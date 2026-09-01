import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/blobstore.mjs";
import { loadLedger, saveLedger, deleteLedger, upsertIfAbsent, nextDm, nextReply } from "../src/live/ledger.mjs";
import { newTrigger, saveTrigger, loadTriggers, deleteTrigger, pushTriggerLog } from "../src/live/triggers.mjs";

const dir = await mkdtemp(join(tmpdir(), "live-test-"));
const store = createStore({ localDir: dir });

after(() => rm(dir, { recursive: true, force: true }));

const NOW = new Date("2026-08-28T12:00:00Z");
const ago = (hours) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

const row = (id, overrides = {}) => ({
  comment_id: id,
  username: `u${id}`,
  comment_ts: ago(1),
  dm_status: "pending",
  attempts: 0,
  reply_status: "pending",
  ...overrides,
});

const trig = (id, overrides = {}) => ({
  id,
  input: { shortcode: `SC${id}`, keywords: ["humano"], replyTexts: ["listo"] },
  ...overrides,
});

describe("triggers en el store", () => {
  test("roundtrip: se guarda en live/triggers/<id>.json y vuelve igual", async () => {
    const trigger = newTrigger({ input: { shortcode: "DcjNz6SlAkr", keywords: ["humano"], replyTexts: [] }, createdBy: "mateo@30x.com" });
    pushTriggerLog(trigger, "Preparando…");
    await saveTrigger(store, trigger);

    const onDisk = JSON.parse(await readFile(join(dir, "live", "triggers", `${trigger.id}.json`), "utf8"));
    assert.equal(onDisk.id, trigger.id);
    assert.equal(onDisk.status, "preparing");
    assert.equal(onDisk.log[0].m, "Preparando…");

    const [loaded] = await loadTriggers(store);
    assert.deepEqual(loaded, trigger);

    await deleteTrigger(store, trigger.id);
    assert.deepEqual(await loadTriggers(store), []);
  });
});

describe("ledger en el store", () => {
  test("un ledger que no existe es uno vacío, no un error", async () => {
    assert.deepEqual(await loadLedger(store, "no-existe"), { rows: {} });
  });

  test("roundtrip de las filas", async () => {
    const ledger = { rows: {} };
    upsertIfAbsent(ledger, row("c1"));
    await saveLedger(store, "t1", ledger);

    const loaded = await loadLedger(store, "t1");
    assert.deepEqual(loaded, ledger);
    await deleteLedger(store, "t1");
  });
});

describe("upsertIfAbsent", () => {
  test("el mismo comment_id no entra dos veces (webhook + sondeo)", () => {
    const ledger = { rows: {} };
    assert.equal(upsertIfAbsent(ledger, row("c1", { source: "webhook" })), true);
    assert.equal(upsertIfAbsent(ledger, row("c1", { source: "poll" })), false);
    assert.equal(Object.keys(ledger.rows).length, 1);
    assert.equal(ledger.rows.c1.source, "webhook", "la fila original no se pisa");
  });
});

describe("nextDm", () => {
  test("el comentario más viejo primero, cruzando automatizaciones", () => {
    const a = { trigger: trig("t1"), ledger: { rows: { c1: row("c1", { comment_ts: ago(2) }) } } };
    const b = { trigger: trig("t2"), ledger: { rows: { c2: row("c2", { comment_ts: ago(9) }) } } };
    const next = nextDm([a, b]);
    assert.equal(next.row.comment_id, "c2");
    assert.equal(next.trigger.id, "t2");
  });

  test("los errores reintentables salen DESPUÉS de las pendientes", () => {
    const entries = [
      {
        trigger: trig("t1"),
        ledger: {
          rows: {
            err: row("err", { dm_status: "error", attempts: 1, comment_ts: ago(50) }),
            pend: row("pend", { comment_ts: ago(1) }),
          },
        },
      },
    ];
    assert.equal(nextDm(entries).row.comment_id, "pend");
  });

  test("un error con 3 intentos ya no vuelve, y lo terminal tampoco", () => {
    const entries = [
      {
        trigger: trig("t1"),
        ledger: {
          rows: {
            quemado: row("quemado", { dm_status: "error", attempts: 3 }),
            enviado: row("enviado", { dm_status: "sent" }),
            vencido: row("vencido", { dm_status: "expired_mid_run" }),
          },
        },
      },
    ];
    assert.equal(nextDm(entries), null);
  });
});

describe("nextReply", () => {
  test("solo filas con el DM enviado y la respuesta pendiente", () => {
    const entries = [
      {
        trigger: trig("t1"),
        ledger: {
          rows: {
            sinDm: row("sinDm"),
            conDm: row("conDm", { dm_status: "sent", comment_ts: ago(3) }),
            yaRespondido: row("yaRespondido", { dm_status: "sent", reply_status: "replied", comment_ts: ago(9) }),
          },
        },
      },
    ];
    assert.equal(nextReply(entries).row.comment_id, "conDm");
  });

  test("una automatización sin respuestas públicas no aporta nada", () => {
    const entries = [
      {
        trigger: trig("t1", { input: { shortcode: "x", keywords: ["humano"], replyTexts: [] } }),
        ledger: { rows: { c1: row("c1", { dm_status: "sent" }) } },
      },
    ];
    assert.equal(nextReply(entries), null);
  });
});
