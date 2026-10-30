import type { Api } from "grammy";
import { config } from "./config.js";
import { completeForJob } from "./job_llm.js";
import {
  addJobCost,
  createJob,
  createTask,
  getDocument,
  getJob,
  insertJobStep,
  listActiveJobs,
  listJobSteps,
  listJobs,
  recoverStuckJobSteps,
  searchQaBank,
  updateJob,
  updateJobStep,
  type JobRecord,
  type JobStepRecord,
} from "./db.js";
import { chunkText, TEXT_CHUNK_CHARS } from "./document_review_logic.js";
import {
  DEFAULT_JOB_BUDGET_USD,
  JOB_MAX_ATTEMPTS,
  JOB_STUCK_MS,
  dependentsToSkip,
  documentChunkCount,
  evaluateDoneCheck,
  extractNumberedQuestions,
  formatFinalMessage,
  formatJobsList,
  formatPlanMessage,
  formatProgressMessage,
  matchJob,
  parseDependsOn,
  parseDoneCondition,
  parseJobCommand,
  parseResultRef,
  looksLikeBigJob,
  type PlannedJob,
} from "./job_logic.js";
import { planJobFromOwnerMessage } from "./job_plan.js";
import { getRecentUpload } from "./recent_upload.js";
import { everyMs, type IntervalJob } from "./scheduler.js";
import { assertTestSeam } from "./test_seam.js";

const CHUNKS_PER_TICK = 3;
const ANSWER_BATCH = 8;

type StepExecutor = (
  job: JobRecord,
  step: JobStepRecord,
) => Promise<Record<string, unknown>>;

let executeOverride: StepExecutor | undefined;
let notifyApi: Api | undefined;

export function setJobExecutorForTests(fn: StepExecutor | undefined): void {
  assertTestSeam("setJobExecutorForTests");
  executeOverride = fn;
}

function logJob(jobId: number, stepId: string, extra: string): void {
  console.log(`job_id=${jobId} step=${stepId} ${extra}`);
}

function parseJsonObject(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  const slice =
    start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
  return JSON.parse(slice);
}

async function jobComplete(
  jobId: number,
  prompt: string,
  maxTokens = 1200,
): Promise<Record<string, unknown>> {
  const result = await completeForJob({
    task: "document",
    effort: "low",
    cacheTtl: "5m",
    maxTokens,
    tools: [],
    system: {
      cacheable:
        "You help Aadi finish one job step. Reply with JSON only. Never send email or book a meeting.",
    },
    messages: [{ role: "user", content: prompt }],
  });
  addJobCost(jobId, result.usage.estimatedCostUsd);
  const text = result.textParts.join("\n").trim();
  if (!text) {
    return {};
  }
  try {
    const parsed = parseJsonObject(text);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : { text };
  } catch {
    return { text };
  }
}

function documentIdFrom(step: JobStepRecord): number | undefined {
  const input = parseResultRef(step.input_ref);
  const value = input.document_id;
  return typeof value === "number" && value > 0 ? value : undefined;
}

async function executeReadChunk(
  job: JobRecord,
  step: JobStepRecord,
): Promise<Record<string, unknown>> {
  const documentId = documentIdFrom(step);
  const document = documentId ? getDocument(documentId) : undefined;
  if (!document) {
    throw new Error("document_id missing or expired");
  }
  const chunks = chunkText(document.extracted_text, TEXT_CHUNK_CHARS);
  const prior = parseResultRef(step.result_ref);
  const notes = Array.isArray(prior.notes)
    ? [...(prior.notes as string[])]
    : [];
  const questions = Array.isArray(prior.questions)
    ? [...(prior.questions as string[])]
    : extractNumberedQuestions(document.extracted_text);
  let processed = Number(prior.processed ?? 0);
  const end = Math.min(chunks.length, processed + CHUNKS_PER_TICK);
  for (let index = processed; index < end; index += 1) {
    const extracted = await jobComplete(
      job.job_id,
      `Extract notes and any numbered questions from this chunk (${index + 1}/${chunks.length}). JSON: {"notes":"","questions":["..."]}\n\n<chunk>\n${chunks[index]}\n</chunk>`,
      800,
    );
    if (typeof extracted.notes === "string" && extracted.notes.trim()) {
      notes.push(extracted.notes.trim());
    } else {
      notes.push(`chunk ${index + 1} read`);
    }
    if (Array.isArray(extracted.questions)) {
      for (const item of extracted.questions) {
        if (typeof item === "string" && item.trim()) {
          questions.push(item.trim());
        }
      }
    }
    processed = index + 1;
  }
  return {
    processed,
    expected: chunks.length,
    notes,
    questions,
  };
}

