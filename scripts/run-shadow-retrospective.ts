/**
 * One-shot 21-day shadow retrospective against the work inbox.
 * Writes a local markdown comparison under local/shadow-reports/ (gitignored).
 * Never sends mail, never creates drafts, never books calendar.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { gmail_v1 } from "googleapis";
import { config } from "../src/config.js";
import {
  getShadowReplyByMessageId,
  listShadowRepliesSince,
  listShadowSkipCountsBetween,
  listUsageLogs,
  updateShadowReplyActual,
} from "../src/db.js";
import { messageHeader } from "../src/gmail_attachments.js";
import { parseAddressList } from "../src/meeting_book.js";
import {
  collectPlainText,
  findActualReplyInThread,
  flagSensitiveDraft,
  getWorkGmail,
  runShadowInboxScan,
  shadowSkipReason,
  type ShadowSkipReason,
} from "../src/shadow_inbox.js";

const LOOKBACK_DAYS = 21;
const REPORT_DIR = join(process.cwd(), "local", "shadow-reports");
const AUTO_SEND = 0.85;

function kolkataYmd(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) {
    return clean;
  }
  return `${clean.slice(0, max)}…`;
}

function confidenceBucket(value: number): string {
  if (value >= 0.85) {
    return "≥0.85";
  }
  if (value >= 0.6) {
    return "0.60–0.84";
  }
  if (value >= 0.3) {
    return "0.30–0.59";
  }
  return "<0.30";
}

function noteDifferences(draft: string, actual: string | null): string {
  if (!actual) {
    return "I never replied.";
  }
  const notes: string[] = [];
  const draftLower = draft.toLowerCase();
  const actualLower = actual.toLowerCase();
  for (const token of [
    "₹",
    "discount",
    "contract",
    "nda",
    "timeline",
    "deadline",
    "price",
  ]) {
    const inDraft = draftLower.includes(token);
    const inActual = actualLower.includes(token);
    if (inDraft !== inActual) {
      notes.push(
        inDraft
          ? `draft mentions ${token}; actual does not`
          : `actual mentions ${token}; draft does not`,
      );
    }
  }
  if (Math.abs(draft.length - actual.length) > 400) {
    notes.push(
      draft.length > actual.length ? "draft is much longer" : "actual is much longer",
    );
  }
  if (notes.length === 0) {
    notes.push("similar substance at a glance; review tone manually");
  }
  return notes.join("; ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isQuotaError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /quota|rate limit|429/i.test(text);
}

async function gmailGetFull(
  gmail: gmail_v1.Gmail,
  id: string,
): Promise<gmail_v1.Schema$Message> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const response = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "full",
      });
      return response.data;
    } catch (error) {
      if (!isQuotaError(error) || attempt === 5) {
        throw error;
      }
      const waitMs = 15_000 * (attempt + 1);
      console.log(`Shadow retrospective: quota backoff ${waitMs}ms id=${id}`);
      await sleep(waitMs);
    }
  }
  throw new Error(`gmail get failed for ${id}`);
}

async function gmailGetMetadata(
  gmail: gmail_v1.Gmail,
  id: string,
): Promise<gmail_v1.Schema$Message> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const response = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: [
          "From",
          "To",
          "Cc",
          "Subject",
          "List-Unsubscribe",
          "Auto-Submitted",
          "Precedence",
          "X-Autoreply",
          "X-Autorespond",
          "X-Auto-Response-Suppress",
          "Content-Type",
        ],
      });
      return response.data;
    } catch (error) {
      if (!isQuotaError(error) || attempt === 5) {
        throw error;
      }
      const waitMs = 15_000 * (attempt + 1);
      console.log(`Shadow retrospective: quota backoff ${waitMs}ms id=${id}`);
      await sleep(waitMs);
    }
  }
  throw new Error(`gmail metadata get failed for ${id}`);
}

async function listLookbackIds(gmail: gmail_v1.Gmail): Promise<string[]> {
  const query = `in:inbox newer_than:${LOOKBACK_DAYS}d -category:promotions -category:social`;
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const listed = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 100,
      pageToken,
    });
    for (const item of listed.data.messages ?? []) {
      if (item.id) {
        ids.push(item.id);
      }
    }
    pageToken = listed.data.nextPageToken ?? undefined;
    await sleep(300);
  } while (pageToken);
  return ids;
}

async function threadPlain(
  gmail: gmail_v1.Gmail,
  threadId: string,
): Promise<string> {
  try {
    const thread = await gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "full",
    });
    return (thread.data.messages ?? [])
      .map((message) => {
        const from = messageHeader(message, "From");
        const subject = messageHeader(message, "Subject");
        return `From: ${from}\nSubject: ${subject}\n${collectPlainText(message.payload)}`;
      })
      .join("\n---\n");
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  const usageFrom = new Date().toISOString();
  const gmail = await getWorkGmail();
  if (!gmail) {
    throw new Error("Work Gmail account is not authorized on this machine.");
  }

  console.log(`Shadow retrospective: listing last ${LOOKBACK_DAYS}d of work inbox…`);
  await sleep(20_000);
  const ids = await listLookbackIds(gmail);
  console.log(`Shadow retrospective: listed=${ids.length}`);

  const skipTotals = new Map<ShadowSkipReason, number>();
  const inScopeIds: string[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i]!;
    const meta = await gmailGetMetadata(gmail, id);
    const fromEmail = parseAddressList(messageHeader(meta, "From"))[0] ?? "";
    const subject = messageHeader(meta, "Subject");
    const skip = shadowSkipReason({
      fromEmail,
      toEmails: parseAddressList(messageHeader(meta, "To")),
      ccEmails: parseAddressList(messageHeader(meta, "Cc")),
      headers: meta.payload?.headers,
      subject,
      mimeType: meta.payload?.mimeType,
      testSenders: config.meetingTestSenders,
    });
    if (skip) {
      skipTotals.set(skip, (skipTotals.get(skip) ?? 0) + 1);
    } else {
      inScopeIds.push(id);
    }
    if (i % 8 === 7) {
      await sleep(1000);
    } else {
      await sleep(150);
    }
    if ((i + 1) % 40 === 0) {
      console.log(`Shadow retrospective: classified ${i + 1}/${ids.length}`);
    }
  }
  console.log(
    `Shadow retrospective: in_scope=${inScopeIds.length} skipped=${ids.length - inScopeIds.length}`,
  );

  const inScope: gmail_v1.Schema$Message[] = [];
  for (let i = 0; i < inScopeIds.length; i += 1) {
    inScope.push(await gmailGetFull(gmail, inScopeIds[i]!));
    await sleep(400);
    if ((i + 1) % 20 === 0) {
      console.log(`Shadow retrospective: full-fetched ${i + 1}/${inScopeIds.length}`);
    }
  }

  const scan = await runShadowInboxScan({
    gmail,
    messages: inScope,
    tokenCap: config.shadowRetroTokenCap,
    recordActualReply: true,
    pauseMsBetween: 1500,
  });

  for (const message of inScope) {
    if (!message.id || !message.threadId) {
      continue;
    }
    const row = getShadowReplyByMessageId(message.id);
    if (!row || row.actual_reply != null) {
      continue;
    }
    const found = await findActualReplyInThread(
      gmail,
      message.threadId,
      message.id,
    );
    updateShadowReplyActual(message.id, found?.body ?? null, found?.at ?? null);
  }

  const since = new Date(
    Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const rows = listShadowRepliesSince(since);
  const byCategory = new Map<string, number>();
  const byConfidence = new Map<string, number>();
  let needsReply = 0;
  for (const row of rows) {
    byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + 1);
    const bucket = confidenceBucket(row.send_confidence);
    byConfidence.set(bucket, (byConfidence.get(bucket) ?? 0) + 1);
    if (row.needs_reply) {
      needsReply += 1;
    }
  }

  const high = rows
    .filter((row) => row.needs_reply && row.send_confidence >= AUTO_SEND)
    .sort((a, b) => b.send_confidence - a.send_confidence);

  const usageTo = new Date().toISOString();
  const usageRows = listUsageLogs(usageFrom, usageTo).filter(
    (row) => row.task === "shadow",
  );
  let tokens = 0;
  let cost = 0;
  for (const row of usageRows) {
    tokens +=
      row.input_tokens +
      row.cache_write_tokens +
      row.cache_read_tokens +
      row.output_tokens;
    cost += row.cost_usd;
  }

  const fromYmd = kolkataYmd(new Date(Date.now() - LOOKBACK_DAYS * 86400000));
  const toYmd = kolkataYmd(new Date());
  const dbSkips = listShadowSkipCountsBetween(fromYmd, toYmd);
  const skipLines = [...skipTotals.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([reason, count]) => `- ${reason}: ${count}`);
  if (skipLines.length === 0) {
    skipLines.push("- (none)");
  }

  const lines: string[] = [];
  lines.push(`# Shadow retrospective (${LOOKBACK_DAYS} days)`);
  lines.push("");
  lines.push(
    `Generated: ${new Date().toISOString()} (local only — do not commit or copy off this machine)`,
  );
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Listed inbox messages: ${ids.length}`);
  lines.push(
    `- In-scope modelled: ${scan.stored} stored, ${scan.errors} errors, ${scan.capped} capped`,
  );
  lines.push(`- Rows in window: ${rows.length}`);
  lines.push(
    `- Needs reply: ${needsReply}/${rows.length || 1} (${
      rows.length ? ((100 * needsReply) / rows.length).toFixed(1) : 0
    }%)`,
  );
  lines.push(`- Would auto-send (≥${AUTO_SEND}): ${high.length}`);
  lines.push(`- Tokens used (this run, task=shadow): ${tokens}`);
  lines.push(`- Estimated cost (this run): $${cost.toFixed(4)}`);
  lines.push(`- Cap: SHADOW_RETRO_TOKEN_CAP=${config.shadowRetroTokenCap}`);
  lines.push(`- Elapsed ms: ${Date.now() - started}`);
  lines.push("");
  lines.push("### By category");
  lines.push("");
  for (const [category, count] of [...byCategory.entries()].sort(
    (a, b) => b[1] - a[1],
  )) {
    lines.push(`- ${category}: ${count}`);
  }
  if (byCategory.size === 0) {
    lines.push("- (none)");
  }
  lines.push("");
  lines.push("### Send confidence distribution");
  lines.push("");
  for (const key of ["≥0.85", "0.60–0.84", "0.30–0.59", "<0.30"]) {
    lines.push(`- ${key}: ${byConfidence.get(key) ?? 0}`);
  }
  lines.push("");
  lines.push("### Skip counts (pre-model exclusions on listed mail)");
  lines.push("");
  lines.push(...skipLines);
  if (dbSkips.length > 0) {
    lines.push("");
    lines.push("DB skip counters in window:");
    for (const row of dbSkips) {
      lines.push(`- ${row.reason}: ${row.count}`);
    }
  }
  lines.push("");
  lines.push(`## Drafts with send_confidence ≥ ${AUTO_SEND}`);
  lines.push("");
  if (high.length === 0) {
    lines.push("_None._");
  }
  for (const row of high) {
    const threadText = await threadPlain(gmail, row.thread_id);
    const allFlags = flagSensitiveDraft(row.draft, threadText);
    lines.push(
      `### ${row.message_id} — ${row.category} — confidence ${row.send_confidence.toFixed(2)}`,
    );
    lines.push("");
    lines.push(`- thread: ${row.thread_id}`);
    lines.push(`- received: ${row.received_at}`);
    lines.push(`- sender_domain: ${row.sender_domain}`);
    lines.push(`- reason: ${row.reason}`);
    lines.push(`- model: ${row.model}`);
    lines.push(`- would_book: ${row.would_book ?? "null"}`);
    lines.push(`- difference note: ${noteDifferences(row.draft, row.actual_reply)}`);
    if (allFlags.length > 0) {
      lines.push(`- flags: ${allFlags.join("; ")}`);
    }
    lines.push("");
    lines.push("**Aadi draft**");
    lines.push("");
    lines.push("```");
    lines.push(clip(row.draft || "(empty)", 2500));
    lines.push("```");
    lines.push("");
    lines.push("**Actual reply**");
    lines.push("");
    lines.push("```");
    lines.push(clip(row.actual_reply ?? "I never replied", 2500));
    lines.push("```");
    lines.push("");
  }

  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = join(REPORT_DIR, `retrospective-${stamp}.md`);
  writeFileSync(reportPath, `${lines.join("\n")}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        reportPath,
        listed: ids.length,
        stored: scan.stored,
        errors: scan.errors,
        capped: scan.capped,
        rows: rows.length,
        needsReply,
        wouldAutoSend: high.length,
        tokens,
        costUsd: Number(cost.toFixed(4)),
        skips: Object.fromEntries(skipTotals),
        byCategory: Object.fromEntries(byCategory),
        byConfidence: Object.fromEntries(byConfidence),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
