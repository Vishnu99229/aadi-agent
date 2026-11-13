import { buttonRows, extractFields } from "../helpers.js";
import type { SpecialistDefinition, Stoppable } from "../specialist.js";

interface FoundEmail {
  id?: string;
  account?: string;
  from?: string;
  subject?: string;
  date?: string;
  snippet?: string;
}

function parseEmails(raw: string): FoundEmail[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as FoundEmail[]) : [];
  } catch {
    return [];
  }
}

/**
 * The Email Agent: mail search and reading, drafts, sending, scheduled sends and
 * follow-up sequences. Every email Aadi sends leaves through this agent.
 */
export const emailAgent: SpecialistDefinition = {
  id: "email",
  name: "Email Agent",
  description:
    "Searches and reads Gmail, writes and updates drafts, sends email, and runs scheduled sends and follow-up sequences.",
  version: "1.0.0",
  promptFile: "email.md",
  tools: [
    { name: "search_emails", effect: "read", retry: "safe" },
    { name: "read_email", effect: "read", retry: "safe" },
    { name: "read_draft", effect: "read", retry: "safe" },
    { name: "draft_reply", effect: "draft", retry: "never" },
    { name: "draft_new_email", effect: "draft", retry: "never" },
    { name: "update_draft", effect: "draft", retry: "never" },
    { name: "draft_mom", effect: "draft", retry: "never" },
    { name: "start_sequence", effect: "draft", retry: "never" },
    { name: "resend_draft_card", effect: "write", retry: "never" },
    { name: "stop_sequence", effect: "write", retry: "never" },
    { name: "set_sequence_timezone", effect: "write", retry: "never" },
    { name: "confirm_send_pending_draft", effect: "external", retry: "never" },
    { name: "discard_pending_draft", effect: "external", retry: "never" },
    { name: "send_email", effect: "external", retry: "never" },
    { name: "cancel_scheduled_send", effect: "external", retry: "never" },
  ],
  sharedTools: ["get_current_time", "react_to_message", "search_notes"],
  routing: {
    patterns: [
      /\b(?:e-?mails?|inbox|gmail|mails?|mailbox|drafts?|repl(?:y|ied|ies)|follow[\s-]?ups?|sequences?|outbox|unread)\b/i,
    ],
    commandKinds: ["sequence", "sequence_stop", "sequence_timezone", "send", "draft", "draft_discard"],
  },
  capabilities: [
    {
      name: "outbox",
      description:
        "Everything due to go out without another tap: scheduled emails and active follow-up sequences, with their Cancel and Stop buttons.",
      kind: "workflow",
      effect: "read",
      retry: "safe",
      usesLlm: false,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      examples: ["Show my scheduled emails.", "What's in my outbox?", "Which follow-ups are running?"],
      triggers: [
        /^(?:show|list|what(?:'s|’s| is| are))\s+(?:me\s+)?(?:in\s+)?(?:my\s+|the\s+)?(?:scheduled\s+(?:e-?mails?|sends?)|outbox|(?:active\s+|running\s+)?(?:follow[\s-]?up\s+)?sequences)(?:\s+please)?[.?!]*$/i,
      ],
      handler: async () => {
        const { outboxPanel } = await import("../../outbox.js");
        const panel = outboxPanel();
        return { text: panel.text, output: { buttons: buttonRows(panel.keyboard) } };
      },
    },
    {
      name: "check_reply",
      description:
        "Check whether a person has replied recently and, if they did, what they said: whether they confirmed a meeting time, and which time.",
      kind: "workflow",
      effect: "read",
      retry: "safe",
      usesLlm: true,
      inputSchema: {
        type: "object",
        properties: {
          person: { type: "string", description: "Who the reply would be from: a name or an address." },
          about: { type: "string", description: "What the thread is about, in a few words." },
          days: { type: "integer", description: "How far back to look. Defaults to 7." },
        },
        required: ["person"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          replied: { type: "boolean" },
          confirmed_time: { type: "string" },
          from: { type: "string" },
          subject: { type: "string" },
          message_id: { type: "string" },
          summary: { type: "string" },
        },
        required: ["replied"],
      },
      handler: async (input, ctx) => {
        const person = String(input.person).trim();
        const days = typeof input.days === "number" && input.days > 0 ? Math.min(60, input.days) : 7;
        const about = typeof input.about === "string" ? input.about.trim() : "";
        const raw = await ctx.runTool("search_emails", {
          query: `from:(${person}) newer_than:${days}d${about ? ` ${about}` : ""}`,
          max_results: 5,
        });
        let found = parseEmails(raw);
        if (found.length === 0 && about) {
          found = parseEmails(
            await ctx.runTool("search_emails", { query: `from:(${person}) newer_than:${days}d`, max_results: 5 }),
          );
        }
        const latest = found
          .filter((email) => email.id)
          .sort((left, right) => Date.parse(right.date ?? "") - Date.parse(left.date ?? ""))[0];
        if (!latest?.id) {
          return {
            text: `No reply from ${person} in the last ${days} days.`,
            output: { replied: false, summary: `No reply from ${person} in the last ${days} days.` },
          };
        }
        const body = await ctx.runTool("read_email", {
          id: latest.id,
          ...(latest.account === "work" || latest.account === "personal" ? { account: latest.account } : {}),
        });
        const fields = await extractFields<{ confirmed_time: string | null; summary: string | null }>(ctx, {
          instruction:
            "This is an email reply. Did the sender confirm one specific meeting time? Give confirmed_time as ISO 8601 with the +05:30 offset only if they clearly agreed to one exact date and time; otherwise null. Give summary as one short sentence saying what they replied.",
          data: `Date header: ${latest.date ?? ""}\n${body}`,
          schema: {
            type: "object",
            properties: {
              confirmed_time: { type: ["string", "null"] },
              summary: { type: ["string", "null"] },
            },
            required: ["confirmed_time", "summary"],
            additionalProperties: false,
          },
        });
        const confirmed =
          typeof fields?.confirmed_time === "string" && !Number.isNaN(Date.parse(fields.confirmed_time))
            ? fields.confirmed_time
            : undefined;
        const summary = fields?.summary?.trim() || latest.snippet || "They replied.";
        return {
          text: `${latest.from ?? person} replied: ${summary}${confirmed ? ` Confirmed time: ${confirmed}.` : " No time confirmed."}`,
          output: {
            replied: true,
            ...(confirmed ? { confirmed_time: confirmed } : {}),
            from: latest.from ?? "",
            subject: latest.subject ?? "",
            message_id: latest.id,
            summary,
          },
        };
      },
    },
    {
      name: "prepare_followups",
      description:
        "Offer a follow-up sequence for each prospect named, or for each account an earlier step found. Each one is a Start card: nothing is sent or enrolled until Vishnu taps it.",
      kind: "workflow",
      effect: "draft",
      retry: "never",
      usesLlm: false,
      inputSchema: {
        type: "object",
        properties: {
          prospects: {
            type: "array",
            items: { type: "string" },
            description: "Names, companies or addresses. Omit to use the accounts an earlier step returned.",
          },
        },
        additionalProperties: false,
      },
      handler: async (input, ctx) => {
        const named = Array.isArray(input.prospects) ? input.prospects.map(String) : [];
        const fromSteps = Object.values(ctx.dependencies).flatMap((dep) => {
          const accounts = dep.output?.accounts;
          return Array.isArray(accounts)
            ? accounts.map((account) => String((account as { name?: unknown }).name ?? "")).filter(Boolean)
            : [];
        });
        const prospects = [...new Set([...named, ...fromSteps].map((name) => name.trim()).filter(Boolean))].slice(0, 10);
        if (prospects.length === 0) {
          return { text: "No accounts need a follow-up.", output: { offered: [] } };
        }
        const offered: Array<{ prospect: string; ok: boolean; result: string }> = [];
        for (const prospect of prospects) {
          try {
            offered.push({ prospect, ok: true, result: await ctx.runTool("start_sequence", { prospect }) });
          } catch (error) {
            offered.push({ prospect, ok: false, result: error instanceof Error ? error.message : String(error) });
          }
        }
        return {
          text: offered.map((item) => `${item.prospect}: ${item.result}`).join("\n"),
          output: { offered },
          nextAction: "Await Vishnu's Start tap on each card.",
        };
      },
    },
  ],
  jobs: async (api) => {
    const { startApprovalExpirySweep } = await import("../../approvals.js");
    const { registerSequenceDetection } = await import("../../sequences.js");
    const { registerSequenceSend } = await import("../../sequence_runner.js");
    const { registerScheduledSends } = await import("../../scheduled_sends.js");
    const sweep = startApprovalExpirySweep();
    return [
      { stop: () => clearInterval(sweep) },
      registerSequenceDetection(api),
      registerSequenceSend(api),
      registerScheduledSends(),
    ].filter((job): job is Stoppable => job !== undefined);
  },
};
