import { chunkText, TEXT_CHUNK_CHARS } from "./document_review_logic.js";
import type { JobRecord, JobStepRecord } from "./db.js";

export const JOB_STEP_TYPES = [
  "read_chunk",
  "answer_questions",
  "extract",
  "draft",
  "summarise",
  "create_tasks",
] as const;

export type JobStepType = (typeof JOB_STEP_TYPES)[number];

const FORBIDDEN_TYPES = new Set([
  "send",
  "book",
  "create_meeting",
  "confirm_send",
  "confirm_send_pending_draft",
  "delete_calendar_event",
  "add_calendar_attendee",
  "invite",
]);

export const DEFAULT_JOB_BUDGET_USD = 0.5;
export const JOB_STUCK_MS = 10 * 60 * 1000;
export const JOB_MAX_ATTEMPTS = 3;
export const JOB_MAX_STEPS = 12;
export const JOB_CHUNK_TRIGGER = 10;

export type DoneCheck =
  | { kind: "chunks_processed" }
  | { kind: "answers_eq_questions" }
  | { kind: "draft_ready" }
  | { kind: "text_exists"; field: string }
  | { kind: "count_gte"; field: string; min?: number }
  | { kind: "tasks_created" };

export interface PlannedStep {
  id: string;
  type: JobStepType;
  input_ref: Record<string, unknown>;
  depends_on: string[];
  done_condition: DoneCheck;
}

export interface PlannedJob {
  title: string;
  steps: PlannedStep[];
}

const ACTION_RES: RegExp[] = [
  /\b(review|analyse|analyze)\b/i,
  /\b(answer|respond to)\b.{0,60}\bquestions?\b/i,
  /\b(draft|write)\b.{0,40}\b(email|summary|reply|note)\b/i,
  /\b(extract|pull out)\b/i,
  /\b(summarise|summarize)\b/i,
  /\bcreate\b.{0,20}\btasks?\b/i,
];

export function looksLikeBigJob(
  ownerText: string,
  chunkCount?: number,
): boolean {
  const text = ownerText.trim();
  if (text.length < 24) {
    return false;
  }
  const hits = ACTION_RES.filter((re) => re.test(text)).length;
  if (hits >= 2) {
    return true;
  }
  if (
    hits >= 1 &&
    /\bevery question\b|\ball (?:the )?questions\b|\bmulti-?step\b|\bchecklist\b/i.test(
      text,
    )
  ) {
    return true;
  }
  if (hits >= 1 && (chunkCount ?? 0) > JOB_CHUNK_TRIGGER) {
    return true;
  }
  return false;
}

export function isJobStepType(value: string): value is JobStepType {
  return (JOB_STEP_TYPES as readonly string[]).includes(value);
}

const TYPE_ALIASES: Record<string, JobStepType> = {
  read: "read_chunk",
  read_chunks: "read_chunk",
  read_document: "read_chunk",
  read_chunk: "read_chunk",
  answer: "answer_questions",
  answers: "answer_questions",
  answer_question: "answer_questions",
  answer_questions: "answer_questions",
  extract: "extract",
  extract_questions: "extract",
  draft: "draft",
  draft_email: "draft",
  summarise: "summarise",
  summarize: "summarise",
  summary: "summarise",
  create_task: "create_tasks",
  create_tasks: "create_tasks",
  tasks: "create_tasks",
};

export function normalizeStepType(value: string): JobStepType | undefined {
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (FORBIDDEN_TYPES.has(key)) {
    return undefined;
  }
  return TYPE_ALIASES[key];
}

export function fallbackPlanFromOwnerMessage(
  ownerText: string,
  title = "Job",
): PlannedJob {
  const steps: PlannedStep[] = [];
  const add = (type: JobStepType, dependsOn: string[] = []): void => {
    const id = `s${steps.length + 1}`;
    steps.push({
      id,
      type,
      input_ref: {},
      depends_on: dependsOn,
      done_condition: doneCheckForType(type),
    });
  };
  const lastId = (): string[] => (steps.length ? [steps.at(-1)!.id] : []);
  if (/\b(review|read|analyse|analyze)\b/i.test(ownerText)) {
    add("read_chunk");
  }
  if (/\bquestions?\b/i.test(ownerText)) {
    add("answer_questions", lastId());
  }
  if (/\b(summarise|summarize|summary)\b/i.test(ownerText)) {
    add("summarise", lastId());
  }
  if (/\bdraft\b/i.test(ownerText)) {
    add("draft", lastId());
  }
  if (/\btasks?\b/i.test(ownerText) && /\bcreate\b/i.test(ownerText)) {
    add("create_tasks", lastId());
  }
  if (steps.length === 0) {
    add("summarise");
  }
  return { title, steps };
}

