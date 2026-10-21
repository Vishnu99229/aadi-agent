import { existsSync, readFileSync, statSync } from "node:fs";
import { config } from "./config.js";
import { getJobRun, isMorningBriefEnabled, listJobRuns, recordJobRun } from "./db.js";
import { msUntilDeepSeekOffPeak } from "./usage.js";
import {
  HEARTBEAT_FILE,
  heartbeatPath,
  writeHeartbeat,
} from "./heartbeat.js";

export const GOOGLE_API_TIMEOUT_MS = 30_000;
const JOB_TIMEOUT_MS = 5 * 60 * 1000;
export const CATCH_UP_MS = 4 * 60 * 60 * 1000;
export const WEEKLY_CATCH_UP_MS = 12 * 60 * 60 * 1000;
const TIME_ZONE = "Asia/Kolkata";
const clockInFlight = new Set<string>();
const dueChecks = new Set<() => void>();
let flushingClockJobs = false;

export function flushDueClockJobs(): void {
  if (flushingClockJobs) {
    return;
  }
  flushingClockJobs = true;
  try {
    for (const check of [...dueChecks]) {
      check();
    }
  } finally {
    flushingClockJobs = false;
  }
}

export const HEALTH_JOBS = [
  "meeting-inbox",
  "meeting-poll",
  "meeting-pending",
  "meeting-prebrief",
  "attachment-alerts",
  "build-poll",
  "morning-brief",
  "bill-scan",
  "followup-scan",
  "important-dates",
  "weekly-review",
  "weekly-backup",
] as const;

/**
 * Expected, recoverable job failure (e.g. an LLM returned unusable output).
 * Recorded as soft_error: logged as a warning, not counted as success, so
 * catch-up still retries the slot.
 */
export class SoftJobError extends Error {
  override name = "SoftJobError";
}

function recordJobFailure(name: string, error: unknown): void {
  if (error instanceof SoftJobError) {
    recordJobRun(name, "soft_error");
    console.warn(`Job ${name}: status=soft_error (${error.name}: ${error.message})`);
    return;
  }
  recordJobRun(name, "error");
  const errorType = error instanceof Error ? error.name : "UnknownError";
  console.error(`Job ${name} failed (${errorType}).`);
}

export type ClockJobKind = "daily" | "weekly";

export interface IntervalJob {
  name: string;
  stop: () => void;
  stats: {
    started: number;
    succeeded: number;
    overlaps: number;
    failures: number;
  };
}

export interface ClockJobOptions {
  weekdays?: number[];
  kind?: ClockJobKind;
  enabled?: () => boolean;
  jobTimeoutMs?: number;
  now?: () => Date;
  /** When DEEPSEEK_API_KEY is set, skip the tick during DeepSeek peak. */
  preferDeepSeekOffPeak?: boolean;
}

export async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  label = "timeout",
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(label));
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function istParts(now: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(now);
  const read = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const weekdayName = read("weekday").toLowerCase().slice(0, 3);
  const weekdays: Record<string, number> = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
  };
  return {
    year: Number(read("year")),
    month: Number(read("month")),
    day: Number(read("day")),
    hour: Number(read("hour")),
    minute: Number(read("minute")),
    weekday: weekdays[weekdayName] ?? 0,
  };
}

