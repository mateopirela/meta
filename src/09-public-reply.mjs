/**
 * PASO 9 — Respuesta PUBLICA en el hilo ("te envie un mensaje, comprueba tus DMs").
 *
 * Lo otro que hace ManyChat y que los pasos 4/8 no hacian: el comentario hijo
 * del owner debajo de cada comentario recuperado. Corre DESPUES de los DMs y
 * SOLO sobre filas cuyo DM salio (status `sent` o `likely_undeliverable_privacy`,
 * que tras el reverify tambien tiene la tarjeta entregada). Nunca prometemos un
 * DM que no existe.
 *
 * Por que es un paso aparte y no va dentro del envio:
 *   - Los DMs ya salieron y necesitan su respuesta igual.
 *   - Ritmo propio y mas lento (default 1/min): N respuestas del owner en un
 *     mismo hilo desde la API es el patron que castiga el filtro de spam de
 *     Meta, y el costo no es un 400 sino un limite sobre la cuenta.
 *   - Copy rotativo (PUBLIC_REPLY_TEXTS): N veces el mismo string es spam de libro.
 *
 * IDEMPOTENCIA — es nuestra, no de Meta. A diferencia del private_reply,
 * /{comment_id}/replies NO rebota duplicados: dos llamadas son dos respuestas
 * visibles en el reel. Por eso, doble red:
 *   1. el CSV guarda public_reply_id por fila, escrito atomico tras cada una;
 *   2. antes de responder se LEEN las replies del comentario: si el owner ya
 *      respondio con alguna de nuestras frases o de las de ManyChat, se saltea.
 * Un corte a mitad de run no duplica ni una.
 *
 * DRY-RUN POR DEFECTO. Flags:
 *   --commit          responde de verdad
 *   --limit=N         solo las primeras N pendientes (tanda de prueba)
 *   --reel=CODE       solo ese shortcode (aplica a cola-global)
 *   --system-token    usa el System User token en vez del Page token
 */
import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.mjs";
import { getPageToken, getCommentReplies, replyToComment, GraphError, NetworkError } from "./meta.mjs";
import { fromCsv, writeCsvAtomic } from "./csv.mjs";
import { isProcessed } from "./classify.mjs";

const config = loadConfig(["META_TOKEN_MARKETING_INTEGRATION", "IG_USERNAME"]);

const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const SYSTEM_TOKEN = args.includes("--system-token");
const LIMIT = Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? Infinity);
const SOLO_REEL = args.find((a) => a.startsWith("--reel="))?.split("=")[1] ?? null;

const PAGE_ID = (process.env.PAGE_ID ?? "").trim();
if (!PAGE_ID && !SYSTEM_TOKEN) {
  console.error("Falta PAGE_ID en .env. Lo imprime el paso 1 (npm run verify). O usa --system-token.");
  process.exit(1);
}

if (config.publicReplyTexts.length === 0) {
  console.error("PUBLIC_REPLY_TEXTS esta vacio: no hay con que responder.");
  process.exit(1);
}

const DATA = new URL("../data/", import.meta.url);
/** Los dos CSV que pueden tener DMs enviados: la cola global (paso 8) y la del paso 4. */
const SOURCES = ["cola-global.csv", "final-sendable.csv"];
/** Estados en los que el DM SI salio. `likely_undeliverable_privacy`: el reverify entrego la tarjeta. */
const DM_SENT = new Set(["sent", "likely_undeliverable_privacy"]);
/** Estados terminales del paso 9: no se reintentan. */
const TERMINAL = new Set(["replied", "already_replied", "comment_deleted"]);
const PUBLIC_COLUMNS = [
  "public_reply_id",
  "public_reply_at",
  "public_reply_text",
  "public_reply_status",
  "public_reply_error",
];

const MAX_RETRIES = 3;
const BACKOFF_MS = 30_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Nuestras frases + las de ManyChat: cualquiera de las dos cuenta como "ya respondido". */
const knownPhrases = [...config.publicReplyTexts, ...config.publicReplyPhrases];

