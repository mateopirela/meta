// worker-poll: lo dispara pg_cron cada 20 s. Prepara las automatizaciones
// nuevas, analiza los jobs nuevos y sondea las automatizaciones activas de
// TODOS los tenants, cada una con el token de su dueño.
//
// Responde en el acto y trabaja en background (EdgeRuntime.waitUntil): pg_net
// no espera mas de 5 s y un tick puede tardar bastante mas. Los pasos son
// idempotentes y los reclamos (`claimed_at`, dedupe por clave primaria) hacen
// inofensivo que dos ticks se solapen.
import { serve, json, requireWorker } from "../_shared/http.mjs";
import { admin, must, env, nowIso } from "../_shared/db.mjs";
import { prepareTrigger, analyzeJob, pollTrigger } from "../_shared/engine.mjs";

const POLL_INTERVAL_MS = Math.max(Number(env("LIVE_POLL_INTERVAL_MS", "20000")) || 20000, 10000);
/** Cuantas automatizaciones se sondean a la vez. */
const CONCURRENCY = 5;
/** Un reclamo mas viejo que esto es de un tick que murio: se vuelve a tomar. */
const STALE_CLAIM_MS = 10 * 60_000;

async function inChunks(items, n, fn) {
  for (let i = 0; i < items.length; i += n) {
    await Promise.allSettled(items.slice(i, i + n).map(fn));
  }
}

async function tick() {
  const db = admin();
  const stale = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
  const now = nowIso();

  // 1. Automatizaciones recien creadas (o reactivadas sin reel resuelto).
  const preparing = must(await db.from("triggers")
    .update({ claimed_at: now })
    .eq("status", "preparing")
    .or(`claimed_at.is.null,claimed_at.lt.${stale}`)
    .select("*"));
  await inChunks(preparing, 2, (t) => prepareTrigger(db, t, { pollIntervalMs: POLL_INTERVAL_MS }));

  // 2. Recuperaciones recien creadas.
  const analyzing = must(await db.from("jobs")
    .update({ claimed_at: now })
    .eq("status", "analyzing")
    .or(`claimed_at.is.null,claimed_at.lt.${stale}`)
    .select("*"));
  await inChunks(analyzing, 2, (j) => analyzeJob(db, j));

  // 3. Sondeo de las activas. Las que un tick acaba de mirar (o que Meta pidio
  //    frenar) se saltean; el dedupe hace inofensivo cualquier solapamiento.
  const active = must(await db.from("triggers").select("*").eq("status", "active").not("resolved", "is", null));
  const due = active.filter((t) => {
    const c = t.cursor ?? {};
    if (c.backoffUntil && Date.parse(c.backoffUntil) > Date.now()) return false;
    if (c.lastPollAt && Date.now() - Date.parse(c.lastPollAt) < POLL_INTERVAL_MS * 0.5) return false;
    return true;
  });
  await inChunks(due, CONCURRENCY, (t) => pollTrigger(db, t));

  console.log(`[worker-poll] preparadas ${preparing.length} · analizados ${analyzing.length} · sondeadas ${due.length}/${active.length}`);
}

Deno.serve(serve(async (req) => {
  requireWorker(req);
  const work = tick().catch((err) => console.error("[worker-poll] tick falló:", err?.stack ?? err));
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(work);
  else await work;
  return json(202, { ok: true });
}));
