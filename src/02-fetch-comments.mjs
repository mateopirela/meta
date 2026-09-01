/**
 * PASO 2 — Bajar todos los comentarios del reel (con sus respuestas).
 *
 * Read-only. Escribe data/comments.json.
 *
 * Usa Graph API, no CDP. El CDP de la Skill original existe para clasificar
 * cuentas que NO estan en el BM; si vamos a enviar, la cuenta SI esta en el BM,
 * y entonces Graph lee los comentarios y los hilos directo.
 */
import { writeFile } from "node:fs/promises";
import { loadConfig } from "./config.mjs";
import { graphGet, graphGetAll, GraphError } from "./meta.mjs";

const config = loadConfig(["META_TOKEN_MARKETING_INTEGRATION", "REEL_SHORTCODE"]);

const IG_USER_ID = (process.env.IG_USER_ID ?? "").trim();
if (!IG_USER_ID) {
  console.error("Falta IG_USER_ID en .env. Lo imprime el paso 1 (npm run verify).");
  process.exit(1);
}

/**
 * `replies` es un campo anidado: Graph devuelve solo su primera pagina y aca
 * no seguimos su cursor. Por eso pedimos limit(50): si la respuesta de ManyChat
 * cayera fuera de esa pagina, el paso 3 clasificaria el comentario como perdido
 * y le mandariamos un DM a alguien que ya lo tenia. Con 50 se cubre practicamente
 * todo hilo real, y abajo avisamos si alguno toca el techo.
 */
const REPLIES_LIMIT = 50;
const COMMENT_FIELDS = `id,text,timestamp,username,like_count,replies.limit(${REPLIES_LIMIT}){id,text,timestamp,username}`;
/** Igual pero sin like_count, por si la cuenta no lo expone. `username` es
 *  imprescindible: sin el no sabemos a quien le estamos mandando. */
const COMMENT_FIELDS_FALLBACK = `id,text,timestamp,username,replies.limit(${REPLIES_LIMIT}){id,text,timestamp,username}`;

/** Encuentra el media por shortcode recorriendo el feed de la cuenta. */
async function resolveMedia() {
  console.log(`Buscando el reel ${config.shortcode} en el feed de la cuenta...`);
  const media = await graphGetAll(
    `${IG_USER_ID}/media`,
    { fields: "id,shortcode,permalink,timestamp,comments_count,media_type", limit: 50 },
    config,
  );

  const found = media.find((m) => m.shortcode === config.shortcode);
  if (!found) {
    console.error(
      `\nNo se encontro el shortcode "${config.shortcode}" en los ${media.length} posts de la cuenta.\n` +
        "Revisa que el shortcode sea correcto y que el reel sea de ESTA cuenta.\n",
    );
    process.exit(1);
  }
  return found;
}

async function fetchComments(mediaId) {
  try {
    return await graphGetAll(`${mediaId}/comments`, { fields: COMMENT_FIELDS, limit: 50 }, config);
  } catch (err) {
    if (!(err instanceof GraphError) || err.code !== 100) throw err;
    console.warn("El set completo de campos fallo; reintentando sin like_count...");
    return graphGetAll(`${mediaId}/comments`, { fields: COMMENT_FIELDS_FALLBACK, limit: 50 }, config);
  }
}

const main = async () => {
  const media = await resolveMedia();
  console.log(`\nReel encontrado:`);
  console.log(`  media id     ${media.id}`);
  console.log(`  permalink    ${media.permalink}`);
  console.log(`  publicado    ${media.timestamp}`);
  console.log(`  comentarios  ${media.comments_count} (segun Meta)\n`);

  const ageHours = (Date.now() - new Date(media.timestamp).getTime()) / 3_600_000;
  if (ageHours > 7 * 24) {
    console.warn(
      `AVISO: el reel se publico hace ${Math.floor(ageHours / 24)} dias. La ventana de\n` +
        "private_reply es de 7 dias DESDE CADA COMENTARIO, asi que los comentarios\n" +
        "viejos ya no son recuperables. El paso 3 te dira cuantos quedan vivos.\n",
    );
  }

  console.log("Bajando comentarios (paginado)...");
  const comments = await fetchComments(media.id);
  console.log(`Bajados: ${comments.length}`);

  if (media.comments_count && comments.length < media.comments_count) {
    const gap = media.comments_count - comments.length;
    console.warn(
      `\nAVISO: Meta reporta ${media.comments_count} comentarios pero la API devolvio ${comments.length} (faltan ${gap}).\n` +
        "Es esperable: la Graph API filtra comentarios de cuentas privadas. A esos no\n" +
        "hay forma de alcanzarlos por esta via (no tenemos su comment_id).\n",
    );
  }

  // Si un hilo llego al techo de replies, puede haber quedado afuera la
  // respuesta de ManyChat y ese comentario se clasificaria mal.
  const truncated = comments.filter((c) => (c.replies?.data?.length ?? 0) >= REPLIES_LIMIT);
  if (truncated.length > 0) {
    console.warn(
      `\nAVISO: ${truncated.length} comentario(s) tienen ${REPLIES_LIMIT}+ respuestas y el hilo\n` +
        "puede venir cortado. Si la respuesta de ManyChat quedo afuera, el paso 3 los\n" +
        "va a marcar como 'perdidos' y se les mandaria un DM que quiza ya recibieron.\n" +
        "Meta lo frena solo (2534023 = ya tenia respuesta), asi que el riesgo real es bajo.\n" +
        `Comentarios afectados: ${truncated.map((c) => c.id).join(", ")}\n`,
    );
  }

  const snapshot = {
    fetched_at: new Date().toISOString(),
    media: {
      id: media.id,
      shortcode: media.shortcode,
      permalink: media.permalink,
      timestamp: media.timestamp,
      comments_count_reported: media.comments_count ?? null,
      comments_count_fetched: comments.length,
    },
    comments,
  };

  const out = new URL("../data/comments.json", import.meta.url);
  await writeFile(out, JSON.stringify(snapshot, null, 2), "utf8");
  console.log(`\nEscrito data/comments.json (${comments.length} comentarios).`);
  console.log("Siguiente: npm run classify\n");
};

main().catch((err) => {
  console.error("\nError:", err.message);
  if (err instanceof GraphError) console.error("Detalle Meta:", JSON.stringify(err.raw, null, 2));
  process.exit(1);
});