async function executeAnswerQuestions(
  job: JobRecord,
  step: JobStepRecord,
): Promise<Record<string, unknown>> {
  const prior = parseResultRef(step.result_ref);
  const documentId = documentIdFrom(step);
  const document = documentId ? getDocument(documentId) : undefined;
  let questions = Array.isArray(prior.questions)
    ? (prior.questions as unknown[]).filter(
        (item): item is string => typeof item === "string" && Boolean(item.trim()),
      )
    : [];
  if (questions.length === 0 && document) {
    questions = extractNumberedQuestions(document.extracted_text);
  }
  const answers = Array.isArray(prior.answers)
    ? [...(prior.answers as Array<{ i: number; text: string }>)]
    : [];
  const filled = (): Set<number> =>
    new Set(
      answers
        .filter((row) => row && typeof row.text === "string" && row.text.trim())
        .map((row) => row.i),
    );
  for (let batchN = 0; batchN < 6; batchN += 1) {
    const pending = questions
      .map((question, index) => ({ i: index, question }))
      .filter((row) => !filled().has(row.i));
    const batch = pending.slice(0, ANSWER_BATCH);
    if (batch.length === 0) {
      break;
    }
    const before = filled().size;
    const withBank = batch.map((row) => {
      const hits = searchQaBank(row.question, 2);
      return {
        i: row.i,
        question: row.question,
        bank: hits.map((hit) => hit.answer),
      };
    });
    const context = document
      ? batch
          .map((row) => {
            const chunks = chunkText(document.extracted_text, TEXT_CHUNK_CHARS);
            const hit = chunks.find((chunk) =>
              chunk.toLowerCase().includes(row.question.slice(0, 40).toLowerCase()),
            );
            return hit ?? "";
          })
          .filter(Boolean)
          .join("\n---\n")
          .slice(0, 12_000)
      : "";
    const extracted = await jobComplete(
      job.job_id,
      `Answer these questions. JSON: {"answers":[{"i":0,"text":"..."}]}\nUse the source notes. If unknown, say "needs Vishnu".\nQuestions: ${JSON.stringify(withBank)}\n\n<source>\n${context}\n</source>`,
      2000,
    );
    if (Array.isArray(extracted.answers)) {
      for (const row of extracted.answers) {
        if (!row || typeof row !== "object") {
          continue;
        }
        const item = row as { i?: unknown; text?: unknown };
        const i = typeof item.i === "number" ? item.i : -1;
        const text = typeof item.text === "string" ? item.text.trim() : "";
        if (i < 0 || !text) {
          continue;
        }
        const existing = answers.findIndex((entry) => entry.i === i);
        if (existing >= 0) {
          answers[existing] = { i, text };
        } else {
          answers.push({ i, text });
        }
      }
    }
    if (filled().size <= before) {
      break;
    }
  }
  return { questions, answers };
}

async function executeExtract(
  job: JobRecord,
  step: JobStepRecord,
): Promise<Record<string, unknown>> {
  const documentId = documentIdFrom(step);
  const document = documentId ? getDocument(documentId) : undefined;
  if (!document) {
    throw new Error("document_id missing or expired");
  }
  const questions = extractNumberedQuestions(document.extracted_text);
  if (questions.length > 0) {
    return { items: questions, questions };
  }
  const extracted = await jobComplete(
    job.job_id,
    `Extract up to 20 key items (questions, deadlines, requirements). JSON: {"items":["..."]}\n\n<document>\n${document.extracted_text.slice(0, 12_000)}\n</document>`,
  );
  const items = Array.isArray(extracted.items)
    ? extracted.items.filter(
        (item): item is string => typeof item === "string" && Boolean(item.trim()),
      )
    : [];
  return { items };
}

async function executeSummarise(
  job: JobRecord,
  step: JobStepRecord,
): Promise<Record<string, unknown>> {
  const priorNotes = collectPriorNotes(job.job_id);
  const documentId = documentIdFrom(step);
  const document = documentId ? getDocument(documentId) : undefined;
  const source =
    priorNotes || document?.extracted_text.slice(0, 12_000) || job.owner_text;
  const extracted = await jobComplete(
    job.job_id,
    `Summarise for Vishnu in under 200 words. JSON: {"summary":"..."}\n\n<source>\n${source}\n</source>`,
    700,
  );
  const summary =
    typeof extracted.summary === "string"
      ? extracted.summary.trim()
      : typeof extracted.text === "string"
        ? extracted.text.trim()
        : "";
  return { summary };
}

