import { readFile } from "node:fs/promises";
import { getTaskBackend } from "../src/chat_backend.ts";
import { IMAGE_VISION_BACKENDS } from "../src/document_llm.ts";
import { analyzePhotoBytes, IMAGE_READ_ERROR } from "../src/documents.ts";
import { setCompleteForTests, type CompleteParams } from "../src/llm.ts";
import {
  extractTextFromImage,
  OCR_MIN_CHARS,
  setVisionOcrTestHook,
} from "../src/vision_ocr.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const SAMPLE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const samplePng = Buffer.from(SAMPLE_PNG_BASE64, "base64");
const jpegBytes = new Uint8Array([1, 2, 3, 4]);

assert(
  IMAGE_VISION_BACKENDS[0] === "haiku" && IMAGE_VISION_BACKENDS[1] === "gemini",
  "vision-LLM fallback still uses haiku then gemini",
);
assert(
  IMAGE_READ_ERROR === "I couldn't read the text in this image. Please type it out.",
  "photo fallback copy",
);
assert(OCR_MIN_CHARS === 10, "OCR needs more than 10 characters");

{
  let passed: Buffer | undefined;
  setVisionOcrTestHook(async (imageBuffer) => {
    passed = imageBuffer;
    return "Sample OCR line from a photo of an email";
  });
  const text = await extractTextFromImage(samplePng);
  assert(passed?.equals(samplePng) === true, "extractTextFromImage receives the image buffer");
  assert(text === "Sample OCR line from a photo of an email", "mocked OCR text is returned");
}

const calls: CompleteParams[] = [];
setCompleteForTests(async (params: CompleteParams) => {
  calls.push(params);
  const user = params.messages[0];
  if (user?.role === "user" && typeof user.content === "string") {
    return {
      textParts: ["Priya wants the deck tomorrow."],
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 },
      stopReason: "end_turn",
    };
  }
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

{
  calls.length = 0;
  setVisionOcrTestHook(async () => "From Priya: please send the deck tomorrow.");
  const photo = await analyzePhotoBytes(jpegBytes, "image/jpeg");
  assert(photo.source === "ocr", "successful OCR uses the text path");
  assert(calls.length === 1, "chat LLM is called once on OCR success");
  assert(calls[0]!.backend === getTaskBackend("chat"), "OCR reasoning uses the Chat backend");
  const user = calls[0]!.messages[0];
  assert(user?.role === "user" && typeof user.content === "string", "OCR path sends text, not an image");
  assert(
    user.content.includes("Google Cloud Vision OCR"),
    "prompt names Cloud Vision OCR",
  );
  assert(
    user.content.includes("From Priya: please send the deck tomorrow."),
    "prompt includes extracted text",
  );
  const hasImage = calls.some((call) => {
    const message = call.messages[0];
    return (
      message?.role === "user" &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "image")
    );
  });
  assert(!hasImage, "vision-LLM fallback is not called when OCR succeeds");
  assert(photo.reply.includes("Priya wants the deck"), "chat reply is returned");
  assert(
    photo.analysis.extracted_text.includes("please send the deck"),
    "OCR text is stored for read_document",
  );
}

{
  calls.length = 0;
  setVisionOcrTestHook(async () => "");
  const photo = await analyzePhotoBytes(jpegBytes, "image/jpeg");
  assert(photo.source === "vision-llm", "empty OCR falls back to vision LLM");
  const user = calls[0]!.messages[0];
  assert(user?.role === "user" && Array.isArray(user.content), "fallback sends multipart content");
  assert(
    user.content.some((part) => part.type === "image"),
    "fallback sends the original image to a vision LLM",
  );
  assert(photo.analysis.summary_bullets[0] === "Follow up with Priya", "vision-LLM facts parsed");
}

setVisionOcrTestHook(undefined);
setCompleteForTests(undefined);

const ocrSrc = await readFile(new URL("../src/vision_ocr.ts", import.meta.url), "utf8");
assert(ocrSrc.includes("documentTextDetection"), "OCR uses documentTextDetection");
assert(ocrSrc.includes("fullTextAnnotation"), "OCR reads fullTextAnnotation.text");

const docsSrc = await readFile(new URL("../src/documents.ts", import.meta.url), "utf8");
assert(docsSrc.includes("extractTextFromImage"), "photo pipeline calls OCR first");
assert(docsSrc.includes('getTaskBackend("chat")'), "OCR success uses the Chat backend");
assert(docsSrc.includes("falling back to vision LLM"), "empty OCR falls back");

const systemMd = await readFile(new URL("../prompts/system.md", import.meta.url), "utf8");
assert(
  systemMd.includes("NEVER append a sign-off"),
  "drafting prompt forbids a model-written sign-off",
);
assert(systemMd.includes("delete_calendar_event"), "system prompt names the delete tool");

console.log("Image vision checks passed.");