function istDayKey(parts: { year: number; month: number; day: number }): string {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function shiftIstDate(
  now: Date,
  days: number,
): { year: number; month: number; day: number; weekday: number } {
  const parts = istParts(now);
  const noon = new Date(
    `${istDayKey(parts)}T12:00:00+05:30`,
  );
  noon.setTime(noon.getTime() + days * 86_400_000);
  return istParts(noon);
}

export function clockSlotUtc(
  hour: number,
  minute: number,
  now = new Date(),
): Date {
  const parts = istParts(now);
  return new Date(
    `${istDayKey(parts)}T${pad2(hour)}:${pad2(minute)}:00+05:30`,
  );
}

export function nextClockSlotUtc(
  hour: number,
  minute: number,
  now = new Date(),
  weekdays?: number[],
): Date {
  const today = clockSlotUtc(hour, minute, now);
  const todayParts = istParts(now);
  const weekdayOk = !weekdays || weekdays.includes(todayParts.weekday);
  if (today.getTime() > now.getTime() && weekdayOk) {
    return today;
  }
  for (let days = 1; days <= 8; days += 1) {
    const shifted = shiftIstDate(now, days);
    if (weekdays && !weekdays.includes(shifted.weekday)) {
      continue;
    }
    return new Date(
      `${istDayKey(shifted)}T${pad2(hour)}:${pad2(minute)}:00+05:30`,
    );
  }
  throw new Error("no Asia/Kolkata clock slot in the next week");
}

export function lastWeeklySlotUtc(
  hour: number,
  minute: number,
  now: Date,
  weekdays: number[],
): Date | null {
  for (let days = 0; days <= 7; days += 1) {
    const shifted = days === 0 ? istParts(now) : shiftIstDate(now, -days);
    if (!weekdays.includes(shifted.weekday)) {
      continue;
    }
    const slot = new Date(
      `${istDayKey(shifted)}T${pad2(hour)}:${pad2(minute)}:00+05:30`,
    );
    if (slot.getTime() <= now.getTime()) {
      return slot;
    }
  }
  return null;
}

export function shouldCatchUpClockJob(
  hour: number,
  minute: number,
  now = new Date(),
  weekdays?: number[],
  kind: ClockJobKind = "daily",
): boolean {
  if (kind === "weekly") {
    if (!weekdays || weekdays.length === 0) {
      return false;
    }
    const slot = lastWeeklySlotUtc(hour, minute, now, weekdays);
    if (!slot) {
      return false;
    }
    const elapsed = now.getTime() - slot.getTime();
    return elapsed >= 0 && elapsed <= WEEKLY_CATCH_UP_MS;
  }
  const parts = istParts(now);
  if (weekdays && !weekdays.includes(parts.weekday)) {
    return false;
  }
  const slot = clockSlotUtc(hour, minute, now);
  const elapsed = now.getTime() - slot.getTime();
  if (elapsed <= 0) {
    return false;
  }
  return elapsed <= CATCH_UP_MS;
}

function succeededSince(name: string, slot: Date): boolean {
  const last = getJobRun(name);
  if (!last?.last_success_at) {
    return false;
  }
  return new Date(last.last_success_at).getTime() >= slot.getTime();
}

function alreadyRanCatchUpSlot(
  name: string,
  hour: number,
  minute: number,
  now: Date,
  weekdays: number[] | undefined,
  kind: ClockJobKind,
): boolean {
  if (kind === "weekly") {
    if (!weekdays) {
      return false;
    }
    const slot = lastWeeklySlotUtc(hour, minute, now, weekdays);
    return slot ? succeededSince(name, slot) : false;
  }
  return alreadySucceededThisSlot(name, hour, minute, now);
}

export function alreadySucceededThisSlot(
  name: string,
  hour: number,
  minute: number,
  now = new Date(),
): boolean {
  const slot = clockSlotUtc(hour, minute, now);
  const last = getJobRun(name);
  if (!last?.last_success_at) {
    return false;
  }
  return new Date(last.last_success_at).getTime() >= slot.getTime();
}

export function everyMs(
  name: string,
  intervalMs: number,
  fn: () => Promise<void>,
  options: { jobTimeoutMs?: number; runImmediately?: boolean } = {},
): IntervalJob {
  const stats = {
    started: 0,
    succeeded: 0,
    overlaps: 0,
    failures: 0,
  };
  let stopped = false;
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  const timeoutMs = options.jobTimeoutMs ?? JOB_TIMEOUT_MS;

  const arm = (delayMs: number) => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      void runTick();
    }, delayMs);
  };

  const runTick = async () => {
    if (stopped) {
      return;
    }
    arm(intervalMs);
    flushDueClockJobs();
    if (running) {
      stats.overlaps += 1;
      recordJobRun(name, "overlap");
      console.log(`Job ${name}: skip=overlap`);
      return;
    }
    running = true;
    stats.started += 1;
    const startedAt = Date.now();
    try {
      await withTimeout(fn(), timeoutMs, `job-timeout:${name}`);
      stats.succeeded += 1;
      recordJobRun(name, "ok");
      if (process.env.AADI_DB_PATH !== ":memory:") {
        writeHeartbeat();
      }
      console.log(
        `Job ${name}: status=ok lag_ms=${Date.now() - startedAt}`,
      );
    } catch (error) {
      stats.failures += 1;
      recordJobFailure(name, error);
    } finally {
      running = false;
    }
  };

  arm(options.runImmediately ? 0 : intervalMs);

  return {
    name,
    stats,
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    },
  };
}

export async function runTrackedJob(
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  if (clockInFlight.has(name)) {
    recordJobRun(name, "overlap");
    console.log(`Job ${name}: skip=overlap`);
    return;
  }
  clockInFlight.add(name);
  try {
    await fn();
    recordJobRun(name, "ok");
  } catch (error) {
    recordJobFailure(name, error);
  } finally {
    clockInFlight.delete(name);
  }
}

