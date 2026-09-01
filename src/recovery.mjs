/**
 * El pipeline de recuperacion como FUNCIONES reutilizables: sin process.exit,
 * sin .env, sin consola. Lo consume la interfaz web (web/server.mjs).
 *
 * Los scripts 01..09 siguen siendo la version CLI. La red vive en meta.mjs y la
 * logica pura en classify.mjs; aca solo se orquesta:
 *
 *   parseShortcode(url) -> resolveReel() -> fetchComments() -> buildPlan() -> runRecovery()
 *
 * Diferencia con la CLI: no hace falta IG_USERNAME ni PAGE_ID. El reel se busca
 * entre TODAS las cuentas de IG que administra el token, y la que lo tiene es
 * la duena (de ahi salen el owner, la pagina y el Page token).
 */
import {
  graphGet,
  graphGetAll,
  listManagedPages,
  getPageToken,
  sendPrivateReply,
  getCommentReplies,
  replyToComment,
  GraphError,
  NetworkError,
} from "./meta.mjs";
import { classifyAll, summarize, isProcessed, windowStatus } from "./classify.mjs";

export const DEFAULT_GRAPH_VERSION = "v23.0";
/** 200/hora es el tope de Meta para private_replies; 18 s es el minimo que lo respeta. */
export const MIN_INTERVAL_MS = 18_000;
export const DEFAULT_SEND_INTERVAL_MS = 18_000;
/** Mas lento a proposito: son comentarios del owner en rafaga en un mismo hilo. */
export const DEFAULT_REPLY_INTERVAL_MS = 60_000;
export const DEFAULT_WINDOW_SAFETY_HOURS = 2;

/** Limites del generic template de Meta. Pasarse da un #100 opaco. */
export const CARD_TITLE_MAX = 80;
export const CARD_BUTTON_TITLE_MAX = 20;

export class RecoveryError extends Error {
  constructor(message, code, meta = {}) {
    super(message);
    this.name = "RecoveryError";
    this.code = code;
    this.meta = meta;
  }
}

/**
 * Saca el shortcode de una URL de Instagram (reel, reels, p, tv; con o sin
 * usuario en el path) o acepta el shortcode pelado. null si no parece ninguna.
 */