const isPending = (r) =>
  Boolean(r.sent_at) &&
  DM_SENT.has(r.status) &&
  !r.public_reply_id &&
  !TERMINAL.has(r.public_reply_status ?? "") &&
  (!SOLO_REEL || !("shortcode" in r) || r.shortcode === SOLO_REEL);

async function loadSources() {
  const out = [];
  for (const name of SOURCES) {
    let text;
    try {
      text = await readFile(new URL(name, DATA), "utf8");
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
    const { columns, rows } = fromCsv(text);
    if (rows.length === 0) continue;
    // Agrega las columnas del paso 9 si el CSV aun no las tiene. toCsv escribe
    // "" para las celdas que la fila no trae.
    const allColumns = [...columns, ...PUBLIC_COLUMNS.filter((c) => !columns.includes(c))];
    out.push({ name, path: new URL(name, DATA), columns: allColumns, rows });
  }
  return out;
}

/**
 * Pre-check de idempotencia: lee las replies y decide si ya esta respondido.
 * Devuelve "already_replied" | "comment_deleted" | null (= hay que responder).
 * Si la lectura falla por otra cosa, tira: nunca respondemos a ciegas.
 */
async function precheck(commentId, token) {
  try {
    const replies = await getCommentReplies(commentId, config, token);
    return isProcessed({ replies }, config.igUsername, knownPhrases) ? "already_replied" : null;
  } catch (err) {
    if (err instanceof GraphError && err.code === 100 && err.subcode === 33) return "comment_deleted";
    throw err;
  }
}

async function replyWithRetry(commentId, message, token) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return { ok: true, res: await replyToComment({ commentId, message, token, config }) };
    } catch (err) {
      const known = err instanceof GraphError || err instanceof NetworkError;
      if (!known) throw err;
      if (err.isRetryable && attempt <= MAX_RETRIES) {
        const wait = BACKOFF_MS * attempt;
        const label = err instanceof GraphError ? `#${err.code ?? err.status}` : "red";
        console.warn(`    ${label} (transitorio). Backoff ${wait / 1000}s, intento ${attempt}/${MAX_RETRIES}...`);
        await sleep(wait);
        continue;
      }
      return { ok: false, err };
    }
  }
}

function describeError(err) {
  if (err instanceof GraphError) {
    if (err.code === 100 && err.subcode === 33) return { status: "comment_deleted", note: "el comentario ya no existe" };
    if (err.code === 10 || err.code === 200) {
      const hint = SYSTEM_TOKEN ? "sin --system-token (Page token)" : "con --system-token";
      return { status: "error", note: `sin permiso para responder (#${err.code}): revisa instagram_manage_comments o proba ${hint}` };
    }
  }
  return { status: "error", note: err.message };
}

