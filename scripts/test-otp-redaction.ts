/**
 * One-time codes in the shared redactor (otp_redaction.ts via redactAllSecrets):
 * a code next to a code word is redacted in every common phrasing, and plain
 * numbers (phone numbers, ₹ amounts, dates, invoice numbers, meeting IDs) are not.
 * The same rule covers fold-summary input, embedding text and memory.
 */
import { buildSummarizerInput, redactAllSecrets } from "../src/chat_history.ts";
import type { StoredMessage } from "../src/db.ts";
import { redactForEmbed } from "../src/embeddings.ts";
import { isSensitiveMemoryText } from "../src/memory_logic.ts";
import { hasOtpCode, redactOtpCodes } from "../src/otp_redaction.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const passed: string[] = [];

// ---------------------------------------------------------------- redacted
const REDACTED: Array<[string, string[]]> = [
  ["Your OTP is 482913", ["482913"]],
  ["OTP: 482913", ["482913"]],
  ["OTP-482913 for your login", ["482913"]],
  ["OTP482913", ["482913"]],
  ["Your OTP is 482-913", ["482-913", "913"]],
  ["OTP 482 913, valid 5 minutes", ["482 913", "913"]],
  ["482913 is your OTP for login", ["482913"]],
  ["Use 551204 as your verification code", ["551204"]],
  ["Your one-time password is 482913.", ["482913"]],
  ["one time code: 7731", ["7731"]],
  ["Verification code: 551204", ["551204"]],
  ["Your security code is 7731", ["7731"]],
  ["PIN: 4821", ["4821"]],
  ["Your PIN is 4821", ["4821"]],
  ["auth code 99120344", ["99120344"]],
  ["2FA code: 662301", ["662301"]],
  ["Your login code 778899", ["778899"]],
  ["Passcode: 4417", ["4417"]],
  ["Your OTP for the Pinnacle portal login is 482913", ["482913"]],
  ["आपका OTP 482913 है। इसे किसी से साझा न करें।", ["482913"]],
  ["482913 आपका OTP है", ["482913"]],
  ["നിങ്ങളുടെ OTP 482913 ആണ്.", ["482913"]],
];
for (const [text, secrets] of REDACTED) {
  const out = redactAllSecrets(text);
  const leaked = secrets.filter((secret) => out.includes(secret));
  assert(leaked.length === 0 && out.includes("[redacted]"), `"${text}" -> "${out}" (leaked ${leaked.join(",")})`);
  assert(hasOtpCode(text), `hasOtpCode("${text}")`);
}
passed.push(`${REDACTED.length} OTP phrasings redacted: OTP/one-time/passcode/verification/security/auth/login code, PIN, 2FA, split codes, Hindi and Malayalam`);

// A real bank SMS and a Zoom invite: only the code goes.
{
  const sms = "Rs. 4,500 debited from a/c XX1234 on 21-11-2026. OTP 482913 valid for 10 mins. Call 1800-123-4567.";
  const out = redactAllSecrets(sms);
  assert(!out.includes("482913"), `the OTP in the SMS is redacted (${out})`);
  for (const keep of ["Rs. 4,500", "XX1234", "21-11-2026", "10 mins", "1800-123-4567"]) {
    assert(out.includes(keep), `the SMS keeps "${keep}" (${out})`);
  }
  for (const invite of ["Meeting ID: 812 3456 7890\nPasscode: 482913", "Join: meeting ID 812 3456 7890 passcode 482913"]) {
    const redacted = redactAllSecrets(invite);
    assert(redacted.includes("812 3456 7890") && !redacted.includes("482913"), `the meeting ID stays and the passcode goes (${JSON.stringify(redacted)})`);
  }
}
passed.push("a bank SMS keeps its amount, account tail, date and helpline; a Zoom invite keeps its meeting ID; only the code goes");

// ---------------------------------------------------------------- not redacted
const UNCHANGED = [
  "Call me on 98450 12345 or 9845012345",
  "Landline 080 4123 4567, ext 2210",
  "Paid ₹4,500 and ₹ 12000 to Pinnacle; Rs. 7500 pending; INR 2400 and 3500 rupees later",
  "Due 21/11/2026, 2026-11-21, 21.11.2026 or 21 Nov 2026 at 10:30",
  "Invoice INV-48213, order #482913 and PO 55123 are paid",
  "Join Zoom meeting ID 812 3456 7890 at 4pm",
  "Ship to Indiranagar, Bengaluru, PIN code 560038",
  "Pincode: 560038",
  "We grew 4500% in 2026",
  "The meeting is at 3pm",
];
for (const text of UNCHANGED) {
  assert(redactOtpCodes(text) === text, `"${text}" is untouched by the OTP rule (${redactOtpCodes(text)})`);
  assert(redactAllSecrets(text) === text, `"${text}" is untouched by redactAllSecrets (${redactAllSecrets(text)})`);
  assert(!hasOtpCode(text), `hasOtpCode is false for "${text}"`);
}
passed.push(`${UNCHANGED.length} plain-number texts untouched: phone numbers, ₹/Rs/INR amounts, dates and times, invoice/order/PO numbers, meeting IDs, postal PIN codes`);

// ---------------------------------------------------------------- everywhere the shared redactor runs
{
  const stored: StoredMessage[] = [
    { id: 1, role: "user", content: "Your verification code is 551204, use it now", created_at: "2026-11-21 08:00:00", tool_name: null } as StoredMessage,
    { id: 2, role: "assistant", content: "Got it. 482913 is your OTP for the portal.", created_at: "2026-11-21 08:00:05", tool_name: null } as StoredMessage,
  ];
  const fold = buildSummarizerInput(stored, "");
  assert(!fold.includes("551204") && !fold.includes("482913"), `fold-summary input carries no code (${fold})`);
  const embed = redactForEmbed("आपका OTP 482913 है");
  assert(!embed.includes("482913"), `embedding text carries no code (${embed})`);
  assert(isSensitiveMemoryText("Verification code 551204 for the Pinnacle portal"), "memory refuses a fact with a code");
  assert(isSensitiveMemoryText("Your login code 778899"), "in any phrasing the shared rule knows");
  assert(!isSensitiveMemoryText("Pinnacle invoice INV-48213 is due 21 Nov 2026"), "but still stores a plain fact with numbers");
}
passed.push("the same rule covers fold-summary input, embedding text and memory");

console.log(passed.map((line) => `  ok  ${line}`).join("\n"));
console.log("test-otp-redaction: ok");
