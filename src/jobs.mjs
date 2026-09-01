/**
 * Persistencia de los jobs de la interfaz web: un JSON por job.
 *
 * El backend (disco local o GCS) vive en blobstore.mjs y lo comparte el modo
 * en vivo (live/triggers/<id>.json, live/ledger/<id>.json). Aca solo quedan
 * las claves de los jobs y lo que sabe de su forma.
 *
 * Las claves NO cambiaron con esa mudanza — los jobs que ya estan en el bucket
 * tienen que seguir cargando:
 *   - GCS:   gs://$JOBS_BUCKET/<JOBS_PREFIX><id>.json   (JOBS_PREFIX = "jobs/")
 *   - local: data/jobs/<id>.json
 * Por eso JOBS_PREFIX es el prefijo DE LOS JOBS, no del store entero.
 *
 * El TOKEN DE META NUNCA pasa por aca. Vive en memoria del servidor
 * (web/server.mjs) mientras el job corre.
 */
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createStore } from "./blobstore.mjs";

export const isValidJobId = (id) => /^[a-z0-9-]{6,40}$/.test(id);

export function newJobId() {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `${day}-${randomBytes(3).toString("hex")}`;
}

const BUCKET = (process.env.JOBS_BUCKET ?? "").trim();
const PREFIX = (process.env.JOBS_PREFIX ?? "jobs/").replace(/^\/+/, "");
const DATA_DIR = new URL("../data/", import.meta.url);

/** El store compartido: jobs y modo en vivo escriben en el mismo lugar. */
export const store = createStore({ bucket: BUCKET, localDir: DATA_DIR });

const jobName = (id) => `${PREFIX}${id}.json`;

/** Para el log de arranque: donde viven los jobs. */
export const storageDescription = () =>
  BUCKET ? `gs://${BUCKET}/${PREFIX}` : `disco local (${fileURLToPath(DATA_DIR)}${PREFIX})`;

export function saveJob(job) {
  return store.queuedWrite(jobName(job.id), JSON.stringify(job, null, 2));
}

export async function loadJobs() {
  const jobs = [];
  for (const name of await store.list(PREFIX)) {
    const text = await store.read(name);
    if (text === null) continue;
    try {
      jobs.push(JSON.parse(text));
    } catch (err) {
      console.warn(`[jobs] no pude leer ${name}: ${err.message}`);
    }
  }
  return jobs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function deleteJob(id) {
  await store.remove(jobName(id));
}

/** Lo justo para la lista de recuperaciones anteriores. */
export function summaryOf(job) {
  return {
    id: job.id,
    createdAt: job.createdAt,
    createdBy: job.createdBy ?? null,
    status: job.status,
    shortcode: job.input.shortcode,
    keyword: job.input.keyword,
    igUsername: job.resolved?.igUsername ?? null,
    sendable: job.rows?.length ?? 0,
    progress: job.progress ?? null,
  };
}
