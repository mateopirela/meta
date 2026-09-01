/**
 * El motor del modo en vivo: arma y desarma las piezas (sondeo, drenador,
 * webhook) alrededor de las automatizaciones, y es el único que muta su estado.
 *
 *   crear -> preparing -> (resolver reel + sembrar cursor + suscribir) -> active
 *   active <-> paused                                   error -> activate() reintenta
 *
 * Los ledgers viven EN MEMORIA (uno por automatización activa) y se persisten
 * después de cada fila. Es la misma apuesta que hacen los jobs y se sostiene en
 * que el servicio corre con una sola instancia (min=max=1 en Cloud Run).
 */
import { makeConfig, resolveReel, fetchComments, RecoveryError } from "../recovery.mjs";
import { GraphError, getPageToken, subscribeAppToPage } from "../meta.mjs";
import { isProcessed, matchesKeyword } from "../classify.mjs";
import { evaluateComment, advanceCursor, tallyRows } from "./rules.mjs";
import { newTrigger, saveTrigger, loadTriggers, deleteTrigger, pushTriggerLog, triggerSummary } from "./triggers.mjs";
import { loadLedger, saveLedger, deleteLedger, upsertIfAbsent } from "./ledger.mjs";
import { startPoller } from "./poller.mjs";
import { createDrainer } from "./sender.mjs";

/** Error con código HTTP: las rutas lo traducen tal cual. */
export class LiveError extends Error {
  constructor(status, message, code = "bad_request") {
    super(message);
    this.name = "LiveError";
    this.status = status;
    this.code = code;
  }
}

const state = {
  store: null,
  live: null,
  config: null,
  ready: false,
  triggers: new Map(),
  ledgers: new Map(),
  pollers: new Map(),
  drainers: new Map(),
  webhook: { events: 0, accepted: 0, ignored: 0, lastEventAt: null },
};

const nowIso = () => new Date().toISOString();
const console_ = (m) => console.log(`[live] ${m}`);

function describeFailure(err) {
  if (err instanceof RecoveryError) return err.message;
  if (err instanceof GraphError) {
    if (err.code === 190 || err.status === 401) {
      return "Meta no acepta la clave del sistema (#190). Hay que cargar una nueva.";
    }
    return `Meta #${err.code ?? err.status}${err.subcode ? `/${err.subcode}` : ""}: ${err.message}`;
  }
  return err.message;
}

function log(trigger, message) {
  pushTriggerLog(trigger, message);
  console_(`${trigger.input.shortcode}: ${message}`);
}

function recount(trigger, ledger) {
  trigger.counts = { ...tallyRows(ledger.rows), ignored: trigger.counts?.ignored ?? 0 };
}

async function persist(trigger, ledger) {
  if (ledger) {
    recount(trigger, ledger);
    await saveLedger(state.store, trigger.id, ledger);
  }
  await saveTrigger(state.store, trigger);
}

const activeOf = (igUserId) =>
  [...state.triggers.values()]
    .filter((t) => t.status === "active" && t.resolved?.igUserId === igUserId && state.ledgers.has(t.id))
    .map((t) => ({ trigger: t, ledger: state.ledgers.get(t.id) }));

/** Marca toda la cuenta en error: sin token válido no hay nada que hacer. */
function failAccount(igUserId, message) {
  for (const trigger of state.triggers.values()) {
    if (trigger.resolved?.igUserId !== igUserId) continue;
    if (trigger.status !== "active") continue;
    trigger.status = "error";
    trigger.error = message;
    log(trigger, message);
    stopPoller(trigger.id);
    saveTrigger(state.store, trigger);
  }
  syncDrainers();
}

function stopPoller(id) {
  state.pollers.get(id)?.stop();
  state.pollers.delete(id);
}

function startPolling(trigger) {
  if (!state.live.enabled || state.pollers.has(trigger.id) || !trigger.resolved) return;
  state.pollers.set(
    trigger.id,
    startPoller({
      trigger,
      config: state.config,
      intervalMs: state.live.pollIntervalMs,
      ingest,
      log: (m) => log(trigger, m),
      persist: () => saveTrigger(state.store, trigger),
      onTokenFatal: (m) => failAccount(trigger.resolved.igUserId, m),
    }),
  );
}

