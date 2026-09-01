/**
 * PASO 7 — Armar la cola GLOBAL de envio (todos los reels juntos).
 *
 * Por que no alcanza con correr el paso 3 una vez por reel: el tope de 200/hora
 * es de la CUENTA, no del reel. Con 263 pendientes el run dura ~80 min, y si
 * arrancas por el reel equivocado hay gente de otro reel que vence mientras
 * tanto. La unica cola correcta es una sola, ordenada por vencimiento, cruzando
 * reels.
 *
 * Lee los CSV de la auditoria (que ya tienen comment_id + comment_ts) en vez de
 * volver a bajar los comentarios: la ventana se calcula del timestamp del
 * comentario, que es absoluto, y el paso 8 la revalida fila por fila antes de
 * cada envio. Si ManyChat contesto a alguien mientras tanto, Meta lo frena sola
 * con el 2534023.
 *
 * Read-only sobre la red. Escribe data/cola-global.csv
 */
import { readFile, writeFile } from "node:fs/promises";
import { loadConfig } from "./config.mjs";
import { fromCsv, toCsv } from "./csv.mjs";
import { windowStatus } from "./classify.mjs";

const config = loadConfig([]);
const DATA = new URL("../data/", import.meta.url);

const FUENTES = ["auditoria-julio-perdidos.csv", "auditoria-julio-perdidos-extra.csv"];
const COLUMNS = [
  "comment_id", "username", "text", "shortcode", "keyword",
  "comment_ts", "expires_at", "hours_left",
  "status", "sent_at", "message_id", "recipient_id",
  "error_code", "error_subcode", "error_msg", "verified",
];

/** comment_id de todo lo que ya se envio en corridas anteriores. */
async function yaEnviados() {
  const hechos = new Set();
  for (const nombre of ["final-sendable.csv", "cola-global.csv"]) {
    try {
      const { rows } = fromCsv(await readFile(new URL(nombre, DATA), "utf8"));
      for (const r of rows) if (r.sent_at) hechos.add(r.comment_id);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  return hechos;
}

const main = async () => {
  const cards = JSON.parse(await readFile(new URL("cards.json", DATA), "utf8"));
  const hechos = await yaEnviados();
  const now = new Date();

  const vistos = new Set();
  const filas = [];
  let expirados = 0;
  let duplicados = 0;

  for (const fuente of FUENTES) {
    const { rows } = fromCsv(await readFile(new URL(fuente, DATA), "utf8"));
    for (const r of rows) {
      if (hechos.has(r.comment_id)) continue;
      // Un mismo comment_id puede aparecer en ambos CSV si el keyword matcheo
      // por dos vias; mandarlo dos veces seria un 2534023 desperdiciado.
      if (vistos.has(r.comment_id)) { duplicados += 1; continue; }
      vistos.add(r.comment_id);

      const win = windowStatus(r.comment_ts, now, config.windowSafetyHours);
      if (win.expired) { expirados += 1; continue; }

      filas.push({
        comment_id: r.comment_id,
        username: r.username,
        text: r.text,
        shortcode: r.shortcode,
        keyword: cards[r.shortcode]?.keyword ?? r.keyword,
        comment_ts: r.comment_ts,
        expires_at: win.expiresAt.toISOString(),
        hours_left: Math.round(win.hoursLeft * 10) / 10,
        status: "sendable",
        sent_at: "", message_id: "", recipient_id: "",
        error_code: "", error_subcode: "", error_msg: "", verified: "",
      });
    }
  }

  // EL orden que importa: quien menos ventana le queda sale primero, sin
  // importar de que reel venga.
  filas.sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at));

  await writeFile(new URL("cola-global.csv", DATA), toCsv(COLUMNS, filas), "utf8");

  const porReel = new Map();
  for (const f of filas) porReel.set(f.shortcode, (porReel.get(f.shortcode) ?? 0) + 1);

  console.log(`\nCola global — ${filas.length} envios pendientes\n`);
  console.log(`  ya enviados antes .... ${hechos.size}`);
  console.log(`  fuera de ventana ..... ${expirados}`);
  if (duplicados > 0) console.log(`  duplicados descartados ${duplicados}`);

  console.log(`\n  reel           keyword       gente   tarjeta`);
  for (const [sc, n] of [...porReel].sort((a, b) => b[1] - a[1])) {
    const card = cards[sc];
    const lista = card?.title && card?.buttonUrl ? "lista" : "FALTA EL COPY";
    console.log(`  ${sc.padEnd(14)} ${(card?.keyword ?? "?").padEnd(13)} ${String(n).padStart(4)}   ${lista}`);
  }

  const listos = filas.filter((f) => cards[f.shortcode]?.title && cards[f.shortcode]?.buttonUrl).length;
  console.log(`\n  enviables ya ......... ${listos}`);
  console.log(`  esperando copy ....... ${filas.length - listos}`);
  console.log(`\n  duracion de los ${listos}: ~${Math.ceil((listos * config.sendIntervalMs) / 60000)} min`);
  console.log(`\nSiguiente: node src/08-send-queue.mjs   (dry-run)\n`);
};

main().catch((err) => {
  console.error("\nError:", err.message);
  process.exit(1);
});
