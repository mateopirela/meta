/**
 * Logica pura de clasificacion. Sin red, sin disco: todo esto es testeable.
 *
 * La pregunta que responde: de los comentarios del reel, ¿a quien hay que
 * mandarle el DM que ManyChat no mando?
 */
import { PRIVATE_REPLY_WINDOW_HOURS } from "./config.mjs";

export const STATUS = Object.freeze({
  SENDABLE: "sendable",
  SKIP_NO_KEYWORD: "skip_no_keyword",
  SKIP_ALREADY_PROCESSED: "skip_already_processed",
  SKIP_EXPIRED: "skip_expired",
});

/** Minusculas + sin acentos, para que "30X" y "Sí" matcheen como uno espera. */
export const normalize = (text) =>
  (text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

/**
 * ManyChat matchea keywords por "contiene", no por palabra exacta.
 * Replicamos ese comportamiento para recuperar exactamente al mismo conjunto.
 */
export const matchesKeyword = (text, keyword) =>
  normalize(text).includes(normalize(keyword));

/**
 * ¿Este comentario ya lo proceso ManyChat?
 *
 * La respuesta publica de ManyChat es un comentario hijo del owner. Entonces:
 * hay respuesta del owner Y (si configuramos frases) el texto matchea alguna.
 *
 * Sin frases configuradas caemos al criterio conservador: cualquier respuesta
 * del owner cuenta como procesado. Prefiere no mandar antes que mandar de mas
 * cuando no sabemos como se ve la respuesta de la automatizacion.
 */
export function isProcessed(comment, ownerUsername, phrases = []) {
  const replies = comment.replies?.data ?? comment.replies ?? [];
  const owner = normalize(ownerUsername);

  return replies.some((reply) => {
    if (normalize(reply.username) !== owner) return false;
    if (phrases.length === 0) return true;
    const text = normalize(reply.text);
    return phrases.some((phrase) => text.includes(normalize(phrase)));
  });
}

/**
 * Estado del comentario frente a la ventana de 7 dias de Meta.
 * `safetyHours` descarta los que expiran mientras corre el envio.
 */
export function windowStatus(commentTs, now, safetyHours = 0) {
  const commentMs = new Date(commentTs).getTime();
  const expiresAt = new Date(commentMs + PRIVATE_REPLY_WINDOW_HOURS * 3_600_000);
  const hoursLeft = (expiresAt.getTime() - now.getTime()) / 3_600_000;
  return {
    expiresAt,
    hoursLeft,
    expired: hoursLeft <= safetyHours,
  };
}

/**
 * Clasifica un comentario. El orden de los cortes importa: primero keyword
 * (no le debemos nada a quien no lo comento), despues procesado, y la ventana
 * al final, para que el reporte distinga "no aplicaba" de "llegamos tarde".
 */
export function classifyComment(comment, options) {
  const { keyword, ownerUsername, phrases, now, safetyHours } = options;
  const window = windowStatus(comment.timestamp, now, safetyHours);
  const base = {
    comment_id: comment.id,
    username: comment.username ?? "",
    text: comment.text ?? "",
    comment_ts: comment.timestamp,
    expires_at: window.expiresAt.toISOString(),
    hours_left: Math.round(window.hoursLeft * 10) / 10,
  };

  if (!matchesKeyword(comment.text, keyword)) {
    return { ...base, status: STATUS.SKIP_NO_KEYWORD };
  }
  if (isProcessed(comment, ownerUsername, phrases)) {
    return { ...base, status: STATUS.SKIP_ALREADY_PROCESSED };
  }
  if (window.expired) {
    return { ...base, status: STATUS.SKIP_EXPIRED };
  }
  return { ...base, status: STATUS.SENDABLE };
}

/**
 * Clasifica todo y ordena los enviables por comentario mas VIEJO primero:
 * son los que menos ventana les queda, y un run de 500 dura horas.
 */
export function classifyAll(comments, options) {
  const rows = comments.map((comment) => classifyComment(comment, options));
  const sendable = rows
    .filter((row) => row.status === STATUS.SENDABLE)
    .sort((a, b) => new Date(a.comment_ts) - new Date(b.comment_ts));
  return { rows, sendable };
}

export function summarize(rows) {
  const counts = Object.fromEntries(Object.values(STATUS).map((s) => [s, 0]));
  for (const row of rows) counts[row.status] += 1;
  return counts;
}
