/**
 * Los tokens de Meta de cada tenant: cifrados en `profiles.meta_token_enc`,
 * descifrados aca con TOKEN_ENCRYPTION_KEY (secreto de las funciones) solo
 * para hacer la llamada. Nunca salen en una respuesta ni en un log.
 *
 * El Page token (el que EXIGE el envio; con el de sistema Meta da #190) se
 * deriva del de sistema y se cachea cifrado en send_state, por cuenta de IG y
 * por dueño.
 */
import { parseKey, encryptSecret, decryptSecret, CryptoError } from "./crypto.mjs";
import { makeConfig, DEFAULT_GRAPH_VERSION } from "./recovery.mjs";
import { getPageToken } from "./meta.mjs";
import { env, must, nowIso } from "./db.mjs";

let cachedKey = null;
function key() {
  if (cachedKey) return cachedKey;
  cachedKey = parseKey(env("TOKEN_ENCRYPTION_KEY"));
  if (!cachedKey) throw new Error("Falta TOKEN_ENCRYPTION_KEY en los secretos de la función.");
  return cachedKey;
}

export const graphVersion = () => env("GRAPH_VERSION") || DEFAULT_GRAPH_VERSION;
export const encryptToken = (token) => encryptSecret(token, key());

/** makeConfig() con el token del dueño, o null si no cargo ninguno (o ya no se puede leer). */
export async function ownerConfig(db, uid) {
  const row = must(await db.from("profiles").select("meta_token_enc").eq("uid", uid).maybeSingle());
  if (!row?.meta_token_enc) return null;
  try {
    return makeConfig(await decryptSecret(row.meta_token_enc, key()), graphVersion());
  } catch (err) {
    if (err instanceof CryptoError) {
      console.warn(`[tokens] token de ${uid} ilegible: ${err.message}`);
      return null;
    }
    throw err;
  }
}

/** ¿Este tenant tiene clave cargada? Sin descifrar nada. */
export async function hasToken(db, uid) {
  const row = must(await db.from("profiles").select("meta_token_enc").eq("uid", uid).maybeSingle());
  return Boolean(row?.meta_token_enc);
}

export async function pageTokenFor(db, { igUserId, pageId, uid, config, force = false }) {
  if (!force) {
    const row = must(await db.from("send_state").select("page_token_enc,page_token_uid").eq("ig_user_id", igUserId).maybeSingle());
    if (row?.page_token_enc && row.page_token_uid === uid) {
      try {
        return await decryptSecret(row.page_token_enc, key());
      } catch { /* clave rotada: se deriva de nuevo */ }
    }
  }
  const pageToken = await getPageToken(pageId, config);
  must(await db.from("send_state").upsert(
    { ig_user_id: igUserId, page_token_enc: await encryptSecret(pageToken, key()), page_token_uid: uid, page_token_at: nowIso() },
    { onConflict: "ig_user_id" },
  ));
  return pageToken;
}

/** El dueño cambio o borro su clave: el Page token derivado ya no vale. */
export async function forgetPageTokens(db, uid) {
  must(await db.from("send_state").update({ page_token_enc: null, page_token_uid: null, page_token_at: null }).eq("page_token_uid", uid));
}
