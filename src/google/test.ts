import { google, type calendar_v3 } from "googleapis";
import { loadGoogleAccounts } from "./auth.js";

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

async function main(): Promise<void> {
  const accounts = await loadGoogleAccounts();
  if (accounts.length === 0) {
    throw new Error(
      "No Google accounts connected. Run npm run google:auth first.",
    );
  }

  for (const account of accounts) {
    const gmail = google.gmail({ version: "v1", auth: account.client });
    const calendar = google.calendar({ version: "v3", auth: account.client });
    const [profile, unreadLabel, eventCount] = await Promise.all([
      gmail.users.getProfile({ userId: "me" }),
      gmail.users.labels.get({ userId: "me", id: "UNREAD" }),
      countEventsToday(calendar),
    ]);

    console.log(`Account: ${account.label}`);
    console.log(`Address: ${profile.data.emailAddress ?? "unknown"}`);
    console.log(`Unread emails: ${unreadLabel.data.messagesTotal ?? 0}`);
    console.log(`Calendar events today: ${eventCount}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