export function parseShortcode(input) {
  const s = String(input ?? "").trim();
  if (!s) return null;
  const m = s.match(/instagram\.com\/(?:[^/?#]+\/)?(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{5,}$/.test(s)) return s;
  return null;
}

export const makeConfig = (token, graphVersion = DEFAULT_GRAPH_VERSION) =>
  Object.freeze({ token, graphVersion });

/** Pagina a mano (en vez de graphGetAll) para poder CORTAR al encontrarlo. */
async function findMediaByShortcode(igUserId, shortcode, config, maxPages) {
  let after;
  for (let page = 0; page < maxPages; page += 1) {
    const body = await graphGet(
      `${igUserId}/media`,
      { fields: "id,shortcode,permalink,timestamp,comments_count,media_type", limit: 50, after },
      config,
    );
    const found = (body.data ?? []).find((m) => m.shortcode === shortcode);
    if (found) return found;
    after = body.paging?.cursors?.after;
    if (!after || !body.paging?.next) return null;
  }
  return null;
}

/**
 * Encuentra el reel entre las cuentas que administra el token. La cuenta que
 * lo tiene es la duena: de ahi salen owner (para detectar sus respuestas),
 * pagina (para el Page token) y media id (para los comentarios).
 */
export async function resolveReel({ token, shortcode, graphVersion, maxPagesPerAccount = 6 }) {
  const config = makeConfig(token, graphVersion);

  let pages;
  try {
    pages = await listManagedPages(config);
  } catch (err) {
    if (err instanceof GraphError && (err.code === 190 || err.status === 401)) {
      throw new RecoveryError(
        "Token inválido o expirado (#190). Generá uno nuevo en el Business Manager.",
        "bad_token",
      );
    }
    throw err;
  }

  const withIg = pages.filter((p) => p.instagram_business_account);
  if (withIg.length === 0) {
    throw new RecoveryError(
      "El token no administra ninguna página con cuenta de Instagram vinculada. " +
        "Revisá los scopes y que la página esté en el Business Manager.",
      "no_pages",
    );
  }

  for (const page of withIg) {
    const ig = page.instagram_business_account;
    const media = await findMediaByShortcode(ig.id, shortcode, config, maxPagesPerAccount);
    if (media) {
      return {
        page: { id: page.id, name: page.name },
        ig: { id: ig.id, username: ig.username },
        media,
      };
    }
  }

  throw new RecoveryError(
    `No encontré el reel ${shortcode} en ninguna de las ${withIg.length} cuenta(s) de Instagram que ` +
      `administra el token (revisé los últimos ${maxPagesPerAccount * 50} posts de cada una). ` +
      "Si el reel es de otra cuenta, su página tiene que estar en nuestro Business Manager.",
    "reel_not_found",
    { accounts: withIg.map((p) => p.instagram_business_account.username) },
  );
}

const REPLIES_LIMIT = 50;
export const COMMENT_FIELDS = `id,text,timestamp,username,like_count,replies.limit(${REPLIES_LIMIT}){id,text,timestamp,username}`;
const COMMENT_FIELDS_FALLBACK = COMMENT_FIELDS.replace("like_count,", "");

/** Todos los comentarios del reel con sus replies (para saber si el owner ya respondio). */
export async function fetchComments({ token, mediaId, graphVersion }) {
  const config = makeConfig(token, graphVersion);
  try {
    return await graphGetAll(`${mediaId}/comments`, { fields: COMMENT_FIELDS, limit: 50 }, config);
  } catch (err) {
    if (!(err instanceof GraphError) || err.code !== 100) throw err;
    return graphGetAll(`${mediaId}/comments`, { fields: COMMENT_FIELDS_FALLBACK, limit: 50 }, config);
  }
}

/**
 * Clasifica y arma las filas a procesar (ya ordenadas: el que menos ventana
 * tiene, primero). Puro: sin red.
 */
export function buildPlan({ comments, keyword, ownerUsername, phrases = [], now = new Date(), safetyHours = DEFAULT_WINDOW_SAFETY_HOURS }) {
  const { rows, sendable } = classifyAll(comments, { keyword, ownerUsername, phrases, now, safetyHours });
  const counts = summarize(rows);
  const plan = sendable.map((r) => ({
    comment_id: r.comment_id,
    username: r.username,
    text: r.text,
    comment_ts: r.comment_ts,
    expires_at: r.expires_at,
    hours_left: r.hours_left,
    dm_status: "",
    sent_at: "",
    message_id: "",
    recipient_id: "",
    dm_error: "",
    reply_status: "",
    public_reply_id: "",
    public_reply_at: "",
    public_reply_text: "",
    reply_error: "",
  }));
  return { total: comments.length, counts, rows: plan };
}

/** Estados en los que NO se vuelve a intentar el DM. */
export const DM_TERMINAL = new Set(["sent", "already_replied", "comment_deleted", "outside_window", "expired_mid_run", "needs_advanced_access"]);
/** Estados en los que NO se vuelve a intentar la respuesta publica. */
export const REPLY_TERMINAL = new Set(["replied", "already_replied", "comment_deleted"]);

/** Espera cancelable: si el job se pausa, no se queda 60 s colgado. */
export const abortableSleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

export async function withRetry(fn, { sleep, signal, log, maxRetries = 3, backoffMs = 30_000 }) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return { ok: true, res: await fn() };
    } catch (err) {
      const known = err instanceof GraphError || err instanceof NetworkError;
      if (!known) throw err;
      if (err.isRetryable && attempt <= maxRetries && !signal?.aborted) {
        const wait = backoffMs * attempt;
        const label = err instanceof GraphError ? `#${err.code ?? err.status}` : "red";
        log(`${label} transitorio: backoff ${wait / 1000}s, intento ${attempt}/${maxRetries}`);
        await sleep(wait, signal);
        continue;
      }
      return { ok: false, err };
    }
  }
}

export function describeDmError(err) {
  if (err instanceof GraphError) {
    if (err.subcode === 2534023) return { outcome: "already_replied", note: "ya tenía respuesta (ManyChat lo procesó o ya se lo mandamos)" };
    if (err.code === 100 && err.subcode === 33) return { outcome: "comment_deleted", note: "el comentario ya no existe" };
    if (err.code === 10) return { outcome: "outside_window", note: "fuera de la ventana de 7 días" };
    if (err.code === 200 && err.subcode === 2534048) return { outcome: "needs_advanced_access", note: "Meta pide Advanced Access para este destinatario" };
  }
  return { outcome: "error", note: err.message };
}

export function describeReplyError(err) {
  if (err instanceof GraphError) {
    if (err.code === 100 && err.subcode === 33) return { status: "comment_deleted", note: "el comentario ya no existe" };
    if (err.code === 10 || err.code === 200) return { status: "error", note: `sin permiso para responder comentarios (#${err.code}): falta instagram_manage_comments` };
  }
  return { status: "error", note: err.message };
}

/**
 * Corre el job: fase 1 DMs, fase 2 respuestas publicas (solo a quien recibio
 * el DM). Muta `job.rows` y `job.progress`; llama `onUpdate` tras cada fila
 * para que el que llama persista. Reanudable: saltea lo terminal.
 *
 * @returns "done" | "paused"  (paused = el signal se aborto entre filas)
 */
