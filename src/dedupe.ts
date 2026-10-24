// @ts-expect-error - minhash@0.0.9 ships no type declarations.
import { Minhash } from "minhash";

/** 3-word shingles. The 0.0.9 Minhash package already does hashing of each
 *  shingle it receives, so we only have to feed it the normalised chunks.
 *  Short inputs (< 3 words) emit a single whole-string shingle so they
 *  still produce a meaningful signature. */
export function shingle(text: string, windowSize = 3): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return [];
  if (words.length < windowSize) return [words.join(" ")];
  const result: string[] = [];
  for (let i = 0; i <= words.length - windowSize; i += 1) {
    result.push(words.slice(i, i + windowSize).join(" "));
  }
  return result;
}

export interface Signature {
  readonly minhash: unknown; // Minhash instance, kept opaque to callers.
}

export function signatureOf(text: string): Signature {
  const sig: { update: (s: string) => void } = new Minhash();
  for (const chunk of shingle(text)) sig.update(chunk);
  return { minhash: sig };
}

/** Approximate Jaccard similarity (0..1). 1 = identical, 0 = disjoint. */
export function similarity(left: Signature, right: Signature): number {
  const l = left.minhash as { jaccard: (other: unknown) => number };
  return l.jaccard(right.minhash);
}

export interface DuplicateMatch<T> {
  record: T;
  score: number;
}

/** Scan `candidates` for near-duplicates of `newText`. Returns the
 *  single best match whose similarity meets the threshold, or null if
 *  nothing crosses it. We DO NOT auto-drop — the caller must decide.
 *  Threshold default is 0.95 per Vishnu's spec. */
export function findNearDuplicate<T>(
  newText: string,
  candidates: ReadonlyArray<{ text: string; record: T }>,
  threshold = 0.95,
): DuplicateMatch<T> | null {
  if (!newText || candidates.length === 0) return null;
  const newSig = signatureOf(newText);
  let best: DuplicateMatch<T> | null = null;
  for (const candidate of candidates) {
    if (!candidate.text) continue;
    const score = similarity(newSig, signatureOf(candidate.text));
    if (score >= threshold && (!best || score > best.score)) {
      best = { record: candidate.record, score };
    }
  }
  return best;
}
