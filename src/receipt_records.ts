import { db, type GoogleAccountId } from "./db.js";

interface DeliveryRead {
  account: GoogleAccountId;
  id: string;
  sent: boolean;
}

function readRecord(value: unknown): DeliveryRead | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { account, id, sent } = value as { account?: unknown; id?: unknown; sent?: unknown };
  if ((account !== "work" && account !== "personal") || typeof id !== "string" || !id) return undefined;
  return { account, id, sent: sent === true };
}

/** Read results identify an exact mailbox message. Body and snippet text carry no evidence. */
export function deliveryReadsFromTool(tool: string, content: string): DeliveryRead[] {
  try {
    if (tool === "search_emails") {
      const rows: unknown = JSON.parse(content);
      if (!Array.isArray(rows)) return [];
      return rows.flatMap(row => readRecord(row) ?? []);
    }
    if (tool === "read_email") {
      const header = content.split("\n", 3)[2];
      const prefix = "Message record: ";
      if (!header?.startsWith(prefix)) return [];
      const row = readRecord(JSON.parse(header.slice(prefix.length)));
      return row ? [row] : [];
    }
  } catch {
    // The tool returned prose or malformed metadata instead of a message record.
  }
  return [];
}

function hasSentRecord(account: GoogleAccountId, id: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM command_sends WHERE account = @account AND sent_message_id = @id AND status = 'sent'
    UNION ALL
    SELECT 1 FROM pending_actions WHERE google_account = @account AND sent_message_id = @id AND status = 'sent'
    UNION ALL
    SELECT 1 FROM scheduled_sends WHERE sent_message_id = @id AND status = 'sent'
      AND CASE WHEN json_valid(request) THEN COALESCE(json_extract(request, '$.account'), 'work') END = @account
    LIMIT 1
  `).get({ account, id }));
}

/** The sent messages among this turn's reads that the records (or Gmail's own sent flag) confirm. */
export function confirmedSentReads(reads: readonly DeliveryRead[]): Array<{ account: GoogleAccountId; id: string }> {
  const seen = new Set<string>();
  const out: Array<{ account: GoogleAccountId; id: string }> = [];
  for (const read of reads) {
    const key = `${read.account}:${read.id}`;
    if (seen.has(key) || !(read.sent || hasSentRecord(read.account, read.id))) continue;
    seen.add(key);
    out.push({ account: read.account, id: read.id });
  }
  return out;
}

/** Use a delivery acknowledged by this turn's write, or the exact message a read returned. */
export function recordedReceipt(input: {
  outcomeIds: Iterable<string>;
  reads: readonly DeliveryRead[];
  deliveryAttempted: boolean;
  writeFailed: boolean;
}): boolean {
  for (const key of input.outcomeIds) {
    const [kind, account, ...messageId] = key.split(":");
    const id = messageId.join(":");
    if (kind === "send" && (account === "work" || account === "personal") && id && hasSentRecord(account, id)) {
      return true;
    }
  }
  if (input.deliveryAttempted || input.writeFailed) return false;
  return input.reads.some(read => read.sent || hasSentRecord(read.account, read.id));
}
