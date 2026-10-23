import { InlineKeyboard, type Api, type Context } from "grammy";
import { decodedAccounts } from "./accounts.js";
import { config } from "./config.js";
import type { FollowupRecord } from "./db.js";
import {
  formatFollowupPanelText,
  formatSnoozeUntil,
  formatToLine,
  type FollowupDisplay,
} from "./followup_logic.js";
import {
  activeFollowups,
  buildNudgeMessage,
  createFollowupDraftForApproval,
  displaysForFollowups,
  dueFollowupsNow,
  FollowupDraftLlmError,
  markFollowupNudged,
  snoozeFollowupThreeDays,
  stopTrackingFollowup,
} from "./followups.js";

interface PanelState {
  heading?: string;
  expandedId: number | null;
  displays: FollowupDisplay[];
}

const panels = new Map<number, PanelState>();

function emptyKeyboard(): InlineKeyboard {
  return new InlineKeyboard();
}

function panelKeyboard(state: PanelState): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (state.displays.length === 0) {
    return keyboard;
  }
  state.displays.forEach((display, index) => {
    keyboard
      .text(`${index + 1} · Actions ▾`, `fu:a:${display.id}`)
      .row();
    if (state.expandedId === display.id) {
      keyboard
        .text("Draft follow-up", `fu:d:${display.id}`)
        .row()
        .text("Send follow-up", `fu:s:${display.id}`)
        .row()
        .text("Snooze 3 days", `fu:z:${display.id}`)
        .row()
        .text("Stop tracking", `fu:t:${display.id}`)
        .row()
        .text("‹ Back", "fu:b")
        .row();
    }
  });
  keyboard.text("Close", "fu:c");
  return keyboard;
}

function setNote(state: PanelState, id: number, note: string): void {
  state.displays = state.displays.map((display) =>
    display.id === id ? { ...display, note } : display,
  );
}

async function editPanel(
  ctx: Context,
  state: PanelState,
  withButtons: boolean,
): Promise<void> {
  const text = formatFollowupPanelText(state.displays, state.heading);
  const markup = withButtons ? panelKeyboard(state) : emptyKeyboard();
  try {
    await ctx.editMessageText(text, { reply_markup: markup });
  } catch {
    await ctx
      .editMessageReplyMarkup({ reply_markup: markup })
      .catch(() => undefined);
  }
}

function panelFromMessage(ctx: Context): PanelState | undefined {
  const message = ctx.callbackQuery?.message;
  if (!message) {
    return undefined;
  }
  return panels.get(message.message_id);
}

async function sendPanel(
  api: Api,
  records: FollowupRecord[],
  heading?: string,
): Promise<void> {
  const displays = await displaysForFollowups(records);
  const state: PanelState = {
    heading,
    expandedId: null,
    displays,
  };
  const text = formatFollowupPanelText(displays, heading);
  const hasButtons = displays.length > 0;
  const message = await api.sendMessage(config.ownerTelegramId, text, {
    reply_markup: hasButtons ? panelKeyboard(state) : undefined,
  });
  if (hasButtons) {
    panels.set(message.message_id, state);
  }
  console.log(`Follow-up panel sent: threads=${displays.length}`);
}

export async function sendActiveFollowupPanel(
  api: Api,
  heading?: string,
): Promise<void> {
  await sendPanel(api, activeFollowups(), heading);
}

/** Phase 4 dispatcher: pure-SQL due check, then one contextual Telegram
 *  message per due follow-up, each with a single [Draft Follow-up] inline
 *  button. Advances the backoff after each send so the row won't fire again
 *  until the next scheduled check. */
export async function sendOverdueFollowupNudge(api: Api): Promise<void> {
  const due = dueFollowupsNow();
  if (due.length === 0) {
    return;
  }
  const accounts = decodedAccounts();
  let sent = 0;
  for (const followup of due) {
    const recipientLabel = formatToLine(followup.recipient, accounts).replace(
      /^To:\s*/,
      "",
    );
    const text = buildNudgeMessage(followup, recipientLabel);
    const keyboard = new InlineKeyboard().text(
      "Draft follow-up",
      `fu:d:${followup.id}`,
    );
    try {
      await api.sendMessage(config.ownerTelegramId, text, {
        reply_markup: keyboard,
      });
      markFollowupNudged(followup);
      sent += 1;
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      console.error(
        `Follow-up ${followup.id}: nudge send failed (${errorType})`,
      );
    }
  }
  console.log(`Follow-up nudges dispatched: due=${due.length}, sent=${sent}`);
}

export async function sendWaitingOnPanel(api: Api): Promise<void> {
  await sendActiveFollowupPanel(api, "Waiting on");
}

export async function handleFollowupCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const message = ctx.callbackQuery?.message;
  if (!message || !data.startsWith("fu:")) {
    return;
  }

  let state = panels.get(message.message_id);
  if (!state) {
    const displays = await displaysForFollowups(activeFollowups());
    state = { expandedId: null, displays };
    panels.set(message.message_id, state);
  }

  if (data === "fu:c") {
    await ctx.answerCallbackQuery();
    state.expandedId = null;
    await editPanel(ctx, state, false);
    panels.delete(message.message_id);
    return;
  }

  if (data === "fu:b") {
    await ctx.answerCallbackQuery();
    state.expandedId = null;
    await editPanel(ctx, state, true);
    return;
  }

  const expand = /^fu:a:(\d+)$/.exec(data);
  if (expand) {
    await ctx.answerCallbackQuery();
    const id = Number(expand[1]);
    state.expandedId = state.expandedId === id ? null : id;
    await editPanel(ctx, state, true);
    return;
  }

  const action = /^fu:([dszt]):(\d+)$/.exec(data);
  if (!action) {
    await ctx.answerCallbackQuery();
    return;
  }
  const kind = action[1];
  const id = Number(action[2]);
  let answered = false;

  try {
    if (kind === "z") {
      const result = snoozeFollowupThreeDays(id);
      if (!result) {
        await ctx.answerCallbackQuery({
          text: "Could not snooze that thread.",
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery("Snoozed");
      setNote(state, id, `Snoozed until ${formatSnoozeUntil(result.until)}`);
      state.expandedId = null;
      await editPanel(ctx, state, true);
      return;
    }

    if (kind === "t") {
      if (!stopTrackingFollowup(id)) {
        await ctx.answerCallbackQuery({
          text: "Could not stop tracking that thread.",
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery("Stopped");
      setNote(state, id, "Stopped tracking");
      state.expandedId = null;
      await editPanel(ctx, state, true);
      return;
    }

    await ctx.answerCallbackQuery(
      kind === "s" ? "Preparing send preview" : "Drafting",
    );
    answered = true;
    await createFollowupDraftForApproval(id, kind === "s");
    setNote(state, id, "Draft ready");
    state.expandedId = null;
    await editPanel(ctx, state, true);
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Follow-up action failed (${errorType})`);
    if (error instanceof FollowupDraftLlmError) {
      // Row stays in `waiting`, so the next scheduled scan or a retap retries.
      if (answered) {
        await ctx.reply(error.message);
      } else {
        await ctx.answerCallbackQuery({
          text: "Drafting failed. See chat for details.",
          show_alert: true,
        });
        await ctx.reply(error.message);
      }
      return;
    }
    if (answered) {
      await ctx.reply("That action failed. Try again.");
      return;
    }
    await ctx.answerCallbackQuery({
      text: "That action failed. Try again.",
      show_alert: true,
    });
  }
}
