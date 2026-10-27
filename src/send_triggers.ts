const EXACT_SEND = /^send(?:\s+it)?[.!]*$/i;
const AMBIGUOUS_ACK = /^(ok|okay|k|kk)[.!]*$/i;

/** Fast path for the one unmistakable phrase. Everything else that means
 *  "send" is read by the model. */
export function isSendDraftCommand(text: string): boolean {
  return EXACT_SEND.test(text.trim());
}

/** Bare acknowledgements. confirm_send_pending_draft must refuse these even
 *  if the model calls it — they are not a send. */
export function isAmbiguousSendAck(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  return AMBIGUOUS_ACK.test(text.trim());
}
