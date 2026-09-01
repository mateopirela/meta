/**
 * Interfaz web de la recuperacion. Sin dependencias: http nativo + estaticos.
 *
 *   node web/server.mjs          ->  http://127.0.0.1:8787
 *   PORT=9000 HOST=0.0.0.0 ...   ->  solo si sabes lo que haces (ver abajo)
 *
 * SEGURIDAD — leer antes de exponerlo fuera de localhost:
 *   - El token de Meta llega en el body de POST /api/jobs y se guarda SOLO en
 *     memoria (`tokens`), asociado al job. Nunca va a disco, nunca vuelve en
 *     una respuesta, nunca se loguea. Si el servidor se reinicia, la UI lo
 *     vuelve a pedir para reanudar.
 *   - Escucha en 127.0.0.1 por defecto. No hay autenticacion: cualquiera que
 *     llegue al puerto puede mandar DMs con el token cargado. Exponerlo en una
 *     red requiere ponerle un proxy con auth delante.
 *
 * Flujo: POST /api/jobs (analiza en background) -> GET /api/jobs/:id (poll)
 *        -> POST /api/jobs/:id/start (corre en background, reanudable)
 *        -> POST /api/jobs/:id/pause -> GET /api/jobs/:id/export.csv
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseShortcode,
  resolveReel,
  fetchComments,
  buildPlan,
  runRecovery,
  tally,
  RecoveryError,
  MIN_INTERVAL_MS,
  DEFAULT_SEND_INTERVAL_MS,
  DEFAULT_REPLY_INTERVAL_MS,
  DEFAULT_WINDOW_SAFETY_HOURS,
  DEFAULT_GRAPH_VERSION,
  CARD_TITLE_MAX,
  CARD_BUTTON_TITLE_MAX,
} from "../src/recovery.mjs";
import { newJobId, saveJob, loadJobs, deleteJob, summaryOf, isValidJobId, storageDescription, store } from "../src/jobs.mjs";
import { verifyFirebaseIdToken, isAllowedUser, AuthError } from "../src/auth.mjs";
import { GraphError, listManagedPages } from "../src/meta.mjs";
import { toCsv } from "../src/csv.mjs";
import { loadLiveConfig, LiveConfigError } from "../src/live/config.mjs";
import { engine, bootEngine, LiveError } from "../src/live/engine.mjs";
import { createWebhookHandlers } from "../src/live/webhook.mjs";
import { validateTriggerInput, validateTriggerPatch, TriggerInputError } from "../src/live/rules.mjs";
import { isValidTriggerId } from "../src/live/triggers.mjs";

const PORT = Number(process.env.PORT ?? 8787);
// En Cloud Run (K_SERVICE) hay que escuchar en todas las interfaces; en una
// laptop, solo en localhost.
const HOST = process.env.HOST ?? (process.env.K_SERVICE ? "0.0.0.0" : "127.0.0.1");
const GRAPH_VERSION = process.env.GRAPH_VERSION ?? DEFAULT_GRAPH_VERSION;

// ── Autenticacion (Firebase, la misma de PreWave) ────────────────────────────
// AUTH_REQUIRED default: true si hay proyecto de Firebase configurado. Sin
// Firebase (uso local) no hay login, y el server solo escucha en localhost.
const csv = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const FIREBASE = {
  projectId: (process.env.FIREBASE_PROJECT_ID ?? "").trim(),
  apiKey: (process.env.FIREBASE_API_KEY ?? "").trim(),
  authDomain: (process.env.FIREBASE_AUTH_DOMAIN ?? "").trim(),
};
const AUTH_REQUIRED = (process.env.AUTH_REQUIRED ?? (FIREBASE.projectId ? "true" : "false")) === "true";
const ALLOWED = { domains: csv(process.env.AUTH_ALLOWED_DOMAINS), emails: csv(process.env.AUTH_ALLOWED_EMAILS) };

if (AUTH_REQUIRED) {
  const missing = Object.entries(FIREBASE).filter(([, v]) => !v).map(([k]) => `FIREBASE_${k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`);
  if (missing.length) {
    console.error(`AUTH_REQUIRED=true pero falta: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (ALLOWED.domains.length === 0 && ALLOWED.emails.length === 0) {
    console.error("AUTH_REQUIRED=true sin AUTH_ALLOWED_DOMAINS ni AUTH_ALLOWED_EMAILS: cualquier cuenta de Google entraria. Configura al menos uno (ej. AUTH_ALLOWED_DOMAINS=30x.com).");
    process.exit(1);
  }
}

// ── Modo en vivo (reemplazo de ManyChat) ────────────────────────────────────────────────
// Los pisos de ritmo se validan acá: un intervalo por debajo del tope de Meta
// no se nota hasta el envío 200, y para entonces ya hay un límite sobre la
// cuenta. Mejor no arrancar.
let LIVE;
try {
  LIVE = loadLiveConfig();
} catch (err) {
  if (!(err instanceof LiveConfigError)) throw err;
  console.error(err.message);
  process.exit(1);
}

const PUBLIC_DIR = new URL("./public/", import.meta.url);
const MAX_BODY = 1_000_000;
const LOG_KEEP = 300;

/** id -> job (se persiste) */
const jobs = new Map();
/** id -> token (SOLO memoria) */
const tokens = new Map();
/** id -> AbortController del run en curso */
const runners = new Map();

