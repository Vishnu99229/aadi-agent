const EXACT_SEND = /^send(?:\s+it)?[.!]*$/i;

/** Fast path for the one unmistakable phrase. Everything else that means
 *  "send" is read by the model. */
export function isSendDraftCommand(text: string): boolean {
  return EXACT_SEND.test(text.trim());
}
