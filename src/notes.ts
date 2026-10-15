import { InlineKeyboard, type Context } from "grammy";
import {
  createNote,
  createTask,
  clearNotePendingTasks,
  getNote,
  type ItemTag,
  type NoteActionItem,
} from "./db.js";
import { runAgent } from "./agent.js";
import { apiEffortForTask, getTaskBackend } from "./chat_backend.js";
import { complete } from "./llm.js";
import { offerAccountUpdateAfterWrapUp } from "./accounts.js";
import { draftMomForNote } from "./mom.js";
import {
  hasMomRecipients,
  type NoteMeeting,
} from "./mom_logic.js";

export interface WrapUpAnalysis {
  title: string;
  people: string;
  tag: ItemTag;
  date: string;
  key_points: string[];
  decisions: string[];
  open_questions: string[];
  action_items: NoteActionItem[];
  content: string;
}

const wrapUpPrompt = `Turn Vishnu's raw call/meeting notes into structured notes. Return ONLY JSON:
{
  "title": "short title",
  "people": "comma-separated names",
  "tag": "work" | "personal",
  "date": "YYYY-MM-DD (use today in Asia/Kolkata unless notes state otherwise)",
  "key_points": ["..."],
  "decisions": ["only explicit decisions"],
  "open_questions": ["..."],
  "action_items": [{"text":"...","owner":"vishnu"|"other","owner_email":null or email,"tag":"work"|"personal","due_at":null or ISO8601}]
}
Never invent decisions, dates, or commitments not in the notes.`;

function parseWrapUp(text: string): WrapUpAnalysis {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const parsed = JSON.parse(text.slice(start, end + 1)) as WrapUpAnalysis;
  if (parsed.tag !== "work" && parsed.tag !== "personal") {
    parsed.tag = "work";
  }
  parsed.action_items = Array.isArray(parsed.action_items)
    ? parsed.action_items
    : [];
  parsed.content = formatNoteContent(parsed);
  return parsed;
}

function formatNoteContent(analysis: WrapUpAnalysis): string {
  return [
    `Date: ${analysis.date}`,
    `People: ${analysis.people}`,
    "",
    "Key points:",
    ...analysis.key_points.map((line) => `• ${line}`),
    "",
    "Decisions:",
    ...analysis.decisions.map((line) => `• ${line}`),
    "",
    "Open questions:",
    ...analysis.open_questions.map((line) => `• ${line}`),
    "",
    "Action items:",
    ...analysis.action_items.map(
      (item) =>
        `• ${item.text} (${item.owner === "vishnu" ? "Vishnu" : "Other"})`,
    ),
  ].join("\n");
}

export async function buildWrapUpNotes(rawInput: string): Promise<WrapUpAnalysis> {
  const response = await complete({
    backend: getTaskBackend("meetings"),
    effort: apiEffortForTask("meetings"),
    cacheTtl: "5m",
    task: "meeting_brief",
    maxTokens: 4096,
    tools: [],
    system: { cacheable: wrapUpPrompt },
    messages: [
      {
        role: "user",
        content: `<raw_notes>\n${rawInput}\n</raw_notes>`,
      },
    ],
  });
  const text = response.textParts.join("\n");
  console.log(
    `Wrap-up analysis: input_tokens=${response.usage.inputTokens}, output_tokens=${response.usage.outputTokens}`,
  );
  return parseWrapUp(text);
}

function noteKeyboard(noteId: number, showMom: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text("Add my action items as tasks", `note:tasks:${noteId}`)
    .row()
    .text("Draft follow-up email", `note:draft:${noteId}`);
  if (showMom) {
    keyboard.row().text("Draft MoM email", `note:mom:${noteId}`);
  }
  return keyboard.row().text("Done", `note:done:${noteId}`);
}

export async function deliverWrapUp(
  ctx: Context,
  rawInput: string,
  meeting?: NoteMeeting | null,
): Promise<void> {
  const analysis = await buildWrapUpNotes(rawInput);
  const pending =
    analysis.action_items.length > 0 ? analysis.action_items : null;
  const showMom = Boolean(meeting && hasMomRecipients(meeting.attendees));
  const note = createNote(
    analysis.title,
    analysis.people,
    analysis.tag,
    analysis.content,
    pending,
    meeting ? JSON.stringify(meeting) : null,
  );
  console.log(`Note ${note.id}: stored`);

  const reply = `${analysis.title} (${analysis.tag})\n\n${analysis.content}\n\nNote id: ${note.id}`;
  await ctx.reply(reply, {
    reply_markup: noteKeyboard(note.id, showMom),
  });
  try {
    await offerAccountUpdateAfterWrapUp(ctx, analysis);
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Account wrap-up offer failed (${errorType}).`);
  }
}

export async function handleNoteCallback(
  ctx: Context,
  operation: "tasks" | "draft" | "done" | "mom",
  noteId: number,
): Promise<void> {
  await ctx.answerCallbackQuery();
  const note = getNote(noteId);
  if (!note) {
    await ctx.reply("That note is no longer available.");
    return;
  }

  if (operation === "done") {
    clearNotePendingTasks(noteId);
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    return;
  }

  if (operation === "mom") {
    try {
      await draftMomForNote(noteId);
      await ctx.reply("MoM draft is waiting for your approval. It will not send until you tap Send.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(message);
    }
    return;
  }

  if (operation === "tasks") {
    if (!note.pending_action_items) {
      await ctx.reply("No pending action items for that note.");
      return;
    }
    const items = JSON.parse(note.pending_action_items) as NoteActionItem[];
    const mine = items.filter((item) => item.owner === "vishnu");
    const created: number[] = [];
    for (const item of mine) {
      const task = createTask(item.text, item.tag, item.due_at);
      created.push(task.id);
      console.log(`Task ${task.id}: status -> open`);
    }
    clearNotePendingTasks(noteId);
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    await ctx.reply(
      created.length
        ? `Added ${created.length} task(s): ${created.map((id) => `#${id}`).join(", ")}.`
        : "No action items assigned to you in that note.",
    );
    return;
  }

  const instruction = `Draft a follow-up email recap from Vishnu's meeting notes below. Use search_emails to find the latest thread with the other person mentioned in the notes. If you cannot find a thread or email address, ask Vishnu for the email address instead of guessing. Never invent decisions or dates not in the notes. Create one draft_reply only; do not send.

<meeting_notes>
${note.content}
</meeting_notes>

People involved: ${note.people}`;

  const reply = await runAgent(instruction, {
    saveUserMessage: false,
    task: "drafting",
  });
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  await ctx.reply(reply);
}
