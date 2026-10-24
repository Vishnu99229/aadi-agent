import type { gmail_v1 } from "googleapis";

/** Jamie Zawinski's email-threading algorithm, condensed and typed.
 *  http://www.jwz.org/doc/threading.html
 *
 *  We use it for ONE narrow job: given a messy set of messages from a
 *  Gmail thread, find the true root (what the chain started with) and
 *  the true latest leaf (what the chain ends with), including when a
 *  client stripped In-Reply-To / References headers so Gmail couldn't
 *  group correctly.
 *
 *  There is no reliable npm JWZ package - the one named "jwz" on npm is
 *  an unrelated utility wrapper. We hand-roll instead. */

export interface ThreadMessage {
  id: string;                        // Gmail internal id
  messageId: string | null;          // RFC "Message-ID"
  inReplyTo: string | null;          // RFC "In-Reply-To"
  references: string[];              // RFC "References"
  subject: string;
  date: number;                      // Gmail internalDate (epoch ms)
  raw: gmail_v1.Schema$Message;
}

export interface ThreadNode {
  message: ThreadMessage | null;     // null for a "ghost" node (referenced but not present)
  parent: ThreadNode | null;
  children: ThreadNode[];
}

export interface ThreadTree {
  /** The forest of root nodes after merging and pruning. Each root is a
   *  distinct thread. For a single Gmail thread_id you'll usually get one. */
  roots: ThreadNode[];
  /** Fast lookup from Message-ID to its node (useful for recipients etc.). */
  byMessageId: Map<string, ThreadNode>;
}

function headerValue(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  return (
    headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())
      ?.value ?? ""
  );
}

/** Parse an RFC-5322 Message-ID list ("References" header or free-form
 *  text) into an ordered, de-duped array of bare ids (no angle brackets). */
