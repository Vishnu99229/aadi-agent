/** Deterministic scheduling CSP solver.
 *
 *  Given a list of per-participant busy intervals, a working window, a
 *  duration, and the usual boolean constraints (avoidLunch, weekdaysOnly),
 *  returns the earliest slot that satisfies them all - or null.
 *
 *  Implemented as a backtracking enumeration over 15-minute candidates
 *  pruned by participant-wise busy intervals. Wrapped by findOptimalSlot
 *  which enforces a 3-second wall-clock cap via Promise.race so a bad
 *  input can never freeze the event loop on the phone. */

const TIME_ZONE = "Asia/Kolkata";
const STEP_MINUTES = 15;
const MINUTE_MS = 60_000;
const LUNCH_START_MIN = 13 * 60;    // 13:00 IST
const LUNCH_END_MIN = 14 * 60;      // 14:00 IST

export interface BusyInterval {
  startIso: string;
  endIso: string;
}

export interface SchedulingConstraints {
  /** Minimum clock-time per day, "HH:MM" in Asia/Kolkata. */
  minTime: string;
  /** Exclusive maximum clock-time per day, "HH:MM" in Asia/Kolkata. */
  maxTime: string;
  /** Reject slots overlapping 13:00-14:00 IST. */
  avoidLunch: boolean;
  /** If set, reject Saturday / Sunday slots. */
  weekdaysOnly?: boolean;
}

export interface SchedulingProblem {
  /** The earliest instant a slot may start, inclusive. */
  rangeStartIso: string;
  /** The latest instant a slot may END, exclusive. */
  rangeEndIso: string;
  /** Per-participant busy intervals, pre-fetched from each calendar. */
  busyByParticipant: BusyInterval[][];
  /** Required slot length, minutes. */
  durationMinutes: number;
  constraints: SchedulingConstraints;
}

export interface OptimalSlot {
  startIso: string;
  endIso: string;
}

function parseHhMm(value: string): number {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`Bad HH:MM value: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Convert an instant to its (minute-of-day, weekday) in Asia/Kolkata. */
function kolkataFields(instantMs: number): {
  minuteOfDay: number;
  weekday: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(new Date(instantMs));
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    get("weekday"),
  );
  return { minuteOfDay: hour * 60 + minute, weekday };
}

function overlapsBusy(
  startMs: number,
  endMs: number,
  busy: BusyInterval[],
): boolean {
  for (const slot of busy) {
    const s = Date.parse(slot.startIso);
    const e = Date.parse(slot.endIso);
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    if (startMs < e && endMs > s) return true;
  }
  return false;
}

/** Walk candidate slots on a 15-minute grid; the first that clears all
 *  constraints wins. Caller must wrap in a timeout. */
export function solveSync(problem: SchedulingProblem): OptimalSlot | null {
  const start = Date.parse(problem.rangeStartIso);
  const end = Date.parse(problem.rangeEndIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  const duration = problem.durationMinutes;
  if (duration <= 0) return null;
  const durationMs = duration * MINUTE_MS;
  const minMin = parseHhMm(problem.constraints.minTime);
  const maxMin = parseHhMm(problem.constraints.maxTime);
  const alignedStart = Math.ceil(start / (STEP_MINUTES * MINUTE_MS)) *
    (STEP_MINUTES * MINUTE_MS);

  for (let cursor = alignedStart; cursor + durationMs <= end; cursor +=
    STEP_MINUTES * MINUTE_MS) {
    const { minuteOfDay, weekday } = kolkataFields(cursor);
    if (problem.constraints.weekdaysOnly && (weekday === 0 || weekday === 6)) {
      continue;
    }
    if (minuteOfDay < minMin) continue;
    const slotEndMinute = minuteOfDay + duration;
    if (slotEndMinute > maxMin) continue;
    if (
      problem.constraints.avoidLunch &&
      slotEndMinute > LUNCH_START_MIN &&
      minuteOfDay < LUNCH_END_MIN
    ) {
      continue;
    }
    const slotEnd = cursor + durationMs;
    let clear = true;
    for (const busy of problem.busyByParticipant) {
      if (overlapsBusy(cursor, slotEnd, busy)) {
        clear = false;
        break;
      }
    }
    if (!clear) continue;
    return {
      startIso: new Date(cursor).toISOString(),
      endIso: new Date(slotEnd).toISOString(),
    };
  }
  return null;
}

export class SchedulingTimeoutError extends Error {
  constructor() {
    super("Could not find an optimal slot in time. Please suggest a manual time.");
    this.name = "SchedulingTimeoutError";
  }
}

/** 3-second wall clock cap. Returns null when no slot fits, throws
 *  SchedulingTimeoutError when the solver didn't finish in time. */
export async function findOptimalSlot(
  problem: SchedulingProblem,
  timeoutMs = 3_000,
): Promise<OptimalSlot | null> {
  // solveSync is synchronous; wrap in a microtask so a timeout can race.
  const work = new Promise<OptimalSlot | null>((resolve) =>
    setImmediate(() => resolve(solveSync(problem))),
  );
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new SchedulingTimeoutError()), timeoutMs),
  );
  return Promise.race([work, timeout]);
}
