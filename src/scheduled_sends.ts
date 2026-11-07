import { InlineKeyboard, type Context } from "grammy";
import {
  commandApi,
  readThread,
  scheduledWhen,
  writeAndSend,
  type CommandRequest,
  type RecipientSlot,
} from "./command_email.js";
import { nameTokens, notAnEventCommand, scheduledTargetWords } from "./command_logic.js";
import { resolveRecipient } from "./command_recipients.js";
import { config } from "./config.js";
import {
  claimScheduledSend,
  getScheduledSend,
  holdScheduledSend,
  listDueScheduledSends,
  listOpenScheduledSends,
  listScheduledSendsWithClosedTask,
  listStaleScheduledSends,
  markTaskDone,
  recordScheduledSendSent,
  releaseHeldScheduledSend,
  retryScheduledSend,
  transitionScheduledSend,
  type ScheduledSendRecord,
} from "./db.js";
import { formatMailbox } from "./draft_recipients.js";
import type { ParsedMailbox } from "./followup_logic.js";
import { loadFollowupSelfAddresses } from "./followups.js";
import { getGoogleAccount } from "./google/auth.js";
import { gmailClient } from "./google/mail.js";
import { everyMs, type IntervalJob } from "./scheduler.js";
import { allowInboundCommands } from "./security/owner_lock.js";
import { allowOwnerChatCancelScheduledSend } from "./security/send_approval.js";
import type { ToolTurn } from "./tools/index.js";

const TICK_INTERVAL_MS = 60 * 1000;
const TICK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_FIRES_PER_TICK = 3;
const RETRY_AFTER_MS = 15 * 60 * 1000;
const STALE_CLAIM_MS = 30 * 60 * 1000;
const LATE_AFTER_MS = 10 * 60 * 1000;
const MAX_HOLD_BUTTONS = 8;

async function tell(text: string, keyboard?: InlineKeyboard): Promise<void> {
  try {
    await commandApi().sendMessage(
      config.ownerTelegramId,
      text,
      keyboard ? { reply_markup: keyboard } : {},
    );
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Scheduled send notice failed (${errorType})`);
  }
}

function requestOf(row: ScheduledSendRecord): CommandRequest {
  return JSON.parse(row.request) as CommandRequest;
}

/** Whether a slot still points at the same person, or what to ask him. */
export type RecheckResult =
  | { ok: true }
  | { ok: false; slotIndex: number; options: ParsedMailbox[]; reason: string };

function sameAddresses(left: readonly ParsedMailbox[], right: readonly ParsedMailbox[]): boolean {
  const known = new Set(right.map((item) => item.email));
  return left.every((item) => known.has(item.email));
}

/** Looks each recipient up again. A choice he already made stands, unless a new
 *  address has appeared that he never saw. */
async function recheckRecipients(request: CommandRequest): Promise<RecheckResult> {
  const gmail = gmailClient(await getGoogleAccount(request.account));
  const selfAddresses = await loadFollowupSelfAddresses();
  const thread = request.threadId
    ? await readThread(gmail, request.threadId).catch(() => undefined)
    : undefined;
  const slots: RecipientSlot[] = [...request.to, ...request.cc];
  for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
    const slot = slots[slotIndex]!;
    const stored = slot.mailbox!;
    const match = await resolveRecipient({
      gmail,
      query: slot.query,
      selfAddresses,
      threadMailboxes: thread?.mailboxes,
    });
    if (match.kind === "one" && match.mailbox.email === stored.email) {
      continue;
    }
    if (
      match.kind === "many" &&
      match.options.some((item) => item.email === stored.email) &&
      sameAddresses(match.options, slot.seen ?? [])
    ) {
      continue;
    }
    const found = match.kind === "one" ? [match.mailbox] : match.kind === "many" ? match.options : [];
    const options = [stored, ...found.filter((item) => item.email !== stored.email)];
    return {
      ok: false,
      slotIndex,
      options,
      reason:
        match.kind === "none"
          ? `I can't find "${slot.query}" any more`
          : match.kind === "one"
            ? `"${slot.query}" now points to a different address`
            : `"${slot.query}" now matches ${match.options.length} addresses`,
    };
  }
  return { ok: true };
}

async function hold(row: ScheduledSendRecord, request: CommandRequest, check: Extract<RecheckResult, { ok: false }>): Promise<void> {
  const slots = [...request.to, ...request.cc];
  slots[check.slotIndex]!.options = check.options;
  if (!holdScheduledSend(row.id, JSON.stringify(request))) {
    return;
  }
  console.log(`Scheduled send ${row.id}: status -> held`);
  const keyboard = new InlineKeyboard();
  check.options.slice(0, MAX_HOLD_BUTTONS).forEach((option, index) => {
    keyboard.text(formatMailbox(option).slice(0, 60), `cmdsend:hold:${row.id}:${check.slotIndex}:${index}`).row();
  });
  keyboard.text("Cancel", `cmdsend:cancelsched:${row.id}`);
  await tell(
    `Held, not sent: ${row.item_text}\n${check.reason}. Who should it go to?`,
    keyboard,
  );
}

