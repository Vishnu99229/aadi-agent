export interface BusyInterval {
  start: Date;
  end: Date;
}

export interface TimeSlot {
  start: Date;
  end: Date;
}

export interface SlotWindow {
  start: Date;
  end: Date;
}

export interface SlotFinderOptions {
  now: Date;
  busy: BusyInterval[];
  durationMinutes: number;
  hours: { startMinutes: number; endMinutes: number };
  breakMinutes: { startMinutes: number; endMinutes: number };
  bufferMinutes: number;
  minNoticeHours: number;
  horizonDays: number;
  slotsToOffer: number;
  timezone: string;
  window?: SlotWindow;
  offset?: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

export function istDateTime(date: string, hhmm: string): Date {
  return new Date(`${date}T${hhmm}:00+05:30`);
}

export function formatIstDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function istParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(date);
  const read = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const weekdayName = read("weekday").toLowerCase().slice(0, 3);
  return {
    year: Number(read("year")),
    month: Number(read("month")),
    day: Number(read("day")),
    hour: Number(read("hour")),
    minute: Number(read("minute")),
    weekday: WEEKDAY_INDEX[weekdayName] ?? 0,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function istDateString(parts: { year: number; month: number; day: number }): string {
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function addIstDays(date: string, days: number): string {
  const utc = new Date(`${date}T00:00:00+05:30`);
  utc.setUTCDate(utc.getUTCDate() + days);
  return formatIstDate(utc);
}

function minutesOfDay(parts: { hour: number; minute: number }): number {
  return parts.hour * 60 + parts.minute;
}

function overlaps(left: BusyInterval, right: BusyInterval): boolean {
  return left.start.getTime() < right.end.getTime() && right.start.getTime() < left.end.getTime();
}

function expandBusy(busy: BusyInterval[], bufferMinutes: number): BusyInterval[] {
  const bufferMs = bufferMinutes * 60 * 1000;
  return busy.map((item) => ({
    start: new Date(item.start.getTime() - bufferMs),
    end: new Date(item.end.getTime() + bufferMs),
  }));
}

function startOfIstDay(date: string): Date {
  return istDateTime(date, "00:00");
}

function endOfIstDay(date: string): Date {
  return istDateTime(date, "23:59");
}

export function parseWindowHint(
  hint: string | null | undefined,
  now: Date,
  timezone = "Asia/Kolkata",
): SlotWindow | undefined {
  void timezone;
  if (!hint) {
    return undefined;
  }
  const trimmed = hint.trim().toLowerCase();
  const today = formatIstDate(now);
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "today") {
    return { start: now, end: endOfIstDay(today) };
  }
  if (trimmed === "tomorrow") {
    const tomorrow = addIstDays(today, 1);
    return { start: startOfIstDay(tomorrow), end: endOfIstDay(tomorrow) };
  }
  if (trimmed === "this week") {
    const parts = istParts(now);
    const daysUntilSunday = (7 - parts.weekday) % 7;
    const thisSunday = addIstDays(today, daysUntilSunday);
    return { start: now, end: endOfIstDay(thisSunday) };
  }
  if (trimmed === "next week") {
    const parts = istParts(now);
    const daysUntilNextMonday = (8 - parts.weekday) % 7 || 7;
    const monday = addIstDays(today, daysUntilNextMonday);
    const sunday = addIstDays(monday, 6);
    return { start: startOfIstDay(monday), end: endOfIstDay(sunday) };
  }
  const iso = trimmed.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (iso) {
    return { start: startOfIstDay(iso[1]!), end: endOfIstDay(iso[1]!) };
  }
  const nextDay = trimmed.match(/^next\s+(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/);
  if (nextDay) {
    const weekday = WEEKDAY_INDEX[nextDay[1]!] ?? 1;
    const parts = istParts(now);
    let delta = (weekday - parts.weekday + 7) % 7;
    if (delta === 0) {
      delta = 7;
    }
    const date = addIstDays(today, delta);
    return { start: startOfIstDay(date), end: endOfIstDay(date) };
  }
  return undefined;
}

function candidateDays(window: SlotWindow): string[] {
  const days: string[] = [];
  let cursor = formatIstDate(window.start);
  const last = formatIstDate(window.end);
  while (cursor <= last) {
    days.push(cursor);
    cursor = addIstDays(cursor, 1);
  }
  return days;
}

function slotOnDay(
  date: string,
  startMinutes: number,
  durationMinutes: number,
): TimeSlot {
  const startH = Math.floor(startMinutes / 60);
  const startM = startMinutes % 60;
  const endMinutes = startMinutes + durationMinutes;
  const endH = Math.floor(endMinutes / 60);
  const endM = endMinutes % 60;
  return {
    start: istDateTime(date, `${pad(startH)}:${pad(startM)}`),
    end: istDateTime(date, `${pad(endH)}:${pad(endM)}`),
  };
}

function isWeekday(date: string): boolean {
  const weekday = istParts(startOfIstDay(date)).weekday;
  return weekday >= 1 && weekday <= 5;
}

function blockedByBreak(
  startMinutes: number,
  durationMinutes: number,
  breakMinutes: { startMinutes: number; endMinutes: number },
): boolean {
  const slot = { start: startMinutes, end: startMinutes + durationMinutes };
  return slot.start < breakMinutes.endMinutes && breakMinutes.startMinutes < slot.end;
}

function spreadAcrossDays(slots: TimeSlot[], timezone: string): TimeSlot[] {
  const groups = new Map<string, TimeSlot[]>();
  for (const slot of slots) {
    const key = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(slot.start);
    const list = groups.get(key) ?? [];
    list.push(slot);
    groups.set(key, list);
  }
  const days = [...groups.keys()].sort();
  const ordered: TimeSlot[] = [];
  let index = 0;
  let remaining = slots.length;
  while (remaining > 0) {
    let added = false;
    for (const day of days) {
      const slot = groups.get(day)?.[index];
      if (slot) {
        ordered.push(slot);
        remaining -= 1;
        added = true;
      }
    }
    if (!added) {
      break;
    }
    index += 1;
  }
  return ordered;
}

export function findSlots(options: SlotFinderOptions): TimeSlot[] {
  const noticeMs = options.minNoticeHours * 60 * 60 * 1000;
  const earliest = new Date(options.now.getTime() + noticeMs);
  const defaultEnd = new Date(
    options.now.getTime() + options.horizonDays * 24 * 60 * 60 * 1000,
  );
  const window: SlotWindow = {
    start: options.window?.start ?? earliest,
    end: options.window?.end ?? defaultEnd,
  };
  if (window.start < earliest) {
    window.start = earliest;
  }
  const busy = expandBusy(options.busy, options.bufferMinutes);
  const duration = options.durationMinutes;
  const collected: TimeSlot[] = [];

  for (const date of candidateDays(window)) {
    if (!isWeekday(date)) {
      continue;
    }
    const alignedStart = Math.ceil(options.hours.startMinutes / 30) * 30;
    for (
      let startMinutes = alignedStart;
      startMinutes + duration <= options.hours.endMinutes;
      startMinutes += 30
    ) {
      if (blockedByBreak(startMinutes, duration, options.breakMinutes)) {
        continue;
      }
      const slot = slotOnDay(date, startMinutes, duration);
      if (slot.start < window.start || slot.end > window.end) {
        continue;
      }
      if (slot.start < earliest) {
        continue;
      }
      if (minutesOfDay(istParts(slot.start)) % 30 !== 0) {
        continue;
      }
      const blocked = busy.some((item) => overlaps(item, slot));
      if (!blocked) {
        collected.push(slot);
      }
    }
  }

  const spread = spreadAcrossDays(collected, options.timezone);
  const offset = options.offset ?? 0;
  return spread.slice(offset, offset + options.slotsToOffer);
}

export function formatSlotIst(slot: TimeSlot, otherTimeZone?: string | null): string {
  const ist = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const start = ist.format(slot.start);
  const end = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(slot.end);
  if (!otherTimeZone) {
    return `${start}–${end} IST`;
  }
  try {
    const other = new Intl.DateTimeFormat("en-GB", {
      timeZone: otherTimeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    }).formatRange(slot.start, slot.end);
    return `${start}–${end} IST (${other})`;
  } catch {
    return `${start}–${end} IST`;
  }
}

export function formatConfirmDayDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    day: "2-digit",
    month: "short",
  }).formatToParts(date);
  const read = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${read("weekday")}, ${read("day")} ${read("month")}`;
}

export function formatConfirmClock(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export function formatOtherZoneRange(
  slot: TimeSlot,
  timeZone: string | null | undefined,
): string | null {
  if (!timeZone) {
    return null;
  }
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    }).formatRange(slot.start, slot.end);
  } catch {
    return null;
  }
}
