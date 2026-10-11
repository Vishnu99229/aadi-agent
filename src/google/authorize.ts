import { access } from "node:fs/promises";
import { authenticate } from "@google-cloud/local-auth";
import {
  GOOGLE_CREDENTIALS_PATH,
  GOOGLE_SCOPES,
  saveGoogleTokens,
} from "./auth.js";

async function main(): Promise<void> {
  try {
    await access(GOOGLE_CREDENTIALS_PATH);
  } catch {
    throw new Error(
      "google-credentials.json was not found in the project root. Download an OAuth Desktop client file from Google Cloud first.",
    );
  }

  const client = await authenticate({
    keyfilePath: GOOGLE_CREDENTIALS_PATH,
    scopes: [...GOOGLE_SCOPES],
  });

  await saveGoogleTokens(client.credentials);
  console.log("Google authorization complete. Saved google-token.json.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
