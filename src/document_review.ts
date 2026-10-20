import { apiEffortForTask, getTaskBackend } from "./chat_backend.js";
import { config } from "./config.js";
import {
  CONTRACT_CLAUSES,
  chunkText,
  emptyContractReview,
  emptyQuestionnaireReview,
  emptyRfpReview,
  formatTypedReview,
  mergeContractReviews,
  mergeQuestionnaireReviews,
  mergeRfpReviews,
  type ClauseHit,
  type ContractClauseKey,
  type ContractReview,
  type QuestionnaireReview,
  type RfpReview,
  type TypedReview,
} from "./document_review_logic.js";
import type { DocumentKind } from "./document_types.js";
import { complete } from "./llm.js";

function parseJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("Document review did not return JSON.");
  }
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
}

async function completeJson(
  system: string,
  user: string,
): Promise<Record<string, unknown>> {
  const result = await complete({
    backend: config.deepseekApiKey
      ? "deepseek-reasoner"
      : getTaskBackend("documents"),
    system: { cacheable: system },
    messages: [{ role: "user", content: user }],
    tools: [],
    maxTokens: 4096,
    task: "contract_review",
    effort: config.deepseekApiKey ? undefined : apiEffortForTask("documents"),
    cacheTtl: "5m",
  });
  const text = result.textParts.join("\n");
  console.log(
    `Document review: input_tokens=${result.usage.inputTokens}, output_tokens=${result.usage.outputTokens}`,
  );
  return parseJsonObject(text);
}

function asClause(value: unknown): ClauseHit {
  if (!value || typeof value !== "object") {
    return { found: false, text: "", page: "", pushback: false };
  }
  const entry = value as Record<string, unknown>;
  const text = typeof entry.text === "string" ? entry.text.trim() : "";
  const found = entry.found === true && text.length > 0;
  return {
    found,
    text: found ? text : "",
    page: typeof entry.page === "string" ? entry.page : "",
    pushback: entry.pushback === true,
  };
}

function contractFromJson(parsed: Record<string, unknown>): ContractReview {
  const review = emptyContractReview();
  review.summary = strings(parsed.summary).slice(0, 5);
  review.pushback = strings(parsed.pushback);
  const clauses =
    parsed.clauses && typeof parsed.clauses === "object"
      ? (parsed.clauses as Record<string, unknown>)
      : {};
  for (const clause of CONTRACT_CLAUSES) {
    review.clauses[clause.key] = asClause(clauses[clause.key]);
  }
  return review;
}

function rfpFromJson(parsed: Record<string, unknown>): RfpReview {
  const review = emptyRfpReview();
  review.summary = strings(parsed.summary).slice(0, 5);
  review.want = typeof parsed.want === "string" ? parsed.want.trim() : "";
  const deadlines =
    parsed.deadlines && typeof parsed.deadlines === "object"
      ? (parsed.deadlines as Record<string, unknown>)
      : {};
  const deadlineValue = (key: string): string => {
    const value = deadlines[key];
    return typeof value === "string" && value.trim() ? value.trim() : "not found";
  };
  review.deadlines = {
    submission: deadlineValue("submission"),
    pre_bid_queries: deadlineValue("pre_bid_queries"),
    validity: deadlineValue("validity"),
  };
  review.eligibility = strings(parsed.eligibility);
  review.evaluation = strings(parsed.evaluation);
  review.deliverables = strings(parsed.deliverables);
  review.questions_to_answer = strings(parsed.questions_to_answer);
  review.check_with_team = strings(parsed.check_with_team);
  return review;
}

function questionnaireFromJson(
  parsed: Record<string, unknown>,
): QuestionnaireReview {
  const review = emptyQuestionnaireReview();
  review.summary = strings(parsed.summary).slice(0, 5);
  const groups = Array.isArray(parsed.groups) ? parsed.groups : [];
  review.groups = groups
    .map((item) => {
      const entry = item as Record<string, unknown>;
      return {
        topic: typeof entry.topic === "string" ? entry.topic.trim() : "General",
        questions: strings(entry.questions),
      };
    })
    .filter((group) => group.questions.length > 0);
  return review;
}

const CONTRACT_SYSTEM = `You extract MSA/NDA/SOW/agreement clauses for Vishnu (Epicode). Return JSON only.
Never invent clauses. If a clause is not in THIS chunk, found must be false and text must be "".
Quote a short excerpt or page label from the chunk. Flag one-sided or unusual terms with pushback true.
JSON shape:
{"summary":["..."],"clauses":{${CONTRACT_CLAUSES.map((c) => `"${c.key}":{"found":false,"text":"","page":"","pushback":false}`).join(",")}},"pushback":["..."]}`;

const RFP_SYSTEM = `You extract RFP/RFQ/tender facts for Vishnu (Epicode). Return JSON only.
Never invent. If something is not in THIS chunk, use "not found" or [].
Flag requirements Epicode may not meet in check_with_team (eligibility, certifications, turnover, geography, mandatory tools).
JSON shape:
{"summary":["..."],"want":"","deadlines":{"submission":"not found","pre_bid_queries":"not found","validity":"not found"},"eligibility":[],"evaluation":[],"deliverables":[],"questions_to_answer":[],"check_with_team":[]}`;

const QUESTIONNAIRE_SYSTEM = `You list questions from a vendor/security/technical questionnaire. Return JSON only.
Do not answer the questions. Group them by topic. If THIS chunk has no questions, groups is [].
JSON shape:
{"summary":["..."],"groups":[{"topic":"Security","questions":["..."]}]}`;

async function reviewContract(text: string): Promise<ContractReview> {
  const chunks = chunkText(text);
  const parts: ContractReview[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const parsed = await completeJson(
      CONTRACT_SYSTEM,
      `Chunk ${index + 1} of ${chunks.length}. Extract only what is in this chunk.\n\n${chunk}`,
    );
    parts.push(contractFromJson(parsed));
  }
  return mergeContractReviews(parts);
}

async function reviewRfp(text: string): Promise<RfpReview> {
  const chunks = chunkText(text);
  const parts: RfpReview[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const parsed = await completeJson(
      RFP_SYSTEM,
      `Chunk ${index + 1} of ${chunks.length}. Extract only what is in this chunk.\n\n${chunk}`,
    );
    parts.push(rfpFromJson(parsed));
  }
  return mergeRfpReviews(parts);
}

async function reviewQuestionnaire(text: string): Promise<QuestionnaireReview> {
  const chunks = chunkText(text);
  const parts: QuestionnaireReview[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const parsed = await completeJson(
      QUESTIONNAIRE_SYSTEM,
      `Chunk ${index + 1} of ${chunks.length}. List questions in this chunk only.\n\n${chunk}`,
    );
    parts.push(questionnaireFromJson(parsed));
  }
  return mergeQuestionnaireReviews(parts);
}

export async function reviewTypedDocument(
  kind: Exclude<DocumentKind, "other">,
  text: string,
  documentId: number,
): Promise<{ review: TypedReview; reply: string }> {
  const review =
    kind === "contract"
      ? await reviewContract(text)
      : kind === "rfp"
        ? await reviewRfp(text)
        : await reviewQuestionnaire(text);
  return { review, reply: formatTypedReview(review, documentId) };
}

export { formatTypedReview };
export type { ContractClauseKey, TypedReview };
