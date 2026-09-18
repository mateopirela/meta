// Sesión compartida por las tres páginas: login con Supabase Auth (Google o
// correo+contraseña), la puerta de entrada, el chip de usuario del riel, y los
// dos canales con el backend:
//   - `sb`  : supabase-js, para LEER tus propias filas (RLS) directo de Postgres
//   - `api` : la Edge Function `api`, para ESCRIBIR (valida y habla con Meta)
//
// El SERVIDOR decide quién entra: acá solo se muestra lo que responde /me
// (401, 403 y sus códigos).
import { SUPABASE_URL, SUPABASE_ANON_KEY, FUNCTIONS_URL } from "/config.js";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const MARK = `<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#0a0e27"/><path d="M8 11h16v10H13l-5 4z" fill="#c4f635"/></svg>`;
const GOOGLE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.4Z"/><path fill="#c4f635" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22Z"/><path fill="#fff" opacity=".7" d="M6.4 14a6 6 0 0 1 0-3.9V7.5H3.1a10 10 0 0 0 0 9l3.3-2.6Z"/><path fill="#fff" d="M12 6c1.5 0 2.8.5 3.8 1.5l2.8-2.8A10 10 0 0 0 3.1 7.5L6.4 10c.8-2.3 3-4 5.6-4Z"/></svg>`;

/** El cliente de Supabase: lecturas con RLS y la sesión. */
export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/** Lo que usan las páginas. `me` se llena al entrar (perfil + estado del sistema). */
export const auth = {
  user: null,
  me: null,
  getToken: async () => (await sb.auth.getSession()).data.session?.access_token ?? null,
  signOut: () => sb.auth.signOut(),
};

