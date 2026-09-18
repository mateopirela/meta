// api: las ESCRITURAS del frontend. Todo lo que valida algo o habla con Meta
// pasa por aca con la sesion de Supabase; las lecturas las hace el browser
// directo contra Postgres con RLS (sus propias filas y nada mas).
//
//   /me/token           PUT · DELETE        la clave de Meta del tenant
//   /jobs               POST                crear (analiza en background: worker-poll)
//   /jobs/:id/messages  POST                tarjeta + respuesta + ritmo
//   /jobs/:id/start     POST                a `running` (envia worker-send)
//   /jobs/:id/pause     POST
//   /jobs/:id           DELETE
//   /triggers           POST                crear (prepara en background)
//   /triggers/:id/pause|activate|messages   POST
//   /triggers/:id       DELETE
//
// Lo que no es tuyo no existe: 404, sin distinguir "no existe" de "es de otro".
import { serve, json, readJson, fail } from "../_shared/http.mjs";
import { admin, must, appendLog, newId, isValidId, env, nowIso } from "../_shared/db.mjs";
import { requireUser } from "../_shared/auth.mjs";
import { hasToken, encryptToken, forgetPageTokens, graphVersion } from "../_shared/tokens.mjs";
import { failOwner, NO_TOKEN_MSG } from "../_shared/engine.mjs";
import { listManagedPages, GraphError } from "../_shared/meta.mjs";
import {
  parseShortcode,
  MIN_INTERVAL_MS,
  DEFAULT_SEND_INTERVAL_MS,
  DEFAULT_REPLY_INTERVAL_MS,
  DEFAULT_WINDOW_SAFETY_HOURS,
  CARD_TITLE_MAX,
  CARD_BUTTON_TITLE_MAX,
} from "../_shared/recovery.mjs";
import { validateTriggerInput, validateTriggerPatch } from "../_shared/rules.mjs";

const str = (v) => String(v ?? "").trim();
const toList = (v) => {
  const raw = Array.isArray(v) ? v : String(v ?? "").split(/\r?\n/);
  return [...new Set(raw.map((t) => String(t).trim()).filter(Boolean))];
};
const num = (key, fallback) => {
  const n = Number(env(key));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
/** Los ritmos del entorno; el formulario puede subirlos, nunca bajarlos del piso de Meta. */
const LIVE_DEFAULTS = {
  sendIntervalMs: Math.max(num("LIVE_SEND_INTERVAL_MS", DEFAULT_SEND_INTERVAL_MS), MIN_INTERVAL_MS),
  replyIntervalMs: Math.max(num("LIVE_REPLY_INTERVAL_MS", DEFAULT_REPLY_INTERVAL_MS), MIN_INTERVAL_MS),
  windowSafetyHours: num("LIVE_WINDOW_SAFETY_HOURS", DEFAULT_WINDOW_SAFETY_HOURS),
};

function intervalMs(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) fail(400, `${label} debe ser un número de milisegundos.`);
  if (n < MIN_INTERVAL_MS) fail(400, `${label}: ${n} ms son más de 200 por hora, el tope de Meta. Mínimo ${MIN_INTERVAL_MS} ms.`);
  return Math.round(n);
}

/** Lo que hace falta para ANALIZAR. La tarjeta se pide despues, cuando ya se sabe si hay alguien. */
function validateAnalysis(body) {
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
    reelUrl: str(body.reelUrl),
    shortcode,
    keyword,
    card: null,
    replyTexts: [],
    phrases,
    sendIntervalMs: DEFAULT_SEND_INTERVAL_MS,
    replyIntervalMs: DEFAULT_REPLY_INTERVAL_MS,
    windowSafetyHours,
  };
}

