/**
 * PASO 5 — Verificar que los envios quedaron registrados.
 *
 * Como: reintentando el MISMO envio. Si el original quedo registrado, Meta
 * responde 2534023 ("ya tiene respuesta") y eso lo confirma. Si en cambio
 * responde 200 con un message_id nuevo, el original se cayo en silencio
 * (tipicamente un filtro de privacidad del destinatario).
 *
 * Por eso el reintento usa la MISMA tarjeta y no un texto cualquiera: si el
 * original no llego, este intento pasa a ser la entrega real. Mejor que llegue
 * la tarjeta de recuperacion y no ruido.
 *
 * COSTO: cada verificacion es un private_reply mas y come del tope de 200/hora.
 * Verificar 500 duplica el run. Por defecto se verifica una MUESTRA, suficiente
 * para detectar una caida sistematica. `--all` verifica todo.
 *
 * Flags:
 *   --sample=N   cuantas verificar (default 20)
 *   --all        verificar todas las enviadas
 */
import { readFile } from "node:fs/promises";
import { loadConfig, applyUtm } from "./config.mjs";
import { getPageToken, sendPrivateReply, GraphError } from "./meta.mjs";
import { fromCsv, writeCsvAtomic } from "./csv.mjs";

const config = loadConfig([
  "META_TOKEN_MARKETING_INTEGRATION",
  "CARD_TITLE",
  "CARD_BUTTON_TITLE",
  "CARD_BUTTON_URL",
]);

const args = process.argv.slice(2);
const ALL = args.includes("--all");
const SAMPLE = Number(args.find((a) => a.startsWith("--sample="))?.split("=")[1] ?? 20);

const PAGE_ID = (process.env.PAGE_ID ?? "").trim();
if (!PAGE_ID) {
  console.error("Falta PAGE_ID en .env. Lo imprime el paso 1 (npm run verify).");
  process.exit(1);
}

const CSV_PATH = new URL("../data/final-sendable.csv", import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const main = async () => {
  const { rows } = fromCsv(await readFile(CSV_PATH, "utf8"));
  const columns = Object.keys(rows[0] ?? {});

  const candidates = rows.filter((r) => r.status === "sent" && r.sent_at && !r.verified);
  const batch = ALL ? candidates : candidates.slice(0, SAMPLE);

  if (batch.length === 0) {
    console.log("\nNo hay envios sin verificar.\n");
    return;
  }

  console.log(`\nVerificando ${batch.length} de ${candidates.length} envios sin verificar.`);
  console.log(`Cada verificacion es un private_reply mas (come del tope de 200/hora).\n`);

  const pageToken = await getPageToken(PAGE_ID, config);
  const card = { ...config.card, buttonUrl: applyUtm(config.card.buttonUrl, config) };

  let confirmed = 0;
  let dropped = 0;
  let inconclusive = 0;
  const flush = () => writeCsvAtomic(CSV_PATH, columns, rows);

  for (const [idx, row] of batch.entries()) {
    const position = `[${idx + 1}/${batch.length}]`;
    try {
      const res = await sendPrivateReply({ commentId: row.comment_id, card, pageToken, config });
      // 200 OK = el original NO quedo registrado; este intento fue la entrega real.
      row.verified = "N";
      row.status = "likely_undeliverable_privacy";
      row.error_msg = "el envio original se cayo en silencio; el reintento entrego la tarjeta";
      row.message_id = res.message_id ?? row.message_id;
      dropped += 1;
      console.log(`${position} @${row.username} — el original NO estaba registrado (reintento entregado)`);
    } catch (err) {
      if (err instanceof GraphError && err.subcode === 2534023) {
        row.verified = "Y";
        confirmed += 1;
        console.log(`${position} @${row.username} — confirmado`);
      } else {
        // `verified` queda VACIO a proposito: los candidatos se filtran por
        // !r.verified, asi que marcarlo con "?" excluiria esta fila de todo
        // reverify futuro y nunca sabriamos si el DM llego. Vacio = reintentable.
        row.error_msg = `verificacion no concluyente: ${err.message}`;
        inconclusive += 1;
        console.log(`${position} @${row.username} — no concluyente (reintentable): ${err.message}`);
      }
    }
    await flush();
    if (idx < batch.length - 1) await sleep(config.sendIntervalMs);
  }

  console.log(`\n  confirmados ......... ${confirmed}`);
  console.log(`  caidos en silencio .. ${dropped}`);
  if (inconclusive > 0) console.log(`  no concluyentes ..... ${inconclusive} (volve a correr reverify)`);

  if (dropped > 0) {
    console.warn(
      `\nOJO: ${dropped} envios no habian quedado registrados. Si la proporcion es\n` +
        "alta, hay algo sistematico (token, permisos, o el payload) y conviene\n" +
        "frenar el resto del run antes de seguir quemando ventana.\n",
    );
  }
  console.log();
};

main().catch((err) => {
  if (err.code === "ENOENT") {
    console.error("\nNo existe data/final-sendable.csv.\n");
    process.exit(1);
  }
  console.error("\nError:", err.message);
  process.exit(1);
});
