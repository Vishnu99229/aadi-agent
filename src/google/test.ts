import { google, type calendar_v3 } from "googleapis";
import { loadGoogleAccounts, type LoadedGoogleAccount } from "./auth.js";

const TIME_ZONE = "Asia/Kolkata";
const INDIA_OFFSET = "+05:30";

function dateInTimeZone(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function googleStatus(error: unknown): number | undefined {
  const err = error as { code?: number | string; status?: number };
  const raw = err.status ?? err.code;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

async function countEventsToday(
  calendar: calendar_v3.Calendar,
): Promise<number> {
  const today = dateInTimeZone(new Date());
  const start = new Date(`${today}T00:00:00${INDIA_OFFSET}`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  let pageToken: string | undefined;
  let count = 0;

  do {
    const response = await calendar.events.list({
      calendarId: "primary",
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      maxResults: 2500,
      pageToken,
    });
    count += response.data.items?.length ?? 0;
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return count;
}

async function checkFreeBusy(
  calendar: calendar_v3.Calendar,
): Promise<number> {
  const start = new Date();
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const response = await calendar.freebusy.query({
    requestBody: {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      timeZone: TIME_ZONE,
      items: [{ id: "primary" }],
    },
  });
  return response.data.calendars?.primary?.busy?.length ?? 0;
}

async function checkWorkCalendarWrite(
  calendar: calendar_v3.Calendar,
): Promise<void> {
  const start = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 1000);
  let eventId: string | undefined;
  try {
    const created = await calendar.events.insert({
      calendarId: "primary",
      sendUpdates: "none",
      requestBody: {
        summary: "Aadi auth check",
        start: { dateTime: start.toISOString(), timeZone: TIME_ZONE },
        end: { dateTime: end.toISOString(), timeZone: TIME_ZONE },
      },
    });
    eventId = created.data.id ?? undefined;
    if (!eventId) {
      throw new Error("Work calendar insert returned no event id.");
    }
  } catch (error) {
    const status = googleStatus(error);
    if (status === 403) {
      throw new Error(
        "Work calendar write failed (403). Re-run npm run google:auth:work and grant calendar.events.",
      );
    }
    throw error;
  }

  try {
    await calendar.events.delete({
      calendarId: "primary",
      eventId,
      sendUpdates: "none",
    });
  } catch (error) {
    const status = googleStatus(error);
    if (status === 403) {
      throw new Error(
        "Work calendar delete failed (403). Re-run npm run google:auth:work and grant calendar.events.",
      );
    }
    throw error;
  }
}

async function testAccount(account: LoadedGoogleAccount): Promise<void> {
  const gmail = google.gmail({ version: "v1", auth: account.client });
  const calendar = google.calendar({ version: "v3", auth: account.client });
  const [profile, unreadLabel, eventCount, busyCount] = await Promise.all([
    gmail.users.getProfile({ userId: "me" }),
    gmail.users.labels.get({ userId: "me", id: "UNREAD" }),
    countEventsToday(calendar),
    checkFreeBusy(calendar),
  ]);

  console.log(`Account: ${account.label}`);
  console.log(`Address: ${profile.data.emailAddress ?? "unknown"}`);
  console.log(`Unread emails: ${unreadLabel.data.messagesTotal ?? 0}`);
  console.log(`Calendar events today: ${eventCount}`);
  console.log(`Freebusy windows (next 24h): ${busyCount}`);

  if (account.id === "work") {
    await checkWorkCalendarWrite(calendar);
    console.log("Work calendar write: insert+delete ok");
  }
}

async function main(): Promise<void> {
  const accounts = await loadGoogleAccounts();
  if (accounts.length === 0) {
    throw new Error(
      "No Google accounts connected. Run npm run google:auth first.",
    );
  }

  for (const account of accounts) {
    await testAccount(account);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
