/** A settings change said in plain words, so it needs no model call. */
export type SettingPhrase =
  | { kind: "voice"; on: boolean }
  | { kind: "keyboard"; on: boolean }
  | { kind: "panel" };

const VOICE = "(?:the\\s+)?(?:voice|spoken)\\s+(?:repl(?:ies|y)|answers?|responses?)";

/** Only whole, unambiguous messages match: anything else is left to the model. */
export function parseSettingPhrase(text: string): SettingPhrase | undefined {
  const clean = text.trim().replace(/[.!]+$/, "");
  let match = new RegExp(`^(?:please\\s+)?(?:turn|switch)\\s+${VOICE}\\s+(on|off)(?:\\s+please)?$`, "i").exec(clean);
  if (match) {
    return { kind: "voice", on: match[1]!.toLowerCase() === "on" };
  }
  match = new RegExp(`^(?:please\\s+)?(?:turn|switch)\\s+(on|off)\\s+${VOICE}(?:\\s+please)?$`, "i").exec(clean);
  if (match) {
    return { kind: "voice", on: match[1]!.toLowerCase() === "on" };
  }
  if (new RegExp(`^(?:please\\s+)?(?:stop|disable)\\s+${VOICE}$`, "i").test(clean)) {
    return { kind: "voice", on: false };
  }
  if (new RegExp(`^(?:please\\s+)?(?:enable|start)\\s+${VOICE}$`, "i").test(clean)) {
    return { kind: "voice", on: true };
  }
  match = /^(?:please\s+)?(show|hide)\s+(?:the\s+|my\s+)?keyboard$/i.exec(clean);
  if (match) {
    return { kind: "keyboard", on: match[1]!.toLowerCase() === "show" };
  }
  if (/^(?:please\s+)?(?:show|open)\s+(?:me\s+)?(?:my\s+|the\s+)?settings$/i.test(clean)) {
    return { kind: "panel" };
  }
  return undefined;
}
