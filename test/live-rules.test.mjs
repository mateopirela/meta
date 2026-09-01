import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  evaluateComment,
  parseWebhookPayload,
  verifySignature,
  shouldStopPaging,
  advanceCursor,
  validateTriggerInput,
  validateTriggerPatch,
  tallyRows,
  TriggerInputError,
} from "../src/live/rules.mjs";

const NOW = new Date("2026-08-28T12:00:00Z");
const ago = (hours) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

const trigger = (overrides = {}) => ({
  resolved: { igUserId: "17841480692373523", igUsername: "cinthyasanchezai", mediaId: "media-1" },
  input: {
    keywords: ["humano"],
    includeReplies: false,
    replyTexts: ["¡Listo! Te envié un mensaje 📩"],
    windowSafetyHours: 2,
    ...overrides,
  },
});

const comment = (overrides = {}) => ({
  id: "c1",
  text: "HUMANO por favor",
  username: "ana",
  from: { id: "999", username: "ana" },
  timestamp: ago(1),
  ...overrides,
});

describe("evaluateComment", () => {
  test("acepta el comentario con la keyword y arma la fila", () => {
    const r = evaluateComment(comment(), trigger(), NOW, "webhook");
    assert.equal(r.accept, true);
    assert.equal(r.row.comment_id, "c1");
    assert.equal(r.row.username, "ana");
    assert.equal(r.row.from_id, "999");
    assert.equal(r.row.source, "webhook");
    assert.equal(r.row.dm_status, "pending");
    assert.equal(r.row.reply_status, "pending");
    assert.equal(r.row.attempts, 0);
  });

  test("sin respuestas públicas configuradas, la fila nace con reply_status skipped", () => {
    const r = evaluateComment(comment(), trigger({ replyTexts: [] }), NOW);
    assert.equal(r.row.reply_status, "skipped");
  });

  test("matchea sin importar mayúsculas ni tildes, igual que ManyChat", () => {
    const r = evaluateComment(comment({ text: "quiero ser HUMÁNO!!" }), trigger(), NOW);
    assert.equal(r.accept, true);
  });

  test("descarta al owner por id (nuestra propia respuesta pública vuelve por el webhook)", () => {
    const own = comment({ from: { id: "17841480692373523", username: "cinthyasanchezai" }, username: "cinthyasanchezai" });
    assert.deepEqual(evaluateComment(own, trigger(), NOW), { accept: false, reason: "skip_owner" });
  });

  test("descarta al owner por username aunque no venga `from`", () => {
    const own = comment({ from: null, username: "CinthyaSanchezAI" });
    assert.deepEqual(evaluateComment(own, trigger(), NOW), { accept: false, reason: "skip_owner" });
  });

  test("descarta las respuestas a otros comentarios salvo que se pidan", () => {
    const reply = comment({ parent_id: "c0" });
    assert.deepEqual(evaluateComment(reply, trigger(), NOW), { accept: false, reason: "skip_reply" });
    assert.equal(evaluateComment(reply, trigger({ includeReplies: true }), NOW).accept, true);
  });

  test("descarta el que no trae la keyword", () => {
    assert.deepEqual(evaluateComment(comment({ text: "qué buen video" }), trigger(), NOW), {
      accept: false,
      reason: "skip_no_keyword",
    });
  });

  test("descarta el que se pasó de la ventana de 7 días", () => {
    assert.deepEqual(evaluateComment(comment({ timestamp: ago(7 * 24 + 1) }), trigger(), NOW), {
      accept: false,
      reason: "skip_expired",
    });
  });

  test("varias keywords: alcanza con que matchee una", () => {
    const t = trigger({ keywords: ["humano", "quiero"] });
    assert.equal(evaluateComment(comment({ text: "QUIERO" }), t, NOW).accept, true);
  });
});

