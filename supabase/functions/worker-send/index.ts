// worker-send: lo dispara pg_cron cada 18 s. Por cada cuenta de Instagram con
// algo por enviar, saca UNA fila (DM y/o respuesta publica) al ritmo de Meta.
//
// El ritmo y la eleccion de fila viven en Postgres (claim_next_dm /
// claim_next_reply): son atomicos, asi que dos ticks solapados no pueden
// mandar dos veces ni pasarse del tope de 200 DMs/hora por cuenta. Aca solo
// se hace la llamada a Meta y se escribe el resultado.
//
// No hay backoff largo dentro del tick: un error transitorio deja la fila en
// `error` con attempts+1 y el proximo tick (18 s despues) la reintenta, hasta
// 3 veces. Es el mismo backoff de siempre, repartido entre ticks.
import { serve, json, requireWorker } from "../_shared/http.mjs";
import { admin, must, appendLog, nowIso } from "../_shared/db.mjs";
import { ownerConfig, pageTokenFor } from "../_shared/tokens.mjs";
import { failOwner, isTokenError, describeFailure, NO_TOKEN_MSG } from "../_shared/engine.mjs";
import { sendPrivateReply, replyToComment, getCommentReplies, GraphError } from "../_shared/meta.mjs";
import { isProcessed, windowStatus } from "../_shared/classify.mjs";
import { describeDmError, describeReplyError } from "../_shared/recovery.mjs";

const rowKey = (r) => ({ kind: r.kind, parent_id: r.parent_id, comment_id: r.comment_id });
async function setRow(db, r, patch) {
  must(await db.from("dm_rows").update(patch).match(rowKey(r)));
}

/** @returns true si hubo llamada a Meta (gasto el turno), false si la fila se resolvio sin llamar (turno devuelto). */
async function sendDm(db, claim) {
  const r = claim.row;
  const { input, resolved, owner_uid: uid } = claim.parent;
  const ig = r.ig_user_id;

  const win = windowStatus(r.comment_ts, new Date(), input.windowSafetyHours ?? 2);
  if (win.expired) {
    await setRow(db, r, { dm_status: "expired_mid_run", dm_error: "expiró la ventana de 7 días" });
    await appendLog(db, r.kind, r.parent_id, `@${r.username}: se pasó la ventana de 7 días, no se envía.`);
    must(await db.rpc("refund_slot", { p_ig: ig, p_kind: "dm" }));
    return false;
  }

  const config = await ownerConfig(db, uid);
  if (!config) {
    await setRow(db, r, { dm_status: "pending", attempts: Math.max(0, r.attempts - 1) });
    must(await db.rpc("refund_slot", { p_ig: ig, p_kind: "dm" }));
    if (r.kind === "trigger") await failOwner(db, uid, NO_TOKEN_MSG);
    else must(await db.from("jobs").update({ status: "error", error: NO_TOKEN_MSG }).eq("id", r.parent_id));
    return false;
  }

  const post = async (force = false) => {
    const pageToken = await pageTokenFor(db, { igUserId: ig, pageId: resolved.pageId, uid, config, force });
    return sendPrivateReply({ commentId: r.comment_id, card: input.card, pageToken, config });
  };

  try {
    let res;
    try {
      res = await post();
    } catch (err) {
      // El Page token se deriva del de sistema y puede caducar antes: un solo
      // reintento con uno fresco antes de dar la clave por caida.
      if (!isTokenError(err)) throw err;
      res = await post(true);
    }
    await setRow(db, r, { dm_status: "sent", sent_at: nowIso(), message_id: res.message_id ?? "", recipient_id: res.recipient_id ?? "", dm_error: "" });
    await appendLog(db, r.kind, r.parent_id, `@${r.username}: DM enviado`);
  } catch (err) {
    const d = describeDmError(err);
    const patch = { dm_status: d.outcome, dm_error: d.note };
    if (d.outcome === "already_replied") patch.sent_at = nowIso();
    await setRow(db, r, patch);
    await appendLog(db, r.kind, r.parent_id, d.outcome === "already_replied"
      ? `@${r.username}: ya tenía DM (Meta lo rechazó como duplicado)`
      : `@${r.username}: ${d.outcome} — ${d.note}`);
    if (isTokenError(err)) {
      const msg = "Meta rechazó tu clave (#190) al enviar. Cargá una nueva en Cuenta y volvé a activar.";
      if (r.kind === "trigger") await failOwner(db, uid, msg);
      else must(await db.from("jobs").update({ status: "error", error: msg }).eq("id", r.parent_id));
    }
  }
  return true;
}

