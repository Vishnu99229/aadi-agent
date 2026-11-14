import type { ContextRef } from "./types.js";

/**
 * A pointer to something Aadi holds, passed between agents instead of the thing
 * itself: `email:work:18c92…` rather than a 50-message thread.
 *
 *   email:<account>:<message-id>        read with read_email
 *   calendar:<account>:<event-id>@<date> read with list_events on that date
 *   account:<name>                       read with account_status
 *   document:<id>                        read with read_document
 *   memory:<query>                       read with search_memories
 *   draft:<draft-id>                     read with read_draft
 *   build:<id>                           read with get_build
 *   contact:<name>                       read with resolve_contact
 *   artifact:<task-id>/<artifact-id>     an artifact of an earlier task in the workflow
 *   cache:<cache-key>                    an entry in the shared result cache
 *
 * A reference grants nothing. An agent can only open it with the tool named
 * here, and only if that tool is one the agent may call: the dispatcher's
 * allowlist and authorization checks run exactly as for any other call.
 */
export const RESOURCE_KINDS = [
  "email",
  "calendar",
  "account",
  "document",
  "memory",
  "draft",
  "build",
  "contact",
  "artifact",
  "cache",
] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** The string form: kind:[account:]id[@hint]. */
export type ResourceRef = string;

export interface ParsedRef {
  kind: ResourceKind;
  account?: string;
  id: string;
  /** Extra locator, e.g. an event's date. */
  hint?: string;
}

const ACCOUNT_KINDS: ReadonlySet<ResourceKind> = new Set(["email", "calendar"]);

export function isResourceKind(value: string): value is ResourceKind {
  return (RESOURCE_KINDS as readonly string[]).includes(value);
}

export function makeRef(kind: ResourceKind, id: string | number, options: { account?: string; hint?: string } = {}): ResourceRef {
  const safeId = encodeURIComponent(String(id));
  const account = ACCOUNT_KINDS.has(kind) ? `${options.account ?? "work"}:` : "";
  return `${kind}:${account}${safeId}${options.hint ? `@${encodeURIComponent(options.hint)}` : ""}`;
}

export function parseRef(ref: string): ParsedRef | undefined {
  const match = /^([a-z]+):(.+)$/.exec(ref.trim());
  if (!match || !isResourceKind(match[1]!)) {
    return undefined;
  }
  const kind = match[1] as ResourceKind;
  let rest = match[2]!;
  let hint: string | undefined;
  const at = rest.lastIndexOf("@");
  if (at > 0) {
    hint = decodeURIComponent(rest.slice(at + 1));
    rest = rest.slice(0, at);
  }
  let account: string | undefined;
  if (ACCOUNT_KINDS.has(kind)) {
    const colon = rest.indexOf(":");
    if (colon <= 0) {
      return undefined;
    }
    account = rest.slice(0, colon);
    rest = rest.slice(colon + 1);
  }
  const id = decodeURIComponent(rest);
  return id ? { kind, account, id, ...(hint ? { hint } : {}) } : undefined;
}

/** The tool that opens a reference and the input it takes, or undefined for Aadi's own records. */
export function readerFor(ref: ParsedRef): { tool: string; input: Record<string, unknown> } | undefined {
  switch (ref.kind) {
    case "email":
      return { tool: "read_email", input: { id: ref.id, account: ref.account } };
    case "calendar":
      return ref.hint ? { tool: "list_events", input: { start_date: ref.hint, end_date: ref.hint, account: ref.account } } : undefined;
    case "account":
      return { tool: "account_status", input: { name: ref.id } };
    case "document":
      return /^\d+$/.test(ref.id) ? { tool: "read_document", input: { id: Number(ref.id) } } : undefined;
    case "memory":
      return { tool: "search_memories", input: { query: ref.id } };
    case "draft":
      return { tool: "read_draft", input: { draft_id: ref.id } };
    case "build":
      return /^\d+$/.test(ref.id) ? { tool: "get_build", input: { build_id: Number(ref.id) } } : undefined;
    case "contact":
      return { tool: "resolve_contact", input: { name: ref.id } };
    default:
      return undefined;
  }
}

/**
 * Whether an agent with these tools could open the reference. Artifacts and
 * cache entries are opened through the workflow and the cache, which check the
 * caller's permission for the tool that produced them.
 */
export function canOpen(ref: ParsedRef, allowedTools: ReadonlySet<string>): boolean {
  const reader = readerFor(ref);
  return reader ? allowedTools.has(reader.tool) : ref.kind === "artifact" || ref.kind === "cache";
}

/** The existing ContextRef shape, as a reference string. */
export function fromContextRef(ref: ContextRef): ResourceRef | undefined {
  switch (ref.kind) {
    case "email_message":
    case "email_thread":
      return makeRef("email", ref.id);
    case "calendar_event":
      return makeRef("calendar", ref.id);
    case "document":
      return makeRef("document", ref.id);
    case "account":
      return makeRef("account", ref.id);
    case "draft":
      return makeRef("draft", ref.id);
    case "build":
      return makeRef("build", ref.id);
    case "task_result":
      return makeRef("artifact", ref.id);
    default:
      return undefined;
  }
}

const EMAIL_ID = /\b(?:id|message[_ ]id)["':\s]+([0-9a-f]{12,20})\b/gi;
const ACCOUNT_TAG = /\[(work|personal)\]/i;
const DOCUMENT_ID = /\bdocument(?:[_ ]id)?["':\s#]+(\d{1,9})\b/gi;
const BUILD_ID = /\bbuild(?:[_ ]id)?["':\s#]+(\d{1,9})\b/gi;
const DRAFT_ID = /\bdraft[_ ]id["':\s]+([A-Za-z0-9_-]{6,40})\b/gi;

/**
 * Pulls references out of a tool result or an earlier step's text, with plain
 * pattern matching (no model call). Used to pass pointers forward instead of
 * the content.
 */
export function extractRefs(text: string, limit = 12): ResourceRef[] {
  const out = new Set<ResourceRef>();
  const account = ACCOUNT_TAG.exec(text)?.[1]?.toLowerCase() ?? "work";
  for (const match of text.matchAll(EMAIL_ID)) {
    out.add(makeRef("email", match[1]!, { account }));
  }
  for (const match of text.matchAll(DOCUMENT_ID)) {
    out.add(makeRef("document", match[1]!));
  }
  for (const match of text.matchAll(BUILD_ID)) {
    out.add(makeRef("build", match[1]!));
  }
  for (const match of text.matchAll(DRAFT_ID)) {
    out.add(makeRef("draft", match[1]!));
  }
  return [...out].slice(0, limit);
}

/** How a reference is shown to an agent: what it is and, if allowed, how to open it. */
export function describeRef(ref: ResourceRef, allowedTools: ReadonlySet<string>): string {
  const parsed = parseRef(ref);
  if (!parsed) {
    return `${ref} (unrecognised)`;
  }
  const reader = readerFor(parsed);
  if (!reader) {
    return parsed.kind === "artifact" || parsed.kind === "cache" ? `${ref} (given below if needed)` : `${ref}`;
  }
  return allowedTools.has(reader.tool)
    ? `${ref} (open with ${reader.tool} ${JSON.stringify(reader.input)} if you need its content)`
    : `${ref} (not yours to open)`;
}
