import { readFile } from "node:fs/promises";
import { tools, TOOL_ORDER } from "../src/tools/index.ts";

const system = (await readFile(new URL("../prompts/system.md", import.meta.url), "utf8")).trim();
const defs = TOOL_ORDER.map((name) => tools[name]!.definition);
const payload = JSON.stringify({ system, tools: defs });
const toolDescChars = defs.reduce((sum, tool) => sum + tool.description.length, 0);
console.log(
  JSON.stringify(
    {
      systemChars: system.length,
      toolCount: defs.length,
      toolDescChars,
      payloadChars: payload.length,
      estTokens: Math.round(payload.length / 4),
    },
    null,
    2,
  ),
);
