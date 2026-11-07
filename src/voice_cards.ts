import { AsyncLocalStorage } from "node:async_hooks";
import type { Api, InlineKeyboard } from "grammy";

/** A card a tool would post during a turn: its full text, the short text its
 *  buttons need, and its buttons. */
export interface VoiceCard {
  text: string;
  caption: string;
  keyboard?: InlineKeyboard;
  /** Told the Telegram message the card ended up on, so later taps can edit it. */
  onPosted?: (messageId: number) => void;
  posted?: boolean;
}

interface Collector {
  cards: VoiceCard[];
  open: boolean;
}

const store = new AsyncLocalStorage<Collector>();

/** For a spoken turn: cards made while it runs wait for Aadi's voice note. */
export function collectVoiceCards(): {
  run<T>(work: () => Promise<T>): Promise<T>;
  close(): VoiceCard[];
} {
  const collector: Collector = { cards: [], open: true };
  return {
    run: (work) => store.run(collector, work),
    close: () => {
      collector.open = false;
      return collector.cards.splice(0);
    },
  };
}

/** True when a spoken turn took the card, to go on its voice note. False when there
 *  is none, or it has already answered, and the caller posts the card itself. */
export function holdForVoiceNote(card: VoiceCard): boolean {
  const collector = store.getStore();
  if (!collector?.open) {
    return false;
  }
  collector.cards.push(card);
  return true;
}

/** A card on a message of its own, the way it would have been without a voice turn. */
export async function postCard(api: Api, chatId: number, card: VoiceCard): Promise<void> {
  const message = await api.sendMessage(
    chatId,
    card.text,
    card.keyboard ? { reply_markup: card.keyboard } : {},
  );
  card.posted = true;
  card.onPosted?.(message.message_id);
}

/** At most this much of a card's own text goes in a caption. */
export const CARD_CAPTION_CHARS = 450;

export function shortCardText(text: string): string {
  const clean = text.trim();
  return clean.length <= CARD_CAPTION_CHARS ? clean : `${clean.slice(0, CARD_CAPTION_CHARS - 1)}…`;
}
