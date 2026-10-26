const SEND_DRAFT_COMMAND =
  /^(?:(?:yes|ok|okay|done|looks\s+good),?\s+)?(?:please\s+)?(?:go\s+ahead\s+and\s+)?send(?:\s+(?:it|this|(?:the\s+)?(?:email|mail|draft)))?[.!?]*$/i;

const AMBIGUOUS_SEND_COMMAND = /^done[.!?]*$/i;

export function isSendDraftCommand(text: string): boolean {
  return SEND_DRAFT_COMMAND.test(text.trim());
}

/** Words that mean "send" only right after a draft was shown. */
export function isAmbiguousSendCommand(text: string): boolean {
  return AMBIGUOUS_SEND_COMMAND.test(text.trim());
}