describe("parseWebhookPayload", () => {
  const payload = {
    object: "instagram",
    entry: [
      {
        id: "17841480692373523",
        time: 1_787_918_400,
        changes: [
          {
            field: "comments",
            value: { id: "c9", text: "humano", from: { id: "42", username: "ana" }, media: { id: "media-1" } },
          },
        ],
      },
    ],
  };

  test("aplana un evento de comentario", () => {
    const [item] = parseWebhookPayload(payload);
    assert.equal(item.igUserId, "17841480692373523");
    assert.equal(item.mediaId, "media-1");
    assert.equal(item.comment.id, "c9");
    assert.equal(item.comment.username, "ana");
    // Sin timestamp propio, el del evento.
    assert.equal(item.comment.timestamp, new Date(1_787_918_400 * 1000).toISOString());
  });

  test("ignora otros objetos y otros campos", () => {
    assert.deepEqual(parseWebhookPayload({ ...payload, object: "page" }), []);
    const otherField = { ...payload, entry: [{ ...payload.entry[0], changes: [{ field: "mentions", value: { id: "x" } }] }] };
    assert.deepEqual(parseWebhookPayload(otherField), []);
  });

  test("nunca tira con basura", () => {
    for (const garbage of [null, undefined, {}, [], "hola", { object: "instagram" }, { object: "instagram", entry: [null] }]) {
      assert.deepEqual(parseWebhookPayload(garbage), []);
    }
  });
});

describe("verifySignature", () => {
  const secret = "s3cr3t";
  const raw = Buffer.from(JSON.stringify({ object: "instagram" }));
  const good = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

  test("acepta la firma correcta", () => assert.equal(verifySignature(raw, good, secret), true));
  test("rechaza otra firma del mismo largo", () =>
    assert.equal(verifySignature(raw, `sha256=${"a".repeat(64)}`, secret), false));
  test("rechaza firma de largo distinto (timingSafeEqual tiraría)", () =>
    assert.equal(verifySignature(raw, "sha256=abcd", secret), false));
  test("rechaza header ausente o mal formado", () => {
    assert.equal(verifySignature(raw, "", secret), false);
    assert.equal(verifySignature(raw, good.replace("sha256=", "sha1="), secret), false);
  });
  test("sin app secret configurado, nada valida", () => {
    assert.equal(verifySignature(raw, good, ""), false);
    assert.equal(verifySignature(raw, good, "unset"), false);
  });
  test("otro cuerpo con la misma firma no pasa", () =>
    assert.equal(verifySignature(Buffer.from("{}"), good, secret), false));
});

describe("shouldStopPaging", () => {
  const cursor = { watermark: ago(2), seenIds: ["c1", "c2"] };
  const page = (ids) => ids.map((id) => ({ id, timestamp: ago(1) }));

  test("página vacía: cortar", () => assert.equal(shouldStopPaging([], cursor), true));
  test("todos nuevos: seguir", () => assert.equal(shouldStopPaging(page(["c8", "c9"]), cursor), false));
  test("mezcla: seguir", () => assert.equal(shouldStopPaging([...page(["c1"]), ...page(["c9"])], cursor), false));
  test("todos conocidos: cortar", () => assert.equal(shouldStopPaging(page(["c1", "c2"]), cursor), true));
  test("desconocidos pero más viejos que la marca: cortar", () =>
    assert.equal(shouldStopPaging([{ id: "viejo", timestamp: ago(48) }], cursor), true));
  test("sin cursor (primera vez) todo es nuevo", () =>
    assert.equal(shouldStopPaging(page(["c1"]), {}), false));
});

describe("advanceCursor", () => {
  test("avanza la marca al comentario más nuevo y suma los ids", () => {
    const next = advanceCursor({ watermark: ago(5), seenIds: ["c1"] }, [
      { id: "c2", timestamp: ago(3) },
      { id: "c3", timestamp: ago(1) },
    ]);
    assert.equal(next.watermark, new Date(ago(1)).toISOString());
    assert.deepEqual(next.seenIds, ["c2", "c3", "c1"]);
  });

  test("no retrocede la marca ni repite ids", () => {
    const next = advanceCursor({ watermark: ago(1), seenIds: ["c1"] }, [{ id: "c1", timestamp: ago(9) }]);
    assert.equal(next.watermark, ago(1));
    assert.deepEqual(next.seenIds, ["c1"]);
  });

  test("recorta a `keep` los ids más viejos (un reel viral no infla el JSON)", () => {
    const old = Array.from({ length: 3000 }, (_, i) => `old${i}`);
    const next = advanceCursor({ seenIds: old }, [{ id: "nuevo", timestamp: ago(1) }]);
    assert.equal(next.seenIds.length, 3000);
    assert.equal(next.seenIds[0], "nuevo");
    assert.equal(next.seenIds.includes("old2999"), false);
  });
});