/** Writes it fresh, then sends. The claim sits right before Gmail, so a cancel by any
 *  route up to that moment stops it. */
export async function fireScheduledSend(row: ScheduledSendRecord, now: Date): Promise<void> {
  const request = requestOf(row);
  const check = await recheckRecipients(request);
  if (!check.ok) {
    await hold(row, request, check);
    return;
  }
  const late = now.getTime() - new Date(row.send_at).getTime() > LATE_AFTER_MS;
  const outcome = await writeAndSend(
    {
      ...request,
      instruction: `${request.instruction}\n(He asked for this earlier, to go out now. Reflect anything that has changed since.)`,
    },
    `sched:${row.id}`,
    { chatId: row.confirm_chat, messageId: row.confirm_message },
    now,
    {
      beforeSend: () => claimScheduledSend(row.id, now.toISOString()),
      note: late ? `This went out late: it was due ${scheduledWhen(row.send_at)}.` : undefined,
    },
  );
  if (outcome.result === "sent") {
    recordScheduledSendSent(row.id, outcome.messageId ?? null);
    markTaskDone(row.task_id);
    console.log(`Scheduled send ${row.id}: status -> sent`);
    return;
  }
  if (outcome.result === "cancelled") {
    return;
  }
  if (outcome.result === "write_failed") {
    const failures = retryScheduledSend(row.id, new Date(now.getTime() + RETRY_AFTER_MS).toISOString());
    console.log(`Scheduled send ${row.id}: writer failed, retrying`);
    if (failures === 1) {
      await tell(`Not sent yet: ${row.item_text}\nI couldn't write it (Claude didn't answer). I'll keep trying every 15 minutes, and you can still cancel it.`);
    }
    return;
  }
  transitionScheduledSend(row.id, ["scheduled", "sending"], "failed");
  console.log(`Scheduled send ${row.id}: status -> failed`);
  await tell(`${row.item_text}\n${outcome.text}\nIt's still on your task list.`);
}

/** One minute's work: closed tasks cancel, stuck sends are reported and never resent,
 *  then whatever is due goes out. Due rows wait for the phone if it was off. */
export async function runScheduledSendTick(now = new Date()): Promise<void> {
  if (!config.sendOnCommandEnabled) {
    return;
  }
  for (const row of listScheduledSendsWithClosedTask()) {
    if (transitionScheduledSend(row.id, ["scheduled", "held"], "cancelled")) {
      console.log(`Scheduled send ${row.id}: status -> cancelled reason=task_closed`);
      await tell(`Cancelled, nothing was sent: ${row.item_text}\nIts task was closed.`);
    }
  }
  const cutoff = new Date(now.getTime() - STALE_CLAIM_MS).toISOString();
  for (const row of listStaleScheduledSends(cutoff)) {
    if (transitionScheduledSend(row.id, ["sending"], "failed")) {
      console.log(`Scheduled send ${row.id}: status -> failed reason=unconfirmed`);
      await tell(`I can't confirm this went out, and I won't resend it. Check your Sent mail: ${row.item_text}`);
    }
  }
  for (const row of listDueScheduledSends(now.toISOString(), MAX_FIRES_PER_TICK)) {
    try {
      await fireScheduledSend(row, now);
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      console.error(`Scheduled send ${row.id}: fire failed (${errorType})`);
      if (getScheduledSend(row.id)?.status === "scheduled") {
        retryScheduledSend(row.id, new Date(now.getTime() + RETRY_AFTER_MS).toISOString());
      }
    }
  }
}

function cancelRow(row: ScheduledSendRecord): boolean {
  if (!transitionScheduledSend(row.id, ["scheduled", "held"], "cancelled")) {
    return false;
  }
  markTaskDone(row.task_id);
  console.log(`Scheduled send ${row.id}: status -> cancelled`);
  return true;
}

function matchesTarget(row: ScheduledSendRecord, words: readonly string[]): boolean {
  const request = requestOf(row);
  const known = new Set(
    nameTokens(
      [
        row.item_text,
        ...[...request.to, ...request.cc].flatMap((slot) => [
          slot.query,
          slot.mailbox?.name ?? "",
          (slot.mailbox?.email ?? "").replace("@", " "),
        ]),
      ].join(" "),
    ),
  );
  return words.length > 0 && words.every((word) => known.has(word));
}