/** Escrituras: la Edge Function `api`. Lanza Error con `.status` y `.code`. */
export async function api(path, options = {}) {
  const headers = { "content-type": "application/json", apikey: SUPABASE_ANON_KEY, ...(options.headers ?? {}) };
  const token = await auth.getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${FUNCTIONS_URL}/api${path}`, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error ?? `Error ${res.status}`);
    err.code = body.code;
    err.status = res.status;
    if (res.status === 401) {
      auth.signOut().catch(() => {});
      showGate("Tu sesión venció. Volvé a entrar.");
    }
    throw err;
  }
  return body;
}

/** Lecturas: desenvuelve `{data, error}` de supabase-js. */
export function must({ data, error }) {
  if (error) {
    const err = new Error(error.message);
    err.code = error.code;
    throw err;
  }
  return data;
}

let pageTitle = "";

// ── La puerta ─────────────────────────────────────────────────────────────────
function gateShell(inner) {
  $("#app").hidden = true;
  const gate = $("#auth-gate");
  gate.hidden = false;
  gate.innerHTML = `<div class="gate-card">${MARK}<h1>${esc(pageTitle)}</h1>${inner}</div>`;
}

function setGateError(message) {
  const el = $("#gate-error");
  if (!el) return;
  el.textContent = message ?? "";
  el.hidden = !message;
}

function describeAuthError(err) {
  const msg = String(err?.message ?? "");
  if (/invalid login credentials/i.test(msg)) return "Correo o contraseña incorrectos.";
  if (/email not confirmed/i.test(msg)) return "Todavía no confirmaste tu correo. Buscá el enlace en tu bandeja (o en spam).";
  if (/user already registered/i.test(msg)) return "Ese correo ya tiene cuenta. Entrá con tu contraseña o recuperala.";
  if (/password should be at least/i.test(msg)) return "La contraseña tiene que tener al menos 6 caracteres.";
  if (/unable to validate email|invalid email/i.test(msg)) return "Ese correo no parece válido.";
  if (/rate limit|too many/i.test(msg)) return "Demasiados intentos seguidos. Esperá un minuto y probá de nuevo.";
  if (/provider is not enabled|unsupported provider/i.test(msg)) return "Google no está habilitado en este proyecto (Authentication → Providers).";
  return msg || "No se pudo iniciar sesión.";
}

/** Login / registro. */
export function showGate(message) {
  gateShell(`
    <p class="lead">Entrá con Google o con tu correo. Si es tu primera vez, creá la cuenta: en un minuto cargás tu clave de Meta y listo.</p>
    <button type="button" class="primary" id="btn-google">${GOOGLE} Continuar con Google</button>
    <div class="divider"><span>o con tu correo</span></div>
    <form id="form-email" class="gate-form" novalidate>
      <div class="field">
        <label for="gate-email">Correo</label>
        <input id="gate-email" type="email" autocomplete="email" inputmode="email" required placeholder="vos@ejemplo.com">
      </div>
      <div class="field">
        <label for="gate-password">Contraseña</label>
        <input id="gate-password" type="password" autocomplete="current-password" required minlength="6" placeholder="mínimo 6 caracteres">
      </div>
      <div class="gate-actions">
        <button type="submit" class="primary" id="btn-signin">Entrar</button>
        <button type="button" class="ghost" id="btn-signup">Crear cuenta</button>
      </div>
      <button type="button" class="linklike" id="btn-forgot">¿Olvidaste la contraseña?</button>
    </form>
    <p class="field-error" id="gate-error" role="alert" hidden></p>`);
  setGateError(message);

  const email = () => $("#gate-email").value.trim();
  const password = () => $("#gate-password").value;
  const busy = (btn, on, label) => {
    btn.disabled = on;
    if (label) btn.textContent = label;
  };

  $("#btn-google").addEventListener("click", async () => {
    setGateError(null);
    const { error } = await sb.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: location.href, queryParams: { prompt: "select_account" } },
    });
    if (error) setGateError(describeAuthError(error));
  });

  $("#form-email").addEventListener("submit", async (e) => {
    e.preventDefault();
    setGateError(null);
    if (!email() || !password()) return setGateError("Completá correo y contraseña.");
    const btn = $("#btn-signin");
    busy(btn, true, "Entrando…");
    const { error } = await sb.auth.signInWithPassword({ email: email(), password: password() });
    busy(btn, false, "Entrar");
    if (error) setGateError(describeAuthError(error));
    // Si salió bien, onAuthStateChange sigue solo.
  });

  $("#btn-signup").addEventListener("click", async () => {
    setGateError(null);
    if (!email() || !password()) return setGateError("Para crear la cuenta, completá correo y contraseña.");
    const btn = $("#btn-signup");
    busy(btn, true, "Creando…");
    const { data, error } = await sb.auth.signUp({ email: email(), password: password(), options: { emailRedirectTo: location.origin + "/" } });
    busy(btn, false, "Crear cuenta");
    if (error) return setGateError(describeAuthError(error));
    // Con confirmación de correo activa, no hay sesión hasta hacer clic en el enlace.
    if (!data.session) showUnverified(email());
  });

  $("#btn-forgot").addEventListener("click", async () => {
    setGateError(null);
    if (!email()) return setGateError("Escribí tu correo arriba y volvé a tocar acá.");
    const { error } = await sb.auth.resetPasswordForEmail(email(), { redirectTo: location.origin + "/" });
    if (error) return setGateError(describeAuthError(error));
    gateShell(`
      <p class="lead">Te mandamos un enlace a <strong>${esc(email())}</strong> para cambiar la contraseña. Abrilo desde este mismo navegador.</p>
      <button type="button" class="ghost" id="btn-back">Volver</button>`);
    $("#btn-back").addEventListener("click", () => showGate());
  });
}

/** Registrado pero sin confirmar el correo. */
function showUnverified(email) {
  gateShell(`
    <p class="lead">Te mandamos un correo a <strong>${esc(email ?? "tu casilla")}</strong>. Abrí el enlace para confirmar la cuenta y después volvé acá.</p>
    <div class="gate-actions">
      <button type="button" class="primary" id="btn-resend">Reenviar el correo</button>
      <button type="button" class="ghost" id="btn-switch">Usar otra cuenta</button>
    </div>
    <p class="field-error" id="gate-error" role="alert" hidden></p>`);
  $("#btn-resend").addEventListener("click", async () => {
    if (!email) return showGate();
    const { error } = await sb.auth.resend({ type: "signup", email, options: { emailRedirectTo: location.origin + "/" } });
    setGateError(error ? describeAuthError(error) : "Listo, revisá tu bandeja (y spam).");
  });
  $("#btn-switch").addEventListener("click", () => auth.signOut().then(() => showGate()));
}

/** El servidor dijo que esta cuenta no puede entrar (lista de permitidos). */
function showForbidden(message) {
  gateShell(`
    <p class="lead">${esc(message)}</p>
    <button type="button" class="ghost" id="btn-switch">Salir y probar con otra cuenta</button>`);
  $("#btn-switch").addEventListener("click", () => auth.signOut().then(() => showGate()));
}

/** Llegó desde el enlace de "olvidé la contraseña": pedir la nueva. */
function showRecovery() {
  gateShell(`
    <p class="lead">Elegí una contraseña nueva.</p>
    <form id="form-recovery" class="gate-form" novalidate>
      <div class="field">
        <label for="new-password">Contraseña nueva</label>
        <input id="new-password" type="password" autocomplete="new-password" required minlength="6" placeholder="mínimo 6 caracteres">
      </div>
      <div class="gate-actions"><button type="submit" class="primary">Guardar y entrar</button></div>
    </form>
    <p class="field-error" id="gate-error" role="alert" hidden></p>`);
  $("#form-recovery").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { error } = await sb.auth.updateUser({ password: $("#new-password").value });
    if (error) return setGateError(describeAuthError(error));
    recovering = false;
    await enter();
  });
}

// ── La app ────────────────────────────────────────────────────────────────────
let onAppReady = null;
let recovering = false;

function showApp() {
  $("#auth-gate").hidden = true;
  $("#app").hidden = false;
  const chip = $("#user-chip");
  if (chip && auth.user) {
    chip.hidden = false;
    $("#user-email").textContent = auth.user.email ?? "";
    $("#user-email").title = auth.user.email ?? "";
  }
  onAppReady?.(auth.user);
}

/** Hay sesión de Supabase: que el servidor confirme que puede entrar (y devuelva el perfil). */
async function enter() {
  try {
    const { me } = await api("/me");
    auth.me = me;
    showApp();
  } catch (err) {
    if (err.status === 403 && err.code === "email_unverified") return showUnverified(auth.user?.email);
    if (err.status === 403) return showForbidden(err.message);
    if (err.status === 401) return; // api() ya mostró la puerta
    showGate(err.message);
  }
}

/** Vuelve a pedir el perfil (después de cargar o borrar la clave). */
export async function refreshMe() {
  const { me } = await api("/me");
  auth.me = me;
  return me;
}

/**
 * Arranque. `title` es el nombre de la página en la puerta; `onApp(user)` se
 * llama una vez que se puede usar la app.
 */
export function startSession({ title, onApp }) {
  pageTitle = title;
  onAppReady = onApp;
  $("#btn-logout")?.addEventListener("click", () => auth.signOut().then(() => location.reload()));

  sb.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") {
      recovering = true;
      auth.user = session?.user ?? null;
      showRecovery();
      return;
    }
    if (recovering && event !== "SIGNED_OUT") return;
    if (!session) {
      auth.user = null;
      showGate();
      return;
    }
    if (event === "TOKEN_REFRESHED" && !$("#app").hidden) return;
    auth.user = session.user;
    enter();
  });
}