class HttpError extends Error {
  constructor(status, message, code = "bad_request") {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, message, code) => {
  throw new HttpError(status, message, code);
};

// ── Arranque: cargar jobs y marcar los que quedaron a medias ─────────────────
for (const job of await loadJobs()) {
  if (job.status === "running") {
    job.status = "interrupted";
    pushLog(job, "El servidor se reinició durante el envío. Pegá el token de nuevo y reanudá.");
    await saveJob(job);
  } else if (job.status === "analyzing") {
    job.status = "error";
    job.error = "El servidor se reinició durante el análisis. Creá el job de nuevo.";
    await saveJob(job);
  }
  jobs.set(job.id, job);
}

// El motor del modo en vivo arranca DESPUES de los jobs: comparte el store y,
// si había una recuperación a medio camino, ya quedó marcada como interrumpida.
const liveBoot = await bootEngine({ store, live: LIVE });
const webhooks = createWebhookHandlers({ live: LIVE, engine });

function pushLog(job, message) {
  job.log ??= [];
  job.log.push({ at: new Date().toISOString(), message });
  if (job.log.length > LOG_KEEP) job.log.splice(0, job.log.length - LOG_KEEP);
}

function describeFailure(err) {
  if (err instanceof RecoveryError) return err.message;
  if (err instanceof GraphError) {
    if (err.code === 190 || err.status === 401) return "Token inválido o expirado (#190). Generá uno nuevo en el Business Manager.";
    return `Meta #${err.code ?? err.status}${err.subcode ? `/${err.subcode}` : ""}: ${err.message}`;
  }
  return err.message;
}

// ── Validacion del formulario ────────────────────────────────────────────────
const str = (v) => String(v ?? "").trim();

function toList(v) {
  const raw = Array.isArray(v) ? v : String(v ?? "").split(/\r?\n/);
  return [...new Set(raw.map((t) => String(t).trim()).filter(Boolean))];
}

function intervalMs(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) fail(400, `${label} debe ser un número de milisegundos.`);
  if (n < MIN_INTERVAL_MS) {
    fail(400, `${label}: ${n} ms son más de 200 por hora, el tope de Meta. Mínimo ${MIN_INTERVAL_MS} ms.`);
  }
  return Math.round(n);
}

/**
 * Lo que hace falta para ANALIZAR (buscar el reel y clasificar comentarios).
 * La tarjeta y la respuesta se piden despues, cuando ya se sabe si hay alguien
 * a quien mandarle algo.
 */
