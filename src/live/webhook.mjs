/**
 * El webhook de Meta: el camino instantáneo (el mismo que usa ManyChat).
 *
 * Dos reglas que no son opcionales:
 *   1. La firma se calcula sobre el cuerpo CRUDO, byte por byte. Parsear y
 *      volver a serializar cambia el JSON y la firma nunca daría.
 *   2. Meta espera un 200 en menos de ~5 s y reintenta si no lo ve. Por eso se
 *      responde PRIMERO y se procesa después (`setImmediate`).
 *
 * Sin App Secret cargado esto contesta 503 a propósito: aceptar eventos sin
 * verificar la firma sería dejar que cualquiera nos dispare DMs.
 */
import { parseWebhookPayload, verifySignature } from "./rules.mjs";

export function createWebhookHandlers({ live, engine }) {
  /** GET: el handshake de verificación. Contesta aunque el modo en vivo esté apagado (Meta verifica una sola vez). */
  function verify(searchParams) {
    const mode = searchParams.get("hub.mode");
    const token = searchParams.get("hub.verify_token");
    const challenge = searchParams.get("hub.challenge") ?? "";
    if (!live.verifyToken || mode !== "subscribe" || token !== live.verifyToken) {
      return { status: 403, body: "Forbidden" };
    }
    return { status: 200, body: challenge };
  }

  /** POST: firma, 200 inmediato, ingesta después. */
  function event({ raw, signature }) {
    if (!live.webhookConfigured) {
      return { status: 503, json: { error: "webhook no configurado", code: "webhook_not_configured" } };
    }
    if (!verifySignature(raw, signature, live.appSecret)) {
      return { status: 401, json: { error: "firma inválida", code: "bad_signature" } };
    }

    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return { status: 400, json: { error: "JSON inválido", code: "bad_request" } };
    }

    setImmediate(() => {
      dispatch(body).catch((err) => console.error("[live] webhook:", err.message));
    });
    return { status: 200, json: { ok: true } };
  }

  async function dispatch(body) {
    for (const item of parseWebhookPayload(body)) {
      const triggers = engine.findActiveTriggers(item);
      engine.noteWebhookEvent(triggers.length === 0);
      for (const trigger of triggers) {
        await engine.ingest(trigger, item.comment, "webhook");
      }
    }
  }

  return { verify, event };
}
