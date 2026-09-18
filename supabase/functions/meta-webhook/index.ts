// meta-webhook: el camino instantaneo (el mismo que usa ManyChat).
//
// Dos reglas que no son opcionales:
//   1. La firma se calcula sobre el cuerpo CRUDO, byte por byte. Parsear y
//      volver a serializar cambia el JSON y la firma nunca daria.
//   2. Meta espera un 200 en menos de ~5 s y reintenta si no lo ve. Por eso se
//      responde PRIMERO y se procesa despues (EdgeRuntime.waitUntil).
//
// Sin META_APP_SECRET esto contesta 503 a proposito: aceptar eventos sin
// verificar la firma seria dejar que cualquiera nos dispare DMs.
//
// Multi-tenant: el evento trae el media id; la automatizacion activa de ESE
// reel (sea de quien sea) recibe el comentario y se envia con el token de su
// dueño. Solo llegan eventos de paginas suscritas a NUESTRA app de Meta; el
// resto de los tenants lo cubre el sondeo.
import { serve, json } from "../_shared/http.mjs";
import { admin, must, env } from "../_shared/db.mjs";
import { parseWebhookPayload, verifySignature } from "../_shared/rules.mjs";
import { ingest } from "../_shared/engine.mjs";

const appSecret = () => {
  const s = env("META_APP_SECRET");
  return s === "unset" ? "" : s;
};

async function dispatch(body) {
  const db = admin();
  for (const item of parseWebhookPayload(body)) {
    let q = db.from("triggers").select("*").eq("status", "active");
    q = item.mediaId ? q.eq("resolved->>mediaId", item.mediaId) : q.eq("resolved->>igUserId", item.igUserId);
    const triggers = must(await q);
    let accepted = 0;
    for (const trigger of triggers) {
      const { queued } = await ingest(db, trigger, [item.comment], "webhook");
      accepted += queued;
    }
    must(await db.rpc("touch_webhook", { p_accepted: accepted, p_ignored: triggers.length === 0 ? 1 : 0 }));
  }
}

Deno.serve(serve(async (req) => {
  const url = new URL(req.url);

  // GET: el handshake de verificacion (Meta lo hace una sola vez).
  if (req.method === "GET") {
    const verifyToken = env("META_WEBHOOK_VERIFY_TOKEN");
    const ok = verifyToken && url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === verifyToken;
    return new Response(ok ? url.searchParams.get("hub.challenge") ?? "" : "Forbidden", { status: ok ? 200 : 403, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  if (req.method !== "POST") return json(405, { error: "Método no permitido." });

  const secret = appSecret();
  if (!secret) return json(503, { error: "webhook no configurado", code: "webhook_not_configured" });

  const raw = new Uint8Array(await req.arrayBuffer());
  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"), secret)) {
    return json(401, { error: "firma inválida", code: "bad_signature" });
  }

  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return json(400, { error: "JSON inválido", code: "bad_request" });
  }

  const work = dispatch(body).catch((err) => console.error("[meta-webhook]", err?.stack ?? err));
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(work);
  else await work;
  return json(200, { ok: true });
}));
