// Cuenta: cargar, reemplazar o borrar la clave de Meta del tenant. Sin frameworks.
//
// El token viaja UNA vez, en el PUT, y no vuelve nunca: lo que se muestra es
// `configured`, la fecha y las cuentas de Instagram que administra.
import { auth, api, startSession, refreshMe } from "/session.js";

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const ICON = {
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  alert: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 8v5M12 16h.01" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>',
  spinner: '<svg class="spin" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="40 20" stroke-linecap="round"/></svg>',
};

let toastTimer;
function toast(message, kind = "error") {
  const el = $("#toast");
  el.className = `toast ${kind}`;
  el.innerHTML = `${kind === "error" ? ICON.alert : ICON.check}<span>${esc(message)}</span>`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 5000);
}

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" }) : "");

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  const el = $("#me");
  const m = auth.me?.meta ?? { configured: false, accounts: [] };

  if (m.configured) {
    el.innerHTML = `
      <div class="notice ok">
        <p class="notice-title">${ICON.check} Clave cargada${m.setAt ? ` · ${esc(fmtDate(m.setAt))}` : ""}</p>
        <p>Puede leer y responder en estas cuentas:</p>
        <ul class="chips">${m.accounts.map((a) => `<li class="chip"><strong>@${esc(a.username)}</strong><span>${esc(a.pageName)}</span></li>`).join("")}</ul>
        <p class="help">Si falta alguna cuenta, su página de Facebook no está en el Business Manager del token (o el usuario del sistema no tiene acceso a ella).</p>
      </div>`;
    $("#token-label").textContent = "Reemplazar la clave";
    $("#btn-save").textContent = "Verificar y reemplazar";
    $("#btn-delete").hidden = false;
  } else {
    el.innerHTML = `
      <div class="notice">
        <p class="notice-title">Todavía no cargaste tu clave</p>
        <p>Sin ella no se puede buscar ningún reel ni mandar ningún mensaje. Es el único dato que hace falta.</p>
      </div>`;
    $("#token-label").textContent = "Clave de acceso (token)";
    $("#btn-save").textContent = "Verificar y guardar";
    $("#btn-delete").hidden = true;
  }
}

function setFieldError(message) {
  const input = $("#token");
  const err = $("#token-error");
  input.setAttribute("aria-invalid", message ? "true" : "false");
  err.textContent = message ?? "";
  err.hidden = !message;
}

// ── Acciones ──────────────────────────────────────────────────────────────────
$("#toggle-token").addEventListener("click", (e) => {
  const input = $("#token");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  e.currentTarget.textContent = show ? "Ocultar" : "Mostrar";
  e.currentTarget.setAttribute("aria-pressed", String(show));
});

$("#form-token").addEventListener("submit", async (e) => {
  e.preventDefault();
  const token = $("#token").value.trim();
  setFieldError(null);
  if (!token) return setFieldError("Pegá la clave de acceso para continuar.");

  const btn = $("#btn-save");
  const label = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = `${ICON.spinner} Verificando con Meta…`;
  try {
    const { me } = await api("/me/token", { method: "PUT", body: JSON.stringify({ token }) });
    auth.me = me;
    $("#token").value = "";
    render();
    toast("Clave guardada. Ya podés buscar reels y crear automatizaciones.", "ok");
  } catch (err) {
    setFieldError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

$("#btn-delete").addEventListener("click", async () => {
  if (!confirm("¿Borrar tu clave de Meta?\n\nTus automatizaciones activas se detienen hasta que cargues una nueva. Nada de lo ya enviado se toca.")) return;
  try {
    const { me } = await api("/me/token", { method: "DELETE" });
    auth.me = me;
    render();
    toast("Clave borrada.", "ok");
  } catch (err) {
    toast(err.message);
  }
});

// ── Arranque ──────────────────────────────────────────────────────────────────
startSession({ title: "Cuenta", onApp: async () => { await refreshMe().catch((e) => toast(e.message)); render(); } });