async function executeDraft(
  job: JobRecord,
  step: JobStepRecord,
): Promise<Record<string, unknown>> {
  const input = parseResultRef(step.input_ref);
  const to =
    (typeof input.to === "string" && input.to) ||
    job.owner_text.match(/\bto\s+([A-Z][a-z]+)\b/)?.[1] ||
    "recipient";
  const prior = collectPriorNotes(job.job_id);
  const extracted = await jobComplete(
    job.job_id,
    `Write a short email from Vishnu to ${to} based on the notes. JSON: {"subject":"","body":""}. Do not send.\n\n<notes>\n${prior || job.owner_text}\n</notes>`,
    800,
  );
  const subject =
    typeof extracted.subject === "string" && extracted.subject.trim()
      ? extracted.subject.trim()
      : `Update: ${job.title}`;
  const body =
    typeof extracted.body === "string" ? extracted.body.trim() : "";
  return {
    to,
    subject,
    body,
    draft_id: body ? `local-${job.job_id}-${step.step_id}` : "",
  };
}

function executeCreateTasks(
  job: JobRecord,
  step: JobStepRecord,
): Record<string, unknown> {
  const prior = parseResultRef(step.result_ref);
  const items = collectPriorItems(job.job_id);
  const taskIds = Array.isArray(prior.task_ids)
    ? [...(prior.task_ids as number[])]
    : [];
  for (const item of items.slice(0, 10)) {
    const task = createTask(item.slice(0, 200), "work", null);
    taskIds.push(task.id);
  }
  return { task_ids: taskIds };
}

function collectPriorNotes(jobId: number): string {
  const parts: string[] = [];
  for (const step of listJobSteps(jobId)) {
    if (step.done_check_passed !== 1) {
      continue;
    }
    const result = parseResultRef(step.result_ref);
    if (typeof result.summary === "string") {
      parts.push(result.summary);
    }
    if (Array.isArray(result.notes)) {
      parts.push(
        result.notes.filter((item) => typeof item === "string").join("\n"),
      );
    }
  }
  return parts.join("\n").slice(0, 12_000);
}

function collectPriorItems(jobId: number): string[] {
  const items: string[] = [];
  for (const step of listJobSteps(jobId)) {
    if (step.done_check_passed !== 1) {
      continue;
    }
    const result = parseResultRef(step.result_ref);
    if (Array.isArray(result.items)) {
      for (const item of result.items) {
        if (typeof item === "string" && item.trim()) {
          items.push(item.trim());
        }
      }
    }
  }
  return items;
}

async function defaultExecute(
  job: JobRecord,
  step: JobStepRecord,
): Promise<Record<string, unknown>> {
  switch (step.type) {
    case "read_chunk":
      return executeReadChunk(job, step);
    case "answer_questions":
      return executeAnswerQuestions(job, step);
    case "extract":
      return executeExtract(job, step);
    case "summarise":
      return executeSummarise(job, step);
    case "draft":
      return executeDraft(job, step);
    case "create_tasks":
      return executeCreateTasks(job, step);
    default:
      throw new Error(`unsupported step type ${step.type}`);
  }
}

function skipDependents(jobId: number, failedId: string): void {
  const steps = listJobSteps(jobId);
  const planned = steps.map((step) => ({
    id: step.step_id,
    depends_on: parseDependsOn(step.depends_on),
  }));
  const skip = dependentsToSkip(failedId, planned);
  for (const step of steps) {
    if (!skip.has(step.step_id) || step.status !== "pending") {
      continue;
    }
    updateJobStep(jobId, step.step_id, {
      status: "skipped",
      error: `skipped; depends on ${failedId}`,
    });
  }
}

function jobFinishedStatus(steps: JobStepRecord[]): "done" | "failed" {
  const anyDone = steps.some(
    (step) => step.status === "done" && step.done_check_passed === 1,
  );
  return anyDone ? "done" : "failed";
}

async function notify(job: JobRecord, text: string, edit: boolean): Promise<void> {
  const api = notifyApi;
  const chatId = job.telegram_chat_id ?? Number(config.ownerTelegramId);
  if (!api || !chatId) {
    return;
  }
  try {
    if (edit && job.telegram_message_id) {
      await api.editMessageText(chatId, job.telegram_message_id, text);
      return;
    }
    const sent = await api.sendMessage(chatId, text);
    updateJob(job.job_id, { telegramMessageId: sent.message_id, telegramChatId: chatId });
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`job notify failed (${errorType}).`);
  }
}

