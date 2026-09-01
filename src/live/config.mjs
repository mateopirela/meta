/**
 * Config del modo en vivo. Un solo lugar que lee el entorno (PLAN §3.2).
 *
 * Los pisos de ritmo NO son negociables y se validan acá, como hace config.mjs
 * con los scripts: si el entorno pide ir más rápido que el tope de Meta, el
 * servidor no arranca. Un ritmo mal puesto no se nota hasta el envío 200, y
 * para entonces ya hay un límite sobre la cuenta.
 *
 * El token NUNCA se loguea ni vuelve en una respuesta: sólo se publica
 * `tokenConfigured: true|false`.
 */
import {
  MIN_INTERVAL_MS,
  DEFAULT_SEND_INTERVAL_MS,
  DEFAULT_REPLY_INTERVAL_MS,
  DEFAULT_WINDOW_SAFETY_HOURS,
  DEFAULT_GRAPH_VERSION,
} from "../recovery.mjs";

/** Más seguido que esto es castigar la API de Meta para nada: el webhook es el camino instantáneo. */
export const MIN_POLL_INTERVAL_MS = 10_000;
export const DEFAULT_POLL_INTERVAL_MS = 20_000;

export class LiveConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "LiveConfigError";
  }
}

const read = (env, key) => String(env[key] ?? "").trim();

function positiveMs(env, key, fallback, floor, why) {
  const raw = read(env, key);
  if (raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new LiveConfigError(`${key} tiene que ser un número de milisegundos.`);
  if (n < floor) throw new LiveConfigError(`${key}=${n} está por debajo del mínimo de ${floor} ms. ${why}`);
  return Math.round(n);
}

export function loadLiveConfig(env = process.env) {
  // En local alcanza con el token de la recuperación: es el mismo System User.
  const token = read(env, "META_SYSTEM_USER_TOKEN") || read(env, "META_TOKEN_MARKETING_INTEGRATION");
  const appSecretRaw = read(env, "META_APP_SECRET");
  // "unset" es el valor con el que nace el secreto en Secret Manager: el
  // webhook queda apagado hasta que el dueño de la cuenta pegue el real.
  const appSecret = appSecretRaw === "unset" ? "" : appSecretRaw;
  const verifyToken = read(env, "META_WEBHOOK_VERIFY_TOKEN");
  const enabledRaw = read(env, "LIVE_ENABLED");

  const windowSafetyRaw = read(env, "LIVE_WINDOW_SAFETY_HOURS");
  const windowSafetyHours = windowSafetyRaw === "" ? DEFAULT_WINDOW_SAFETY_HOURS : Number(windowSafetyRaw);
  if (!Number.isFinite(windowSafetyHours) || windowSafetyHours < 0) {
    throw new LiveConfigError("LIVE_WINDOW_SAFETY_HOURS tiene que ser un número de horas ≥ 0.");
  }

  return Object.freeze({
    token,
    tokenConfigured: token !== "",
    appSecret,
    webhookConfigured: appSecret !== "",
    verifyToken,
    // Sin token no hay modo en vivo posible, diga lo que diga LIVE_ENABLED.
    enabled: token !== "" && enabledRaw !== "false",
    pollIntervalMs: positiveMs(
      env,
      "LIVE_POLL_INTERVAL_MS",
      DEFAULT_POLL_INTERVAL_MS,
      MIN_POLL_INTERVAL_MS,
      "Sondear más seguido no sirve: para instantáneo está el webhook.",
    ),
    sendIntervalMs: positiveMs(
      env,
      "LIVE_SEND_INTERVAL_MS",
      DEFAULT_SEND_INTERVAL_MS,
      MIN_INTERVAL_MS,
      "Son más de 200 DMs por hora, el tope de Meta (#613).",
    ),
    replyIntervalMs: positiveMs(
      env,
      "LIVE_REPLY_INTERVAL_MS",
      DEFAULT_REPLY_INTERVAL_MS,
      MIN_INTERVAL_MS,
      "Son respuestas del owner en ráfaga en un mismo hilo: el filtro de spam de Meta castiga eso con un límite sobre la cuenta.",
    ),
    windowSafetyHours,
    graphVersion: read(env, "GRAPH_VERSION") || DEFAULT_GRAPH_VERSION,
  });
}
