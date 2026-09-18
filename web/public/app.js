// Interfaz de la recuperación: cinco pasos, un job. Sin frameworks.
//
// Lee sus propios jobs y filas directo de Postgres (supabase-js + RLS) y
// escribe a través de la Edge Function `api`. La clave de Meta NO pasa por
// acá: vive cifrada en el servidor, cargada desde /settings.html. El paso 1
// solo confirma que está.
import { auth, sb, api, must, startSession, refreshMe } from "/session.js";
import { downloadCsv, JOB_COLUMNS } from "/csv.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const ICON = {
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  alert: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 8v5M12 16h.01" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>',
  spinner: '<svg class="spin" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="40 20" stroke-linecap="round"/></svg>',
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0 4-4m-4 4-4-4M4 19h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5v14l11-7z" fill="currentColor"/></svg>',
  external: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const state = { step: 1, job: null, poll: null };
const DRAFT_KEY = "dm-recovery-draft-v1";

const hasToken = () => Boolean(auth.me?.meta?.configured);
const accounts = () => auth.me?.meta?.accounts ?? [];

// ── Datos ─────────────────────────────────────────────────────────────────────
/** El job como lo entiende esta UI: nombres de siempre + filas + resúmenes. */
function jobView(job, rows = []) {
  return {
    ...job,
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    rows: rows.map((r) => ({ ...r, hours_left: (Date.parse(r.expires_at) - Date.now()) / 3_600_000 })),
    tally: job.tally ?? { dm: {}, reply: {} },
    hasMessages: Boolean(job.input?.card?.title && job.input?.card?.buttonTitle && job.input?.card?.buttonUrl),
    hasToken: hasToken(),
    log: (job.log ?? []).map((l) => ({ at: l.at, message: l.m ?? l.message ?? "" })),
  };
}

async function loadJob(id) {
  const [job, rows] = await Promise.all([
    must(await sb.from("jobs").select("*").eq("id", id).single()),
    must(await sb.from("dm_rows").select("*").eq("kind", "job").eq("parent_id", id).order("position", { ascending: true }).limit(2000)),
  ]);
  return jobView(job, rows);
}

async function loadJobs() {
  const jobs = must(await sb.from("jobs").select("id,created_at,created_by,status,input,resolved,counts").order("created_at", { ascending: false }).limit(20));
  return jobs.map((j) => ({
    id: j.id,
    createdAt: j.created_at,
    createdBy: j.created_by,
    status: j.status,
    shortcode: j.input?.shortcode,
    keyword: j.input?.keyword,
    igUsername: j.resolved?.igUsername ?? null,
    sendable: j.counts?.sendable ?? 0,
  }));
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer;
function toast(message, kind = "error") {
  const el = $("#toast");
  el.className = `toast ${kind}`;
  el.innerHTML = `${kind === "error" ? ICON.alert : ICON.check}<span>${esc(message)}</span>`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 5000);
}

// ── Pasos ─────────────────────────────────────────────────────────────────────
/** Hasta qué paso tiene sentido poder ir con lo que hay. */
function maxStep() {
  const j = state.job;
  if (j) {
    if (["running", "paused", "interrupted", "done"].includes(j.status)) return 5;
    if (j.status === "error" && j.rows?.length) return 5;
    if (j.status === "ready" && j.rows?.length) return j.hasMessages ? 5 : 4;
    return 3;
  }
  return hasToken() ? 2 : 1;
}

function setStep(n) {
  state.step = n;
  const max = maxStep();
  $$(".view").forEach((v) => (v.hidden = Number(v.dataset.view) !== n));
  $$("#steps li").forEach((li) => {
    const s = Number(li.dataset.step);
    li.classList.toggle("active", s === n);
    li.classList.toggle("done", s < n && s <= max);
    li.classList.toggle("locked", s > max);
    const btn = $(".step", li);
    btn.disabled = s > max;
    btn.setAttribute("aria-current", s === n ? "step" : "false");
  });
  if (n === 1) renderConnect();
  if (n === 3) renderAnalysis();
  if (n === 4) { fillMessagesFromJob(); updatePreview(); }
  if (n === 5) renderSend();
  $("#panel").focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.addEventListener("click", (e) => {
  const go = e.target.closest("[data-goto]");
  if (go && !go.disabled) setStep(Number(go.dataset.goto));
});

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-csv]");
  if (!b || !state.job) return;
  e.preventDefault();
  downloadCsv(`recuperacion-${state.job.input?.shortcode ?? state.job.id}.csv`, JOB_COLUMNS, state.job.rows);
});

