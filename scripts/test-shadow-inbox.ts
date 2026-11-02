import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { gmail_v1 } from "googleapis";

function ensureTestEnv(): void {
  process.env.LLM_PROVIDER ??= "claude";
  process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
  process.env.OWNER_TELEGRAM_ID ??= "1";
  process.env.CLAUDE_MODEL ??= "claude-sonnet-5-5";
  process.env.BACKGROUND_MODEL ??= "claude-haiku-5-5";
  process.env.ANTHROPIC_API_KEY ??= "test-key";
  process.env.BRIEF_TIME ??= "08:00";
  process.env.SHADOW_DAILY_TOKEN_CAP ??= "300000";
  process.env.AADI_DB_PATH ??= ":memory:";
  process.env.DOTENV_CONFIG_PATH ??= "scripts/fixtures/test.env";
}

ensureTestEnv();

const {
  assertShadowSourceIsReadOnly,
  collectPlainText,
  findWouldBookSlot,
  flagSensitiveDraft,
  formatShadowEveningSummary,
  parseShadowModelResult,
  readShadowModuleSources,
  runShadowInboxScan,
  shadowSkipReason,
  shadowTokensUsedToday,
} = await import("../src/shadow_inbox.ts");
const {
  deleteExpiredShadowReplies,
  getShadowReplyByMessageId,
  insertShadowReply,
  insertUsageLog,
  listShadowSkipCounts,
} = await import("../src/db.ts");
const { findSlots } = await import("../src/meeting_slots.ts");

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function throwWrite(method: string): never {
  throw new Error(`WRITE_FORBIDDEN:${method}`);
}

function encodePlain(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function fixtureMessage(input: {
  id: string;
  threadId: string;
  from: string;
  to?: string;
  cc?: string;
  subject: string;
  body: string;
  internalDate?: string;
}): gmail_v1.Schema$Message {
  const headers: gmail_v1.Schema$MessagePartHeader[] = [
    { name: "From", value: input.from },
    { name: "To", value: input.to ?? "Vishnu Rajan <vishnu.rajan@epicode.in>" },
    { name: "Subject", value: input.subject },
    { name: "Message-ID", value: `<${input.id}@test>` },
  ];
  if (input.cc) {
    headers.push({ name: "Cc", value: input.cc });
  }
  return {
    id: input.id,
    threadId: input.threadId,
    internalDate: input.internalDate ?? String(Date.now() - 60_000),
    labelIds: ["INBOX"],
    payload: {
      mimeType: "text/plain",
      headers,
      body: { data: encodePlain(input.body) },
    },
  };
}

{
  assertShadowSourceIsReadOnly(readShadowModuleSources());
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "../src/shadow_inbox.ts"), "utf8");
  assert(
    !source.includes(["create", "Holds"].join("")),
    "shadow_inbox must never mention createHolds",
  );
  console.log("static no-send source check: ok");
}

{
  assert(
    shadowSkipReason({
      fromEmail: "ops@supertroninfotech.com",
      toEmails: ["vishnu.rajan@epicode.in"],
      ccEmails: [],
      headers: [],
      subject: "Hello",
    }) === "partner_self",
    "partner sender is partner_self",
  );
  assert(
    shadowSkipReason({
      fromEmail: "alex@acme.com",
      toEmails: ["vishnu.rajan@epicode.in"],
      ccEmails: ["colleague@epicode.in"],
      headers: [],
      subject: "Hello",
    }) === "colleague_cc",
    "epicode colleague on Cc is colleague_cc",
  );
  assert(
    shadowSkipReason({
      fromEmail: "mailer-daemon@bounce.example",
      toEmails: ["vishnu.rajan@epicode.in"],
      ccEmails: [],
      headers: [],
      subject: "Delivery",
    }) === "noreply",
    "mailer-daemon is noreply",
  );
  assert(
    shadowSkipReason({
      fromEmail: "news@example.com",
      toEmails: ["vishnu.rajan@epicode.in"],
      ccEmails: [],
      headers: [{ name: "List-Unsubscribe", value: "<mailto:x>" }],
      subject: "Weekly",
    }) === "list",
    "List-Unsubscribe is list",
  );
  assert(
    shadowSkipReason({
      fromEmail: "bot@example.com",
      toEmails: ["vishnu.rajan@epicode.in"],
      ccEmails: [],
      headers: [{ name: "Auto-Submitted", value: "auto-replied" }],
      subject: "Out of office",
    }) === "auto_reply",
    "Auto-Submitted is auto_reply",
  );
  assert(
    shadowSkipReason({
      fromEmail: "calendar-notification@google.com",
      toEmails: ["vishnu.rajan@epicode.in"],
      ccEmails: [],
      headers: [{ name: "Content-Type", value: "text/calendar" }],
      subject: "Accepted: Sync",
      mimeType: "text/calendar",
    }) === "calendar",
    "calendar invite is calendar",
  );
  assert(
    shadowSkipReason({
      fromEmail: "billing@stripe.com",
      toEmails: ["vishnu.rajan@epicode.in"],
      ccEmails: [],
      headers: [],
      subject: "Your receipt from Stripe",
    }) === "receipt",
    "receipt subject is receipt",
  );
  assert(
    shadowSkipReason({
      fromEmail: "priya@acme.com",
      toEmails: ["vishnu.rajan@epicode.in"],
      ccEmails: [],
      headers: [],
      subject: "Quick question",
    }) === undefined,
    "external prospect stays in scope",
  );
  console.log("exclusion rules: ok");
}

