/**
 * Benchmark claude / cloud-gemma / local-gemma on four tasks.
 * Does not change production routing. Sample Gmail/calendar data only.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { config } from "../src/config.ts";
import type {
  LlmBackend,
  LlmContentPart,
  LlmMessage,
  LlmTool,
  ToolCall,
} from "../src/llm.ts";
import { complete } from "../src/llm.ts";
import {
  LocalLlmBlockedError,
  assertLocalModelAllowed,
} from "../src/local_llm_guard.ts";
import { definition as draftReplyDef } from "../src/tools/draft_reply.ts";
import { definition as getCurrentTimeDef } from "../src/tools/get_current_time.ts";
import { handler as getCurrentTime } from "../src/tools/get_current_time.ts";
import { definition as listEventsDef } from "../src/tools/list_events.ts";
import { definition as readEmailDef } from "../src/tools/read_email.ts";
import { definition as searchEmailsDef } from "../src/tools/search_emails.ts";

const execFileAsync = promisify(execFile);
const TIME_ZONE = "Asia/Kolkata";
const PHONE_SSH = [
  "-p",
  "8022",
  "-o",
  "ConnectTimeout=8",
  "-o",
  "BatchMode=yes",
  "u0_a289@192.168.1.7",
];
const BACKENDS: LlmBackend[] = ["claude", "cloud-gemma", "local-gemma"];
const TASKS = ["document", "chat", "search_draft", "brief"] as const;
type TaskName = (typeof TASKS)[number];

const SAMPLE_EMAILS = [
  {
    id: "sample-msg-gcc",
    from: "Priya Sharma <priya@example.com>",
    subject: "Bengaluru GCC Summit — can you confirm?",
    date: "Mon, 12 Oct 2026 09:14:00 +0530",
    snippet:
      "Hi Vishnu, can you confirm if you're attending the GCC summit on 25 Nov? Need a yes/no by Friday.",
  },
  {
    id: "sample-msg-newsletter",
    from: "Industry Weekly <news@example.com>",
    subject: "This week in enterprise telephony",
    date: "Mon, 12 Oct 2026 07:02:00 +0530",
    snippet: "Five headlines you can skip. Unsubscribe anytime.",
  },
];

const SAMPLE_EMAIL_BODY = `From: Priya Sharma <priya@example.com>
To: Vishnu <vishnu@example.com>
Subject: Bengaluru GCC Summit — can you confirm?
Date: Mon, 12 Oct 2026 09:14:00 +0530

Hi Vishnu,

Can you confirm if you are attending the Bengaluru GCC Summit on 25 Nov 2026 at Sheraton Grand Brigade Gateway? I need a yes or no by Friday so I can lock the booth.

Thanks,
Priya`;

const SAMPLE_EVENTS = `1. Epicode account review
Start: 2026-10-14T10:00:00+05:30
End: 2026-10-14T11:00:00+05:30
Location: Google Meet
Attendees: Priya Sharma

2. GoSchedule.ai design sync
Start: 2026-10-14T16:00:00+05:30
End: 2026-10-14T16:45:00+05:30
Location:
Attendees:`;

const SAMPLE_LOCAL_DATA = JSON.stringify({
  date: "2026-10-14",
  work: {
    overdue_tasks: [
      { id: 11, text: "Send Epicode pricing follow-up", due_at: "2026-10-13T18:00:00+05:30" },
    ],
    tasks_due_today: [
      { id: 12, text: "Draft GCC booth one-pager", due_at: "2026-10-14T17:00:00+05:30" },
    ],
    todays_reminders: [],
  },
  personal: {
    overdue_tasks: [],
    tasks_due_today: [],
    todays_reminders: [
      { id: 21, text: "Call Amma", remind_at: "2026-10-14T20:00:00+05:30", recurrence: "none", status: "pending" },
    ],
    upcoming_bills: [
      { id: 31, biller: "Airtel Fiber", amount: 999, currency: "INR", due_date: "2026-10-18" },
    ],
    overdue_bills: [],
    upcoming_important_dates: [
      { id: 41, person: "Amma", month_day: "10-20", type: "birthday" },
    ],
  },
});

interface ToolTrace {
  name: string;
  input: unknown;
  invented: boolean;
}

interface BenchRow {
  backend: LlmBackend;
  task: TaskName;
  seconds: number;
  toolCorrect: string;
  quality: string;
  costUsd: number;
  peakRamMb: number | null;
  notes: string;
  outputPreview: string;
}

function formatNow(): string {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "full",
    timeStyle: "long",
    timeZone: TIME_ZONE,
  }).format(new Date());
}

function systemPrompt(): { cacheable: string; dynamic: string } {
  return {
    cacheable: `You are Aadi, Vishnu's personal assistant on Telegram.
Plain text only. Lead with the answer. Never invent facts.
For the current date, time, or weekday, call get_current_time first.
Email: search and read sample inboxes with the provided tools; create drafts with draft_reply. You cannot send email.
Calendar: list_events only. Do not invent events.
Drafting: write in first person as Vishnu and sign off as "Vishnu". Never invent commitments.`,
    dynamic: `Current date and time in ${TIME_ZONE}: ${formatNow()}`,
  };
}

function allowedNames(tools: LlmTool[]): Set<string> {
  return new Set(
    tools
      .filter((tool): tool is Extract<LlmTool, { type: "function" }> => tool.type === "function")
      .map((tool) => tool.name),
  );
}

function stubToolResult(call: ToolCall): string {
  if (call.name === "get_current_time") {
    return getCurrentTime();
  }
  if (call.name === "search_emails") {
    return JSON.stringify(SAMPLE_EMAILS, null, 2);
  }
  if (call.name === "read_email") {
    const id =
      call.input && typeof call.input === "object"
        ? String((call.input as { id?: unknown }).id ?? "")
        : "";
    if (id === "sample-msg-newsletter") {
      return "From: Industry Weekly\nSubject: This week in enterprise telephony\n\nFive headlines you can skip.";
    }
    return SAMPLE_EMAIL_BODY;
  }
  if (call.name === "draft_reply") {
    const values = (call.input ?? {}) as { email_id?: unknown; body?: unknown };
    if (typeof values.email_id !== "string" || !values.email_id.trim()) {
      return "Tool error: email_id must be a non-empty id.";
    }
    if (typeof values.body !== "string" || !values.body.trim()) {
      return "Tool error: body must be a non-empty plain-text reply.";
    }
    return JSON.stringify({ draft_id: "sample-draft-1" });
  }
  if (call.name === "list_events") {
    return SAMPLE_EVENTS;
  }
  return `Unknown tool: ${call.name}`;
}

function argumentErrors(call: ToolCall): string[] {
  const input =
    call.input && typeof call.input === "object"
      ? (call.input as Record<string, unknown>)
      : {};
  if (call.name === "get_current_time") {
    return [];
  }
  if (call.name === "search_emails") {
    return typeof input.query === "string" && input.query.trim()
      ? []
      : ["search_emails.query missing"];
  }
  if (call.name === "read_email") {
    return typeof input.id === "string" && input.id.trim()
      ? []
      : ["read_email.id missing"];
  }
  if (call.name === "draft_reply") {
    const errors = [];
    if (typeof input.email_id !== "string" || !input.email_id.trim()) {
      errors.push("draft_reply.email_id missing");
    } else if (!SAMPLE_EMAILS.some((email) => email.id === input.email_id)) {
      errors.push("draft_reply.email_id not from sample set");
    }
    if (typeof input.body !== "string" || !input.body.trim()) {
      errors.push("draft_reply.body missing");
    }
    return errors;
  }
  if (call.name === "list_events") {
    const errors = [];
    if (
      typeof input.start_date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(input.start_date)
    ) {
      errors.push("list_events.start_date invalid");
    }
    if (
      typeof input.end_date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(input.end_date)
    ) {
      errors.push("list_events.end_date invalid");
    }
    return errors;
  }
  return [];
}

async function runToolLoop(options: {
  backend: LlmBackend;
  user: string | LlmContentPart[];
  tools: LlmTool[];
  timeoutMs: number;
  maxTokens?: number;
}): Promise<{
  text: string;
  traces: ToolTrace[];
  costUsd: number;
  notes: string[];
}> {
  const known = allowedNames(options.tools);
  const messages: LlmMessage[] = [{ role: "user", content: options.user }];
  const traces: ToolTrace[] = [];
  const notes: string[] = [];
  let costUsd = 0;
  let text = "";

  for (let iteration = 1; iteration <= 6; iteration += 1) {
    const response = await complete({
      backend: options.backend,
      system: systemPrompt(),
      tools: options.tools,
      messages,
      timeoutMs: options.timeoutMs,
      maxTokens: options.maxTokens,
    });
    costUsd += response.usage.estimatedCostUsd;
    const responseText = response.textParts.join("\n").trim();
    if (responseText) {
      text = responseText;
    }
    for (const call of response.toolCalls) {
      traces.push({
        name: call.name,
        input: call.input,
        invented: !known.has(call.name),
      });
    }
    if (response.stopReason !== "tool_use") {
      if (!text) {
        notes.push(`stop=${response.stopReason}`);
      }
      return { text, traces, costUsd, notes };
    }
    const clientCalls = response.toolCalls.filter(
      (call) => call.execution === "client",
    );
    if (clientCalls.length === 0) {
      notes.push("tool_use with no client calls");
      return { text, traces, costUsd, notes };
    }
    messages.push({
      role: "assistant",
      textParts: response.textParts,
      toolCalls: response.toolCalls,
    });
    for (const call of clientCalls) {
      messages.push({
        role: "tool",
        toolCallId: call.id,
        content: stubToolResult(call),
        isError: !known.has(call.name),
      });
    }
  }
  notes.push("hit 6-iteration limit");
  return { text, traces, costUsd, notes };
}

function toolCorrectness(
  traces: ToolTrace[],
  expected: string[],
  requiredOrder?: string[],
): { ok: boolean; label: string } {
  const names = traces.map((trace) => trace.name);
  const invented = traces.filter((trace) => trace.invented).map((trace) => trace.name);
  const inputIssues: string[] = [];
  for (const trace of traces) {
    if (trace.invented) {
      continue;
    }
    inputIssues.push(
      ...argumentErrors({
        id: "bench",
        name: trace.name,
        input: trace.input,
        execution: "client",
      }),
    );
  }
  const missing = expected.filter((name) => !names.includes(name));
  let orderOk = true;
  if (requiredOrder && requiredOrder.length >= 2) {
    const first = names.indexOf(requiredOrder[0]!);
    const second = names.indexOf(requiredOrder[1]!);
    orderOk = first >= 0 && second > first;
  }
  const ok =
    invented.length === 0 &&
    inputIssues.length === 0 &&
    missing.length === 0 &&
    orderOk;
  const parts = [];
  if (invented.length) {
    parts.push(`invented ${invented.join(",")}`);
  }
  if (inputIssues.length) {
    parts.push(inputIssues.join("; "));
  }
  if (missing.length) {
    parts.push(`missing ${missing.join(",")}`);
  }
  if (!orderOk) {
    parts.push(`order ${requiredOrder?.join("→")}`);
  }
  if (names.length) {
    parts.unshift(names.join(" → "));
  } else {
    parts.unshift("no tools");
  }
  return { ok, label: (ok ? "ok: " : "FAIL: ") + parts.join("; ") };
}

function scoreChat(text: string, traces: ToolTrace[]): string {
  const usedTime = traces.some((trace) => trace.name === "get_current_time");
  const hasClock = /\d{1,2}:\d{2}/.test(text);
  if (usedTime && hasClock) {
    return "5 — used get_current_time and reported a time";
  }
  if (usedTime) {
    return "3 — called time tool but answer was vague";
  }
  if (hasClock) {
    return "2 — stated a time without the tool";
  }
  return "1 — did not answer the time";
}

function scoreDraft(text: string, traces: ToolTrace[]): string {
  const draft = traces.find((trace) => trace.name === "draft_reply");
  const body =
    draft && draft.input && typeof draft.input === "object"
      ? String((draft.input as { body?: unknown }).body ?? "")
      : "";
  const signed = /Vishnu\s*$/m.test(body);
  const aboutEvent = /gcc|summit|25|attend|booth/i.test(body);
  const mentionsDraft = /draft|approval|waiting/i.test(text);
  if (draft && signed && aboutEvent && mentionsDraft) {
    return "5 — searched, drafted as Vishnu, noted approval";
  }
  if (draft && signed) {
    return "4 — draft created as Vishnu";
  }
  if (draft) {
    return "3 — draft created but weak body";
  }
  if (/priya|summit/i.test(text)) {
    return "2 — talked about the email but did not draft";
  }
  return "1 — did not handle the email task";
}

function scoreBrief(text: string): string {
  const hasWork = /WORK/i.test(text);
  const hasPersonal = /PERSONAL/i.test(text);
  const usesSample =
    /epicode|goschedule|priya|airtel|amma/i.test(text);
  const structure =
    /email/i.test(text) && /calendar/i.test(text) && /bill/i.test(text);
  if (hasWork && hasPersonal && usesSample && structure) {
    return "5 — WORK/PERSONAL with sample emails, calendar, bills";
  }
  if (hasWork && hasPersonal && usesSample) {
    return "4 — sections present, used sample facts";
  }
  if (hasWork && hasPersonal) {
    return "3 — sections present but thin";
  }
  if (text.trim()) {
    return "2 — some brief text";
  }
  return "1 — empty";
}

function scorePdf(text: string): string {
  const date = /25\s*(Nov|November)\s*2026/i.test(text);
  const dubai = /971[\s-]*50[\s-]*943[\s-]*1529/.test(text.replace(/\s+/g, ""));
  const india = /91[\s-]*77809[\s-]*85893/.test(text.replace(/\s+/g, " "));
  const indiaAlt = /77809[\s-]*85893/.test(text);
  const phones = dubai && (india || indiaAlt);
  if (date && phones) {
    return "pass — 25 Nov 2026 and page-17 phones";
  }
  if (date) {
    return "partial — date yes, phones no";
  }
  if (phones) {
    return "partial — phones yes, date no";
  }
  return "fail — missed 25 Nov 2026 and page-17 phones";
}

async function renderPdfJpegs(pdfPath: string): Promise<LlmContentPart[]> {
  const dir = await mkdtemp(join(tmpdir(), "aadi-bench-"));
  const script = `import os, sys
import pypdfium2 as pdfium
pdf = pdfium.PdfDocument(sys.argv[1])
out = sys.argv[2]
scale = float(sys.argv[3])
for i in range(len(pdf)):
    image = pdf[i].render(scale=scale).to_pil()
    image.convert("RGB").save(os.path.join(out, f"page-{i+1:02d}.jpg"), "JPEG", quality=52)
print(len(pdf))
`;
  const scriptPath = join(dir, "render.py");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(scriptPath, script);
  await execFileAsync("python3", [scriptPath, pdfPath, dir, "0.28"], {
    timeout: 120_000,
  });
  const files = (await readdir(dir))
    .filter((name) => name.endsWith(".jpg"))
    .sort();
  const parts: LlmContentPart[] = [];
  for (const file of files) {
    const bytes = await readFile(join(dir, file));
    parts.push({
      type: "image",
      mediaType: "image/jpeg",
      data: bytes.toString("base64"),
    });
  }
  await rm(dir, { recursive: true, force: true });
  return parts;
}

async function brochurePath(): Promise<string> {
  const dir = fileURLToPath(new URL("../test-fixtures/", import.meta.url));
  const files = (await readdir(dir)).filter((name) =>
    name.toLowerCase().endsWith(".pdf"),
  );
  if (files.length === 0) {
    throw new Error("No PDF found in test-fixtures/.");
  }
  return join(dir, files.sort()[0]!);
}

async function phoneUsedMb(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ssh", [...PHONE_SSH, "free -m"], {
      timeout: 15_000,
    });
    const line = stdout
      .split("\n")
      .find((row) => row.toLowerCase().startsWith("mem:"));
    if (!line) {
      return null;
    }
    const parts = line.trim().split(/\s+/);
    const used = Number(parts[2]);
    return Number.isFinite(used) ? used : null;
  } catch {
    return null;
  }
}

function startRamSampler(): { stop: () => Promise<number | null> } {
  let peak: number | null = null;
  let active = true;
  const tick = async () => {
    const used = await phoneUsedMb();
    if (used !== null) {
      peak = peak === null ? used : Math.max(peak, used);
    }
  };
  void tick();
  const timer = setInterval(() => {
    if (active) {
      void tick();
    }
  }, 4000);
  return {
    stop: async () => {
      active = false;
      clearInterval(timer);
      await tick();
      return peak;
    },
  };
}

function classifyFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("aborted")) {
    return `timeout: ${message}`;
  }
  if (
    lower.includes("out of memory") ||
    lower.includes("oom") ||
    lower.includes("enomem") ||
    lower.includes("killed")
  ) {
    return `out-of-memory: ${message}`;
  }
  if (lower.includes("econnrefused") || lower.includes("fetch failed")) {
    return `crash/connect: ${message}`;
  }
  return `error: ${message}`;
}

async function runTask(
  backend: LlmBackend,
  task: TaskName,
  pdfBytes: Uint8Array,
  jpegParts: LlmContentPart[],
): Promise<BenchRow> {
  const started = Date.now();
  const ram =
    backend === "local-gemma" ? startRamSampler() : null;
  const timeoutMs =
    task === "document"
      ? backend === "local-gemma"
        ? 20 * 60 * 1000
        : 10 * 60 * 1000
      : backend === "local-gemma"
        ? 15 * 60 * 1000
        : 3 * 60 * 1000;
  try {
    let result: Awaited<ReturnType<typeof runToolLoop>>;
    if (task === "document") {
      const prompt =
        "Analyze this 17-page Bengaluru GCC Summit brochure. List what it is, the event date, venue, and every phone number printed on the last page (page 17). Do not invent figures. Short bullets.";
      const user: LlmContentPart[] =
        backend === "claude"
          ? [
              {
                type: "document",
                mediaType: "application/pdf",
                data: Buffer.from(pdfBytes).toString("base64"),
              },
              { type: "text", text: prompt },
            ]
          : [...jpegParts, { type: "text", text: prompt }];
      result = await runToolLoop({
        backend,
        user,
        tools: [],
        timeoutMs,
        maxTokens: 2048,
      });
    } else if (task === "chat") {
      result = await runToolLoop({
        backend,
        user: "what time is it?",
        tools: [getCurrentTimeDef],
        timeoutMs,
      });
    } else if (task === "search_draft") {
      result = await runToolLoop({
        backend,
        user:
          "Priya emailed asking if I can confirm attendance at the Bengaluru GCC Summit. Search my mail, read it if needed, and draft a short reply saying yes I will attend. Do not send.",
        tools: [searchEmailsDef, readEmailDef, draftReplyDef],
        timeoutMs,
      });
    } else {
      result = await runToolLoop({
        backend,
        user: `Build Vishnu's morning brief now from sample data only.
Use search_emails with query "is:unread newer_than:1d" and list_events for today (2026-10-14) in Asia/Kolkata.
Use the local task and reminder data below. Do not call list_tasks or list_reminders.

<local_task_and_reminder_data>
${SAMPLE_LOCAL_DATA}
</local_task_and_reminder_data>

Output two top-level sections in this exact order: WORK, then PERSONAL. Within WORK: Email, Calendar, Overdue tasks, Tasks due today, Today's reminders. Within PERSONAL: the same task/reminder subsections plus Upcoming bills and Upcoming important dates. Say "None" for an empty subsection. Plain text.`,
        tools: [searchEmailsDef, listEventsDef],
        timeoutMs,
      });
    }

    const seconds = (Date.now() - started) / 1000;
    const peakRamMb = ram ? await ram.stop() : null;
    let tools;
    if (task === "document") {
      tools = toolCorrectness(result.traces, []);
      if (result.traces.length === 0) {
        tools = { ok: true, label: "ok: no tools (analysis only)" };
      }
    } else if (task === "chat") {
      tools = toolCorrectness(result.traces, ["get_current_time"]);
    } else if (task === "search_draft") {
      tools = toolCorrectness(result.traces, ["search_emails", "draft_reply"], [
        "search_emails",
        "draft_reply",
      ]);
    } else {
      tools = toolCorrectness(result.traces, ["search_emails", "list_events"]);
    }
    const quality =
      task === "document"
        ? scorePdf(result.text)
        : task === "chat"
          ? scoreChat(result.text, result.traces)
          : task === "search_draft"
            ? scoreDraft(result.text, result.traces)
            : scoreBrief(result.text);
    return {
      backend,
      task,
      seconds,
      toolCorrect: tools.label,
      quality,
      costUsd: result.costUsd,
      peakRamMb,
      notes: result.notes.join("; ") || "ok",
      outputPreview: result.text.slice(0, 240).replace(/\s+/g, " "),
    };
  } catch (error) {
    const peakRamMb = ram ? await ram.stop() : null;
    return {
      backend,
      task,
      seconds: (Date.now() - started) / 1000,
      toolCorrect: "n/a",
      quality: "n/a",
      costUsd: 0,
      peakRamMb,
      notes: classifyFailure(error),
      outputPreview: "",
    };
  }
}

function printTable(rows: BenchRow[]): void {
  const header = [
    "backend",
    "task",
    "sec",
    "costUSD",
    "peakRAM",
    "tools",
    "quality",
    "notes",
  ];
  console.log("\n=== MODEL BENCH ===");
  console.log(header.join(" | "));
  for (const row of rows) {
    console.log(
      [
        row.backend,
        row.task,
        row.seconds.toFixed(1),
        row.costUsd.toFixed(6),
        row.peakRamMb === null ? "-" : `${row.peakRamMb}MB`,
        row.toolCorrect,
        row.quality,
        row.notes,
      ].join(" | "),
    );
  }
  console.log("\nPreviews:");
  for (const row of rows) {
    if (row.outputPreview) {
      console.log(`- ${row.backend}/${row.task}: ${row.outputPreview}`);
    }
  }
}

const only = process.env.BENCH_BACKENDS?.split(",")
  .map((value) => value.trim())
  .filter(Boolean) as LlmBackend[] | undefined;
const backends = only?.length ? only : BACKENDS;
const onlyTasks = process.env.BENCH_TASKS?.split(",")
  .map((value) => value.trim())
  .filter(Boolean) as TaskName[] | undefined;
const tasks = onlyTasks?.length ? onlyTasks : [...TASKS];

if (backends.includes("local-gemma")) {
  try {
    await assertLocalModelAllowed();
  } catch (error) {
    const message =
      error instanceof LocalLlmBlockedError || error instanceof Error
        ? error.message
        : String(error);
    console.error(message);
    process.exit(1);
  }
}

const pdfPath = await brochurePath();
const pdfBytes = new Uint8Array(await readFile(pdfPath));
console.log(
  `Brochure: ${pdfPath} (${(pdfBytes.byteLength / 1024 / 1024).toFixed(2)} MB)`,
);
console.log(
  `Defaults unchanged: LLM_PROVIDER=${config.llmProvider} CLAUDE_MODEL=${config.claudeModel}`,
);
console.log(
  `cloud-gemma=${config.gemmaCloudModel} local=${config.localLlmModel} @ ${config.localLlmBaseUrl}`,
);

console.log("Rendering brochure pages for Gemma vision…");
const jpegParts = await renderPdfJpegs(pdfPath);
console.log(`Rendered ${jpegParts.length} JPEG pages.`);

const rows: BenchRow[] = [];

for (const backend of backends) {
  for (const task of tasks) {
    console.log(`\n--- ${backend} / ${task} ---`);
    const row = await runTask(backend, task, pdfBytes, jpegParts);
    rows.push(row);
    console.log(JSON.stringify(row, null, 2));
  }
}

printTable(rows);