// ── Borrador ──────────────────────────────────────────────────────────────────
const DRAFT_FIELDS = ["reelUrl", "keyword", "phrases", "windowSafetyHours", "cardTitle", "cardButtonTitle", "cardButtonUrl", "replyTexts", "sendIntervalSec", "replyIntervalSec"];
function saveDraft() {
  try {
    const draft = Object.fromEntries(DRAFT_FIELDS.map((id) => [id, $(`#${id}`)?.value ?? ""]));
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch { /* sin localStorage no pasa nada */ }
}
function restoreDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "{}");
    for (const [id, value] of Object.entries(draft)) {
      const el = $(`#${id}`);
      if (el && value !== "") el.value = value;
    }
  } catch { /* borrador roto: se ignora */ }
}
DRAFT_FIELDS.forEach((id) => $(`#${id}`)?.addEventListener("input", saveDraft));

// ── Validación inline ─────────────────────────────────────────────────────────
function setFieldError(id, message) {
  const input = $(`#${id}`);
  const err = $(`#${id}-error`);
  if (!input || !err) return;
  input.setAttribute("aria-invalid", message ? "true" : "false");
  err.textContent = message ?? "";
  err.hidden = !message;
}
const isReelUrl = (v) => /instagram\.com\/(?:[^/?#]+\/)?(?:reel|reels|p|tv)\/[A-Za-z0-9_-]+/i.test(v) || /^[A-Za-z0-9_-]{5,}$/.test(v.trim());
const isHttpUrl = (v) => { try { return /^https?:$/.test(new URL(v).protocol); } catch { return false; } };

$("#reelUrl").addEventListener("blur", (e) => setFieldError("reelUrl", e.target.value && !isReelUrl(e.target.value) ? "Ese enlace no parece de un reel. Copialo desde Instagram (··· → Copiar enlace)." : null));
$("#cardButtonUrl").addEventListener("blur", (e) => setFieldError("cardButtonUrl", e.target.value && !isHttpUrl(e.target.value) ? "El enlace tiene que empezar con https://" : null));

// ── Paso 1 · Conectar ─────────────────────────────────────────────────────────
const noTokenNotice = (lead) => `
  <div class="notice error">
    <p class="notice-title">${ICON.alert} Falta tu clave de Meta</p>
    <p>${lead}</p>
  </div>
  <div class="actions"><a class="button primary" href="/settings.html">Cargar mi clave en Cuenta</a></div>`;

function renderConnect() {
  const el = $("#connect");
  const m = auth.me?.meta;
  if (!m) { el.innerHTML = `<p class="muted">${ICON.spinner} Cargando tu cuenta…</p>`; return; }
  if (!m.configured) {
    el.innerHTML = noTokenNotice("Sin ella no se puede leer ningún reel ni mandar ningún DM. Se carga una sola vez y sirve para todas las recuperaciones y automatizaciones.");
    return;
  }
  el.innerHTML = `
    <div class="notice ok">
      <p class="notice-title">${ICON.check} Clave cargada</p>
      <p>Puede leer y responder en estas cuentas:</p>
      <ul class="chips">${accounts().map((a) => `<li class="chip"><strong>@${esc(a.username)}</strong><span>${esc(a.pageName)}</span></li>`).join("")}</ul>
      <p class="help">El reel tiene que ser de una de ellas. Si falta alguna, su página de Facebook no está en el Business Manager del token. <a href="/settings.html">Cambiar la clave</a>.</p>
    </div>
    <div class="actions"><button type="button" class="primary" data-goto="2">Continuar</button></div>`;
}

// ── Paso 2 · El reel ──────────────────────────────────────────────────────────
$("#form-reel").addEventListener("submit", async (e) => {
  e.preventDefault();
  const reelUrl = $("#reelUrl").value.trim();
  const keyword = $("#keyword").value.trim();
  let bad = false;
  if (!reelUrl || !isReelUrl(reelUrl)) { setFieldError("reelUrl", "Pegá el enlace del reel (··· → Copiar enlace en Instagram)."); bad = true; }
  if (!keyword) { setFieldError("keyword", "Escribí la palabra que la gente comentó."); bad = true; }
  if (bad) { $(`#${!reelUrl || !isReelUrl(reelUrl) ? "reelUrl" : "keyword"}`).focus(); return; }
  if (!hasToken()) { toast("Primero cargá tu clave de Meta en Cuenta."); return setStep(1); }

  const btn = $("#btn-analyze");
  btn.disabled = true;
  btn.innerHTML = `${ICON.spinner} Buscando…`;
  try {
    const { job } = await api("/jobs", {
      method: "POST",
      body: JSON.stringify({ reelUrl, keyword, phrases: $("#phrases").value, windowSafetyHours: $("#windowSafetyHours").value }),
    });
    state.job = jobView(job, []);
    setStep(3);
    schedulePoll();
    loadHistory();
  } catch (err) {
    if (err.code === "token_required") { await refreshMe().catch(() => {}); toast(err.message); return setStep(1); }
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Buscar comentarios";
  }
});

// ── Poll ──────────────────────────────────────────────────────────────────────
function schedulePoll() {
  clearTimeout(state.poll);
  if (state.job && ["analyzing", "running"].includes(state.job.status)) state.poll = setTimeout(refresh, 3000);
}
async function refresh() {
  if (!state.job) return;
  try {
    const job = await loadJob(state.job.id);
    const before = state.job.status;
    state.job = job;
    if (state.step === 3) renderAnalysis();
    if (state.step === 5) renderSend();
    if (before !== job.status) { setStep(state.step); loadHistory(); }
    schedulePoll();
  } catch (err) {
    toast(err.message);
  }
}

// ── Paso 3 · Quién falta ──────────────────────────────────────────────────────
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" }) : "");
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" }) : "");
const fmtDur = (ms) => {
  const min = Math.ceil(ms / 60000);
  if (min < 1) return "menos de un minuto";
  if (min < 90) return `${min} min`;
  return `${Math.round((min / 60) * 10) / 10} h`;
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function renderAnalysis() {
  const j = state.job;
  const el = $("#analysis");
  if (!j) { el.innerHTML = `<p class="muted">Todavía no buscamos ningún reel.</p>`; return; }

  const head = (title, lead) => `
    <header class="view-head">
      <p class="eyebrow">Paso 3 de 5</p>
      <h1>${title}</h1>
      ${lead ? `<p class="lead">${lead}</p>` : ""}
    </header>`;

  if (j.status === "analyzing") {
    const steps = [
      { label: "Encontrar el reel entre tus cuentas", done: Boolean(j.resolved) },
      { label: "Leer todos los comentarios", done: Boolean(j.counts) },
      { label: "Separar a quién no le llegó", done: Boolean(j.counts) },
    ];
    const activeIdx = steps.findIndex((s) => !s.done);
    el.innerHTML = head("Buscando…", `Arranca en menos de 20 segundos y tarda un poco más si el reel tiene miles de comentarios.`) + `
      <ol class="tasks">${steps.map((s, i) => `
        <li class="${s.done ? "done" : i === activeIdx ? "active" : ""}">
          <span class="task-icon">${s.done ? ICON.check : i === activeIdx ? ICON.spinner : ""}</span>
          <span>${esc(s.label)}</span>
        </li>`).join("")}
      </ol>
      ${logBlock(j)}`;
    return;
  }

  if (j.status === "error" && !j.rows?.length) {
    el.innerHTML = head("No pudimos analizar el reel") + `
      <div class="notice error"><p class="notice-title">${ICON.alert} ${esc(j.error)}</p></div>
      <div class="actions">
        <a class="button ghost" href="/settings.html">Revisar la clave</a>
        <button type="button" class="primary" data-goto="2">Probar con otro enlace</button>
      </div>`;
    return;
  }

  const c = j.counts ?? { total: 0, skip_no_keyword: 0, skip_already_processed: 0, skip_expired: 0, sendable: 0 };
  const withKeyword = c.total - c.skip_no_keyword;
  const unanswered = withKeyword - c.skip_already_processed;
  const n = c.sendable;
  const r = j.resolved;
  const kw = j.input.keyword;
  const pct = (v) => (c.total ? Math.max(2, Math.round((v / c.total) * 100)) : 0);

  const sentence = n > 0
    ? `De <strong>${c.total}</strong> comentarios, <strong>${withKeyword}</strong> dijeron «${esc(kw)}». A <strong>${c.skip_already_processed}</strong> ya les respondió ManyChat${c.skip_expired ? ` y <strong>${c.skip_expired}</strong> comentaron hace más de 7 días, así que Meta ya no deja escribirles` : ""}. <strong class="hi">Quedan ${plural(n, "persona", "personas")} por recuperar.</strong>`
    : `De <strong>${c.total}</strong> comentarios, <strong>${withKeyword}</strong> dijeron «${esc(kw)}» y ${withKeyword ? "todos ya tienen respuesta o pasaron los 7 días" : "nadie dijo la palabra"}. <strong>No hay nadie a quien enviarle.</strong>`;

  el.innerHTML = head(
    n > 0 ? `${plural(n, "persona quedó", "personas quedaron")} sin respuesta` : "Nadie quedó sin respuesta",
    r ? `Reel de <strong>@${esc(r.igUsername)}</strong> · <a href="${esc(r.permalink)}" target="_blank" rel="noopener">ver en Instagram ${ICON.external}</a> · publicado ${esc(fmtDate(r.publishedAt))}` : "",
  ) + `
    <div class="funnel" role="img" aria-label="Embudo: ${c.total} comentarios, ${withKeyword} con la palabra, ${unanswered} sin respuesta, ${n} dentro de los 7 días">
      ${funnelRow("Comentarios en el reel", c.total, pct(c.total))}
      ${funnelRow(`Dijeron «${esc(kw)}»`, withKeyword, pct(withKeyword))}
      ${funnelRow("Sin respuesta de ManyChat", unanswered, pct(unanswered))}
      ${funnelRow("Todavía dentro de los 7 días", n, pct(n), true)}
    </div>
    <p class="sentence">${sentence}</p>
    ${n > 0 ? peopleTable(j) : ""}
    <div class="actions">
      <button type="button" class="ghost" data-goto="2">Probar con otro reel</button>
      ${n > 0 ? `<button type="button" class="primary" data-goto="4">Continuar: qué reciben</button>` : ""}
    </div>`;
}

function funnelRow(label, value, pct, hi = false) {
  return `<div class="funnel-row ${hi ? "hi" : ""}"><span class="funnel-label">${label}</span><span class="funnel-bar"><span style="width:${pct}%"></span></span><span class="funnel-num">${value}</span></div>`;
}

const DM_LABEL = { pending: "pendiente", sending: "enviando…", sent: "DM enviado", already_replied: "ya tenía DM", comment_deleted: "comentario borrado", outside_window: "pasaron los 7 días", expired_mid_run: "pasaron los 7 días", needs_advanced_access: "no se pudo (Meta)", error: "no se pudo" };
const REPLY_LABEL = { pending: "pendiente", sending: "respondiendo…", replied: "respondido", already_replied: "ya tenía respuesta", comment_deleted: "borrado", skipped: "—", error: "no se pudo" };
const STATUS_LABEL = { analyzing: "Analizando", ready: "Lista para enviar", running: "Enviando", paused: "Pausada", interrupted: "Interrumpida", done: "Terminada", error: "Con error" };

function peopleTable(j, withStatus = false) {
  const rows = j.rows.slice(0, 300);
  return `
    <details class="people" ${withStatus || j.rows.length <= 12 ? "open" : ""}>
      <summary>Ver ${plural(j.rows.length, "persona", "personas")}${j.rows.length > 300 ? " (se muestran 300)" : ""}</summary>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Usuario</th><th>Comentó</th><th>Le quedan</th>${withStatus ? "<th>DM</th><th>Comentario</th>" : ""}</tr></thead>
          <tbody>${rows.map((p) => `
            <tr>
              <td><a href="https://www.instagram.com/${esc(p.username)}/" target="_blank" rel="noopener">@${esc(p.username)}</a></td>
              <td class="text" title="${esc(p.text)}">${esc(p.text.slice(0, 60))}${p.text.length > 60 ? "…" : ""}</td>
              <td class="num">${esc(Math.max(0, Math.round(p.hours_left)))} h</td>
              ${withStatus ? `<td class="st ${esc(p.dm_status)}" title="${esc(p.dm_error)}">${esc(DM_LABEL[p.dm_status] ?? p.dm_status)}</td>
              <td class="st ${esc(p.reply_status)}" title="${esc(p.reply_error)}">${j.input.replyTexts?.length ? esc(REPLY_LABEL[p.reply_status] ?? p.reply_status) : "—"}</td>` : ""}
            </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </details>`;
}

function logBlock(j, open = false) {
  if (!j.log?.length) return "";
  return `<details class="log-wrap" ${open ? "open" : ""}><summary>Ver detalle técnico</summary><div class="log">${j.log.slice(-60).map((l) => `<div><span>${esc(fmtTime(l.at))}</span> ${esc(l.message)}</div>`).join("")}</div></details>`;
}

// ── Paso 4 · Mensajes ─────────────────────────────────────────────────────────
const bindCounter = (id, counterId, max) => {
  const input = $(`#${id}`);
  const update = () => ($(`#${counterId}`).textContent = `${input.value.length}/${max}`);
  input.addEventListener("input", update);
  update();
};
bindCounter("cardTitle", "title-count", 80);
bindCounter("cardButtonTitle", "button-count", 20);

function fillMessagesFromJob() {
  const j = state.job;
  if (!j?.hasMessages) return;
  $("#cardTitle").value = j.input.card.title;
  $("#cardButtonTitle").value = j.input.card.buttonTitle;
  $("#cardButtonUrl").value = j.input.card.buttonUrl;
  $("#replyTexts").value = j.input.replyTexts.join("\n");
  $("#sendIntervalSec").value = Math.round(j.input.sendIntervalMs / 1000);
  $("#replyIntervalSec").value = Math.round(j.input.replyIntervalMs / 1000);
  $("#title-count").textContent = `${$("#cardTitle").value.length}/80`;
  $("#button-count").textContent = `${$("#cardButtonTitle").value.length}/20`;
}

function updatePreview() {
  const j = state.job;
  const owner = j?.resolved?.igUsername ?? accounts()[0]?.username ?? "tu_cuenta";
  const person = j?.rows?.[0]?.username ?? "persona";
  const comment = j?.rows?.[0]?.text ?? j?.input?.keyword ?? $("#keyword").value ?? "IA";
  const replies = $("#replyTexts").value.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);

  $("#pv-user").textContent = person;
  $("#pv-avatar").textContent = person[0]?.toUpperCase() ?? "P";
  $("#pv-comment").textContent = comment.length > 48 ? `${comment.slice(0, 48)}…` : comment;
  $("#pv-owner").textContent = owner;
  $("#pv-owner-avatar").textContent = owner[0]?.toUpperCase() ?? "T";
  $("#pv-owner-avatar-2").textContent = owner[0]?.toUpperCase() ?? "T";
  $("#pv-reply-wrap").hidden = replies.length === 0;
  $("#pv-reply").textContent = replies[0] ?? "";
  $("#pv-title").textContent = $("#cardTitle").value.trim() || "Título de la tarjeta";
  $("#pv-title").classList.toggle("placeholder", !$("#cardTitle").value.trim());
  $("#pv-button").textContent = $("#cardButtonTitle").value.trim() || "Botón";
  $("#pv-button").classList.toggle("placeholder", !$("#cardButtonTitle").value.trim());
}
["cardTitle", "cardButtonTitle", "replyTexts", "keyword"].forEach((id) => $(`#${id}`).addEventListener("input", updatePreview));

$("#form-messages").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("#cardTitle").value.trim();
  const buttonTitle = $("#cardButtonTitle").value.trim();
  const buttonUrl = $("#cardButtonUrl").value.trim();
  const problems = [
    ["cardTitle", title ? null : "Escribí el título que verá la persona."],
    ["cardButtonTitle", buttonTitle ? null : "Escribí el texto del botón."],
    ["cardButtonUrl", isHttpUrl(buttonUrl) ? null : "Pegá el enlace completo, con https://"],
  ];
  problems.forEach(([id, msg]) => setFieldError(id, msg));
  const first = problems.find(([, msg]) => msg);
  if (first) return $(`#${first[0]}`).focus();
  if (!state.job) return toast("Primero buscá el reel (paso 2).");

  const btn = $("#btn-messages");
  btn.disabled = true;
  try {
    const { job } = await api(`/jobs/${state.job.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        card: { title, buttonTitle, buttonUrl },
        replyTexts: $("#replyTexts").value,
        sendIntervalMs: Number($("#sendIntervalSec").value) * 1000,
        replyIntervalMs: Number($("#replyIntervalSec").value) * 1000,
      }),
    });
    state.job = jobView(job, state.job.rows);
    setStep(5);
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

// ── Paso 5 · Enviar ───────────────────────────────────────────────────────────
const sum = (obj, keys) => keys.reduce((s, k) => s + (obj[k] ?? 0), 0);

function renderSend() {
  const j = state.job;
  const el = $("#send");
  if (!j) { el.innerHTML = `<p class="muted">Todavía no hay nada para enviar.</p>`; return; }

  const n = j.rows?.length ?? 0;
  const t = j.tally ?? { dm: {}, reply: {} };
  const hasReplies = j.input.replyTexts?.length > 0;
  const head = (title, lead) => `<header class="view-head"><p class="eyebrow">Paso 5 de 5</p><h1>${title}</h1>${lead ? `<p class="lead">${lead}</p>` : ""}</header>`;
  const tokenNotice = j.hasToken ? "" : `
    <div class="notice error">
      <p class="notice-title">${ICON.alert} Falta tu clave de Meta</p>
      <p>Esta recuperación no puede enviar hasta que cargues una clave en <a href="/settings.html">Cuenta</a>. Lo que ya se envió quedó registrado.</p>
    </div>`;
  const recap = `
    <div class="recap">
      <div class="recap-item"><span class="recap-k">Personas</span><span class="recap-v">${n}</span></div>
      <div class="recap-item"><span class="recap-k">Mensaje directo</span><span class="recap-v">${esc(j.input.card?.title ?? "")} <span class="pill">${esc(j.input.card?.buttonTitle ?? "")}</span></span></div>
      <div class="recap-item"><span class="recap-k">En el comentario</span><span class="recap-v">${hasReplies ? esc(j.input.replyTexts[0]) + (j.input.replyTexts.length > 1 ? ` <span class="muted">(+${j.input.replyTexts.length - 1} variantes)</span>` : "") : '<span class="muted">Sin respuesta pública</span>'}</span></div>
      <div class="recap-item"><span class="recap-k">Tiempo estimado</span><span class="recap-v">${fmtDur(n * j.input.sendIntervalMs)}${hasReplies ? ` + ${fmtDur(n * j.input.replyIntervalMs)} de respuestas` : ""}</span></div>
    </div>`;

  if (j.status === "ready") {
    el.innerHTML = head("Revisar y enviar", "Esto es lo que va a pasar. Los mensajes son reales y no se pueden deshacer, pero podés pausar en cualquier momento y cerrar esta pestaña sin cortar el envío.") + recap + tokenNotice + `
      <label class="confirm">
        <input type="checkbox" id="confirm-check" ${j.hasToken ? "" : "disabled"}>
        <span>Entiendo que se van a enviar mensajes reales a ${plural(n, "persona", "personas")}.</span>
      </label>
      <div class="actions">
        <button type="button" class="ghost" data-goto="4">Cambiar los mensajes</button>
        <button type="button" class="primary" id="btn-start" disabled>Enviar ahora</button>
      </div>`;
    $("#confirm-check").addEventListener("change", (e) => ($("#btn-start").disabled = !e.target.checked));
    $("#btn-start").addEventListener("click", () => startJob());
    return;
  }

  // Corriendo, pausada, terminada o con error a mitad de camino.
  const dmPending = sum(t.dm, ["pending", "sending"]);
  const dmDone = n - dmPending;
  const dmSent = t.dm.sent ?? 0;
  const replyPending = sum(t.reply, ["pending", "sending"]);
  const replyDone = sum(t.reply, ["replied", "already_replied", "comment_deleted", "error"]);
  const replyTarget = dmSent;
  const phase = dmPending > 0 ? "dm" : "reply";
  const running = j.status === "running";

  const dmState = phase === "dm" && running ? "active" : dmPending === 0 ? "done" : "";
  const replyState = !hasReplies ? "skip" : j.status === "done" ? "done" : phase === "reply" && running ? "active" : "";
  const bar = (done, total) => `<span class="mini-bar" aria-hidden="true"><span style="width:${total ? Math.round((done / total) * 100) : 0}%"></span></span>`;

  const titleByStatus = { running: "Enviando…", paused: "Pausada", interrupted: "Se interrumpió", done: "Listo", error: "Se detuvo por un error" };
  const remaining = phase === "dm" ? dmPending * j.input.sendIntervalMs : replyPending * j.input.replyIntervalMs;
  const leadByStatus = {
    running: `Podés cerrar esta pestaña: el envío sigue en el servidor. Quedan ~${fmtDur(remaining)} de esta fase.`,
    paused: "Nada se perdió. Cuando quieras, reanudá y sigue desde donde quedó.",
    interrupted: "Se interrumpió a mitad del envío. Nada se duplicó: reanudá y sigue desde donde quedó.",
    done: `${plural(dmSent, "persona recibió", "personas recibieron")} el mensaje directo${hasReplies ? ` y ${plural(t.reply.replied ?? 0, "comentario fue respondido", "comentarios fueron respondidos")}` : ""}.`,
    error: "Lo que ya se envió quedó registrado. Corregí lo que indica el error y reintentá.",
  };

  const canResume = ["paused", "interrupted"].includes(j.status) || (j.status === "error" && j.resolved);

  el.innerHTML = head(titleByStatus[j.status] ?? STATUS_LABEL[j.status], leadByStatus[j.status] ?? "") + `
    ${j.status === "error" ? `<div class="notice error"><p class="notice-title">${ICON.alert} ${esc(j.error)}</p></div>` : ""}
    ${j.status === "done" ? `<div class="notice ok"><p class="notice-title">${ICON.check} Recuperación terminada</p></div>` : ""}
    <ol class="tasks big">
      <li class="${dmState}">
        <span class="task-icon">${dmState === "done" ? ICON.check : dmState === "active" ? ICON.spinner : ""}</span>
        <div class="task-body">
          <div class="task-head"><span>1. Mandar el mensaje directo</span><span class="task-count">${dmDone}/${n}</span></div>
          ${bar(dmDone, n)}
          <p class="task-detail">${dmSent} enviados${t.dm.already_replied ? ` · ${t.dm.already_replied} ya lo tenían` : ""}${(t.dm.expired_mid_run ?? 0) + (t.dm.outside_window ?? 0) ? ` · ${(t.dm.expired_mid_run ?? 0) + (t.dm.outside_window ?? 0)} pasaron los 7 días` : ""}${(t.dm.error ?? 0) + (t.dm.needs_advanced_access ?? 0) ? ` · ${(t.dm.error ?? 0) + (t.dm.needs_advanced_access ?? 0)} no se pudo` : ""}</p>
        </div>
      </li>
      <li class="${replyState}">
        <span class="task-icon">${replyState === "done" ? ICON.check : replyState === "active" ? ICON.spinner : ""}</span>
        <div class="task-body">
          <div class="task-head"><span>2. Responder el comentario</span><span class="task-count">${hasReplies ? `${replyDone}/${replyTarget}` : "—"}</span></div>
          ${hasReplies ? bar(replyDone, replyTarget) : ""}
          <p class="task-detail">${hasReplies ? `${t.reply.replied ?? 0} respondidos${t.reply.already_replied ? ` · ${t.reply.already_replied} ya tenían respuesta` : ""}${t.reply.error ? ` · ${t.reply.error} no se pudo` : ""}` : "No se configuró respuesta pública."}</p>
        </div>
      </li>
    </ol>
    ${canResume ? tokenNotice : ""}
    <div class="actions">
      ${running ? `<button type="button" class="ghost" id="btn-pause">${ICON.pause} Pausar</button>` : ""}
      ${canResume && j.hasToken ? `<button type="button" class="primary" id="btn-start">${ICON.play} ${j.status === "error" ? "Reintentar" : "Reanudar"}</button>` : ""}
      <button type="button" class="ghost" data-csv>${ICON.download} Descargar lista (CSV)</button>
      ${j.status === "done" ? `<button type="button" class="ghost" id="btn-new">Empezar otra recuperación</button>` : ""}
    </div>
    ${peopleTable(j, true)}
    ${logBlock(j)}`;

  $("#btn-pause")?.addEventListener("click", pauseJob);
  $("#btn-start")?.addEventListener("click", () => startJob());
  $("#btn-new")?.addEventListener("click", () => { state.job = null; setStep(2); });
}

async function startJob() {
  const j = state.job;
  const btn = $("#btn-start");
  if (btn) { btn.disabled = true; btn.innerHTML = `${ICON.spinner} Arrancando…`; }
  try {
    const { job } = await api(`/jobs/${j.id}/start`, { method: "POST", body: "{}" });
    state.job = jobView(job, j.rows);
    renderSend();
    schedulePoll();
    loadHistory();
  } catch (err) {
    if (err.code === "token_required") await refreshMe().catch(() => {});
    toast(err.message);
    renderSend();
  }
}

async function pauseJob() {
  try {
    const { job } = await api(`/jobs/${state.job.id}/pause`, { method: "POST", body: "{}" });
    state.job = jobView(job, state.job.rows);
    toast("Pausando: termina la persona en curso y se detiene.", "ok");
    renderSend();
    schedulePoll();
  } catch (err) {
    toast(err.message);
  }
}

// ── Historial ─────────────────────────────────────────────────────────────────
async function loadHistory() {
  try {
    const jobs = await loadJobs();
    const ul = $("#history");
    if (jobs.length === 0) { ul.innerHTML = `<li class="muted">Todavía no hay ninguna.</li>`; return jobs; }
    ul.innerHTML = jobs.slice(0, 12).map((j) => `
      <li>
        <button type="button" class="history-item ${state.job?.id === j.id ? "current" : ""}" data-open="${esc(j.id)}">
          <span class="badge ${esc(j.status)}">${esc(STATUS_LABEL[j.status] ?? j.status)}</span>
          <span class="history-main">${j.igUsername ? `@${esc(j.igUsername)} · ` : ""}«${esc(j.keyword)}»${j.sendable ? ` · ${plural(j.sendable, "persona", "personas")}` : ""}</span>
          <span class="history-date">${esc(fmtDate(j.createdAt))}</span>
        </button>
      </li>`).join("");
    return jobs;
  } catch { return []; }
}
$("#history").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-open]");
  if (!btn) return;
  try {
    openJob(await loadJob(btn.dataset.open));
  } catch (err) {
    toast(err.message);
  }
});

function openJob(job) {
  state.job = job;
  const target = job.status === "analyzing" ? 3
    : ["running", "paused", "interrupted", "done"].includes(job.status) ? 5
    : job.status === "error" ? (job.rows?.length ? 5 : 3)
    : job.hasMessages ? 5
    : job.rows?.length ? 4 : 3;
  setStep(target);
  schedulePoll();
  loadHistory();
}

// ── Arranque ──────────────────────────────────────────────────────────────────
let appStarted = false;
async function initApp() {
  if (appStarted) { loadHistory(); return; }
  appStarted = true;
  restoreDraft();
  updatePreview();
  setStep(1);
  const jobs = await loadHistory();
  const live = jobs.find((j) => ["running", "analyzing"].includes(j.status));
  if (live) {
    try { openJob(await loadJob(live.id)); } catch { /* nada */ }
  }
}

startSession({ title: "Recuperación de DMs", onApp: initApp });
