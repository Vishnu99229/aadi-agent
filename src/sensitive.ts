/** Remove card and account numbers from untrusted email snippets. */
export function stripSensitive(text: string): string {
  return text
    .replace(/\b(?:\d[ \-]*){13,19}\b/g, "[REDACTED]")
    .replace(
      /\b(?:A\/C|Account(?:\s+No)?|Acct)[#:\s]*[0-9][0-9\- ]{5,}[0-9]\b/gi,
      "[REDACTED]",
    )
    .replace(/\bIFSC[:\s]*[A-Z]{4}0[A-Z0-9]{6}\b/gi, "[REDACTED]");
}