/** "Cancel the email to Selvaraj", typed or spoken. */
export function cancelScheduledSendFromTool(
  target: string,
  turn: Pick<ToolTurn, "confirmation" | "userText">,
): string {
  allowOwnerChatCancelScheduledSend(turn.confirmation);
  const reason = notAnEventCommand(turn.userText ?? "");
  if (reason) {
    return `Not cancelled: ${reason}. Ask him if he wants it cancelled.`;
  }
  const rows = listOpenScheduledSends();
  if (rows.length === 0) {
    return "Nothing cancelled: there are no scheduled emails.";
  }
  const list = (items: readonly ScheduledSendRecord[]) => items.map((row) => `- ${row.item_text}`).join("\n");
  const everything = /^(?:all|everything|all of them|every(?:one| one)?)$/i.test(target.trim());
  const words = scheduledTargetWords(target);
  const matched = everything ? rows : rows.filter((row) => matchesTarget(row, words));
  if (matched.length === 0) {
    return `Nothing cancelled: no scheduled email matches "${target}". Scheduled:\n${list(rows)}`;
  }
  if (matched.length > 1 && !everything) {
    return `Nothing cancelled yet: "${target}" matches more than one. Ask Vishnu which:\n${list(matched)}`;
  }
  const cancelled = matched.filter(cancelRow);
  return cancelled.length > 0
    ? `Cancelled, and nothing will be sent:\n${list(cancelled)}`
    : "Nothing cancelled: that one has already gone out or ended.";
}

export function scheduledSendsPanel(): { text: string; keyboard?: InlineKeyboard } {
  const rows = listOpenScheduledSends();
  if (rows.length === 0) {
    return { text: "No scheduled emails." };
  }
  const keyboard = new InlineKeyboard();
  rows.forEach((row, index) => {
    keyboard.text(`Cancel ${index + 1}`, `cmdsend:cancelsched:${row.id}`).row();
  });
  const lines = rows.map(
    (row, index) => `${index + 1}. ${row.item_text}${row.status === "held" ? " (held, waiting on you)" : ""}`,
  );
  const off = config.sendOnCommandEnabled
    ? ""
    : "\n\nSending is switched off (SEND_ON_COMMAND_ENABLED), so nothing goes out until it's on.";
  return { text: `Scheduled emails:\n${lines.join("\n")}${off}`, keyboard };
}

export async function handleScheduledSendsCommand(ctx: Context): Promise<void> {
  if (!allowInboundCommands(ctx.message)) {
    await ctx.reply("A forwarded message can't do that.");
    return;
  }
  const panel = scheduledSendsPanel();
  await ctx.reply(panel.text, panel.keyboard ? { reply_markup: panel.keyboard } : {});
}

/** The Cancel button, and the buttons on a held send. */
export async function handleScheduledSendCallback(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const data = ctx.callbackQuery?.data ?? "";
  const cancel = /^cmdsend:cancelsched:(\d+)$/.exec(data);
  if (cancel) {
    const row = getScheduledSend(Number(cancel[1]));
    const cancelled = row ? cancelRow(row) : false;
    const after = scheduledSendsPanel();
    const heading = cancelled
      ? `Cancelled, nothing will be sent: ${row!.item_text}`
      : `Too late to cancel, or already ended${row ? `: ${row.item_text}` : "."}`;
    const text = after.keyboard ? `${heading}\n\n${after.text}` : heading;
    await ctx
      .editMessageText(text, after.keyboard ? { reply_markup: after.keyboard } : { reply_markup: undefined })
      .catch(() => undefined);
    return;
  }
  const pick = /^cmdsend:hold:(\d+):(\d+):(\d+)$/.exec(data);
  const row = pick ? getScheduledSend(Number(pick[1])) : undefined;
  if (!pick || !row || row.status !== "held") {
    await ctx.editMessageText("That's already been handled.", { reply_markup: undefined }).catch(() => undefined);
    return;
  }
  const request = requestOf(row);
  const slot = [...request.to, ...request.cc][Number(pick[2])];
  const picked = slot?.options?.[Number(pick[3])];
  if (!slot || !picked) {
    await ctx.editMessageText("That's already been handled.", { reply_markup: undefined }).catch(() => undefined);
    return;
  }
  slot.mailbox = picked;
  slot.seen = slot.options;
  delete slot.options;
  // One tap wins: a double tap finds it no longer held.
  if (!releaseHeldScheduledSend(row.id, JSON.stringify(request))) {
    await ctx.editMessageText("That's already been handled.", { reply_markup: undefined }).catch(() => undefined);
    return;
  }
  await ctx.editMessageText(`Picked ${formatMailbox(picked)}.`, { reply_markup: undefined }).catch(() => undefined);
  const released = getScheduledSend(row.id)!;
  try {
    await fireScheduledSend(released, new Date());
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Scheduled send ${row.id}: fire after tap failed (${errorType})`);
    await ctx.reply("That hit a problem, so it hasn't gone out yet. I'll try again on the next check.");
  }
}

export function registerScheduledSends(): IntervalJob | undefined {
  if (!config.sendOnCommandEnabled) {
    console.log("Scheduled sends off (SEND_ON_COMMAND_ENABLED).");
    return undefined;
  }
  const job = everyMs("scheduled-send", TICK_INTERVAL_MS, () => runScheduledSendTick(), {
    jobTimeoutMs: TICK_TIMEOUT_MS,
  });
  console.log("Scheduled sends checked every minute.");
  return job;
}
