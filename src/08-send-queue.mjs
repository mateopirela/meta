/**
 * PASO 8 — Enviar la cola global (multi-reel, una tarjeta distinta por reel).
 *
 * Mismo contrato que el paso 4 — dry-run por defecto, reanudable, atomico,
 * revalida la ventana fila por fila, 200/hora — con dos diferencias:
 *
 *   1. La cola cruza reels y va ordenada por vencimiento global. El tope de
 *      Meta es de la cuenta, asi que la unica prioridad correcta es "a quien
 *      le queda menos ventana", venga del reel que venga.
 *   2. La tarjeta sale de data/cards.json segun el shortcode de cada fila.
 *      Un reel sin copy se SALTEA sin gastarle el intento a nadie: completas
 *      su tarjeta despues y volves a correr.
 *
 * Flags:
 *   --commit      envia de verdad (sin esto, simula)
 *   --limit=N     solo las primeras N pendientes (tanda de prueba)
 *   --reel=CODE   restringe a un shortcode
 */
import { readFile } from "node:fs/promises";
import { loadConfig, applyUtm } from "./config.mjs";
import { getPageToken, sendPrivateReply, GraphError, NetworkError } from "./meta.mjs";
import { fromCsv, writeCsvAtomic } from "./csv.mjs";
import { windowStatus } from "./classify.mjs";

// Las tarjetas viven en cards.json, no en el .env: son varias a la vez.
const config = loadConfig(["META_TOKEN_MARKETING_INTEGRATION"]);

const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const LIMIT = Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? Infinity);
const SOLO_REEL = args.find((a) => a.startsWith("--reel="))?.split("=")[1] ?? null;

const PAGE_ID = (process.env.PAGE_ID ?? "").trim();
if (!PAGE_ID) {
  console.error("Falta PAGE_ID en .env. Lo imprime el paso 1 (npm run verify).");
  process.exit(1);
}

const DATA = new URL("../data/", import.meta.url);
const CSV_PATH = new URL("cola-global.csv", DATA);
const MAX_RETRIES = 3;
const BACKOFF_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tieneCopy = (card) => Boolean(card?.title && card?.buttonTitle && card?.buttonUrl);

async function sendWithRetry(commentId, card, pageToken) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return { ok: true, res: await sendPrivateReply({ commentId, card, pageToken, config }) };
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
  if (err.subcode === 2534023) return { outcome: "already_replied", note: "ya tenia respuesta" };
  if (err.code === 100 && err.subcode === 33) return { outcome: "comment_deleted", note: "el comentario ya no existe" };
  if (err.code === 10) return { outcome: "outside_window", note: "fuera de la ventana de 7 dias" };
  if (err.code === 200 && err.subcode === 2534048) return { outcome: "needs_advanced_access", note: "recipient mal armado" };
  return { outcome: "error", note: err.message };
}

const main = async () => {
  const cards = JSON.parse(await readFile(new URL("cards.json", DATA), "utf8"));
  const { rows } = fromCsv(await readFile(CSV_PATH, "utf8"));
  if (rows.length === 0) {
    console.error("data/cola-global.csv esta vacio. Corre: node src/07-build-queue.mjs");
    process.exit(1);
  }
  const columns = Object.keys(rows[0]);

  const pendientes = rows.filter(
    (r) => !r.sent_at && (!SOLO_REEL || r.shortcode === SOLO_REEL) && tieneCopy(cards[r.shortcode]),
  );
  const sinCopy = rows.filter((r) => !r.sent_at && !tieneCopy(cards[r.shortcode]));
  const batch = pendientes.slice(0, LIMIT);

  console.log(`\n${COMMIT ? "ENVIO REAL" : "DRY-RUN (no se envia nada)"}`);
  console.log(`\n  total en la cola ... ${rows.length}`);
  console.log(`  ya enviados ........ ${rows.filter((r) => r.sent_at).length}`);
  console.log(`  listos para enviar . ${pendientes.length}`);
  console.log(`  esperando copy ..... ${sinCopy.length}`);
  console.log(`  en esta tanda ...... ${batch.length}`);
  console.log(`\n  ritmo .............. 1 cada ${config.sendIntervalMs / 1000}s (${Math.round(3_600_000 / config.sendIntervalMs)}/hora)`);
  console.log(`  duracion estimada .. ~${Math.ceil((batch.length * config.sendIntervalMs) / 60_000)} min`);

  if (sinCopy.length > 0) {
    const faltan = [...new Set(sinCopy.map((r) => r.shortcode))];
    console.log(`\n  Sin tarjeta (se saltean): ${faltan.join(", ")}`);
  }

  if (batch.length === 0) {
    console.log("\nNada que enviar. Completa las tarjetas en data/cards.json.\n");
    return;
  }

  if (!COMMIT) {
    console.log(`\n  Primeros ${Math.min(8, batch.length)} de la cola:`);
    for (const row of batch.slice(0, 8)) {
      const card = cards[row.shortcode];
      console.log(`    @${row.username.padEnd(24)} ${String(row.hours_left).padStart(6)}h  "${card.buttonTitle}"  [${row.shortcode}]`);
    }
    console.log(`\nPara enviar de verdad: node src/08-send-queue.mjs --commit\n`);
    return;
  }

  console.log("\nDerivando Page Access Token...");
  const pageToken = await getPageToken(PAGE_ID, config);
  console.log("OK. Arrancando.\n");

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const flush = () => writeCsvAtomic(CSV_PATH, columns, rows);

  for (const [idx, row] of batch.entries()) {
    const position = `[${idx + 1}/${batch.length}]`;
    const spec = cards[row.shortcode];
    const card = {
      title: spec.title,
      buttonTitle: spec.buttonTitle,
      buttonUrl: applyUtm(spec.buttonUrl, config),
    };

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
      console.log(`${position} @${row.username} — enviado [${row.keyword}]`);
    } else {
      const { outcome, note } = describeError(result.err);
      row.status = outcome;
      row.error_code = result.err.code ?? "";
      row.error_subcode = result.err.subcode ?? "";
      row.error_msg = note;
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
  console.log(`\nCSV actualizado. Volver a correr es seguro: saltea lo ya enviado.\n`);
};

main().catch((err) => {
  if (err.code === "ENOENT") {
    console.error("\nFalta data/cola-global.csv o data/cards.json. Corre: node src/07-build-queue.mjs\n");
    process.exit(1);
  }
  console.error("\nError:", err.message);
  if (err instanceof GraphError) console.error("Detalle Meta:", JSON.stringify(err.raw, null, 2));
  process.exit(1);
});
