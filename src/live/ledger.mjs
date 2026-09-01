/**
 * El ledger: las filas de una automatizacion, indexadas por comment_id.
 *
 *   live/ledger/<triggerId>.json  ->  { rows: { "<comment_id>": {…} } }
 *
 * ES la idempotencia. Dos cosas dependen de eso:
 *   - el indice por comment_id hace imposible encolar dos veces el mismo
 *     comentario, venga del webhook o del sondeo (los dos caminos corren);
 *   - se persiste DESPUES DE CADA FILA, igual que el CSV de la recuperacion,
 *     asi un reinicio no reenvia lo ya enviado.
 *
 * Solo entran los comentarios ACEPTADOS. Un reel viral con 20k comentarios sin
 * la keyword no puede inflar este archivo: esos se cuentan (`counts.ignored`)
 * y se olvidan.
 */
export const LEDGER_PREFIX = "live/ledger/";

/** Reintentos por fila antes de dejarla en error definitivo. */
export const MAX_DM_ATTEMPTS = 3;

const ledgerName = (triggerId) => `${LEDGER_PREFIX}${triggerId}.json`;

export async function loadLedger(store, triggerId) {
  const text = await store.read(ledgerName(triggerId));
  if (text === null) return { rows: {} };
  try {
    const parsed = JSON.parse(text);
    return { rows: parsed.rows ?? {} };
  } catch (err) {
    console.warn(`[live] ledger ilegible de ${triggerId}: ${err.message}`);
    return { rows: {} };
  }
}

export function saveLedger(store, triggerId, ledger) {
  return store.queuedWrite(ledgerName(triggerId), JSON.stringify(ledger, null, 2));
}

export async function deleteLedger(store, triggerId) {
  await store.remove(ledgerName(triggerId));
}

/** @returns true si la fila era nueva. false = ya la teniamos (no se pisa nada). */
export function upsertIfAbsent(ledger, row) {
  if (ledger.rows[row.comment_id]) return false;
  ledger.rows[row.comment_id] = row;
  return true;
}

const olderFirst = (a, b) => new Date(a.row.comment_ts) - new Date(b.row.comment_ts);

/**
 * La proxima fila a la que mandarle el DM, entre TODAS las automatizaciones de
 * la cuenta (el tope de 200/hora de Meta es por cuenta, no por reel).
 *
 * Orden: primero las pendientes de siempre, del comentario mas VIEJO al mas
 * nuevo (son las que menos ventana de 7 dias les queda); los errores
 * reintentables van despues, para no gastar el ritmo en algo que ya fallo.
 *
 * @param {{trigger: object, ledger: object}[]} entries
 */
export function nextDm(entries) {
  const pending = [];
  const retries = [];
  for (const { trigger, ledger } of entries) {
    for (const row of Object.values(ledger.rows)) {
      if (row.dm_status === "pending") pending.push({ trigger, row });
      else if (row.dm_status === "error" && (row.attempts ?? 0) < MAX_DM_ATTEMPTS) retries.push({ trigger, row });
    }
  }
  return pending.sort(olderFirst)[0] ?? retries.sort(olderFirst)[0] ?? null;
}

/** La proxima respuesta publica: solo a quien YA recibio el DM. */
export function nextReply(entries) {
  const pending = [];
  for (const { trigger, ledger } of entries) {
    if ((trigger.input.replyTexts ?? []).length === 0) continue;
    for (const row of Object.values(ledger.rows)) {
      if (row.dm_status === "sent" && row.reply_status === "pending") pending.push({ trigger, row });
    }
  }
  return pending.sort(olderFirst)[0] ?? null;
}
