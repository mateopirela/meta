/**
 * Respuestas JSON, CORS y errores con codigo HTTP para las Edge Functions.
 *
 * CORS abierto: el frontend vive en otro origen (Vercel) y la autenticacion es
 * el bearer de Supabase, no una cookie, asi que no hay nada que un origen ajeno
 * pueda hacer sin la sesion de la persona.
 */
import { TriggerInputError } from "./rules.mjs";

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, x-worker-secret",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-max-age": "86400",
};

export class HttpError extends Error {
  constructor(status, message, code = "bad_request") {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export const fail = (status, message, code) => {
  throw new HttpError(status, message, code);
};

export function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function readJson(req) {
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    fail(400, "JSON inválido.");
  }
}

/** Envuelve un handler: OPTIONS, errores conocidos -> JSON con codigo, el resto -> 500. */
export function serve(handler) {
  return async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    try {
      return await handler(req);
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message, code: err.code });
      if (err instanceof TriggerInputError) return json(400, { error: err.message, field: err.field, code: "bad_request" });
      console.error("[edge] error:", err?.stack ?? err);
      return json(500, { error: "Error interno.", code: "internal" });
    }
  };
}

/** Los workers no tienen sesion: se autentican con el secreto que pg_cron lee de Vault. */
export function requireWorker(req) {
  const expected = Deno.env.get("WORKER_SECRET") ?? "";
  const given = req.headers.get("x-worker-secret") ?? "";
  if (!expected || given.length !== expected.length || given !== expected) fail(401, "No autorizado.", "unauthorized");
}
