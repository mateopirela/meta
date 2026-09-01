/**
 * CSV RFC4180 minimo. Sin dependencias a proposito: el texto de los comentarios
 * trae comas, comillas, saltos de linea y emoji, y un split(",") casero rompe
 * el archivo justo cuando mas importa (a mitad de un envio de 2 horas).
 */
import { writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const needsQuoting = (value) => /[",\r\n]/.test(value);

const escapeCell = (value) => {
  const str = value === null || value === undefined ? "" : String(value);
  return needsQuoting(str) ? `"${str.replaceAll('"', '""')}"` : str;
};

/**
 * Escribe el CSV de forma ATOMICA: a un temporal y despues rename().
 *
 * Por que importa: writeFile() trunca el archivo y despues escribe. Si el
 * proceso muere entre las dos cosas (kill, corte de luz, OOM), el CSV queda
 * vacio o cortado y perdes el `sent_at` de TODAS las filas ya enviadas, no
 * solo la de la fila en curso. En un run de 2,5 h eso significa rehacer 500
 * llamadas y quedarte sin auditoria de a quien le llego el DM.
 *
 * rename() es atomico dentro del mismo filesystem: o esta el archivo viejo
 * entero, o el nuevo entero. Nunca uno a medias.
 */
export async function writeCsvAtomic(target, columns, rows) {
  // Los scripts pasan una URL (new URL("../data/x.csv", import.meta.url)).
  // Hay que bajarla a path real: `${url}.tmp` daria "file:///...csv.tmp",
  // que writeFile trataria como nombre de archivo literal.
  const path = target instanceof URL ? fileURLToPath(target) : String(target);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, toCsv(columns, rows), "utf8");
  await rename(tmp, path);
}

/**
 * @param {string[]} columns
 * @param {Record<string, unknown>[]} rows
 */
export function toCsv(columns, rows) {
  const header = columns.map(escapeCell).join(",");
  const body = rows.map((row) => columns.map((col) => escapeCell(row[col])).join(","));
  return [header, ...body].join("\n") + "\n";
}

/**
 * Parser RFC4180. Devuelve { columns, rows } con todas las celdas como string.
 * @param {string} text
 */
export function fromCsv(text) {
  const cells = [];
  let field = "";
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      // \r\n cuenta como un solo salto.
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      cells.push(row);
      field = "";
      row = [];
    } else {
      field += char;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    cells.push(row);
  }

  const nonEmpty = cells.filter((r) => r.length > 1 || r[0] !== "");
  if (nonEmpty.length === 0) return { columns: [], rows: [] };

  const [columns, ...dataRows] = nonEmpty;
  const rows = dataRows.map((values) =>
    Object.fromEntries(columns.map((col, idx) => [col, values[idx] ?? ""])),
  );
  return { columns, rows };
}
