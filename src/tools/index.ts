import type { LlmTool } from "../llm.js";
import { config } from "../config.js";
import * as accountStatus from "./account_status.js";
import * as addAccount from "./add_account.js";
import * as addTask from "./add_task.js";
import * as markBillPaid from "./mark_bill_paid.js";
import * as removeDate from "./remove_date.js";
import * as cancelReminder from "./cancel_reminder.js";
import * as completeTask from "./complete_task.js";
import * as draftReply from "./draft_reply.js";
import * as getCurrentTime from "./get_current_time.js";
import * as addDate from "./add_date.js";
import * as listAccounts from "./list_accounts.js";
import * as listBills from "./list_bills.js";
import * as listEvents from "./list_events.js";
import * as listDates from "./list_dates.js";
import * as listUpcomingDates from "./list_upcoming_dates.js";
import * as listReminders from "./list_reminders.js";
import * as listTasks from "./list_tasks.js";
import * as listWaiting from "./list_waiting.js";
import * as readDocument from "./read_document.js";
import * as removeAccount from "./remove_account.js";
import * as readEmail from "./read_email.js";
import * as readSheet from "./read_sheet.js";
import * as searchEmails from "./search_emails.js";
import * as searchNotes from "./search_notes.js";
import * as setReminder from "./set_reminder.js";
import * as stopTracking from "./stop_tracking.js";
import * as trackThread from "./track_thread.js";
import * as updateAccount from "./update_account.js";
import * as updateDraft from "./update_draft.js";

export interface RegisteredTool {
  definition: Extract<LlmTool, { type: "function" }>;
  handler: (input: unknown) => string | Promise<string>;
}

export const tools: Record<string, RegisteredTool> = {
  account_status: accountStatus,
  add_account: addAccount,
  add_date: addDate,
  add_task: addTask,
  cancel_reminder: cancelReminder,
  complete_task: completeTask,
  draft_reply: draftReply,
  get_current_time: getCurrentTime,
  list_accounts: listAccounts,
  list_bills: listBills,
  list_dates: listDates,
  list_events: listEvents,
  list_upcoming_dates: listUpcomingDates,
  list_reminders: listReminders,
  list_tasks: listTasks,
  list_waiting: listWaiting,
  mark_bill_paid: markBillPaid,
  read_document: readDocument,
  remove_account: removeAccount,
  remove_date: removeDate,
  read_email: readEmail,
  ...(config.googleSheetId ? { read_sheet: readSheet } : {}),
  search_emails: searchEmails,
  search_notes: searchNotes,
  set_reminder: setReminder,
  stop_tracking: stopTracking,
  track_thread: trackThread,
  update_account: updateAccount,
  update_draft: updateDraft,
};
