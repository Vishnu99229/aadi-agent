import * as XLSX from "xlsx";

export function extractSpreadsheetText(bytes: Uint8Array): string {
  const workbook = XLSX.read(bytes, { type: "array", cellDates: true });
  const parts: string[] = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) {
      continue;
    }
    const csv = XLSX.utils.sheet_to_csv(sheet).trim();
    parts.push(`--- sheet ${name} ---\n${csv}`);
  }
  return parts.join("\n\n").trim();
}

export function buildSpreadsheetBuffer(
  sheets: Record<string, Array<Array<string | number | null>>>,
): Uint8Array {
  const workbook = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  }
  return new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }));
}
