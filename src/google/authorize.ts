import { access } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { authenticate } from "@google-cloud/local-auth";
import { google } from "googleapis";
import {
  GOOGLE_CREDENTIALS_PATH,
  GOOGLE_SCOPES,
  GOOGLE_TOKEN_PATH,
  GOOGLE_TOKEN_WORK_PATH,
  loadDesktopCredentials,
  saveGoogleTokens,
} from "./auth.js";

const execFileAsync = promisify(execFile);

const WORKSPACE_ADMIN_HELP = `Epicode Workspace admin needs to allow this OAuth app in Google Admin:
1. Security → Access and data control → API controls → Manage third-party app access
2. Add this app as Trusted (or Allowed) for Vishnu's OU. Do not leave it blocked.
3. Grant Gmail (gmail.readonly, gmail.compose) and Calendar (calendar.readonly).
4. If Google says the app is unverified or blocked: allow unverified third-party apps for that OU, or add this OAuth client ID to the allowlist.
5. Confirm users can grant those scopes (App access control / internal apps).
Then run npm run google:auth:work again and pick the Epicode email.`;

function formatOAuthError(error: string, description?: string): string {
  return description ? `${error}: ${description}` : error;
}

function looksLikeWorkspacePolicy(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("admin_policy_enforced") ||
    lower.includes("org_internal") ||
    lower.includes("restricted") ||
    lower.includes("blocked") ||
    lower.includes("unverified") ||
    lower.includes("access_denied") ||
    lower.includes("403") ||
    lower.includes("policy")
  );
}

class WorkspacePolicyError extends Error {
  constructor(detail: string) {
    super(
      `Google blocked the Epicode work login.\nExact error: ${detail}\n\n${WORKSPACE_ADMIN_HELP}`,
    );
    this.name = "WorkspacePolicyError";
  }
}

interface OAuthCallback {
  code?: string;
  error?: string;
  errorDescription?: string;
}

function startLoopbackServer(): Promise<{
  port: number;
  waitForCallback: Promise<OAuthCallback>;
}> {
  return new Promise((resolve, reject) => {
    let settle: ((result: OAuthCallback) => void) | undefined;
    const waitForCallback = new Promise<OAuthCallback>((done) => {
      settle = done;
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("You can close this tab and return to the terminal.");
      server.close();
      settle?.({
        code: url.searchParams.get("code") ?? undefined,
        error: url.searchParams.get("error") ?? undefined,
        errorDescription:
          url.searchParams.get("error_description") ?? undefined,
      });
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ port: address.port, waitForCallback });
    });
  });
}

async function openBrowser(url: string): Promise<void> {
  try {
    await execFileAsync("open", [url]);
  } catch {
    console.log(`Open this URL in your browser:\n${url}`);
  }
}

async function authorizeWork(): Promise<void> {
  const installed = await loadDesktopCredentials();
  const { port, waitForCallback } = await startLoopbackServer();
  const redirectUri = `http://127.0.0.1:${port}`;
  const oauthClient = new google.auth.OAuth2(
    installed.clientId,
    installed.clientSecret,
    redirectUri,
  );
  const authUrl = oauthClient.generateAuthUrl({
    access_type: "offline",
    prompt: "select_account consent",
    scope: [...GOOGLE_SCOPES],
  });

  console.log("Browser step: a Google sign-in window will open now.");
  console.log(
    "You MUST pick your Epicode work email, not personal Gmail.",
  );
  console.log(`If the window does not open, visit:\n${authUrl}`);

  await openBrowser(authUrl);
  const result = await waitForCallback;

  if (result.error || !result.code) {
    const detail = formatOAuthError(
      result.error ?? "missing_code",
      result.errorDescription,
    );
    if (looksLikeWorkspacePolicy(detail)) {
      throw new WorkspacePolicyError(detail);
    }
    throw new Error(`Google authorization failed. Exact error: ${detail}`);
  }

  try {
    const { tokens } = await oauthClient.getToken(result.code);
    await saveGoogleTokens(tokens, GOOGLE_TOKEN_WORK_PATH);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (looksLikeWorkspacePolicy(detail)) {
      throw new WorkspacePolicyError(detail);
    }
    throw error;
  }

  console.log(
    "Google work authorization complete. Saved google-token-work.json.",
  );
}

async function authorizePersonal(): Promise<void> {
  const client = await authenticate({
    keyfilePath: GOOGLE_CREDENTIALS_PATH,
    scopes: [...GOOGLE_SCOPES],
  });

  await saveGoogleTokens(client.credentials, GOOGLE_TOKEN_PATH);
  console.log("Google authorization complete. Saved google-token.json.");
}

async function main(): Promise<void> {
  try {
    await access(GOOGLE_CREDENTIALS_PATH);
  } catch {
    throw new Error(
      "google-credentials.json was not found in the project root. Download an OAuth Desktop client file from Google Cloud first.",
    );
  }

  if (process.argv.includes("--work")) {
    await authorizeWork();
    return;
  }
  await authorizePersonal();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
