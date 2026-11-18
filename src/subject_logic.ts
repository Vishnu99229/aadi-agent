/** A subject without its reply and forward prefixes, for comparing conversations. */
export function conversationSubject(subject: string): string {
  return subject
    .replace(/^\s*(?:(?:re|fwd?|fw|aw|sv)\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Whether a subject still belongs to the thread's conversation. Gmail keeps a reply in a
 * thread only while the subject matches, so a different one starts a new conversation.
 */
export function sameConversation(subject: string, threadSubject: string): boolean {
  return conversationSubject(subject) === conversationSubject(threadSubject);
}