export function doneCheckForType(type: JobStepType): DoneCheck {
  switch (type) {
    case "read_chunk":
      return { kind: "chunks_processed" };
    case "answer_questions":
      return { kind: "answers_eq_questions" };
    case "extract":
      return { kind: "count_gte", field: "items", min: 1 };
    case "draft":
      return { kind: "draft_ready" };
    case "summarise":
      return { kind: "text_exists", field: "summary" };
    case "create_tasks":
      return { kind: "tasks_created" };
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function parseInputRef(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return {};
    }
    try {
      return asObject(JSON.parse(trimmed));
    } catch {
      return { raw: trimmed };
    }
  }
  return asObject(value);
}

export function parseDependsOn(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

export function parseResultRef(raw: string | null): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  try {
    return asObject(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function parseDoneCondition(raw: string): DoneCheck {
  try {
    const parsed = asObject(JSON.parse(raw));
    const kind = typeof parsed.kind === "string" ? parsed.kind : "";
    if (kind === "chunks_processed") {
      return { kind };
    }
    if (kind === "answers_eq_questions") {
      return { kind };
    }
    if (kind === "draft_ready") {
      return { kind };
    }
    if (kind === "text_exists" && typeof parsed.field === "string") {
      return { kind, field: parsed.field };
    }
    if (kind === "count_gte" && typeof parsed.field === "string") {
      return {
        kind,
        field: parsed.field,
        min: typeof parsed.min === "number" ? parsed.min : 1,
      };
    }
    if (kind === "tasks_created") {
      return { kind };
    }
  } catch {
    // fall through
  }
  return { kind: "text_exists", field: "summary" };
}

function stringField(
  result: Record<string, unknown>,
  field: string,
): string {
  const value = result[field];
  return typeof value === "string" ? value.trim() : "";
}

function arrayField(
  result: Record<string, unknown>,
  field: string,
): unknown[] {
  const value = result[field];
  return Array.isArray(value) ? value : [];
}

export function evaluateDoneCheck(
  check: DoneCheck,
  result: Record<string, unknown>,
  expectedChunks?: number,
): { passed: boolean; gap: string } {
  switch (check.kind) {
    case "chunks_processed": {
      const processed = Number(result.processed ?? 0);
      const expected = Number(result.expected ?? expectedChunks ?? 0);
      if (expected > 0 && processed >= expected) {
        return { passed: true, gap: "" };
      }
      return {
        passed: false,
        gap: `you processed ${processed} of ${expected} chunks, finish the remaining ${Math.max(0, expected - processed)}`,
      };
    }
    case "answers_eq_questions": {
      const questions = arrayField(result, "questions");
      const answers = arrayField(result, "answers");
      const answered = answers.filter(
        (row) =>
          row &&
          typeof row === "object" &&
          typeof (row as { text?: unknown }).text === "string" &&
          String((row as { text: string }).text).trim().length > 0,
      ).length;
      const expected = questions.length;
      if (expected > 0 && answered >= expected) {
        return { passed: true, gap: "" };
      }
      return {
        passed: false,
        gap: `you answered ${answered} of ${expected}, answer the remaining ${Math.max(0, expected - answered)}`,
      };
    }
    case "draft_ready": {
      const draftId = stringField(result, "draft_id");
      const body = stringField(result, "body");
      if (draftId || body) {
        return { passed: true, gap: "" };
      }
      return { passed: false, gap: "draft_id is missing and no draft body was stored" };
    }
    case "text_exists": {
      if (stringField(result, check.field)) {
        return { passed: true, gap: "" };
      }
      return { passed: false, gap: `${check.field} is empty` };
    }
    case "count_gte": {
      const count = arrayField(result, check.field).length;
      const min = check.min ?? 1;
      if (count >= min) {
        return { passed: true, gap: "" };
      }
      return {
        passed: false,
        gap: `${check.field} has ${count}, need at least ${min}`,
      };
    }
    case "tasks_created": {
      const ids = arrayField(result, "task_ids");
      if (ids.length > 0) {
        return { passed: true, gap: "" };
      }
      return { passed: false, gap: "no task_ids were created" };
    }
  }
}

export function documentChunkCount(text: string): number {
  return chunkText(text, TEXT_CHUNK_CHARS).length;
}

export function extractNumberedQuestions(text: string): string[] {
  const found = new Map<number, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*Q(?:uestion)?\s*(\d+)[.):]\s*(.+)$/i.exec(line.trim());
    if (!match) {
      continue;
    }
    const n = Number(match[1]);
    const question = match[2]!.trim();
    if (!Number.isFinite(n) || n <= 0 || !question) {
      continue;
    }
    if (!found.has(n)) {
      found.set(n, question);
    }
  }
  return [...found.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, question]) => question);
}

