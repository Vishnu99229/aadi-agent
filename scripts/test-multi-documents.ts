import "dotenv/config";

process.env.AADI_DB_PATH ??= ":memory:";
process.env.LLM_PROVIDER ??= "claude";
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.OWNER_TELEGRAM_ID ??= "1";
process.env.CLAUDE_MODEL ??= "claude-sonnet-5-5";
process.env.ANTHROPIC_API_KEY ??= "test-key";
process.env.BRIEF_TIME ??= "08:00";

import { runAgent, setToolInterceptorForTests } from "../src/agent.ts";
import { createDocument, getDocument } from "../src/db.ts";
import { setCompleteForTests } from "../src/llm.ts";
import {
  getRecentUpload,
  recentUploadLine,
  setRecentUploadsForTests,
} from "../src/recent_upload.ts";
import { FORWARDED_TOOLS, TOOL_ORDER } from "../src/tools/index.ts";
import { handler as listDocumentsHandler } from "../src/tools/list_documents.ts";
import { modelReply } from "./fakes.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

{
  setRecentUploadsForTests([
    {
      documentId: 10,
      fileName: "msa.pdf",
      kind: "PDF",
      uploadedAt: Date.now() - 5 * 60_000,
    },
    {
      documentId: 11,
      fileName: "pricing.xlsx",
      kind: "XLSX",
      uploadedAt: Date.now() - 60_000,
    },
  ]);
  const block = recentUploadLine();
  assert(block !== null, "context block present for two uploads");
  assert(/id 11 — "pricing\.xlsx"/.test(block!), "newest id 11 listed");
  assert(/id 10 — "msa\.pdf"/.test(block!), "older id 10 listed");
  assert(
    /use id 11 \("pricing\.xlsx"\)/.test(block!),
    '"the document" points at newest',
  );
  console.log("two uploads → both ids in context: ok");
}

{
  const a = createDocument("msa.pdf", "work", "MSA text", null);
  const b = createDocument("pricing.xlsx", "work", "Pricing text", null);
  const listed = listDocumentsHandler({});
  assert(/id 2 — "pricing\.xlsx"/.test(listed), "list newest first: pricing");
  assert(/id 1 — "msa\.pdf"/.test(listed), "list includes msa");
  assert(
    listed.indexOf("pricing.xlsx") < listed.indexOf("msa.pdf"),
    "newest-first order",
  );
  assert(a.id === 1 && b.id === 2, "fixture ids");
  assert(
    TOOL_ORDER[TOOL_ORDER.length - 1] === "list_documents",
    "list_documents is last in TOOL_ORDER",
  );
  console.log("list_documents returns both newest-first: ok");
}


{
  setRecentUploadsForTests([
    {
      documentId: 99,
      fileName: "solo.pdf",
      kind: "PDF",
      uploadedAt: Date.now() - 10_000,
    },
  ]);
  const block = recentUploadLine()!;
  assert(/id 99 — "solo\.pdf"/.test(block), "single upload listed");
  assert(
    /use id 99 \("solo\.pdf"\)/.test(block),
    '"the document" resolves to the single upload',
  );
  assert(getRecentUpload()?.documentId === 99, "getRecentUpload is solo");
  console.log("single upload still works as the document: ok");
}

{
  assert(
    FORWARDED_TOOLS.includes("list_documents"),
    "forwarded turns may list_documents",
  );
  assert(
    FORWARDED_TOOLS.includes("read_document"),
    "forwarded turns may read_document",
  );
  const writeTools = [
    "remember",
    "add_task",
    "set_reminder",
    "create_meeting",
    "delete_calendar_event",
    "mark_bill_paid",
    "confirm_send_pending_draft",
  ] as const;
  for (const name of writeTools) {
    assert(
      !(FORWARDED_TOOLS as readonly string[]).includes(name),
      `forwarded turn must not offer write tool ${name}`,
    );
  }
  console.log("forwarded: list_documents ok, no write tools: ok");
}

setRecentUploadsForTests([]);
console.log("test-multi-documents: all passed");
