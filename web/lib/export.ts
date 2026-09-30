import { strToU8, zipSync } from "fflate";
import type { Transaction } from "./types";
import { DEBT_LABEL, TYPE_LABEL, balanceSign, toLocalInput } from "./utils";

/**
 * CSV / XLSX export built in the browser, so the Worker never spends CPU time on file generation.
 * The XLSX writer emits a minimal valid Office Open XML workbook (one sheet, styled header,
 * number formats, frozen header row, autofilter).
 */

const HEADERS = [
  "ID", "Tanggal", "Tipe", "Arah Utang", "Kategori", "Deskripsi", "Merchant",
  "Pihak Lain", "Metode Bayar", "Jumlah", "Efek Saldo", "Sumber",
] as const;

type Cell = string | number | null;

function rows(items: Transaction[], tz: string): Cell[][] {
  return items.map((t) => [
    t.id,
    toLocalInput(t.transaction_date, tz).replace("T", " "),
    TYPE_LABEL[t.type],
    t.debt_direction ? DEBT_LABEL[t.debt_direction] ?? t.debt_direction : "",
    t.category?.name ?? "",
    t.description,
    t.merchant ?? "",
    t.counterparty ?? "",
    t.payment_method,
    Number(t.amount),
    balanceSign(t) * Number(t.amount),
    ({ telegram_text: "Telegram", telegram_voice: "Voice note", telegram_receipt: "Struk", dashboard: "Dashboard" } as const)[t.source],
  ]);
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvEscape(v: Cell): string {
  if (v === null) return "";
  const s = String(v);
  // Neutralise spreadsheet formula injection from user-controlled text.
  const safe = typeof v === "string" && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function exportCsv(items: Transaction[], tz: string, filename: string) {
  const lines = [HEADERS.join(","), ...rows(items, tz).map((r) => r.map(csvEscape).join(","))];
  // BOM so Excel opens UTF-8 (emoji, accents) correctly.
  download(new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }), filename);
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // strip characters that are illegal in XML 1.0
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function colName(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function exportXlsx(items: Transaction[], tz: string, filename: string) {
  const data = rows(items, tz);
  const moneyCols = new Set([9, 10]);
  const widths = HEADERS.map((h, i) =>
    Math.min(50, Math.max(h.length + 2, ...data.slice(0, 500).map((r) => String(r[i] ?? "").length + 2), moneyCols.has(i) ? 16 : 0)),
  );

  const cell = (v: Cell, r: number, c: number, style = 0) => {
    const ref = `${colName(c)}${r}`;
    if (v === null || v === "") return `<c r="${ref}" s="${style}"/>`;
    if (typeof v === "number") return `<c r="${ref}" s="${moneyCols.has(c) ? 2 : style}"><v>${v}</v></c>`;
    return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
  };

  const lastRow = data.length + 1;
  const totalRow = lastRow + 1;
  const sheetRows = [
    `<row r="1">${HEADERS.map((h, c) => cell(h, 1, c, 1)).join("")}</row>`,
    ...data.map((r, i) => `<row r="${i + 2}">${r.map((v, c) => cell(v, i + 2, c)).join("")}</row>`),
    `<row r="${totalRow}">${cell("Total efek saldo", totalRow, 9, 1)}<c r="K${totalRow}" s="3"><f>SUM(K2:K${lastRow})</f></c></row>`,
  ];

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>
<sheetData>${sheetRows.join("")}</sheetData>
<autoFilter ref="A1:${colName(HEADERS.length - 1)}${lastRow}"/>
</worksheet>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8F5EE"/></patternFill></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf/></cellStyleXfs>
<cellXfs count="4">
<xf/>
<xf fontId="1" fillId="2" applyFont="1" applyFill="1"/>
<xf numFmtId="164" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" applyNumberFormat="1" applyFont="1"/>
</cellXfs>
</styleSheet>`;

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Transaksi" sheetId="1" r:id="rId1"/></sheets>
<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Transaksi!$A$1:$${colName(HEADERS.length - 1)}$${lastRow}</definedName></definedNames>
</workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
    "xl/styles.xml": strToU8(styles),
  };

  const zipped = zipSync(files, { level: 6 });
  download(
    new Blob([zipped as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    filename,
  );
}
