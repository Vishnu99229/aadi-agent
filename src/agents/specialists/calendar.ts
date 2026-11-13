import { config } from "../../config.js";
import { formatIst, istDate } from "../helpers.js";
import type { CapabilityContext, SpecialistDefinition } from "../specialist.js";
import { InputRequiredSignal } from "../types.js";

interface ListedEvent {
  tag: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  attendees: string;
}

/** Reads the text list_events returns back into events. */
export function parseListedEvents(raw: string): ListedEvent[] {
  const events: ListedEvent[] = [];
  for (const block of raw.split(/\n\n+/)) {
    const head = /^\d+\.\s+\[(\w+)\]\s+(.*)$/m.exec(block);
    const start = /^Start:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? "";
    const end = /^End:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? "";
    if (!head || !start) {
      continue;
    }
    const allDay = /^\d{4}-\d{2}-\d{2}$/.test(start);
    const startAt = new Date(allDay ? `${start}T00:00:00+05:30` : start);
    const endAt = new Date(/^\d{4}-\d{2}-\d{2}$/.test(end) ? `${end}T00:00:00+05:30` : end || start);
    if (Number.isNaN(startAt.getTime())) {
      continue;
    }
    events.push({
      tag: head[1]!,
      title: head[2]!.trim(),
      start: startAt,
      end: Number.isNaN(endAt.getTime()) ? startAt : endAt,
      allDay,
      attendees: /^Attendees:\s*(.*)$/m.exec(block)?.[1]?.trim() ?? "",
    });
  }
  return events;
}

async function eventsBetween(ctx: CapabilityContext, from: Date, to: Date): Promise<ListedEvent[]> {
  const raw = await ctx.runTool("list_events", { start_date: istDate(from), end_date: istDate(to) });
  return parseListedEvents(raw);
}

/**
 * The Calendar Agent: reading both calendars, availability, and creating,
 * moving and deleting events and meetings.
 */