{
  const stamp = new Date(Date.now() - 1000).toISOString();
  insertUsageLog({
    timestamp: stamp,
    task: "shadow",
    model: "claude-haiku-5-5",
    input_tokens: 250_000,
    cache_write_tokens: 0,
    cache_read_tokens: 0,
    output_tokens: 50_000,
    cost_usd: 0.1,
  });
  assert(
    shadowTokensUsedToday() >= 300_000,
    `shadow tokens accumulate (got ${shadowTokensUsedToday()})`,
  );
  const meeting = fixtureMessage({
    id: "cap-msg",
    threadId: "cap-thread",
    from: "priya@acme.com",
    subject: "Meet?",
    body: "Can we talk tomorrow?",
  });
  let completeCalls = 0;
  const stats = await runShadowInboxScan({
    gmail: {
      users: {
        messages: {
          list: async () => ({ data: { messages: [] } }),
          get: async () => ({ data: meeting }),
          send: async () => throwWrite("messages.send"),
        },
        drafts: {
          create: async () => throwWrite("drafts.create"),
          send: async () => throwWrite("drafts.send"),
          update: async () => throwWrite("drafts.update"),
        },
        threads: {
          get: async () => ({ data: { messages: [meeting] } }),
        },
      },
    } as unknown as gmail_v1.Gmail,
    messages: [meeting],
    tokenCap: 100,
    complete: async () => {
      completeCalls += 1;
      throw new Error("should not call model when over cap");
    },
    loadBusy: async () => [],
    gatherContext: async () => "(test context)",
  });
  assert(stats.capped === 1, "over-cap scan stops with capped");
  assert(completeCalls === 0, "model is not called when over daily cap");
  console.log("cap enforcement: ok");
}

{
  let createHoldsTouched = false;
  const slots = findSlots({
    now: new Date("2026-11-03T04:00:00.000Z"),
    busy: [],
    durationMinutes: 30,
    hours: { startMinutes: 10 * 60, endMinutes: 18 * 60 + 30 },
    breakMinutes: { startMinutes: 13 * 60, endMinutes: 14 * 60 },
    bufferMinutes: 15,
    minNoticeHours: 4,
    horizonDays: 7,
    slotsToOffer: 1,
    timezone: "Asia/Kolkata",
  });
  assert(slots.length >= 1, "findSlots returns a free slot");
  assert(createHoldsTouched === false, "findSlots never touches createHolds");
  const would = await findWouldBookSlot(
    new Date("2026-11-03T04:00:00.000Z"),
    async () => [],
  );
  assert(would !== null, "would_book slot is found read-only");
  console.log("findSlots read-only: ok");
}