export function sanitizePlan(
  raw: unknown,
  fallbackTitle: string,
): PlannedJob {
  const obj = Array.isArray(raw) ? { title: fallbackTitle, steps: raw } : asObject(raw);
  const title =
    typeof obj.title === "string" && obj.title.trim()
      ? obj.title.trim().slice(0, 80)
      : fallbackTitle;
  const stepsIn = Array.isArray(obj.steps)
    ? obj.steps
    : Array.isArray(obj.checklist)
      ? obj.checklist
      : [];
  const steps: PlannedStep[] = [];
  const seen = new Set<string>();
  for (const item of stepsIn) {
    if (steps.length >= JOB_MAX_STEPS) {
      break;
    }
    const row = asObject(item);
    const typeRaw =
      typeof row.type === "string"
        ? row.type
        : typeof row.step_type === "string"
          ? row.step_type
          : "";
    const type = normalizeStepType(typeRaw);
    if (!type) {
      continue;
    }
    let id =
      typeof row.id === "string" && row.id.trim()
        ? row.id.trim().slice(0, 32)
        : `s${steps.length + 1}`;
    if (seen.has(id)) {
      id = `${id}_${steps.length + 1}`;
    }
    seen.add(id);
    const depends = Array.isArray(row.depends_on)
      ? row.depends_on.filter(
          (dep): dep is string => typeof dep === "string" && seen.has(dep),
        )
      : [];
    steps.push({
      id,
      type,
      input_ref: parseInputRef(row.input_ref ?? row.input),
      depends_on: depends,
      done_condition: doneCheckForType(type),
    });
  }
  return { title, steps };
}

export function formatPlanMessage(plan: PlannedJob): string {
  const lines = plan.steps.map(
    (step, index) => `${index + 1}. ${step.type} (${step.id})`,
  );
  return `${plan.steps.length} steps: ${plan.title}\n${lines.join("\n")}\nStarting now. Say stop to cancel.`;
}

function stepMark(step: JobStepRecord, currentId?: string): string {
  if (step.done_check_passed === 1 && step.status === "done") {
    return "✅";
  }
  if (step.status === "failed") {
    return "❌";
  }
  if (step.status === "skipped") {
    return "⏭";
  }
  if (step.status === "running" || step.step_id === currentId) {
    return "⏳";
  }
  return "⬜";
}

export function formatProgressMessage(
  job: JobRecord,
  steps: JobStepRecord[],
  currentId?: string,
): string {
  const done = steps.filter((step) => step.status === "done").length;
  const marks = steps.map((step) => stepMark(step, currentId)).join("");
  return `${job.title} — step ${Math.min(done + 1, steps.length)}/${steps.length} ${marks}`;
}

export function formatFinalMessage(
  job: JobRecord,
  steps: JobStepRecord[],
): string {
  const done: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  for (const step of steps) {
    const result = parseResultRef(step.result_ref);
    if (step.status === "done" && step.done_check_passed === 1) {
      done.push(describeDone(step, result));
      continue;
    }
    if (step.status === "skipped") {
      skipped.push(`${step.type} (${step.step_id})`);
      continue;
    }
    failed.push(
      `${step.type} (${step.step_id})${step.error ? `: ${step.error}` : ""}`,
    );
  }
  const lines = [`${job.title} finished.`, `Cost $${job.cost_usd.toFixed(2)}.`];
  lines.push(done.length ? `Done: ${done.join("; ")}.` : "Done: nothing passed its check.");
  if (failed.length > 0) {
    lines.push(`Failed: ${failed.join("; ")}.`);
  }
  if (skipped.length > 0) {
    lines.push(`Skipped: ${skipped.join("; ")}.`);
  }
  return lines.join("\n");
}

