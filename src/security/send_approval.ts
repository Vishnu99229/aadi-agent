export class SendNotApprovedError extends Error {
  constructor() {
    super(
      "Send is only allowed after an approval button tap or Vishnu's explicit send command in his own chat.",
    );
    this.name = "SendNotApprovedError";
  }
}

export class EventNotApprovedError extends Error {
  constructor() {
    super("Event creation is only allowed after an approval button tap.");
    this.name = "EventNotApprovedError";
  }
}

const SEND_CALLBACK = /^approval:send:(\d+)$/;
const CREATE_EVENT_CALLBACK = /^approval:create:(\d+)$/;

export function parseSendApprovalCallback(
  data: string | undefined,
): number | undefined {
  const match = SEND_CALLBACK.exec(data ?? "");
  if (!match) {
    return undefined;
  }
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export function parseCreateEventApprovalCallback(
  data: string | undefined,
): number | undefined {
  const match = CREATE_EVENT_CALLBACK.exec(data ?? "");
  if (!match) {
    return undefined;
  }
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export function allowSendDraft(params: {
  callbackData: string | undefined;
  actionId: number;
  actionStatus: string;
}): void {
  const approvedId = parseSendApprovalCallback(params.callbackData);
  if (
    approvedId !== params.actionId ||
    params.actionStatus !== "pending"
  ) {
    throw new SendNotApprovedError();
  }
}

export function allowCreateEvent(params: {
  callbackData: string | undefined;
  actionId: number;
  actionStatus: string;
  actionType: string;
}): void {
  const approvedId = parseCreateEventApprovalCallback(params.callbackData);
  if (
    approvedId !== params.actionId ||
    params.actionStatus !== "pending" ||
    params.actionType !== "create_event"
  ) {
    throw new EventNotApprovedError();
  }
}

function requireOwnerChatConfirmation(confirmation: {
  chatId: number;
  messageId: number;
} | undefined): void {
  if (
    !confirmation ||
    !Number.isSafeInteger(confirmation.chatId) ||
    !Number.isSafeInteger(confirmation.messageId) ||
    confirmation.messageId <= 0
  ) {
    throw new EventNotApprovedError();
  }
}

/** Vishnu's own chat/voice turn is the approval for create_meeting.
 *  Never call this from inbound email handling. */
export function allowOwnerChatCreateEvent(confirmation: {
  chatId: number;
  messageId: number;
} | undefined): void {
  requireOwnerChatConfirmation(confirmation);
}

/** Vishnu's own chat/voice turn is the approval for delete_calendar_event.
 *  Never call this from inbound email handling. */
export function allowOwnerChatDeleteEvent(confirmation: {
  chatId: number;
  messageId: number;
} | undefined): void {
  requireOwnerChatConfirmation(confirmation);
}

/** Vishnu's own chat/voice turn is the approval for send_immediately on
 *  draft_reply / draft_new_email. Never call this from inbound email. */
export function allowOwnerChatSendDraft(confirmation: {
  chatId: number;
  messageId: number;
} | undefined): void {
  if (
    !confirmation ||
    !Number.isSafeInteger(confirmation.chatId) ||
    !Number.isSafeInteger(confirmation.messageId) ||
    confirmation.messageId <= 0
  ) {
    throw new SendNotApprovedError();
  }
}
