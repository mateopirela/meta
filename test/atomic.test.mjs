import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeCsvAtomic, fromCsv } from "../src/csv.mjs";

const COLUMNS = ["comment_id", "sent_at"];
const dir = await mkdtemp(join(tmpdir(), "recovery-test-"));

after(() => rm(dir, { recursive: true, force: true }));

const exists = async (p) => access(p).then(() => true).catch(() => false);

describe("writeCsvAtomic", () => {
  test("escribe el contenido y no deja el .tmp tirado", async () => {
    const path = join(dir, "a.csv");
    await writeCsvAtomic(path, COLUMNS, [{ comment_id: "1", sent_at: "x" }]);

    assert.deepEqual(fromCsv(await readFile(path, "utf8")).rows, [{ comment_id: "1", sent_at: "x" }]);
    assert.equal(await exists(`${path}.tmp`), false, "quedo un .tmp sin limpiar");
  });

  test("acepta una URL (los scripts pasan new URL(...))", async () => {
    const path = join(dir, "b.csv");
    await writeCsvAtomic(pathToFileURL(path), COLUMNS, [{ comment_id: "2", sent_at: "" }]);

    assert.equal(await exists(path), true, "no escribio en el path real");
    assert.equal(fromCsv(await readFile(path, "utf8")).rows[0].comment_id, "2");
  });

  test("sobreescribir deja el archivo completo, no mezclado con el anterior", async () => {
    const path = join(dir, "c.csv");
    const big = Array.from({ length: 300 }, (_, i) => ({ comment_id: `id_${i}`, sent_at: "2026-07-15" }));
    await writeCsvAtomic(path, COLUMNS, big);

    // Sobreescribe con MENOS filas: si truncara mal, quedarian restos de las 300.
    await writeCsvAtomic(path, COLUMNS, [{ comment_id: "solo_una", sent_at: "" }]);

    const { rows } = fromCsv(await readFile(path, "utf8"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].comment_id, "solo_una");
  });

  test("un run de 300 flushes sobrevive entero (simula el loop de envio)", async () => {
    const path = join(dir, "d.csv");
    const rows = Array.from({ length: 300 }, (_, i) => ({ comment_id: `id_${i}`, sent_at: "" }));

    // Igual que 04-send: mutar la fila y reescribir el CSV entero, 300 veces.
    for (const row of rows) {
      row.sent_at = "2026-07-15T12:00:00Z";
      await writeCsvAtomic(path, COLUMNS, rows);
    }

    const { rows: final } = fromCsv(await readFile(path, "utf8"));
    assert.equal(final.length, 300);
    assert.ok(final.every((r) => r.sent_at !== ""), "alguna fila perdio su sent_at");
    assert.equal(await exists(`${path}.tmp`), false);
  });
});
