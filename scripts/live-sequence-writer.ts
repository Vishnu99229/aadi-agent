/**
 * The real writer model on invented fixture threads, with docs/sales_facts.md.
 * Gmail, Telegram and the calendar are stubs: nothing reads your mailbox or sends.
 */
import { setApprovalsTestHooks } from "../src/approvals.js";
import {
  activateSalesSequence,
  createProposedSalesSequence,
  listUsageLogs,
  getSalesSequence,
  getSalesSequenceStep,
  recordSalesStepSent,
} from "../src/db.js";
import { setGoogleAccountForTests, type LoadedGoogleAccount } from "../src/google/auth.js";
import { setGmailClientForTests } from "../src/google/mail.js";
import { setMeetingTestHooks } from "../src/meeting_book.js";
import { prospectKey } from "../src/sequence_logic.js";
import { prepareSequenceStep } from "../src/sequence_writer.js";
import { fakeTelegramApi } from "./fakes.js";
import {
  DEMO_PITCH,
  fixtureGmail,
  FIXTURE_ME,
  MEETING_PITCH,
  PARTNERSHIP_PITCH,
  type FixtureMessage,
} from "./fixtures/sequence-threads.js";

const threads = new Map<string, FixtureMessage[]>();
const gmail = fixtureGmail(threads, { created: [], sent: [], deleted: [] });
const account = { id: "work", tag: "work", label: "work (Epicode)", client: {} } as unknown as LoadedGoogleAccount;

setGoogleAccountForTests((id) => (id === "work" ? account : undefined));
setGmailClientForTests(() => gmail);
setApprovalsTestHooks({ telegram: fakeTelegramApi({ sent: [], edited: [] }), gmailFor: () => gmail });
setMeetingTestHooks({ loadBusy: async () => [] });

const log = console.log;
console.log = () => undefined;

for (const pitch of [DEMO_PITCH, PARTNERSHIP_PITCH, MEETING_PITCH]) {
  const messages = pitch.build();
  threads.set(pitch.threadId, messages);
  const row = createProposedSalesSequence({
    threadId: pitch.threadId,
    prospectEmail: pitch.prospectEmail,
    prospectDomain: pitch.prospectEmail.split("@")[1]!,
    prospectKey: prospectKey(pitch.prospectEmail),
    prospectName: pitch.prospectName,
    prospectCompany: pitch.prospectCompany,
    subject: pitch.subject,
    originalMessageId: messages[0]!.id,
    originalSentAt: new Date().toISOString(),
    manualFollowups: 0,
    classifierConfidence: null,
    classifierReason: null,
  })!;
  activateSalesSequence(row.id, {
    nextStepAt: new Date().toISOString(),
    enrolledAt: new Date().toISOString(),
    manualFollowups: 0,
  });
  log(`\n=== ${pitch.subject}`);
  for (let stepNo = 1; stepNo <= 4; stepNo += 1) {
    const outcome = await prepareSequenceStep(row.id);
    const ask = getSalesSequence(row.id)!.original_ask;
    const step = getSalesSequenceStep(row.id, stepNo)!;
    const text = step.draft_text ?? "";
    const verdict = outcome.kind === "ready" ? "ready" : `${outcome.kind}: ${outcome.reason}`;
    log(`\n--- step ${stepNo} [ask=${ask}] ${verdict} (${text.split(/\s+/).filter(Boolean).length} words)`);
    log(text);
    if (!text) {
      break;
    }
    const sentAt = new Date().toISOString();
    recordSalesStepSent({
      sequenceId: row.id,
      stepNo,
      sentMessageId: `live-${stepNo}`,
      sentAt,
      stepDays: 2,
    });
    messages.push({
      id: `${pitch.threadId}-s${stepNo}`,
      from: `Vishnu Rajan <${FIXTURE_ME}>`,
      to: messages[0]!.to,
      subject: `Re: ${pitch.subject}`,
      sentAt: Date.now(),
      sent: true,
      body: text,
      messageId: `<${pitch.threadId}-s${stepNo}@mail.example>`,
    });
  }
}
const usage = new Map<string, { calls: number; cost: number; models: Set<string> }>();
for (const row of listUsageLogs("2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z")) {
  if (row.task === "sequence") {
    const entry = usage.get(row.task) ?? { calls: 0, cost: 0, models: new Set<string>() };
    entry.calls += 1;
    entry.cost += row.cost_usd;
    entry.models.add(row.model);
    usage.set(row.task, entry);
  }
}
log("");
for (const [task, entry] of usage) {
  log(`usage_log ${task}: calls=${entry.calls} cost_usd=${entry.cost.toFixed(4)} models=${[...entry.models].join(",")}`);
}
process.exit(0);
