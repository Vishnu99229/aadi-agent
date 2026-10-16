import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isOwner,
  isOwnerTelegramId,
  isOwnerWhatsApp,
  ownerOnly,
} from "../src/security/owner_lock.ts";
import {
  SendNotApprovedError,
  allowSendDraft,
  parseSendApprovalCallback,
} from "../src/security/send_approval.ts";
import {
  missingRequiredEnv,
  parseOwnerTelegramId,
  redactSecrets,
} from "../src/security/env_guard.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertThrows(run: () => void, message: string): void {
  try {
    run();
  } catch (error) {
    if (error instanceof SendNotApprovedError) {
      return;
    }
    throw error;
  }
  throw new Error(message);
}

const ownerId = 111;
assert(isOwnerTelegramId(ownerId, ownerId), "owner telegram id matches");
assert(!isOwnerTelegramId(1, ownerId), "stranger telegram id is rejected");
assert(!isOwnerTelegramId(undefined, ownerId), "missing telegram id is rejected");
assert(
  isOwnerWhatsApp("+91 98765 43210", "919876543210"),
  "owner whatsapp matches",
);
assert(
  !isOwnerWhatsApp("911111111111", "919876543210"),
  "stranger whatsapp is rejected",
);
assert(
  isOwner({ telegramUserId: ownerId, ownerTelegramId: ownerId }),
  "isOwner accepts telegram",
);
assert(
  !isOwner({ telegramUserId: 99, ownerTelegramId: ownerId }),
  "isOwner rejects other telegram",
);

let continued = false;
const middleware = ownerOnly(ownerId);
await middleware(
  { from: { id: 99 } } as never,
  async () => {
    continued = true;
  },
);
assert(!continued, "non-owner update is not handled");

continued = false;
await middleware(
  { from: { id: ownerId } } as never,
  async () => {
    continued = true;
  },
);
assert(continued, "owner update is handled");

assert(parseSendApprovalCallback("approval:send:12") === 12, "send callback");
assert(
  parseSendApprovalCallback("approval:discard:12") === undefined,
  "discard is not send",
);
assert(
  parseSendApprovalCallback("approval:edit:12") === undefined,
  "edit is not send",
);

allowSendDraft({
  callbackData: "approval:send:7",
  actionId: 7,
  actionStatus: "pending",
});

assertThrows(
  () =>
    allowSendDraft({
      callbackData: undefined,
      actionId: 7,
      actionStatus: "pending",
    }),
  "send without approval callback must fail",
);
assertThrows(
  () =>
    allowSendDraft({
      callbackData: "approval:send:7",
      actionId: 7,
      actionStatus: "sent",
    }),
  "already-sent action must not send again",
);
assertThrows(
  () =>
    allowSendDraft({
      callbackData: "approval:discard:7",
      actionId: 7,
      actionStatus: "pending",
    }),
  "discard callback must not send",
);
assertThrows(
  () =>
    allowSendDraft({
      callbackData: "approval:send:8",
      actionId: 7,
      actionStatus: "pending",
    }),
  "mismatched action id must not send",
);

assert(
  missingRequiredEnv(["TELEGRAM_BOT_TOKEN", "MISSING_FAKE_VAR"]).includes(
    "MISSING_FAKE_VAR",
  ),
  "env guard reports missing names",
);
assert(parseOwnerTelegramId("0") === undefined, "owner id must be positive");
assert(parseOwnerTelegramId("12") === 12, "owner id parses");
assert(
  redactSecrets("Bearer abc and sk-ant-example and crsr_abc").includes(
    "[redacted]",
  ),
  "secrets are redacted",
);
assert(
  !redactSecrets("sk-ant-example-value").includes("sk-ant-example"),
  "redacted text drops secret payload",
);

const root = process.cwd();
const botSrc = await readFile(join(root, "src/bot.ts"), "utf8");
assert(
  botSrc.includes('from "./security/owner_lock.js"'),
  "bot.ts must import the owner lock",
);
assert(/bot\.use\(\s*ownerOnly\(/.test(botSrc), "bot.ts must install ownerOnly");
assert(
  !botSrc.includes("ctx.from?.id !== config.ownerTelegramId"),
  "owner lock must not live inline in bot.ts",
);

const approvalsSrc = await readFile(join(root, "src/approvals.ts"), "utf8");
assert(
  approvalsSrc.includes('from "./security/send_approval.js"'),
  "approvals.ts must import the send gate",
);
const sendFnStart = approvalsSrc.indexOf("async function sendDraft");
const sendFnEnd = approvalsSrc.indexOf("async function discardDraft");
assert(sendFnStart >= 0 && sendFnEnd > sendFnStart, "sendDraft is present");
const sendFn = approvalsSrc.slice(sendFnStart, sendFnEnd);
assert(sendFn.includes("allowSendDraft"), "sendDraft must call allowSendDraft");
assert(sendFn.includes("drafts.send"), "sendDraft still sends the draft");
assert(
  sendFn.indexOf("allowSendDraft") < sendFn.indexOf("drafts.send"),
  "send gate must run before drafts.send",
);

const configSrc = await readFile(join(root, "src/config.ts"), "utf8");
assert(
  configSrc.includes('from "./security/env_guard.js"'),
  "config.ts must use the env guard",
);

console.log("Security gate checks passed.");
