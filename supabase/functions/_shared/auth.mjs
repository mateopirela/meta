/**
 * Quien llama a la API: la sesion de Supabase del browser.
 *
 * El runtime de Edge Functions solo sabe verificar JWT HS256 (legacy) y este
 * proyecto firma con ES256, asi que `verify_jwt = false` y la verificacion es
 * `auth.getUser(token)` contra el servidor de Auth: siempre correcto, una
 * llamada corta por request.
 *
 * Solo correos VERIFICADOS. Con AUTH_ALLOWED_DOMAINS / AUTH_ALLOWED_EMAILS
 * (secretos de la funcion), solo los de la lista; sin lista entra cualquiera:
 * es multi-tenant y cada quien manda DMs con SU token.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { env } from "./db.mjs";
import { fail } from "./http.mjs";

const csv = (v) => String(v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

export function isAllowedEmail(email, { domains = [], emails = [] } = {}) {
  if (!email) return false;
  if (domains.length === 0 && emails.length === 0) return true;
  const e = email.toLowerCase();
  if (emails.includes(e)) return true;
  return domains.map((d) => d.replace(/^@/, "")).includes(e.split("@")[1] ?? "");
}

export async function requireUser(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) fail(401, "Iniciá sesión para usar la herramienta.", "unauthenticated");

  const anon = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await anon.auth.getUser(m[1]);
  if (error || !data?.user) fail(401, "Tu sesión no es válida o venció. Volvé a iniciar sesión.", "unauthenticated");

  const u = data.user;
  if (u.is_anonymous) fail(403, "Los usuarios anónimos no pueden usar la herramienta.", "forbidden");
  const email = (u.email ?? "").toLowerCase();
  const verified = Boolean(u.email_confirmed_at) || u.user_metadata?.email_verified === true;
  if (!email || !verified) fail(403, "Verificá tu correo antes de entrar: te mandamos un enlace al registrarte.", "email_unverified");
  if (!isAllowedEmail(email, { domains: csv(env("AUTH_ALLOWED_DOMAINS")), emails: csv(env("AUTH_ALLOWED_EMAILS")) })) {
    fail(403, `La cuenta ${email} no tiene acceso a esta herramienta.`, "forbidden");
  }
  return { uid: u.id, email };
}
