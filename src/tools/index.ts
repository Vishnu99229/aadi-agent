import type { LlmTool } from "../llm.js";
import type { SendConfirmation } from "../approvals.js";
import * as accountStatus from "./account_status.js";
import * as confirmSendPendingDraft from "./confirm_send_pending_draft.js";
import * as createMeeting from "./create_meeting.js";
import * as discardPendingDraft from "./discard_pending_draft.js";
import * as resendDraftCard from "./resend_draft_card.js";
import * as addAccount from "./add_account.js";
import * as addTask from "./add_task.js";
import * as markBillPaid from "./mark_bill_paid.js";
import * as removeDate from "./remove_date.js";
import * as cancelReminder from "./cancel_reminder.js";
import * as completeTask from "./complete_task.js";
import * as deleteCalendarEvent from "./delete_calendar_event.js";
import * as deleteTask from "./delete_task.js";
import * as forgetMemory from "./forget_memory.js";
import * as ignoreBill from "./ignore_bill.js";
import * as draftMom from "./draft_mom.js";
import * as draftNewEmail from "./draft_new_email.js";
import * as draftReply from "./draft_reply.js";
import * as listAttachments from "./list_attachments.js";
import * as readAttachment from "./read_attachment.js";
import * as getCurrentTime from "./get_current_time.js";
import * as addDate from "./add_date.js";
import * as listAccounts from "./list_accounts.js";
import * as listBills from "./list_bills.js";
import * as listEvents from "./list_events.js";
import * as listDates from "./list_dates.js";
import * as listUpcomingDates from "./list_upcoming_dates.js";
import * as listReminders from "./list_reminders.js";
import * as listTasks from "./list_tasks.js";
import * as learnQa from "./learn_qa.js";
import * as listMemories from "./list_memories.js";
import * as listWaiting from "./list_waiting.js";
import * as proposeCalendarEvent from "./propose_calendar_event.js";
import * as remember from "./remember.js";
import * as searchMemories from "./search_memories.js";
import * as searchQa from "./search_qa.js";
import * as updateMemory from "./update_memory.js";
import * as readDocument from "./read_document.js";
import * as readDraft from "./read_draft.js";
import * as readDriveFile from "./read_drive_file.js";
import * as removeAccount from "./remove_account.js";
import * as readEmail from "./read_email.js";
import * as readSheet from "./read_sheet.js";
import * as searchDrive from "./search_drive.js";
import * as searchEmails from "./search_emails.js";
import * as searchNotes from "./search_notes.js";
import * as setReminder from "./set_reminder.js";
import * as stopTracking from "./stop_tracking.js";
import * as trackThread from "./track_thread.js";
import * as updateAccount from "./update_account.js";
import * as updateDraft from "./update_draft.js";

export interface ToolTurn {
  /** 1 = the model's first step, decided from Vishnu's message alone. */
  iteration: number;
  /** Every tool the model called in this same step. */
  calledTools: readonly string[];
  /** Present only when the turn is Vishnu's own chat message (typed or voice). */
  confirmation?: SendConfirmation;
  /** Vishnu's own words for this turn (no quoted-message wrapper). */
  userText?: string;
}

export interface RegisteredTool {
  definition: Extract<LlmTool, { type: "function" }>;
  handler: (input: unknown, turn: ToolTurn) => string | Promise<string>;
}

const modules = {
  account_status: accountStatus,
  add_account: addAccount,
  add_date: addDate,
  add_task: addTask,
  cancel_reminder: cancelReminder,
  complete_task: completeTask,
  confirm_send_pending_draft: confirmSendPendingDraft,
  create_meeting: createMeeting,
  delete_calendar_event: deleteCalendarEvent,
  discard_pending_draft: discardPendingDraft,
  delete_task: deleteTask,
  draft_mom: draftMom,
  draft_new_email: draftNewEmail,
  forget_memory: forgetMemory,
  draft_reply: draftReply,
  get_current_time: getCurrentTime,
  ignore_bill: ignoreBill,
  learn_qa_bank: learnQa,
  list_accounts: listAccounts,
  list_attachments: listAttachments,
  list_bills: listBills,
  list_dates: listDates,
  list_events: listEvents,
  list_upcoming_dates: listUpcomingDates,
  list_reminders: listReminders,
  list_tasks: listTasks,
  list_memories: listMemories,
  list_waiting: listWaiting,
  mark_bill_paid: markBillPaid,
  propose_calendar_event: proposeCalendarEvent,
  resend_draft_card: resendDraftCard,
  read_attachment: readAttachment,
  read_document: readDocument,
  read_draft: readDraft,
  read_drive_file: readDriveFile,
  remove_account: removeAccount,
  remove_date: removeDate,
  read_email: readEmail,
  remember,
  read_sheet: readSheet,
  search_drive: searchDrive,
  search_emails: searchEmails,
  search_memories: searchMemories,
  search_notes: searchNotes,
  search_qa_bank: searchQa,
  set_reminder: setReminder,
  stop_tracking: stopTracking,
  track_thread: trackThread,
  update_account: updateAccount,
  update_memory: updateMemory,
  update_draft: updateDraft,
} as const satisfies Record<string, RegisteredTool>;

/** Fixed order so the Anthropic cached prefix never changes with object-key churn or optional tools. */
export const TOOL_ORDER = [
  "account_status",
  "add_account",
  "add_date",
  "add_task",
  "cancel_reminder",
  "complete_task",
  "draft_mom",
  "forget_memory",
  "draft_reply",
  "get_current_time",
  "ignore_bill",
  "learn_qa_bank",
  "list_accounts",
  "list_attachments",
  "list_bills",
  "list_dates",
  "list_events",
  "list_upcoming_dates",
  "list_reminders",
  "list_tasks",
  "list_memories",
  "list_waiting",
  "mark_bill_paid",
  "propose_calendar_event",
  "create_meeting",
  "delete_calendar_event",
  "read_attachment",
  "read_document",
  "read_drive_file",
  "remove_account",
  "remove_date",
  "read_email",
  "remember",
  "read_sheet",
  "search_drive",
  "search_emails",
  "search_memories",
  "search_notes",
  "search_qa_bank",
  "set_reminder",
  "stop_tracking",
  "track_thread",
  "update_account",
  "update_memory",
  "update_draft",
  "delete_task",
  "read_draft",
  "draft_new_email",
  "confirm_send_pending_draft",
  "discard_pending_draft",
  "resend_draft_card",
] as const;

export const tools: Record<string, RegisteredTool> = Object.fromEntries(
  TOOL_ORDER.map((name) => [name, modules[name]]),
);
