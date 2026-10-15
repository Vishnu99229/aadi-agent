const DEFERRED_ACTION =
  /\b(?:let me (?:check|look|find|search|see)|i['’]ll (?:check|look|find|search|see)|i will (?:check|look|find|search|see))\b/i;

export function looksLikeDeferredAction(text: string): boolean {
  return DEFERRED_ACTION.test(text);
}
