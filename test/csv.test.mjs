import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { toCsv, fromCsv } from "../src/csv.mjs";

const COLUMNS = ["comment_id", "username", "text", "sent_at"];

const roundTrip = (rows) => fromCsv(toCsv(COLUMNS, rows)).rows;

describe("csv round-trip", () => {
  test("texto simple", () => {
    const rows = [{ comment_id: "1", username: "ana", text: "guia", sent_at: "" }];
    assert.deepEqual(roundTrip(rows), rows);
  });

  test("texto con comas no corre las columnas", () => {
    const rows = [{ comment_id: "1", username: "ana", text: "quiero guia, ya, porfa", sent_at: "" }];
    assert.deepEqual(roundTrip(rows), rows);
  });

  test("texto con comillas dobles", () => {
    const rows = [{ comment_id: "1", username: "ana", text: 'dijo "guia" y se fue', sent_at: "" }];
    assert.deepEqual(roundTrip(rows), rows);
  });

  test("texto con saltos de linea (los comentarios de IG los tienen)", () => {
    const rows = [{ comment_id: "1", username: "ana", text: "guia\n\npor favor", sent_at: "" }];
    assert.deepEqual(roundTrip(rows), rows);
  });

  test("emoji", () => {
    const rows = [{ comment_id: "1", username: "ana", text: "guia 🔥🙏 vamos", sent_at: "" }];
    assert.deepEqual(roundTrip(rows), rows);
  });

  test("el combo completo, que es el que rompe los parsers caseros", () => {
    const rows = [
      { comment_id: "1", username: "ana", text: 'guia, "ya"\nporfa 🔥', sent_at: "2026-07-15T12:00:00Z" },
      { comment_id: "2", username: "bob", text: "normal", sent_at: "" },
    ];
    assert.deepEqual(roundTrip(rows), rows);
  });

  test("celdas vacias sobreviven", () => {
    const rows = [{ comment_id: "1", username: "", text: "", sent_at: "" }];
    assert.deepEqual(roundTrip(rows), rows);
  });

  test("null/undefined se serializan como vacio", () => {
    const csv = toCsv(COLUMNS, [{ comment_id: "1", username: null, text: undefined, sent_at: "" }]);
    assert.deepEqual(fromCsv(csv).rows, [{ comment_id: "1", username: "", text: "", sent_at: "" }]);
  });

  test("preserva el orden de las filas (la cola de envio depende de eso)", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      comment_id: String(i),
      username: `u${i}`,
      text: `t,${i}`,
      sent_at: "",
    }));
    assert.deepEqual(
      roundTrip(rows).map((r) => r.comment_id),
      rows.map((r) => r.comment_id),
    );
  });
});

describe("fromCsv", () => {
  test("texto vacio => sin filas", () => {
    assert.deepEqual(fromCsv(""), { columns: [], rows: [] });
  });

  test("solo header => sin filas pero con columnas", () => {
    const { columns, rows } = fromCsv("a,b,c\n");
    assert.deepEqual(columns, ["a", "b", "c"]);
    assert.equal(rows.length, 0);
  });

  test("acepta finales de linea CRLF (Windows)", () => {
    const { rows } = fromCsv("a,b\r\n1,2\r\n");
    assert.deepEqual(rows, [{ a: "1", b: "2" }]);
  });
});
