import { InlineKeyboard, type Context } from "grammy";
import {
  createPendingAccountUpdate,
  deletePendingAccountUpdate,
  getAccount,
  getAccounts,
  getFollowups,
  getPendingAccountUpdate,
  getTasks,
  searchNotes,
  updateAccount,
  updateAccountActivity,
  type AccountRecord as AccountRow,
  type NoteRecord,
} from "./db.js";
import { loadGoogleAccounts } from "./google/auth.js";
import { gmailClient } from "./google/mail.js";
import {
  accountMatchesEmail,
  accountMatchesText,
  decodeAccount,
  findAccountsInText,
  formatAccountListLine,
  formatAccountStatus,
  gmailQueryForAccount,
  latestActivityIso,
  suggestedUpdateFromWrapUp,
  type AccountRecord,
  type InteractionLine,
  type OpenItemLine,
  type WrapUpBits,
} from "./account_logic.js";

function header(
  headers: Array<{ name?: string | null; value?: string | null }> | undefined,
  name: string,
): string {
  return (
    headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())
      ?.value ?? ""
  );
}

export function decodedAccounts(): AccountRecord[] {
  return getAccounts().map(decodeAccount);
}

export function decodedAccount(id: number): AccountRecord | undefined {
  const row = getAccount(id);
  return row ? decodeAccount(row) : undefined;
}

function noteDateMs(note: NoteRecord): number {
  const ms = new Date(`${note.created_at.replace(" ", "T")}Z`).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function matchingNotes(account: AccountRecord): NoteRecord[] {
  return searchNotes("").filter((note) =>
    accountMatchesText(
      account,
      `${note.title} ${note.people} ${note.content}`,
    ),
  );
}

function openItemsFor(account: AccountRecord): OpenItemLine[] {
  const items: OpenItemLine[] = [];
  for (const followup of getFollowups()) {
    if (followup.status !== "waiting" && followup.status !== "snoozed") {
      continue;
    }
    if (accountMatchesText(account, `${followup.recipient} ${followup.subject}`)) {
      items.push({
        kind: "follow-up",
        text: `${followup.subject} (${followup.recipient})`,
      });
    }
  }
  for (const task of getTasks()) {
    if (task.status !== "open") {
      continue;
    }
    if (accountMatchesText(account, task.text)) {
      items.push({ kind: "task", text: task.text });
    }
  }
  for (const note of matchingNotes(account)) {
    if (!note.pending_action_items) {
      continue;
    }
    try {
      const pending = JSON.parse(note.pending_action_items) as Array<{
        text?: string;
        owner?: string;
      }>;
      for (const item of pending) {
        if (item.owner === "other" && item.text?.trim()) {
          items.push({ kind: "promised", text: item.text.trim() });
        }
      }
    } catch {
      // ignore malformed note JSON
    }
  }
  return items;
}

async function workEmailInteractions(
  account: AccountRecord,
): Promise<InteractionLine[]> {
  const query = gmailQueryForAccount(account);
  if (!query) {
    return [];
  }
  const work = (await loadGoogleAccounts()).find((item) => item.id === "work");
  if (!work) {
    return [];
  }
  const gmail = gmailClient(work);
  const listed = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: 8,
  });
  const threads = new Map<string, InteractionLine>();
  for (const message of listed.data.messages ?? []) {
    if (!message.id) {
      continue;
    }
    const response = await gmail.users.messages.get({
      userId: "me",
      id: message.id,
      format: "metadata",
      metadataHeaders: ["From", "To", "Subject", "Date"],
    });
    const headers = response.data.payload?.headers;
    const from = header(headers, "From");
    const to = header(headers, "To");
    const subject = header(headers, "Subject");
    const date = header(headers, "Date");
    if (
      !accountMatchesEmail(account, from) &&
      !accountMatchesEmail(account, to) &&
      !accountMatchesText(account, `${from} ${to} ${subject}`)
    ) {
      continue;
    }
    const threadId = response.data.threadId ?? message.id;
    const dateMs = Date.parse(date);
    threads.set(threadId, {
      kind: "email",
      date,
      dateMs: Number.isFinite(dateMs) ? dateMs : 0,
      text: subject || "(no subject)",
    });
    if (threads.size >= 3) {
      break;
    }
  }
  console.log(
    `Account status mail search: account=${account.id}, threads=${threads.size}`,
  );
  return [...threads.values()];
}

