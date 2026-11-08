import "dotenv/config";
import { runAgent, setToolInterceptorForTests } from "../src/agent.ts";
import {
  COMMAND_TOOLS,
  commandFamilyTools,
  commandIntents,
  forcedCommandTool,
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

// ---- which messages are commands, family by family ----
const commands: Array<[string, string]> = [
  ["Start a sequence for Dorothy Copeland.", "sequence"],
  ["start a sequence for dorothy.copeland@nice.com", "sequence"],
  ["Can you auto follow up with Jeff Comstock", "sequence"],
  ["Follow up on my email to Jeff Comstock", "sequence"],
  ["follow up on the email I sent Munil", "sequence"],
  ["Follow up with Dorothy on my email", "sequence"],
  ["Remind me to follow up with Jeff on Monday", "sequence"],
  ["track my email to Priya", "sequence"],
  ["remind me to follow up with me on Friday", "reminder"],
  ["Stop following up with Rajan", "sequence_stop"],
  ["pause all follow-ups", "sequence_stop"],
  ["Don't email Talkdesk again", "sequence_stop"],
  ["stop the sequence for Munil", "sequence_stop"],
  ["Set Jeff's timezone to Pacific", "sequence_timezone"],
  ["change Munil's time zone to Eastern", "sequence_timezone"],
  ["Add to sales facts: we run on Kubernetes", "sales_fact_add"],
  ["add this to my sales facts under BotCompose: live in 12 languages", "sales_fact_add"],
  ["Remove sales fact 3", "sales_fact_remove"],
  ["Send Jeff an email saying we're on for Monday", "send"],
  ["send a reply to Munil saying thanks", "send"],
  ["Reply to Munil saying thanks", "send"],
  ["Email Selvaraj about the invoice", "send"],
  ["please email Priya the deck link", "send"],
  ["Draft a reply to Jeff saying Monday works", "draft"],
  ["draft an email to Priya about the renewal", "draft"],
  ["Write a follow-up email to Dorothy", "draft"],
  ["Prepare the MoM for today's call", "draft"],
  ["change the draft to say Tuesday instead", "draft"],
  ["Discard the draft", "draft_discard"],
  ["Book a meeting with Jeff tomorrow at 3", "calendar"],
  ["Schedule a call with Dorothy on Monday", "calendar"],
  ["Cancel my call with Dorothy", "calendar"],
  ["Move the demo with Talkdesk to Friday", "calendar"],
  ["Block my calendar Friday 2-4", "calendar"],
  ["Add Dorothy to the meeting", "calendar"],
  ["create an event tomorrow 4pm", "calendar"],
  ["Remind me to email Jeff tomorrow at 10", "reminder"],
  ["remind me at 6pm to call Amma", "reminder"],
  ["Set a reminder for the Airtel payment on Friday", "reminder"],
  ["Cancel the reminder for the dentist", "reminder"],
  ["Add a task to send the proposal to Tata", "task_add"],
  ["add renew the domain to my to-do list", "task_add"],
  ["Mark the proposal task as done", "task"],
  ["Delete the sales report task", "task"],
  ["Mark the Airtel bill paid", "bill"],
  ["Ignore the LinkedIn bill", "bill"],
  ["Add Priya's birthday on 14 March", "date_add"],
  ["save our anniversary as 12 June", "date_add"],
  ["Remove Ravi's birthday", "date"],
  ["Add Supertron as a partner", "account"],
  ["Create a new account for Tata Tele", "account"],
  ["Update the Talkdesk account: next step is a pilot", "account"],
  ["Remember that Jeff prefers mornings", "memory"],
  ["Forget the note about my old address", "memory"],
  ["Learn the Q&A from the Tata RFP", "qa_bank"],
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
  "draft",
  "Should I email Jeff?",
  "did you send the email to Munil?",
  "I'll email Jeff later",
  "remove the call recording",
  "add a note to the meeting",
  "What meetings do I have today?",
  "when is my call with Dorothy?",
  "propose a meeting with Jeff next week",
  "how's the weather",
  "is the draft ready?",
  "did you set the reminder?",
  "remind me what Jeff said about pricing",
  "what are my tasks?",
  "I need to add a task for this later",
  "which bills are due?",
  "when is Priya's birthday?",
  "show my sales facts",
  "what's Munil's timezone?",
  "remember when we met Jeff in Bangalore?",
  "is Talkdesk an account?",
  "remove my Google account",
  "the follow-ups are working well",
  "don't follow up on my email to Jeff",
  "did I follow up on my email to Jeff?",
  "follow up with me tomorrow about the deck",
];
for (const text of notCommands) {
  const kinds = commandIntents(text);
  assert(kinds.length === 0, `"${text}" is not a command, got ${kinds.join(",")}`);
}
// One message, two commands; and the specific object wins over a generic word.
assert(commandIntents("Book a call with Jeff on Monday. Email him the agenda.").join(",") === "send,calendar", "one message can hold two commands");
assert(commandIntents("Cancel the reminder for the call").join(",") === "reminder", "a reminder about a call is a reminder");
assert(commandIntents("Draft an email to Jeff to schedule a call").join(",") === "draft", "a draft that mentions a call is a draft");
assert(commandIntents("Delete the task about the Talkdesk call").join(",") === "task", "a task about a call is a task");
assert(commandIntents("remind me to book a meeting with Jeff").join(",") === "reminder", "remind me to book is a reminder, not a booking");
assert(commandIntents("Remind me to follow up with Jeff").join(",") === "sequence", "remind me to follow up with X is the sequence card, not a reminder");
assert(commandIntents("draft and send an email to Jeff saying Monday works").join(",") === "send", "draft and send is a send");

// ---- who a sequence request names ----
assert(JSON.stringify(sequenceTargets("Start a sequence for Dorothy Copeland.")) === '["Dorothy Copeland"]', "a name");
assert(JSON.stringify(sequenceTargets("start a sequence for dorothy.copeland@nice.com please")) === '["dorothy.copeland@nice.com"]', "an address, filler dropped");
assert(JSON.stringify(sequenceTargets("Auto follow up with Jeff at NICE")) === '["Jeff at NICE"]', "auto follow up");
assert(
  JSON.stringify(sequenceTargets("Start a sequence for Munil Shah. Start a sequence for Jeff Comstock too.")) === '["Munil Shah","Jeff Comstock"]',
  "one target per request",
);
assert(JSON.stringify(sequenceTargets("Follow up on my email to Jeff Comstock")) === '["Jeff Comstock"]', "the old tracker's phrasing names the person");
assert(JSON.stringify(sequenceTargets("Remind me to follow up with Jeff on Monday")) === '["Jeff"]', "the person, not the day");
assert(JSON.stringify(sequenceTargets("Follow up with Dorothy on my email")) === '["Dorothy"]', "follow up with X on my email");
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

// ---- forced tool calls by backend and family ----
assert(forcedCommandTool(["task_add"]) === "add_task" && forcedCommandTool(["date_add"]) === "add_date", "safe single tools are forced");
assert(forcedCommandTool(["sequence_stop"]) === undefined, "stop is never forced: \"pause all\" would stop every sequence");
assert(forcedCommandTool(["task"]) === undefined && forcedCommandTool(["bill"]) === undefined, "tools that need a lookup first aren't forced");
assert(forcedCommandTool(["reminder"]) === undefined, "set_reminder wants get_current_time first, so it isn't forced");
assert(forcedCommandTool(["task_add", "reminder"]) === undefined, "two commands force nothing");
assert(commandFamilyTools("task").includes("list_tasks") && commandFamilyTools("bill").includes("list_bills"), "a lookup counts for its family");
for (const [kind, names] of Object.entries(COMMAND_TOOLS)) {
  for (const name of [...names, ...commandFamilyTools(kind as never)]) {
    assert(Boolean(tools[name]), `${kind} names a real tool: ${name}`);
  }
}
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
  if (call.name === "add_task") {
    return `Added task #${40 + ran.length}: ${(call.input as { text: string }).text}`;
  }
  if (call.name === "list_tasks") {
    return '[{"id":3,"text":"Send the proposal to Tata"},{"id":7,"text":"Send the proposal to Airtel"}]';
  }
  if (call.name === "list_bills") {
    return '[{"id":2,"name":"Airtel","status":"upcoming"}]';
  }
  return "ok";
});

