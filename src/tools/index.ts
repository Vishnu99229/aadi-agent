import type { LlmTool } from "../llm.js";
import { config } from "../config.js";
import * as addTask from "./add_task.js";
import * as cancelReminder from "./cancel_reminder.js";
import * as completeTask from "./complete_task.js";
import * as draftReply from "./draft_reply.js";
import * as getCurrentTime from "./get_current_time.js";
import * as listEvents from "./list_events.js";
import * as listReminders from "./list_reminders.js";
import * as listTasks from "./list_tasks.js";
import * as listWaiting from "./list_waiting.js";
import * as readEmail from "./read_email.js";
import * as readSheet from "./read_sheet.js";
import * as searchEmails from "./search_emails.js";
import * as setReminder from "./set_reminder.js";
import * as stopTracking from "./stop_tracking.js";
import * as trackThread from "./track_thread.js";
import * as updateDraft from "./update_draft.js";

export interface RegisteredTool {
  definition: Extract<LlmTool, { type: "function" }>;
  handler: (input: unknown) => string | Promise<string>;
}

export const tools: Record<string, RegisteredTool> = {
  add_task: addTask,
  cancel_reminder: cancelReminder,
  complete_task: completeTask,
  draft_reply: draftReply,
  get_current_time: getCurrentTime,
  list_events: listEvents,
  list_reminders: listReminders,
  list_tasks: listTasks,
  list_waiting: listWaiting,
  read_email: readEmail,
  ...(config.googleSheetId ? { read_sheet: readSheet } : {}),
  search_emails: searchEmails,
  set_reminder: setReminder,
  stop_tracking: stopTracking,
  track_thread: trackThread,
  update_draft: updateDraft,
};
