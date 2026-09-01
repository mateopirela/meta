/**
 * Reglas puras del modo en vivo. Sin red, sin disco, sin estado: todo esto es
 * testeable (test/live-rules.test.mjs) y es donde viven las decisiones.
 *
 * La pregunta que responde: de los comentarios que llegan (por webhook o por
 * sondeo), ¿cual dispara un DM, y cual se cuenta y se olvida?
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { normalize, matchesKeyword, windowStatus } from "../classify.mjs";
import {
  parseShortcode,
  MIN_INTERVAL_MS,
  DEFAULT_SEND_INTERVAL_MS,
  DEFAULT_REPLY_INTERVAL_MS,
  DEFAULT_WINDOW_SAFETY_HOURS,
  CARD_TITLE_MAX,
  CARD_BUTTON_TITLE_MAX,
} from "../recovery.mjs";

export const KEYWORD_MAX = 60;
export const TEXT_MAX = 300;
export const TEXTS_MAX = 10;
/** Tope de ids recordados por trigger: un reel viral no puede inflar el JSON. */
export const SEEN_IDS_KEEP = 3000;

/** Error de formulario: la ruta lo convierte en un 400 con el campo culpable. */
export class TriggerInputError extends Error {
  constructor(field, message) {
    super(message);
    this.name = "TriggerInputError";
    this.field = field;
  }
}

const bad = (field, message) => {
  throw new TriggerInputError(field, message);
};

const str = (v) => String(v ?? "").trim();

/**
 * ¿Este comentario dispara un DM?
 *
 * El orden de los cortes importa y es el mismo del clasificador de la
 * recuperacion: primero lo que no nos corresponde (el owner, las respuestas),
 * despues la keyword, y la ventana al final para poder distinguir "no aplicaba"
 * de "llegamos tarde".
 *
 * @returns {{accept: true, row: object} | {accept: false, reason: string}}
 */
export function evaluateComment(comment, trigger, now = new Date(), source = "poll") {
  const input = trigger.input ?? {};
  const resolved = trigger.resolved ?? {};
  const fromId = comment.from?.id ? String(comment.from.id) : "";
  const username = comment.username ?? comment.from?.username ?? "";

  // El owner comenta en su propio reel (y nuestra respuesta publica dispara el
  // webhook otra vez). Nunca nos mandamos un DM a nosotros mismos.
  const ownerById = fromId && resolved.igUserId && fromId === String(resolved.igUserId);
  const ownerByName = username && resolved.igUsername && normalize(username) === normalize(resolved.igUsername);
  if (ownerById || ownerByName) return { accept: false, reason: "skip_owner" };

  if (comment.parent_id && !input.includeReplies) return { accept: false, reason: "skip_reply" };

  const keywords = input.keywords ?? [];
  if (!keywords.some((k) => matchesKeyword(comment.text, k))) return { accept: false, reason: "skip_no_keyword" };

  const ts = comment.timestamp ?? now.toISOString();
  if (windowStatus(ts, now, input.windowSafetyHours ?? DEFAULT_WINDOW_SAFETY_HOURS).expired) {
    return { accept: false, reason: "skip_expired" };
  }

  return { accept: true, row: rowFromComment(comment, trigger, source, now) };
}

/**
 * Fila del ledger. Mismas columnas que la recuperacion (para que el CSV abra en
 * la misma planilla) + `source`, `received_at`, `attempts`, `from_id`.
 */
export function rowFromComment(comment, trigger, source, now = new Date()) {
  const ts = comment.timestamp ?? now.toISOString();
  const hasReplies = (trigger.input?.replyTexts ?? []).length > 0;
  return {
    comment_id: String(comment.id),
    username: comment.username ?? comment.from?.username ?? "",
    from_id: comment.from?.id ? String(comment.from.id) : "",
    text: comment.text ?? "",
    comment_ts: ts,
    expires_at: windowStatus(ts, now, 0).expiresAt.toISOString(),
    source,
    received_at: now.toISOString(),
    dm_status: "pending",
    attempts: 0,
    sent_at: "",
    message_id: "",
    recipient_id: "",
    dm_error: "",
    reply_status: hasReplies ? "pending" : "skipped",
    public_reply_id: "",
    public_reply_at: "",
    public_reply_text: "",
    reply_error: "",
  };
}

/**
 * Aplana el POST del webhook de Meta a una lista de comentarios.
 * Tolera basura: cualquier cosa rara devuelve [] en vez de tirar.
 */
