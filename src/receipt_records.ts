import { db } from "./db.js";
import { detectClaimedActions, type ClaimAction } from "./receipt.js";

interface SendRecord {
  status: string;
  account: string;
  recipients: string;
  action_id: number | null;
  draft_id: string | null;
  card_id: number | null;
  thread_id: string | null;
  sent_message_id: string | null;
  sent_at: string | null;
  scheduled_at: string | null;
}

/** Metadata only. Pending rows also participate in matching so an explicit pending
 * draft cannot accidentally resolve to an older send to the same person. */
function sendRecords(): SendRecord[] {
  const drafts = db.prepare(`SELECT COALESCE(c.status, p.status) AS status, p.google_account AS account,
      COALESCE(NULLIF(p.to_header, ''), c.idem_key, '') AS recipients, p.id AS action_id, p.draft_id,
      p.telegram_message_id AS card_id, COALESCE(p.thread_id, c.thread_id) AS thread_id,
      COALESCE(p.sent_message_id, c.sent_message_id) AS sent_message_id,
      COALESCE(c.sent_at, p.sent_at) AS sent_at, NULL AS scheduled_at
    FROM pending_actions p LEFT JOIN command_sends c ON c.idem_key = p.command_key AND c.status = 'sent'
    WHERE p.type = 'send_draft'`).all() as SendRecord[];
  const commands = db.prepare(`SELECT c.status, c.account, c.idem_key AS recipients,
      NULL AS action_id, NULL AS draft_id, c.telegram_message_id AS card_id, c.thread_id,
      c.sent_message_id, c.sent_at, NULL AS scheduled_at
    FROM command_sends c WHERE NOT EXISTS
      (SELECT 1 FROM pending_actions p WHERE p.command_key = c.idem_key)`).all() as SendRecord[];
  const schedules = db.prepare(`SELECT s.status,
      COALESCE(json_extract(s.request, '$.account'), 'work') AS account,
      COALESCE((SELECT group_concat(json_extract(value, '$.mailbox.email'), ',')
        FROM json_each(s.request, '$.to')), '') AS recipients,
      NULL AS action_id, json_extract(s.request, '$.draftId') AS draft_id,
      (SELECT message_id FROM card_message_recipients WHERE draft_id = 'schedule:' || s.id
        ORDER BY message_id DESC LIMIT 1) AS card_id,
      json_extract(s.request, '$.threadId') AS thread_id,
      s.sent_message_id, COALESCE(s.sent_at, c.sent_at) AS sent_at, s.send_at AS scheduled_at
    FROM scheduled_sends s LEFT JOIN command_sends c ON c.sent_message_id = s.sent_message_id
      AND c.status = 'sent' AND c.account = json_extract(s.request, '$.account')
    WHERE json_valid(s.request)`).all() as SendRecord[];
  return [...drafts, ...commands, ...schedules];
}

function addresses(text: string): string[] {
  return [...new Set((text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []).map(value => value.toLowerCase()))];
}

function containsId(text: string, id: string | null): boolean {
  if (!id) return false;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "i").test(text);
}

