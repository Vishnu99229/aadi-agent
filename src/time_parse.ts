import { formatIstDate, istDateTime } from "./meeting_slots.js";

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const CLOCK = "(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?";
const WEEKDAY_NAMES = Object.keys(WEEKDAYS).join("|");

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function weekdayIndex(now: Date): number {
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
  })
    .format(now)
    .toLowerCase();
  return WEEKDAYS[label] ?? 0;
}

function addDaysYmd(ymd: string, days: number): string {
  const start = istDateTime(ymd, "12:00");
  return formatIstDate(new Date(start.getTime() + days * 24 * 60 * 60 * 1000));
}

function hourFromClock(hour: number, minute: number, meridian?: string): { hour: number; minute: number } {
  let resolved = hour;
  const marker = meridian?.toLowerCase();
  if (marker === "pm" && hour < 12) {
    resolved += 12;
  } else if (marker === "am" && hour === 12) {
    resolved = 0;
  } else if (!marker && hour < 8) {
    // Bare "2" or "3:50" in a work context is afternoon.
    resolved += 12;
  }
  return { hour: resolved, minute };
}

function isoFor(ymd: string, hour: number, minute: number): string {
  return `${ymd}T${pad(hour)}:${pad(minute)}:00+05:30`;
}

function isoFromClock(
  now: Date,
  dayWord: string | undefined,
  hourToken: string,
  minuteToken: string | undefined,
  meridian: string | undefined,
): string {
  const { hour, minute } = hourFromClock(
    Number(hourToken),
    minuteToken ? Number(minuteToken) : 0,
    meridian,
  );
  let ymd = formatIstDate(now);
  if (dayWord?.toLowerCase() === "tomorrow") {
    ymd = addDaysYmd(ymd, 1);
  }
  return isoFor(ymd, hour, minute);
}

/**
 * Turns a short time phrase in Vishnu's own words into an Asia/Kolkata ISO
 * timestamp. Returns undefined unless the whole message is a time fill.
 */
export function parseOwnerTime(text: string, now = new Date()): string | undefined {
  const clean = text.trim().replace(/[.!?]+$/, "");
  if (!clean) {
    return undefined;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(clean) && Number.isFinite(Date.parse(clean))) {
    return clean;
  }
  const dayFirst = new RegExp(`^(today|tomorrow)\\s+(?:at\\s+)?${CLOCK}$`, "i").exec(clean);
  if (dayFirst) {
    return isoFromClock(now, dayFirst[1], dayFirst[2]!, dayFirst[3], dayFirst[4]);
  }
  const weekday = new RegExp(`^(${WEEKDAY_NAMES})\\s+(?:at\\s+)?${CLOCK}$`, "i").exec(clean);
  if (weekday) {
    const today = formatIstDate(now);
    const current = weekdayIndex(now);
    const target = WEEKDAYS[weekday[1]!.toLowerCase()]!;
    let delta = (target - current + 7) % 7;
    if (delta === 0) {
      delta = 7;
    }
    const { hour, minute } = hourFromClock(
      Number(weekday[2]),
      weekday[3] ? Number(weekday[3]) : 0,
      weekday[4],
    );
    return isoFor(addDaysYmd(today, delta), hour, minute);
  }
  const timeThenDay = new RegExp(`^(?:at\\s+)?${CLOCK}(?:\\s+(today|tomorrow))?$`, "i").exec(clean);
  if (!timeThenDay) {
    return undefined;
  }
  return isoFromClock(now, timeThenDay[4], timeThenDay[1]!, timeThenDay[2], timeThenDay[3]);
}

export function looksLikeTimeFill(text: string): boolean {
  return parseOwnerTime(text) !== undefined;
}