async function sendReply(db, claim) {
  const r = claim.row;
  const { input, resolved, owner_uid: uid, replied } = claim.parent;
  const ig = r.ig_user_id;
  const texts = input.replyTexts ?? [];

  const config = await ownerConfig(db, uid);
  if (!config) {
    await setRow(db, r, { reply_status: "pending" });
    must(await db.rpc("refund_slot", { p_ig: ig, p_kind: "reply" }));
    return false;
  }

  // Meta NO dedupea las respuestas publicas: dos llamadas son dos comentarios
  // visibles. La idempotencia es nuestra: mirar el hilo antes de responder.
  let pre = null;
  try {
    const pageToken = await pageTokenFor(db, { igUserId: ig, pageId: resolved.pageId, uid, config });
    const replies = await getCommentReplies(r.comment_id, config, pageToken);
    const known = [...texts, ...(input.processedPhrases ?? input.phrases ?? [])];
    pre = isProcessed({ replies }, resolved.igUsername, known) ? "already_replied" : null;
  } catch (err) {
    if (err instanceof GraphError && err.code === 100 && err.subcode === 33) {
      pre = "comment_deleted";
    } else {
      await setRow(db, r, { reply_status: "error", reply_error: `no se pudieron leer las replies: ${describeFailure(err)}` });
      await appendLog(db, r.kind, r.parent_id, `@${r.username}: no pude leer las replies — ${describeFailure(err)}`);
      return true;
    }
  }
  if (pre) {
    const note = pre === "already_replied" ? "el owner ya había respondido en el hilo" : "el comentario ya no existe";
    await setRow(db, r, { reply_status: pre, reply_error: note });
    await appendLog(db, r.kind, r.parent_id, `@${r.username}: respuesta salteada — ${note}`);
    must(await db.rpc("refund_slot", { p_ig: ig, p_kind: "reply" }));
    return false;
  }

  // Copy rotativo: N veces el mismo string exacto es spam de libro.
  const text = texts[(replied ?? 0) % texts.length];
  try {
    const pageToken = await pageTokenFor(db, { igUserId: ig, pageId: resolved.pageId, uid, config });
    const res = await replyToComment({ commentId: r.comment_id, message: text, token: pageToken, config });
    await setRow(db, r, { reply_status: "replied", public_reply_id: res.id ?? "", public_reply_at: nowIso(), public_reply_text: text, reply_error: "" });
    await appendLog(db, r.kind, r.parent_id, `@${r.username}: comentario respondido`);
  } catch (err) {
    const d = describeReplyError(err);
    await setRow(db, r, { reply_status: d.status, reply_error: d.note });
    await appendLog(db, r.kind, r.parent_id, `@${r.username}: respuesta falló — ${d.note}`);
  }
  return true;
}

/** Una cuenta: hasta un DM y hasta una respuesta por tick, saltando lo que se resuelve sin llamar. */
async function drainAccount(db, ig) {
  for (let i = 0; i < 25; i += 1) {
    const claim = must(await db.rpc("claim_next_dm", { p_ig: ig }));
    if (!claim) break;
    if (await sendDm(db, claim)) break;
  }
  for (let i = 0; i < 25; i += 1) {
    const claim = must(await db.rpc("claim_next_reply", { p_ig: ig }));
    if (!claim) break;
    if (await sendReply(db, claim)) break;
  }
}

async function tick() {
  const db = admin();
  const unstuck = must(await db.rpc("unstick_rows"));
  if (unstuck) console.log(`[worker-send] ${unstuck} fila(s) destrabada(s)`);
  const accounts = must(await db.rpc("accounts_with_work")) ?? [];
  const results = await Promise.allSettled(accounts.map((ig) => drainAccount(db, ig)));
  for (const [i, r] of results.entries()) {
    if (r.status === "rejected") console.error(`[worker-send] cuenta ${accounts[i]}:`, r.reason?.stack ?? r.reason);
  }
  console.log(`[worker-send] cuentas con trabajo: ${accounts.length}`);
}

Deno.serve(serve(async (req) => {
  requireWorker(req);
  const work = tick().catch((err) => console.error("[worker-send] tick falló:", err?.stack ?? err));
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(work);
  else await work;
  return json(202, { ok: true });
}));
