import type { DocumentKind } from "./document_types.js";

export const CONTRACT_CLAUSES = [
  { key: "payment_terms", label: "Payment terms" },
  { key: "liability_cap", label: "Liability cap" },
  { key: "indemnity", label: "Indemnity" },
  { key: "termination_notice", label: "Termination and notice period" },
  { key: "auto_renewal", label: "Auto-renewal" },
  { key: "exclusivity", label: "Exclusivity" },
  { key: "ip_ownership", label: "IP ownership" },
  { key: "confidentiality_duration", label: "Confidentiality duration" },
  { key: "slas_penalties", label: "SLAs and penalties" },
  { key: "governing_law", label: "Governing law and jurisdiction" },
] as const;

export type ContractClauseKey = (typeof CONTRACT_CLAUSES)[number]["key"];

export interface ClauseHit {
  found: boolean;
  text: string;
  page: string;
  pushback: boolean;
}

export interface ContractReview {
  kind: "contract";
  summary: string[];
  clauses: Record<ContractClauseKey, ClauseHit>;
  pushback: string[];
}

export interface RfpReview {
  kind: "rfp";
  summary: string[];
  want: string;
  deadlines: {
    submission: string;
    pre_bid_queries: string;
    validity: string;
  };
  eligibility: string[];
  evaluation: string[];
  deliverables: string[];
  questions_to_answer: string[];
  check_with_team: string[];
}

export interface QuestionnaireReview {
  kind: "questionnaire";
  summary: string[];
  groups: Array<{ topic: string; questions: string[] }>;
}

export type TypedReview = ContractReview | RfpReview | QuestionnaireReview;

export const TEXT_CHUNK_CHARS = 12_000;
export const TEXT_CHUNK_OVERLAP = 400;

export function chunkText(
  text: string,
  size = TEXT_CHUNK_CHARS,
  overlap = TEXT_CHUNK_OVERLAP,
): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.length <= size) {
    return [trimmed];
  }
  const chunks: string[] = [];
  let start = 0;
  while (start < trimmed.length) {
    const end = Math.min(trimmed.length, start + size);
    chunks.push(trimmed.slice(start, end));
    if (end >= trimmed.length) {
      break;
    }
    start = Math.max(0, end - overlap);
  }
  return chunks;
}

export function emptyClause(): ClauseHit {
  return { found: false, text: "", page: "", pushback: false };
}

export function emptyContractReview(): ContractReview {
  const clauses = {} as Record<ContractClauseKey, ClauseHit>;
  for (const clause of CONTRACT_CLAUSES) {
    clauses[clause.key] = emptyClause();
  }
  return { kind: "contract", summary: [], clauses, pushback: [] };
}

export function emptyRfpReview(): RfpReview {
  return {
    kind: "rfp",
    summary: [],
    want: "",
    deadlines: {
      submission: "not found",
      pre_bid_queries: "not found",
      validity: "not found",
    },
    eligibility: [],
    evaluation: [],
    deliverables: [],
    questions_to_answer: [],
    check_with_team: [],
  };
}

export function emptyQuestionnaireReview(): QuestionnaireReview {
  return { kind: "questionnaire", summary: [], groups: [] };
}

function uniqueStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const text = item.trim();
    if (!text) {
      continue;
    }
    const key = text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(text);
  }
  return result;
}

function mergeClause(current: ClauseHit, incoming: ClauseHit): ClauseHit {
  if (!incoming.found || !incoming.text.trim()) {
    return current;
  }
  if (!current.found) {
    return {
      found: true,
      text: incoming.text.trim(),
      page: incoming.page.trim(),
      pushback: incoming.pushback,
    };
  }
  return {
    ...current,
    pushback: current.pushback || incoming.pushback,
  };
}

export function mergeContractReviews(parts: ContractReview[]): ContractReview {
  const merged = emptyContractReview();
  for (const part of parts) {
    merged.summary = uniqueStrings([...merged.summary, ...part.summary]).slice(
      0,
      5,
    );
    merged.pushback = uniqueStrings([...merged.pushback, ...part.pushback]);
    for (const clause of CONTRACT_CLAUSES) {
      merged.clauses[clause.key] = mergeClause(
        merged.clauses[clause.key],
        part.clauses[clause.key] ?? emptyClause(),
      );
    }
  }
  return merged;
}