function noteInteractions(account: AccountRecord): InteractionLine[] {
  return matchingNotes(account).map((note) => ({
    kind: "note" as const,
    date: note.created_at.slice(0, 10),
    dateMs: noteDateMs(note),
    text: note.title,
  }));
}

export function formatAccountsList(): string {
  const accounts = decodedAccounts();
  if (accounts.length === 0) {
    return "No accounts tracked yet.";
  }
  return accounts.map(formatAccountListLine).join("\n");
}

export async function buildAccountStatus(account: AccountRecord): Promise<string> {
  const emails = await workEmailInteractions(account);
  const notes = noteInteractions(account);
  const interactions = [...emails, ...notes];
  const activity = latestActivityIso(interactions);
  if (activity) {
    updateAccountActivity(account.id, activity);
  }
  const fresh = decodedAccount(account.id) ?? account;
  return formatAccountStatus({
    account: fresh,
    interactions,
    openItems: openItemsFor(account),
  });
}

function updateLabel(name: string, suggestion: { stage: string; next_step: string }): string {
  const detail = suggestion.next_step.trim() || suggestion.stage.trim() || "update";
  const label = `Update ${name}: ${detail}`;
  return label.length <= 64 ? label : `${label.slice(0, 61)}...`;
}

export async function offerAccountUpdateAfterWrapUp(
  ctx: Context,
  wrapUp: WrapUpBits,
): Promise<void> {
  const haystack = `${wrapUp.title} ${wrapUp.people} ${wrapUp.content}`;
  const matches = findAccountsInText(decodedAccounts(), haystack) as AccountRecord[];
  for (const account of matches) {
    const suggestion = suggestedUpdateFromWrapUp(account, wrapUp);
    if (!suggestion) {
      continue;
    }
    const pending = createPendingAccountUpdate({
      accountId: account.id,
      suggestedStage: suggestion.stage,
      suggestedNextStep: suggestion.next_step,
      suggestedWaitingOn: suggestion.waiting_on,
    });
    await ctx.reply(`Update ${account.name}?`, {
      reply_markup: new InlineKeyboard()
        .text(
          updateLabel(account.name, suggestion),
          `acct:yes:${pending.id}`,
        )
        .row()
        .text("No change", `acct:no:${pending.id}`),
    });
  }
}

export async function handleAccountUpdateCallback(
  ctx: Context,
  apply: boolean,
  pendingId: number,
): Promise<void> {
  await ctx.answerCallbackQuery();
  const pending = getPendingAccountUpdate(pendingId);
  if (!pending) {
    await ctx.reply("That account update is no longer available.");
    return;
  }
  deletePendingAccountUpdate(pendingId);
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  if (!apply) {
    await ctx.reply("No change.");
    return;
  }
  const updated = updateAccount(pending.account_id, {
    stage: pending.suggested_stage,
    nextStep: pending.suggested_next_step,
    waitingOn: pending.suggested_waiting_on,
  });
  if (!updated) {
    await ctx.reply("That account is gone.");
    return;
  }
  console.log(`Account ${updated.id}: stage/next_step updated from wrap-up confirm`);
  await ctx.reply(
    `Updated ${updated.name}: ${updated.stage || "no stage"} / ${updated.next_step || "no next step"} (waiting on ${updated.waiting_on}).`,
  );
}

export function rowToDecoded(row: AccountRow): AccountRecord {
  return decodeAccount(row);
}