export const calendarAgent: SpecialistDefinition = {
  id: "calendar",
  name: "Calendar Agent",
  description:
    "Reads the work and personal calendars, checks availability and conflicts, and creates, moves and deletes events and meetings.",
  version: "1.0.0",
  promptFile: "calendar.md",
  tools: [
    { name: "list_events", effect: "read", retry: "safe" },
    { name: "propose_calendar_event", effect: "draft", retry: "never" },
    { name: "create_event", effect: "external", retry: "never" },
    { name: "create_meeting", effect: "external", retry: "never" },
    { name: "book_meeting", effect: "external", retry: "never" },
    { name: "move_event", effect: "external", retry: "never" },
    { name: "delete_calendar_event", effect: "external", retry: "never" },
    { name: "add_calendar_attendee", effect: "external", retry: "never" },
  ],
  sharedTools: ["get_current_time", "react_to_message"],
  routing: {
    patterns: [
      /\b(?:calendar|schedule|meetings?|events?|invites?|availability|available|free\s+(?:at|on|today|tomorrow|this|next)|reschedul\w*|standup)\b/i,
    ],
    commandKinds: ["calendar"],
  },
  capabilities: [
    {
      name: "next_meeting",
      description: "The next meeting on either calendar, from now.",
      kind: "workflow",
      effect: "read",
      retry: "safe",
      usesLlm: false,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      examples: ["What's my next meeting?", "When is my next call?"],
      triggers: [/^(?:what(?:'s|’s| is)|when(?:'s|’s| is)|show(?:\s+me)?)\s+my\s+next\s+(?:meeting|call)[.?!]*$/i],
      handler: async (_input, ctx) => {
        const now = new Date();
        const events = await eventsBetween(ctx, now, new Date(now.getTime() + 7 * 86_400_000));
        const next = events.find((event) => !event.allDay && event.end.getTime() > now.getTime());
        if (!next) {
          return { text: "No meetings in the next 7 days.", output: { found: false } };
        }
        const running = next.start.getTime() <= now.getTime();
        const who = next.attendees ? `\nWith: ${next.attendees}` : "";
        return {
          text: `${running ? "Now" : "Next"}: ${next.title} (${next.tag})\n${formatIst(next.start)} to ${formatIst(next.end)}${who}`,
          output: {
            found: true,
            title: next.title,
            tag: next.tag,
            start: next.start.toISOString(),
            end: next.end.toISOString(),
          },
        };
      },
    },
    {
      name: "check_conflicts",
      description: "Whether a time slot is free on both calendars, and what is in the way if it isn't.",
      kind: "workflow",
      effect: "read",
      retry: "safe",
      usesLlm: false,
      inputSchema: {
        type: "object",
        properties: {
          start_time: { type: "string", description: "ISO 8601 with offset." },
          duration_minutes: { type: "integer", description: "Defaults to 30." },
        },
        required: ["start_time"],
        additionalProperties: false,
      },
      handler: async (input, ctx) => {
        const start = new Date(String(input.start_time));
        if (Number.isNaN(start.getTime())) {
          throw new Error("start_time must be an ISO 8601 date and time.");
        }
        const minutes = typeof input.duration_minutes === "number" ? input.duration_minutes : 30;
        const end = new Date(start.getTime() + minutes * 60_000);
        const clashes = (await eventsBetween(ctx, start, end)).filter(
          (event) => !event.allDay && event.start < end && event.end > start,
        );
        return {
          text:
            clashes.length === 0
              ? `Free at ${formatIst(start)}.`
              : `Busy at ${formatIst(start)}: ${clashes.map((event) => event.title).join(", ")}.`,
          output: { free: clashes.length === 0, conflicts: clashes.map((event) => event.title) },
        };
      },
    },
    {
      name: "book_confirmed_meeting",
      description:
        "Book a meeting with someone at a time they confirmed. Takes the time from the input or from an earlier step's confirmed_time, checks for conflicts first, and asks when no time is known or the slot is taken.",
      kind: "workflow",
      effect: "external",
      retry: "never",
      usesLlm: false,
      inputSchema: {
        type: "object",
        properties: {
          attendees: {
            type: "array",
            items: { type: "string" },
            description: "Who to invite, as Vishnu named them.",
          },
          start_time: { type: "string", description: "ISO 8601 with offset. Omit to use an earlier step's confirmed time." },
          title: { type: "string" },
          duration_minutes: { type: "integer" },
        },
        required: ["attendees"],
        additionalProperties: false,
      },
      handler: async (input, ctx) => {
        const attendees = (input.attendees as unknown[]).map(String).filter(Boolean);
        const answer = ctx.resume?.input ?? {};
        const fromSteps = Object.values(ctx.dependencies);
        const lookedForReply = fromSteps.some((dep) => dep.output && "replied" in dep.output);
        const stepTime = fromSteps
          .map((dep) => dep.output?.confirmed_time)
          .find((value): value is string => typeof value === "string");
        const chosen =
          (typeof answer.start_time === "string" ? answer.start_time : undefined) ??
          (typeof input.start_time === "string" ? input.start_time : undefined) ??
          stepTime;
        const who = attendees.join(", ");
        if (!chosen) {
          const replied = fromSteps.some((dep) => dep.output?.replied === true);
          throw new InputRequiredSignal({
            question: lookedForReply
              ? replied
                ? `${who} replied but didn't confirm a time. When should I book it?`
                : `${who} hasn't replied yet. Book it anyway? If so, when?`
              : `When should I book the meeting with ${who}?`,
            fields: ["start_time"],
            from: "user",
          });
        }
        const start = new Date(chosen);
        if (Number.isNaN(start.getTime())) {
          throw new InputRequiredSignal({
            question: `I couldn't read "${chosen}" as a time. When should I book the meeting with ${who}?`,
            fields: ["start_time"],
            from: "user",
          });
        }
        const minutes = typeof input.duration_minutes === "number" ? input.duration_minutes : 30;
        const end = new Date(start.getTime() + minutes * 60_000);
        if (answer.book_anyway !== true) {
          const clashes = (await eventsBetween(ctx, start, end)).filter(
            (event) => !event.allDay && event.start < end && event.end > start,
          );
          if (clashes.length > 0) {
            throw new InputRequiredSignal({
              question: `You have ${clashes.map((event) => event.title).join(", ")} at ${formatIst(start)}. Book the meeting with ${who} anyway, or at another time?`,
              fields: ["start_time", "book_anyway"],
              from: "user",
            });
          }
        }
        // Both tools resolve the attendee themselves and refuse a turn that isn't Vishnu's.
        const result = config.sendOnCommandEnabled
          ? await ctx.runTool("book_meeting", {
              attendees,
              start_time: chosen,
              duration_minutes: minutes,
              ...(typeof input.title === "string" ? { title: input.title } : {}),
            })
          : await ctx.runTool("create_meeting", {
              person: attendees[0],
              start_time: chosen,
              ...(typeof input.title === "string" ? { title: input.title } : {}),
            });
        return { text: result, output: { start_time: chosen, attendees } };
      },
    },
  ],
  jobs: async (api) => {
    const { registerMeetingScan } = await import("../../meetings.js");
    const { registerMeetingBookingJobs } = await import("../../meeting_book.js");
    const booking = registerMeetingBookingJobs(api);
    return [registerMeetingScan(api), booking.inbox, booking.poll, booking.pending];
  },
};
