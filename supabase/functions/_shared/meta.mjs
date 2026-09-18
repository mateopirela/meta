/**
 * Helpers de Meta Graph API. Todo lo que toca la red vive aca.
 *
 * SEGURIDAD: el token va en el header `Authorization`, NO como query param.
 * Como query param cualquier log de la URL (un console.log(url) de debug, un
 * proxy, un logger de requests) lo publicaria en texto plano. No metas el
 * token en `graphUrl` ni loguees `url.toString()` con credenciales adentro.
 */

const BASE = "https://graph.facebook.com";

/** Errores de Meta que valen un reintento con backoff. */
const RETRYABLE_META_CODES = new Set([613, 4, 17, 32, 341]);

/** HTTP que vale reintentar aunque Meta no mande su JSON de error. */
const RETRYABLE_HTTP = new Set([429, 500, 502, 503, 504]);

export class GraphError extends Error {
  constructor(error, status) {
    super(error?.message ?? `HTTP ${status}`);
    this.name = "GraphError";
    this.code = error?.code ?? null;
    this.subcode = error?.error_subcode ?? null;
    this.status = status;
    this.raw = error ?? null;
  }

  get isRetryable() {
    // El status importa aparte del code: un 429/502 de un proxy intermedio
    // llega sin el JSON {error:{code}} de Meta, asi que code queda null y
    // sin esto lo trataríamos como fallo definitivo.
    return RETRYABLE_META_CODES.has(this.code) || RETRYABLE_HTTP.has(this.status);
  }
}

/** Fallo de red (DNS, timeout, conexion cortada). En un run de horas, pasa. */
export class NetworkError extends Error {
  constructor(cause) {
    super(`fallo de red: ${cause?.message ?? "desconocido"}`);
    this.name = "NetworkError";
    this.cause = cause;
  }

  get isRetryable() {
    return true;
  }
}

async function request(url, token, options = {}) {
  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers: { ...options.headers, authorization: `Bearer ${token}` },
    });
  } catch (err) {
    // fetch() tira TypeError ante fallos de red. Lo envolvemos para que el
    // que llama pueda reintentar en vez de morirse.
    throw new NetworkError(err);
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new GraphError(body.error, res.status);
  return body;
}

/** Arma la URL SIN credenciales. El token va por header en `request`. */
export function graphUrl(path, params, config) {
  const url = new URL(`${BASE}/${config.graphVersion}/${path.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url;
}

export async function graphGet(path, params, config, token = config.token) {
  return request(graphUrl(path, params, config), token);
}

/**
 * Recorre la paginacion cursor-based de Graph y devuelve todos los `data`.
 * @param {number} maxPages guarda contra un bucle infinito por cursor roto.
 */
export async function graphGetAll(path, params, config, token = config.token, maxPages = 200) {
  const items = [];
  let url = graphUrl(path, params, config);

  for (let page = 0; page < maxPages; page += 1) {
    const body = await request(url, token);
    items.push(...(body.data ?? []));
    const next = body.paging?.next;
    if (!next) return items;
    // Meta mete el access_token en la URL de `next`. Lo sacamos: va por header.
    url = new URL(next);
    url.searchParams.delete("access_token");
  }

  // Tope alcanzado: se devuelve lo leido. Quien llama decide si avisa que quedo corto.
  items.truncated = true;
  return items;
}

/**
 * Lista las paginas que el token administra, con su cuenta de IG vinculada.
 * Es la fuente de verdad de "podemos enviar o no".
 */
export async function listManagedPages(config) {
  return graphGetAll(
    "me/accounts",
    { fields: "id,name,username,instagram_business_account{id,username,name}", limit: 100 },
    config,
  );
}

/**
 * Page Access Token derivado del System User token.
 * El envio DEBE usar este, no el token de sistema (si no: error #190).
 */
export async function getPageToken(pageId, config) {
  const body = await graphGet(pageId, { fields: "access_token" }, config);
  if (!body.access_token) {
    throw new Error(`La pagina ${pageId} no devolvio access_token: revisa permisos en el BM.`);
  }
  return body.access_token;
}

/**
 * Manda la tarjeta de recuperacion como private_reply a un comentario.
 *
 * Las cuatro reglas de abajo salieron a golpes; no cambiarlas sin releer el
 * runbook (README, seccion "Por que estas cuatro cosas no se tocan"):
 *   1. endpoint `/me/messages`, NO `/{ig_user_id}/messages`  -> #3
 *   2. PAGE token, NO system user token                      -> #190
 *   3. `recipient.comment_id`, NO `recipient.id`             -> #200/2534048
 *   4. `messaging_type: "RESPONSE"`
 */
export async function sendPrivateReply({ commentId, card, pageToken, config }) {
  const url = graphUrl("me/messages", {}, config);
  const payload = {
    recipient: { comment_id: commentId },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [
            {
              title: card.title,
              buttons: [{ type: "web_url", url: card.buttonUrl, title: card.buttonTitle }],
            },
          ],
        },
      },
    },
    messaging_type: "RESPONSE",
  };

  return request(url, pageToken, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/**
 * Replies de un comentario (primera pagina, hasta 50). Lo usa el pre-check de
 * idempotencia del paso 9: "¿el owner ya respondio aca?".
 */
export async function getCommentReplies(commentId, config, token = config.token) {
  const body = await graphGet(
    commentId,
    { fields: "replies.limit(50){id,text,username,timestamp}" },
    config,
    token,
  );
  return body.replies?.data ?? [];
}

/**
 * Respuesta PUBLICA en el hilo: un comentario hijo del owner debajo del
 * comentario de la persona. POST /{ig_comment_id}/replies con `message`.
 * Scope: instagram_manage_comments.
 *
 * OJO: a diferencia del private_reply, Meta NO dedupea esto. Dos llamadas son
 * dos respuestas visibles en el reel. La idempotencia es nuestra (CSV +
 * pre-check con getCommentReplies), no de ellos.
 */
export async function replyToComment({ commentId, message, token, config }) {
  const url = graphUrl(`${commentId}/replies`, {}, config);
  return request(url, token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

/**
 * Suscribe la app a los eventos de la pagina: la mitad por API de habilitar los
 * webhooks (la otra mitad — callback URL y campo `comments` — es manual en el
 * dashboard de Meta). Idempotente: llamarla dos veces no cambia nada.
 *
 * Con PAGE token: es una accion sobre la pagina, misma leccion que el resto.
 */
export async function subscribeAppToPage({ pageId, pageToken, config, fields = "feed" }) {
  const url = graphUrl(`${pageId}/subscribed_apps`, {}, config);
  return request(url, pageToken, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subscribed_fields: fields }),
  });
}
