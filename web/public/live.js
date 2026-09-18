// Automatizaciones en vivo: un reel + una palabra y el DM sale solo. Sin frameworks.
//
// Tres vistas en una sola página: la lista (con el estado del sistema), el alta
// y el detalle. Lee sus propias automatizaciones y filas de Postgres
// (supabase-js + RLS) y escribe a través de la Edge Function `api`. Los
// patrones (toast(), esc(), el sondeo) están COPIADOS de app.js a propósito:
// cada página se sirve sola. La sesión sí es compartida (session.js).
import { auth, sb, api, must, startSession } from "/session.js";
import { downloadCsv, TRIGGER_COLUMNS } from "/csv.js";

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
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 19l-7-7 7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const state = {
  view: "list",
  triggers: [],          // resumen de cada automatización
  webhook: null,         // fila de webhook_stats
  detail: null,          // { trigger, rows, counts }
  detailId: null,
  poll: null,
  loading: false,
  phrasesTouched: false, // el usuario editó las frases de "ya atendido" a mano
};

const hasToken = () => Boolean(auth.me?.meta?.configured);
const system = () => auth.me?.system ?? { liveEnabled: true, webhookConfigured: false, pollIntervalMs: 20000 };

// ── Datos ─────────────────────────────────────────────────────────────────────
const summaryOf = (t) => ({
  id: t.id,
  status: t.status,
  error: t.error ?? null,
  shortcode: t.input?.shortcode,
  reel: t.input?.reel,
  permalink: t.resolved?.permalink ?? null,
  igUsername: t.resolved?.igUsername ?? null,
  igUserId: t.resolved?.igUserId ?? null,
  keywords: t.input?.keywords ?? [],
  counts: t.counts ?? {},
  lastEventAt: t.last_event_at ?? null,
  createdAt: t.created_at,
  createdBy: t.created_by ?? null,
});

const detailOf = (t) => ({
  ...t,
  lastEventAt: t.last_event_at ?? null,
  createdAt: t.created_at,
  createdBy: t.created_by ?? null,
  cursor: { ...(t.cursor ?? {}), seenIds: undefined, seenCount: t.cursor?.seenIds?.length ?? 0 },
  log: (t.log ?? []).map((l) => ({ at: l.at, m: l.m ?? l.message ?? "" })),
});

async function loadAll() {
  const [triggers, webhook] = await Promise.all([
    must(await sb.from("triggers").select("id,status,error,input,resolved,counts,last_event_at,created_at,created_by").order("created_at", { ascending: false }).limit(100)),
    must(await sb.from("webhook_stats").select("*").maybeSingle()),
  ]);
  state.triggers = triggers.map(summaryOf);
  state.webhook = webhook;
}

async function loadDetail(id) {
  try {
    const [t, rows] = await Promise.all([
      must(await sb.from("triggers").select("*").eq("id", id).maybeSingle()),
      must(await sb.from("dm_rows").select("*").eq("kind", "trigger").eq("parent_id", id).order("comment_ts", { ascending: false }).limit(500)),
    ]);
    if (state.detailId !== id) return;
    if (!t) {
      state.detailId = null;
      state.detail = null;
      toast("Esa automatización ya no existe.");
      setView("list");
      return;
    }
    state.detail = { trigger: detailOf(t), rows, counts: t.counts };
  } catch (err) {
    toast(err.message);
  }
}