export function everyClock(
  name: string,
  hour: number,
  minute: number,
  fn: () => Promise<void>,
  options: ClockJobOptions = {},
): IntervalJob {
  const stats = {
    started: 0,
    succeeded: 0,
    overlaps: 0,
    failures: 0,
  };
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const timeoutMs = options.jobTimeoutMs ?? JOB_TIMEOUT_MS;
  const kind = options.kind ?? (options.weekdays ? "weekly" : "daily");
  const nowFn = options.now ?? (() => new Date());
  const enabled = options.enabled ?? (() => true);

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const armNext = () => {
    if (stopped) {
      return;
    }
    clearTimer();
    const now = nowFn();
    const next = nextClockSlotUtc(hour, minute, now, options.weekdays);
    const delayMs = Math.max(0, next.getTime() - now.getTime());
    timer = setTimeout(() => {
      void runTick("scheduled");
    }, delayMs);
  };

  const runTick = async (reason: "scheduled" | "catch_up") => {
    if (stopped) {
      return;
    }
    const now = nowFn();
    if (!enabled()) {
      console.log(`Job ${name}: skip=disabled`);
      armNext();
      return;
    }
    if (options.preferDeepSeekOffPeak && config.deepseekApiKey) {
      const deferMs = msUntilDeepSeekOffPeak(now);
      if (deferMs > 0 && deferMs <= CATCH_UP_MS) {
        recordJobRun(name, "deferred");
        console.log(`Job ${name}: skip=peak`);
        armNext();
        return;
      }
    }
    if (alreadyRanCatchUpSlot(name, hour, minute, now, options.weekdays, kind)) {
      console.log(`Job ${name}: skip=already`);
      armNext();
      return;
    }
    stats.started += 1;
    const startedAt = Date.now();
    await runTrackedJob(name, () =>
      withTimeout(fn(), timeoutMs, `job-timeout:${name}`),
    );
    const lastStatus = getJobRun(name)?.last_status;
    if (lastStatus === "ok") {
      stats.succeeded += 1;
      if (process.env.AADI_DB_PATH !== ":memory:") {
        writeHeartbeat();
      }
      const lag = Date.now() - startedAt;
      const catchUp = reason === "catch_up" ? " catch_up=1" : "";
      console.log(`Job ${name}: status=ok lag_ms=${lag}${catchUp}`);
    } else if (lastStatus === "overlap") {
      stats.overlaps += 1;
    } else if (lastStatus === "deferred") {
      // Peak skip is not a failure; catch-up can retry once off-peak.
    } else {
      stats.failures += 1;
    }
    armNext();
  };

  const catchUpIfDue = (): boolean => {
    if (stopped || clockInFlight.has(name)) {
      return false;
    }
    const now = nowFn();
    if (
      !enabled() ||
      !shouldCatchUpClockJob(hour, minute, now, options.weekdays, kind) ||
      alreadyRanCatchUpSlot(name, hour, minute, now, options.weekdays, kind)
    ) {
      return false;
    }
    void runTick("catch_up");
    return true;
  };
  dueChecks.add(catchUpIfDue);
  if (!catchUpIfDue()) {
    armNext();
  }

  return {
    name,
    stats,
    stop() {
      stopped = true;
      dueChecks.delete(catchUpIfDue);
      clearTimer();
    },
  };
}

function agoLabel(iso: string | null, now: Date): string {
  if (!iso) {
    return "never";
  }
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) {
    return "never";
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

export function lastRanLabel(iso: string | null, now: Date): string {
  if (!iso) {
    return "last ran never";
  }
  const ran = new Date(iso);
  if (Number.isNaN(ran.getTime())) {
    return "last ran never";
  }
  const ranParts = istParts(ran);
  const nowParts = istParts(now);
  const hhmm = `${pad2(ranParts.hour)}:${pad2(ranParts.minute)}`;
  if (istDayKey(ranParts) === istDayKey(nowParts)) {
    return `last ran ${hhmm} today`;
  }
  const yesterday = shiftIstDate(now, -1);
  if (istDayKey(ranParts) === istDayKey(yesterday)) {
    return `last ran ${hhmm} yesterday`;
  }
  return `last ran ${hhmm} ${pad2(ranParts.day)}/${pad2(ranParts.month)}`;
}

export function formatHealthReport(now = new Date()): string {
  const runs = new Map(listJobRuns().map((row) => [row.name, row]));
  const lines = ["Aadi health"];
  const beatPath = heartbeatPath();
  if (existsSync(beatPath)) {
    let iso = "";
    try {
      iso = readFileSync(beatPath, "utf8").trim();
    } catch {
      iso = "";
    }
    if (!iso || Number.isNaN(Date.parse(iso))) {
      iso = statSync(beatPath).mtime.toISOString();
    }
    lines.push(`heartbeat: ${agoLabel(iso, now)}`);
  } else {
    lines.push(`heartbeat: never (${HEARTBEAT_FILE} missing)`);
  }
  for (const name of HEALTH_JOBS) {
    if (name === "morning-brief" && !isMorningBriefEnabled()) {
      lines.push(`${name}: off`);
      continue;
    }
    const row = runs.get(name);
    lines.push(`${name}: ${lastRanLabel(row?.last_success_at ?? null, now)}`);
  }
  return lines.join("\n");
}
