/**
 * El motor del modo en vivo y del analisis, contra Postgres: lo que antes era
 * un proceso con estado en memoria son pasos idempotentes que un tick de
 * pg_cron (worker-poll) o un evento del webhook ejecutan y persisten.
 *
 *   crear -> preparing -> prepareTrigger() -> active
 *   active: pollTrigger() cada tick · ingest() desde el webhook
 *   job:   analyzing -> analyzeJob() -> ready
 *
 * Las decisiones (que comentario entra, cursor, firma) siguen en rules.mjs y
 * classify.mjs, sin cambios: aca solo se orquesta y se escribe.
 */
import { resolveReel, fetchComments, buildPlan, RecoveryError } from "./recovery.mjs";
import { graphGet, GraphError, NetworkError, getPageToken, subscribeAppToPage } from "./meta.mjs";
import { isProcessed, matchesKeyword } from "./classify.mjs";
import { evaluateComment, advanceCursor, shouldStopPaging } from "./rules.mjs";
import { must, appendLog, nowIso } from "./db.mjs";
import { ownerConfig } from "./tokens.mjs";

export const NO_TOKEN_MSG = "Todavía no cargaste tu clave de Meta. Cargala en Cuenta y volvé a activar.";
/** Tope de paginas de comentarios por preparacion/analisis: un tick tiene presupuesto de tiempo. */
const PREPARE_MAX_PAGES = 80;
/** Sondeo: tope de paginas por tick; el siguiente retoma donde este dejo. */
const POLL_MAX_PAGES = 20;
const FULL_SYNC_EVERY_MS = 5 * 60_000;
const RATE_CODES = new Set([4, 17, 32, 613]);
const POLL_FIELDS = "id,text,timestamp,username,from{id,username},parent_id";
const POLL_FIELDS_WITH_REPLIES = `${POLL_FIELDS},replies.limit(50){id,text,timestamp,username,from{id,username},parent_id}`;

export function describeFailure(err) {
  if (err instanceof RecoveryError) return err.message;
  if (err instanceof GraphError) {
    if (err.code === 190 || err.status === 401) return "Meta no acepta tu clave (#190). Cargá una nueva en Cuenta.";
    return `Meta #${err.code ?? err.status}${err.subcode ? `/${err.subcode}` : ""}: ${err.message}`;
  }
  return err?.message ?? String(err);
}

export const isTokenError = (err) => err instanceof GraphError && (err.code === 190 || err.status === 401);

/** La fila del ledger (rules.rowFromComment) en columnas de dm_rows. */
export function toDbRow(row, { kind, parentId, ownerUid, igUserId, position = 0, replyPending }) {
  return {
    kind,
    parent_id: parentId,
    comment_id: row.comment_id,
    owner_uid: ownerUid,
    ig_user_id: igUserId,
    position,
    username: row.username ?? "",
    from_id: row.from_id ?? "",
    text: row.text ?? "",
    comment_ts: row.comment_ts,
    expires_at: row.expires_at,
    source: row.source ?? "",
    received_at: row.received_at ?? nowIso(),
    dm_status: "pending",
    attempts: 0,
    reply_status: replyPending ? "pending" : "skipped",
  };
}

/** Todas las automatizaciones activas de un dueño pasan a error: sin su token valido no hay nada que hacer. */
export async function failOwner(db, uid, message) {
  const rows = must(await db.from("triggers").select("id").eq("owner_uid", uid).eq("status", "active"));
  for (const { id } of rows) {
    must(await db.from("triggers").update({ status: "error", error: message }).eq("id", id));
    await appendLog(db, "trigger", id, message);
  }
}

/**
 * La puerta de entrada de TODO comentario de una automatizacion, venga del
 * webhook, del sondeo o del backfill. Dedupe por clave primaria: el mismo
 * comment_id no entra dos veces aunque llegue por los dos caminos.
 * @returns {{queued: number, ignored: number}}
 */
