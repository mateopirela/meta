import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  STATUS,
  normalize,
  matchesKeyword,
  isProcessed,
  windowStatus,
  classifyComment,
  classifyAll,
  summarize,
} from "../src/classify.mjs";

const NOW = new Date("2026-07-15T12:00:00Z");
const OWNER = "creadora";
const PHRASES = ["te acabo de enviar", "revisa tu dm"];

const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const comment = (over = {}) => ({
  id: "c1",
  username: "seguidor1",
  text: "guia",
  timestamp: hoursAgo(1),
  replies: { data: [] },
  ...over,
});

const options = (over = {}) => ({
  keyword: "guia",
  ownerUsername: OWNER,
  phrases: PHRASES,
  now: NOW,
  safetyHours: 2,
  ...over,
});

describe("normalize", () => {
  test("baja a minusculas y saca acentos", () => {
    assert.equal(normalize("SÍ Quiero"), "si quiero");
  });

  test("trata null/undefined como string vacio", () => {
    assert.equal(normalize(null), "");
    assert.equal(normalize(undefined), "");
  });
});

describe("matchesKeyword", () => {
  test("matchea sin importar mayusculas", () => {
    assert.equal(matchesKeyword("Quiero GUIA porfa", "guia"), true);
  });

  test("matchea por contenido, como ManyChat", () => {
    assert.equal(matchesKeyword("guiaxx", "guia"), true);
  });

  test("no matchea cuando el keyword no esta", () => {
    assert.equal(matchesKeyword("que buen video", "guia"), false);
  });

  test("matchea keyword acentuado contra texto sin acento", () => {
    assert.equal(matchesKeyword("quiero informacion", "información"), true);
  });
});

describe("isProcessed", () => {
  test("sin respuestas => no procesado", () => {
    assert.equal(isProcessed(comment(), OWNER, PHRASES), false);
  });

  test("respuesta del owner con frase de la automatizacion => procesado", () => {
    const c = comment({
      replies: { data: [{ username: "creadora", text: "Te acabo de enviar el link!" }] },
    });
    assert.equal(isProcessed(c, OWNER, PHRASES), true);
  });

  test("respuesta de OTRO usuario con la frase => NO procesado", () => {
    const c = comment({
      replies: { data: [{ username: "randokid", text: "te acabo de enviar" }] },
    });
    assert.equal(isProcessed(c, OWNER, PHRASES), false);
  });

  test("respuesta del owner que NO es la automatizacion => no procesado", () => {
    const c = comment({ replies: { data: [{ username: "creadora", text: "gracias!" }] } });
    assert.equal(isProcessed(c, OWNER, PHRASES), false);
  });

  test("sin frases configuradas, cualquier respuesta del owner cuenta (conservador)", () => {
    const c = comment({ replies: { data: [{ username: "creadora", text: "gracias!" }] } });
    assert.equal(isProcessed(c, OWNER, []), true);
  });

  test("acepta replies como array plano ademas de {data}", () => {
    const c = comment({ replies: [{ username: "creadora", text: "revisa tu dm" }] });
    assert.equal(isProcessed(c, OWNER, PHRASES), true);
  });
});

describe("windowStatus", () => {
  test("comentario reciente: vivo, ~7 dias por delante", () => {
    const w = windowStatus(hoursAgo(1), NOW, 0);
    assert.equal(w.expired, false);
    assert.ok(Math.abs(w.hoursLeft - 167) < 0.01);
  });

  test("comentario de mas de 7 dias: expirado", () => {
    assert.equal(windowStatus(hoursAgo(24 * 7 + 1), NOW, 0).expired, true);
  });

  test("el margen de seguridad expira los que estan por vencer", () => {
    const almost = hoursAgo(24 * 7 - 1); // le queda 1 hora
    assert.equal(windowStatus(almost, NOW, 0).expired, false);
    assert.equal(windowStatus(almost, NOW, 2).expired, true);
  });
});

describe("classifyComment", () => {
  test("keyword + sin respuesta + en ventana => enviable", () => {
    const row = classifyComment(comment(), options());
    assert.equal(row.status, STATUS.SENDABLE);
    assert.equal(row.comment_id, "c1");
  });

  test("sin keyword => se descarta antes que nada", () => {
    const row = classifyComment(comment({ text: "que crack" }), options());
    assert.equal(row.status, STATUS.SKIP_NO_KEYWORD);
  });

  test("ya respondido por la automatizacion => no se reenvia", () => {
    const c = comment({ replies: { data: [{ username: "creadora", text: "revisa tu DM" }] } });
    assert.equal(classifyComment(c, options()).status, STATUS.SKIP_ALREADY_PROCESSED);
  });

  test("fuera de la ventana de 7 dias => no enviable", () => {
    const c = comment({ timestamp: hoursAgo(24 * 8) });
    assert.equal(classifyComment(c, options()).status, STATUS.SKIP_EXPIRED);
  });

  test("expone expires_at para auditar el corte", () => {
    const row = classifyComment(comment({ timestamp: "2026-07-15T00:00:00.000Z" }), options());
    assert.equal(row.expires_at, "2026-07-22T00:00:00.000Z");
  });
});

describe("classifyAll", () => {
  test("ordena los enviables por el mas viejo primero (menos ventana le queda)", () => {
    const comments = [
      comment({ id: "nuevo", timestamp: hoursAgo(1) }),
      comment({ id: "viejo", timestamp: hoursAgo(100) }),
      comment({ id: "medio", timestamp: hoursAgo(50) }),
    ];
    const { sendable } = classifyAll(comments, options());
    assert.deepEqual(
      sendable.map((r) => r.comment_id),
      ["viejo", "medio", "nuevo"],
    );
  });

  test("separa enviables de descartados", () => {
    const comments = [
      comment({ id: "a" }),
      comment({ id: "b", text: "sin keyword" }),
      comment({ id: "c", timestamp: hoursAgo(24 * 9) }),
    ];
    const { rows, sendable } = classifyAll(comments, options());
    assert.equal(rows.length, 3);
    assert.equal(sendable.length, 1);
    assert.equal(sendable[0].comment_id, "a");
  });
});

describe("summarize", () => {
  test("cuenta por estado e incluye los que dieron cero", () => {
    const comments = [comment({ id: "a" }), comment({ id: "b", text: "nada" })];
    const { rows } = classifyAll(comments, options());
    const counts = summarize(rows);
    assert.equal(counts[STATUS.SENDABLE], 1);
    assert.equal(counts[STATUS.SKIP_NO_KEYWORD], 1);
    assert.equal(counts[STATUS.SKIP_EXPIRED], 0);
  });
});