const main = async () => {
  const sources = await loadSources();
  if (sources.length === 0) {
    console.error("No hay data/cola-global.csv ni data/final-sendable.csv con filas.");
    process.exit(1);
  }

  // Cola unica cruzando los dos CSV, en el orden de los archivos. Cada fila
  // recuerda su archivo para el flush.
  const queue = [];
  for (const src of sources) for (const row of src.rows) if (isPending(row)) queue.push({ row, src });
  const batch = queue.slice(0, LIMIT);

  const totalRows = sources.reduce((n, s) => n + s.rows.length, 0);
  const done = sources.reduce((n, s) => n + s.rows.filter((r) => r.public_reply_id).length, 0);
  const dmSent = sources.reduce((n, s) => n + s.rows.filter((r) => r.sent_at && DM_SENT.has(r.status)).length, 0);
  const perHour = Math.round(3_600_000 / config.publicReplyIntervalMs);
  const minutes = Math.ceil((batch.length * config.publicReplyIntervalMs) / 60_000);

  console.log(`\n${COMMIT ? "RESPUESTA PUBLICA REAL" : "DRY-RUN (no se responde nada)"}`);
  console.log(`\n  archivos ................. ${sources.map((s) => s.name).join(", ")}`);
  console.log(`  filas totales ............ ${totalRows}`);
  console.log(`  con DM enviado ........... ${dmSent}`);
  console.log(`  ya con respuesta publica . ${done}`);
  console.log(`  pendientes ............... ${queue.length}`);
  console.log(`  en esta tanda ............ ${batch.length}`);
  console.log(`\n  ritmo .................... 1 cada ${config.publicReplyIntervalMs / 1000}s (${perHour}/hora)`);
  console.log(`  duracion estimada ........ ~${minutes} min`);
  console.log(`  token .................... ${SYSTEM_TOKEN ? "System User" : `Page (${PAGE_ID})`}`);
  console.log(`\n  textos (rotan):`);
  for (const t of config.publicReplyTexts) console.log(`    - ${t}`);

  if (batch.length === 0) {
    console.log("\nNo queda nada pendiente.\n");
    return;
  }

  if (!COMMIT) {
    console.log(`\n  Primeros ${Math.min(8, batch.length)}:`);
    for (const [i, { row, src }] of batch.slice(0, 8).entries()) {
      const text = config.publicReplyTexts[i % config.publicReplyTexts.length];
      console.log(`    @${row.username.padEnd(24)} [${src.name}]  "${text}"`);
    }
    console.log("\nPara responder de verdad: npm run reply:commit   (o --commit --limit=10 para probar)\n");
    return;
  }

  let token = config.token;
  if (!SYSTEM_TOKEN) {
    console.log("\nDerivando Page Access Token...");
    token = await getPageToken(PAGE_ID, config);
    console.log("OK. Arrancando.\n");
  }

  let replied = 0;
  let skipped = 0;
  let failed = 0;
  const flush = (src) => writeCsvAtomic(src.path, src.columns, src.rows);

  for (const [idx, { row, src }] of batch.entries()) {
    const position = `[${idx + 1}/${batch.length}]`;

    let pre;
    try {
      pre = await precheck(row.comment_id, token);
    } catch (err) {
      row.public_reply_status = "error";
      row.public_reply_error = `no se pudieron leer las replies: ${err.message}`;
      failed += 1;
      console.log(`${position} @${row.username} — FALLO leyendo replies: ${err.message}`);
      await flush(src);
      continue;
    }
    if (pre) {
      row.public_reply_status = pre;
      row.public_reply_error =
        pre === "already_replied" ? "el owner ya habia respondido en el hilo" : "el comentario ya no existe";
      skipped += 1;
      console.log(`${position} @${row.username} — SALTEADO: ${row.public_reply_error}`);
      await flush(src);
      continue;
    }

    const text = config.publicReplyTexts[replied % config.publicReplyTexts.length];
    const result = await replyWithRetry(row.comment_id, text, token);

    if (result.ok) {
      row.public_reply_id = result.res.id ?? "";
      row.public_reply_at = new Date().toISOString();
      row.public_reply_text = text;
      row.public_reply_status = "replied";
      row.public_reply_error = "";
      replied += 1;
      console.log(`${position} @${row.username} — respondido (${row.public_reply_id})`);
    } else {
      const { status, note } = describeError(result.err);
      row.public_reply_status = status;
      row.public_reply_error = note;
      failed += 1;
      console.log(`${position} @${row.username} — FALLO: ${note}`);
    }

    await flush(src);
    // El ritmo aplica a los POST; los salteados no gastan cuota.
    if (idx < batch.length - 1) await sleep(config.publicReplyIntervalMs);
  }

  console.log(`\n  respondidos .. ${replied}`);
  console.log(`  salteados .... ${skipped}`);
  console.log(`  fallidos ..... ${failed}`);
  console.log("\nCSV actualizado. Volver a correr es seguro: saltea lo ya respondido.\n");
};

main().catch((err) => {
  console.error("\nError:", err.message);
  if (err instanceof GraphError) console.error("Detalle Meta:", JSON.stringify(err.raw, null, 2));
  process.exit(1);
});
