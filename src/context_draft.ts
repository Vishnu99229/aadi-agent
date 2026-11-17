import { getPendingAction, savePendingAction } from "./action_context.js";
import { complete, type CompleteResult } from "./llm.js";
import { resolveAgentModel } from "./models/agent_models.js";
import { handler as draftNewEmail } from "./tools/draft_new_email.js";
import { handler as updateDraft } from "./tools/update_draft.js";

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
export async function publishReadyDraft(
  chatId: number,
  now = new Date(),
): Promise<{ posted: boolean; draftId?: string }> {
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
      await updateDraft({ draft_id: email.draftId, to, body });
      const notes = email.notes.filter((note) => !note.startsWith("Current draft:"));
      notes.push(`Current draft:\n${body}`);
      savePendingAction(chatId, { ...pending, email: { ...email, notes } }, now);
      return { posted: true, draftId: email.draftId };
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
