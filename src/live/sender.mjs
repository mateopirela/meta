/**
 * El drenador: un loop POR CUENTA de Instagram que saca filas del ledger y las
 * envía al ritmo de Meta (200 DMs/hora, 60 respuestas públicas/hora).
 *
 * Por cuenta y no por automatización porque el tope de Meta es por cuenta: dos
 * reels activos de @cinthyasanchezai comparten los mismos 200/hora.
 *
 * Es el mismo envío de la recuperación (`sendPrivateReply` intacto, mismos
 * `describeDmError` / `withRetry`), pero manejado por una cola que nunca
 * termina en vez de por una lista cerrada.
 */
import { getPageToken, sendPrivateReply, replyToComment, getCommentReplies, GraphError } from "../meta.mjs";
import { isProcessed, windowStatus } from "../classify.mjs";
import { withRetry, describeDmError, describeReplyError, abortableSleep } from "../recovery.mjs";
import { nextDm, nextReply } from "./ledger.mjs";

/** Cada cuánto despierta el loop cuando no tiene nada que hacer. */
const IDLE_MS = 5_000;

const nowIso = () => new Date().toISOString();
const isTokenError = (err) => err instanceof GraphError && (err.code === 190 || err.status === 401);

/**
 * @param {object} o
 * @param {string} o.igUserId
 * @param {string} o.pageId
 * @param {object} o.config       makeConfig(systemToken, graphVersion)
 * @param {() => {trigger: object, ledger: object}[]} o.entries  automatizaciones ACTIVAS de la cuenta
 * @param {(trigger, message) => void} o.log
 * @param {(trigger, ledger) => Promise<void>} o.persist
 * @param {(message: string) => void} o.onTokenFatal
 */
