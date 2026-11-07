import "dotenv/config";
import { runAgent, setToolInterceptorForTests } from "../src/agent.ts";
import {
  COMMAND_TOOLS,
  commandIntents,
  commandNotRunMessage,
  echoesEarlierReply,
  sequenceTargets,
} from "../src/command_intent.ts";
import { getRecentMessages, saveMessage } from "../src/db.ts";
import {
  backendForcesTools,
  openAiToolChoice,
  setCompleteForTests,
  type CompleteParams,
  type ToolCall,
} from "../src/llm.ts";
import { FORWARDED_TOOLS, tools, type ToolTurn } from "../src/tools/index.ts";
import { modelReply } from "./fakes.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("test-command-guarantee.ts must run with AADI_DB_PATH=:memory:");
}

const log = console.log;
console.log = () => undefined;
console.error = () => undefined;

// ---- which messages are commands ----
const commands: Array<[string, string]> = [
  ["Start a sequence for Dorothy Copeland.", "sequence"],
  ["start a sequence for dorothy.copeland@nice.com", "sequence"],
  ["Can you auto follow up with Jeff Comstock", "sequence"],
  ["Send Jeff an email saying we're on for Monday", "send"],
  ["send a reply to Munil saying thanks", "send"],
  ["Reply to Munil saying thanks", "send"],
  ["Email Selvaraj about the invoice", "send"],
  ["please email Priya the deck link", "send"],
  ["Book a meeting with Jeff tomorrow at 3", "calendar"],
  ["Schedule a call with Dorothy on Monday", "calendar"],
  ["Cancel my call with Dorothy", "calendar"],
  ["Move the demo with Talkdesk to Friday", "calendar"],
  ["Block my calendar Friday 2-4", "calendar"],
  ["Add Dorothy to the meeting", "calendar"],
  ["create an event tomorrow 4pm", "calendar"],
];
for (const [text, kind] of commands) {
  const kinds = commandIntents(text);
  assert(kinds.includes(kind as never), `"${text}" is a ${kind} command, got ${kinds.join(",") || "none"}`);
}
const notCommands = [
  "what did Jeff's email say?",
  "send me the summary of Jeff's email",
  "send me the list of my tasks",
  "Email from Jeff - summarize it",
  "did I start a sequence for Jeff?",
  "don't start a sequence for Jeff",
  "should I start a sequence for Jeff?",
  "remind me to email Jeff",
  "remind me to book a meeting with Jeff",
  "draft an email to Jeff",
  "Should I email Jeff?",
  "did you send the email to Munil?",
  "I'll email Jeff later",
  "remove the call recording",
  "add a note to the meeting",
  "What meetings do I have today?",
  "when is my call with Dorothy?",
  "propose a meeting with Jeff next week",
  "follow up on my email to Jeff",
  "how's the weather",
];
for (const text of notCommands) {
  const kinds = commandIntents(text);
  assert(kinds.length === 0, `"${text}" is not a command, got ${kinds.join(",")}`);
}
assert(commandIntents("Book a call with Jeff on Monday. Email him the agenda.").join(",") === "send,calendar", "one message can hold two commands");

// ---- who a sequence request names ----
assert(JSON.stringify(sequenceTargets("Start a sequence for Dorothy Copeland.")) === '["Dorothy Copeland"]', "a name");
assert(JSON.stringify(sequenceTargets("start a sequence for dorothy.copeland@nice.com please")) === '["dorothy.copeland@nice.com"]', "an address, filler dropped");
assert(JSON.stringify(sequenceTargets("Auto follow up with Jeff at NICE")) === '["Jeff at NICE"]', "auto follow up");
assert(
  JSON.stringify(sequenceTargets("Start a sequence for Munil Shah. Start a sequence for Jeff Comstock too.")) === '["Munil Shah","Jeff Comstock"]',
  "one target per request",
);
for (const vague of ["start a sequence for her", "Start a sequence for the other person also", "start a sequence for them", "Start a sequence from Dorothy for Coplan"]) {
  assert(sequenceTargets(vague) === undefined, `"${vague}" is left to the model`);
}

// ---- what counts as repeating an earlier answer ----
const OLD =
  "Not started for dorothy.copeland@nice.com ('Re: Exploring a Telephony Technology Partnership with NiCE'): that person or company already has an open sequence.";
assert(echoesEarlierReply(`${OLD}\n\nSame block again.`, [`${OLD}\n\nSixth try.`], []), "an old answer with a new tail is an echo");
assert(!echoesEarlierReply(`${OLD}\n\nSame block.`, [OLD], [OLD]), "the same words from a tool that ran now aren't an echo");
assert(!echoesEarlierReply("Start card sent for Dorothy.", [OLD], ["Start card sent for Dorothy."]), "a fresh answer isn't an echo");
assert(!echoesEarlierReply("Done.", ["Done."], []), "a very short reply can't be told apart, so it isn't judged");
{
  const card = "Start card sent for Dorothy Copeland <dorothy.copeland@nice.com>. Nothing is enrolled unless Vishnu taps Start.";
  const worded = "Start card sent for Dorothy Copeland. Nothing is enrolled until you tap Start.";
  assert(!echoesEarlierReply(worded, [worded, card], [card], [card]), "the same outcome as last time may be worded the same");
  assert(echoesEarlierReply(OLD, [OLD], [card], [OLD]), "an old refusal over a new result is an echo");
}

