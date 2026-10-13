export function isWrapUpText(text: string): boolean {
  const trimmed = text.trim();
  return /^(call notes|meeting notes|wrap up)\b/i.test(trimmed);
}

export function stripWrapUpPrefix(text: string): string {
  return text.replace(/^(call notes|meeting notes|wrap up)[:\s-]*/i, "").trim();
}
