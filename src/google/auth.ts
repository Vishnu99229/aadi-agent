import { access, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { google, type Auth } from "googleapis";

export type GoogleAccountId = "personal" | "work";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
] as const;

/** Work account only. calendar.events is the narrowest scope that can insert/patch/delete events. Keep calendar.readonly so freebusy.query still works (that method does not list calendar.events). */
export const WORK_GOOGLE_SCOPES = [
  ...GOOGLE_SCOPES,
  "https://www.googleapis.com/auth/calendar.events",
] as const;

export const GOOGLE_CREDENTIALS_PATH = fileURLToPath(
  new URL("../../google-credentials.json", import.meta.url),
);

export const GOOGLE_TOKEN_PATH = fileURLToPath(
  new URL("../../google-token.json", import.meta.url),
);

export const GOOGLE_TOKEN_WORK_PATH = fileURLToPath(
  new URL("../../google-token-work.json", import.meta.url),
);

export interface GoogleAccountConfig {
  id: GoogleAccountId;
  tag: "work" | "personal";
  label: string;
  tokenPath: string;
  tokenFile: string;
}

export const GOOGLE_ACCOUNT_CONFIGS: GoogleAccountConfig[] = [
  {
    id: "personal",
    tag: "personal",
    label: "personal (Gmail)",
    tokenPath: GOOGLE_TOKEN_PATH,
    tokenFile: "google-token.json",
  },
  {
    id: "work",
    tag: "work",
    label: "work (Epicode)",
    tokenPath: GOOGLE_TOKEN_WORK_PATH,
    tokenFile: "google-token-work.json",
  },
];

export interface LoadedGoogleAccount extends GoogleAccountConfig {
  client: Auth.OAuth2Client;
}

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

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function loadDesktopCredentials(): Promise<{
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
}> {
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

  return {
    clientId: installed.client_id,
    clientSecret: installed.client_secret,
    redirectUri: installed.redirect_uris?.[0],
  };
}

export async function saveGoogleTokens(
  tokens: Auth.Credentials,
  tokenPath: string = GOOGLE_TOKEN_PATH,
): Promise<void> {
  let existing: Auth.Credentials = {};

  try {
    existing = await readJsonFile<Auth.Credentials>(tokenPath);
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

  await writeFile(tokenPath, `${JSON.stringify(merged, null, 2)}\n`, {
    mode: 0o600,
  });
}

function attachTokenSaver(
  client: Auth.OAuth2Client,
  tokenPath: string,
): Auth.OAuth2Client {
  let pendingTokenWrite = Promise.resolve();
  client.on("tokens", (tokens) => {
    pendingTokenWrite = pendingTokenWrite
      .then(() => saveGoogleTokens(tokens, tokenPath))
      .catch((error: unknown) => {
        console.error("Failed to save refreshed Google tokens:", error);
      });
  });
  return client;
}

export async function createGoogleClient(
  tokenPath: string,
  savedTokens: Auth.Credentials,
): Promise<Auth.OAuth2Client> {
  const installed = await loadDesktopCredentials();
  const client = new google.auth.OAuth2(
    installed.clientId,
    installed.clientSecret,
    installed.redirectUri,
  );
  attachTokenSaver(client, tokenPath);
  client.setCredentials(savedTokens);
  return client;
}

async function loadClientFromTokenFile(
  tokenPath: string,
): Promise<Auth.OAuth2Client> {
  let savedTokens: Auth.Credentials;
  try {
    savedTokens = await readJsonFile<Auth.Credentials>(tokenPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "Google authorization is missing. Run npm run google:auth first.",
      );
    }
    throw error;
  }
  return createGoogleClient(tokenPath, savedTokens);
}

let loadedAccountsPromise: Promise<LoadedGoogleAccount[]> | null = null;

async function loadGoogleAccountsUncached(): Promise<LoadedGoogleAccount[]> {
  const loaded: LoadedGoogleAccount[] = [];

  for (const config of GOOGLE_ACCOUNT_CONFIGS) {
    if (!(await fileExists(config.tokenPath))) {
      if (config.id === "work") {
        console.log(
          "Google work account skipped: google-token-work.json not found.",
        );
      }
      continue;
    }

    const client = await loadClientFromTokenFile(config.tokenPath);
    loaded.push({ ...config, client });
    console.log(`Google account loaded: ${config.label}`);
  }

  return loaded;
}

export async function loadGoogleAccounts(): Promise<LoadedGoogleAccount[]> {
  if (!loadedAccountsPromise) {
    loadedAccountsPromise = loadGoogleAccountsUncached();
  }
  return loadedAccountsPromise;
}

export async function logGoogleAccounts(): Promise<void> {
  await loadGoogleAccounts();
}

export async function getGoogleClient(): Promise<Auth.OAuth2Client> {
  return getGoogleClientFor("personal");
}

export async function getGoogleClientFor(
  accountId: GoogleAccountId,
): Promise<Auth.OAuth2Client> {
  const account = (await loadGoogleAccounts()).find(
    (item) => item.id === accountId,
  );
  if (account) {
    return account.client;
  }
  if (accountId === "work") {
    throw new Error(
      "Google work account is not connected. Run npm run google:auth:work.",
    );
  }
  throw new Error(
    "Google authorization is missing. Run npm run google:auth first.",
  );
}

export async function getGoogleAccount(
  accountId: GoogleAccountId,
): Promise<LoadedGoogleAccount> {
  const account = (await loadGoogleAccounts()).find(
    (item) => item.id === accountId,
  );
  if (account) {
    return account;
  }
  if (accountId === "work") {
    throw new Error(
      "Google work account is not connected. Run npm run google:auth:work.",
    );
  }
  throw new Error(
    "Google authorization is missing. Run npm run google:auth first.",
  );
}

export function parseGoogleAccountFilter(
  value: unknown,
): GoogleAccountId | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === "personal" || value === "work") {
    return value;
  }
  throw new Error('account must be either "personal" or "work".');
}

export async function accountsForFilter(
  filter: GoogleAccountId | undefined,
): Promise<LoadedGoogleAccount[]> {
  const loaded = await loadGoogleAccounts();
  if (!filter) {
    return loaded;
  }
  const match = loaded.find((account) => account.id === filter);
  if (!match) {
    if (filter === "work") {
      throw new Error(
        "Google work account is not connected. Run npm run google:auth:work.",
      );
    }
    throw new Error(
      "Google authorization is missing. Run npm run google:auth first.",
    );
  }
  return [match];
}

export function isGoogleNotFound(error: unknown): boolean {
  const err = error as { code?: number | string; status?: number };
  return err.code === 404 || err.status === 404;
}