// ---- forced tool calls by backend ----
assert(backendForcesTools("deepseek") && backendForcesTools("gemini"), "DeepSeek and Gemini take a forced call");
assert(!backendForcesTools("claude") && !backendForcesTools("haiku"), "Claude rejects tool_choice, so it is never sent");
assert(JSON.stringify(openAiToolChoice({ name: "start_sequence" })) === '{"type":"function","function":{"name":"start_sequence"}}', "named choice");
assert(openAiToolChoice(undefined) === undefined, "no choice by default");

// ---- the agent loop ----
const confirmation = { chatId: 1, messageId: 100 };
let nextMessage = 100;
const ran: Array<{ name: string; input: unknown; turn: ToolTurn }> = [];
let freshCount = 0;
setToolInterceptorForTests((call: ToolCall, turn: ToolTurn) => {
  ran.push({ name: call.name, input: call.input, turn });
  // Every call, the model's or code's, must fit the real tool's schema.
  const required = (tools[call.name]?.definition.inputSchema.required ?? []) as string[];
  for (const key of required) {
    assert(
      call.input !== null && typeof call.input === "object" && key in (call.input as Record<string, unknown>),
      `${call.name} was called without its required "${key}": ${JSON.stringify(call.input)}`,
    );
  }
  if (call.name === "start_sequence") {
    freshCount += 1;
    return `Start card sent for Dorothy Copeland <dorothy.copeland@nice.com> ('Re: Exploring a Telephony Technology Partnership with NiCE'), check ${freshCount}. Nothing is enrolled unless Vishnu taps Start.`;
  }
  if (call.name === "send_email") {
    return "Sent to Jeff Comstock <jeff.comstock@nice.com>: Monday is on.";
  }
  return "ok";
});

/** A model that, like DeepSeek on 7 Nov, answers a repeated request by pasting
 *  the newest earlier answer, and calls a tool only when the API forces it. */
let honoursForcing = true;
let callsWhenAsked: string | undefined;
const seen: CompleteParams[] = [];
setCompleteForTests(async (params) => {
  seen.push(params);
  if (params.tools.length === 0) {
    return modelReply({ text: '{"facts":[]}' });
  }
  const forced = params.toolChoice;
  if (forced && honoursForcing && typeof forced === "object") {
    return modelReply({ tools: [{ name: forced.name, input: { prospect: "Dorothy Copeland" } }] });
  }
  const last = params.messages.at(-1);
  if (callsWhenAsked && last?.role === "user" && String(last.content).includes("looks like a command")) {
    return modelReply({ tools: [{ name: callsWhenAsked, input: { to: ["Jeff"], instruction: "Monday is on" } }] });
  }
  const earlier = params.messages
    .filter((message) => message.role === "assistant" && message.textParts.length > 0)
    .at(-1);
  return modelReply({ text: earlier && earlier.role === "assistant" ? earlier.textParts.join("\n") : OLD });
});

async function say(text: string, options: { backend?: "deepseek" | "claude"; forwarded?: boolean } = {}): Promise<string> {
  nextMessage += 1;
  return runAgent(text, {
    guardText: text,
    backend: options.backend ?? "deepseek",
    ...(options.forwarded
      ? { toolNames: FORWARDED_TOOLS, sendConfirmation: undefined }
      : { sendConfirmation: { ...confirmation, messageId: nextMessage } }),
  });
}

function reset(): void {
  ran.length = 0;
  seen.length = 0;
  honoursForcing = true;
  callsWhenAsked = undefined;
}

// The old refusal is in the history, as it was on the phone.
saveMessage("user", "Start a sequence for Dorothy Copeland.");
saveMessage("assistant", `${OLD}\n\nSixth try, same block.`);

// DeepSeek: the API forces start_sequence, and every repeat runs the check again.
for (let attempt = 1; attempt <= 3; attempt += 1) {
  reset();
  const before = freshCount;
  const reply = await say("Start a sequence for Dorothy Copeland.");
  assert(freshCount === before + 1, `attempt ${attempt}: the check ran exactly once, ran=${freshCount - before}`);
  assert(ran.every((item) => item.name === "start_sequence"), "only start_sequence ran");
  const first = seen.find((params) => params.tools.length > 0)!;
  assert(JSON.stringify(first.toolChoice) === '{"name":"start_sequence"}', "the first step forces start_sequence");
  assert(reply.includes(`check ${freshCount}`), `attempt ${attempt}: the reply is this turn's result, got: ${reply}`);
  assert(!reply.includes("already has an open sequence"), `attempt ${attempt}: the old refusal is never repeated`);
}
assert(ran[0]!.turn.confirmation?.messageId === nextMessage, "the check runs on his own message's confirmation");

