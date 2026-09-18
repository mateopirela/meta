// CSV RFC4180 en el browser, para exportar lo que la página ya leyó. El texto
// de Instagram trae comas, comillas y saltos de línea: todo va entre comillas.

export const JOB_COLUMNS = [
  "comment_id", "username", "text", "comment_ts", "expires_at",
  "dm_status", "sent_at", "message_id", "recipient_id", "dm_error",
  "reply_status", "public_reply_id", "public_reply_at", "public_reply_text", "reply_error",
];
/** Mismas columnas (abre en la misma planilla) + las del modo en vivo. */
export const TRIGGER_COLUMNS = [...JOB_COLUMNS, "source", "received_at", "attempts", "from_id"];

const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

export function toCsv(columns, rows) {
  const lines = [columns.map(cell).join(",")];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

export function downloadCsv(filename, columns, rows) {
  const blob = new Blob(["﻿" + toCsv(columns, rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
