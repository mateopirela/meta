/**
 * Store generico de blobs de texto: clave -> texto. Dos backends, la misma API.
 *
 *   - bucket vacio -> disco local, <localDir>/<name> (desarrollo).
 *   - bucket=xxx   -> Google Cloud Storage, gs://xxx/<prefix><name>
 *                     (produccion en Cloud Run, donde el disco es efimero: un
 *                     redeploy borraria el registro de a quien ya se le mando
 *                     el DM, y ese registro es la idempotencia).
 *
 * Salio de jobs.mjs, que era lo mismo pero solo para jobs. Ahora lo comparten
 * los jobs (`jobs/<id>.json`) y el modo en vivo (`live/triggers/<id>.json`,
 * `live/ledger/<id>.json`): el `name` YA trae la carpeta adentro.
 *
 * GCS se habla por su API REST con fetch: sin SDK. El access token sale del
 * metadata server de Cloud Run (la identidad del servicio) o, para probar desde
 * una laptop, de GCS_ACCESS_TOKEN (`gcloud auth print-access-token`).
 *
 * El TOKEN DE META NUNCA pasa por aca.
 */
import { mkdir, readdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Backend: disco local ─────────────────────────────────────────────────────
function localStore(localDir) {
  const root = localDir instanceof URL ? fileURLToPath(localDir) : String(localDir);
  const filePath = (name) => `${root}/${name}`;

  return {
    description: `disco local (${root})`,

    async write(name, text) {
      const path = filePath(name);
      await mkdir(dirname(path), { recursive: true });
      // Atomico: temporal + rename. Un corte a mitad de escritura no deja el
      // archivo vacio ni a medias.
      await writeFile(`${path}.tmp`, text, "utf8");
      await rename(`${path}.tmp`, path);
    },

    async read(name) {
      try {
        return await readFile(filePath(name), "utf8");
      } catch (err) {
        if (err.code === "ENOENT") return null;
        throw err;
      }
    },

    async list(prefix = "") {
      let entries;
      try {
        entries = await readdir(`${root}/${prefix}`, { recursive: true });
      } catch (err) {
        if (err.code === "ENOENT") return [];
        throw err;
      }
      return entries
        // readdir recursivo devuelve separadores del sistema: en Windows son
        // "\", y las claves del store SIEMPRE son con "/".
        .map((entry) => `${prefix}${entry.split("\\").join("/")}`)
        .filter((name) => name.endsWith(".json"));
    },

    async remove(name) {
      await unlink(filePath(name)).catch((err) => {
        if (err.code !== "ENOENT") throw err;
      });
    },
  };
}

// ── Backend: Google Cloud Storage (REST) ─────────────────────────────────────
function gcsStore(bucket, prefix) {
  const API = "https://storage.googleapis.com";
  const object = (name) => `${prefix}${name}`;
  let tokenCache = { token: null, expiresAt: 0 };

  async function accessToken() {
    if (process.env.GCS_ACCESS_TOKEN) return process.env.GCS_ACCESS_TOKEN;
    if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
    const res = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" } },
    );
    if (!res.ok) throw new Error(`No pude obtener credenciales del metadata server (HTTP ${res.status})`);
    const body = await res.json();
    tokenCache = { token: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
    return tokenCache.token;
  }

  /** fetch con auth y reintento ante 429/5xx/red: GCS los devuelve de vez en cuando. */
  async function call(url, init = {}, attempt = 1) {
    let res;
    try {
      res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${await accessToken()}` } });
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 500 * attempt));
      return call(url, init, attempt + 1);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
      return call(url, init, attempt + 1);
    }
    return res;
  }

  return {
    description: `gs://${bucket}/${prefix}`,

    async write(name, text) {
      const url = `${API}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(object(name))}`;
      const res = await call(url, { method: "POST", headers: { "content-type": "application/json" }, body: text });
      if (!res.ok) throw new Error(`GCS no guardó ${name}: HTTP ${res.status} ${await res.text()}`);
    },

    async read(name) {
      const res = await call(`${API}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object(name))}?alt=media`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GCS no devolvió ${name}: HTTP ${res.status}`);
      return res.text();
    },

    async list(namePrefix = "") {
      const out = [];
      let pageToken;
      do {
        const url = new URL(`${API}/storage/v1/b/${encodeURIComponent(bucket)}/o`);
        url.searchParams.set("prefix", `${prefix}${namePrefix}`);
        url.searchParams.set("fields", "items(name),nextPageToken");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const res = await call(url);
        if (!res.ok) throw new Error(`GCS no listó ${namePrefix}: HTTP ${res.status} ${await res.text()}`);
        const body = await res.json();
        for (const item of body.items ?? []) {
          if (item.name.endsWith(".json")) out.push(item.name.slice(prefix.length));
        }
        pageToken = body.nextPageToken;
      } while (pageToken);
      return out;
    },

    async remove(name) {
      const res = await call(`${API}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object(name))}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(`GCS no borró ${name}: HTTP ${res.status}`);
    },
  };
}

/**
 * @param {{bucket?: string, prefix?: string, localDir: string|URL}} options
 *   `prefix` solo aplica al backend de GCS (raiz del bucket); en local la raiz
 *   es `localDir`. En los dos casos el `name` completo lleva su carpeta.
 */
export function createStore({ bucket = "", prefix = "", localDir }) {
  const store = bucket ? gcsStore(bucket, prefix) : localStore(localDir);

  // Una cola de escritura por clave: el drenador guarda tras cada fila y el
  // handler de "pausar" tambien; dos escrituras concurrentes de la misma clave
  // se pisarian.
  const queues = new Map();

  return {
    ...store,
    /** write() serializado por clave. Devuelve la promesa de ESTA escritura. */
    queuedWrite(name, text) {
      const prev = queues.get(name) ?? Promise.resolve();
      const next = prev.catch(() => {}).then(() => store.write(name, text));
      queues.set(name, next);
      return next;
    },
  };
}