function nextEligibleStep(steps: JobStepRecord[]): JobStepRecord | undefined {
  const done = new Set(
    steps
      .filter((step) => step.status === "done" && step.done_check_passed === 1)
      .map((step) => step.step_id),
  );
  return steps.find((step) => {
    if (step.status !== "pending") {
      return false;
    }
    const deps = parseDependsOn(step.depends_on);
    return deps.every((dep) => done.has(dep));
  });
}

export async function processNextJobStep(): Promise<string | undefined> {
  recoverStuckJobSteps(JOB_STUCK_MS);
  const jobs = listActiveJobs();
  for (const job of jobs) {
    if (job.status === "paused") {
      continue;
    }
    if (job.status === "cancelled") {
      continue;
    }
    const steps = listJobSteps(job.job_id);
    if (steps.some((step) => step.status === "running")) {
      continue;
    }
    if (job.cost_usd >= job.budget_usd) {
      updateJob(job.job_id, { status: "paused" });
      await notify(
        job,
        `${job.title} hit the $${job.budget_usd.toFixed(2)} cap (spent $${job.cost_usd.toFixed(2)}). Reply "continue the ${job.title} job" or "cancel the ${job.title} job".`,
        false,
      );
      logJob(job.job_id, "-", `paused cost=${job.cost_usd.toFixed(4)}`);
      continue;
    }
    const step = nextEligibleStep(steps);
    if (!step) {
      for (const leftover of steps) {
        if (leftover.status === "pending" || leftover.status === "running") {
          updateJobStep(job.job_id, leftover.step_id, {
            status: "skipped",
            error: "blocked",
          });
        }
      }
      const finalSteps = listJobSteps(job.job_id);
      const finished = jobFinishedStatus(finalSteps);
      updateJob(job.job_id, { status: finished });
      await notify(
        job,
        formatFinalMessage(getJob(job.job_id)!, finalSteps),
        false,
      );
      logJob(job.job_id, "-", `finished status=${finished}`);
      return finished;
    }
    const attempts = step.attempts + 1;
    updateJobStep(job.job_id, step.step_id, {
      status: "running",
      attempts,
      startedAt: new Date().toISOString(),
    });
    logJob(job.job_id, step.step_id, `attempt=${attempts} type=${step.type}`);
    await notify(
      getJob(job.job_id)!,
      formatProgressMessage(job, listJobSteps(job.job_id), step.step_id),
      true,
    );
    try {
      const executor = executeOverride ?? defaultExecute;
      const result = await executor(getJob(job.job_id)!, getJobStepOrThrow(job.job_id, step.step_id));
      const expectedChunks =
        step.type === "read_chunk"
          ? Number(result.expected ?? 0)
          : undefined;
      const check = evaluateDoneCheck(
        parseDoneCondition(step.done_condition),
        result,
        expectedChunks,
      );
      const incompleteRead =
        step.type === "read_chunk" &&
        Number(result.processed ?? 0) < Number(result.expected ?? 0);
      if (incompleteRead) {
        updateJobStep(job.job_id, step.step_id, {
          status: "pending",
          resultRef: result,
          attempts: step.attempts,
          startedAt: null,
        });
        logJob(
          job.job_id,
          step.step_id,
          `yield processed=${result.processed} expected=${result.expected}`,
        );
        return "yield";
      }
      if (check.passed) {
        updateJobStep(job.job_id, step.step_id, {
          status: "done",
          resultRef: result,
          doneCheckPassed: true,
          error: null,
          startedAt: null,
        });
        logJob(job.job_id, step.step_id, "done_check=passed");
        return "done";
      }
      if (attempts >= JOB_MAX_ATTEMPTS) {
        updateJobStep(job.job_id, step.step_id, {
          status: "failed",
          resultRef: result,
          doneCheckPassed: false,
          error: check.gap,
          startedAt: null,
        });
        skipDependents(job.job_id, step.step_id);
        logJob(job.job_id, step.step_id, `failed gap_len=${check.gap.length}`);
        return "failed";
      }
      updateJobStep(job.job_id, step.step_id, {
        status: "pending",
        resultRef: result,
        error: check.gap,
        startedAt: null,
      });
      logJob(job.job_id, step.step_id, `retry gap_len=${check.gap.length}`);
      return "retry";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempts >= JOB_MAX_ATTEMPTS) {
        updateJobStep(job.job_id, step.step_id, {
          status: "failed",
          doneCheckPassed: false,
          error: message.slice(0, 180),
          startedAt: null,
        });
        skipDependents(job.job_id, step.step_id);
        logJob(job.job_id, step.step_id, "failed error");
        return "failed";
      }
      updateJobStep(job.job_id, step.step_id, {
        status: "pending",
        error: message.slice(0, 180),
        startedAt: null,
      });
      logJob(job.job_id, step.step_id, "retry error");
      return "retry";
    }
  }
  return undefined;
}

