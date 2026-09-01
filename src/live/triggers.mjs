/**
 * Las automatizaciones (triggers): un JSON por trigger en el store compartido.
 *
 *   live/triggers/<id>.json
 *
 * Forma del objeto: ver PLAN §3.3. Acá solo está la persistencia y lo que sabe
 * de su forma; las decisiones viven en rules.mjs y el ciclo de vida en engine.mjs.
 */
import { newJobId, isValidJobId } from "../jobs.mjs";

export const TRIGGERS_PREFIX = "live/triggers/";
/** Ring buffer del log que ve la UI. */
export const LOG_KEEP = 200;

// Mismo formato que los jobs (YYYYMMDD-xxxxxx): la UI los muestra igual.
export const newTriggerId = newJobId;
export const isValidTriggerId = isValidJobId;

const triggerName = (id) => `${TRIGGERS_PREFIX}${id}.json`;

export function newTrigger({ input, createdBy = null }) {
  return {
    id: newTriggerId(),
    createdAt: new Date().toISOString(),
    createdBy,
    status: "preparing",
    error: null,
    input,
    resolved: null,
    cursor: { watermark: null, seenIds: [], commentsCount: null, lastPollAt: null, lastFullSyncAt: null, polls: 0, pollErrors: 0 },
    counts: { pending: 0, sent: 0, replied: 0, errors: 0, skipped: 0, ignored: 0 },
    lastEventAt: null,
    log: [],
  };
}

export function pushTriggerLog(trigger, message) {
  trigger.log ??= [];
  trigger.log.push({ at: new Date().toISOString(), m: message });
  if (trigger.log.length > LOG_KEEP) trigger.log.splice(0, trigger.log.length - LOG_KEEP);
}

export function saveTrigger(store, trigger) {
  return store.queuedWrite(triggerName(trigger.id), JSON.stringify(trigger, null, 2));
}

export async function loadTriggers(store) {
  const triggers = [];
  for (const name of await store.list(TRIGGERS_PREFIX)) {
    const text = await store.read(name);
    if (text === null) continue;
    try {
      triggers.push(JSON.parse(text));
    } catch (err) {
      console.warn(`[live] no pude leer ${name}: ${err.message}`);
    }
  }
  return triggers.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function deleteTrigger(store, id) {
  await store.remove(triggerName(id));
}

/** Lo justo para la lista de automatizaciones. */
export function triggerSummary(trigger) {
  return {
    id: trigger.id,
    status: trigger.status,
    error: trigger.error ?? null,
    shortcode: trigger.input.shortcode,
    reel: trigger.input.reel,
    permalink: trigger.resolved?.permalink ?? null,
    igUsername: trigger.resolved?.igUsername ?? null,
    keywords: trigger.input.keywords,
    counts: trigger.counts,
    lastEventAt: trigger.lastEventAt ?? null,
    createdAt: trigger.createdAt,
    createdBy: trigger.createdBy ?? null,
  };
}