describe("validateTriggerInput", () => {
  const body = {
    reelUrl: "https://www.instagram.com/reel/DcjNz6SlAkr/",
    keywords: "humano, HUMANO , quiero",
    card: { title: "Tu recurso", buttonTitle: "Verlo", buttonUrl: "https://example.com" },
    replyTexts: "¡Listo! Te envié un mensaje 📩\n\nRevisá tus DMs 🙌",
    processedPhrases: "te envie un mensaje",
    backfill: "window",
    includeReplies: true,
  };

  test("acepta el formulario completo y normaliza las listas", () => {
    const input = validateTriggerInput(body);
    assert.equal(input.shortcode, "DcjNz6SlAkr");
    assert.deepEqual(input.keywords, ["humano", "quiero"]); // dedupe sin importar mayúsculas
    assert.equal(input.replyTexts.length, 2);
    assert.deepEqual(input.processedPhrases, ["te envie un mensaje"]);
    assert.equal(input.backfill, "window");
    assert.equal(input.includeReplies, true);
    assert.equal(input.sendIntervalMs, 18_000);
    assert.equal(input.replyIntervalMs, 60_000);
  });

  test("por defecto: sin backfill, sin respuestas, sin replies", () => {
    const input = validateTriggerInput({ ...body, backfill: undefined, replyTexts: "", includeReplies: undefined });
    assert.equal(input.backfill, "none");
    assert.deepEqual(input.replyTexts, []);
    assert.equal(input.includeReplies, false);
  });

  const rejects = (patch, field) =>
    assert.throws(
      () => validateTriggerInput({ ...body, ...patch }),
      (err) => err instanceof TriggerInputError && err.field === field,
    );

  test("rechaza un enlace que no es de un reel", () => rejects({ reelUrl: "https://ejemplo.com/x" }, "reel"));
  test("rechaza sin palabras clave", () => rejects({ keywords: "  ,  " }, "keywords"));
  test("rechaza la tarjeta sin URL http(s)", () =>
    rejects({ card: { ...body.card, buttonUrl: "ftp://x" } }, "card.buttonUrl"));
  test("rechaza el título de tarjeta demasiado largo", () =>
    rejects({ card: { ...body.card, title: "x".repeat(81) } }, "card.title"));
  test("rechaza un ritmo por encima del tope de Meta", () => rejects({ sendIntervalMs: 5000 }, "sendIntervalMs"));
});

describe("validateTriggerPatch", () => {
  test("solo devuelve lo que vino", () => {
    const patch = validateTriggerPatch({ replyTexts: "una sola" });
    assert.deepEqual(patch, { replyTexts: ["una sola"] });
  });

  test("un patch vacío es un error (no un no-op silencioso)", () => {
    assert.throws(() => validateTriggerPatch({}), (err) => err instanceof TriggerInputError);
  });
});

describe("tallyRows", () => {
  test("cuenta pendientes, enviados, respondidos, errores y salteados", () => {
    const counts = tallyRows({
      a: { dm_status: "pending", reply_status: "pending" },
      b: { dm_status: "sent", reply_status: "replied" },
      c: { dm_status: "sent", reply_status: "pending" },
      d: { dm_status: "error", reply_status: "skipped" },
      e: { dm_status: "already_replied", reply_status: "skipped" },
    });
    assert.deepEqual(counts, { pending: 1, sent: 2, replied: 1, errors: 1, skipped: 1 });
  });
});
