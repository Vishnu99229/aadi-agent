import { InlineKeyboard, type Api, type Context } from "grammy";
import { everyMs, type IntervalJob } from "./scheduler.js";
import { google } from "googleapis";
import { config } from "./config.js";
import {
  clearMeetingRebrief,
  deleteSetting,
  getFollowups,
  getMeetingBrief,
  getMeetingBriefByEvent,
  getSetting,
  getTasks,
  listMeetingBriefs,
  recordMeetingBrief,
  rescheduleMeetingBrief,
  searchNotes,
  setSetting,
  updateMeetingNudge,
  type MeetingBriefRecord,
} from "./db.js";
import { decodedAccounts } from "./accounts.js";
import {
  isGoogleNotFound,
  loadGoogleAccounts,
  type LoadedGoogleAccount,
} from "./google/auth.js";
import { gmailClient } from "./google/mail.js";
import {
  buildMeetingBriefText,
  eventsDueForBrief,
  meetingKey,
  nextBriefInstant,
  nextQualifyingEvent,
  nudgeQuestion,
  planNudgeRefresh,
  selectLinkedOpenItems,
  textLinkedToMeeting,
  toMeetingAttendees,
  type CalendarEventLike,
  type EmailThreadLine,
  type MeetingAttendee,
  type OpenItemLine,
} from "./meeting_logic.js";
import { memoriesMatchingText } from "./memory.js";

const TIME_ZONE = "Asia/Kolkata";
const PENDING_WRAPUP_KEY = "pending_meeting_wrapup";
const SELF_FALLBACK = "vishnu.rajan@epicode.in";
const BRIEF_LOOKAHEAD_MS = 36 * 60 * 60 * 1000;

let briefTimer: NodeJS.Timeout | undefined;
let scanInFlight = false;

export interface PendingMeetingWrapUp {
  briefId: number;
  title: string;
  attendeeLine: string;
}

function header(
  headers: Array<{ name?: string | null; value?: string | null }> | undefined,
  name: string,
): string {
  return (
    headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())
      ?.value ?? ""
  );
}

function nudgeKeyboard(briefId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("Wrap up", `meet:wrap:${briefId}`)
    .text("Remind me in 1h", `meet:remind:${briefId}`)
    .text("Skip", `meet:skip:${briefId}`);
}

