import "dotenv/config";
import { readFile } from "node:fs/promises";
import { setApprovalsTestHooks } from "../src/approvals.ts";
import {
  activateSalesSequence,
  createProposedSalesSequence,
  getSalesSequence,
  getSalesSequenceStep,
  listAddedSalesFacts,
  recordSalesStepSent,
  setSalesSequenceTimezone,
  type SalesOriginalAsk,
} from "../src/db.ts";
import { setGoogleAccountForTests, type LoadedGoogleAccount } from "../src/google/auth.ts";
import { setGmailClientForTests } from "../src/google/mail.ts";
import { setCompleteForTests, type CompleteParams, type CompleteResult } from "../src/llm.ts";
import { setMeetingTestHooks, resetMeetingTestHooks } from "../src/meeting_book.ts";
import {
  addSalesFactFromTool,
  listSalesFactsFromTool,
  mergeSalesFacts,
  readSalesFactsFile,
  removeSalesFactFromTool,
  salesFactsText,
} from "../src/sales_facts.ts";
import { prospectKey } from "../src/sequence_logic.ts";
import {
  ASK_SYSTEM,
  askPhrase,
  cleanDraftBody,
  htmlFromSequenceBody,
  parseWriterPayload,
  prepareSequenceStep,
  resolveOriginalAsk,
  SEQUENCE_FOOTER,
  SEQUENCE_FOOTER_HTML,
  SLOTS_TOKEN,
  stepBrief,
  withSequenceFooter,
  WRITER_SYSTEM,
} from "../src/sequence_writer.ts";
import { fakeTelegramApi, type TelegramLog } from "./fakes.ts";
import {
  DEMO_PITCH,
  fixtureGmail,
  MEETING_PITCH,
  PARTNERSHIP_PITCH,
  type FixtureMessage,
} from "./fixtures/sequence-threads.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("test-sequence-writer.ts must run with AADI_DB_PATH=:memory:");
}

const OWNER = { confirmation: { chatId: 1, messageId: 42 } };

// ---- the fact sheet ----
{
  const file = readSalesFactsFile();
  assert(file.startsWith("# Epicode sales facts"), "docs/sales_facts.md is the Epicode fact sheet");
  assert(!/\bTODO\b/.test(file), "the fact sheet has no TODO lines");
  for (const heading of ["Who we are", "Scale and performance", "IraVoice", "BotCompose", "Campaign Manager", "Why partners work with us", "Trusted by", "The demo (15-20 minutes)", "Writing style for follow-ups"]) {
    assert(file.includes(`## ${heading}`), `the sheet has the ${heading} section`);
  }
  assert(file.includes("Zoom, Five9, Bajaj Finserv, Pinnacle."), "the customer list is there");
  assert(readSalesFactsFile("scripts/fixtures/no-such-file.md") === "", "a missing file reads as empty, not an error");
}

