/**
 * El sondeo: cada ~20 s le pregunta a Meta si hay comentarios nuevos en el reel
 * de una automatizacion activa.
 *
 * Es el camino PRIMARIO hasta que el webhook este configurado, y despues queda
 * como red de seguridad (los webhooks se pierden: reintentos, caidas, eventos
 * que Meta nunca manda). Los dos caminos dedupean por comment_id en el ledger,
 * asi que correr los dos no duplica nada.
 *
 * Barato a proposito: primero `comments_count` (una llamada minima); solo si
 * cambio se baja la lista, y se corta de paginar en cuanto una pagina entera es
 * conocida (los comentarios vienen del mas nuevo al mas viejo).
 */
import { graphGet, GraphError, NetworkError } from "../meta.mjs";
import { abortableSleep } from "../recovery.mjs";
import { shouldStopPaging, advanceCursor } from "./rules.mjs";

export const POLL_FIELDS = "id,text,timestamp,username,from{id,username},parent_id";
export const POLL_FIELDS_WITH_REPLIES = `${POLL_FIELDS},replies.limit(50){id,text,timestamp,username,from{id,username},parent_id}`;

/** Tope de paginas por sondeo: el que sigue retoma donde este dejo (la marca avanzo). */
const MAX_PAGES = 20;
/** Aunque el contador no cambie, mirar de verdad cada tanto (los borrados lo bajan). */
const FULL_SYNC_EVERY_MS = 5 * 60_000;
/** Persistir el trigger aunque no pase nada, para que "último sondeo" no mienta. */
const PERSIST_EVERY_MS = 5 * 60_000;
/** Ante rate limit (#4/#17/#32/#613), esperar 5 intervalos antes del proximo. */
const RATE_BACKOFF_FACTOR = 5;
const RATE_CODES = new Set([4, 17, 32, 613]);

const jitter = (ms) => Math.round(ms * (0.9 + Math.random() * 0.2));

/**
 * @param {object} o
 * @param {object} o.trigger        el trigger vivo (se muta su `cursor`)
 * @param {object} o.config         makeConfig(systemToken, graphVersion)
 * @param {number} o.intervalMs
 * @param {(trigger, comment, source) => Promise<string>} o.ingest
 * @param {(message: string) => void} o.log
 * @param {() => Promise<void>} o.persist
 * @param {(message: string) => void} o.onTokenFatal
 */
export function startPoller({ trigger, config, intervalMs, ingest, log, persist, onTokenFatal }) {
  const controller = new AbortController();
  let stopped = false;
  let consecutiveErrors = 0;
  let lastPersistAt = 0;

  /** @returns {{candidates: object[], complete: boolean}} complete=false si se corto por MAX_PAGES con paginas nuevas por delante. */
  async function fetchCandidates(cursor) {
    const fields = trigger.input.includeReplies ? POLL_FIELDS_WITH_REPLIES : POLL_FIELDS;
    const candidates = [];
    let after;
    let complete = false;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await graphGet(`${trigger.resolved.mediaId}/comments`, { fields, limit: 50, after }, config);
      const data = body.data ?? [];
      for (const comment of data) {
        candidates.push(comment);
        for (const reply of comment.replies?.data ?? []) {
          // El edge de replies no siempre trae parent_id; sin el, el filtro de
          // "no responder a respuestas" no tendria como distinguirlas.
          candidates.push({ ...reply, parent_id: reply.parent_id ?? comment.id });
        }
      }
      if (shouldStopPaging(data, cursor)) {
        complete = true;
        break;
      }
      after = body.paging?.cursors?.after;
      if (!after || !body.paging?.next) {
        complete = true;
        break;
      }
    }
    return { candidates, complete };
  }

  async function tick() {
    const cursor = (trigger.cursor ??= { watermark: null, seenIds: [], commentsCount: null, polls: 0, pollErrors: 0 });
    const startedAt = Date.now();
    cursor.polls = (cursor.polls ?? 0) + 1;
    cursor.lastPollAt = new Date().toISOString();

    const media = await graphGet(trigger.resolved.mediaId, { fields: "comments_count" }, config);
    const count = media.comments_count ?? null;
    const sinceFullSync = cursor.lastFullSyncAt ? startedAt - Date.parse(cursor.lastFullSyncAt) : Infinity;

    let ingested = 0;
    let queued = 0;
    if (count !== cursor.commentsCount || sinceFullSync >= FULL_SYNC_EVERY_MS) {
      const { candidates, complete } = await fetchCandidates(cursor);
      const seen = new Set(cursor.seenIds ?? []);
      const fresh = candidates
        .filter((c) => !seen.has(String(c.id)))
        // Del mas viejo al mas nuevo: la cola sale en ese orden y es el que
        // menos ventana de 7 dias le queda.
        .sort((a, b) => new Date(a.timestamp ?? 0) - new Date(b.timestamp ?? 0));

      for (const comment of fresh) {
        ingested += 1;
        if ((await ingest(trigger, comment, "poll")) === "queued") queued += 1;
      }

      Object.assign(cursor, advanceCursor(cursor, candidates));
      if (!complete) {
        // Se corto por MAX_PAGES con comentarios nuevos por delante: si la marca
        // quedara en el mas nuevo, el proximo sondeo daria por viejos a los que
        // no llegamos a leer. La bajamos al mas viejo leido; los ya leidos los
        // filtra seenIds.
        const oldest = candidates.reduce((min, c) => {
          const ts = c.timestamp ? new Date(c.timestamp).getTime() : NaN;
          return Number.isFinite(ts) && ts < min ? ts : min;
        }, Infinity);
        if (Number.isFinite(oldest)) cursor.watermark = new Date(oldest).toISOString();
        log(`Sondeo: ráfaga grande (${candidates.length} comentarios en ${MAX_PAGES} páginas); el próximo sondeo sigue desde donde quedó.`);
      }
      cursor.commentsCount = count;
      cursor.lastFullSyncAt = new Date().toISOString();
      if (ingested > 0) {
        log(`Sondeo: ${ingested} comentario(s) nuevo(s), ${queued} con la palabra.`);
      }
    }

    consecutiveErrors = 0;
    if (ingested > 0 || Date.now() - lastPersistAt >= PERSIST_EVERY_MS) {
      lastPersistAt = Date.now();
      await persist();
    }
  }

  (async () => {
    while (!stopped) {
      await abortableSleep(jitter(intervalMs), controller.signal);
      if (stopped) return;

      try {
        await tick();
      } catch (err) {
        trigger.cursor.pollErrors = (trigger.cursor.pollErrors ?? 0) + 1;
        consecutiveErrors += 1;

        if (err instanceof GraphError && (err.code === 190 || err.status === 401)) {
          log("Meta rechazó el token (#190). El sondeo se detiene hasta que se cargue una clave nueva.");
          onTokenFatal("Meta rechazó el token (#190). Cargá una clave nueva y volvé a activar.");
          return;
        }
        if (err instanceof GraphError && RATE_CODES.has(err.code)) {
          log(`Meta pidió bajar el ritmo (#${err.code}): el próximo sondeo espera ${(intervalMs * RATE_BACKOFF_FACTOR) / 1000} s.`);
          await abortableSleep(intervalMs * RATE_BACKOFF_FACTOR, controller.signal);
          continue;
        }
        // Un blip de red no merece una linea de log cada 20 s.
        if (err instanceof NetworkError ? consecutiveErrors % 10 === 1 : true) {
          log(`Sondeo falló: ${err.message}`);
        }
      }
    }
  })();

  return {
    stop() {
      stopped = true;
      controller.abort();
    },
  };
}