export async function ingest(db, trigger, comments, source, { skipProcessedBy = null } = {}) {
  const now = new Date();
  const replyPending = (trigger.input?.replyTexts ?? []).length > 0;
  const rows = [];
  let ignored = 0;
  for (const comment of comments) {
    if (skipProcessedBy && isProcessed(comment, trigger.resolved.igUsername, skipProcessedBy)) continue;
    const evaluated = evaluateComment(comment, trigger, now, source);
    if (!evaluated.accept) {
      ignored += 1;
      continue;
    }
    rows.push(toDbRow(evaluated.row, {
      kind: "trigger",
      parentId: trigger.id,
      ownerUid: trigger.owner_uid,
      igUserId: trigger.resolved.igUserId,
      replyPending,
    }));
  }

  let queued = 0;
  if (rows.length > 0) {
    // ON CONFLICT DO NOTHING + return=representation: vuelven solo las nuevas.
    const inserted = must(await db.from("dm_rows")
      .upsert(rows, { onConflict: "kind,parent_id,comment_id", ignoreDuplicates: true })
      .select("comment_id,username,text"));
    queued = inserted.length;
    for (const r of inserted) {
      const keyword = trigger.input.keywords.find((k) => matchesKeyword(r.text, k)) ?? trigger.input.keywords[0];
      await appendLog(db, "trigger", trigger.id, `@${r.username} comentó «${keyword}» → en cola (${source})`);
    }
    if (queued > 0) must(await db.from("triggers").update({ last_event_at: nowIso() }).eq("id", trigger.id));
  }
  // Los que no aplican se cuentan y se olvidan: un reel viral no infla la tabla.
  if (ignored > 0) must(await db.rpc("bump_ignored", { p_trigger_id: trigger.id, p_n: ignored }));
  return { queued, ignored };
}

/** Trae el reel, siembra el cursor, hace el backfill y deja la automatizacion andando. */
export async function prepareTrigger(db, trigger, { pollIntervalMs }) {
  const id = trigger.id;
  try {
    const config = await ownerConfig(db, trigger.owner_uid);
    if (!config) throw new RecoveryError(NO_TOKEN_MSG, "token_required");

    await appendLog(db, "trigger", id, "Buscando el reel entre las cuentas de Instagram que administra tu clave…");
    const r = await resolveReel({ token: config.token, shortcode: trigger.input.shortcode, graphVersion: config.graphVersion });
    trigger.resolved = {
      pageId: r.page.id,
      pageName: r.page.name,
      igUserId: r.ig.id,
      igUsername: r.ig.username,
      mediaId: r.media.id,
      permalink: r.media.permalink,
      publishedAt: r.media.timestamp,
    };
    must(await db.from("triggers").update({ resolved: trigger.resolved }).eq("id", id));
    await appendLog(db, "trigger", id, `Reel encontrado en @${r.ig.username} (página "${r.page.name}").`);

    // Una lectura completa para saber que ya existe: sin esto, el primer sondeo
    // trataria los comentarios viejos del reel como nuevos.
    const comments = await fetchComments({ token: config.token, mediaId: r.media.id, graphVersion: config.graphVersion, maxPages: PREPARE_MAX_PAGES });
    if (comments.truncated) {
      await appendLog(db, "trigger", id, `El reel tiene más de ${PREPARE_MAX_PAGES * 50} comentarios: se leyeron los más recientes. Los anteriores no entran al backfill.`);
    }

    if (trigger.input.backfill === "window") {
      const known = [...(trigger.input.replyTexts ?? []), ...(trigger.input.processedPhrases ?? [])];
      const { queued } = await ingest(db, trigger, comments, "backfill", { skipProcessedBy: known });
      await appendLog(db, "trigger", id, `Arranque: ${queued} comentario(s) de los últimos 7 días quedaron en cola.`);
    }

    const cursor = advanceCursor(trigger.cursor ?? {}, comments);
    cursor.commentsCount = r.media.comments_count ?? null;
    cursor.lastFullSyncAt = nowIso();
    cursor.polls = cursor.polls ?? 0;
    cursor.pollErrors = cursor.pollErrors ?? 0;
    await appendLog(db, "trigger", id, `${comments.length} comentario(s) ya existentes: quedan marcados como vistos.`);

    // La mitad por API de habilitar el webhook. Que falle es un aviso, no un freno: el sondeo cubre igual.
    try {
      const pageToken = await getPageToken(r.page.id, config);
      await subscribeAppToPage({ pageId: r.page.id, pageToken, config });
      await appendLog(db, "trigger", id, "La página quedó suscrita a los eventos de la app.");
    } catch (err) {
      await appendLog(db, "trigger", id, `No pude suscribir la página a los webhooks (${describeFailure(err)}). El sondeo cubre igual.`);
    }

    must(await db.from("triggers").update({ status: "active", error: null, cursor, claimed_at: null }).eq("id", id));
    await appendLog(db, "trigger", id, `Automatización activa. Detección cada ${Math.round(pollIntervalMs / 1000)} s (o instantánea si el webhook está configurado).`);
  } catch (err) {
    const message = describeFailure(err);
    must(await db.from("triggers").update({ status: "error", error: message, claimed_at: null }).eq("id", id));
    await appendLog(db, "trigger", id, `Error: ${message}`);
  }
}