/** Un drenador por cuenta con automatizaciones activas; ni uno más, ni uno menos. */
function syncDrainers() {
  if (!state.live.enabled) return;
  const wanted = new Map();
  for (const trigger of state.triggers.values()) {
    if (trigger.status === "active" && trigger.resolved) wanted.set(trigger.resolved.igUserId, trigger.resolved.pageId);
  }
  for (const [igUserId, drainer] of state.drainers) {
    if (!wanted.has(igUserId)) {
      drainer.stop();
      state.drainers.delete(igUserId);
    }
  }
  for (const [igUserId, pageId] of wanted) {
    if (state.drainers.has(igUserId)) continue;
    state.drainers.set(
      igUserId,
      createDrainer({
        igUserId,
        pageId,
        config: state.config,
        entries: () => activeOf(igUserId),
        log,
        persist,
        onTokenFatal: (m) => failAccount(igUserId, m),
      }),
    );
  }
}

/** La mitad por API de habilitar el webhook. Que falle es un aviso, no un freno: el sondeo cubre igual. */
async function ensureSubscribed(trigger) {
  try {
    const pageToken = await getPageToken(trigger.resolved.pageId, state.config);
    await subscribeAppToPage({ pageId: trigger.resolved.pageId, pageToken, config: state.config });
    log(trigger, "La página quedó suscrita a los eventos de la app.");
  } catch (err) {
    log(trigger, `No pude suscribir la página a los webhooks (${describeFailure(err)}). El sondeo cubre igual.`);
  }
}

/** Trae el reel, siembra el cursor, hace el backfill y deja la automatización andando. */
async function prepare(trigger) {
  try {
    log(trigger, "Buscando el reel entre las cuentas de Instagram que administra la clave…");
    const r = await resolveReel({ token: state.live.token, shortcode: trigger.input.shortcode, graphVersion: state.live.graphVersion });
    trigger.resolved = {
      pageId: r.page.id,
      pageName: r.page.name,
      igUserId: r.ig.id,
      igUsername: r.ig.username,
      mediaId: r.media.id,
      permalink: r.media.permalink,
      publishedAt: r.media.timestamp,
    };
    log(trigger, `Reel encontrado en @${r.ig.username} (página "${r.page.name}").`);
    await saveTrigger(state.store, trigger);

    // Una lectura completa para saber qué ya existe: sin esto, el primer sondeo
    // trataría los 500 comentarios viejos del reel como nuevos.
    const comments = await fetchComments({ token: state.live.token, mediaId: r.media.id, graphVersion: state.live.graphVersion });
    const ledger = await loadLedger(state.store, trigger.id);
    state.ledgers.set(trigger.id, ledger);

    if (trigger.input.backfill === "window") {
      const known = [...trigger.input.replyTexts, ...trigger.input.processedPhrases];
      let queued = 0;
      for (const comment of comments) {
        if (isProcessed(comment, r.ig.username, known)) continue;
        const evaluated = evaluateComment(comment, trigger, new Date(), "backfill");
        if (evaluated.accept && upsertIfAbsent(ledger, evaluated.row)) queued += 1;
      }
      log(trigger, `Arranque: ${queued} comentario(s) de los últimos 7 días quedaron en cola.`);
    }

    Object.assign(trigger.cursor, advanceCursor(trigger.cursor, comments));
    trigger.cursor.commentsCount = r.media.comments_count ?? null;
    trigger.cursor.lastFullSyncAt = nowIso();
    log(trigger, `${comments.length} comentario(s) ya existentes: quedan marcados como vistos.`);

    await ensureSubscribed(trigger);

    trigger.status = "active";
    trigger.error = null;
    log(trigger, `Automatización activa. Detección cada ${Math.round(state.live.pollIntervalMs / 1000)} s (o instantánea si el webhook está configurado).`);
    await persist(trigger, ledger);
    startPolling(trigger);
    syncDrainers();
  } catch (err) {
    trigger.status = "error";
    trigger.error = describeFailure(err);
    log(trigger, `Error: ${trigger.error}`);
    await saveTrigger(state.store, trigger);
  }
}

