/**
 * Config centralizada. Los scripts declaran que variables necesitan y esto
 * falla temprano y claro si falta alguna, en vez de reventar contra la API
 * de Meta con un error opaco.
 */

const DEFAULTS = {
  GRAPH_VERSION: "v23.0",
  SEND_INTERVAL_MS: "18000",
  WINDOW_SAFETY_HOURS: "2",
  REWRITE_UTM_MEDIUM: "true",
  UTM_MEDIUM_RECOVERY: "ig_dm_recovery",
  PUBLIC_REPLY_PHRASES: "",
  // Respuesta publica del paso 9. Rotativas, separadas por "|". Escritas para
  // que matcheen las PUBLIC_REPLY_PHRASES de ejemplo: asi, si alguien vuelve a
  // correr el paso 3, nuestras respuestas cuentan como "ya procesado".
  PUBLIC_REPLY_TEXTS:
    "Listo, te acabo de enviar el recurso por DM 📩|Ya te lo mandé por DM, revisa tu bandeja 🙌|Listo, te escribí por DM con el acceso ✅",
  // 1 por minuto. Mas lento que los DMs a proposito: son N comentarios del
  // owner en un mismo hilo, el patron que castiga el filtro de spam de Meta.
  PUBLIC_REPLY_INTERVAL_MS: "60000",
};

/** Ventana de private_reply de Meta. No es configurable: es una regla de ellos. */
export { PRIVATE_REPLY_WINDOW_HOURS } from "./classify.mjs";

/** Tope de private_replies de Meta por hora. Referencia para validar el ritmo. */
export const META_HOURLY_SEND_CAP = 200;

const read = (key) => (process.env[key] ?? DEFAULTS[key] ?? "").trim();

/**
 * Devuelve la config validada, o corta el proceso con un mensaje accionable.
 * @param {string[]} required nombres de variables que este script necesita
 */
export function loadConfig(required = []) {
  const missing = required.filter((key) => read(key) === "");
  if (missing.length > 0) {
    console.error("\nFaltan variables obligatorias en .env:\n");
    for (const key of missing) console.error(`  - ${key}`);
    console.error("\nMira .env.example: cada una dice de donde sacar el valor.\n");
    process.exit(1);
  }

  const intervalMs = Number(read("SEND_INTERVAL_MS"));
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    console.error("SEND_INTERVAL_MS debe ser un numero positivo de milisegundos.");
    process.exit(1);
  }

  const perHour = 3_600_000 / intervalMs;
  if (perHour > META_HOURLY_SEND_CAP) {
    console.error(
      `\nSEND_INTERVAL_MS=${intervalMs} son ${Math.round(perHour)} envios/hora, ` +
        `por encima del tope de Meta (${META_HOURLY_SEND_CAP}/hora).\n` +
        `Eso dispara el error #613 y, sostenido, arriesga un limite sobre la cuenta.\n` +
        `Minimo seguro: SEND_INTERVAL_MS=${Math.ceil(3_600_000 / META_HOURLY_SEND_CAP)}\n`,
    );
    process.exit(1);
  }

  const publicReplyIntervalMs = Number(read("PUBLIC_REPLY_INTERVAL_MS"));
  if (!Number.isFinite(publicReplyIntervalMs) || publicReplyIntervalMs <= 0) {
    console.error("PUBLIC_REPLY_INTERVAL_MS debe ser un numero positivo de milisegundos.");
    process.exit(1);
  }
  if (3_600_000 / publicReplyIntervalMs > META_HOURLY_SEND_CAP) {
    console.error(
      `\nPUBLIC_REPLY_INTERVAL_MS=${publicReplyIntervalMs} son mas de ${META_HOURLY_SEND_CAP} respuestas/hora.\n` +
        "Son comentarios del owner en rafaga en un mismo hilo: el filtro de spam de Meta\n" +
        "castiga eso con un limite sobre la cuenta, no con un 400. Minimo: 18000 (60000 recomendado).\n",
    );
    process.exit(1);
  }

  return Object.freeze({
    token: read("META_TOKEN_MARKETING_INTEGRATION"),
    graphVersion: read("GRAPH_VERSION"),
    shortcode: read("REEL_SHORTCODE"),
    igUsername: read("IG_USERNAME").replace(/^@/, ""),
    keyword: read("TRIGGER_KEYWORD"),
    card: Object.freeze({
      title: read("CARD_TITLE"),
      buttonTitle: read("CARD_BUTTON_TITLE"),
      buttonUrl: read("CARD_BUTTON_URL"),
    }),
    publicReplyPhrases: Object.freeze(
      read("PUBLIC_REPLY_PHRASES")
        .split("|")
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean),
    ),
    publicReplyTexts: Object.freeze(
      read("PUBLIC_REPLY_TEXTS")
        .split("|")
        .map((t) => t.trim())
        .filter(Boolean),
    ),
    publicReplyIntervalMs,
    sendIntervalMs: intervalMs,
    windowSafetyHours: Number(read("WINDOW_SAFETY_HOURS")),
    rewriteUtmMedium: read("REWRITE_UTM_MEDIUM") === "true",
    utmMediumRecovery: read("UTM_MEDIUM_RECOVERY"),
  });
}

/**
 * Aplica la separacion de cohorte en la URL del boton. Devuelve la URL tal cual
 * si el rewrite esta apagado o si la URL no es parseable.
 */
export function applyUtm(rawUrl, config) {
  if (!config.rewriteUtmMedium) return rawUrl;
  try {
    const url = new URL(rawUrl);
    url.searchParams.set("utm_medium", config.utmMediumRecovery);
    return url.toString();
  } catch {
    return rawUrl;
  }
}