/** El analisis de una recuperacion: encontrar el reel, leer todo, decidir a quien. */
export async function analyzeJob(db, job) {
  const id = job.id;
  try {
    const config = await ownerConfig(db, job.owner_uid);
    if (!config) throw new RecoveryError(NO_TOKEN_MSG, "token_required");

    await appendLog(db, "job", id, "Buscando el reel entre las cuentas de Instagram que administra tu clave…");
    const r = await resolveReel({ token: config.token, shortcode: job.input.shortcode, graphVersion: config.graphVersion });
    const resolved = {
      pageId: r.page.id,
      pageName: r.page.name,
      igUserId: r.ig.id,
      igUsername: r.ig.username,
      mediaId: r.media.id,
      permalink: r.media.permalink,
      publishedAt: r.media.timestamp,
      commentsCount: r.media.comments_count ?? null,
    };
    must(await db.from("jobs").update({ resolved }).eq("id", id));
    await appendLog(db, "job", id, `Reel encontrado en @${r.ig.username} (página "${r.page.name}"). Bajando comentarios…`);

    const comments = await fetchComments({ token: config.token, mediaId: r.media.id, graphVersion: config.graphVersion, maxPages: PREPARE_MAX_PAGES });
    const reported = resolved.commentsCount;
    await appendLog(db, "job", id,
      `${comments.length} comentarios leídos` +
        (comments.truncated ? ` (tope de ${PREPARE_MAX_PAGES * 50}: se leyeron los más recientes).` : "") +
        (!comments.truncated && reported != null && reported > comments.length
          ? ` (Meta reporta ${reported}: la diferencia son cuentas privadas, que la API no expone y no se pueden recuperar).`
          : "."));

    const plan = buildPlan({
      comments,
      keyword: job.input.keyword,
      ownerUsername: r.ig.username,
      phrases: job.input.phrases ?? [],
      safetyHours: job.input.windowSafetyHours,
    });
    // Filas nuevas de cero: un re-analisis no existe (se crea otro job).
    must(await db.from("dm_rows").delete().eq("kind", "job").eq("parent_id", id));
    const rows = plan.rows.map((row, i) => toDbRow(
      { ...row, source: "recovery", received_at: nowIso() },
      { kind: "job", parentId: id, ownerUid: job.owner_uid, igUserId: r.ig.id, position: i, replyPending: true },
    ));
    for (let i = 0; i < rows.length; i += 500) {
      must(await db.from("dm_rows").upsert(rows.slice(i, i + 500), { onConflict: "kind,parent_id,comment_id", ignoreDuplicates: true }));
    }
    must(await db.from("jobs").update({ status: "ready", counts: { total: plan.total, ...plan.counts }, claimed_at: null }).eq("id", id));
    await appendLog(db, "job", id, `${plan.rows.length} persona(s) para recuperar.`);
  } catch (err) {
    const message = describeFailure(err);
    must(await db.from("jobs").update({ status: "error", error: message, claimed_at: null }).eq("id", id));
    await appendLog(db, "job", id, `Error: ${message}`);
  }
}