/** La tarjeta del DM, la respuesta publica y el ritmo. */
function validateMessages(body) {
  const card = { title: str(body.card?.title), buttonTitle: str(body.card?.buttonTitle), buttonUrl: str(body.card?.buttonUrl) };
  if (!card.title) fail(400, "Falta el título de la tarjeta del DM.");
  if (card.title.length > CARD_TITLE_MAX) fail(400, `El título de la tarjeta no puede pasar de ${CARD_TITLE_MAX} caracteres (límite de Meta).`);
  if (!card.buttonTitle) fail(400, "Falta el texto del botón.");
  if (card.buttonTitle.length > CARD_BUTTON_TITLE_MAX) fail(400, `El texto del botón no puede pasar de ${CARD_BUTTON_TITLE_MAX} caracteres (límite de Meta).`);
  try {
    if (!/^https?:$/.test(new URL(card.buttonUrl).protocol)) throw new Error();
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

const hasMessages = (job) => Boolean(job.input?.card?.title && job.input?.card?.buttonTitle && job.input?.card?.buttonUrl);

/** Verifica una clave de Meta: las paginas + cuentas de IG que administra. Es lo que se guarda junto al token. */
async function verifyMetaToken(token) {
  let pages;
  try {
    pages = await listManagedPages({ token, graphVersion: graphVersion() });
  } catch (err) {
    if (err instanceof GraphError && (err.code === 190 || err.status === 401)) {
      fail(400, "Meta no acepta esta clave (#190): está vencida, mal copiada o revocada. Generá una nueva en el Business Manager.", "bad_token");
    }
    throw err;
  }
  const accounts = pages
    .filter((p) => p.instagram_business_account)
    .map((p) => ({ igUserId: p.instagram_business_account.id, username: p.instagram_business_account.username, pageId: p.id, pageName: p.name }));
  if (accounts.length === 0) {
    fail(400, "La clave es válida pero no administra ninguna página con Instagram vinculado. Revisá que la página esté en tu Business Manager y que el token tenga los permisos.", "no_pages");
  }
  return accounts;
}

async function meView(db, uid) {
  const p = must(await db.from("profiles").select("uid,email,meta_token_enc,meta_token_set_at,meta_accounts,created_at").eq("uid", uid).maybeSingle());
  const configured = Boolean(p?.meta_token_enc);
  const appSecret = env("META_APP_SECRET");
  return {
    uid,
    email: p?.email ?? null,
    createdAt: p?.created_at ?? null,
    meta: { configured, setAt: p?.meta_token_set_at ?? null, accounts: configured ? p.meta_accounts ?? [] : [] },
    // Lo del sistema que la UI necesita para explicar el estado del modo en vivo.
    system: {
      liveEnabled: env("LIVE_ENABLED") !== "false",
      webhookConfigured: Boolean(appSecret) && appSecret !== "unset",
      pollIntervalMs: Math.max(num("LIVE_POLL_INTERVAL_MS", 20000), 10000),
    },
  };
}

const ownerRunning = async (db, uid) =>
  (must(await db.from("jobs").select("id").eq("owner_uid", uid).eq("status", "running").limit(1))).length > 0;

async function requireToken(db, uid) {
  if (!(await hasToken(db, uid))) fail(409, NO_TOKEN_MSG, "token_required");
}

async function ownJob(db, id, uid) {
  if (!isValidId(id)) fail(404, "Job no encontrado.", "not_found");
  const job = must(await db.from("jobs").select("*").eq("id", id).eq("owner_uid", uid).maybeSingle());
  if (!job) fail(404, "Job no encontrado.", "not_found");
  return job;
}

async function ownTrigger(db, id, uid) {
  if (!isValidId(id)) fail(404, "No encontré esa automatización.", "not_found");
  const t = must(await db.from("triggers").select("*").eq("id", id).eq("owner_uid", uid).maybeSingle());
  if (!t) fail(404, "No encontré esa automatización.", "not_found");
  return t;
}

const reload = async (db, table, id) => must(await db.from(table).select("*").eq("id", id).single());

// ── Cuenta ───────────────────────────────────────────────────────────────────
async function handleMe(req, db, user, path, method) {
  if (method === "GET" && path === "/me") return json(200, { me: await meView(db, user.uid) });
  if (path !== "/me/token") return json(404, { error: "No existe." });

  if (method === "PUT" || method === "POST") {
    const token = str((await readJson(req)).token);
    if (!token) fail(400, "Pegá la clave de acceso (token) de Meta.");
    if (await ownerRunning(db, user.uid)) fail(409, "Tenés una recuperación en curso. Pausala antes de cambiar la clave.", "running");
    const accounts = await verifyMetaToken(token);
    must(await db.from("profiles").upsert(
      { uid: user.uid, email: user.email, meta_token_enc: await encryptToken(token), meta_token_set_at: nowIso(), meta_accounts: accounts },
      { onConflict: "uid" },
    ));
    await forgetPageTokens(db, user.uid);
    return json(200, { me: await meView(db, user.uid) });
  }
  if (method === "DELETE") {
    if (await ownerRunning(db, user.uid)) fail(409, "Tenés una recuperación en curso. Pausala antes de borrar la clave.", "running");
    must(await db.from("profiles").update({ meta_token_enc: null, meta_token_set_at: null, meta_accounts: [] }).eq("uid", user.uid));
    await forgetPageTokens(db, user.uid);
    await failOwner(db, user.uid, "Borraste tu clave de Meta. Cargá una nueva en Cuenta y volvé a activar.");
    return json(200, { me: await meView(db, user.uid) });
  }
  return json(405, { error: "Método no permitido." });
}

// ── Recuperaciones ───────────────────────────────────────────────────────────
async function handleJobs(req, db, user, path, method) {
  const uid = user.uid;
  if (path === "/jobs") {
    if (method !== "POST") return json(405, { error: "Método no permitido." });
    await requireToken(db, uid);
    const body = await readJson(req);
    const input = validateAnalysis(body);
    if (body.card && (str(body.card.title) || str(body.card.buttonTitle) || str(body.card.buttonUrl))) Object.assign(input, validateMessages(body));
    const job = { id: newId(), owner_uid: uid, status: "analyzing", input, created_by: user.email };
    must(await db.from("jobs").insert(job));
    return json(202, { job: await reload(db, "jobs", job.id) });
  }

  const m = path.match(/^\/jobs\/([^/]+)(?:\/(start|pause|messages))?$/);
  if (!m) return json(404, { error: "No existe." });
  const [, id, action] = m;
  const job = await ownJob(db, id, uid);

  if (method === "DELETE" && !action) {
    if (job.status === "running") fail(409, "El job está corriendo. Pausalo antes de borrarlo.", "running");
    must(await db.from("dm_rows").delete().eq("kind", "job").eq("parent_id", id));
    must(await db.from("jobs").delete().eq("id", id));
    return json(200, { ok: true });
  }
  if (method !== "POST") return json(405, { error: "Método no permitido." });

  if (action === "messages") {
    if (job.status === "running") fail(409, "La recuperación está en curso: pausala antes de cambiar los mensajes.", "running");
    if (!["ready", "paused", "interrupted", "error"].includes(job.status)) fail(409, "Todavía no terminó el análisis.", "bad_state");
    const input = { ...job.input, ...validateMessages(await readJson(req)) };
    must(await db.from("jobs").update({ input }).eq("id", id));
    return json(200, { job: await reload(db, "jobs", id) });
  }

  if (action === "start") {
    const resumable = ["ready", "paused", "interrupted"].includes(job.status) || (job.status === "error" && job.resolved);
    if (!resumable) fail(409, `La recuperación está en estado "${job.status}" y no se puede arrancar.`, "bad_state");
    if (!hasMessages(job)) fail(400, "Falta la tarjeta del DM. Completá los mensajes antes de enviar.", "messages_required");
    if (await ownerRunning(db, uid)) fail(409, "Ya tenés una recuperación en curso. Meta limita por cuenta: corré una a la vez.", "busy");
    await requireToken(db, uid);
    const { count: total, error: countErr } = await db.from("dm_rows").select("*", { count: "exact", head: true }).eq("kind", "job").eq("parent_id", id);
    if (countErr) throw new Error(`[db] ${countErr.message}`);
    if ((total ?? 0) === 0) {
      must(await db.from("jobs").update({ status: "done", finished_at: nowIso() }).eq("id", id));
      await appendLog(db, "job", id, "No había nadie para recuperar.");
      return json(200, { job: await reload(db, "jobs", id) });
    }
    // La respuesta publica solo aplica si hay textos; se decide al arrancar.
    const wantsReply = (job.input.replyTexts ?? []).length > 0;
    must(await db.from("dm_rows").update({ reply_status: wantsReply ? "pending" : "skipped" })
      .eq("kind", "job").eq("parent_id", id).in("reply_status", ["pending", "skipped"]));
    must(await db.from("jobs").update({ status: "running", error: null, started_by: user.email, started_at: job.started_at ?? nowIso() }).eq("id", id));
    await appendLog(db, "job", id, `Arrancando envío… (${user.email})`);
    return json(202, { job: await reload(db, "jobs", id) });
  }

  if (action === "pause") {
    if (job.status !== "running") fail(409, "El job no está corriendo.", "not_running");
    must(await db.from("jobs").update({ status: "paused" }).eq("id", id));
    await appendLog(db, "job", id, "Pausado: termina la fila en curso y para.");
    return json(202, { job: await reload(db, "jobs", id) });
  }
  return json(405, { error: "Método no permitido." });
}

// ── Automatizaciones ─────────────────────────────────────────────────────────
async function handleTriggers(req, db, user, path, method) {
  const uid = user.uid;
  if (path === "/triggers") {
    if (method !== "POST") return json(405, { error: "Método no permitido." });
    await requireToken(db, uid);
    const input = validateTriggerInput(await readJson(req), LIVE_DEFAULTS);
    const clash = must(await db.from("triggers").select("id,status").eq("owner_uid", uid).eq("input->>shortcode", input.shortcode).in("status", ["preparing", "active", "paused"]).limit(1));
    if (clash.length) fail(409, `Ya tenés una automatización para ese reel (${clash[0].status}). Editá esa en vez de crear otra.`, "duplicate");
    const trigger = { id: newId(), owner_uid: uid, status: "preparing", input, created_by: user.email };
    must(await db.from("triggers").insert(trigger));
    return json(201, { trigger: await reload(db, "triggers", trigger.id) });
  }

  const m = path.match(/^\/triggers\/([^/]+)(?:\/(pause|activate|messages))?$/);
  if (!m) return json(404, { error: "No existe." });
  const [, id, action] = m;
  const t = await ownTrigger(db, id, uid);

  if (method === "DELETE" && !action) {
    if (t.status === "active" || t.status === "preparing") fail(409, "Pausá la automatización antes de borrarla.", "running");
    must(await db.from("dm_rows").delete().eq("kind", "trigger").eq("parent_id", id));
    must(await db.from("triggers").delete().eq("id", id));
    return json(200, { ok: true });
  }
  if (method !== "POST") return json(405, { error: "Método no permitido." });

  if (action === "pause") {
    if (t.status === "preparing") fail(409, "Esperá a que termine de prepararse.", "bad_state");
    must(await db.from("triggers").update({ status: "paused" }).eq("id", id));
    await appendLog(db, "trigger", id, "Automatización pausada: no se detecta ni se envía nada. Lo que ya estaba en cola queda esperando.");
    return json(200, { trigger: await reload(db, "triggers", id) });
  }
  if (action === "activate") {
    if (t.status === "active") return json(200, { trigger: t });
    if (env("LIVE_ENABLED") === "false") fail(409, "El modo en vivo está apagado (LIVE_ENABLED=false).", "live_disabled");
    await requireToken(db, uid);
    if (!t.resolved) {
      must(await db.from("triggers").update({ status: "preparing", error: null, claimed_at: null }).eq("id", id));
    } else {
      must(await db.from("triggers").update({ status: "active", error: null }).eq("id", id));
      await appendLog(db, "trigger", id, "Automatización reactivada.");
    }
    return json(200, { trigger: await reload(db, "triggers", id) });
  }
  if (action === "messages") {
    if (t.status === "active" || t.status === "preparing") fail(409, "Pausá la automatización antes de cambiar los mensajes.", "running");
    const input = { ...t.input, ...validateTriggerPatch(await readJson(req)) };
    must(await db.from("triggers").update({ input }).eq("id", id));
    await appendLog(db, "trigger", id, "Mensajes actualizados.");
    return json(200, { trigger: await reload(db, "triggers", id) });
  }
  return json(405, { error: "Método no permitido." });
}

Deno.serve(serve(async (req) => {
  const path = new URL(req.url).pathname.replace(/^\/api(?=\/|$)/, "").replace(/\/+$/, "") || "/";
  const method = req.method;
  const user = await requireUser(req);
  const db = admin();
  if (path === "/me" || path.startsWith("/me/")) return handleMe(req, db, user, path, method);
  if (path === "/jobs" || path.startsWith("/jobs/")) return handleJobs(req, db, user, path, method);
  if (path === "/triggers" || path.startsWith("/triggers/")) return handleTriggers(req, db, user, path, method);
  return json(404, { error: "No existe." });
}));