export function parseWebhookPayload(body) {
  try {
    if (!body || body.object !== "instagram" || !Array.isArray(body.entry)) return [];
    const out = [];
    for (const entry of body.entry) {
      const eventTime = Number.isFinite(entry?.time)
        ? new Date(entry.time * 1000).toISOString()
        : new Date().toISOString();
      for (const change of entry?.changes ?? []) {
        if (change?.field !== "comments") continue;
        const v = change.value ?? {};
        if (!v.id) continue;
        out.push({
          igUserId: entry.id ? String(entry.id) : "",
          eventTime,
          mediaId: v.media?.id ? String(v.media.id) : "",
          comment: {
            id: String(v.id),
            text: v.text ?? "",
            username: v.from?.username ?? "",
            from: v.from ?? null,
            timestamp: v.timestamp ?? eventTime,
            parent_id: v.parent_id ?? null,
          },
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * HMAC-SHA256 del cuerpo CRUDO contra el header `x-hub-signature-256`.
 * Sin app secret configurado no hay firma valida posible. Nunca tira.
 */
export function verifySignature(rawBody, headerValue, appSecret) {
  try {
    const secret = str(appSecret);
    if (!secret || secret === "unset") return false;
    const m = /^sha256=([0-9a-f]+)$/i.exec(str(headerValue));
    if (!m) return false;
    const given = Buffer.from(m[1], "hex");
    const expected = createHmac("sha256", secret).update(Buffer.from(rawBody ?? "")).digest();
    if (given.length !== expected.length) return false;
    return timingSafeEqual(given, expected);
  } catch {
    return false;
  }
}

const isNewComment = (comment, seen, watermarkMs, slackMs) => {
  if (seen.has(String(comment.id))) return false;
  if (watermarkMs === null) return true;
  const ts = comment.timestamp ? new Date(comment.timestamp).getTime() : NaN;
  // Sin timestamp usable no podemos descartarlo por viejo: que lo mire el filtro.
  if (!Number.isFinite(ts)) return true;
  return ts > watermarkMs - slackMs;
};

/**
 * ¿Cortamos de paginar? `/{media}/comments` viene del mas nuevo al mas viejo,
 * asi que en cuanto una pagina entera es conocida, lo que sigue tambien.
 * El `slackMs` cubre el reloj de Meta y los comentarios que llegan desordenados.
 */
export function shouldStopPaging(pageComments, cursor = {}, { slackMs = 120_000 } = {}) {
  if (!pageComments || pageComments.length === 0) return true;
  const seen = new Set(cursor.seenIds ?? []);
  const watermarkMs = cursor.watermark ? new Date(cursor.watermark).getTime() : null;
  return !pageComments.some((c) => isNewComment(c, seen, watermarkMs, slackMs));
}

/** Nueva marca de agua + ids vistos (los mas nuevos primero, recortado a `keep`). */
export function advanceCursor(cursor = {}, comments = [], { keep = SEEN_IDS_KEEP } = {}) {
  const seen = cursor.seenIds ?? [];
  const known = new Set(seen);
  const fresh = [];
  let watermarkMs = cursor.watermark ? new Date(cursor.watermark).getTime() : -Infinity;
  let watermark = cursor.watermark ?? null;

  for (const comment of comments ?? []) {
    const id = String(comment.id);
    if (!known.has(id)) {
      known.add(id);
      fresh.push(id);
    }
    const ts = comment.timestamp ? new Date(comment.timestamp).getTime() : NaN;
    if (Number.isFinite(ts) && ts > watermarkMs) {
      watermarkMs = ts;
      watermark = new Date(ts).toISOString();
    }
  }

  return { ...cursor, watermark, seenIds: [...fresh, ...seen].slice(0, keep) };
}

/** Cuenta lo que la UI muestra por automatizacion. `ignored` no vive acá: no se guarda. */
export function tallyRows(rows = {}) {
  const counts = { pending: 0, sent: 0, replied: 0, errors: 0, skipped: 0 };
  for (const row of Object.values(rows)) {
    if (row.dm_status === "pending") counts.pending += 1;
    else if (row.dm_status === "sent") counts.sent += 1;
    else if (row.dm_status === "error") counts.errors += 1;
    else counts.skipped += 1;
    if (row.reply_status === "replied") counts.replied += 1;
    else if (row.reply_status === "error") counts.errors += 1;
  }
  return counts;
}

// ── Validacion del formulario ────────────────────────────────────────────────

/** Lista desde textarea (una por linea) o array. Sin vacios ni repetidos. */
function toLines(value, { field, label, max = TEXTS_MAX, maxLen = TEXT_MAX }) {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(/\r?\n/);
  const list = [...new Set(raw.map((t) => String(t).trim()).filter(Boolean))];
  if (list.length > max) bad(field, `${label}: como máximo ${max}.`);
  for (const item of list) {
    if (item.length > maxLen) bad(field, `${label}: cada línea puede tener hasta ${maxLen} caracteres.`);
  }
  return list;
}

/** Las keywords se escriben en una sola linea, separadas por coma o barra. */
function toKeywords(value) {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(/[,|\n]/);
  const seen = new Set();
  const list = [];
  for (const item of raw) {
    const k = String(item).trim();
    if (!k) continue;
    if (k.length > KEYWORD_MAX) bad("keywords", `Cada palabra clave puede tener hasta ${KEYWORD_MAX} caracteres.`);
    const key = normalize(k);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(k);
  }
  if (list.length === 0) bad("keywords", "Falta al menos una palabra clave. Separá varias con comas.");
  return list;
}

function intervalMs(value, fallback, { field, label }) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) bad(field, `${label} debe ser un número de milisegundos.`);
  if (n < MIN_INTERVAL_MS) {
    bad(field, `${label}: ${n} ms son más de 200 por hora, el tope de Meta. Mínimo ${MIN_INTERVAL_MS} ms.`);
  }
  return Math.round(n);
}

function validateCard(value) {
  const card = {
    title: str(value?.title),
    buttonTitle: str(value?.buttonTitle),
    buttonUrl: str(value?.buttonUrl),
  };
  if (!card.title) bad("card.title", "Falta el título de la tarjeta del DM.");
  if (card.title.length > CARD_TITLE_MAX) {
    bad("card.title", `El título de la tarjeta no puede pasar de ${CARD_TITLE_MAX} caracteres (límite de Meta).`);
  }
  if (!card.buttonTitle) bad("card.buttonTitle", "Falta el texto del botón.");
  if (card.buttonTitle.length > CARD_BUTTON_TITLE_MAX) {
    bad("card.buttonTitle", `El texto del botón no puede pasar de ${CARD_BUTTON_TITLE_MAX} caracteres (límite de Meta).`);
  }
  try {
    const u = new URL(card.buttonUrl);
    if (!/^https?:$/.test(u.protocol)) throw new Error();
  } catch {
    bad("card.buttonUrl", "El enlace del botón tiene que empezar con http:// o https://.");
  }
  return card;
}

/**
 * Todo lo que hace falta para crear una automatizacion.
 * `defaults` son los del entorno (LIVE_SEND_INTERVAL_MS y compañía); el
 * formulario puede subirlos, nunca bajarlos del piso de Meta.
 */
export function validateTriggerInput(body, defaults = {}) {
  const reel = str(body?.reelUrl ?? body?.reel);
  const shortcode = parseShortcode(reel);
  if (!shortcode) {
    bad("reel", "Ese enlace no parece de un reel de Instagram. Ejemplo: https://www.instagram.com/reel/DbqpQCZFDNC/");
  }

  const backfill = str(body?.backfill) || "none";
  if (!["none", "window"].includes(backfill)) bad("backfill", "El modo de arranque tiene que ser «none» o «window».");

  const windowSafetyHours =
    body?.windowSafetyHours === undefined || body?.windowSafetyHours === ""
      ? defaults.windowSafetyHours ?? DEFAULT_WINDOW_SAFETY_HOURS
      : Number(body.windowSafetyHours);
  if (!Number.isFinite(windowSafetyHours) || windowSafetyHours < 0) {
    bad("windowSafetyHours", "El margen de ventana debe ser un número de horas ≥ 0.");
  }

  return {
    reel,
    shortcode,
    keywords: toKeywords(body?.keywords),
    includeReplies: Boolean(body?.includeReplies),
    backfill,
    processedPhrases: toLines(body?.processedPhrases, { field: "processedPhrases", label: "Frases de «ya atendido»" }),
    card: validateCard(body?.card),
    replyTexts: toLines(body?.replyTexts, { field: "replyTexts", label: "Respuestas públicas" }),
    sendIntervalMs: intervalMs(body?.sendIntervalMs, defaults.sendIntervalMs ?? DEFAULT_SEND_INTERVAL_MS, { field: "sendIntervalMs", label: "Intervalo entre DMs" }),
    replyIntervalMs: intervalMs(body?.replyIntervalMs, defaults.replyIntervalMs ?? DEFAULT_REPLY_INTERVAL_MS, { field: "replyIntervalMs", label: "Intervalo entre respuestas" }),
    windowSafetyHours,
  };
}

/**
 * Edicion de una automatizacion pausada: solo los campos que vengan. El reel no
 * se toca (cambiarlo seria otra automatizacion).
 */
export function validateTriggerPatch(body) {
  const patch = {};
  if (body?.card !== undefined) patch.card = validateCard(body.card);
  if (body?.keywords !== undefined) patch.keywords = toKeywords(body.keywords);
  if (body?.replyTexts !== undefined) {
    patch.replyTexts = toLines(body.replyTexts, { field: "replyTexts", label: "Respuestas públicas" });
  }
  if (body?.processedPhrases !== undefined) {
    patch.processedPhrases = toLines(body.processedPhrases, { field: "processedPhrases", label: "Frases de «ya atendido»" });
  }
  if (body?.includeReplies !== undefined) patch.includeReplies = Boolean(body.includeReplies);
  if (body?.sendIntervalMs !== undefined) {
    patch.sendIntervalMs = intervalMs(body.sendIntervalMs, DEFAULT_SEND_INTERVAL_MS, { field: "sendIntervalMs", label: "Intervalo entre DMs" });
  }
  if (body?.replyIntervalMs !== undefined) {
    patch.replyIntervalMs = intervalMs(body.replyIntervalMs, DEFAULT_REPLY_INTERVAL_MS, { field: "replyIntervalMs", label: "Intervalo entre respuestas" });
  }
  if (Object.keys(patch).length === 0) bad("input", "No mandaste nada para cambiar.");
  return patch;
}
