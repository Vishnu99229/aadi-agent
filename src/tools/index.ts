import type { LlmTool } from "../llm.js";
import { config } from "../config.js";
import * as draftReply from "./draft_reply.js";
import * as getCurrentTime from "./get_current_time.js";
import * as listEvents from "./list_events.js";
import * as readEmail from "./read_email.js";
import * as readSheet from "./read_sheet.js";
import * as searchEmails from "./search_emails.js";
import * as updateDraft from "./update_draft.js";

export interface RegisteredTool {
  definition: Extract<LlmTool, { type: "function" }>;
  handler: (input: unknown) => string | Promise<string>;
}

export const tools: Record<string, RegisteredTool> = {
  draft_reply: draftReply,
  get_current_time: getCurrentTime,
  list_events: listEvents,
  read_email: readEmail,
  ...(config.googleSheetId ? { read_sheet: readSheet } : {}),
  search_emails: searchEmails,
  update_draft: updateDraft,
};
