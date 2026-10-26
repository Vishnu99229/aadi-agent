const SEND_DRAFT_COMMAND =
  /^(?:yes,?\s+)?(?:please\s+)?(?:go\s+ahead\s+and\s+)?send(?:\s+(?:it|this|the\s+(?:email|draft)))?[.!?]*$/i;

export function isSendDraftCommand(text: string): boolean {
  return SEND_DRAFT_COMMAND.test(text.trim());
}
