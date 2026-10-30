// Live eval: real background model, no Telegram. Prints the chosen emoji.
// Usage: npm run eval:reactions
import "dotenv/config";
import { config } from "../src/config.ts";
import { pickContextualEmoji } from "../src/contextual_react.ts";

const samples = [
  "I just closed Eternal!",
  "Can you believe Pinnacle doubled the order?",
  "should I take the Aspirare deal or wait?",
  "my grandmother is unwell",
  "lol that was funny",
  "ok",
  "create a meeting with Nitish tomorrow 4pm",
  "you wanna hear something fascinating",
];

console.log(
  `reaction picker live eval model=${config.deepseekApiKey ? config.deepseekModel : config.backgroundModel}`,
);

for (const text of samples) {
  const picked = await pickContextualEmoji(text);
  const emoji = picked.emoji ?? "null";
  console.log(`${JSON.stringify(text)} → ${emoji} (${picked.confidence.toFixed(2)})`);
}
