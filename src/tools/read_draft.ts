import type { LlmTool } from "../llm.js";
import {
  getLatestPendingSendAction,
  getPendingActionForDraft,
} from "../db.js";
import {
  messageHeader,
  plainTextBody,
  resolveGmailDraft,
  stripSignature,
} from "../google/mail.js";

const BODY_LIMIT = 8000;

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "read_draft",
  description:
    "Read a Gmail draft's exact plain-text body plus its To, Cc and Subject so you can show it to Vishnu in chat. Omit draft_id to read the latest draft waiting for his approval. Read-only; never sends.",
  inputSchema: {
    type: "object",
    properties: {
      draft_id: {
        type: "string",
        description:
          "Gmail draft ID returned by draft_reply, draft_mom or update_draft. Omit for the latest pending draft.",
      },
    },
    required: [],
  },
};

export async function handler(input: unknown): Promise<string> {
  const values = (input ?? {}) as { draft_id?: unknown };
  let draftId =
    typeof values.draft_id === "string" ? values.draft_id.trim() : "";
  if (!draftId) {
    const latest = getLatestPendingSendAction();
    if (!latest || latest.type !== "send_draft" || !latest.draft_id) {
      return "No draft is waiting for approval.";
    }
    draftId = latest.draft_id;
  }

  const pending = getPendingActionForDraft(draftId);
  const { account, draft } = await resolveGmailDraft(
    draftId,
    pending?.google_account,
  );
  const payload = draft.message?.payload;
  const headers = payload?.headers;
  const { body: text, signed } = stripSignature(
    payload ? plainTextBody(payload).trim() : "",
  );
  const characters = Array.from(text);
  const body =
    characters.length > BODY_LIMIT
      ? `${characters.slice(0, BODY_LIMIT).join("")}\n[truncated]`
      : characters.join("");

  return [
    `Draft ID: ${draftId}`,
    `Account: ${account.label}`,
    `To: ${messageHeader(headers, "To")}`,
    `Cc: ${messageHeader(headers, "Cc") || "(none)"}`,
    `Subject: ${messageHeader(headers, "Subject")}`,
    `Signature: ${signed ? "included" : "none"}`,
    "",
    body || "(No plain-text body found.)",
  ].join("\n");
}
