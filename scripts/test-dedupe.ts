import { claimTelegramMessage, pruneProcessedMessages } from "../src/db.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function testFirstClaimSucceedsSecondFails(): void {
  const chatId = 111;
  const messageId = 42;
  assert(
    claimTelegramMessage(chatId, messageId) === true,
    "first claim should succeed",
  );
  assert(
    claimTelegramMessage(chatId, messageId) === false,
    "second claim with same id should be rejected",
  );
}

function testDifferentIdsAreIndependent(): void {
  const chatId = 111;
  assert(
    claimTelegramMessage(chatId, 100) === true,
    "new message_id should claim",
  );
  assert(
    claimTelegramMessage(chatId, 101) === true,
    "another new message_id should claim",
  );
  assert(
    claimTelegramMessage(chatId, 100) === false,
    "re-claim of 100 should fail",
  );
}

function testDifferentChatsAreIndependent(): void {
  assert(
    claimTelegramMessage(222, 7) === true,
    "chat 222 msg 7 should claim",
  );
  assert(
    claimTelegramMessage(333, 7) === true,
    "chat 333 msg 7 should also claim (different chat)",
  );
}

function testPruneRunsWithoutError(): void {
  const removed = pruneProcessedMessages();
  assert(removed >= 0, "prune should return a non-negative count");
}

function main(): void {
  testFirstClaimSucceedsSecondFails();
  testDifferentIdsAreIndependent();
  testDifferentChatsAreIndependent();
  testPruneRunsWithoutError();
  console.log("Telegram message dedupe checks passed.");
}

main();
