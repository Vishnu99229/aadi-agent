import { referencesAttachment } from "../command_logic.js";
import { config } from "../config.js";
import {
  claimCommandSend,
  recordCommandSendSent,
  releaseCommandSend,
  markCommandSendUnconfirmed,
} from "../db.js";
import { parseAddressList } from "../followup_logic.js";
import type { LoadedGoogleAccount } from "../google/auth.js";
import {
  buildMimeMessage,
  buildThreadReplyMime,
  gmailClient,
  mimeHeaderBlock,
} from "../google/mail.js";
import { allowOwnerChatCommandSend } from "./send_approval.js";

export class CommandSendRefusedError extends Error {
  constructor(readonly reason: string) {
    super(`command send refused: ${reason}`);
    this.name = "CommandSendRefusedError";
  }
}

/** Gmail answered and did not take the message, so nothing went out. */
export class CommandSendRejectedError extends Error {
  constructor(readonly status: number) {
    super(`command send rejected: ${status}`);
    this.name = "CommandSendRejectedError";
  }
}

/** The message's fate is unknown. It stays claimed and is never sent again. */
export class CommandSendUnconfirmedError extends Error {
  constructor() {
    super("command send unconfirmed");
    this.name = "CommandSendUnconfirmedError";
  }
}

export interface CommandSendGateInput {
  enabled: boolean;
  to: string;
  cc: string;
  /** The addresses resolved from what he named. Nothing else may receive it. */
  resolved: ReadonlySet<string>;
  subject: string;
  body: string;
  threadId: string | null;
  inReplyTo: string;
}

function addresses(header: string): string[] {
  return parseAddressList(header).map((item) => item.email.toLowerCase());
}

/** Delivery safety only. There is no check on what the email says, except that it
 *  can't refer to an attachment, because this path can't add one. */
export function evaluateCommandSendGate(
  input: CommandSendGateInput,
): { ok: true } | { ok: false; reason: string } {
  const refuse = (reason: string) => ({ ok: false as const, reason });
  if (!input.enabled) {
    return refuse("disabled");
  }
  const to = addresses(input.to);
  if (to.length === 0) {
    return refuse("no_recipient");
  }
  if ([...to, ...addresses(input.cc)].some((email) => !input.resolved.has(email))) {
    return refuse("recipient_not_resolved");
  }
  if (!input.subject.trim()) {
    return refuse("no_subject");
  }
  if (!input.body.trim()) {
    return refuse("empty_body");
  }
  if (referencesAttachment(`${input.subject}\n${input.body}`)) {
    return refuse("refers_to_attachment");
  }
  if (input.threadId && !input.inReplyTo.trim()) {
    return refuse("no_thread_headers");
  }
  return { ok: true };
}

function httpStatus(error: unknown): number | undefined {
  const record = error as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const value of [record?.response?.status, record?.status, record?.code]) {
    const status = Number(value);
    if (Number.isInteger(status) && status >= 100 && status < 600) {
      return status;
    }
  }
  return undefined;
}

export interface SendCommandEmailParams {
  /** One per command, so a retried message or tool call can't send twice. */
  key: string;
  confirmation: { chatId: number; messageId: number } | undefined;
  account: LoadedGoogleAccount;
  to: string;
  cc: string;
  resolved: ReadonlySet<string>;
  subject: string;
  body: string;
  signatureHtml?: string;
  threadId: string | null;
  inReplyTo: string;
  references: string;
}

/** The only way an email sent on Vishnu's command reaches Gmail. */
export async function sendCommandEmail(
  params: SendCommandEmailParams,
): Promise<{ messageId: string }> {
  allowOwnerChatCommandSend(params.confirmation);
  const gate = evaluateCommandSendGate({
    enabled: config.sendOnCommandEnabled,
    to: params.to,
    cc: params.cc,
    resolved: params.resolved,
    subject: params.subject,
    body: params.body,
    threadId: params.threadId,
    inReplyTo: params.inReplyTo,
  });
  if (!gate.ok) {
    throw new CommandSendRefusedError(gate.reason);
  }
  const raw = params.threadId
    ? buildThreadReplyMime({
        to: params.to,
        cc: params.cc,
        subject: params.subject,
        inReplyTo: params.inReplyTo,
        references: params.references,
        body: params.body,
        signatureHtml: params.signatureHtml,
      })
    : buildMimeMessage(
        [
          ["To", params.to],
          ["Cc", params.cc],
          ["Subject", params.subject],
        ],
        params.body,
        params.signatureHtml,
      );
  if (/^bcc:/im.test(mimeHeaderBlock(raw))) {
    throw new CommandSendRefusedError("bcc_not_allowed");
  }
  if (
    !claimCommandSend({
      key: params.key,
      account: params.account.id,
      threadId: params.threadId,
    })
  ) {
    throw new CommandSendRefusedError("already_handled");
  }
  const tag = `Command send: provider=gmail`;
  let messageId: string | null | undefined;
  try {
    const sent = await gmailClient(params.account).users.messages.send({
      userId: "me",
      requestBody: {
        ...(params.threadId ? { threadId: params.threadId } : {}),
        raw: Buffer.from(raw, "utf8").toString("base64url"),
      },
    });
    messageId = sent.data.id;
  } catch (error) {
    const status = httpStatus(error);
    if (status !== undefined && status >= 400 && status < 500 && status !== 408) {
      releaseCommandSend(params.key);
      console.error(`${tag} status=rejected code=${status}`);
      throw new CommandSendRejectedError(status);
    }
    markCommandSendUnconfirmed(params.key);
    console.error(`${tag} status=unconfirmed`);
    throw new CommandSendUnconfirmedError();
  }
  if (!messageId) {
    markCommandSendUnconfirmed(params.key);
    console.error(`${tag} status=unconfirmed`);
    throw new CommandSendUnconfirmedError();
  }
  recordCommandSendSent(params.key, messageId);
  console.log(`${tag} status=sent`);
  return { messageId };
}
