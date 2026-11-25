import { InlineKeyboard, type Api } from "grammy";
import { config } from "./config.js";
import { recordCardRecipients } from "./db.js";
import { formatMailbox } from "./draft_recipients.js";
import { parseAddressList, type ParsedMailbox } from "./mail_helpers.js";
import { recipientFingerprint } from "./security/send_decision.js";
import { CARD_CAPTION_CHARS, holdForVoiceNote } from "./voice_cards.js";

/**
 * The one way to post a Telegram card whose button can confirm who an email goes to: a
 * draft's Send, a held schedule's Confirm, an address choice. It is given the exact
 * addresses its buttons will confirm, writes them into the card's own text (and the
 * caption a voice note would carry), and records that same list for the posted message,
 * only once Telegram has confirmed the post or edit. No other code builds those buttons.
 */
export type ConfirmCardSpec =
  | {
      kind: "draft_send";
      /** The Gmail draft: its posted cards are recorded under it. */
      key: string;
      actionId: number;
      sendOnly: boolean;
      showFull: boolean;
      to: string;
      cc: string;
      /** "Cc: none" on the full card; the short card leaves the line out. */
      ccWhenEmpty: "none" | "omit";
      /** The lines above To and Cc. */
      head: readonly string[];
      /** Everything below To and Cc, as it reads. */
      tail: string;
      /** The caption's lines after To and Cc. */
      captionTail: readonly string[];
    }
  | { kind: "schedule_confirm"; scheduleId: number; to: string; cc: string; headline: string }
  | { kind: "address_choice"; choiceId: number; options: readonly ParsedMailbox[]; headline: string }
  | { kind: "schedule_pick"; scheduleId: number; slotIndex: number; options: readonly ParsedMailbox[]; headline: string };

export interface RenderedConfirmCard {
  text: string;
  caption: string;
  keyboard: InlineKeyboard;
  /** Every address a button on this card can confirm, all written in text and caption. */
  confirms: string[];
  /** What the posted message's recipients are recorded under. */
  key: string;
}

/** The callback a draft card's Send button carries (also what a text "send it" checks). */
export function draftSendCallback(actionId: number): string {
  return `approval:send:${actionId}`;
}

/** What a held schedule's cards and their posted messages are recorded under. */
export function scheduleCardKey(scheduleId: number): string {
  return `schedule:${scheduleId}`;
}

/** What an address-choice card's posted message is recorded under. */
export function choiceCardKey(choiceId: number): string {
  return `choice:${choiceId}`;
}