function validateAnalysis(body) {
  const token = str(body.token);
  if (!token) fail(400, "Falta la clave de acceso (token) de Meta.");

  const shortcode = parseShortcode(body.reelUrl);
  if (!shortcode) fail(400, "Ese enlace no parece de un reel de Instagram. Ejemplo: https://www.instagram.com/reel/DbqpQCZFDNC/");

  const keyword = str(body.keyword);
  if (!keyword) fail(400, "Falta la palabra clave que la gente comentó.");

  const phrases = toList(String(body.phrases ?? "").split("|")).map((p) => p.toLowerCase());

  const windowSafetyHours = body.windowSafetyHours === undefined || body.windowSafetyHours === ""
    ? DEFAULT_WINDOW_SAFETY_HOURS
    : Number(body.windowSafetyHours);
  if (!Number.isFinite(windowSafetyHours) || windowSafetyHours < 0) fail(400, "El margen de ventana debe ser un número de horas ≥ 0.");

  return {
    token,
    input: {
      reelUrl: str(body.reelUrl),
      shortcode,
      keyword,
      card: null,
      replyTexts: [],
      phrases,
      sendIntervalMs: DEFAULT_SEND_INTERVAL_MS,
      replyIntervalMs: DEFAULT_REPLY_INTERVAL_MS,
      windowSafetyHours,
    },
  };
}

/** La tarjeta del DM, la respuesta publica y el ritmo. Se cargan antes de enviar. */
function validateMessages(body) {
  const card = {
    title: str(body.card?.title),
    buttonTitle: str(body.card?.buttonTitle),
    buttonUrl: str(body.card?.buttonUrl),
  };
  if (!card.title) fail(400, "Falta el título de la tarjeta del DM.");
  if (card.title.length > CARD_TITLE_MAX) fail(400, `El título de la tarjeta no puede pasar de ${CARD_TITLE_MAX} caracteres (límite de Meta).`);
  if (!card.buttonTitle) fail(400, "Falta el texto del botón.");
  if (card.buttonTitle.length > CARD_BUTTON_TITLE_MAX) fail(400, `El texto del botón no puede pasar de ${CARD_BUTTON_TITLE_MAX} caracteres (límite de Meta).`);
  try {
    const u = new URL(card.buttonUrl);
    if (!/^https?:$/.test(u.protocol)) throw new Error();
  } catch {
    fail(400, "El enlace del botón tiene que empezar con http:// o https://.");
  }

  return {
    card,
    replyTexts: toList(body.replyTexts),
    sendIntervalMs: intervalMs(body.sendIntervalMs, DEFAULT_SEND_INTERVAL_MS, "Intervalo entre DMs"),
    replyIntervalMs: intervalMs(body.replyIntervalMs, DEFAULT_REPLY_INTERVAL_MS, "Intervalo entre respuestas"),
  };
}

const hasMessages = (job) =>
  Boolean(job.input.card?.title && job.input.card?.buttonTitle && job.input.card?.buttonUrl);

// ── Analisis (background) ────────────────────────────────────────────────────
async function analyze(job, token) {
  const log = (m) => pushLog(job, m);
  try {
    log("Buscando el reel entre las cuentas de Instagram que administra el token…");
    const r = await resolveReel({ token, shortcode: job.input.shortcode, graphVersion: GRAPH_VERSION });
    job.resolved = {
      pageId: r.page.id,
      pageName: r.page.name,
      igUserId: r.ig.id,
      igUsername: r.ig.username,
      mediaId: r.media.id,
      permalink: r.media.permalink,
      publishedAt: r.media.timestamp,
      commentsCount: r.media.comments_count ?? null,
    };
    log(`Reel encontrado en @${r.ig.username} (página "${r.page.name}"). Bajando comentarios…`);
    await saveJob(job);

    const comments = await fetchComments({ token, mediaId: r.media.id, graphVersion: GRAPH_VERSION });
    const reported = job.resolved.commentsCount;
    log(
      `${comments.length} comentarios leídos` +
        (reported != null && reported > comments.length
          ? ` (Meta reporta ${reported}: la diferencia son cuentas privadas, que la API no expone y no se pueden recuperar).`
          : "."),
    );

    const plan = buildPlan({
      comments,
      keyword: job.input.keyword,
      ownerUsername: r.ig.username,
      phrases: job.input.phrases,
      safetyHours: job.input.windowSafetyHours,
    });
    job.counts = { total: plan.total, ...plan.counts };
    job.rows = plan.rows;
    job.status = "ready";
    log(`${plan.rows.length} persona(s) para recuperar.`);
  } catch (err) {
    job.status = "error";
    job.error = describeFailure(err);
    log(`Error: ${job.error}`);
  }
  await saveJob(job);
}

