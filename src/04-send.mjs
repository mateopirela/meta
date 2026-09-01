/**
 * PASO 4 — Enviar los DMs.
 *
 * DRY-RUN POR DEFECTO. Para enviar de verdad: `npm run send:commit`.
 *
 * Propiedades que importan a esta escala (500 envios ~ 2.5 h):
 *   - Reanudable: escribe el CSV despues de CADA fila. Si se corta la luz,
 *     volves a correr y sigue donde quedo (saltea filas con sent_at).
 *   - Ritmo: 200/hora, el tope de Meta. Ver config.mjs.
 *   - Revalida la ventana de 7 dias por fila JUSTO antes de enviar: en un run
 *     largo hay comentarios que expiran a mitad de camino.
 *   - Idempotente por partida doble: nuestro CSV + el 2534023 de Meta.
 *
 * Flags:
 *   --commit      envia de verdad (sin esto, simula)
 *   --limit=N     solo las primeras N filas pendientes (para una tanda de prueba)
 */
import { readFile } from "node:fs/promises";
import { loadConfig, applyUtm } from "./config.mjs";
import { getPageToken, sendPrivateReply, GraphError, NetworkError } from "./meta.mjs";
import { fromCsv, writeCsvAtomic } from "./csv.mjs";
import { windowStatus } from "./classify.mjs";

const config = loadConfig([
  "META_TOKEN_MARKETING_INTEGRATION",
  "CARD_TITLE",
  "CARD_BUTTON_TITLE",
  "CARD_BUTTON_URL",
]);

const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const LIMIT = Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? Infinity);

const PAGE_ID = (process.env.PAGE_ID ?? "").trim();
if (!PAGE_ID) {
  console.error("Falta PAGE_ID en .env. Lo imprime el paso 1 (npm run verify).");
  process.exit(1);
}

