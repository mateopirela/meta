import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseShortcode, buildPlan } from "../src/recovery.mjs";

describe("parseShortcode", () => {
  test("acepta las formas de URL que pega la gente", () => {
    assert.equal(parseShortcode("https://www.instagram.com/reel/DbqpQCZFDNC/"), "DbqpQCZFDNC");
    assert.equal(parseShortcode("https://www.instagram.com/reel/DbqpQCZFDNC/?igsh=abc"), "DbqpQCZFDNC");
    assert.equal(parseShortcode("https://www.instagram.com/p/Db1FjyejyMK"), "Db1FjyejyMK");
    assert.equal(parseShortcode("https://instagram.com/creadora.x/reel/DbrHiR-D6vM/"), "DbrHiR-D6vM");
    assert.equal(parseShortcode("  Dbyno76Ev_6  "), "Dbyno76Ev_6");
  });

  test("rechaza lo que no es un reel", () => {
    assert.equal(parseShortcode(""), null);
    assert.equal(parseShortcode("https://www.instagram.com/creadora.x/"), null);
    assert.equal(parseShortcode("hola que tal"), null);
  });
});

describe("buildPlan", () => {
  test("solo deja a quien comento la keyword sin respuesta del owner y dentro de la ventana", () => {
    const now = new Date("2026-08-27T12:00:00Z");
    const ts = (hoursAgo) => new Date(now.getTime() - hoursAgo * 3_600_000).toISOString();
    const comments = [
      { id: "1", username: "ana", text: "IA por favor", timestamp: ts(10), replies: { data: [] } },
      { id: "2", username: "beto", text: "ia", timestamp: ts(20), replies: { data: [{ username: "owner", text: "Te envié un mensaje, comprueba tus DMs" }] } },
      { id: "3", username: "caro", text: "muy bueno el video", timestamp: ts(5), replies: { data: [] } },
      { id: "4", username: "dani", text: "IA", timestamp: ts(7 * 24 + 1), replies: { data: [] } },
    ];
    const plan = buildPlan({ comments, keyword: "ia", ownerUsername: "owner", phrases: ["te envie un mensaje"], now });

    assert.equal(plan.total, 4);
    assert.deepEqual(plan.rows.map((r) => r.username), ["ana"]);
    assert.equal(plan.counts.skip_already_processed, 1);
    assert.equal(plan.counts.skip_no_keyword, 1);
    assert.equal(plan.counts.skip_expired, 1);
    assert.equal(plan.rows[0].dm_status, "");
    assert.equal(plan.rows[0].reply_status, "");
  });
});