// ── Run (background) ─────────────────────────────────────────────────────────
function startRun(job, token) {
  const controller = new AbortController();
  runners.set(job.id, controller);
  job.status = "running";
  job.error = null;
  job.startedAt ??= new Date().toISOString();
  pushLog(job, `Arrancando envío…${job.startedBy ? ` (${job.startedBy})` : ""}`);

  (async () => {
    try {
      const outcome = await runRecovery(job, {
        token,
        graphVersion: GRAPH_VERSION,
        signal: controller.signal,
        onUpdate: () => saveJob(job),
        log: (m) => pushLog(job, m),
      });
      if (outcome === "done") {
        job.status = "done";
        job.finishedAt = new Date().toISOString();
        pushLog(job, "Listo.");
      } else {
        job.status = "paused";
        pushLog(job, "Pausado.");
      }
    } catch (err) {
      job.status = "error";
      job.error = describeFailure(err);
      pushLog(job, `Error: ${job.error}`);
    } finally {
      runners.delete(job.id);
      await saveJob(job);
    }
  })();
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "Body demasiado grande."));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "JSON inválido."));
      }
    });
    req.on("error", reject);
  });
}

/**
 * El cuerpo CRUDO, sin parsear. El webhook de Meta firma los BYTES: parsear y
 * volver a serializar cambia el JSON y la firma no daría nunca.
 */
function readRaw(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "Body demasiado grande."));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

