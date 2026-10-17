import { existsSync, readFileSync, statSync } from "node:fs";
import { getJobRun, listJobRuns, recordJobRun } from "./db.js";
import {
  HEARTBEAT_FILE,
  heartbeatPath,
  writeHeartbeat,
} from "./heartbeat.js";

export const GOOGLE_API_TIMEOUT_MS = 30_000;
const JOB_TIMEOUT_MS = 5 * 60 * 1000;
const CATCH_UP_MS = 60 * 60 * 1000;
const TIME_ZONE = "Asia/Kolkata";
const clockInFlight = new Set<string>();

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

export function clockSlotUtc(
  hour: number,
  minute: number,
  now = new Date(),
): Date {
  const parts = istParts(now);
  const pad = (value: number) => String(value).padStart(2, "0");
  return new Date(
    `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(hour)}:${pad(minute)}:00+05:30`,
  );
}

export function shouldCatchUpClockJob(
  hour: number,
  minute: number,
  now = new Date(),
  weekdays?: number[],
): boolean {
  const parts = istParts(now);
  if (weekdays && !weekdays.includes(parts.weekday)) {
    return false;
  }
  const slot = clockSlotUtc(hour, minute, now);
  const elapsed = now.getTime() - slot.getTime();
  return elapsed > 0 && elapsed <= CATCH_UP_MS;
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
      recordJobRun(name, "error");
      const errorType = error instanceof Error ? error.name : "UnknownError";
      console.error(`Job ${name} failed (${errorType}).`);
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
    recordJobRun(name, "error");
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Job ${name} failed (${errorType}).`);
  } finally {
    clockInFlight.delete(name);
  }
}

export function maybeCatchUpClockJob(
  name: string,
  hour: number,
  minute: number,
  fn: () => Promise<void>,
  weekdays?: number[],
): void {
  if (!shouldCatchUpClockJob(hour, minute, new Date(), weekdays)) {
    return;
  }
  const slot = clockSlotUtc(hour, minute);
  const last = getJobRun(name);
  if (
    last?.last_success_at &&
    new Date(last.last_success_at).getTime() >= slot.getTime()
  ) {
    return;
  }
  void runTrackedJob(name, async () => {
    await fn();
    console.log(`Job ${name}: status=ok catch_up=1`);
  });
}

export function wrapClockJob(
  name: string,
  hour: number,
  minute: number,
  fn: () => Promise<void>,
  weekdays?: number[],
): () => Promise<void> {
  maybeCatchUpClockJob(name, hour, minute, fn, weekdays);
  return () => runTrackedJob(name, fn);
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
    const row = runs.get(name);
    lines.push(
      `${name}: last ran ${agoLabel(row?.last_success_at ?? null, now)}`,
    );
  }
  return lines.join("\n");
}