export function parseIdList(value: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const matches = value.match(/<[^<>]+>/g) ?? [];
  for (const match of matches) {
    const id = match.slice(1, -1).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function singleId(value: string): string | null {
  const list = parseIdList(value);
  return list[0] ?? null;
}

/** Strip "Re:", "Fwd:", "Fw:" prefixes (ANY number, locale-insensitive) and
 *  normalise whitespace. Used for the JWZ "same-subject merge" pass. */
export function normaliseSubject(subject: string): string {
  let s = subject.trim();
  const prefix = /^\s*(?:re|fwd?|fw)\s*:\s*/i;
  while (prefix.test(s)) {
    s = s.replace(prefix, "");
  }
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export function toThreadMessage(
  message: gmail_v1.Schema$Message,
): ThreadMessage | null {
  const id = message.id;
  if (!id) return null;
  const headers = message.payload?.headers;
  const messageId = singleId(headerValue(headers, "Message-ID"));
  const inReplyTo = singleId(headerValue(headers, "In-Reply-To"));
  const references = parseIdList(headerValue(headers, "References"));
  const date = Number(message.internalDate);
  return {
    id,
    messageId,
    inReplyTo,
    references,
    subject: headerValue(headers, "Subject").trim(),
    date: Number.isFinite(date) ? date : 0,
    raw: message,
  };
}

/** Walk up ancestors to detect a would-be cycle before linking. */
function wouldLoop(node: ThreadNode, candidateChild: ThreadNode): boolean {
  if (node === candidateChild) return true;
  let cursor: ThreadNode | null = node;
  while (cursor) {
    if (cursor === candidateChild) return true;
    cursor = cursor.parent;
  }
  return false;
}

function link(parent: ThreadNode, child: ThreadNode): void {
  if (child.parent === parent) return;
  if (wouldLoop(parent, child)) return;
  if (child.parent) {
    child.parent.children = child.parent.children.filter((c) => c !== child);
  }
  child.parent = parent;
  parent.children.push(child);
}

/** Build the full JWZ thread tree for a set of messages. */
export function buildThreadTree(messages: gmail_v1.Schema$Message[]): ThreadTree {
  const nodes = new Map<string, ThreadNode>();
  const byMessageId = new Map<string, ThreadNode>();
  const materialNodes: ThreadNode[] = [];

  const ensure = (messageId: string): ThreadNode => {
    let node = nodes.get(messageId);
    if (!node) {
      node = { message: null, parent: null, children: [] };
      nodes.set(messageId, node);
    }
    return node;
  };

  // Pass 1: Create a node for every message. For messages that reference
  // others, create ghost nodes keyed by the referenced Message-ID.
  const material: ThreadMessage[] = [];
  for (const raw of messages) {
    const message = toThreadMessage(raw);
    if (!message) continue;
    material.push(message);
    const key = message.messageId ?? `gmail-id:${message.id}`;
    const node = ensure(key);
    node.message = message;
    materialNodes.push(node);
    if (message.messageId) byMessageId.set(message.messageId, node);
  }

  // Pass 2: Chain each message's References (then In-Reply-To as a tail).
  for (const message of material) {
    const key = message.messageId ?? `gmail-id:${message.id}`;
    const node = ensure(key);
    const chain = [...message.references];
    if (message.inReplyTo && !chain.includes(message.inReplyTo)) {
      chain.push(message.inReplyTo);
    }
    // Chain is parent-to-child (RFC 5322 References is oldest-first).
    for (let i = 0; i < chain.length - 1; i += 1) {
      const parent = ensure(chain[i]);
      const child = ensure(chain[i + 1]);
      link(parent, child);
    }
    const lastReferenced = chain[chain.length - 1];
    if (lastReferenced) {
      link(ensure(lastReferenced), node);
    }
  }

  // Pass 3: Collect roots and prune ghost roots that have no material
  // descendants (nothing to show).
  const allRoots = new Set<ThreadNode>();
  for (const node of nodes.values()) {
    let cursor = node;
    while (cursor.parent) cursor = cursor.parent;
    allRoots.add(cursor);
  }
  const hasMaterial = (node: ThreadNode): boolean => {
    if (node.message) return true;
    return node.children.some(hasMaterial);
  };
  const roots: ThreadNode[] = [];
  for (const root of allRoots) {
    if (hasMaterial(root)) roots.push(root);
  }

  // Pass 4: Fallback subject-merge. For messages with no References AND
  // no In-Reply-To (headers stripped), group by normalised subject with
  // the EARLIEST message of that subject becoming the parent.
  const bySubject = new Map<string, ThreadNode[]>();
  for (const node of materialNodes) {
    if (!node.message) continue;
    const stripped = normaliseSubject(node.message.subject);
    if (!stripped) continue;
    const list = bySubject.get(stripped) ?? [];
    list.push(node);
    bySubject.set(stripped, list);
  }
  for (const [, group] of bySubject) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(
      (a, b) => (a.message!.date) - (b.message!.date),
    );
    const earliest = sorted[0]!;
    for (let i = 1; i < sorted.length; i += 1) {
      const node = sorted[i]!;
      const hasHeaders =
        node.message!.inReplyTo !== null ||
        node.message!.references.length > 0;
      if (hasHeaders) continue;             // JWZ real-chain wins
      if (node === earliest) continue;
      // Only merge if these are currently in DIFFERENT roots.
      let aRoot = node;
      while (aRoot.parent) aRoot = aRoot.parent;
      let bRoot = earliest;
      while (bRoot.parent) bRoot = bRoot.parent;
      if (aRoot === bRoot) continue;
      link(earliest, node);
    }
  }

  // Recompute roots after merge.
  const finalRoots = new Set<ThreadNode>();
  for (const node of nodes.values()) {
    let cursor = node;
    while (cursor.parent) cursor = cursor.parent;
    if (hasMaterial(cursor)) finalRoots.add(cursor);
  }

  return { roots: [...finalRoots], byMessageId };
}

function firstMaterial(node: ThreadNode): ThreadMessage | null {
  if (node.message) return node.message;
  for (const child of node.children) {
    const found = firstMaterial(child);
    if (found) return found;
  }
  return null;
}

function latestMaterial(node: ThreadNode): ThreadMessage | null {
  let best: ThreadMessage | null = node.message;
  for (const child of node.children) {
    const candidate = latestMaterial(child);
    if (candidate && (!best || candidate.date > best.date)) best = candidate;
  }
  return best;
}

/** Convenience: for a set of messages assumed to be ONE thread (Gmail's
 *  thread_id grouping), return the earliest-dated material root and the
 *  latest-dated material leaf of the biggest JWZ-reconstructed tree. */
export function rootAndLatest(messages: gmail_v1.Schema$Message[]): {
  root: ThreadMessage | null;
  latest: ThreadMessage | null;
} {
  const tree = buildThreadTree(messages);
  if (tree.roots.length === 0) return { root: null, latest: null };
  // Pick the root whose subtree contains the most material messages.
  const countMaterial = (node: ThreadNode): number =>
    (node.message ? 1 : 0) +
    node.children.reduce((sum, child) => sum + countMaterial(child), 0);
  const dominantRoot = [...tree.roots].sort(
    (a, b) => countMaterial(b) - countMaterial(a),
  )[0]!;
  return {
    root: firstMaterial(dominantRoot),
    latest: latestMaterial(dominantRoot),
  };
}