/** Lo que la lista muestra por cuenta: cuánto hay en cola, sumando sus automatizaciones activas. */
function accountsStatus() {
  const acc = new Map();
  for (const t of state.triggers) {
    if (t.status !== "active" || !t.igUserId) continue;
    const a = acc.get(t.igUserId) ?? { igUserId: t.igUserId, igUsername: t.igUsername, pending: 0 };
    a.pending += t.counts?.pending ?? 0;
    acc.set(t.igUserId, a);
  }
  return [...acc.values()];
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

// ── Formato ───────────────────────────────────────────────────────────────────
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" }) : "");
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" }) : "");
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "hace 2 min" — para el último comentario / último evento del webhook. */
function fmtAgo(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  if (ms < 0 || ms < 45_000) return "hace unos segundos";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}

// ── Etiquetas ─────────────────────────────────────────────────────────────────
const STATUS_LABEL = { preparing: "Preparando", active: "Activa", paused: "Pausada", error: "Error" };
const STATUS_HINT = {
  preparing: "Estamos buscando el reel y dejando la cola lista: tarda menos de un minuto.",
  active: "Cada comentario nuevo con la palabra recibe su DM solo, sin que nadie mire.",
  paused: "No entra ni sale nada. Lo que quedó en cola te espera para cuando la actives.",
  error: "Se detuvo sola. Abajo está el motivo: corregilo y activala de nuevo.",
};
const DM_LABEL = {
  pending: "En cola", sending: "Enviando…", sent: "Enviado", already_replied: "Ya tenía DM", comment_deleted: "Comentario borrado",
  expired_mid_run: "Fuera de ventana", outside_window: "Fuera de ventana",
  needs_advanced_access: "Necesita acceso avanzado", error: "Error",
};
const REPLY_LABEL = {
  pending: "Pendiente", sending: "Respondiendo…", replied: "Respondido", already_replied: "Ya tenía respuesta",
  comment_deleted: "Comentario borrado", skipped: "—", error: "Error",
};
const SOURCE_LABEL = { webhook: "Webhook", poll: "Sondeo", backfill: "Anteriores" };

const statusPill = (s) => `<span class="pill st st-${esc(s)}">${esc(STATUS_LABEL[s] ?? s)}</span>`;

// ── Vistas ────────────────────────────────────────────────────────────────────
function setView(v) {
  state.view = v;
  $$(".view").forEach((el) => (el.hidden = el.dataset.view !== v));
  $$("[data-view-goto]").forEach((b) => b.classList.toggle("current", b.dataset.viewGoto === v));
  render();
  $("#panel").focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function render() {
  renderRail();
  if (state.view === "list") { renderStatus(); renderList(); }
  if (state.view === "new") { renderNewBanner(); updatePreview(); }
  // Con el editor abierto no se repinta el detalle: el sondeo borraría lo que
  // se está escribiendo. Vuelve a actualizarse al cerrarlo.
  if (state.view === "detail" && !$("#edit-box")?.open) renderDetail();
}

document.addEventListener("click", (e) => {
  const go = e.target.closest("[data-view-goto]");
  if (go && !go.disabled) setView(go.dataset.viewGoto);
});

// ── Estado del sistema ────────────────────────────────────────────────────────
function renderStatus() {
  const el = $("#status-strip");
  const sys = system();
  const wh = state.webhook ?? {};
  const pollSec = Math.round((sys.pollIntervalMs ?? 20000) / 1000);

  const envio = !hasToken()
    ? { dot: "bad", title: "Falta tu clave de Meta", note: 'Nadie recibe nada hasta que cargues tu clave en <a href="/settings.html">Cuenta</a>. Podés dejar las automatizaciones armadas: las activás cuando esté.' }
    : !sys.liveEnabled
      ? { dot: "warn", title: "Desactivado (<code>LIVE_ENABLED=false</code>)", note: "Las automatizaciones quedan guardadas pero no se manda ni un mensaje: es el interruptor general." }
      : { dot: "ok", title: "Activo", note: "Cada comentario que diga la palabra recibe su DM, a un ritmo de 200 por hora (el tope de Meta)." };

  const deteccion = sys.webhookConfigured
    ? {
        dot: wh.last_event_at ? "ok" : "warn",
        title: `Instantánea (webhook)${wh.last_event_at ? ` · último evento ${fmtAgo(wh.last_event_at)}` : ""}`,
        note: wh.last_event_at
          ? `Meta nos avisa en el momento en que alguien comenta. El sondeo cada ${pollSec} s sigue corriendo de red de seguridad.${wh.events ? ` ${wh.events} eventos recibidos, ${wh.accepted ?? 0} con la palabra.` : ""}`
          : `El webhook está conectado pero todavía no llegó ningún evento. Mientras tanto el sondeo revisa el reel cada ${pollSec} s.`,
      }
    : {
        dot: "warn",
        title: `Cada ${pollSec} s (sondeo)`,
        note: "Revisamos el reel nosotros, así que un comentario puede tardar hasta ese tiempo en recibir su DM. La detección instantánea se activa sola cuando se configure el webhook de Meta.",
      };

  const accounts = accountsStatus().map((a) => `
    <div class="status-row">
      <span class="status-dot ${a.pending ? "warn" : "ok"}"></span>
      <span class="status-k">@${esc(a.igUsername ?? a.igUserId)}</span>
      <span class="status-v">${plural(a.pending ?? 0, "persona en cola", "personas en cola")}
        <span class="status-note">Sale un DM cada 18 s por cuenta.</span>
      </span>
    </div>`).join("");

  el.innerHTML = `
    <div class="status-strip">
      <div class="status-row">
        <span class="status-dot ${envio.dot}"></span>
        <span class="status-k">Envío automático</span>
        <span class="status-v">${envio.title}<span class="status-note">${envio.note}</span></span>
      </div>
      <div class="status-row">
        <span class="status-dot ${deteccion.dot}"></span>
        <span class="status-k">Detección</span>
        <span class="status-v">${deteccion.title}<span class="status-note">${deteccion.note}</span></span>
      </div>
      ${accounts}
    </div>`;
}

// ── Lista ─────────────────────────────────────────────────────────────────────
function countsRow(c = {}, { big = false } = {}) {
  const items = [
    { k: "En cola", v: c.pending ?? 0, cls: "" },
    { k: "DM enviados", v: c.sent ?? 0, cls: c.sent ? "hi" : "" },
    { k: "Respondidos", v: c.replied ?? 0, cls: "" },
    { k: "Errores", v: c.errors ?? 0, cls: c.errors ? "bad" : "" },
  ];
  if (big) {
    items.push({ k: "Descartados", v: c.skipped ?? 0, cls: "" });
    items.push({ k: "Sin la palabra", v: c.ignored ?? 0, cls: "" });
  }
  return `<ul class="counts">${items.map((i) => `
    <li class="${i.cls}"><span class="count-n">${esc(i.v)}</span><span class="count-k">${i.k}</span></li>`).join("")}</ul>`;
}

const keywordChips = (kws = []) => kws.map((k) => `<span class="kw">${esc(k)}</span>`).join("");

function triggerCard(t) {
  const acciones = t.status === "active"
    ? `<button type="button" class="ghost" data-act="pause" data-id="${esc(t.id)}">${ICON.pause} Pausar</button>`
    : t.status === "preparing"
      ? ""
      : `<button type="button" class="ghost" data-act="activate" data-id="${esc(t.id)}">${ICON.play} Activar</button>`;

  return `
    <article class="trigger">
      <div class="trigger-head">
        ${statusPill(t.status)}
        <h2 class="trigger-title">@${esc(t.igUsername ?? "cuenta")} · ${keywordChips(t.keywords ?? [])}</h2>
      </div>
      <p class="trigger-meta">
        ${t.permalink ? `<a href="${esc(t.permalink)}" target="_blank" rel="noopener">ver el reel ${ICON.external}</a> · ` : ""}
        ${t.lastEventAt ? `último comentario ${esc(fmtAgo(t.lastEventAt))}` : "todavía sin comentarios con la palabra"}
        ${t.createdAt ? ` · ${esc(fmtDate(t.createdAt))}` : ""}
      </p>
      ${countsRow(t.counts)}
      <div class="actions">
        ${acciones}
        <button type="button" class="ghost" data-act="delete" data-id="${esc(t.id)}">${ICON.trash} Borrar</button>
        <button type="button" class="primary" data-act="open" data-id="${esc(t.id)}">Ver detalle</button>
      </div>
    </article>`;
}

function renderList() {
  const el = $("#trigger-list");
  if (!state.triggers.length) {
    el.innerHTML = `
      <div class="empty">
        <strong>Todavía no hay ninguna automatización</strong>
        <p>Creá la primera: un reel, la palabra que pide el video y la tarjeta que recibe la gente. De ahí en adelante trabaja sola.</p>
      </div>`;
    return;
  }
  el.innerHTML = `<div class="trigger-list">${state.triggers.map(triggerCard).join("")}</div>`;
}

function renderRail() {
  const ul = $("#rail-triggers");
  if (!state.triggers.length) {
    ul.innerHTML = `<li class="muted">Todavía no hay ninguna.</li>`;
    return;
  }
  ul.innerHTML = state.triggers.slice(0, 12).map((t) => `
    <li>
      <button type="button" class="history-item ${state.detailId === t.id ? "current" : ""}" data-act="open" data-id="${esc(t.id)}">
        <span class="badge ${esc(t.status)}">${esc(STATUS_LABEL[t.status] ?? t.status)}</span>
        <span class="history-main">@${esc(t.igUsername ?? "cuenta")} · «${esc((t.keywords ?? []).join(", "))}»</span>
        <span class="history-date">${esc(plural(t.counts?.sent ?? 0, "DM enviado", "DMs enviados"))}</span>
      </button>
    </li>`).join("");
}

// ── Detalle ───────────────────────────────────────────────────────────────────
function logBlock(trigger, open = true) {
  const log = trigger.log ?? [];
  if (!log.length) return "";
  return `<details class="log-wrap" ${open ? "open" : ""}><summary>Ver detalle técnico</summary><div class="log">${
    log.slice(-80).map((l) => `<div><span>${esc(fmtTime(l.at))}</span> ${esc(l.m)}</div>`).join("")
  }</div></details>`;
}

function rowsTable(rows = [], hasReplies) {
  if (!rows.length) {
    return `<div class="empty"><strong>Todavía nadie comentó la palabra</strong><p>Cuando alguien la escriba aparece acá, con la hora del comentario y si ya recibió el DM.</p></div>`;
  }
  return `
    <div class="table-wrap tall">
      <table>
        <thead><tr><th>Usuario</th><th>Comentó</th><th>Hora</th><th>DM</th><th>Enviado</th><th>Respuesta</th><th>Origen</th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td><a href="https://www.instagram.com/${esc(r.username)}/" target="_blank" rel="noopener">@${esc(r.username)}</a></td>
            <td class="text" title="${esc(r.text)}">${esc(String(r.text ?? "").slice(0, 60))}${String(r.text ?? "").length > 60 ? "…" : ""}</td>
            <td class="num">${esc(fmtTime(r.comment_ts))}</td>
            <td class="st ${esc(r.dm_status)}" title="${esc(r.dm_error)}">${esc(DM_LABEL[r.dm_status] ?? r.dm_status ?? "")}</td>
            <td class="num">${esc(fmtTime(r.sent_at))}</td>
            <td class="st ${esc(r.reply_status)}" title="${esc(r.reply_error)}">${hasReplies ? esc(REPLY_LABEL[r.reply_status] ?? r.reply_status ?? "") : "—"}</td>
            <td class="src">${esc(SOURCE_LABEL[r.source] ?? r.source ?? "")}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
}

function editForm(t) {
  const input = t.input ?? {};
  return `
    <details class="howto" id="edit-box">
      <summary>Editar mensajes y palabras</summary>
      <form id="form-edit" novalidate>
        <div class="field">
          <label for="edit-keywords">Palabras clave</label>
          <input id="edit-keywords" type="text" autocomplete="off" value="${esc((input.keywords ?? []).join(", "))}">
        </div>
        <div class="field">
          <label for="edit-cardTitle">Título de la tarjeta</label>
          <input id="edit-cardTitle" type="text" maxlength="80" autocomplete="off" value="${esc(input.card?.title ?? "")}">
        </div>
        <div class="field">
          <label for="edit-cardButtonTitle">Texto del botón</label>
          <input id="edit-cardButtonTitle" type="text" maxlength="20" autocomplete="off" value="${esc(input.card?.buttonTitle ?? "")}">
        </div>
        <div class="field">
          <label for="edit-cardButtonUrl">Enlace del botón</label>
          <input id="edit-cardButtonUrl" type="url" inputmode="url" autocomplete="off" value="${esc(input.card?.buttonUrl ?? "")}">
        </div>
        <div class="field">
          <label for="edit-replyTexts">Respuestas públicas (una por línea)</label>
          <textarea id="edit-replyTexts" rows="3">${esc((input.replyTexts ?? []).join("\n"))}</textarea>
        </div>
        <div class="field">
          <label for="edit-processedPhrases">Frases de «ya atendido» (una por línea)</label>
          <textarea id="edit-processedPhrases" rows="3">${esc((input.processedPhrases ?? []).join("\n"))}</textarea>
        </div>
        <div class="actions">
          <button type="submit" class="primary" id="btn-edit">Guardar cambios</button>
        </div>
      </form>
    </details>`;
}

function renderDetail() {
  const el = $("#detail");
  const d = state.detail;
  if (!d?.trigger) {
    el.innerHTML = `<p class="muted">${state.detailId ? "Cargando…" : "Elegí una automatización de la lista."}</p>`;
    return;
  }
  const t = d.trigger;
  const input = t.input ?? {};
  const r = t.resolved ?? {};
  const counts = d.counts ?? t.counts ?? {};
  const hasReplies = (input.replyTexts ?? []).length > 0;
  const editable = ["paused", "error"].includes(t.status);
  const sys = system();

  const acciones = t.status === "active"
    ? `<button type="button" class="ghost" data-act="pause" data-id="${esc(t.id)}">${ICON.pause} Pausar</button>`
    : t.status === "preparing"
      ? `<span class="muted">${ICON.spinner} Preparando…</span>`
      : `<button type="button" class="ghost" data-act="activate" data-id="${esc(t.id)}">${ICON.play} Activar</button>`;

  el.innerHTML = `
    <header class="view-head">
      <p class="eyebrow">Automatización</p>
      <h1>@${esc(r.igUsername ?? "cuenta")} · ${keywordChips(input.keywords ?? [])}</h1>
      <p class="lead">
        ${statusPill(t.status)} ${esc(STATUS_HINT[t.status] ?? "")}
      </p>
      <p class="help">
        ${r.permalink ? `<a href="${esc(r.permalink)}" target="_blank" rel="noopener">ver el reel ${ICON.external}</a> · ` : ""}
        detección ${t.status === "active" ? (sys.webhookConfigured ? "instantánea (webhook) + sondeo de respaldo" : `cada ${Math.round((sys.pollIntervalMs ?? 20000) / 1000)} s (sondeo)`) : "detenida"}
        ${t.cursor?.lastPollAt ? ` · última revisión ${esc(fmtAgo(t.cursor.lastPollAt))}` : ""}
        ${t.lastEventAt ? ` · último comentario ${esc(fmtAgo(t.lastEventAt))}` : ""}
      </p>
    </header>

    ${t.status === "error" && t.error ? `<div class="notice error"><p class="notice-title">${ICON.alert} ${esc(t.error)}</p></div>` : ""}
    ${t.status === "preparing" ? `<div class="notice"><p class="notice-title">${ICON.spinner} Preparando…</p><p>Buscamos el reel entre tus cuentas y dejamos la cola lista. Esta pantalla se actualiza sola.</p></div>` : ""}

    ${countsRow(counts, { big: true })}

    <div class="actions">
      <button type="button" class="ghost" data-view-goto="list">${ICON.back} Volver</button>
      ${acciones}
      <button type="button" class="ghost" data-csv>${ICON.download} Exportar CSV</button>
      <button type="button" class="ghost" data-act="delete" data-id="${esc(t.id)}">${ICON.trash} Borrar</button>
    </div>

    <h2 class="sub">Qué recibe cada persona</h2>
    <div class="recap">
      <div class="recap-item"><span class="recap-k">Mensaje directo</span><span class="recap-v">${esc(input.card?.title ?? "")} <span class="pill">${esc(input.card?.buttonTitle ?? "")}</span></span></div>
      <div class="recap-item"><span class="recap-k">En el comentario</span><span class="recap-v">${hasReplies ? esc(input.replyTexts[0]) + (input.replyTexts.length > 1 ? ` <span class="muted">(+${input.replyTexts.length - 1} variantes)</span>` : "") : '<span class="muted">Sin respuesta pública</span>'}</span></div>
      <div class="recap-item"><span class="recap-k">Respuestas a otros</span><span class="recap-v">${input.includeReplies ? "También se detectan" : "Solo el hilo principal"}</span></div>
    </div>

    <p class="help">${editable
      ? "Podés cambiar los textos porque está en pausa. Los cambios valen para lo que salga de ahora en adelante: lo ya enviado no se toca."
      : "Para cambiar los mensajes hay que pausarla primero. Mientras está activa se están mandando DMs con estos textos, y cambiarlos a mitad dejaría gente con una versión y gente con otra."}</p>
    ${editable ? editForm(t) : ""}

    <h2 class="sub">Quién comentó</h2>
    ${rowsTable(d.rows ?? [], hasReplies)}
    ${logBlock(t)}`;
}

// ── Acciones ──────────────────────────────────────────────────────────────────
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const { act, id } = btn.dataset;
  if (act === "open") return openTrigger(id);
  if (act === "pause" || act === "activate") return triggerAction(id, act, btn);
  if (act === "delete") return removeTrigger(id);
});

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-csv]");
  if (!b || !state.detail?.trigger) return;
  e.preventDefault();
  const t = state.detail.trigger;
  const rows = [...(state.detail.rows ?? [])].sort((a, b2) => new Date(a.comment_ts) - new Date(b2.comment_ts));
  downloadCsv(`automatizacion-${t.input?.shortcode ?? t.id}.csv`, TRIGGER_COLUMNS, rows);
});

async function openTrigger(id) {
  state.detailId = id;
  state.detail = null;
  setView("detail");
  await loadDetail(id);
  render();
  schedulePoll();
}

async function triggerAction(id, action, btn) {
  if (btn) btn.disabled = true;
  try {
    const { trigger } = await api(`/triggers/${encodeURIComponent(id)}/${action}`, { method: "POST", body: "{}" });
    upsertTrigger(trigger);
    if (state.detailId === id) state.detail = { ...(state.detail ?? {}), trigger: detailOf(trigger), counts: trigger.counts };
    toast(action === "pause"
      ? "Pausada. No sale ningún mensaje hasta que la actives."
      : "Activa. Los comentarios nuevos ya entran en la cola.", "ok");
    await refresh();
  } catch (err) {
    toast(err.code === "token_required" ? `${err.message}` : err.message);
    if (btn) btn.disabled = false;
  }
}

async function removeTrigger(id) {
  const t = state.triggers.find((x) => x.id === id) ?? (state.detail?.trigger ? summaryOf(state.detail.trigger) : null);
  const kw = (t?.keywords ?? []).join(", ");
  if (!confirm(`¿Borrar la automatización de «${kw}»?\n\nSe pierde el registro de a quién ya se le escribió (exportá el CSV antes si lo necesitás). Los DMs enviados no se deshacen.`)) return;
  try {
    await api(`/triggers/${encodeURIComponent(id)}`, { method: "DELETE" });
    state.triggers = state.triggers.filter((x) => x.id !== id);
    if (state.detailId === id) { state.detailId = null; state.detail = null; setView("list"); }
    toast("Borrada.", "ok");
    await refresh();
  } catch (err) {
    toast(err.status === 409 ? "Está activa: pausala antes de borrarla." : err.message);
  }
}

function upsertTrigger(trigger) {
  if (!trigger?.id) return;
  const summary = summaryOf(trigger);
  const i = state.triggers.findIndex((x) => x.id === trigger.id);
  if (i === -1) state.triggers.unshift(summary);
  else state.triggers[i] = { ...state.triggers[i], ...summary };
}

// ── Formulario: validación inline y vista previa ──────────────────────────────
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
const lines = (v) => String(v ?? "").split(/\r?\n/).map((t) => t.trim()).filter(Boolean);

$("#reel").addEventListener("blur", (e) => setFieldError("reel", e.target.value && !isReelUrl(e.target.value) ? "Ese enlace no parece de un reel. Copialo desde Instagram (··· → Copiar enlace)." : null));
$("#cardButtonUrl").addEventListener("blur", (e) => setFieldError("cardButtonUrl", e.target.value && !isHttpUrl(e.target.value) ? "El enlace tiene que empezar con https://" : null));

const bindCounter = (id, counterId, max) => {
  const input = $(`#${id}`);
  const update = () => ($(`#${counterId}`).textContent = `${input.value.length}/${max}`);
  input.addEventListener("input", update);
  update();
};
bindCounter("cardTitle", "title-count", 80);
bindCounter("cardButtonTitle", "button-count", 20);

// Las frases de "ya atendido" se copian de las respuestas públicas hasta que
// alguien las toca a mano.
$("#processedPhrases").addEventListener("input", () => (state.phrasesTouched = true));
function syncPhrases() {
  if (state.phrasesTouched) return;
  $("#processedPhrases").value = lines($("#replyTexts").value).join("\n");
}
$("#replyTexts").addEventListener("input", syncPhrases);
syncPhrases();

function updatePreview() {
  const owner = accountsStatus()[0]?.igUsername ?? state.triggers[0]?.igUsername ?? auth.me?.meta?.accounts?.[0]?.username ?? "tu_cuenta";
  const keyword = lines($("#keywords").value.replace(/,/g, "\n"))[0] ?? "humano";
  const replies = lines($("#replyTexts").value);

  $("#pv-user").textContent = "persona";
  $("#pv-avatar").textContent = "P";
  $("#pv-comment").textContent = keyword.length > 48 ? `${keyword.slice(0, 48)}…` : keyword;
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
["cardTitle", "cardButtonTitle", "replyTexts", "keywords"].forEach((id) => $(`#${id}`).addEventListener("input", updatePreview));

function renderNewBanner() {
  const el = $("#new-banner");
  el.innerHTML = hasToken() ? "" : `
    <div class="notice error">
      <p class="notice-title">${ICON.alert} Falta tu clave de Meta</p>
      <p>Sin ella no se puede crear ninguna automatización. Cargala en <a href="/settings.html">Cuenta</a> y volvé.</p>
    </div>`;
}

// ── Alta ──────────────────────────────────────────────────────────────────────
$("#form-trigger").addEventListener("submit", async (e) => {
  e.preventDefault();
  const reel = $("#reel").value.trim();
  const keywords = $("#keywords").value.trim();
  const title = $("#cardTitle").value.trim();
  const buttonTitle = $("#cardButtonTitle").value.trim();
  const buttonUrl = $("#cardButtonUrl").value.trim();

  const problems = [
    ["reel", reel && isReelUrl(reel) ? null : "Pegá el enlace del reel (··· → Copiar enlace en Instagram)."],
    ["keywords", keywords ? null : "Escribí al menos una palabra clave."],
    ["cardTitle", title ? null : "Escribí el título que verá la persona."],
    ["cardButtonTitle", buttonTitle ? null : "Escribí el texto del botón."],
    ["cardButtonUrl", isHttpUrl(buttonUrl) ? null : "Pegá el enlace completo, con https://"],
  ];
  problems.forEach(([id, msg]) => setFieldError(id, msg));
  const first = problems.find(([, msg]) => msg);
  if (first) return $(`#${first[0]}`).focus();

  const btn = $("#btn-create");
  btn.disabled = true;
  btn.innerHTML = `${ICON.spinner} Creando…`;
  try {
    const { trigger } = await api("/triggers", {
      method: "POST",
      body: JSON.stringify({
        reel,
        keywords,
        includeReplies: $("#includeReplies").checked,
        backfill: $("#backfill").checked ? "window" : "none",
        processedPhrases: $("#processedPhrases").value,
        card: { title, buttonTitle, buttonUrl },
        replyTexts: $("#replyTexts").value,
      }),
    });
    upsertTrigger(trigger);
    state.detail = { trigger: detailOf(trigger), rows: [], counts: trigger.counts ?? {} };
    state.detailId = trigger.id;
    setView("detail");
    toast("Creada. Preparando: en menos de un minuto empieza a escuchar.", "ok");
    schedulePoll();
  } catch (err) {
    if (err.code === "token_required") {
      $("#new-banner").innerHTML = `
        <div class="notice error">
          <p class="notice-title">${ICON.alert} Falta tu clave de Meta</p>
          <p>${esc(err.message)} <a href="/settings.html">Ir a Cuenta</a>.</p>
        </div>`;
      toast("Falta tu clave de Meta.");
    } else if (err.status === 409 && err.code === "duplicate") {
      setFieldError("reel", "Ya hay una automatización para ese reel. Abrila desde la lista o borrala antes de crear otra.");
      $("#reel").focus();
    } else if (err.status === 400) {
      setFieldError(err.field && $(`#${err.field}`) ? err.field : "reel", err.message);
      toast(err.message);
    } else {
      toast(err.message);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Crear automatización";
  }
});

// ── Edición (solo en pausa) ───────────────────────────────────────────────────
document.addEventListener("submit", async (e) => {
  if (e.target.id !== "form-edit") return;
  e.preventDefault();
  const id = state.detailId;
  const btn = $("#btn-edit");
  btn.disabled = true;
  try {
    const { trigger } = await api(`/triggers/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      body: JSON.stringify({
        keywords: $("#edit-keywords").value,
        card: {
          title: $("#edit-cardTitle").value.trim(),
          buttonTitle: $("#edit-cardButtonTitle").value.trim(),
          buttonUrl: $("#edit-cardButtonUrl").value.trim(),
        },
        replyTexts: $("#edit-replyTexts").value,
        processedPhrases: $("#edit-processedPhrases").value,
      }),
    });
    upsertTrigger(trigger);
    state.detail = { ...(state.detail ?? {}), trigger: detailOf(trigger) };
    toast("Guardado. Vale para los mensajes que salgan de ahora en adelante.", "ok");
    const box = $("#edit-box");
    if (box) box.open = false;
    render();
  } catch (err) {
    toast(err.status === 409 ? "Está activa: pausala antes de cambiar los mensajes." : err.message);
    btn.disabled = false;
  }
});

// ── Carga y sondeo ────────────────────────────────────────────────────────────
function busy() {
  const live = (t) => ["preparing", "active"].includes(t?.status);
  return state.triggers.some(live) || live(state.detail?.trigger);
}

function schedulePoll() {
  clearTimeout(state.poll);
  state.poll = setTimeout(refresh, busy() ? 5_000 : 30_000);
}

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  try {
    await loadAll();
    if (state.view === "detail" && state.detailId) await loadDetail(state.detailId);
    render();
  } catch (err) {
    toast(err.message);
  } finally {
    state.loading = false;
    schedulePoll();
  }
}

// ── Arranque ──────────────────────────────────────────────────────────────────
let appStarted = false;
function initApp() {
  if (appStarted) { refresh(); return; }
  appStarted = true;
  setView("list");
  refresh();
}

startSession({ title: "Automatizaciones", onApp: initApp });