// ---- merging added facts ----
{
  const file = "# Facts\n\n## IraVoice\n- Media server.\n\n## The demo (15-20 minutes)\nA live call.\n\n## Trusted by\nZoom.";
  const merged = mergeSalesFacts(file, [
    { id: 1, section: "IraVoice", fact: "Runs on-prem." },
    { id: 2, section: "demo", fact: "Ends with Q&A." },
    { id: 3, section: null, fact: "New logo: Acme." },
    { id: 4, section: "Customers", fact: "Ten banks." },
    { id: 5, section: "customers", fact: "Two telcos." },
  ]);
  assert(/## IraVoice\n- Media server\.\n- Runs on-prem\.\n\n## The demo/.test(merged), `a named section gets the fact at its end:\n${merged}`);
  assert(/A live call\.\n- Ends with Q&A\.\n/.test(merged), "\"under demo\" finds The demo (15-20 minutes)");
  assert(/## Added facts\n- New logo: Acme\./.test(merged), "no section goes under Added facts");
  assert(/## Customers\n- Ten banks\.\n- Two telcos\./.test(merged), "an unknown section is created once, at the end");
  assert(merged.startsWith("# Facts"), "the title stays first");
  const tagged = mergeSalesFacts(file, [{ id: 7, section: null, fact: "X." }], { tagAdded: true });
  assert(tagged.includes("- X. [added #7]"), "the listing tags added facts");
  assert(mergeSalesFacts(file, []) === file, "with nothing added the sheet is unchanged");
}

// ---- add, show and remove by chat ----
{
  let refused = false;
  try {
    addSalesFactFromTool({ fact: "x" }, { confirmation: undefined });
  } catch {
    refused = true;
  }
  assert(refused, "adding a fact needs Vishnu's own turn");
  for (const run of [() => listSalesFactsFromTool({ confirmation: undefined }), () => removeSalesFactFromTool({ fact: "x" }, { confirmation: undefined })]) {
    let threw = false;
    try {
      run();
    } catch {
      threw = true;
    }
    assert(threw, "show and remove need Vishnu's own turn too");
  }
  assert(addSalesFactFromTool({ fact: "  " }, OWNER).startsWith("Nothing added"), "an empty fact is refused");
  const added = addSalesFactFromTool({ fact: "- Live in 12 Indian languages.", section: "botcompose" }, OWNER);
  assert(added.includes('under "BotCompose"'), `the reply names the matched section: ${added}`);
  assert(listAddedSalesFacts()[0]!.fact === "Live in 12 Indian languages.", "the bullet marker is dropped");
  addSalesFactFromTool({ fact: "Used by a large US bank." }, OWNER);
  addSalesFactFromTool({ fact: "Used by a large Indian bank." }, OWNER);
  const text = salesFactsText();
  assert(/## BotCompose\n[\s\S]*- Live in 12 Indian languages\.\n\n## Campaign Manager/.test(text), "the added fact sits in BotCompose");
  assert(text.includes("## Added facts\n- Used by a large US bank."), "facts with no section go under Added facts");
  const listing = listSalesFactsFromTool(OWNER);
  assert(listing.includes("Zoom, Five9") && listing.includes("[added #1]"), "show lists the file and the added facts");
  assert(removeSalesFactFromTool({ fact: "bank" }, OWNER).startsWith("Nothing removed yet"), "two matches ask which");
  assert(removeSalesFactFromTool({ fact: "Zoom" }, OWNER).includes("can only be changed by editing"), "file facts can't be removed by chat");
  assert(removeSalesFactFromTool({ fact: "US bank" }, OWNER).startsWith("Removed sales fact #2"), "one match is removed");
  assert(removeSalesFactFromTool({ fact: "#3" }, OWNER).startsWith("Removed sales fact #3"), "a number removes that fact");
  assert(listAddedSalesFacts().length === 1, "one added fact is left");
  assert(!salesFactsText().includes("Used by a large"), "removed facts are gone from what the writer reads");
}

// ---- the ask ----
assert(resolveOriginalAsk('{"ask":"demo"}', "open to a short demo?") === "demo", "demo when he offered one");
assert(
  resolveOriginalAsk('{"ask":"demo"}', "could we explore a partnership?") === "partnership_call",
  "the model can't turn a partnership email into a demo",
);
assert(
  resolveOriginalAsk('{"ask":"demo"}', "could we meet next week?") === "meeting",
  "the model can't turn a meeting email into a demo",
);
assert(resolveOriginalAsk("garbage", "a technology partnership call") === "partnership_call", "fallback finds partnership");
assert(resolveOriginalAsk("garbage", "a short demo") === "demo", "fallback finds demo");
assert(resolveOriginalAsk("garbage", "could we talk") === "meeting", "fallback is a meeting");

// ---- step angles push the same ask ----
for (const ask of ["demo", "partnership_call", "meeting"] as SalesOriginalAsk[]) {
  const briefs = [1, 2, 3, 4].map((step) => stepBrief(step, ask));
  assert(new Set(briefs).size === 4, "each step has its own angle");
  const { short } = askPhrase(ask);
  assert(briefs[0]!.includes(short) && briefs[1]!.includes(short) && briefs[3]!.includes(short), `steps 1, 2 and 4 push ${ask}`);
  if (ask !== "demo") {
    assert(briefs.every((brief) => !/\bdemo\b/i.test(brief)), `${ask} steps never say demo`);
  }
}
assert(stepBrief(3, "demo").includes("a 15-20 minute demo"), "step 3 offers the demo");
assert(
  stepBrief(3, "partnership_call").includes("a 15-20 minute call to explore the partnership"),
  "partnership step 3 offers the call",
);
assert(stepBrief(3, "meeting").includes("a 15-20 minute meeting"), "meeting step 3 offers the meeting");
assert(stepBrief(3, "demo").includes(SLOTS_TOKEN), "step 3 with times carries the slot token");
assert(!stepBrief(3, "demo", false).includes(SLOTS_TOKEN), "step 3 without times has no token");
assert(/a day and time that suits them/.test(stepBrief(3, "demo", false)), "step 3 without times asks for one");
assert(/curiosity/i.test(stepBrief(1, "demo")), "step 1 is curiosity");
assert(/SALES FACTS/.test(stepBrief(1, "demo")) && /SALES FACTS/.test(stepBrief(2, "demo")), "steps 1 and 2 draw on the sales facts");
assert(/business value/i.test(stepBrief(2, "demo")), "step 2 is business value");
assert(/meeting conversion/i.test(stepBrief(4, "demo")), "step 4 converts to a meeting");
assert(WRITER_SYSTEM.includes("Infrastructure Partners"), "the writer classifies infrastructure partners");
assert(WRITER_SYSTEM.includes("Voice AI Companies and Builders"), "and Voice AI builders");
assert(WRITER_SYSTEM.includes("one or two points most relevant"), "the writer picks one or two points");
assert(WRITER_SYSTEM.includes("never list everything"), "the writer never lists everything");
assert(WRITER_SYSTEM.includes("Never suggest the recipient would get the same result"), "the writer won't promise a customer's result");
assert(WRITER_SYSTEM.includes('"subject"') && WRITER_SYSTEM.includes('"body"'), "the writer returns subject and body JSON");
assert(
  parseWriterPayload('{"subject":"Re: IraVoice","body":"Hi Priya,\\n\\nWould a demo work?"}') ===
    "Hi Priya,\n\nWould a demo work?",
  "subject-and-body JSON still yields the body",
);

assert(
  cleanDraftBody("Hi Priya,\n\nWould that work?\n\nThanks,\nVishnu") === "Hi Priya,\n\nWould that work?",
  "a model sign-off is removed",
);
assert(
  cleanDraftBody("Hi Priya,\n\nWould that work?\n\nBest, Vishnu") === "Hi Priya,\n\nWould that work?",
  "a one-line Best, Vishnu sign-off is removed",
);
assert(
  cleanDraftBody("Hi Priya,\n\nWould that work?\n\nThanks, Vishnu") === "Hi Priya,\n\nWould that work?",
  "a one-line Thanks, Vishnu sign-off is removed",
);
assert(
  withSequenceFooter("Hi Priya,\n\nWould a demo work?") ===
    `Hi Priya,\n\nWould a demo work?\n\n${SEQUENCE_FOOTER}`,
  "the CAN-SPAM footer follows the written body",
);
assert(withSequenceFooter(withSequenceFooter("Hi")).endsWith(SEQUENCE_FOOTER), "the footer is not doubled");
assert(
  SEQUENCE_FOOTER.includes("reply 'no thanks'") && SEQUENCE_FOOTER.includes("Bengaluru – 560040"),
  "the footer has the opt-out line and the Bangalore address",
);
{
  const html = htmlFromSequenceBody("Hi Priya,\n\nWould a demo work?\n\n" + SEQUENCE_FOOTER, "<div>SIG</div>");
  assert(html.includes("Would a demo work?"), "HTML keeps the written body");
  assert(html.includes(SEQUENCE_FOOTER_HTML), "HTML uses the styled footer");
  assert(html.includes('font-size:12px'), "the address is in a smaller font");
  assert(html.includes("<div>SIG</div>"), "the Gmail signature still follows");
  assert(!html.includes("Would a demo work?\n\nIf you'd prefer"), "the footer is not left as escaped plain text");
}

// ---- the full flow on fixture threads ----
const threads = new Map<string, FixtureMessage[]>();
const mail = { created: [] as string[], sent: [] as string[], deleted: [] as string[] };
const gmailStub = fixtureGmail(threads, mail);
const telegram: TelegramLog = { sent: [], edited: [] };
const workAccount = { id: "work", tag: "work", label: "work (Epicode)", client: {} } as unknown as LoadedGoogleAccount;

setGoogleAccountForTests((id) => (id === "work" ? workAccount : undefined));
setGmailClientForTests(() => gmailStub);
setApprovalsTestHooks({ telegram: fakeTelegramApi(telegram), gmailFor: () => gmailStub });

const MONDAY_MORNING = new Date("2026-11-09T04:30:00Z");
let busy: Array<{ start: Date; end: Date }> = [];
setMeetingTestHooks({ loadBusy: async () => busy });

const CLEAN =
  "Hi Priya,\n\nJust a quick follow-up. IraVoice answers inbound support calls in Hindi and English, which could take some of the order-status calls off your team at Acme Foods.\n\nWould a short demo next week work?";

interface ModelScript {
  ask: string;
  write: string | (() => string);
}
let script: ModelScript = { ask: '{"ask":"demo"}', write: JSON.stringify({ body: CLEAN }) };
let calls: CompleteParams[] = [];
setCompleteForTests(async (params) => {
  calls.push(params);
  const system = params.system.cacheable ?? "";
  const pick = system === ASK_SYSTEM ? script.ask : system === WRITER_SYSTEM ? script.write : "{}";
  const text = typeof pick === "function" ? pick() : pick;
  return {
    textParts: [text],
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    stopReason: "end_turn",
  } as CompleteResult;
});

function enrol(pitch: typeof DEMO_PITCH, manualFollowups = 0): number {
  threads.set(pitch.threadId, pitch.build());
  const row = createProposedSalesSequence({
    threadId: pitch.threadId,
    prospectEmail: pitch.prospectEmail,
    prospectDomain: pitch.prospectEmail.split("@")[1]!,
    prospectKey: prospectKey(pitch.prospectEmail),
    prospectName: pitch.prospectName,
    prospectCompany: pitch.prospectCompany,
    subject: pitch.subject,
    originalMessageId: `${pitch.threadId}-1`,
    originalSentAt: new Date().toISOString(),
    manualFollowups,
    classifierConfidence: 0.9,
    classifierReason: "x",
  })!;
  assert(
    activateSalesSequence(row.id, {
      nextStepAt: new Date().toISOString(),
      enrolledAt: new Date().toISOString(),
      manualFollowups,
    }),
    "fixture sequence activates",
  );
  return row.id;
}

function reset(): void {
  calls = [];
}

function writerPrompt(): string {
  const call = calls.find((item) => item.system.cacheable === WRITER_SYSTEM);
  const message = call?.messages[0];
  return message && "content" in message && typeof message.content === "string" ? message.content : "";
}

function sent(id: number, ...steps: number[]): void {
  for (const stepNo of steps) {
    recordSalesStepSent({ sequenceId: id, stepNo, sentMessageId: `g${id}-${stepNo}`, sentAt: new Date().toISOString(), stepDays: 2 });
  }
}

function slotLines(body: string): string[] {
  return body.split("\n").filter((line) => line.startsWith("- "));
}

// A written draft is stored, unsent and ready, with no check and no card.
{
  const id = enrol(DEMO_PITCH);
  reset();
  const ready = await prepareSequenceStep(id);
  assert(ready.kind === "ready", `clean draft is ready, got ${JSON.stringify(ready)}`);
  const step = getSalesSequenceStep(id, 1)!;
  assert(step.status === "planned", "ready does not mean sent");
  assert(step.draft_text === withSequenceFooter(cleanDraftBody(CLEAN)), "the draft is stored with the footer");
  assert(step.check_result === null, "no check result is stored");
  assert(step.sent_message_id === null, "nothing was sent");
  assert(calls.length === 2, `one ask call and one writer call, no checker: ${calls.length}`);
  assert(getSalesSequence(id)!.original_ask === "demo", "the ask is stored");

  const prompt = writerPrompt();
  assert(prompt.includes("Hi Priya"), "the writer sees the original thread");
  assert(prompt.includes("<<<UNTRUSTED_ORIGINAL_THREAD>>>"), "the thread is marked untrusted");
  assert(prompt.includes("<<<UNTRUSTED_BACKGROUND>>>"), "background is marked untrusted");
  assert(prompt.includes("SALES FACTS:\n# Epicode sales facts"), "the writer gets the whole fact sheet");
  assert(prompt.includes("Zoom, Five9, Bajaj Finserv, Pinnacle."), "the writer sees the customer list");
  assert(prompt.includes("Live in 12 Indian languages."), "the writer sees a fact added by chat");
  assert(prompt.includes("Curiosity"), "the writer gets the step's angle");
  assert(prompt.includes("SEQUENCE STEP: 1"), "the writer sees the step number");

  addSalesFactFromTool({ fact: "Brand-new point for the next email.", section: "Trusted by" }, OWNER);
  reset();
  await prepareSequenceStep(id);
  assert(writerPrompt().includes("Brand-new point for the next email."), "a newly added fact is used from the next follow-up");
  assert(!calls.some((item) => item.system.cacheable === ASK_SYSTEM), "the ask is worked out once");

  sent(id, 1);
  reset();
  script.write = JSON.stringify({ body: "Hi Priya,\n\nA different angle: Five9 runs on our stack.\n\nWould a short demo next week work?" });
  const second = await prepareSequenceStep(id);
  assert(second.kind === "ready", `step 2 ready, got ${JSON.stringify(second)}`);
  assert(writerPrompt().includes("Follow-up 1:"), "step 2 sees what step 1 said");
}

// What used to be blocked now goes as written: price, discount, numbers, links,
// attachments, timelines, other customers, demo on a partnership.
{
  const risky = [
    "Hi Priya,\n\nIt starts at $500 a month, and we can offer a 20% discount.",
    "Hi Priya,\n\nWe guarantee go-live in two weeks with a 99.9% SLA. I've attached a deck: https://example.com/deck",
    "Hi Priya,\n\nZeta Corp moved 40 agents to us. We will ensure your team is live soon.",
  ];
  for (const [index, body] of risky.entries()) {
    const id = enrol({ ...DEMO_PITCH, threadId: `fixture-free-${index}`, prospectEmail: `p${index}@free${index}.example`, prospectName: "Priya", prospectCompany: `Free${index}` });
    script = { ask: '{"ask":"demo"}', write: JSON.stringify({ body }) };
    const ready = await prepareSequenceStep(id);
    assert(ready.kind === "ready" && ready.body === withSequenceFooter(body), `sent as written: ${body.slice(0, 40)}`);
    assert(getSalesSequenceStep(id, 1)!.status === "planned", "no blocked step");
    assert(getSalesSequence(id)!.next_step_at !== null, "the sequence isn't paused");
  }
  const id = enrol(PARTNERSHIP_PITCH);
  script = { ask: '{"ask":"partnership_call"}', write: JSON.stringify({ body: "Hi Mira,\n\nA demo is open whenever it suits." }) };
  assert((await prepareSequenceStep(id)).kind === "ready", "a demo on a partnership email is no longer blocked");
  assert(mail.created.length === 0, "no Gmail draft is ever created");
  assert(telegram.sent.length === 0, "no blocked-step card is ever posted");
}

// Step 3: times that suit both sides, or ask them for one.
{
  const id = enrol({ ...MEETING_PITCH, threadId: "fixture-slots-ist" });
  script = { ask: '{"ask":"meeting"}', write: JSON.stringify({ body: `Hi Omar,\n\nWould a 15-20 minute meeting suit?\n\n${SLOTS_TOKEN}\n\nOr tell me what works.` }) };
  sent(id, 1, 2);
  setSalesSequenceTimezone(id, "Asia/Kolkata", "email");
  reset();
  const ready = await prepareSequenceStep(id, { now: MONDAY_MORNING });
  assert(ready.kind === "ready", `IST step 3 ready, got ${JSON.stringify(ready)}`);
  const lines = ready.kind === "ready" ? slotLines(ready.body) : [];
  assert(lines.length >= 1 && lines.length <= 3, `1-3 slots offered, got ${lines.length}`);
  assert(lines.every((line) => line.includes("IST") && !line.includes("(")), "IST slots carry no second zone");
  assert(ready.kind === "ready" && !ready.body.includes(SLOTS_TOKEN), "the token is replaced");
  assert(writerPrompt().includes(SLOTS_TOKEN), "the writer is told where the times go");
}
{
  const id = enrol({ ...MEETING_PITCH, threadId: "fixture-slots-london", prospectEmail: "omar@london.example" });
  script = { ask: '{"ask":"meeting"}', write: JSON.stringify({ body: `Hi Omar,\n\nWould one of these suit?\n\n${SLOTS_TOKEN}` }) };
  sent(id, 1, 2);
  setSalesSequenceTimezone(id, "Europe/London", "signature");
  const ready = await prepareSequenceStep(id, { now: MONDAY_MORNING });
  const lines = ready.kind === "ready" ? slotLines(ready.body) : [];
  assert(lines.length >= 1, "London overlaps his day, so times are offered");
  for (const line of lines) {
    const match = /\((\d{1,2}):(\d{2}) ([AP]M)/.exec(line);
    assert(match !== null, `each London slot shows their time: ${line}`);
    const hour = (Number(match![1]) % 12) + (match![3] === "PM" ? 12 : 0);
    assert(hour >= 9 && hour < 18, `a London slot falls in 09:00-18:00 their time: ${line}`);
  }
}
{
  const id = enrol({ ...MEETING_PITCH, threadId: "fixture-slots-pacific", prospectEmail: "omar@pacific.example" });
  script = { ask: '{"ask":"meeting"}', write: JSON.stringify({ body: `Hi Omar,\n\nWhat day and time would suit you for a 15-20 minute meeting?\n\n${SLOTS_TOKEN}` }) };
  sent(id, 1, 2);
  setSalesSequenceTimezone(id, "America/Los_Angeles", "company");
  reset();
  const ready = await prepareSequenceStep(id, { now: MONDAY_MORNING });
  assert(ready.kind === "ready", `Pacific step 3 ready, got ${JSON.stringify(ready)}`);
  assert(ready.kind === "ready" && slotLines(ready.body).length === 0, "no time of his day is 09:00-18:00 Pacific, so none is offered");
  assert(ready.kind === "ready" && !ready.body.includes(SLOTS_TOKEN), "a stray token is removed");
  assert(/a day and time that suits them/.test(writerPrompt()), "the writer asks them for a time instead");
  assert(!writerPrompt().includes(SLOTS_TOKEN), "and is given no token");
}
{
  const id = enrol({ ...MEETING_PITCH, threadId: "fixture-slots-full", prospectEmail: "omar@full.example" });
  sent(id, 1, 2);
  setSalesSequenceTimezone(id, "Asia/Kolkata", "default");
  busy = [{ start: new Date(MONDAY_MORNING.getTime() - 86400000), end: new Date(MONDAY_MORNING.getTime() + 90 * 86400000) }];
  script.write = JSON.stringify({ body: "Hi Omar,\n\nWhat time would suit you?" });
  reset();
  const ready = await prepareSequenceStep(id, { now: MONDAY_MORNING });
  assert(ready.kind === "ready", "a full calendar asks for a time instead of waiting");
  assert(/a day and time that suits them/.test(writerPrompt()), "the writer is told to ask");
  busy = [];
}
{
  const id = enrol({ ...MEETING_PITCH, threadId: "fixture-slots-dropped", prospectEmail: "omar@dropped.example" });
  sent(id, 1, 2);
  setSalesSequenceTimezone(id, "Asia/Kolkata", "email");
  script.write = JSON.stringify({ body: "Hi Omar,\n\nWould next week suit?" });
  const dropped = await prepareSequenceStep(id, { now: MONDAY_MORNING });
  assert(dropped.kind === "deferred" && dropped.reason === "writer_failed", "a writer that drops the times waits and retries");
  assert(getSalesSequenceStep(id, 3)!.draft_text === null, "nothing is stored to send");
}

// A writer outage or an empty body waits; nothing goes out.
{
  const id = enrol({ ...DEMO_PITCH, threadId: "fixture-writer-down", prospectEmail: "h@writerdown.example", prospectName: "Priya", prospectCompany: "Writerdown" });
  script.write = "not json";
  const down = await prepareSequenceStep(id);
  assert(down.kind === "deferred" && down.reason === "writer_failed", "an unreadable writer waits");
  assert(getSalesSequenceStep(id, 1)!.status === "planned", "the step stays planned");
  script.write = JSON.stringify({ body: "   " });
  const empty = await prepareSequenceStep(id);
  assert(empty.kind === "deferred", "an empty body waits");
  assert(getSalesSequenceStep(id, 1)!.draft_text === null, "an empty body is never stored");
}

// The last step gets the closing angle.
{
  const id = enrol({ ...DEMO_PITCH, threadId: "fixture-last", prospectEmail: "d@last.example", prospectName: "Dev", prospectCompany: "Last" }, 3);
  assert(getSalesSequence(id)!.current_step === 4, "it's the last step");
  script.write = JSON.stringify({ body: "Hi Dev,\n\nLast note from me." });
  reset();
  await prepareSequenceStep(id);
  assert(writerPrompt().includes("Meeting conversion"), "the writer gets the closing angle");
}

// No bodies, names or addresses reach the logs.
{
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  const id = enrol({ ...DEMO_PITCH, threadId: "fixture-log", prospectEmail: "secret@logcheck.example", prospectName: "Secretname", prospectCompany: "Logcheck" });
  script = { ask: '{"ask":"demo"}', write: JSON.stringify({ body: "Hi Secretname,\n\nIt starts at $500." }) };
  await prepareSequenceStep(id);
  console.log = original;
  const joined = logs.join("\n");
  assert(!/secret|\$500|acme foods/i.test(joined), "logs carry no bodies, names or addresses");
}

// Writing adds no send path.
for (const file of ["src/sequence_writer.ts", "src/sales_facts.ts", "src/sequences.ts", "src/sequence_timezone.ts"]) {
  const src = await readFile(file, "utf8");
  assert(!src.includes("messages.send"), `${file} must not call messages.send`);
  assert(!src.includes("drafts."), `${file} must not touch drafts`);
}
assert(mail.sent.length === 0, "nothing was sent");

resetMeetingTestHooks();
setGoogleAccountForTests(undefined);
setGmailClientForTests(undefined);
setCompleteForTests(undefined);
setApprovalsTestHooks({});
console.log("test-sequence-writer: ok");