function emails(header: string): string[] {
  return parseAddressList(header).map((item) => item.email.toLowerCase());
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

function draftKeyboard(actionId: number, sendOnly: boolean, showFull: boolean): InlineKeyboard {
  const keys = new InlineKeyboard();
  if (showFull) {
    keys.text("📄 Show Full Draft", `approval:draft:${actionId}`).row();
  }
  if (sendOnly) {
    return keys.text("Send", draftSendCallback(actionId)).row().text("Cancel", `approval:discard:${actionId}`);
  }
  return keys
    .text("Send", draftSendCallback(actionId))
    .text("Edit", `approval:edit:${actionId}`)
    .text("Discard", `approval:discard:${actionId}`);
}

function scheduleConfirmKeyboard(scheduleId: number, confirms: readonly string[]): InlineKeyboard {
  return new InlineKeyboard()
    .text("Confirm", `cmdsend:confirmsched:${scheduleId}:${recipientFingerprint(confirms)}`)
    .text("Cancel", `cmdsend:cancelsched:${scheduleId}`);
}

function choiceKeyboard(choiceId: number, options: readonly ParsedMailbox[]): InlineKeyboard {
  const keys = new InlineKeyboard();
  options.forEach((option, index) => {
    keys.text(formatMailbox(option).slice(0, 60), `cmdsend:pick:${choiceId}:${index}`).row();
  });
  return keys.text("Don't send", `cmdsend:drop:${choiceId}`);
}

function pickKeyboard(scheduleId: number, slotIndex: number, options: readonly ParsedMailbox[]): InlineKeyboard {
  const keys = new InlineKeyboard();
  options.forEach((option, index) => {
    keys.text(formatMailbox(option).slice(0, 60), `cmdsend:hold:${scheduleId}:${slotIndex}:${index}`).row();
  });
  return keys.text("Cancel", `cmdsend:cancelsched:${scheduleId}`);
}

function fit(text: string, room: number): string {
  if (room < 2) {
    return "";
  }
  return text.length <= room ? text : `${text.slice(0, room - 1)}…`;
}

/** A voice note's caption: the lead (the question), the people, then the rest. The people
 *  are never cut; the lead and the rest get what room is left, in that order. */
function captionOf(lead: readonly string[], people: readonly string[], rest: readonly string[]): string {
  const middle = people.join("\n");
  const leadText = lead.join("\n").trim();
  const restText = rest.join("\n").trim();
  const before = fit(leadText, CARD_CAPTION_CHARS - middle.length - 1);
  const after = fit(restText, CARD_CAPTION_CHARS - middle.length - (before ? before.length + 1 : 0) - 1);
  return [before, middle, after].filter(Boolean).join("\n");
}

function recipientLines(to: string, cc: string, ccWhenEmpty: "none" | "omit"): string[] {
  return [`To: ${to}`, ...(cc ? [`Cc: ${cc}`] : ccWhenEmpty === "none" ? ["Cc: none"] : [])];
}

export function renderConfirmCard(spec: ConfirmCardSpec): RenderedConfirmCard {
  switch (spec.kind) {
    case "draft_send": {
      const cc = spec.cc.trim();
      return {
        text: `${[...spec.head, ...recipientLines(spec.to, cc, spec.ccWhenEmpty)].join("\n")}\n${spec.tail}`,
        caption: captionOf([], [`Draft to ${spec.to}`, ...(cc ? [`Cc: ${cc}`] : [])], spec.captionTail),
        keyboard: draftKeyboard(spec.actionId, spec.sendOnly, spec.showFull),
        confirms: unique([...emails(spec.to), ...emails(cc)]),
        key: spec.key,
      };
    }
    case "schedule_confirm": {
      const cc = spec.cc.trim();
      const confirms = unique([...emails(spec.to), ...emails(cc)]);
      const people = recipientLines(spec.to, cc, "omit");
      return {
        text: [spec.headline, ...people].join("\n"),
        caption: captionOf([spec.headline], people, []),
        keyboard: scheduleConfirmKeyboard(spec.scheduleId, confirms),
        confirms,
        key: scheduleCardKey(spec.scheduleId),
      };
    }
    case "address_choice":
    case "schedule_pick": {
      const people = spec.options.map((option) => formatMailbox(option));
      return {
        text: [spec.headline, ...people].join("\n"),
        caption: captionOf([spec.headline], people, []),
        keyboard:
          spec.kind === "address_choice"
            ? choiceKeyboard(spec.choiceId, spec.options)
            : pickKeyboard(spec.scheduleId, spec.slotIndex, spec.options),
        confirms: unique(spec.options.map((option) => option.email.toLowerCase())),
        key: spec.kind === "address_choice" ? choiceCardKey(spec.choiceId) : scheduleCardKey(spec.scheduleId),
      };
    }
  }
}

/**
 * Posts (or, with editMessageId, edits) the card and records who it shows once Telegram
 * confirms. In a spoken turn it waits for the voice note and is recorded against it.
 * Returns the message id, or undefined while it waits for a voice note. Throws if
 * Telegram refuses: then nothing new counts as shown.
 */
export async function postConfirmCard(
  spec: ConfirmCardSpec,
  options: { api: Api; editMessageId?: number; onShown?: (messageId: number) => void },
): Promise<number | undefined> {
  const card = renderConfirmCard(spec);
  const shown = (messageId: number): void => {
    recordCardRecipients(messageId, card.key, card.confirms.join(","));
    options.onShown?.(messageId);
  };
  if (options.editMessageId !== undefined) {
    await options.api.editMessageText(config.ownerTelegramId, options.editMessageId, card.text, {
      reply_markup: card.keyboard,
    });
    shown(options.editMessageId);
    return options.editMessageId;
  }
  if (holdForVoiceNote({ text: card.text, caption: card.caption, keyboard: card.keyboard, onPosted: shown })) {
    return undefined;
  }
  const message = await options.api.sendMessage(config.ownerTelegramId, card.text, { reply_markup: card.keyboard });
  shown(message.message_id);
  return message.message_id;
}
