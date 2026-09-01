/**
 * PASO 6 — Resumen de como fue.
 *
 * Sin red. Lee data/final-sendable.csv y cuenta por estado.
 */
import { readFile } from "node:fs/promises";
import { fromCsv } from "./csv.mjs";

const LABELS = {
  sendable: "pendientes de enviar",
  sent: "enviados",
  already_replied: "ya tenian respuesta (los proceso ManyChat)",
  expired_mid_run: "expiraron durante el run",
  outside_window: "rechazados por ventana (#10)",
  comment_deleted: "comentario borrado (#100/33)",
  likely_undeliverable_privacy: "no entregables (filtro de privacidad)",
  needs_advanced_access: "requieren Advanced Access (#200/2534048)",
  error: "fallidos por otro error",
};

const main = async () => {
  const csv = await readFile(new URL("../data/final-sendable.csv", import.meta.url), "utf8");
  const { rows } = fromCsv(csv);

  if (rows.length === 0) {
    console.log("\nEl CSV esta vacio.\n");
    return;
  }

  const counts = new Map();
  for (const row of rows) {
    const key = row.status || "sin_estado";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  console.log(`\nRecuperacion — ${rows.length} destinatarios en la cola\n`);
  for (const [status, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    const pct = Math.round((count / rows.length) * 100);
    console.log(`  ${String(count).padStart(4)}  ${String(pct).padStart(3)}%  ${LABELS[status] ?? status}`);
  }

  // Solo cuenta verificaciones DE LOS ENVIADOS: los `already_replied` tambien
  // traen verified=Y (Meta los confirmo), pero no son envios nuestros y
  // mezclarlos inflaba el numero.
  const sent = rows.filter((r) => r.status === "sent");
  const verified = sent.filter((r) => r.verified === "Y").length;
  if (sent.length > 0) {
    const pending = sent.length - verified;
    console.log(`\n  verificados: ${verified} de ${sent.length} enviados` + (pending > 0 ? ` (${pending} sin verificar — npm run reverify)` : ""));
  }

  const errors = rows.filter((r) => r.error_code && r.status === "error");
  if (errors.length > 0) {
    console.log(`\n  Errores sin clasificar:`);
    const byCode = new Map();
    for (const row of errors) {
      const key = `#${row.error_code}/${row.error_subcode || "-"}: ${row.error_msg}`;
      byCode.set(key, (byCode.get(key) ?? 0) + 1);
    }
    for (const [msg, count] of byCode) console.log(`    ${count}x  ${msg}`);
  }

  console.log();
};

main().catch((err) => {
  if (err.code === "ENOENT") {
    console.error("\nNo existe data/final-sendable.csv. Corre: npm run classify\n");
    process.exit(1);
  }
  console.error("\nError:", err.message);
  process.exit(1);
});
