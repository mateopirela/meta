/**
 * Verificacion de ID tokens de Firebase Auth SIN firebase-admin.
 *
 * Un ID token de Firebase es un JWT RS256 firmado por Google. Verificarlo es:
 *   1. bajar los certificados publicos de Google (se cachean segun Cache-Control),
 *   2. comprobar la firma con el cert cuyo `kid` coincide,
 *   3. validar los claims: exp, iat, aud (= project id), iss, sub, auth_time.
 * Es exactamente lo que documenta Firebase para "verificar tokens con una
 * libreria JWT de terceros"; aca la libreria es node:crypto.
 *
 * El resultado NO es "esta persona puede usar la herramienta": eso lo decide
 * `isAllowedUser` con la lista de dominios/correos permitidos.
 */
import { createPublicKey, verify as cryptoVerify } from "node:crypto";

export const GOOGLE_CERTS_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

/** Tolerancia de reloj entre el cliente de Firebase y este servidor. */
const CLOCK_SKEW_MS = 5 * 60_000;

export class AuthError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

let certCache = { certs: null, expiresAt: 0 };

/** Certificados de Google, cacheados hasta que su Cache-Control lo permita. */
export async function fetchGoogleCerts(fetchImpl = fetch, now = Date.now()) {
  if (certCache.certs && now < certCache.expiresAt) return certCache.certs;
  const res = await fetchImpl(GOOGLE_CERTS_URL);
  if (!res.ok) throw new AuthError(`No se pudieron bajar los certificados de Google (HTTP ${res.status})`, "certs_unavailable");
  const certs = await res.json();
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1] ?? 3600);
  certCache = { certs, expiresAt: now + maxAge * 1000 };
  return certs;
}

/** Solo para tests: vacia la cache. */
export function resetCertCache() {
  certCache = { certs: null, expiresAt: 0 };
}

const b64url = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

function decodeSegment(segment, what) {
  try {
    return JSON.parse(b64url(segment).toString("utf8"));
  } catch {
    throw new AuthError(`El token no es un JWT valido (${what})`, "malformed");
  }
}

/**
 * Verifica un ID token y devuelve sus claims utiles.
 *
 * @param {string} token
 * @param {{ projectId: string, now?: number, certs?: Record<string,string>, fetchImpl?: typeof fetch }} opts
 *   `certs` permite inyectar llaves publicas (PEM) en tests; en produccion se
 *   bajan de Google.
 */
export async function verifyFirebaseIdToken(token, opts) {
  const { projectId, now = Date.now(), fetchImpl } = opts;
  if (!projectId) throw new Error("verifyFirebaseIdToken: falta projectId");
  if (typeof token !== "string" || token.split(".").length !== 3) {
    throw new AuthError("El token no es un JWT", "malformed");
  }

  const [h, p, s] = token.split(".");
  const header = decodeSegment(h, "header");
  const payload = decodeSegment(p, "payload");

  if (header.alg !== "RS256") throw new AuthError(`Algoritmo no permitido: ${header.alg}`, "bad_alg");
  if (typeof header.kid !== "string") throw new AuthError("El token no indica con que llave se firmo (kid)", "bad_kid");

  const certs = opts.certs ?? (await fetchGoogleCerts(fetchImpl, now));
  const pem = certs[header.kid];
  if (!pem) throw new AuthError("El token esta firmado con una llave que Google no reconoce", "unknown_kid");

  const ok = cryptoVerify("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey(pem), b64url(s));
  if (!ok) throw new AuthError("La firma del token no es valida", "bad_signature");

  const nowSec = Math.floor(now / 1000);
  const skew = CLOCK_SKEW_MS / 1000;
  if (typeof payload.exp !== "number" || payload.exp <= nowSec - skew) throw new AuthError("El token vencio", "expired");
  if (typeof payload.iat !== "number" || payload.iat > nowSec + skew) throw new AuthError("El token todavia no es valido (iat)", "iat_future");
  if (payload.aud !== projectId) throw new AuthError("El token es de otro proyecto de Firebase (aud)", "bad_aud");
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new AuthError("El token no lo emitio Firebase (iss)", "bad_iss");
  if (typeof payload.sub !== "string" || payload.sub === "" || payload.sub.length > 128) throw new AuthError("El token no identifica a nadie (sub)", "bad_sub");
  if (typeof payload.auth_time !== "number" || payload.auth_time > nowSec + skew) throw new AuthError("auth_time invalido", "bad_auth_time");

  return {
    uid: payload.sub,
    email: typeof payload.email === "string" ? payload.email.toLowerCase() : null,
    emailVerified: payload.email_verified === true,
    name: typeof payload.name === "string" ? payload.name : null,
  };
}

/**
 * ¿Esta persona puede usar la herramienta? Solo correos verificados, y solo
 * si su dominio o su correo exacto estan en la lista. Sin lista, NADIE entra:
 * el default seguro para una herramienta que manda DMs en nombre de la marca.
 */
export function isAllowedUser(claims, { domains = [], emails = [] } = {}) {
  if (!claims?.email || !claims.emailVerified) return false;
  const email = claims.email.toLowerCase();
  const domain = email.split("@")[1] ?? "";
  if (emails.map((e) => e.toLowerCase()).includes(email)) return true;
  return domains.map((d) => d.toLowerCase().replace(/^@/, "")).includes(domain);
}
