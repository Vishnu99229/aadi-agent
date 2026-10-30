// LIVE job-queue eval on a synthetic 60-page RFP with 40 questions.
// Prints plan types, step statuses, answer counts and the final message.
// Never prints document, question or answer text.
import "dotenv/config";

process.env.AADI_DB_PATH = ":memory:";

const { createDocument, getJob, listJobSteps, recoverStuckJobSteps, updateJobStep } =
  await import("../src/db.ts");
const { JOB_STUCK_MS, extractNumberedQuestions } = await import(
  "../src/job_logic.ts"
);
const { planJobFromOwnerMessage } = await import("../src/job_plan.ts");
const { persistPlannedJob, processNextJobStep } = await import(
  "../src/job_worker.ts"
);
const { formatFinalMessage } = await import("../src/job_logic.ts");
const { recordRecentUpload } = await import("../src/recent_upload.ts");

function syntheticRfp(): { text: string; pages: number; questions: number } {
  const pages: string[] = [];
  for (let page = 1; page <= 60; page += 1) {
    const body = `TEST RFP (synthetic, no client data). Page ${page} of 60.
Section ${page}: fictional Testville municipal Wi-Fi tender. Eligibility, scope, SLAs and timelines.
Filler: ${"network coverage requirements. ".repeat(80)}`;
    pages.push(`--- Page ${page} ---\n${body}`);
  }
  for (let q = 1; q <= 40; q += 1) {
    const page = 20 + ((q - 1) % 40);
    if (page >= 1 && page <= 60) {
      pages[page - 1] += `\nQ${q}. What is the requirement number ${q} for the Testville Wi-Fi tender?\n`;
      pages[page - 1] += `A${q} in document: requirement ${q} is coverage in zone ${q} by 15 December 2026.\n`;
    }
  }
  const text = pages.join("\n\n");
  return {
    text,
    pages: 60,
    questions: extractNumberedQuestions(text).length,
  };
}

async function drain(jobId: number, maxTicks: number): Promise<string[]> {
  const outcomes: string[] = [];
  for (let tick = 1; tick <= maxTicks; tick += 1) {
    const outcome = (await processNextJobStep()) ?? "idle";
    outcomes.push(outcome);
    const current = getJob(jobId);
    if (
      outcome === "idle" ||
      current?.status === "done" ||
      current?.status === "failed" ||
      current?.status === "cancelled" ||
      current?.status === "paused"
    ) {
      break;
    }
  }
  return outcomes;
}

const rfp = syntheticRfp();
const document = createDocument("synthetic-test-rfp.txt", "work", rfp.text, null);
recordRecentUpload(document.id, document.file_name, "text");
console.log(
  `fixture pages=${rfp.pages} chars=${rfp.text.length} numbered_questions=${rfp.questions} document_id=${document.id}`,
);

const ownerText =
  "Review this 60-page TEST RFP, answer every question from the questionnaire, and draft a summary to Sendhil.";
const plan = await planJobFromOwnerMessage(ownerText, {
  documentId: document.id,
  fileName: document.file_name,
  chars: rfp.text.length,
  chunks: Math.ceil(rfp.text.length / 8000),
});
console.log(
  `plan title=${plan.title} steps=${plan.steps.length} types=${plan.steps.map((step) => step.type).join(",")}`,
);

const job = persistPlannedJob(ownerText, plan, { budgetUsd: 3 });
console.log(`job_id=${job.job_id} budget_usd=${job.budget_usd}`);

const first = await processNextJobStep();
console.log(`tick=1 outcome=${first}`);

const afterFirst = listJobSteps(job.job_id);
const nextPending = afterFirst.find((step) => step.status === "pending");
if (nextPending) {
  const stuckAt = new Date(Date.now() - JOB_STUCK_MS - 1000).toISOString();
  updateJobStep(job.job_id, nextPending.step_id, {
    status: "running",
    startedAt: stuckAt,
  });
  const recovered = recoverStuckJobSteps(JOB_STUCK_MS);
  const resumed = listJobSteps(job.job_id).find(
    (step) => step.step_id === nextPending.step_id,
  );
  console.log(
    `crash-resume recovered=${recovered} step=${nextPending.step_id} status=${resumed?.status}`,
  );
}

const outcomes = await drain(job.job_id, 40);
console.log(`drain outcomes=${outcomes.join(",")}`);

const finalJob = getJob(job.job_id)!;
const steps = listJobSteps(job.job_id);
for (const step of steps) {
  const result = step.result_ref ? JSON.parse(step.result_ref) as Record<string, unknown> : {};
  const answers = Array.isArray(result.answers) ? result.answers.length : 0;
  const questions = Array.isArray(result.questions) ? result.questions.length : 0;
  console.log(
    `step=${step.step_id} type=${step.type} status=${step.status} attempts=${step.attempts} done_check=${step.done_check_passed} answers=${answers} questions=${questions}`,
  );
}
console.log(`job status=${finalJob.status} cost_usd=${finalJob.cost_usd.toFixed(4)}`);
const final = formatFinalMessage(finalJob, steps);
console.log(`final_chars=${final.length}`);
console.log(final);
if (/Done:.*(?=Failed)|Failed:/.test(final) && /draft/.test(final) && /Done:.*draft/.test(final)) {
  const unchecked = steps.filter(
    (step) => step.type === "draft" && step.done_check_passed !== 1,
  );
  if (unchecked.length > 0) {
    throw new Error("final message claimed an unchecked draft");
  }
}