export function mergeRfpReviews(parts: RfpReview[]): RfpReview {
  const merged = emptyRfpReview();
  for (const part of parts) {
    merged.summary = uniqueStrings([...merged.summary, ...part.summary]).slice(
      0,
      5,
    );
    if (!merged.want.trim() && part.want.trim()) {
      merged.want = part.want.trim();
    }
    for (const key of ["submission", "pre_bid_queries", "validity"] as const) {
      const value = part.deadlines[key]?.trim() ?? "";
      if (
        value &&
        value.toLowerCase() !== "not found" &&
        (merged.deadlines[key] === "not found" || !merged.deadlines[key])
      ) {
        merged.deadlines[key] = value;
      }
    }
    merged.eligibility = uniqueStrings([
      ...merged.eligibility,
      ...part.eligibility,
    ]);
    merged.evaluation = uniqueStrings([
      ...merged.evaluation,
      ...part.evaluation,
    ]);
    merged.deliverables = uniqueStrings([
      ...merged.deliverables,
      ...part.deliverables,
    ]);
    merged.questions_to_answer = uniqueStrings([
      ...merged.questions_to_answer,
      ...part.questions_to_answer,
    ]);
    merged.check_with_team = uniqueStrings([
      ...merged.check_with_team,
      ...part.check_with_team,
    ]);
  }
  return merged;
}

export function mergeQuestionnaireReviews(
  parts: QuestionnaireReview[],
): QuestionnaireReview {
  const byTopic = new Map<string, string[]>();
  const summary: string[] = [];
  for (const part of parts) {
    summary.push(...part.summary);
    for (const group of part.groups) {
      const topic = group.topic.trim() || "General";
      const existing = byTopic.get(topic) ?? [];
      byTopic.set(topic, uniqueStrings([...existing, ...group.questions]));
    }
  }
  return {
    kind: "questionnaire",
    summary: uniqueStrings(summary).slice(0, 5),
    groups: [...byTopic.entries()].map(([topic, questions]) => ({
      topic,
      questions,
    })),
  };
}

function clauseLine(hit: ClauseHit): string {
  if (!hit.found || !hit.text.trim()) {
    return "not found";
  }
  const page = hit.page.trim() ? ` (p. ${hit.page.trim()})` : "";
  const flag = hit.pushback ? " — worth pushing back on" : "";
  return `${hit.text.trim()}${page}${flag}`;
}

function bullet(items: string[], empty = "not found"): string {
  if (items.length === 0) {
    return empty;
  }
  return items.map((item) => `• ${item}`).join("\n");
}

export function formatTypedReview(
  review: TypedReview,
  documentId: number,
): string {
  if (review.kind === "contract") {
    const lines = [
      "Contract review",
      "",
      "Summary:",
      ...review.summary.map((item) => `• ${item}`),
      "",
      "Clause checklist:",
      ...CONTRACT_CLAUSES.map(
        (clause) =>
          `• ${clause.label}: ${clauseLine(review.clauses[clause.key])}`,
      ),
    ];
    if (review.pushback.length > 0) {
      lines.push("", "Worth pushing back on:");
      lines.push(...review.pushback.map((item) => `• ${item}`));
    }
    lines.push(
      "",
      `Document id: ${documentId} (use read_document for follow-ups)`,
    );
    return lines.join("\n");
  }

  if (review.kind === "rfp") {
    const lines = [
      "RFP / tender review",
      "",
      "What they want:",
      review.want.trim() || "not found",
      "",
      "Key deadlines:",
      `• Submission: ${review.deadlines.submission || "not found"}`,
      `• Pre-bid queries: ${review.deadlines.pre_bid_queries || "not found"}`,
      `• Validity: ${review.deadlines.validity || "not found"}`,
      "",
      "Eligibility:",
      bullet(review.eligibility),
      "",
      "Evaluation:",
      bullet(review.evaluation),
      "",
      "Deliverables / scope:",
      bullet(review.deliverables),
      "",
      "Questions we must answer:",
      bullet(review.questions_to_answer),
    ];
    if (review.check_with_team.length > 0) {
      lines.push("", "Check with the team:");
      lines.push(
        ...review.check_with_team.map((item) => `• ${item} — check with the team`),
      );
    }
    lines.push(
      "",
      `Document id: ${documentId} (use read_document for follow-ups)`,
    );
    return lines.join("\n");
  }

  const count = review.groups.reduce(
    (sum, group) => sum + group.questions.length,
    0,
  );
  const lines = [
    `Questionnaire (${count} question${count === 1 ? "" : "s"})`,
    "",
    "I'm listing the questions only — not filling them in.",
    "",
  ];
  if (review.groups.length === 0) {
    lines.push("No questions found.");
  } else {
    for (const group of review.groups) {
      lines.push(`${group.topic} (${group.questions.length}):`);
      lines.push(...group.questions.map((item) => `• ${item}`));
      lines.push("");
    }
  }
  lines.push(`Document id: ${documentId} (use read_document for follow-ups)`);
  return lines.join("\n").trim();
}

export function kindLabel(kind: DocumentKind): string {
  if (kind === "contract") {
    return "contract";
  }
  if (kind === "rfp") {
    return "RFP";
  }
  if (kind === "questionnaire") {
    return "questionnaire";
  }
  return "document";
}