export function createDrainer({ igUserId, pageId, config, entries, log, persist, onTokenFatal }) {
  const controller = new AbortController();
  const state = { igUserId, nextDmAt: 0, nextReplyAt: 0, pageToken: null };
  let stopped = false;
  let wakeUp = null;

  /** El Page token: el envío EXIGE este, no el de sistema (si no, #190). */
  async function pageToken(force = false) {
    if (force || !state.pageToken) state.pageToken = await getPageToken(pageId, config);
    return state.pageToken;
  }

  async function sendDm({ trigger, row }) {
    const win = windowStatus(row.comment_ts, new Date(), trigger.input.windowSafetyHours);
    if (win.expired) {
      row.dm_status = "expired_mid_run";
      row.dm_error = "expiró la ventana de 7 días";
      log(trigger, `@${row.username}: se pasó la ventana de 7 días, no se envía.`);
      return false; // no gastó ritmo: no hubo llamada
    }

    row.attempts = (row.attempts ?? 0) + 1;
    const post = async () =>
      withRetry(
        async () =>
          sendPrivateReply({ commentId: row.comment_id, card: trigger.input.card, pageToken: await pageToken(), config }),
        { sleep: abortableSleep, signal: controller.signal, log: (m) => log(trigger, m) },
      );

    let r = await post();
    if (!r.ok && isTokenError(r.err)) {
      // El Page token se deriva del de sistema y puede caducar antes: uno solo
      // de reintento con uno fresco antes de dar la cuenta por caída.
      await pageToken(true).catch(() => {});
      r = await post();
    }

    if (r.ok) {
      row.dm_status = "sent";
      row.sent_at = nowIso();
      row.message_id = r.res.message_id ?? "";
      row.recipient_id = r.res.recipient_id ?? "";
      row.dm_error = "";
      log(trigger, `@${row.username}: DM enviado`);
    } else {
      const d = describeDmError(r.err);
      row.dm_status = d.outcome;
      row.dm_error = d.note;
      if (d.outcome === "already_replied") {
        // Alguien llegó primero (¿ManyChat?): el DM existe igual.
        row.sent_at = nowIso();
        log(trigger, `@${row.username}: ya tenía DM (Meta lo rechazó como duplicado)`);
      } else {
        log(trigger, `@${row.username}: ${d.outcome} — ${d.note}`);
      }
      if (isTokenError(r.err)) {
        onTokenFatal("Meta rechazó el token (#190) al enviar. El envío automático se detiene.");
        stopped = true;
      }
    }
    return true;
  }

  async function sendReply({ trigger, row }) {
    const texts = trigger.input.replyTexts ?? [];
    if (texts.length === 0) {
      row.reply_status = "skipped";
      return false;
    }

    // Meta NO dedupea las respuestas públicas: dos llamadas son dos comentarios
    // visibles. La idempotencia es nuestra — mirar el hilo antes de responder.
    let pre = null;
    try {
      const replies = await getCommentReplies(row.comment_id, config, await pageToken());
      const known = [...texts, ...(trigger.input.processedPhrases ?? [])];
      pre = isProcessed({ replies }, trigger.resolved.igUsername, known) ? "already_replied" : null;
    } catch (err) {
      if (err instanceof GraphError && err.code === 100 && err.subcode === 33) {
        pre = "comment_deleted";
      } else {
        row.reply_status = "error";
        row.reply_error = `no se pudieron leer las replies: ${err.message}`;
        log(trigger, `@${row.username}: no pude leer las replies — ${err.message}`);
        return false;
      }
    }

    if (pre) {
      row.reply_status = pre;
      row.reply_error = pre === "already_replied" ? "el owner ya había respondido en el hilo" : "el comentario ya no existe";
      log(trigger, `@${row.username}: respuesta salteada — ${row.reply_error}`);
      return false;
    }

    // Copy rotativo: N veces el mismo string exacto es spam de libro.
    const text = texts[(trigger.counts?.replied ?? 0) % texts.length];
    const r = await withRetry(
      async () => replyToComment({ commentId: row.comment_id, message: text, token: await pageToken(), config }),
      { sleep: abortableSleep, signal: controller.signal, log: (m) => log(trigger, m) },
    );
    if (r.ok) {
      row.reply_status = "replied";
      row.public_reply_id = r.res.id ?? "";
      row.public_reply_at = nowIso();
      row.public_reply_text = text;
      row.reply_error = "";
      log(trigger, `@${row.username}: comentario respondido`);
    } else {
      const d = describeReplyError(r.err);
      row.reply_status = d.status;
      row.reply_error = d.note;
      log(trigger, `@${row.username}: respuesta falló — ${d.note}`);
    }
    return true;
  }

  const ledgerOf = (active, trigger) => active.find((e) => e.trigger.id === trigger.id).ledger;

  /** @returns true si resolvió una fila SIN gastar el ritmo (no hubo llamada a Meta). */
  async function step() {
    const active = entries();
    if (active.length === 0) return false;
    let free = false;

    if (Date.now() >= state.nextDmAt) {
      const next = nextDm(active);
      if (next) {
        const posted = await sendDm(next);
        // Persistir DESPUÉS DE CADA FILA: el ledger es la idempotencia.
        await persist(next.trigger, ledgerOf(active, next.trigger));
        if (posted) state.nextDmAt = Date.now() + next.trigger.input.sendIntervalMs;
        else free = true;
      }
    }

    if (stopped || controller.signal.aborted) return false;

    if (Date.now() >= state.nextReplyAt) {
      const next = nextReply(active);
      if (next) {
        const posted = await sendReply(next);
        await persist(next.trigger, ledgerOf(active, next.trigger));
        if (posted) state.nextReplyAt = Date.now() + next.trigger.input.replyIntervalMs;
        else free = true;
      }
    }
    return free;
  }

  /** Espera cancelable que además se corta si entra un comentario nuevo. */
  function idle(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      wakeUp = done;
      function done() {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", done);
        wakeUp = null;
        resolve();
      }
      controller.signal.addEventListener("abort", done, { once: true });
    });
  }

  (async () => {
    while (!stopped) {
      let free = false;
      try {
        free = await step();
      } catch (err) {
        // Un fallo acá no puede matar el loop: la próxima vuelta reintenta.
        console.error(`[live] drenador ${igUserId}:`, err.message);
      }
      if (stopped) return;
      // Una fila que se resolvió sin llamar a Meta (venció la ventana, ya estaba
      // respondida) no gastó ritmo: la siguiente puede salir ya.
      if (free) continue;
      const now = Date.now();
      const next = [state.nextDmAt, state.nextReplyAt].filter((t) => t > now);
      await idle(Math.max(0, Math.min(now + IDLE_MS, ...next) - now));
    }
  })();

  return {
    state,
    /** Un comentario nuevo no espera a la próxima vuelta del loop. */
    wake() {
      wakeUp?.();
    },
    stop() {
      stopped = true;
      controller.abort();
    },
  };
}