function matching(records: SendRecord[], text: string): SendRecord[] | undefined {
  if (!text.trim()) return undefined;
  const card = /\b(?:card|message)\s*[:#]?\s*(\d+)\b/i.exec(text)?.[1];
  if (card) return records.filter(record => record.card_id === Number(card));
  const action = /\bdraft\s*[:#]?\s*(\d+)\b/i.exec(text)?.[1];
  if (action) return records.filter(record => record.action_id === Number(action));
  const wanted = addresses(text);
  const identifiers = records.filter(record =>
    [record.draft_id, record.thread_id, record.sent_message_id].some(id => containsId(text, id)),
  );
  if (identifiers.length) return identifiers;
  // An unknown explicit ID must not fall back to a different send in history.
  if (/\b(?:draft_id|thread_id|sent_message_id|card)\s*[:=#]\s*\S+/i.test(text)) return [];
  if (wanted.length) return records.filter(record => wanted.every(address => addresses(record.recipients).includes(address)));
  return undefined;
}

export interface ReceiptRecordContext {
  ownerText: string;
  reply: string;
  /** The selected Telegram reply, when the owner replied to a card. */
  repliedCard?: number;
  /** Successful read results from this turn. */
  reads?: readonly string[];
  /** Most recent conversation messages, newest last, used only for a pronoun reference. */
  history?: readonly string[];
  turnStartedAt: number;
}

export interface RecordedReceipt {
  actions: ClaimAction[];
  summary: string;
}

/** Resolve the email being discussed, then require an actual completed ledger state.
 * A current send request needs a current receipt even when that person was sent mail before. */
export function recordedReceipt(context: ReceiptRecordContext): RecordedReceipt | undefined {
  const denial = contradictsRecordedSend(context.reply);
  const claims = detectClaimedActions(context.reply);
  const sent = denial || claims.includes("sent");
  const scheduled = claims.includes("scheduled");
  if (!sent && !scheduled) return undefined;
  if (/\b(?:just (?:sent|emailed)|sent (?:it )?(?:just )?now|sent .*\b(?:this turn|just now))\b/i.test(context.reply)) return undefined;
  const records = sendRecords();
  const ownerMatch = context.repliedCard === undefined
    ? matching(records, context.ownerText)
    : records.filter(record => record.card_id === context.repliedCard);
  const replyMatch = matching(records, context.reply);
  let selected = replyMatch ?? ownerMatch;
  if (replyMatch && ownerMatch) {
    selected = replyMatch.filter(record => ownerMatch.includes(record));
  }
  const readMatches = new Set<SendRecord>();
  for (const read of context.reads ?? []) {
    try {
      // Tool output can include snippets. Only identifiers and mailbox metadata count.
      const parsed = JSON.parse(read);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const record of selected ?? records) {
        if (items.some(item => (!item?.account || record.account === item.account) &&
          ((item?.id && record.sent_message_id === item.id) ||
            (item?.draft_id && record.draft_id === item.draft_id) ||
            (item?.threadId && record.thread_id === item.threadId)))) {
          readMatches.add(record);
        }
      }
    } catch { /* A prose tool result supplies no structured send evidence. */ }
  }
  if (readMatches.size > 0) selected = [...readMatches];
  const previousReply = context.history?.at(-1);
  if (selected === undefined && previousReply && /\b(?:it|this|that|earlier|previous|last)\b/i.test(context.ownerText) &&
      detectClaimedActions(previousReply).includes("sent")) {
    selected = matching(records, previousReply);
  }
  if (!selected?.length) return undefined;
  // Different drafts for the same recipient can have different outcomes. Check
  // ambiguity before dropping pending rows, and collapse only linked deliveries.
  const identities = new Set(selected.map(record => record.sent_message_id
    ? `${record.account}:${record.sent_message_id}`
    : record));
  if (identities.size !== 1) return undefined;
  const completed = selected.filter(record =>
    (sent && record.status === "sent" && (!record.sent_at || recordTime(record.sent_at).getTime() <= context.turnStartedAt)) ||
    (scheduled && record.status === "scheduled" && record.scheduled_at),
  );
  if (!completed.length) return undefined;
  // Prefer a known delivery time. Older pending-action rows may have no delivery timestamp.
  completed.sort((a, b) => (b.sent_at ?? "").localeCompare(a.sent_at ?? ""));
  const record = completed[0]!;
  const recipients = addresses(record.recipients);
  if (!recipients.length) return undefined;
  if (record.status === "scheduled") return { actions: ["scheduled"], summary: "" };
  const time = record.sent_at ? recordTime(record.sent_at) : undefined;
  const summary = time && Number.isFinite(time.getTime())
    ? `Sent to ${recipients.join(", ")} at ${new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(time)} IST.`
    : `Sent to ${recipients.join(", ")}. The delivery time was not recorded.`;
  return { actions: ["sent"], summary };
}

function recordTime(value: string): Date {
  return new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
}

export function contradictsRecordedSend(reply: string): boolean {
  return /\b(?:it|that|the send)\s+(?:didn['’]t|did not)\s+happen\b|\b(?:no (?:send )?tool (?:confirmed|sent)|nothing (?:was |has been )?sent|(?:email|mail|message|it) (?:was |has |has been |is )?(?:not|never|wasn['’]t|hasn['’]t) (?:been )?sent|(?:didn['’]t|did not|couldn['’]t|could not) send)\b/i.test(reply);
}
