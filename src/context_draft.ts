import {
  applyToSchedule,
  contextScheduleForDraft,
  getPendingAction,
  lockedScheduleFor,
  savePendingAction,
  scheduleSyncNotice,
  tooLateText,
  type ScheduleSync,
} from "./action_context.js";
import { getScheduledSend } from "./db.js";
import { complete, type CompleteResult } from "./llm.js";
import { resolveAgentModel } from "./models/agent_models.js";
import { handler as draftNewEmail } from "./tools/draft_new_email.js";
import { draftUpdateNotice, handler as updateDraft } from "./tools/update_draft.js";

function subjectFrom(purpose: string): string {
  const line = purpose.replace(/\s+/g, " ").trim();
  const cut = line.split(/[.!?]/)[0] ?? line;
  return cut.length <= 80 ? cut : `${cut.slice(0, 79)}…`;
}

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string" },
    body: { type: "string" },
  },
  required: ["subject", "body"],
  additionalProperties: false,
} as const;

const WRITER_SYSTEM = `You write emails as Vishnu. Return only JSON with "subject" and "body".
The body is plain text, short, and specific to the facts you are given.
Do not invent pricing, product claims, meetings, or requirements that are not in the facts.
If the facts do not mention a previous discussion, do not say there was one.
Do not add a sign-off. Match the situation: follow-up, proposal, or a first note.
No filler such as "I hope this email finds you well" or "just following up" when the facts already say what to ask.`;

/** Keep the start of the facts and the latest instruction. A long draft must not push the correction off the end. */
function boundedFacts(facts: string): string {
  if (facts.length <= 1800) {
    return facts;
  }
  return `${facts.slice(0, 1100)}\n…\n${facts.slice(-600)}`;
}

/** One email-agent call. Exported so tests can see which model was asked. */
export async function composeWithEmailAgent(facts: string): Promise<{ subject: string; body: string; modelKey?: string }> {
  const resolved = resolveAgentModel("email", { needs: { tools: false } });
  const result: CompleteResult = await complete({
    system: { cacheable: WRITER_SYSTEM },
    messages: [{ role: "user", content: boundedFacts(facts) }],
    tools: [],
    jsonSchema: DRAFT_SCHEMA,
    maxTokens: 500,
    route: { agentId: "email", models: resolved.models },
    task: "drafting",
  });
  const raw = result.textParts.join("").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  const parsed = JSON.parse(raw) as { subject?: unknown; body?: unknown };
  const subject = typeof parsed.subject === "string" ? parsed.subject.trim() : "";
  const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
  if (!subject || !body) {
    throw new Error("email agent returned an empty draft");
  }
  return { subject, body, modelKey: result.servedBy };
}

/**
 * Turns a finished pending draft into one Gmail draft and its approval card.
 * A later note updates that same draft. This never sends.
 */
function revisionMode(text: string): "add" | "shorten" | "replace" {
  if (/\b(?:shorter|brief|concise)\b/i.test(text)) {
    return "shorten";
  }
  if (
    /\b(?:also|as well|add|mention|include)\b/i.test(text) &&
    !/\b(?:instead|change|actually|make that|correct)\b/i.test(text)
  ) {
    return "add";
  }
  return "replace";
}

function savedBody(email: { notes: string[]; purpose?: string; scheduledSendId?: number }): string {
  if (email.scheduledSendId) {
    const row = getScheduledSend(email.scheduledSendId);
    if (row) {
      try {
        const request = JSON.parse(row.request) as { finalBody?: string; instruction?: string };
        if (request.finalBody?.trim()) {
          return request.finalBody;
        }
        if (request.instruction?.trim()) {
          return request.instruction;
        }
      } catch {
        // The row stays as it is. The draft notes are the fallback.
      }
    }
  }
  const note = [...email.notes].reverse().find((item) => item.startsWith("Current draft:"));
  if (note) {
    return note.replace(/^Current draft:\n?/, "");
  }
  return email.purpose ?? "";
}

/**
 * Rewrites the open draft from Vishnu's correction and stores that text as the
 * scheduled copy. The Gmail draft is written first; update_draft refuses it if the
 * scheduled email is already going out, so nothing changes and he is told. A schedule
 * write that fails afterwards cancels the send instead of leaving the old wording queued.
 */
