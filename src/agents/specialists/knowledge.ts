import { RELEASE_QUESTION } from "../../release_logic.js";
import { extractFields } from "../helpers.js";
import type { SpecialistDefinition, Stoppable } from "../specialist.js";
import { InputRequiredSignal } from "../types.js";

/**
 * The Knowledge Agent: documents, Drive, sheets, attachments, the Q&A bank,
 * long-term memory, call notes, past chat and web search.
 */
export const knowledgeAgent: SpecialistDefinition = {
  id: "knowledge",
  name: "Knowledge Agent",
  description:
    "Reads uploaded documents, Drive files, sheets and email attachments, searches the web, looks up the latest release of software or a protocol from its official release list, and keeps the Q&A bank, long-term memory and call notes.",
  version: "1.0.0",
  promptFile: "knowledge.md",
  tools: [
    { name: "read_document", effect: "read", retry: "safe" },
    { name: "list_documents", effect: "read", retry: "safe" },
    { name: "read_attachment", effect: "read", retry: "safe" },
    { name: "list_attachments", effect: "read", retry: "safe" },
    { name: "read_drive_file", effect: "read", retry: "safe" },
    { name: "search_drive", effect: "read", retry: "safe" },
    { name: "read_sheet", effect: "read", retry: "safe" },
    { name: "search_qa_bank", effect: "read", retry: "safe" },
    { name: "web_search", effect: "read", retry: "safe", remoteExposed: true },
    { name: "latest_release", effect: "read", retry: "safe" },
    { name: "search_memories", effect: "read", retry: "safe" },
    { name: "list_memories", effect: "read", retry: "safe" },
    { name: "search_history", effect: "read", retry: "safe" },
    { name: "search_notes", effect: "read", retry: "safe" },
    { name: "learn_qa_bank", effect: "write", retry: "never" },
    { name: "remember", effect: "write", retry: "never" },
    { name: "update_memory", effect: "write", retry: "never" },
    { name: "forget_memory", effect: "write", retry: "never" },
  ],
  sharedTools: ["get_current_time", "react_to_message", "search_emails"],
  routing: {
    patterns: [
      /\b(?:documents?|docs?|pdfs?|drive|sheets?|spreadsheets?|rfps?|questionnaires?|q\s*&\s*a|memor(?:y|ies)|attachments?|uploads?|uploaded|files?|scans?|scanned|photos?|screenshots?|call\s+notes|meeting\s+notes|search\s+the\s+web|google\s+it)\b/i,
      // "What's the latest version of X?" is a lookup, whether or not he says "search".
      RELEASE_QUESTION,
    ],
    commandKinds: ["memory", "qa_bank"],
  },
  capabilities: [
    {
      name: "extract_bill",
      description:
        "Read a stored document that is a bill or invoice and return who it is from, the amount and the due date. Uses the most recent upload when no id is given.",
      kind: "workflow",
      effect: "read",
      retry: "safe",
      usesLlm: true,
      inputSchema: {
        type: "object",
        properties: { document_id: { type: "integer", description: "The stored document's id." } },
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          biller: { type: "string" },
          amount: { type: "number" },
          currency: { type: "string" },
          due_date: { type: "string" },
          document_id: { type: "integer" },
        },
        required: ["document_id"],
      },
      handler: async (input, ctx) => {
        const { getRecentUpload } = await import("../../recent_upload.js");
        const id = typeof input.document_id === "number" ? input.document_id : getRecentUpload()?.documentId;
        if (!id) {
          throw new InputRequiredSignal({
            question: "Which document is the bill? Send it, or tell me its id.",
            fields: ["document_id"],
            from: "user",
          });
        }
        const text = await ctx.runTool("read_document", { id, question: "amount due and due date" });
        const fields = await extractFields<{
          biller: string | null;
          amount: number | null;
          currency: string | null;
          due_date: string | null;
        }>(ctx, {
          instruction:
            "This is the text of a bill. Give the biller's name, the total amount due as a number, the currency code (INR if it is rupees), and the payment due date as YYYY-MM-DD.",
          data: text,
          schema: {
            type: "object",
            properties: {
              biller: { type: ["string", "null"] },
              amount: { type: ["number", "null"] },
              currency: { type: ["string", "null"] },
              due_date: { type: ["string", "null"] },
            },
            required: ["biller", "amount", "currency", "due_date"],
            additionalProperties: false,
          },
        });
        const dueDate =
          typeof fields?.due_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fields.due_date)
            ? fields.due_date
            : undefined;
        const output = {
          document_id: id,
          ...(fields?.biller ? { biller: fields.biller } : {}),
          ...(typeof fields?.amount === "number" ? { amount: fields.amount } : {}),
          ...(fields?.currency ? { currency: fields.currency } : {}),
          ...(dueDate ? { due_date: dueDate } : {}),
        };
        return {
          text: `${fields?.biller ?? "Bill"}: ${
            typeof fields?.amount === "number" ? `${fields.currency ?? "INR"} ${fields.amount}` : "amount not found"
          }, ${dueDate ? `due ${dueDate}` : "due date not found"}.`,
          output,
        };
      },
    },
  ],
  jobs: async (api) => {
    const { startDocumentExpirySweep } = await import("../../documents.js");
    const { registerAttachmentAlertScan } = await import("../../attachment_alerts.js");
    const { registerMessageEmbed } = await import("../../embeddings.js");
    const { registerJobWorker } = await import("../../job_worker.js");
    const sweep = startDocumentExpirySweep();
    const jobs: Stoppable[] = [
      { stop: () => clearInterval(sweep) },
      registerAttachmentAlertScan(api),
      registerJobWorker(api),
      registerMessageEmbed(),
    ];
    return jobs;
  },
};