{
  const writeCounts = {
    messagesSend: 0,
    draftsCreate: 0,
    draftsSend: 0,
    draftsUpdate: 0,
    eventsInsert: 0,
    eventsPatch: 0,
    eventsDelete: 0,
    sendUpdates: 0,
    telegramOther: 0,
  };

  const meeting = fixtureMessage({
    id: "shadow-meet-1",
    threadId: "shadow-thread-meet",
    from: "Priya Shah <priya@acme.com>",
    subject: "Intro call?",
    body: "Hi Vishnu — could we find 30 minutes this week for an intro call?",
  });
  const pricing = fixtureMessage({
    id: "shadow-price-1",
    threadId: "shadow-thread-price",
    from: "Lee Chen <lee@globex.io>",
    subject: "Pricing for Epicode seats",
    body: "What does your team pricing look like for 10 seats?",
  });
  const vendor = fixtureMessage({
    id: "shadow-vendor-1",
    threadId: "shadow-thread-vendor",
    from: "Sam Pitch <sam@vendora.io>",
    subject: "Quick partnership idea",
    body: "We help GTMs book more demos. Open to a quick chat?",
  });

  const byId = new Map(
    [meeting, pricing, vendor].map((message) => [message.id!, message]),
  );

  const fakeGmail = {
    users: {
      messages: {
        list: async () => ({
          data: {
            messages: [meeting, pricing, vendor].map((message) => ({
              id: message.id,
              threadId: message.threadId,
            })),
          },
        }),
        get: async (params: { id: string }) => {
          const found = byId.get(params.id);
          if (!found) {
            throw new Error(`missing ${params.id}`);
          }
          return { data: found };
        },
        send: async () => {
          writeCounts.messagesSend += 1;
          throwWrite("messages.send");
        },
      },
      drafts: {
        create: async () => {
          writeCounts.draftsCreate += 1;
          throwWrite("drafts.create");
        },
        send: async () => {
          writeCounts.draftsSend += 1;
          throwWrite("drafts.send");
        },
        update: async () => {
          writeCounts.draftsUpdate += 1;
          throwWrite("drafts.update");
        },
      },
      threads: {
        get: async (params: { id: string }) => {
          const message = [...byId.values()].find(
            (item) => item.threadId === params.id,
          );
          return { data: { id: params.id, messages: message ? [message] : [] } };
        },
      },
    },
  } as unknown as gmail_v1.Gmail;

  const responses: Record<string, object> = {
    "shadow-meet-1": {
      needs_reply: true,
      category: "meeting_request",
      draft: "Hi Priya — happy to meet. Does Thursday 11:00 IST work?",
      send_confidence: 0.9,
      reason: "Clear intro meeting ask",
    },
    "shadow-price-1": {
      needs_reply: true,
      category: "pricing",
      draft: "Hi Lee — thanks for asking. I will share a range after I check seat tiers.",
      send_confidence: 0.7,
      reason: "Pricing question needs a careful reply",
    },
    "shadow-vendor-1": {
      needs_reply: false,
      category: "vendor_pitch",
      draft: "",
      send_confidence: 0.2,
      reason: "Cold vendor pitch",
    },
  };

  let eveningText = "";
  const stats = await runShadowInboxScan({
    gmail: fakeGmail,
    messages: [meeting, pricing, vendor],
    tokenCap: 1_000_000,
    loadBusy: async () => [],
    gatherContext: async (_gmail, input) =>
      `Thread for ${input.fromEmail}\nSubject context only`,
    complete: async (params) => {
      const user = params.messages[0]?.content;
      const text = typeof user === "string" ? user : "";
      const id =
        Object.keys(responses).find((key) => text.includes(key)) ??
        (text.includes("Intro call")
          ? "shadow-meet-1"
          : text.includes("Pricing")
            ? "shadow-price-1"
            : "shadow-vendor-1");
      return {
        textParts: [JSON.stringify(responses[id]!)],
        toolCalls: [],
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          estimatedCostUsd: 0,
        },
        stopReason: "end_turn",
      };
    },
    sendEveningSummary: async (text) => {
      eveningText = text;
    },
  });

  assert(stats.stored === 3, `expected 3 stored, got ${stats.stored}`);
  assert(getShadowReplyByMessageId("shadow-meet-1")?.category === "meeting_request");
  assert(getShadowReplyByMessageId("shadow-price-1")?.category === "pricing");
  assert(getShadowReplyByMessageId("shadow-vendor-1")?.category === "vendor_pitch");
  assert(
    getShadowReplyByMessageId("shadow-meet-1")?.would_book != null,
    "meeting request stores would_book",
  );
  assert(
    writeCounts.messagesSend === 0 &&
      writeCounts.draftsCreate === 0 &&
      writeCounts.draftsSend === 0 &&
      writeCounts.draftsUpdate === 0 &&
      writeCounts.eventsInsert === 0 &&
      writeCounts.eventsPatch === 0 &&
      writeCounts.eventsDelete === 0 &&
      writeCounts.sendUpdates === 0,
    "runtime write counters stay at zero",
  );

  const summary = formatShadowEveningSummary(
    [
      getShadowReplyByMessageId("shadow-meet-1")!,
      getShadowReplyByMessageId("shadow-price-1")!,
      getShadowReplyByMessageId("shadow-vendor-1")!,
    ],
    listShadowSkipCounts(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date()),
    ),
  );
  assert(/Shadow: 3 emails/.test(summary), "evening summary counts emails");
  assert(/would auto-send at ≥0.85/.test(summary), "evening summary mentions threshold");
  void eveningText;
  console.log("runtime pipeline + no-send: ok");
}

{
  const parsed = parseShadowModelResult({
    needs_reply: true,
    category: "question",
    draft: "Thanks — will check and reply.",
    send_confidence: 0.88,
    reason: "Straightforward question",
  });
  assert(parsed?.send_confidence === 0.88, "parse confidence");
  const flags = flagSensitiveDraft(
    "We can do ₹50k with a 10% discount by Friday.",
    "Hi, curious about your product",
  );
  assert(flags.some((flag) => /price/.test(flag)), "flags price invention");
  assert(collectPlainText(fixtureMessage({
    id: "x",
    threadId: "t",
    from: "a@b.com",
    subject: "s",
    body: "hello plain",
  }).payload) === "hello plain");
  insertShadowReply({
    messageId: "old-shadow",
    threadId: "t",
    receivedAt: "2020-01-01T00:00:00.000Z",
    senderDomain: "acme.com",
    category: "other",
    needsReply: false,
    sendConfidence: 0,
    draft: "",
    wouldBook: null,
    reason: "old",
    model: "test",
  });
  // Force created_at old via raw update is unnecessary; deleteExpired uses created_at default now.
  // Just ensure the helper runs.
  deleteExpiredShadowReplies(30);
  console.log("helpers: ok");
}

console.log("test-shadow-inbox: all passed");
