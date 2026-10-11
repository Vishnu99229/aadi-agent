import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { google, type Auth } from "googleapis";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
] as const;

export const GOOGLE_CREDENTIALS_PATH = fileURLToPath(
  new URL("../../google-credentials.json", import.meta.url),
);

export const GOOGLE_TOKEN_PATH = fileURLToPath(
  new URL("../../google-token.json", import.meta.url),
);

interface DesktopCredentials {
  installed?: {
    client_id?: string;
    client_secret?: string;
    redirect_uris?: string[];
  };
}

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function saveGoogleTokens(
  tokens: Auth.Credentials,
): Promise<void> {
  let existing: Auth.Credentials = {};

  try {
    existing = await readJsonFile<Auth.Credentials>(GOOGLE_TOKEN_PATH);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const merged: Auth.Credentials = {
    ...existing,
    ...tokens,
    refresh_token: tokens.refresh_token ?? existing.refresh_token,
  };

  await writeFile(GOOGLE_TOKEN_PATH, `${JSON.stringify(merged, null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function getGoogleClient(): Promise<Auth.OAuth2Client> {
  let savedTokens: Auth.Credentials;
  try {
    savedTokens = await readJsonFile<Auth.Credentials>(GOOGLE_TOKEN_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "Google authorization is missing. Run npm run google:auth first.",
      );
    }
    throw error;
  }

  let credentials: DesktopCredentials;

  try {
    credentials = await readJsonFile<DesktopCredentials>(
      GOOGLE_CREDENTIALS_PATH,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "google-credentials.json was not found in the project root.",
      );
    }
    throw error;
  }

  const installed = credentials.installed;
  if (!installed?.client_id || !installed.client_secret) {
    throw new Error(
      "google-credentials.json must contain an OAuth Desktop client.",
    );
  }

  const client = new google.auth.OAuth2(
    installed.client_id,
    installed.client_secret,
    installed.redirect_uris?.[0],
  );

  let pendingTokenWrite = Promise.resolve();
  client.on("tokens", (tokens) => {
    pendingTokenWrite = pendingTokenWrite
      .then(() => saveGoogleTokens(tokens))
      .catch((error: unknown) => {
        console.error("Failed to save refreshed Google tokens:", error);
      });
  });

  client.setCredentials(savedTokens);
  return client;
}