const CSV_PATH = new URL("../data/final-sendable.csv", import.meta.url);
const MAX_RETRIES = 3;
const BACKOFF_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Un envio con reintentos ante lo transitorio: rate limit (#613), 5xx/429 de
 * un proxy, y fallos de red (DNS, timeout, conexion cortada).
 *
 * Los fallos de red importan tanto como los de Meta: en 500 llamadas HTTP
 * secuenciales a lo largo de 2,5 h, un hipo de red es probable, y sin esto
 * un TypeError de fetch() se escapaba hasta matar el run entero.
 */
async function sendWithRetry(commentId, card, pageToken) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await sendPrivateReply({ commentId, card, pageToken, config });
      return { ok: true, res };
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

/** Traduce el error de Meta a un estado legible en el CSV. */
function describeError(err) {
  if (err.subcode === 2534023) {
    return { outcome: "already_replied", note: "ya tenia respuesta (ManyChat lo proceso o ya lo mandamos)" };
  }
  if (err.code === 100 && err.subcode === 33) {
    return { outcome: "comment_deleted", note: "el comentario ya no existe" };
  }
  if (err.code === 10) {
    return { outcome: "outside_window", note: "fuera de la ventana de 7 dias" };
  }
  if (err.code === 200 && err.subcode === 2534048) {
    return { outcome: "needs_advanced_access", note: "recipient mal armado: debe ser comment_id" };
  }
  return { outcome: "error", note: err.message };
}

const main = async () => {
  const { rows } = fromCsv(await readFile(CSV_PATH, "utf8"));
  if (rows.length === 0) {
    console.error("data/final-sendable.csv esta vacio. Corre: npm run classify");
    process.exit(1);
  }

  const columns = Object.keys(rows[0]);
  const pending = rows.filter((r) => !r.sent_at);
  const done = rows.length - pending.length;
  const batch = pending.slice(0, LIMIT);

  const buttonUrl = applyUtm(config.card.buttonUrl, config);
  const card = { ...config.card, buttonUrl };

  console.log(`\n${COMMIT ? "ENVIO REAL" : "DRY-RUN (no se envia nada)"}`);
  console.log(`\n  total en el CSV .... ${rows.length}`);
  console.log(`  ya enviados ........ ${done}`);
  console.log(`  pendientes ......... ${pending.length}`);
  console.log(`  en esta tanda ...... ${batch.length}`);
  console.log(`\n  ritmo .............. 1 cada ${config.sendIntervalMs / 1000}s (${Math.round(3_600_000 / config.sendIntervalMs)}/hora)`);
  console.log(`  duracion estimada .. ~${Math.ceil((batch.length * config.sendIntervalMs) / 60_000)} min`);
  console.log(`\n  tarjeta:`);
  console.log(`    titulo  ${card.title}`);
  console.log(`    boton   ${card.buttonTitle}`);
  console.log(`    url     ${buttonUrl}`);
  if (config.rewriteUtmMedium) console.log(`            (utm_medium reescrito a "${config.utmMediumRecovery}")`);

  if (batch.length === 0) {
    console.log("\nNo queda nada pendiente.\n");
    return;
  }

  if (!COMMIT) {
    console.log(`\n  Primeros ${Math.min(5, batch.length)} destinatarios:`);
    for (const row of batch.slice(0, 5)) {
      console.log(`    @${row.username}  (${row.hours_left}h de ventana)  "${row.text.slice(0, 40)}"`);
    }
    console.log(`\nPara enviar de verdad: npm run send:commit\n`);
    return;
  }

  console.log("\nDerivando Page Access Token...");
  const pageToken = await getPageToken(PAGE_ID, config);
  console.log("OK. Arrancando.\n");

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  const flush = () => writeCsvAtomic(CSV_PATH, columns, rows);

  // `batch` son las MISMAS referencias que estan en `rows` (filter/slice no
  // copian los objetos), asi que mutar `row` actualiza la fila del CSV. No
  // hace falta buscarla por id — y buscarla seria peor: con comment_id
  // duplicados devolveria otra fila.
  for (const [idx, row] of batch.entries()) {
    const position = `[${idx + 1}/${batch.length}]`;

    // La ventana se revalida ACA, no en el paso 3: este run dura horas.
    const window = windowStatus(row.comment_ts, new Date(), config.windowSafetyHours);
    if (window.expired) {
      row.status = "expired_mid_run";
      row.error_msg = "expiro la ventana de 7d mientras corria el envio";
      skipped += 1;
      console.log(`${position} @${row.username} — SALTEADO: expiro la ventana`);
      await flush();
      continue;
    }

    const result = await sendWithRetry(row.comment_id, card, pageToken);

    if (result.ok) {
      row.sent_at = new Date().toISOString();
      row.message_id = result.res.message_id ?? "";
      row.recipient_id = result.res.recipient_id ?? "";
      row.status = "sent";
      sent += 1;
      console.log(`${position} @${row.username} — enviado (${row.message_id})`);
    } else {
      const { outcome, note } = describeError(result.err);
      row.status = outcome;
      row.error_code = result.err.code ?? "";
      row.error_subcode = result.err.subcode ?? "";
      row.error_msg = note;
      // "Ya tenia respuesta" no es un fallo: es la idempotencia de Meta haciendo su trabajo.
      if (outcome === "already_replied") {
        row.sent_at = new Date().toISOString();
        row.verified = "Y";
        skipped += 1;
        console.log(`${position} @${row.username} — ya tenia respuesta, se saltea`);
      } else {
        failed += 1;
        console.log(`${position} @${row.username} — FALLO #${result.err.code}: ${note}`);
      }
    }

    await flush();
    if (idx < batch.length - 1) await sleep(config.sendIntervalMs);
  }

  console.log(`\n  enviados ... ${sent}`);
  console.log(`  salteados .. ${skipped}`);
  console.log(`  fallidos ... ${failed}`);
  console.log(`\nCSV actualizado. Volver a correr es seguro: saltea lo ya enviado.`);
  console.log("Siguiente: npm run report\n");
};

main().catch((err) => {
  if (err.code === "ENOENT") {
    console.error("\nNo existe data/final-sendable.csv. Corre primero: npm run classify\n");
    process.exit(1);
  }
  console.error("\nError:", err.message);
  if (err instanceof GraphError) console.error("Detalle Meta:", JSON.stringify(err.raw, null, 2));
  process.exit(1);
});
