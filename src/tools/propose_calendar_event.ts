import { google } from "googleapis";
import type { LlmTool } from "../llm.js";
import { queueEventApproval } from "../approvals.js";
import type { GoogleAccountId } from "../db.js";
import { getGoogleAccount } from "../google/auth.js";
import {
  findOptimalSlot,
  SchedulingTimeoutError,
  type BusyInterval,
  type SchedulingConstraints,
} from "../scheduling_csp.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "propose_calendar_event",
  description:
    "Propose a calendar event for Vishnu to approve. Does NOT create the event; it queues a Telegram approval card with Create Event / Cancel buttons. Only Vishnu's tap creates the event.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Short event title. Required.",
      },
      start_time: {
        type: "string",
        description:
          "Event start as ISO 8601 with offset, for example 2026-10-25T15:30:00+05:30. Required.",
      },
      end_time: {
        type: "string",
        description:
          "Event end as ISO 8601 with offset, for example 2026-10-25T16:00:00+05:30. Required.",
      },
      attendees: {
        type: "array",
        description:
          "Email addresses to invite. Omit or empty array for a solo block.",
        items: { type: "string" },
      },
      description: {
        type: "string",
        description:
          "Optional meeting notes or agenda shown on the calendar event.",
      },
      google_account: {
        type: "string",
        description:
          'Which calendar to book on. Defaults to "work" (the only account with calendar.events scope).',
        enum: ["personal", "work"],
      },
    },
    required: ["title", "start_time", "end_time"],
  },
};

function isValidIso(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

export async function handler(input: unknown): Promise<string> {
  const values = input as {
    title?: unknown;
    start_time?: unknown;
    end_time?: unknown;
    attendees?: unknown;
    description?: unknown;
    google_account?: unknown;
  };
  const title =
    typeof values.title === "string" ? values.title.trim() : "";
  if (!title) {
    throw new Error("title is required.");
  }
  const startIso =
    typeof values.start_time === "string" ? values.start_time.trim() : "";
  const endIso =
    typeof values.end_time === "string" ? values.end_time.trim() : "";
  if (!isValidIso(startIso) || !isValidIso(endIso)) {
    throw new Error(
      "start_time and end_time must be ISO 8601 datetimes with offset.",
    );
  }
  if (Date.parse(endIso) <= Date.parse(startIso)) {
    throw new Error("end_time must be after start_time.");
  }
  const attendees = Array.isArray(values.attendees)
    ? values.attendees
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.includes("@"))
    : [];
  const description =
    typeof values.description === "string" ? values.description.trim() : "";
  const googleAccount: GoogleAccountId =
    values.google_account === "personal" ? "personal" : "work";

  // CSP + freebusy pre-check: if the LLM-chosen slot clashes with any
  // attendee's calendar, run the backtracker over the following 7 days
  // to propose the nearest clear slot. All wrapped in a 3s timeout so a
  // slow Google call can never freeze the agent loop on the phone.
  const resolved = await resolveSlot({
    startIso,
    endIso,
    attendees,
    googleAccount,
  }).catch((error) => {
    if (error instanceof SchedulingTimeoutError) {
      return { ok: false as const, message: error.message };
    }
    throw error;
  });

  if (!resolved.ok) {
    return resolved.message;
  }

  const finalStartIso = resolved.startIso;
  const finalEndIso = resolved.endIso;
  const bumped =
    finalStartIso !== startIso || finalEndIso !== endIso;

  const actionId = await queueEventApproval({
    title,
    startIso: finalStartIso,
    endIso: finalEndIso,
    attendees,
    description: description || undefined,
    googleAccount,
  });
  const suffix = bumped
    ? ` CSP solver bumped the slot to ${finalStartIso} - ${finalEndIso} to clear a conflict.`
    : "";
  return `Event ${title} is waiting for Vishnu's Create Event tap (approval #${actionId}).${suffix}`;
}

async function freebusyFor(
  account: Awaited<ReturnType<typeof getGoogleAccount>>,
  attendees: string[],
  rangeStartIso: string,
  rangeEndIso: string,
): Promise<BusyInterval[][]> {
  if (attendees.length === 0) return [];
  const calendar = google.calendar({ version: "v3", auth: account.client });
  const response = await calendar.freebusy.query({
    requestBody: {
      timeMin: rangeStartIso,
      timeMax: rangeEndIso,
      items: attendees.map((email) => ({ id: email })),
    },
  });
  const calendars = response.data.calendars ?? {};
  return attendees.map((email) => {
    const slots = calendars[email]?.busy ?? [];
    return slots
      .filter(
        (slot): slot is { start: string; end: string } =>
          typeof slot.start === "string" && typeof slot.end === "string",
      )
      .map((slot) => ({ startIso: slot.start, endIso: slot.end }));
  });
}

async function resolveSlot(input: {
  startIso: string;
  endIso: string;
  attendees: string[];
  googleAccount: GoogleAccountId;
}): Promise<
  | { ok: true; startIso: string; endIso: string }
  | { ok: false; message: string }
> {
  if (input.attendees.length === 0) {
    return { ok: true, startIso: input.startIso, endIso: input.endIso };
  }
  const account = await getGoogleAccount(input.googleAccount);
  const rangeEnd = new Date(
    Date.parse(input.startIso) + 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const busy = await freebusyFor(
    account,
    input.attendees,
    input.startIso,
    rangeEnd,
  );
  const durationMinutes = Math.round(
    (Date.parse(input.endIso) - Date.parse(input.startIso)) / 60000,
  );
  const constraints: SchedulingConstraints = {
    minTime: "09:00",
    maxTime: "18:00",
    avoidLunch: true,
    weekdaysOnly: true,
  };
  // First check: is the LLM-chosen slot itself clear?
  const headCheck = await findOptimalSlot(
    {
      rangeStartIso: input.startIso,
      rangeEndIso: input.endIso,
      busyByParticipant: busy,
      durationMinutes,
      constraints,
    },
    3_000,
  );
  if (
    headCheck &&
    Date.parse(headCheck.startIso) === Date.parse(input.startIso)
  ) {
    return { ok: true, startIso: input.startIso, endIso: input.endIso };
  }
  // Clash: search the next 7 days for a clear slot.
  const alt = await findOptimalSlot(
    {
      rangeStartIso: input.startIso,
      rangeEndIso: rangeEnd,
      busyByParticipant: busy,
      durationMinutes,
      constraints,
    },
    3_000,
  );
  if (!alt) {
    return {
      ok: false,
      message:
        "Every slot in the next 7 days clashes with an attendee's calendar. Please suggest a manual time.",
    };
  }
  return { ok: true, startIso: alt.startIso, endIso: alt.endIso };
}
