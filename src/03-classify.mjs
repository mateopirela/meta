/**
 * PASO 3 — Decidir a quien se le manda.
 *
 * Sin red. Lee data/comments.json y escribe:
 *   data/final-sendable.csv   -> la cola de envio (la consume el paso 4)
 *   data/classified-all.csv   -> todos los comentarios con su estado (auditoria)
 */
import { readFile, writeFile } from "node:fs/promises";
import { loadConfig } from "./config.mjs";
import { classifyAll, summarize, STATUS } from "./classify.mjs";
import { toCsv } from "./csv.mjs";

const config = loadConfig(["REEL_SHORTCODE", "IG_USERNAME", "TRIGGER_KEYWORD"]);

/** Columnas del CSV de envio. El paso 4 rellena de `sent_at` en adelante. */
const SEND_COLUMNS = [
  "comment_id",
  "username",
  "text",
  "comment_ts",
  "expires_at",
  "hours_left",
  "status",
  "sent_at",
  "message_id",
  "recipient_id",
  "verified",
  "error_code",
  "error_subcode",
  "error_msg",
];

const AUDIT_COLUMNS = ["comment_id", "username", "text", "comment_ts", "expires_at", "hours_left", "status"];

const main = async () => {
  const snapshotUrl = new URL("../data/comments.json", import.meta.url);
  const { comments, media } = JSON.parse(await readFile(snapshotUrl, "utf8"));

  if (config.publicReplyPhrases.length === 0) {
    console.warn(
      "\nAVISO: PUBLIC_REPLY_PHRASES esta vacio. Se usa el criterio conservador:\n" +
        "cualquier respuesta de @" + config.igUsername + " cuenta como 'ya procesado'.\n" +
        "Eso puede dejar afuera gente que si necesita el DM. Si podes, carga las\n" +
        "frases reales del flow de ManyChat.\n",
    );
  }

  const now = new Date();
  const { rows, sendable } = classifyAll(comments, {
    keyword: config.keyword,
    ownerUsername: config.igUsername,
    phrases: config.publicReplyPhrases,
    now,
    safetyHours: config.windowSafetyHours,
  });

  const counts = summarize(rows);

  console.log(`\nReel ${media.shortcode} — ${comments.length} comentarios analizados`);
  console.log(`Keyword: "${config.keyword}"   Owner: @${config.igUsername}\n`);
  console.log(`  ENVIABLES ................. ${counts[STATUS.SENDABLE]}`);
  console.log(`  sin el keyword ............ ${counts[STATUS.SKIP_NO_KEYWORD]}`);
  console.log(`  ya procesados por ManyChat  ${counts[STATUS.SKIP_ALREADY_PROCESSED]}`);
  console.log(`  fuera de la ventana 7d .... ${counts[STATUS.SKIP_EXPIRED]}`);

  const sendRows = sendable.map((row) => ({
    ...row,
    sent_at: "",
    message_id: "",
    recipient_id: "",
    verified: "",
    error_code: "",
    error_subcode: "",
    error_msg: "",
  }));

  await writeFile(
    new URL("../data/final-sendable.csv", import.meta.url),
    toCsv(SEND_COLUMNS, sendRows),
    "utf8",
  );
  await writeFile(
    new URL("../data/classified-all.csv", import.meta.url),
    toCsv(AUDIT_COLUMNS, rows),
    "utf8",
  );

  if (sendable.length === 0) {
    console.log("\nNo hay nada que enviar.\n");
    return;
  }

  const minutes = Math.ceil((sendable.length * config.sendIntervalMs) / 60_000);
  const tightest = sendable[0];
  console.log(`\nEscrito data/final-sendable.csv (${sendable.length} filas).`);
  console.log(
    `\nA ${config.sendIntervalMs / 1000}s por envio, el run dura ~${minutes} min ` +
      `(${Math.round((minutes / 60) * 10) / 10} h).`,
  );
  console.log(
    `El mas urgente es @${tightest.username}: le quedan ${tightest.hours_left} h de ventana.`,
  );

  if (tightest.hours_left < minutes / 60) {
    console.warn(
      "\nOJO: al mas urgente le queda menos ventana de lo que dura el run completo.\n" +
        "La cola ya va del mas viejo al mas nuevo, asi que arranca por el. Igual\n" +
        "el paso 4 revalida la ventana de cada fila justo antes de enviarla.",
    );
  }

  console.log("\nSiguiente: npm run send   (dry-run, no envia nada)\n");
};

main().catch((err) => {
  if (err.code === "ENOENT") {
    console.error("\nNo existe data/comments.json. Corre primero: npm run fetch\n");
    process.exit(1);
  }
  console.error("\nError:", err.message);
  process.exit(1);
});
