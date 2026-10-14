const TIME_ZONE = "Asia/Kolkata";

export const SELF_EMAILS = new Set([
  "vishnu.rajan@epicode.in",
  "vishnu.rajan294@gmail.com",
]);

export interface MomAttendee {
  name: string;
  email: string;
}

export interface MomActionItem {
  text: string;
  owner: "vishnu" | "other";
  owner_email: string | null;
  due_at: string | null;
}

export interface NoteMeeting {
  title: string;
  startAt: string;
  attendees: MomAttendee[];
  briefId?: number;
}

export interface MomInput {
  title: string;
  dateValue: string;
  attendees: MomAttendee[];
  keyPoints: string[];
  decisions: string[];
  actionItems: MomActionItem[];
  nextSteps: string[];
}

export interface MomDraft {
  subject: string;
  body: string;
  to: string[];
  attendeeLines: string[];
  tbdWarnings: string[];
}

export function isSelfEmail(email: string): boolean {
  return SELF_EMAILS.has(email.trim().toLowerCase());
}

export function recipientsExcludingSelf(
  attendees: MomAttendee[],
): MomAttendee[] {
  const seen = new Set<string>();
  const result: MomAttendee[] = [];
  for (const attendee of attendees) {
    const email = attendee.email.trim().toLowerCase();
    if (!email || isSelfEmail(email) || seen.has(email)) {
      continue;
    }
    seen.add(email);
    result.push({
      name: attendee.name.trim() || email,
      email,
    });
  }
  return result;
}

export function hasMomRecipients(attendees: MomAttendee[]): boolean {
  return recipientsExcludingSelf(attendees).length > 0;
}

export function formatMomDate(value: string): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(new Date(`${trimmed}T00:00:00Z`));
  }
  const date = new Date(trimmed);
  if (!Number.isFinite(date.getTime())) {
    return trimmed;
  }
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

export function momOwnerLabel(item: MomActionItem): string {
  if (item.owner === "vishnu") {
    return "Vishnu";
  }
  const email = item.owner_email?.trim() ?? "";
  if (email && isSelfEmail(email)) {
    return "Vishnu";
  }
  if (email) {
    return email;
  }
  return "TBD";
}

export function momDueLabel(dueAt: string | null | undefined): string {
  if (!dueAt || !dueAt.trim()) {
    return "TBD";
  }
  const date = new Date(dueAt);
  if (!Number.isFinite(date.getTime())) {
    return "TBD";
  }
  return formatMomDate(dueAt);
}

export function parseNoteSections(content: string): {
  dateValue: string | null;
  keyPoints: string[];
  decisions: string[];
  openQuestions: string[];
} {
  const keyPoints: string[] = [];
  const decisions: string[] = [];
  const openQuestions: string[] = [];
  let dateValue: string | null = null;
  let section:
    | "none"
    | "key"
    | "decisions"
    | "questions"
    | "actions"
    | "other" = "none";

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const dateMatch = line.match(/^Date:\s*(.+)$/i);
    if (dateMatch) {
      dateValue = dateMatch[1]!.trim();
      continue;
    }
    if (/^key points:?$/i.test(line)) {
      section = "key";
      continue;
    }
    if (/^decisions?:?$/i.test(line)) {
      section = "decisions";
      continue;
    }
    if (/^open questions:?$/i.test(line)) {
      section = "questions";
      continue;
    }
    if (/^action items:?$/i.test(line) || /^next steps:?$/i.test(line)) {
      section = "actions";
      continue;
    }
    if (!line.startsWith("•") && !line.startsWith("-") && !/^\d+[.)]/.test(line)) {
      continue;
    }
    const text = line.replace(/^([•\-]|(\d+[.)]))\s*/, "").trim();
    if (!text) {
      continue;
    }
    if (section === "key") {
      keyPoints.push(text);
    } else if (section === "decisions") {
      decisions.push(text);
    } else if (section === "questions") {
      openQuestions.push(text);
    }
  }

  return { dateValue, keyPoints, decisions, openQuestions };
}

export function parseNoteMeeting(raw: string | null | undefined): NoteMeeting | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as NoteMeeting;
    if (!parsed.title || !Array.isArray(parsed.attendees)) {
      return null;
    }
    return {
      title: parsed.title,
      startAt: parsed.startAt || "",
      attendees: parsed.attendees
        .filter((item) => item && typeof item.email === "string")
        .map((item) => ({
          name: typeof item.name === "string" ? item.name : item.email,
          email: item.email,
        })),
      briefId: parsed.briefId,
    };
  } catch {
    return null;
  }
}

function numbered(items: string[]): string {
  if (items.length === 0) {
    return "None recorded in notes.";
  }
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

export function buildMomDraft(input: MomInput): MomDraft {
  const recipients = recipientsExcludingSelf(input.attendees);
  const dateLabel = formatMomDate(input.dateValue);
  const title = input.title.trim() || "Meeting";
  const tbdWarnings: string[] = [];
  const actionLines = input.actionItems.map((item, index) => {
    const owner = momOwnerLabel(item);
    const due = momDueLabel(item.due_at);
    if (owner === "TBD") {
      tbdWarnings.push(`Action item ${index + 1} has no owner (TBD).`);
    }
    if (due === "TBD") {
      tbdWarnings.push(`Action item ${index + 1} has no due date (TBD).`);
    }
    return `${index + 1}. ${item.text.trim()} — Owner: ${owner} — Due: ${due}`;
  });

  const attendeeLines = recipients.map((item) =>
    item.name && item.name.toLowerCase() !== item.email
      ? `${item.name} (${item.email})`
      : item.email,
  );

  const body = [
    "Dear All,",
    "",
    `Please find below the minutes of the meeting held on ${dateLabel}.`,
    "",
    `Meeting: ${title}`,
    `Date: ${dateLabel}`,
    "",
    "Attendees:",
    attendeeLines.length ? attendeeLines.map((line) => `- ${line}`).join("\n") : "- None listed",
    "",
    "Key discussion points:",
    numbered(input.keyPoints),
    "",
    "Decisions:",
    numbered(input.decisions),
    "",
    "Action items:",
    actionLines.length ? actionLines.join("\n") : "None recorded in notes.",
    "",
    "Next steps:",
    numbered(input.nextSteps),
    "",
    "Regards,",
    "Vishnu",
  ].join("\n");

  return {
    subject: `MoM – ${title} – ${dateLabel}`,
    body,
    to: recipients.map((item) => item.email),
    attendeeLines,
    tbdWarnings,
  };
}
