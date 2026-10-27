import { readFile } from "node:fs/promises";
import { analyzeImage, IMAGE_VISION_BACKENDS } from "../src/document_llm.ts";
import { IMAGE_READ_ERROR } from "../src/documents.ts";
import { setCompleteForTests } from "../src/llm.ts";
import type { CompleteParams } from "../src/llm.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

assert(
  IMAGE_VISION_BACKENDS[0] === "haiku" && IMAGE_VISION_BACKENDS[1] === "gemini",
  "image OCR uses haiku then gemini",
);
assert(!IMAGE_VISION_BACKENDS.includes("deepseek"), "DeepSeek is not a vision backend");
assert(
  IMAGE_READ_ERROR === "I couldn't read the text in this image. Please type it out.",
  "photo fallback copy",
);

const backends: Array<string | undefined> = [];
setCompleteForTests(async (params: CompleteParams) => {
  backends.push(params.backend);
  const user = params.messages[0];
  assert(user?.role === "user", "vision call is a user message");
  assert(Array.isArray(user.content), "vision payload is multipart");
  const image = user.content.find((part) => part.type === "image");
  assert(image?.type === "image" && image.data.length > 0, "image is base64");
  assert(image.mediaType === "image/jpeg", "jpeg media type");
  return {
    textParts: [
      JSON.stringify({
        tag: "work",
        document_type: "email screenshot",
        summary_bullets: ["Follow up with Priya"],
        dates: [],
        money: [],
        risks: [],
        action_items: [],
      }),
    ],
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 },
    stopReason: "end_turn",
  };
});

const analysis = await analyzeImage(new Uint8Array([1, 2, 3, 4]), "image/jpeg");
assert(backends[0] === "haiku", "first vision attempt is haiku, not Chat");
assert(!backends.includes("deepseek"), "chat DeepSeek is never used for photos");
assert(analysis.summary_bullets[0] === "Follow up with Priya", "structured facts parsed");
setCompleteForTests(undefined);

const llmSrc = await readFile(new URL("../src/document_llm.ts", import.meta.url), "utf8");
const analyzeStart = llmSrc.indexOf("export async function analyzeImage");
const analyzeEnd = llmSrc.indexOf("export async function analyzeText");
const analyzeFn = llmSrc.slice(analyzeStart, analyzeEnd);
assert(analyzeFn.includes("IMAGE_VISION_BACKENDS"), "analyzeImage loops vision backends");
assert(!analyzeFn.includes("getTaskBackend"), "analyzeImage ignores the Chat picker");
assert(analyzeFn.includes("type: \"image\""), "sends an image content part");

const systemMd = await readFile(new URL("../prompts/system.md", import.meta.url), "utf8");
assert(
  systemMd.includes("NEVER append a sign-off"),
  "drafting prompt forbids a model-written sign-off",
);
assert(systemMd.includes("delete_calendar_event"), "system prompt names the delete tool");

console.log("Image vision checks passed.");
