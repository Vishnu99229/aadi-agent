export function quotedMessageText(
  reply: { text?: string; caption?: string } | undefined,
): string {
  if (!reply) {
    return "";
  }
  return (reply.text ?? reply.caption ?? "").trim();
}

export function withQuotedContext(userText: string, quoted: string): string {
  const quote = quoted.trim();
  if (!quote) {
    return userText;
  }
  return `Vishnu is replying to this earlier message from you:\n"""\n${quote}\n"""\n\n${userText}`;
}
