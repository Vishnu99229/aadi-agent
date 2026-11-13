import { randomUUID } from "node:crypto";
import type { SendConfirmation } from "../approvals.js";
import { FORWARDED_TOOLS } from "../tools/index.js";
import type { CapabilityEffect } from "./types.js";

/**
 * Aadi is the only authority on what a task may do. It issues a grant for each
 * turn and passes agents the grant's ref. The grant itself stays in this
 * process's memory: it is never written to SQLite and never sent to a remote
 * agent, so a restart or a replayed message can't bring Vishnu's approval back.
 */
export type AuthSource =
  /** Vishnu's own typed or spoken message. */
  | "owner_chat"
  /** Something he forwarded or pasted: content, not an instruction. */
  | "forwarded"
  /** Aadi's own scheduled work. */
  | "background"
  /** A request that arrived from another agent over A2A. */
  | "remote_agent";

export interface AuthGrant {
  ref: string;
  source: AuthSource;
  /** Present only for owner_chat: the message that is the approval. */
  confirmation?: SendConfirmation;
  /** Vishnu's own words for the turn, which the send and booking gates read. */
  ownerText?: string;
  /** Lets react_to_message reach the message. */
  ctx?: { react: (emoji: string) => Promise<unknown> };
  expiresAt: number;
}

const GRANT_TTL_MS = 10 * 60 * 1000;
const grants = new Map<string, AuthGrant>();
const forwardedTools: ReadonlySet<string> = new Set(FORWARDED_TOOLS);

function sweep(now: number): void {
  for (const [ref, grant] of grants) {
    if (grant.expiresAt <= now) {
      grants.delete(ref);
    }
  }
}

export function issueGrant(input: {
  source: AuthSource;
  confirmation?: SendConfirmation;
  ownerText?: string;
  ctx?: AuthGrant["ctx"];
  ttlMs?: number;
}): AuthGrant {
  const now = Date.now();
  sweep(now);
  const grant: AuthGrant = {
    ref: `auth_${randomUUID()}`,
    source: input.source,
    // A confirmation only ever rides on his own message.
    confirmation: input.source === "owner_chat" ? input.confirmation : undefined,
    ownerText: input.ownerText,
    ctx: input.source === "owner_chat" ? input.ctx : undefined,
    expiresAt: now + (input.ttlMs ?? GRANT_TTL_MS),
  };
  grants.set(grant.ref, grant);
  return grant;
}

export function resolveGrant(ref: string | undefined): AuthGrant | undefined {
  if (!ref) {
    return undefined;
  }
  const grant = grants.get(ref);
  if (!grant) {
    return undefined;
  }
  if (grant.expiresAt <= Date.now()) {
    grants.delete(ref);
    return undefined;
  }
  return grant;
}

export function revokeGrant(ref: string | undefined): void {
  if (ref) {
    grants.delete(ref);
  }
}

export interface AuthDecision {
  ok: boolean;
  reason?: string;
}

/**
 * The delegation layer's own check, on top of the gates each tool already has.
 * With no grant (after a restart, or a task nobody approved) nothing may leave
 * Aadi: only reads, drafts and Aadi's own records.
 */
export function authorize(
  grant: AuthGrant | undefined,
  capability: { effect: CapabilityEffect; tool?: string; remoteExposed?: boolean },
): AuthDecision {
  const source: AuthSource = grant?.source ?? "background";
  if (source === "owner_chat") {
    return { ok: true };
  }
  if (source === "forwarded") {
    const allowed = capability.tool
      ? forwardedTools.has(capability.tool)
      : capability.effect === "read" || capability.effect === "draft";
    return allowed
      ? { ok: true }
      : { ok: false, reason: "A forwarded message can only read and draft." };
  }
  if (source === "remote_agent") {
    return capability.remoteExposed === true && capability.effect === "read"
      ? { ok: true }
      : { ok: false, reason: "This capability isn't open to other agents." };
  }
  return capability.effect === "external"
    ? { ok: false, reason: "This needs Vishnu's own message or tap." }
    : { ok: true };
}

export function grantCountForTests(): number {
  return grants.size;
}
