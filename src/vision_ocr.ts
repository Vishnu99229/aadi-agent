import vision from "@google-cloud/vision";
import { config } from "./config.js";
import { assertTestSeam } from "./test_seam.js";

/** Below this, OCR is treated as empty and the vision-LLM fallback runs. */
export const OCR_MIN_CHARS = 10;

type VisionClient = InstanceType<typeof vision.ImageAnnotatorClient>;

let testExtract: ((imageBuffer: Buffer) => Promise<string>) | undefined;
let client: VisionClient | undefined;

export function setVisionOcrTestHook(
  hook: ((imageBuffer: Buffer) => Promise<string>) | undefined,
): void {
  assertTestSeam("setVisionOcrTestHook");
  testExtract = hook;
}

function visionClient(): VisionClient {
  if (!client) {
    client = new vision.ImageAnnotatorClient({
      apiKey: config.googleVisionApiKey,
      fallback: true,
    });
  }
  return client;
}

export async function extractTextFromImage(
  imageBuffer: Buffer,
): Promise<string> {
  if (testExtract) {
    return testExtract(imageBuffer);
  }
  if (!config.googleVisionApiKey) {
    console.log("Vision OCR skipped: GOOGLE_VISION_API_KEY is empty");
    return "";
  }
  try {
    const [response] = await visionClient().documentTextDetection({
      image: { content: imageBuffer.toString("base64") },
    });
    const text = response.fullTextAnnotation?.text?.trim() ?? "";
    console.log(`Vision OCR: chars=${text.length}`);
    return text;
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Vision OCR failed (${errorType}).`);
    return "";
  }
}