/**
 * La puerta de entrada de TODO comentario, venga del webhook o del sondeo.
 * @returns "queued" | "duplicate" | "inactive" | motivo del descarte
 */
async function ingest(trigger, comment, source) {
  const ledger = state.ledgers.get(trigger.id);
  if (!ledger || trigger.status !== "active") return "inactive";

  const evaluated = evaluateComment(comment, trigger, new Date(), source);
  if (!evaluated.accept) {
    // Los que no aplican se cuentan y se olvidan: un reel viral no puede
    // inflar el ledger con 20k comentarios sin la keyword.
    trigger.counts.ignored = (trigger.counts.ignored ?? 0) + 1;
    return evaluated.reason;
  }

  const row = evaluated.row;
  if (!upsertIfAbsent(ledger, row)) return "duplicate";

  const keyword = trigger.input.keywords.find((k) => matchesKeyword(row.text, k)) ?? trigger.input.keywords[0];
  trigger.lastEventAt = nowIso();
  log(trigger, `@${row.username} comentó «${keyword}» → en cola (${source})`);
  if (source === "webhook") state.webhook.accepted += 1;

  await persist(trigger, ledger);
  state.drainers.get(trigger.resolved.igUserId)?.wake();
  return "queued";
}

function getTrigger(id) {
  const trigger = state.triggers.get(id);
  if (!trigger) throw new LiveError(404, "No encontré esa automatización.", "not_found");
  return trigger;
}