function parseAttendeesJson(raw: string): MeetingAttendee[] {
  try {
    const parsed = JSON.parse(raw) as MeetingAttendee[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function setPendingMeetingWrapUp(value: PendingMeetingWrapUp): void {
  setSetting(PENDING_WRAPUP_KEY, JSON.stringify(value));
}

export function consumePendingMeetingWrapUp(): PendingMeetingWrapUp | undefined {
  const raw = getSetting(PENDING_WRAPUP_KEY);
  if (!raw) {
    return undefined;
  }
  deleteSetting(PENDING_WRAPUP_KEY);
  try {
    const parsed = JSON.parse(raw) as PendingMeetingWrapUp;
    if (!parsed.briefId || !parsed.title) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function formatWrapUpPrefill(
  pending: PendingMeetingWrapUp,
  userText: string,
): string {
  return `Meeting: ${pending.title}\nAttendees: ${pending.attendeeLine}\n\n${userText}`;
}

async function loadWorkAccount(): Promise<LoadedGoogleAccount | undefined> {
  const accounts = await loadGoogleAccounts();
  return accounts.find((account) => account.id === "work");
}

async function selfEmail(account: LoadedGoogleAccount): Promise<string> {
  try {
    const profile = await gmailClient(account).users.getProfile({
      userId: "me",
    });
    return profile.data.emailAddress?.toLowerCase() || SELF_FALLBACK;
  } catch {
    return SELF_FALLBACK;
  }
}

async function listWorkEvents(
  account: LoadedGoogleAccount,
  timeMin: Date,
  timeMax: Date,
): Promise<CalendarEventLike[]> {
  const calendar = google.calendar({ version: "v3", auth: account.client });
  const events: CalendarEventLike[] = [];
  let pageToken: string | undefined;
  do {
    const response = await calendar.events.list({
      calendarId: "primary",
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      timeZone: TIME_ZONE,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 50,
      pageToken,
    });
    events.push(...(response.data.items ?? []));
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);
  return events;
}

async function searchWorkThreads(
  account: LoadedGoogleAccount,
  attendees: MeetingAttendee[],
): Promise<EmailThreadLine[]> {
  const addresses = attendees
    .map((item) => item.email)
    .filter((email) => email.includes("@"));
  if (addresses.length === 0) {
    return [];
  }
  const query = addresses
    .map((email) => `from:${email} OR to:${email}`)
    .join(" OR ");
  const gmail = gmailClient(account);
  const listed = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: 8,
  });
  const accounts = linkAccounts();
  const threads = new Map<string, EmailThreadLine>();
  for (const message of listed.data.messages ?? []) {
    if (!message.id) {
      continue;
    }
    const response = await gmail.users.messages.get({
      userId: "me",
      id: message.id,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });
    const threadId = response.data.threadId ?? message.id;
    if (threads.has(threadId)) {
      continue;
    }
    const headers = response.data.payload?.headers;
    threads.set(threadId, {
      from: header(headers, "From"),
      subject: header(headers, "Subject"),
      date: header(headers, "Date"),
    });
    if (threads.size >= 8) {
      break;
    }
  }
  const linked = [...threads.values()].filter((thread) => {
    if (textLinkedToMeeting(`${thread.from} ${thread.subject}`, attendees, accounts)) {
      return true;
    }
    const from = thread.from.toLowerCase();
    return from.includes("@epicode.in") || from.includes(SELF_FALLBACK);
  }).slice(0, 3);
  console.log(
    `Pre-meeting mail search: attendees=${addresses.length}, threads=${linked.length}`,
  );
  return linked;
}

function linkAccounts() {
  return decodedAccounts().map((account) => ({
    name: account.name,
    aliases: account.aliases,
    email_domains: account.email_domains,
  }));
}

function openItemsFor(attendees: MeetingAttendee[]): OpenItemLine[] {
  return selectLinkedOpenItems({
    attendees,
    accounts: linkAccounts(),
    followups: getFollowups(),
    tasks: getTasks(),
    notes: searchNotes("").map((note) => ({
      title: note.title,
      people: note.people,
      content: note.content,
    })),
  });
}

export async function buildBriefForEvent(
  event: CalendarEventLike,
  account: LoadedGoogleAccount,
  self: string,
): Promise<{ text: string; attendees: MeetingAttendee[] } | undefined> {
  const startIso = event.start?.dateTime;
  if (!event.id || !startIso) {
    return undefined;
  }
  const attendees = toMeetingAttendees(event, self);
  const threads = await searchWorkThreads(account, attendees);
  const openItems = openItemsFor(attendees);
  const memoryHay = [
    event.summary ?? "",
    ...attendees.map((item) => `${item.name} ${item.company}`),
  ].join(" ");
  const memories = memoriesMatchingText(memoryHay).map((item) => item.content);
  return {
    attendees,
    text: buildMeetingBriefText({
      title: event.summary ?? "(Untitled event)",
      startIso,
      attendees,
      threads,
      openItems,
      memories,
    }),
  };
}

async function sendBrief(
  api: Api,
  event: CalendarEventLike,
  account: LoadedGoogleAccount,
  self: string,
): Promise<MeetingBriefRecord | undefined> {
  const startIso = event.start?.dateTime;
  const endIso = event.end?.dateTime;
  if (!event.id || !startIso || !endIso) {
    return undefined;
  }
  const startKey = new Date(startIso).toISOString();
  const endKey = new Date(endIso).toISOString();
  const existing = getMeetingBriefByEvent(event.id, startKey);
  if (existing && !existing.needs_rebrief) {
    return existing;
  }
  const built = await buildBriefForEvent(event, account, self);
  if (!built) {
    return undefined;
  }
  await api.sendMessage(config.ownerTelegramId, built.text);
  const title = event.summary?.trim() || "(Untitled event)";
  const attendeesJson = JSON.stringify(built.attendees);
  const idealAt =
    new Date(startKey).getTime() - config.preMeetingMinutes * 60 * 1000;
  const timing = Date.now() - idealAt > 60_000 ? "short_notice" : "on_time";
  if (existing) {
    clearMeetingRebrief(existing.id, endKey, title, attendeesJson);
    console.log(
      `Pre-meeting brief sent: event=${event.id} timing=${timing} rebrief=1`,
    );
    return getMeetingBrief(existing.id);
  }
  const record = recordMeetingBrief({
    eventId: event.id,
    startAt: startKey,
    endAt: endKey,
    title,
    attendeesJson,
    nudgeAt: endKey,
  });
  console.log(
    `Pre-meeting brief sent: event=${event.id} timing=${timing} rebrief=0`,
  );
  return record;
}

export async function sendNextMeetingBrief(api: Api): Promise<string> {
  const account = await loadWorkAccount();
  if (!account) {
    return "Work calendar is not connected.";
  }
  const now = new Date();
  const horizon = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const self = await selfEmail(account);
  const events = await listWorkEvents(account, now, horizon);
  const next = nextQualifyingEvent(
    events,
    now,
    self,
    config.skipInternalRecurring,
  );
  if (!next) {
    return "No upcoming work meetings.";
  }
  const built = await buildBriefForEvent(next, account, self);
  if (!built || !next.id || !next.start?.dateTime || !next.end?.dateTime) {
    return "No upcoming work meetings.";
  }
  if (!getMeetingBriefByEvent(next.id, next.start.dateTime)) {
    recordMeetingBrief({
      eventId: next.id,
      startAt: next.start.dateTime,
      endAt: next.end.dateTime,
      title: next.summary?.trim() || "(Untitled event)",
      attendeesJson: JSON.stringify(built.attendees),
      nudgeAt: next.end.dateTime,
    });
  }
  return built.text;
}

async function sendNudge(api: Api, brief: MeetingBriefRecord): Promise<void> {
  const attendees = parseAttendeesJson(brief.attendees_json);
  await api.sendMessage(
    config.ownerTelegramId,
    nudgeQuestion(brief.title, attendees),
    { reply_markup: nudgeKeyboard(brief.id) },
  );
  console.log(`Post-call nudge sent: brief=${brief.id}`);
}

async function fetchWorkEvent(
  account: LoadedGoogleAccount,
  eventId: string,
): Promise<CalendarEventLike | null> {
  const calendar = google.calendar({ version: "v3", auth: account.client });
  try {
    const response = await calendar.events.get({
      calendarId: "primary",
      eventId,
      timeZone: TIME_ZONE,
    });
    return response.data;
  } catch (error) {
    if (isGoogleNotFound(error)) {
      return null;
    }
    throw error;
  }
}

function armBriefTimer(api: Api, atMs: number | null, now: Date): void {
  if (briefTimer) {
    clearTimeout(briefTimer);
    briefTimer = undefined;
  }
  if (atMs === null) {
    return;
  }
  const delay = atMs - now.getTime();
  if (delay <= 0 || delay > BRIEF_LOOKAHEAD_MS) {
    return;
  }
  briefTimer = setTimeout(() => {
    briefTimer = undefined;
    void runMeetingScan(api);
  }, delay);
}

async function refreshNudges(
  api: Api,
  account: LoadedGoogleAccount,
  now: Date,
): Promise<void> {
  const active = listMeetingBriefs().filter(
    (row) =>
      row.nudge_status === "briefed" || row.nudge_status === "remind_scheduled",
  );
  for (const brief of active) {
    let event: CalendarEventLike | null;
    try {
      event = await fetchWorkEvent(account, brief.event_id);
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      console.error(`Post-call nudge refresh failed (${errorType}).`);
      continue;
    }
    const plan = planNudgeRefresh(brief, event, now);
    if (plan.action === "skip") {
      updateMeetingNudge(brief.id, "skipped");
      console.log(
        `Post-call nudge skipped: brief=${brief.id} reason=${plan.reason}`,
      );
      continue;
    }
    if (plan.action === "reschedule") {
      const updated = rescheduleMeetingBrief(
        brief.id,
        plan.startAt,
        plan.endAt,
        plan.nudgeAt,
        plan.needsRebrief,
      );
      console.log(
        `Post-call nudge rescheduled: brief=${brief.id} status=${updated ? "rescheduled" : "skipped"}`,
      );
      continue;
    }
    if (plan.action !== "send") {
      continue;
    }
    try {
      const current = getMeetingBrief(brief.id);
      if (!current) {
        continue;
      }
      if (new Date(current.end_at).getTime() > now.getTime()) {
        console.log(
          `Post-call nudge skipped: brief=${brief.id} reason=before_end`,
        );
        continue;
      }
      await sendNudge(api, current);
      updateMeetingNudge(
        brief.id,
        brief.nudge_status === "remind_scheduled" ? "re_nudged" : "nudged",
      );
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      console.error(`Post-call nudge failed (${errorType}).`);
    }
  }
}

export async function runMeetingScan(api: Api, now = new Date()): Promise<void> {
  if (scanInFlight) {
    console.log("Job meeting-prebrief: skip=overlap");
    return;
  }
  scanInFlight = true;
  try {
    const account = await loadWorkAccount();
    if (!account) {
      console.log("Pre-meeting scan skipped: work calendar not connected.");
      return;
    }
    const self = await selfEmail(account);
    await refreshNudges(api, account, now);
    const horizon = new Date(now.getTime() + BRIEF_LOOKAHEAD_MS);
    const events = await listWorkEvents(account, now, horizon);
    const rows = listMeetingBriefs();
    const alreadySent = new Set(
      rows
        .filter((row) => !row.needs_rebrief)
        .map((row) => meetingKey(row.event_id, row.start_at)),
    );
    for (const event of eventsDueForBrief(
      events,
      now,
      config.preMeetingMinutes,
      self,
      config.skipInternalRecurring,
      alreadySent,
    )) {
      if (!event.id) {
        continue;
      }
      try {
        const fresh = await fetchWorkEvent(account, event.id);
        if (!fresh || fresh.status === "cancelled" || !fresh.start?.dateTime) {
          console.log(
            `Pre-meeting brief skipped: event=${event.id} reason=${fresh?.status === "cancelled" ? "cancelled" : "missing"}`,
          );
          continue;
        }
        const due = eventsDueForBrief(
          [fresh],
          now,
          config.preMeetingMinutes,
          self,
          config.skipInternalRecurring,
          alreadySent,
        );
        if (due.length === 0) {
          const freshKey = meetingKey(fresh.id ?? event.id, fresh.start.dateTime);
          const moved =
            freshKey !== meetingKey(event.id, event.start?.dateTime ?? "");
          if (moved) {
            console.log(
              `Pre-meeting brief skipped: event=${event.id} reason=moved`,
            );
          }
          continue;
        }
        const sent = await sendBrief(api, fresh, account, self);
        if (sent) {
          alreadySent.add(meetingKey(sent.event_id, sent.start_at));
        }
      } catch (error) {
        const errorType = error instanceof Error ? error.name : "UnknownError";
        console.error(`Pre-meeting brief failed (${errorType}).`);
      }
    }
    armBriefTimer(
      api,
      nextBriefInstant(
        events,
        now,
        config.preMeetingMinutes,
        self,
        config.skipInternalRecurring,
        alreadySent,
      ),
      now,
    );
  } finally {
    scanInFlight = false;
  }
}

export async function handleMeetingCallback(
  ctx: Context,
  operation: "wrap" | "remind" | "skip",
  briefId: number,
): Promise<void> {
  await ctx.answerCallbackQuery();
  const brief = getMeetingBrief(briefId);
  if (!brief) {
    await ctx.reply("That meeting nudge is no longer available.");
    return;
  }
  if (
    brief.nudge_status === "skipped" ||
    brief.nudge_status === "wrapped" ||
    brief.nudge_status === "wrapping"
  ) {
    await ctx.reply("That meeting nudge is already handled.");
    return;
  }

  if (operation === "skip") {
    updateMeetingNudge(brief.id, "skipped");
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    return;
  }

  if (operation === "remind") {
    if (brief.nudge_status === "remind_scheduled" || brief.nudge_status === "re_nudged") {
      await ctx.reply("I'll only remind once.");
      return;
    }
    const when = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    updateMeetingNudge(brief.id, "remind_scheduled", when);
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    await ctx.reply("I'll ask again in 1 hour.");
    return;
  }

  const attendees = parseAttendeesJson(brief.attendees_json);
  const attendeeLine = attendees
    .map((item) => item.name)
    .filter(Boolean)
    .join(", ");
  updateMeetingNudge(brief.id, "wrapping");
  setPendingMeetingWrapUp({
    briefId: brief.id,
    title: brief.title,
    attendeeLine: attendeeLine || brief.title,
  });
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  await ctx.reply(
    `Send a voice note or text and I'll save wrap-up notes for ${brief.title}.`,
  );
}

export function markMeetingWrapped(briefId: number): void {
  updateMeetingNudge(briefId, "wrapped");
}

export function registerMeetingScan(api: Api): IntervalJob {
  const task = everyMs(
    "meeting-prebrief",
    5 * 60 * 1000,
    () => runMeetingScan(api),
    { runImmediately: true },
  );
  console.log(
    `Pre-meeting scan every 5 minutes (${config.preMeetingMinutes} min window, ${TIME_ZONE}).`,
  );
  return task;
}