function getJobStepOrThrow(jobId: number, stepId: string): JobStepRecord {
  const step = listJobSteps(jobId).find((row) => row.step_id === stepId);
  if (!step) {
    throw new Error(`missing step ${stepId}`);
  }
  return step;
}

export function persistPlannedJob(
  ownerText: string,
  plan: PlannedJob,
  options: {
    chatId?: number;
    messageId?: number;
    budgetUsd?: number;
  } = {},
): JobRecord {
  const job = createJob({
    title: plan.title,
    ownerText,
    budgetUsd: options.budgetUsd ?? DEFAULT_JOB_BUDGET_USD,
    telegramChatId: options.chatId,
    telegramMessageId: options.messageId,
  });
  for (const [index, step] of plan.steps.entries()) {
    insertJobStep({
      jobId: job.job_id,
      stepId: step.id,
      order: index + 1,
      type: step.type,
      dependsOn: step.depends_on,
      inputRef: step.input_ref,
      doneCondition: step.done_condition,
    });
  }
  logJob(job.job_id, "-", `created steps=${plan.steps.length}`);
  return job;
}

export async function tryStartBigJob(input: {
  ownerText: string;
  chatId: number;
  api: Api;
  chunkCount?: number;
}): Promise<string | undefined> {
  const upload = getRecentUpload();
  const document = upload ? getDocument(upload.documentId) : undefined;
  const chunks =
    input.chunkCount ??
    (document ? documentChunkCount(document.extracted_text) : 0);
  if (!looksLikeBigJob(input.ownerText, chunks)) {
    return undefined;
  }
  const plan = await planJobFromOwnerMessage(input.ownerText, {
    documentId: document?.id,
    fileName: document?.file_name ?? upload?.fileName,
    chars: document?.extracted_text.length,
    chunks,
  });
  const job = persistPlannedJob(input.ownerText, plan, { chatId: input.chatId });
  const text = formatPlanMessage(plan);
  try {
    const sent = await input.api.sendMessage(input.chatId, text);
    updateJob(job.job_id, {
      telegramMessageId: sent.message_id,
      telegramChatId: input.chatId,
    });
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`job plan send failed (${errorType}).`);
  }
  await processNextJobStep();
  return text;
}

export function handleJobChatCommand(text: string): string | undefined {
  const command = parseJobCommand(text);
  if (!command) {
    return undefined;
  }
  const jobs = listJobs(30);
  const job = matchJob(jobs, command);
  if (!job) {
    return command.action === "cancel"
      ? "Which job should I cancel? Use /jobs."
      : "Which job should I continue? Use /jobs.";
  }
  if (command.action === "cancel") {
    updateJob(job.job_id, { status: "cancelled" });
    for (const step of listJobSteps(job.job_id)) {
      if (step.status === "pending" || step.status === "running") {
        updateJobStep(job.job_id, step.step_id, {
          status: "skipped",
          error: "cancelled",
        });
      }
    }
    logJob(job.job_id, "-", "cancelled");
    return `Cancelled ${job.title}.`;
  }
  if (job.status !== "paused" && job.status !== "running") {
    return `${job.title} is ${job.status}.`;
  }
  updateJob(job.job_id, {
    status: "running",
    budgetUsd: job.budget_usd + DEFAULT_JOB_BUDGET_USD,
  });
  logJob(job.job_id, "-", "continued");
  return `Continuing ${job.title}. Raised the cap by $${DEFAULT_JOB_BUDGET_USD.toFixed(2)}.`;
}

export function jobsListText(): string {
  return formatJobsList(listJobs(20));
}

export function registerJobWorker(api: Api): IntervalJob {
  notifyApi = api;
  recoverStuckJobSteps(JOB_STUCK_MS);
  return everyMs(
    "job-queue",
    60_000,
    async () => {
      await processNextJobStep();
    },
    { runImmediately: true, jobTimeoutMs: 10 * 60 * 1000 },
  );
}