export const engine = {
  status() {
    const live = state.live ?? {};
    const accounts = new Map();
    for (const trigger of state.triggers.values()) {
      if (trigger.status !== "active" || !trigger.resolved) continue;
      const { igUserId, igUsername } = trigger.resolved;
      const acc = accounts.get(igUserId) ?? { igUserId, igUsername, pending: 0, nextDmAt: null, nextReplyAt: null };
      acc.pending += state.ledgers.get(trigger.id) ? tallyRows(state.ledgers.get(trigger.id).rows).pending : 0;
      const drainer = state.drainers.get(igUserId);
      if (drainer) {
        acc.nextDmAt = drainer.state.nextDmAt ? new Date(drainer.state.nextDmAt).toISOString() : null;
        acc.nextReplyAt = drainer.state.nextReplyAt ? new Date(drainer.state.nextReplyAt).toISOString() : null;
      }
      accounts.set(igUserId, acc);
    }
    return {
      enabled: Boolean(live.enabled),
      tokenConfigured: Boolean(live.tokenConfigured),
      webhook: { configured: Boolean(live.webhookConfigured), ...state.webhook },
      pollIntervalMs: live.pollIntervalMs ?? null,
      accounts: [...accounts.values()],
    };
  },

  listTriggers() {
    return [...state.triggers.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(triggerSummary);
  },

  getTrigger,

  async getLedger(id) {
    if (!state.ledgers.has(id)) state.ledgers.set(id, await loadLedger(state.store, id));
    return state.ledgers.get(id);
  },

  async createTrigger(input, user) {
    if (!state.live.tokenConfigured) {
      throw new LiveError(503, "Falta la clave del sistema (META_SYSTEM_USER_TOKEN). Sin eso no se puede enviar nada.", "token_not_configured");
    }
    const clash = [...state.triggers.values()].find(
      (t) => t.input.shortcode === input.shortcode && ["preparing", "active", "paused"].includes(t.status),
    );
    if (clash) {
      throw new LiveError(409, `Ya hay una automatización para ese reel (${clash.status}). Editá esa en vez de crear otra.`, "duplicate");
    }

    const trigger = newTrigger({ input, createdBy: user?.email ?? null });
    state.triggers.set(trigger.id, trigger);
    await saveTrigger(state.store, trigger);
    prepare(trigger); // background
    return trigger;
  },

  async activate(id) {
    const trigger = getTrigger(id);
    if (trigger.status === "active") return trigger;
    if (!state.live.enabled) {
      throw new LiveError(409, "El modo en vivo está apagado (LIVE_ENABLED=false).", "live_disabled");
    }
    if (!trigger.resolved) {
      trigger.status = "preparing";
      trigger.error = null;
      await saveTrigger(state.store, trigger);
      prepare(trigger);
      return trigger;
    }
    if (!state.ledgers.has(id)) state.ledgers.set(id, await loadLedger(state.store, id));
    trigger.status = "active";
    trigger.error = null;
    log(trigger, "Automatización reactivada.");
    await persist(trigger, state.ledgers.get(id));
    startPolling(trigger);
    syncDrainers();
    return trigger;
  },

  async pause(id) {
    const trigger = getTrigger(id);
    if (trigger.status === "preparing") {
      throw new LiveError(409, "Esperá a que termine de prepararse.", "bad_state");
    }
    stopPoller(id);
    trigger.status = "paused";
    log(trigger, "Automatización pausada: no se detecta ni se envía nada. Lo que ya estaba en cola queda esperando.");
    await saveTrigger(state.store, trigger);
    syncDrainers();
    return trigger;
  },

  async updateMessages(id, patch) {
    const trigger = getTrigger(id);
    if (trigger.status === "active" || trigger.status === "preparing") {
      throw new LiveError(409, "Pausá la automatización antes de cambiar los mensajes.", "running");
    }
    Object.assign(trigger.input, patch);
    log(trigger, "Mensajes actualizados.");
    await saveTrigger(state.store, trigger);
    return trigger;
  },

  async remove(id) {
    const trigger = getTrigger(id);
    if (trigger.status === "active" || trigger.status === "preparing") {
      throw new LiveError(409, "Pausá la automatización antes de borrarla.", "running");
    }
    stopPoller(id);
    state.triggers.delete(id);
    state.ledgers.delete(id);
    await deleteTrigger(state.store, id);
    await deleteLedger(state.store, id);
    syncDrainers();
    return { ok: true };
  },

  ingest,

  /** Las automatizaciones activas a las que le corresponde un evento del webhook. */
  findActiveTriggers({ mediaId, igUserId }) {
    return [...state.triggers.values()].filter((t) => {
      if (t.status !== "active" || !t.resolved) return false;
      if (mediaId) return t.resolved.mediaId === String(mediaId);
      return t.resolved.igUserId === String(igUserId);
    });
  },

  noteWebhookEvent(ignored) {
    if (state.webhook.events === 0) console_("Webhook activo: primer evento recibido.");
    state.webhook.events += 1;
    if (ignored) state.webhook.ignored += 1;
    state.webhook.lastEventAt = nowIso();
  },
};

/**
 * Arranque, una sola vez, desde web/server.mjs después de cargar los jobs.
 * Sin token o con el modo apagado, las automatizaciones se cargan igual para
 * mostrarlas: lo que no arranca es el sondeo ni el envío.
 */
export async function bootEngine({ store, live }) {
  state.store = store;
  state.live = live;
  state.config = live.tokenConfigured ? makeConfig(live.token, live.graphVersion) : null;

  for (const trigger of await loadTriggers(store)) {
    if (trigger.status === "preparing") {
      trigger.status = "error";
      trigger.error = "El servidor se reinició durante la preparación. Creá la automatización de nuevo.";
      await saveTrigger(store, trigger);
    }
    state.triggers.set(trigger.id, trigger);
  }

  if (!live.enabled) {
    state.ready = true;
    return {
      triggers: state.triggers.size,
      started: 0,
      reason: live.tokenConfigured ? "LIVE_ENABLED=false" : "falta META_SYSTEM_USER_TOKEN",
    };
  }

  let started = 0;
  for (const trigger of state.triggers.values()) {
    if (trigger.status !== "active" || !trigger.resolved) continue;
    state.ledgers.set(trigger.id, await loadLedger(store, trigger.id));
    startPolling(trigger);
    started += 1;
  }
  syncDrainers();
  state.ready = true;
  return { triggers: state.triggers.size, started, reason: null };
}

/** Para pruebas y para un apagado limpio: frena todos los loops. */
export function stopEngine() {
  for (const id of [...state.pollers.keys()]) stopPoller(id);
  for (const [igUserId, drainer] of state.drainers) {
    drainer.stop();
    state.drainers.delete(igUserId);
  }
}
