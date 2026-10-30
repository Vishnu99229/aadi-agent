// Live model ping: one cheap chat turn, no Telegram send, no secrets in output.
import "dotenv/config";
import { runAgent } from "../src/agent.ts";

const started = Date.now();
const reply = await runAgent("Reply with the single word hello.", {
  skipHistory: true,
  saveUserMessage: false,
  saveAssistantMessage: false,
  backend: "deepseek",
});
const ms = Date.now() - started;
const blocked = reply.startsWith("I couldn't do that:");
console.log(
  `live agent ping duration_ms=${ms} chars=${reply.length} empty=${reply.trim().length === 0} receipt_blocked=${blocked}`,
);
if (!reply.trim()) {
  process.exit(1);
}
