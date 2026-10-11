import { google } from "googleapis";
import type { LlmTool } from "../llm.js";
import { config } from "../config.js";
import { getGoogleClient } from "../google/auth.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "read_sheet",
  description:
    'Read rows from Vishnu\'s configured Google task sheet. Use an A1-notation range such as "Tasks!A1:F50" or "Tasks!A:Z". This tool only reads values and cannot edit the sheet.',
  inputSchema: {
    type: "object",
    properties: {
      range: {
        type: "string",
        description:
          'The sheet name and A1 range to read, for example "Tasks!A1:F50".',
      },
    },
    required: ["range"],
  },
};

function cellText(value: unknown): string {
  return String(value ?? "").replace(/\r?\n/g, " ");
}

export async function handler(input: unknown): Promise<string> {
  const values = input as { range?: unknown };
  if (typeof values.range !== "string" || !values.range.trim()) {
    throw new Error("range must be a non-empty A1-notation sheet range.");
  }
  if (!config.googleSheetId) {
    throw new Error("No Google task sheet is configured.");
  }

  const auth = await getGoogleClient();
  const sheets = google.sheets({ version: "v4", auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.googleSheetId,
    range: values.range,
    majorDimension: "ROWS",
    valueRenderOption: "FORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const rows = response.data.values ?? [];

  if (rows.length === 0) {
    return "The requested sheet range is empty.";
  }

  return rows
    .map(
      (row, index) =>
        `${index + 1}: ${row.map((value) => cellText(value)).join(" | ")}`,
    )
    .join("\n");
}