export async function reviseLinkedDraft(
  chatId: number,
  instruction: string,
  now = new Date(),
  options: { subject?: string } = {},
): Promise<string> {
  const pending = getPendingAction(chatId, now);
  const email = pending?.email;
  if (!pending || !email) {
    return "I don't have an email open to change.";
  }
  const locked = lockedScheduleFor(email);
  if (locked) {
    return tooLateText(locked);
  }
  const current = savedBody(email);
  const mode = revisionMode(instruction);
  const rule =
    mode === "add"
      ? "Add the new fact. Keep every fact that is still true."
      : mode === "shorten"
        ? "Make the email shorter. Keep the commercial details and requirements he asked to retain."
        : "Replace the fact he corrected. The old value must not remain as if it were still true. Do not invent pricing, channels, or dates that he did not state.";
  const newSubject = options.subject?.trim();
  let written: { subject: string; body: string };
  try {
    written = await composeWithEmailAgent(
      [
        `Current subject: ${newSubject || email.subject || "(none)"}`,
        `Current body:\n${current || "(empty)"}`,
        `Vishnu's correction:\n${instruction}`,
        rule,
        "Keep the same recipient. Do not add a sign-off.",
      ].join("\n\n"),
    );
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Contextual revision failed (${errorType}).`);
    return "I didn't change the email. The previous wording is still in place.";
  }
  const subject = newSubject || email.subject?.trim() || written.subject;
  const notes = email.notes.filter((note) => !note.startsWith("Current draft:"));
  notes.push(`Current draft:\n${written.body}`);
  const notices: string[] = [];
  if (email.draftId) {
    let result: string;
    try {
      result = await updateDraft({
        draft_id: email.draftId,
        to: email.to.map((item) => item.email).join(", "),
        subject,
        body: written.body,
      });
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      console.error(`Contextual draft update failed (${errorType}).`);
      return "I couldn't update the Gmail draft, so nothing changed. The previous wording is still in place.";
    }
    const notice = draftUpdateNotice(result);
    if (notice && !result.startsWith("{")) {
      // Refused before Gmail: the email was claimed while this was being written.
      return notice;
    }
    if (notice) {
      notices.push(notice);
    }
  }
  // A schedule this chat links to the email, bound to the draft or not.
  const scheduleId = contextScheduleForDraft(email);
  let sync: ScheduleSync = { kind: "none" };
  if (scheduleId) {
    sync = applyToSchedule(scheduleId, { subject, body: written.body });
    if (sync.kind === "too_late" && !email.draftId) {
      // Nothing else was written, so nothing changed at all.
      return tooLateText(sync);
    }
    const notice = scheduleSyncNotice(sync);
    if (notice && !notices.includes(notice)) {
      notices.push(notice);
    }
  }
  const keepSchedule = sync.kind === "synced" || (sync.kind === "none" && !email.scheduledSendId);
  savePendingAction(
    chatId,
    {
      ...pending,
      email: keepSchedule ? { ...email, subject, notes } : { ...email, subject, notes, scheduledSendId: undefined, sendAt: undefined },
    },
    now,
  );
  const lead = email.draftId ? "Updated the draft." : "Updated the scheduled email.";
  if (notices.length > 0) {
    return `${lead} ${notices.join(" ")}`;
  }
  return sync.kind === "synced" && email.draftId ? `${lead} The scheduled copy matches it.` : lead;
}

export async function publishReadyDraft(
  chatId: number,
  now = new Date(),
): Promise<{ posted: boolean; draftId?: string; notice?: string }> {
  const pending = getPendingAction(chatId, now);
  const email = pending?.email;
  if (!pending || pending.status !== "open" || !email || email.to.length === 0 || !email.purpose) {
    return { posted: false };
  }
  const to = email.to.map((item) => item.email).join(", ");
  const name = email.to[0]?.name || "there";
  const facts = [
    `Recipient: ${name} <${email.to[0]?.email}>`,
    `Vishnu's instruction: ${email.purpose}`,
    email.notes.length ? `Notes:\n${email.notes.join("\n")}` : "",
    "Write the email. The To line is already chosen. Do not name a different recipient.",
  ].filter(Boolean).join("\n\n");
  const turn = {
    iteration: 1,
    calledTools: [] as string[],
    confirmation: { chatId, messageId: pending.confirmMessage },
    userText: "Draft the email. Do not send it.",
  };
  try {
    const written = await composeWithEmailAgent(
      email.draftId ? `${facts}\n\nRevise the email. Keep the same intent.` : facts,
    );
    const body = written.body;
    if (email.draftId) {
      const result = await updateDraft({ draft_id: email.draftId, to, body });
      const refused = draftUpdateNotice(result);
      if (refused && !result.startsWith("{")) {
        return { posted: true, draftId: email.draftId, notice: refused };
      }
      // The rewritten body is now the scheduled copy too, so the old wording can't go out.
      const scheduleId = contextScheduleForDraft(email);
      const sync: ScheduleSync = scheduleId
        ? applyToSchedule(scheduleId, { body })
        : { kind: "none" };
      const notice = [refused, scheduleSyncNotice(sync)].filter(Boolean).filter((item, index, all) => all.indexOf(item) === index).join(" ");
      const notes = email.notes.filter((note) => !note.startsWith("Current draft:"));
      notes.push(`Current draft:\n${body}`);
      const kept = sync.kind === "synced" || sync.kind === "none" ? email : { ...email, scheduledSendId: undefined, sendAt: undefined };
      savePendingAction(chatId, { ...pending, email: { ...kept, notes } }, now);
      return { posted: true, draftId: email.draftId, notice: notice || undefined };
    }
    const subject = written.subject || email.subject || subjectFrom(email.purpose);
    const created = await draftNewEmail(
      { to, subject, body, account: email.account, send_immediately: false },
      turn,
    );
    const draftId = /draft_id:\s*(\S+)/.exec(created)?.[1];
    if (!draftId) {
      return { posted: false };
    }
    savePendingAction(
      chatId,
      { ...pending, email: { ...email, draftId, subject } },
      now,
    );
    return { posted: true, draftId };
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Contextual draft failed (${errorType}).`);
    return { posted: false };
  }
}