/** A model that, like DeepSeek on 7 Nov, answers a repeated request by pasting
 *  the newest earlier answer, and calls a tool only when the API forces it. */
let honoursForcing = true;
let callsWhenAsked: string | undefined;
/** Calls this read tool first, then answers with `clarify` or by pasting. */
let lookupFirst: string | undefined;
let clarify: string | undefined;
const SAMPLE_INPUT: Record<string, unknown> = {
  start_sequence: { prospect: "Dorothy Copeland" },
  add_task: { text: "Send the proposal to Tata", tag: "work" },
  add_date: { person: "Priya", month_day: "03-14", type: "birthday" },
};
const seen: CompleteParams[] = [];
setCompleteForTests(async (params) => {
  seen.push(params);
  if (params.tools.length === 0) {
    return modelReply({ text: '{"facts":[]}' });
  }
  const forced = params.toolChoice;
  if (forced && honoursForcing && typeof forced === "object") {
    return modelReply({ tools: [{ name: forced.name, input: SAMPLE_INPUT[forced.name] ?? {} }] });
  }
  if (lookupFirst && !params.messages.some((message) => message.role === "tool")) {
    return modelReply({ tools: [{ name: lookupFirst, input: {} }] });
  }
  if (lookupFirst && clarify) {
    return modelReply({ text: clarify });
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
  lookupFirst = undefined;
  clarify = undefined;
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

// A task on DeepSeek: add_task is forced, and an old "Added" can't stand in for the new one.
saveMessage("user", "Add a task to send the proposal to Tata");
saveMessage("assistant", "Added task #12: Send the proposal to Tata. It's on your list for today.");
for (let attempt = 1; attempt <= 2; attempt += 1) {
  reset();
  const reply = await say("Add a task to send the proposal to Tata");
  const first = seen.find((params) => params.tools.length > 0)!;
  assert(JSON.stringify(first.toolChoice) === '{"name":"add_task"}', "the first step forces add_task");
  assert(ran.filter((item) => item.name === "add_task").length === 1, `attempt ${attempt}: the task is added once`);
  assert(reply.startsWith("Added task #4") && !reply.includes("#12"), `attempt ${attempt}: this turn's task, not the old one: ${reply}`);
}

// Stop is never forced, even on DeepSeek.
{
  reset();
  await say("pause all follow-ups");
  assert(seen.every((params) => params.toolChoice === undefined), "pause all follow-ups forces nothing");
}

// A fresh lookup and a "which one?" is a real answer.
{
  reset();
  lookupFirst = "list_tasks";
  clarify = "Which one: #3 Send the proposal to Tata, or #7 Send the proposal to Airtel?";
  const reply = await say("Mark the proposal task as done", { backend: "claude" });
  assert(ran.map((item) => item.name).join(",") === "list_tasks", "it looked the tasks up");
  assert(reply === clarify, `and its question goes through: ${reply}`);
  assert(!seen.some((params) => String((params.messages.at(-1) as { content?: unknown } | undefined)?.content ?? "").includes("looks like a command")), "with no retry");
}

// A lookup and then an old answer: he's told nothing was done, not shown the lookup.
saveMessage("user", "Mark the Airtel bill paid");
saveMessage("assistant", "Marked the Airtel bill paid. Next one due is LinkedIn on the 30th.");
{
  reset();
  lookupFirst = "list_bills";
  const reply = await say("Mark the Airtel bill paid", { backend: "claude" });
  assert(reply === commandNotRunMessage(["bill"]), `nothing was marked, and he's told: ${reply}`);
}
// No tool at all, twice: the same.
{
  reset();
  const reply = await say("Mark the Airtel bill paid", { backend: "claude" });
  assert(ran.length === 0, "nothing ran");
  assert(reply === commandNotRunMessage(["bill"]), `an honest "not run": ${reply}`);
  assert(reply.includes("no bill was marked paid or skipped"), "in the bill family's words");
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