async function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (rel.includes("..") || !/^[\w./-]+$/.test(rel)) return json(res, 404, { error: "No existe." });
  try {
    const data = await readFile(fileURLToPath(new URL(rel, PUBLIC_DIR)));
    res.writeHead(200, { "content-type": MIME[extname(rel)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  } catch {
    json(res, 404, { error: "No existe." });
  }
}

/** Lo que ve la UI. Nada sensible vive en el job, pero el token tampoco se cuela por aca. */
function view(job) {
  return {
    ...job,
    hasToken: tokens.has(job.id),
    hasMessages: hasMessages(job),
    isRunning: runners.has(job.id),
    tally: tally(job.rows ?? []),
  };
}

/**
 * Verifica la clave sin guardarla: lista las cuentas de Instagram que
 * administra. Es la tranquilidad de "esto funciona" antes de pedir nada mas.
 */
async function verifyToken(token) {
  let pages;
  try {
    pages = await listManagedPages({ token, graphVersion: GRAPH_VERSION });
  } catch (err) {
    if (err instanceof GraphError && (err.code === 190 || err.status === 401)) {
      fail(400, "Meta no acepta esta clave (#190): está vencida, mal copiada o revocada. Generá una nueva en el Business Manager.", "bad_token");
    }
    throw err;
  }
  const accounts = pages
    .filter((p) => p.instagram_business_account)
    .map((p) => ({ username: p.instagram_business_account.username, pageName: p.name }));
  if (accounts.length === 0) {
    fail(400, "La clave es válida pero no administra ninguna página con Instagram vinculado. Revisá que la página esté en el Business Manager y que el token tenga los permisos.", "no_pages");
  }
  return accounts;
}

/**
 * Quien llama. Con AUTH_REQUIRED: exige `Authorization: Bearer <ID token de
 * Firebase>`, lo verifica contra Google y comprueba que el correo este
 * permitido. Sin AUTH_REQUIRED (uso local) devuelve null.
 */
async function authenticate(req) {
  if (!AUTH_REQUIRED) return null;
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  if (!m) fail(401, "Iniciá sesión para usar la herramienta.", "unauthenticated");
  let claims;
  try {
    claims = await verifyFirebaseIdToken(m[1], { projectId: FIREBASE.projectId });
  } catch (err) {
    if (err instanceof AuthError) fail(401, "Tu sesión no es válida o venció. Volvé a iniciar sesión.", "unauthenticated");
    throw err;
  }
  if (!isAllowedUser(claims, ALLOWED)) {
    fail(403, `La cuenta ${claims.email ?? "(sin correo)"} no tiene acceso a esta herramienta.`, "forbidden");
  }
  return { uid: claims.uid, email: claims.email };
}

function getJob(id) {
  if (!isValidJobId(id)) fail(404, "Job no encontrado.", "not_found");
  const job = jobs.get(id);
  if (!job) fail(404, "Job no encontrado.", "not_found");
  return job;
}

const CSV_COLUMNS = [
  "comment_id", "username", "text", "comment_ts", "expires_at", "hours_left",
  "dm_status", "sent_at", "message_id", "recipient_id", "dm_error",
  "reply_status", "public_reply_id", "public_reply_at", "public_reply_text", "reply_error",
];

/** Mismas columnas que la recuperación (abre en la misma planilla) + las del modo en vivo. */
const LIVE_CSV_COLUMNS = [...CSV_COLUMNS, "source", "received_at", "attempts", "from_id"];

// ── Webhook de Meta (público: Meta no puede iniciar sesión con Firebase) ─────
async function handleWebhook(req, res, method, url) {
  if (method === "GET") {
    const r = webhooks.verify(url.searchParams);
    res.writeHead(r.status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    return res.end(r.body);
  }
  if (method === "POST") {
    const raw = await readRaw(req);
    const r = webhooks.event({ raw, signature: req.headers["x-hub-signature-256"] });
    return json(res, r.status, r.json);
  }
  return json(res, 405, { error: "Método no permitido." });
}

// ── Modo en vivo: /api/live/* (detrás del mismo login) ───────────────────────
async function handleLive(req, res, { pathname, method, user }) {
  if (method === "GET" && pathname === "/api/live/status") return json(res, 200, { status: engine.status() });

  if (pathname === "/api/live/triggers") {
    if (method === "GET") return json(res, 200, { triggers: engine.listTriggers() });
    if (method === "POST") {
      const input = validateTriggerInput(await readJson(req), LIVE);
      return json(res, 201, { trigger: await engine.createTrigger(input, user) });
    }
    return json(res, 405, { error: "Método no permitido." });
  }

  const m = pathname.match(/^\/api\/live\/triggers\/([^/]+)(?:\/(pause|activate|messages|export\.csv))?$/);
  if (!m) return json(res, 404, { error: "No existe." });
  const [, id, action] = m;
  if (!isValidTriggerId(id)) fail(404, "No encontré esa automatización.", "not_found");

  if (method === "GET" && !action) {
    const trigger = engine.getTrigger(id);
    const ledger = await engine.getLedger(id);
    const rows = Object.values(ledger.rows)
      .sort((a, b) => new Date(b.comment_ts) - new Date(a.comment_ts))
      .slice(0, 500);
    // seenIds son hasta 3000 ids que la UI no usa: no viajan en cada refresco.
    const { seenIds, ...cursor } = trigger.cursor ?? {};
    return json(res, 200, { trigger: { ...trigger, cursor: { ...cursor, seenCount: seenIds?.length ?? 0 } }, rows, counts: trigger.counts });
  }

  if (method === "GET" && action === "export.csv") {
    const trigger = engine.getTrigger(id);
    const ledger = await engine.getLedger(id);
    const rows = Object.values(ledger.rows).sort((a, b) => new Date(a.comment_ts) - new Date(b.comment_ts));
    res.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="automatizacion-${trigger.input.shortcode}.csv"`,
    });
    return res.end("﻿" + toCsv(LIVE_CSV_COLUMNS, rows));
  }

  if (method === "POST" && action === "pause") return json(res, 200, { trigger: await engine.pause(id) });
  if (method === "POST" && action === "activate") return json(res, 200, { trigger: await engine.activate(id) });
  if (method === "POST" && action === "messages") {
    const patch = validateTriggerPatch(await readJson(req));
    return json(res, 200, { trigger: await engine.updateMessages(id, patch) });
  }
  if (method === "DELETE" && !action) return json(res, 200, await engine.remove(id));

  return json(res, 405, { error: "Método no permitido." });
}

// ── Router ───────────────────────────────────────────────────────────────────
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const { pathname } = url;
  const method = req.method ?? "GET";

  // Meta no puede iniciar sesión: el webhook se autentica con la firma HMAC.
  if (pathname === "/webhooks/meta") return handleWebhook(req, res, method, url);

  if (!pathname.startsWith("/api/")) {
    if (method !== "GET") return json(res, 405, { error: "Método no permitido." });
    return serveStatic(res, pathname);
  }

  // Publico: lo que el browser necesita para mostrar el login. Solo la config
  // web de Firebase (que es publica por diseño) y si hace falta iniciar sesion.
  if (method === "GET" && pathname === "/api/config") {
    return json(res, 200, {
      auth: { required: AUTH_REQUIRED, firebase: AUTH_REQUIRED ? FIREBASE : null, allowedDomains: ALLOWED.domains },
      live: { enabled: LIVE.enabled, tokenConfigured: LIVE.tokenConfigured, webhookConfigured: LIVE.webhookConfigured },
    });
  }

  const user = await authenticate(req);

  if (pathname.startsWith("/api/live/")) return handleLive(req, res, { pathname, method, user });

  if (method === "GET" && pathname === "/api/jobs") {
    return json(res, 200, { jobs: [...jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map(summaryOf) });
  }

  if (method === "POST" && pathname === "/api/verify") {
    const body = await readJson(req);
    const token = str(body.token);
    if (!token) fail(400, "Pegá la clave de acceso primero.");
    return json(res, 200, { accounts: await verifyToken(token) });
  }

  if (method === "POST" && pathname === "/api/jobs") {
    const body = await readJson(req);
    const { token, input } = validateAnalysis(body);
    // Compatibilidad: si vienen los mensajes en la misma llamada, se validan y guardan.
    if (body.card && (str(body.card.title) || str(body.card.buttonTitle) || str(body.card.buttonUrl))) {
      Object.assign(input, validateMessages(body));
    }
    const job = {
      id: newJobId(),
      createdAt: new Date().toISOString(),
      createdBy: user?.email ?? null,
      status: "analyzing",
      input,
      resolved: null,
      counts: null,
      rows: [],
      progress: null,
      log: [],
      error: null,
    };
    jobs.set(job.id, job);
    tokens.set(job.id, token);
    await saveJob(job);
    analyze(job, token); // background
    return json(res, 202, { job: view(job) });
  }

  const m = pathname.match(/^\/api\/jobs\/([^/]+)(?:\/(start|pause|messages|export\.csv))?$/);
  if (!m) return json(res, 404, { error: "No existe." });
  const job = getJob(m[1]);
  const action = m[2];

  if (method === "GET" && !action) return json(res, 200, { job: view(job) });

  if (method === "DELETE" && !action) {
    if (runners.has(job.id)) fail(409, "El job está corriendo. Pausalo antes de borrarlo.", "running");
    jobs.delete(job.id);
    tokens.delete(job.id);
    await deleteJob(job.id);
    return json(res, 200, { ok: true });
  }

  if (method === "GET" && action === "export.csv") {
    res.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="recuperacion-${job.input.shortcode}.csv"`,
    });
    return res.end("﻿" + toCsv(CSV_COLUMNS, job.rows ?? []));
  }

  if (method === "POST" && action === "messages") {
    if (runners.has(job.id)) fail(409, "La recuperación está en curso: pausala antes de cambiar los mensajes.", "running");
    if (!["ready", "paused", "interrupted", "error"].includes(job.status)) {
      fail(409, "Todavía no terminó el análisis.", "bad_state");
    }
    const body = await readJson(req);
    Object.assign(job.input, validateMessages(body));
    await saveJob(job);
    return json(res, 200, { job: view(job) });
  }

  if (method === "POST" && action === "start") {
    const body = await readJson(req);
    const resumable = ["ready", "paused", "interrupted"].includes(job.status) || (job.status === "error" && job.rows?.length > 0 && job.resolved);
    if (!resumable) fail(409, `La recuperación está en estado "${job.status}" y no se puede arrancar.`, "bad_state");
    if (!hasMessages(job)) fail(400, "Falta la tarjeta del DM. Completá los mensajes antes de enviar.", "messages_required");
    if (runners.size > 0) fail(409, "Ya hay una recuperación en curso. Meta limita por cuenta: corré una a la vez.", "busy");
    const token = str(body.token) || tokens.get(job.id);
    if (!token) fail(400, "Hace falta la clave de acceso para reanudar (el servidor no la guarda en disco).", "token_required");
    tokens.set(job.id, token);
    if ((job.rows?.length ?? 0) === 0) {
      job.status = "done";
      job.finishedAt = new Date().toISOString();
      pushLog(job, "No había nadie para recuperar.");
      await saveJob(job);
      return json(res, 200, { job: view(job) });
    }
    job.startedBy = user?.email ?? null;
    startRun(job, token);
    await saveJob(job);
    return json(res, 202, { job: view(job) });
  }

  if (method === "POST" && action === "pause") {
    const controller = runners.get(job.id);
    if (!controller) fail(409, "El job no está corriendo.", "not_running");
    controller.abort();
    pushLog(job, "Pausa pedida: termina la fila en curso y para.");
    return json(res, 202, { job: view(job) });
  }

  return json(res, 405, { error: "Método no permitido." });
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (err instanceof HttpError) return json(res, err.status, { error: err.message, code: err.code });
    if (err instanceof TriggerInputError) return json(res, 400, { error: err.message, field: err.field, code: "bad_request" });
    if (err instanceof LiveError) return json(res, err.status, { error: err.message, code: err.code });
    console.error("[web] error:", err);
    json(res, 500, { error: "Error interno.", code: "internal" });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\nRecuperación de DMs — http://${HOST}:${PORT}`);
  console.log(`Jobs: ${jobs.size} cargados desde ${storageDescription()}. El token de Meta no se guarda.`);
  console.log(
    LIVE.enabled
      ? `Modo en vivo: ${liveBoot.started} automatización(es) andando de ${liveBoot.triggers} · sondeo cada ${LIVE.pollIntervalMs / 1000} s · webhook ${LIVE.webhookConfigured ? "configurado" : "sin App Secret (todavía)"}`
      : `Modo en vivo: apagado (${liveBoot.reason}).`,
  );
  console.log(
    AUTH_REQUIRED
      ? `Login: Firebase (${FIREBASE.projectId}) · permitidos: ${[...ALLOWED.domains.map((d) => `@${d}`), ...ALLOWED.emails].join(", ")}\n`
      : "Login: desactivado (uso local).\n",
  );
  if (!AUTH_REQUIRED && HOST !== "127.0.0.1" && HOST !== "localhost") {
    console.warn("AVISO: escuchando fuera de localhost SIN autenticación. Configurá Firebase (AUTH_REQUIRED=true) o poné un proxy con auth delante.\n");
  }
});