// Claude can't be forced, and this model never calls a tool on its own: code runs the check.
for (let attempt = 1; attempt <= 2; attempt += 1) {
  reset();
  honoursForcing = false;
  const before = freshCount;
  const reply = await say("start a sequence for Dorothy Copeland", { backend: "claude" });
  assert(seen.every((params) => params.toolChoice === undefined), "Claude is never sent tool_choice");
  assert(freshCount === before + 1, `claude attempt ${attempt}: code ran the check once`);
  assert(JSON.stringify(ran[0]!.input) === '{"prospect":"Dorothy Copeland"}', "with the name from his own words, in the tool's own input field");
  assert(ran[0]!.turn.userText === "start a sequence for Dorothy Copeland", "and his words as the guard text");
  assert(reply.includes(`check ${freshCount}`) && !reply.includes("already has an open sequence"), `claude attempt ${attempt}: fresh result, got: ${reply}`);
}
{
  const rows = getRecentMessages(40);
  const toolRows = rows.filter((row) => row.role === "tool" && row.tool_name === "start_sequence");
  assert(toolRows.length >= 5, `each check is recorded as a tool row, got ${toolRows.length}`);
}

// A target only the model can resolve, and a model that won't call: he's told nothing ran.
{
  reset();
  honoursForcing = false;
  const before = freshCount;
  const reply = await say("start a sequence for her", { backend: "claude" });
  assert(freshCount === before, "nothing was guessed for \"her\"");
  assert(
    seen.some((params) => String(params.messages.at(-1)?.role === "user" ? (params.messages.at(-1) as { content: unknown }).content : "").includes("looks like a command")),
    "the model was asked once more",
  );
  assert(reply === commandNotRunMessage(["sequence"]), `an honest "not run", got: ${reply}`);
}

// Send: an echoing model never gets its old "Sent" through.
saveMessage("user", "Send Jeff an email saying Monday is on");
saveMessage("assistant", "Sent to Jeff Comstock <jeff.comstock@nice.com>: Monday is on. He has it in his inbox now.");
{
  reset();
  const reply = await say("Send Jeff an email saying Monday is on", { backend: "claude" });
  assert(!ran.some((item) => item.name === "send_email"), "nothing was sent");
  assert(reply === commandNotRunMessage(["send"]), `he's told no email was sent, got: ${reply}`);
  assert(!reply.includes("He has it in his inbox"), "the old confirmation is not repeated");
}
{
  reset();
  callsWhenAsked = "send_email";
  const reply = await say("Send Jeff an email saying Monday is on", { backend: "claude" });
  assert(ran.filter((item) => item.name === "send_email").length === 1, "asked again, the model sends it once");
  assert(reply.startsWith("Sent to Jeff Comstock") && !reply.includes("He has it in his inbox"), `the reply is this send's result, got: ${reply}`);
}

// Calendar: same guarantee.
{
  reset();
  const reply = await say("Book a meeting with Jeff tomorrow at 3", { backend: "claude" });
  assert(!ran.some((item) => COMMAND_TOOLS.calendar.includes(item.name)), "nothing was booked");
  assert(reply === commandNotRunMessage(["calendar"]), `he's told the calendar wasn't changed, got: ${reply}`);
}

// Not a command: nothing is forced, retried or replaced.
{
  reset();
  setCompleteForTests(async (params) => {
    seen.push(params);
    return modelReply({ text: params.tools.length === 0 ? '{"facts":[]}' : "Jeff said Monday works." });
  });
  const reply = await say("what did Jeff's email say?");
  assert(reply === "Jeff said Monday works.", `a question is answered as usual, got: ${reply}`);
  assert(seen.every((params) => params.toolChoice === undefined), "nothing is forced");
  assert(seen.filter((params) => params.tools.length > 0).length === 1, "and nothing is retried");
}

// A forwarded message is never a command, whatever it says.
{
  reset();
  setCompleteForTests(async (params) => {
    seen.push(params);
    return modelReply({ text: params.tools.length === 0 ? '{"facts":[]}' : "That's a forwarded note." });
  });
  const reply = await say("Start a sequence for Dorothy Copeland.", { forwarded: true });
  assert(ran.length === 0, "a forwarded message runs nothing in code");
  assert(seen.every((params) => params.toolChoice === undefined), "and forces nothing");
  assert(reply === "That's a forwarded note.", "its reply passes through");
}

setCompleteForTests(undefined);
setToolInterceptorForTests(undefined);
log("test-command-guarantee: ok");
process.exit(0);
