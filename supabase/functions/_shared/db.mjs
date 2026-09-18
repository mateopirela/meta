/**
 * Acceso a Postgres desde las funciones, con la service role (salta RLS: la
 * autorizacion por tenant la hacen las rutas, filtrando por owner_uid).
 *
 * SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los inyecta el runtime de Edge
 * Functions solo; no hay que cargarlos como secretos.
 */
import { createClient } from "npm:@supabase/supabase-js@2";

export const env = (key, fallback = "") => (Deno.env.get(key) ?? fallback).trim();

export function admin() {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** Desenvuelve `{data, error}` de supabase-js: un error de base es un 500 honesto, no un `null` silencioso. */
export function must({ data, error }) {
  if (error) throw new Error(`[db] ${error.message}${error.details ? ` · ${error.details}` : ""}`);
  return data;
}

export async function appendLog(db, kind, id, message) {
  console.log(`[${kind} ${id}] ${message}`);
  must(await db.rpc("append_log", { p_kind: kind, p_id: id, p_msg: message }));
}

export const nowIso = () => new Date().toISOString();

/** Ids con el mismo formato de siempre (YYYYMMDD-xxxxxx): la UI los muestra igual. */
export function newId() {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  return `${day}-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
export const isValidId = (id) => /^[a-z0-9-]{6,40}$/.test(String(id ?? ""));