/** @returns {{candidates: object[], complete: boolean}} */
async function fetchCandidates(trigger, cursor, config) {
  const fields = trigger.input.includeReplies ? POLL_FIELDS_WITH_REPLIES : POLL_FIELDS;
  const candidates = [];
  let after;
  for (let page = 0; page < POLL_MAX_PAGES; page += 1) {
    const body = await graphGet(`${trigger.resolved.mediaId}/comments`, { fields, limit: 50, after }, config);
    const data = body.data ?? [];
    for (const comment of data) {
      candidates.push(comment);
      for (const reply of comment.replies?.data ?? []) {
        candidates.push({ ...reply, parent_id: reply.parent_id ?? comment.id });
      }
    }
    if (shouldStopPaging(data, cursor)) return { candidates, complete: true };
    after = body.paging?.cursors?.after;
    if (!after || !body.paging?.next) return { candidates, complete: true };
  }
  return { candidates, complete: false };
}

/**
 * Un sondeo de una automatizacion activa. Barato a proposito: primero
 * `comments_count`; solo si cambio (o cada 5 min) se baja la lista, y se corta
 * de paginar en cuanto una pagina entera es conocida.
 */
export async function pollTrigger(db, trigger) {
  const id = trigger.id;
  const cursor = { watermark: null, seenIds: [], commentsCount: null, polls: 0, pollErrors: 0, ...(trigger.cursor ?? {}) };
  cursor.polls += 1;
  cursor.lastPollAt = nowIso();

  try {
    const config = await ownerConfig(db, trigger.owner_uid);
    if (!config) {
      await failOwner(db, trigger.owner_uid, NO_TOKEN_MSG);
      return;
    }

    const media = await graphGet(trigger.resolved.mediaId, { fields: "comments_count" }, config);
    const count = media.comments_count ?? null;
    const sinceFullSync = cursor.lastFullSyncAt ? Date.now() - Date.parse(cursor.lastFullSyncAt) : Infinity;

    if (count !== cursor.commentsCount || sinceFullSync >= FULL_SYNC_EVERY_MS) {
      const { candidates, complete } = await fetchCandidates(trigger, cursor, config);
      const seen = new Set(cursor.seenIds ?? []);
      const fresh = candidates
        .filter((c) => !seen.has(String(c.id)))
        .sort((a, b) => new Date(a.timestamp ?? 0) - new Date(b.timestamp ?? 0));

      let queued = 0;
      if (fresh.length > 0) queued = (await ingest(db, trigger, fresh, "poll")).queued;

      Object.assign(cursor, advanceCursor(cursor, candidates));
      if (!complete) {
        const oldest = candidates.reduce((min, c) => {
          const ts = c.timestamp ? new Date(c.timestamp).getTime() : NaN;
          return Number.isFinite(ts) && ts < min ? ts : min;
        }, Infinity);
        if (Number.isFinite(oldest)) cursor.watermark = new Date(oldest).toISOString();
        await appendLog(db, "trigger", id, `Sondeo: ráfaga grande (${candidates.length} comentarios en ${POLL_MAX_PAGES} páginas); el próximo sondeo sigue desde donde quedó.`);
      }
      cursor.commentsCount = count;
      cursor.lastFullSyncAt = nowIso();
      if (fresh.length > 0) await appendLog(db, "trigger", id, `Sondeo: ${fresh.length} comentario(s) nuevo(s), ${queued} con la palabra.`);
    }
  } catch (err) {
    cursor.pollErrors += 1;
    if (isTokenError(err)) {
      await appendLog(db, "trigger", id, "Meta rechazó tu clave (#190). El sondeo se detiene hasta que cargues una nueva en Cuenta.");
      await failOwner(db, trigger.owner_uid, "Meta rechazó tu clave de Meta (#190). Cargá una nueva en Cuenta y volvé a activar.");
      return;
    }
    if (err instanceof GraphError && RATE_CODES.has(err.code)) {
      await appendLog(db, "trigger", id, `Meta pidió bajar el ritmo (#${err.code}): el próximo sondeo espera.`);
      cursor.backoffUntil = new Date(Date.now() + 100_000).toISOString();
    } else if (!(err instanceof NetworkError) || cursor.pollErrors % 10 === 1) {
      await appendLog(db, "trigger", id, `Sondeo falló: ${describeFailure(err)}`);
    }
  }
  must(await db.from("triggers").update({ cursor }).eq("id", id));
}