function describeDone(
  step: JobStepRecord,
  result: Record<string, unknown>,
): string {
  if (step.type === "answer_questions") {
    const n = arrayField(result, "answers").length;
    const q = arrayField(result, "questions").length;
    return `answers ${n}/${q}`;
  }
  if (step.type === "read_chunk") {
    return `chunks ${Number(result.processed ?? 0)}/${Number(result.expected ?? 0)}`;
  }
  if (step.type === "draft") {
    const id = stringField(result, "draft_id");
    return id ? `draft ${id}` : "draft stored locally";
  }
  if (step.type === "create_tasks") {
    return `tasks ${arrayField(result, "task_ids").length}`;
  }
  if (step.type === "summarise") {
    return "summary";
  }
  return `${step.type} (${step.step_id})`;
}

export function formatJobsList(jobs: JobRecord[]): string {
  if (jobs.length === 0) {
    return "No jobs yet.";
  }
  return jobs
    .map(
      (job) =>
        `#${job.job_id} ${job.title} — ${job.status} ($${job.cost_usd.toFixed(2)} / $${job.budget_usd.toFixed(2)})`,
    )
    .join("\n");
}

export function parseJobCommand(
  text: string,
):
  | { action: "cancel"; jobId?: number; titleQuery?: string }
  | { action: "continue"; jobId?: number; titleQuery?: string }
  | undefined {
  const trimmed = text.trim();
  const cancelId = /^cancel\s+job\s+#?(\d+)\s*$/i.exec(trimmed);
  if (cancelId) {
    return { action: "cancel", jobId: Number(cancelId[1]) };
  }
  const continueId = /^(?:continue|resume)\s+job\s+#?(\d+)\s*$/i.exec(trimmed);
  if (continueId) {
    return { action: "continue", jobId: Number(continueId[1]) };
  }
  const cancelTitle =
    /^cancel(?:\s+the)?\s+(.+?)\s+job\s*$/i.exec(trimmed) ??
    /^stop(?:\s+the)?\s+(.+?)\s+job\s*$/i.exec(trimmed);
  if (cancelTitle) {
    return { action: "cancel", titleQuery: cancelTitle[1]!.trim() };
  }
  if (/^(?:stop|cancel)(?:\s+that)?(?:\s+job)?\s*$/i.test(trimmed)) {
    return { action: "cancel" };
  }
  const continueTitle =
    /^(?:continue|resume)(?:\s+the)?\s+(.+?)\s+job\s*$/i.exec(trimmed);
  if (continueTitle) {
    return { action: "continue", titleQuery: continueTitle[1]!.trim() };
  }
  return undefined;
}

export function matchJob(
  jobs: JobRecord[],
  query: { jobId?: number; titleQuery?: string },
): JobRecord | undefined {
  if (query.jobId) {
    return jobs.find((job) => job.job_id === query.jobId);
  }
  if (query.titleQuery) {
    const needle = query.titleQuery.toLowerCase();
    return jobs.find((job) => job.title.toLowerCase().includes(needle));
  }
  const active = jobs.filter(
    (job) => job.status === "running" || job.status === "paused",
  );
  return active.length === 1 ? active[0] : undefined;
}

export function dependentsToSkip(
  failedId: string,
  steps: PlannedStep[] | Array<{ id?: string; step_id?: string; depends_on: string[] }>,
): Set<string> {
  const skip = new Set<string>();
  const idOf = (step: { id?: string; step_id?: string }) =>
    step.id ?? step.step_id ?? "";
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      const id = idOf(step);
      if (!id || skip.has(id) || id === failedId) {
        continue;
      }
      if (
        step.depends_on.includes(failedId) ||
        step.depends_on.some((dep) => skip.has(dep))
      ) {
        skip.add(id);
        changed = true;
      }
    }
  }
  return skip;
}
