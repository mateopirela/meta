/**
 * Cifrado de los tokens de Meta de cada usuario, en reposo.
 *
 * AES-256-GCM por WebCrypto (`crypto.subtle`): la misma API en Node 24 y en
 * Deno (Edge Functions), sin `node:crypto`. La clave es del servidor
 * (TOKEN_ENCRYPTION_KEY, 32 bytes) y vive en los secretos de las funciones;
 * Postgres solo ve el blob cifrado.
 *
 * Formato del blob:  v1.<iv b64url>.<tag b64url>.<ct b64url>
 *   - iv de 12 bytes, nuevo por cada cifrado;
 *   - tag de autenticacion de 16 bytes: un blob manipulado no descifra.
 *
 * Si la clave cambia, NINGUN token guardado se puede leer: cada usuario tendria
 * que pegarlo de nuevo. Por eso no se rota a la ligera.
 */

export class CryptoError extends Error {
  constructor(message, code = "crypto") {
    super(message);
    this.name = "CryptoError";
    this.code = code;
  }
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const b64url = {
  encode: (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  decode: (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0)),
};

/**
 * Lee la clave del entorno: 64 hex (o base64 de 32 bytes). Vacio -> null, para
 * que el que llama decida si es fatal.
 */
export function parseKey(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let bytes;
  if (/^[0-9a-f]{64}$/i.test(s)) {
    bytes = Uint8Array.from(s.match(/../g), (h) => parseInt(h, 16));
  } else {
    try {
      bytes = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    } catch {
      bytes = new Uint8Array(0);
    }
  }
  if (bytes.length !== KEY_BYTES) {
    throw new CryptoError(
      `TOKEN_ENCRYPTION_KEY tiene que ser ${KEY_BYTES} bytes (64 hex). Generala con: openssl rand -hex 32`,
      "bad_key",
    );
  }
  return bytes;
}

const importKey = (key, usage) => crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, [usage]);

export async function encryptSecret(plain, key) {
  if (!key) throw new CryptoError("Falta la clave de cifrado.", "no_key");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const k = await importKey(key, "encrypt");
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode(String(plain))));
  // WebCrypto devuelve ct||tag; se guardan separados para que el formato sea explicito.
  const ct = out.slice(0, out.length - TAG_BYTES);
  const tag = out.slice(out.length - TAG_BYTES);
  return `v1.${b64url.encode(iv)}.${b64url.encode(tag)}.${b64url.encode(ct)}`;
}

export async function decryptSecret(blob, key) {
  if (!key) throw new CryptoError("Falta la clave de cifrado.", "no_key");
  const [v, iv, tag, ct] = String(blob ?? "").split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new CryptoError("El blob cifrado no tiene el formato esperado.", "malformed");
  try {
    const k = await importKey(key, "decrypt");
    const ctBytes = b64url.decode(ct);
    const tagBytes = b64url.decode(tag);
    const joined = new Uint8Array(ctBytes.length + tagBytes.length);
    joined.set(ctBytes);
    joined.set(tagBytes, ctBytes.length);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64url.decode(iv) }, k, joined);
    return new TextDecoder().decode(plain);
  } catch {
    throw new CryptoError("No se pudo descifrar: la clave cambió o el dato está corrupto.", "bad_decrypt");
  }
}