export async function runRecovery(job, opts) {
  const {
    token,
    graphVersion = DEFAULT_GRAPH_VERSION,
    signal,
    onUpdate = async () => {},
    sleep = abortableSleep,
    log = () => {},
  } = opts;
  const config = makeConfig(token, graphVersion);
  const { input, resolved, rows } = job;
  const nowIso = () => new Date().toISOString();

  const pageToken = await getPageToken(resolved.pageId, config);

  // ── Fase 1: DMs ─────────────────────────────────────────────────────────────
  const dmPending = rows.filter((r) => !DM_TERMINAL.has(r.dm_status));
  job.progress = { phase: "dm", done: 0, total: dmPending.length };
  await onUpdate();

  for (const [i, row] of dmPending.entries()) {
    if (signal?.aborted) return "paused";

    let posted = false;
    const win = windowStatus(row.comment_ts, new Date(), input.windowSafetyHours);
    if (win.expired) {
      row.dm_status = "expired_mid_run";
      row.dm_error = "expiró la ventana de 7 días";
      log(`@${row.username}: salteado, expiró la ventana`);
    } else {
      posted = true;
      const r = await withRetry(
        () => sendPrivateReply({ commentId: row.comment_id, card: input.card, pageToken, config }),
        { sleep, signal, log },
      );
      if (r.ok) {
        row.sent_at = nowIso();
        row.message_id = r.res.message_id ?? "";
        row.recipient_id = r.res.recipient_id ?? "";
        row.dm_status = "sent";
        row.dm_error = "";
        log(`@${row.username}: DM enviado`);
      } else {
        const d = describeDmError(r.err);
        row.dm_status = d.outcome;
        row.dm_error = d.note;
        if (d.outcome === "already_replied") row.sent_at = nowIso();
        log(`@${row.username}: ${d.outcome} — ${d.note}`);
      }
    }

    job.progress.done = i + 1;
    await onUpdate();
    if (signal?.aborted) return "paused";
    if (posted && i < dmPending.length - 1) await sleep(input.sendIntervalMs, signal);
  }

  // ── Fase 2: respuesta publica, solo a quien recibio el DM ───────────────────
  if (input.replyTexts.length > 0) {
    const replyPending = rows.filter((r) => r.dm_status === "sent" && !REPLY_TERMINAL.has(r.reply_status));
    job.progress = { phase: "reply", done: 0, total: replyPending.length };
    await onUpdate();

    const known = [...input.replyTexts, ...input.phrases];
    let replied = rows.filter((r) => r.reply_status === "replied").length;

    for (const [i, row] of replyPending.entries()) {
      if (signal?.aborted) return "paused";

      // Pre-check de idempotencia: Meta NO dedupea replies, asi que miramos
      // antes si el owner ya respondio (nosotros en un run anterior, o ManyChat).
      let pre = null;
      try {
        const replies = await getCommentReplies(row.comment_id, config, pageToken);
        pre = isProcessed({ replies }, resolved.igUsername, known) ? "already_replied" : null;
      } catch (err) {
        if (err instanceof GraphError && err.code === 100 && err.subcode === 33) {
          pre = "comment_deleted";
        } else {
          row.reply_status = "error";
          row.reply_error = `no se pudieron leer las replies: ${err.message}`;
          log(`@${row.username}: no pude leer las replies — ${err.message}`);
          job.progress.done = i + 1;
          await onUpdate();
          continue;
        }
      }

      let posted = false;
      if (pre) {
        row.reply_status = pre;
        row.reply_error = pre === "already_replied" ? "el owner ya había respondido en el hilo" : "el comentario ya no existe";
        log(`@${row.username}: respuesta salteada — ${row.reply_error}`);
      } else {
        posted = true;
        const text = input.replyTexts[replied % input.replyTexts.length];
        const r = await withRetry(
          () => replyToComment({ commentId: row.comment_id, message: text, token: pageToken, config }),
          { sleep, signal, log },
        );
        if (r.ok) {
          row.public_reply_id = r.res.id ?? "";
          row.public_reply_at = nowIso();
          row.public_reply_text = text;
          row.reply_status = "replied";
          row.reply_error = "";
          replied += 1;
          log(`@${row.username}: comentario respondido`);
        } else {
          const d = describeReplyError(r.err);
          row.reply_status = d.status;
          row.reply_error = d.note;
          log(`@${row.username}: respuesta falló — ${d.note}`);
        }
      }

      job.progress.done = i + 1;
      await onUpdate();
      if (signal?.aborted) return "paused";
      if (posted && i < replyPending.length - 1) await sleep(input.replyIntervalMs, signal);
    }
  }

  return "done";
}

/** Resumen de estados para la UI y el reporte final. */
export function tally(rows) {
  const dm = {};
  const reply = {};
  for (const r of rows) {
    if (r.dm_status) dm[r.dm_status] = (dm[r.dm_status] ?? 0) + 1;
    if (r.reply_status) reply[r.reply_status] = (reply[r.reply_status] ?? 0) + 1;
  }
  return { dm, reply };
}
