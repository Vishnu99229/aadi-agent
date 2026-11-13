import { InlineKeyboard } from "grammy";
import { scheduledSendsPanel } from "./scheduled_sends.js";
import { sequencesPanel } from "./sequence_runner.js";

/**
 * Everything Aadi is due to send without another tap: active follow-up
 * sequences and emails scheduled for later. One view, with the same Stop and
 * Cancel buttons each list already had.
 */
export function outboxPanel(now = new Date()): { text: string; keyboard: InlineKeyboard | undefined } {
  const sequences = sequencesPanel(now);
  const scheduled = scheduledSendsPanel();
  const keyboard = new InlineKeyboard();
  for (const panel of [scheduled, sequences]) {
    for (const row of panel.keyboard?.inline_keyboard ?? []) {
      for (const button of row) {
        if ("callback_data" in button && typeof button.callback_data === "string") {
          keyboard.text(button.text, button.callback_data);
        }
      }
      keyboard.row();
    }
  }
  const text = [
    "Outbox",
    "",
    "Scheduled emails",
    scheduled.text,
    "",
    "Follow-up sequences",
    sequences.text,
  ].join("\n");
  return { text, keyboard: keyboard.inline_keyboard.some((row) => row.length > 0) ? keyboard : undefined };
}
