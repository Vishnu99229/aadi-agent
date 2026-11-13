/**
 * A release question through the real chat model, the real web search
 * providers and the real GitHub API, routed the way a Telegram turn is.
 *
 * Nothing reaches Telegram, Gmail or Calendar (the Google clients are stubs
 * that throw), the database is in memory, and the turn carries no send
 * confirmation, so nothing can be sent or booked. Only lookups are real.
 *
 *   npm run live:latest-release
 *   npm run live:latest-release -- "What's the latest version of Kubernetes?"
 */
import { newRunReport } from "../src/agent.ts";
import { runOwnerTurn, type Route } from "../src/agents/orchestrator.ts";
import { setGoogleAccountForTests } from "../src/google/auth.ts";
import { setGmailClientForTests } from "../src/google/mail.ts";

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("live-latest-release.ts must run with AADI_DB_PATH=:memory:");
}

setGoogleAccountForTests(() => undefined);
setGmailClientForTests(() => {
  throw new Error("Gmail is not reachable from this check.");
});

const question = process.argv.slice(2).join(" ").trim() || "Search the web for the latest A2A protocol release";

const route: { value?: Route; report?: ReturnType<typeof newRunReport> } = {};
const reply = await runOwnerTurn(question, {
  ownerText: question,
  guardText: question,
  saveUserMessage: false,
  saveAssistantMessage: false,
  skipHistory: true,
  route,
});

const picked = route.value;
console.log("\n=== question ===");
console.log(question);
console.log("\n=== route ===");
console.log(picked?.kind === "specialist" ? `${picked.agentId} agent` : `aadi (${picked?.kind === "aadi" ? picked.reason : "direct"})`);
console.log("\n=== tools called ===");
console.log(
  (route.report?.tools ?? []).map((entry) => `${entry.owner}.${entry.tool}${entry.ok ? "" : " (failed)"}`).join(", ") || "none",
);
console.log("\n=== reply ===");
console.log(reply);
process.exit(0);
