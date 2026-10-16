import { readFile } from "node:fs/promises";
import { START_GREETING } from "../src/start_greeting.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

assert(START_GREETING === "Hi Vishnu, Aadi here.", "start greeting text");

const botSource = await readFile(new URL("../src/bot.ts", import.meta.url), "utf8");
assert(
  botSource.includes("await ctx.reply(START_GREETING)"),
  "/start replies with START_GREETING",
);
assert(
  !botSource.includes("How can I help?"),
  "old start greeting is gone",
);

console.log("Start greeting checks passed.");
