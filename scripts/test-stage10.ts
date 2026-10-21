import "dotenv/config";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

function ensureTestEnv(): void {
  process.env.LLM_PROVIDER ??= "claude";
  process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
  process.env.OWNER_TELEGRAM_ID ??= "1";
  process.env.CLAUDE_MODEL ??= "claude-haiku-4-5";
  process.env.ANTHROPIC_API_KEY ??= "test-key";
  process.env.BRIEF_TIME ??= "08:00";
}

ensureTestEnv();

const {
  buildMomDraft,
  formatMomDate,
  hasMomRecipients,
  isSelfEmail,
  momDueLabel,
  momOwnerLabel,
  parseNoteMeeting,
  parseNoteSections,
  recipientsExcludingSelf,
} = await import("../src/mom_logic.ts");
const {
  attachmentAlertLabel,
  detectDocumentKind,
  isSupportedAttachment,
  looksLikeReviewAttachment,
} = await import("../src/document_types.ts");
const {
  chunkText,
  emptyContractReview,
  formatTypedReview,
  mergeContractReviews,
  mergeQuestionnaireReviews,
  mergeRfpReviews,
} = await import("../src/document_review_logic.ts");
const {
  attachmentTooLarge,
  collectAttachmentParts,
  matchAttachment,
  MAX_ATTACHMENT_BYTES,
  senderDisplay,
} = await import("../src/gmail_attachments.ts");
const { extractPdfText } = await import("../src/pdf_text.ts");
const {
  buildSpreadsheetBuffer,
  extractSpreadsheetText,
} = await import("../src/xlsx_text.ts");
const { createNote, getNote } = await import("../src/db.ts");
const { selectReplyRecipients } = await import("../src/followups.ts");
const { buildThreadReplyMime } = await import("../src/google/mail.ts");

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function testMomDraft(): void {
  const draft = buildMomDraft({
    title: "Pinnacle weekly",
    dateValue: "2026-10-14",
    attendees: [
      { name: "Vishnu Rajan", email: "vishnu.rajan@epicode.in" },
      { name: "Vishnu", email: "vishnu.rajan294@gmail.com" },
      { name: "Priya", email: "priya@pinnacle.in" },
      { name: "Amit", email: "amit@epicode.in" },
    ],
    keyPoints: ["Discussed Eternal PIVC scope"],
    decisions: ["Share revised SOW"],
    actionItems: [
      {
        text: "Send revised SOW",
        owner: "vishnu",
        owner_email: null,
        due_at: "2026-10-20T00:00:00+05:30",
      },
      {
        text: "Confirm commercials",
        owner: "other",
        owner_email: null,
        due_at: null,
      },
    ],
    nextSteps: ["Wait for Priya's confirmation"],
  });
  assert(draft.subject === "MoM – Pinnacle weekly – 14 Oct 2026", draft.subject);
  assert(draft.to.join(",") === "priya@pinnacle.in,amit@epicode.in", draft.to.join(","));
  assert(!draft.to.some((email) => isSelfEmail(email)), "self excluded from To");
  assert(draft.body.startsWith("Dear All,"), "greeting");
  assert(draft.body.includes("Regards,\nVishnu"), "sign-off");
  assert(draft.body.includes("Owner: Vishnu"), "vishnu owner");
  assert(draft.body.includes("Owner: TBD"), "missing owner is TBD");
  assert(draft.body.includes("Due: TBD"), "missing due is TBD");
  assert(draft.tbdWarnings.length === 2, `tbd warnings: ${draft.tbdWarnings.length}`);
  assert(
    !hasMomRecipients([{ name: "Vishnu", email: "vishnu.rajan@epicode.in" }]),
    "self-only meeting has no MoM recipients",
  );
  assert(recipientsExcludingSelf([{ name: "X", email: "  PRIYA@pinnacle.in " }])[0]?.email === "priya@pinnacle.in", "email normalised");
  assert(momOwnerLabel({ text: "x", owner: "other", owner_email: null, due_at: null }) === "TBD", "owner TBD");
  assert(momDueLabel(null) === "TBD", "due TBD");
  assert(formatMomDate("2026-10-14") === "14 Oct 2026", formatMomDate("2026-10-14"));
}

function testNoteParsing(): void {
  const sections = parseNoteSections(`Date: 2026-10-14
People: Priya

Key points:
• Scope for Eternal PIVC
• Timeline tight

Decisions:
• Share SOW this week

Open questions:
• Who owns commercials?

Action items:
• Send SOW (Vishnu)
`);
  assert(sections.dateValue === "2026-10-14", "date parsed");
  assert(sections.keyPoints.includes("Scope for Eternal PIVC"), "key points");
  assert(sections.decisions.includes("Share SOW this week"), "decisions");
  assert(sections.openQuestions.includes("Who owns commercials?"), "questions");
  const meeting = parseNoteMeeting(
    JSON.stringify({
      title: "Pinnacle weekly",
      startAt: "2026-10-14T11:00:00+05:30",
      attendees: [{ name: "Priya", email: "priya@pinnacle.in" }],
    }),
  );
  assert(meeting?.title === "Pinnacle weekly", "meeting json");
  const note = createNote(
    "Stage10 MoM fixture",
    "Priya",
    "work",
    "Key points:\n• Fixture only",
    null,
    JSON.stringify(meeting),
  );
  const stored = getNote(note.id);
  assert(stored?.meeting_json?.includes("priya@pinnacle.in") === true, "meeting_json persisted");
}

function testDocumentTypes(): void {
  assert(detectDocumentKind("Pinnacle_MSA_v3.pdf") === "contract", "msa filename");
  assert(detectDocumentKind("scan.pdf", "NDA for review") === "contract", "nda subject");
  assert(detectDocumentKind("pack.zip", "RFP – Eternal PIVC") === "rfp", "rfp subject");
  assert(
    detectDocumentKind("vendor_security_questionnaire.xlsx") === "questionnaire",
    "questionnaire filename",
  );
  assert(detectDocumentKind("invoice.pdf", "Invoice March") === "other", "invoice other");
  assert(attachmentAlertLabel("contract", "MSA_Pinnacle.pdf") === "MSA", "alert MSA");
  assert(attachmentAlertLabel("rfp", "tender.pdf", "Tender notice") === "Tender", "alert tender");
  assert(
    looksLikeReviewAttachment({
      filename: "MSA.pdf",
      mimeType: "application/pdf",
      subject: "Please review",
    }),
    "msa pdf alerts",
  );
  assert(
    looksLikeReviewAttachment({
      filename: "scope.pdf",
      mimeType: "application/pdf",
      subject: "RFP from Eternal",
    }),
    "rfp subject alerts",
  );
  assert(
    !looksLikeReviewAttachment({
      filename: "logo.png",
      mimeType: "image/png",
      subject: "MSA attached",
    }),
    "inline image skipped",
  );
  assert(isSupportedAttachment("a.pdf"), "pdf supported");
  assert(isSupportedAttachment("a.docx"), "docx supported");
  assert(isSupportedAttachment("a.xlsx"), "xlsx supported");
  assert(isSupportedAttachment("a.xls"), "xls supported");
  assert(isSupportedAttachment("scan.png", "image/png"), "png supported");
  assert(!isSupportedAttachment("a.exe"), "exe unsupported");
}

function testReviewMergeAndFormat(): void {
  const first = emptyContractReview();
  const second = emptyContractReview();
  second.clauses.liability_cap = {
    found: true,
    text: "Cap of INR 50 lakh",
    page: "12",
    pushback: true,
  };
  second.summary = ["MSA with a low liability cap"];
  const merged = mergeContractReviews([first, second]);
  assert(merged.clauses.payment_terms.found === false, "missing clause stays not found");
  assert(merged.clauses.liability_cap.found === true, "found clause kept");
  const formatted = formatTypedReview(merged, 42);
  assert(formatted.includes("Payment terms: not found"), formatted);
  assert(formatted.includes("Cap of INR 50 lakh (p. 12) — worth pushing back on"), "pushback");
  assert(formatted.includes("Document id: 42"), "id");

  const rfp = mergeRfpReviews([
    {
      kind: "rfp",
      summary: ["PIVC RFP"],
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
    },
    {
      kind: "rfp",
      summary: [],
      want: "PIVC for Eternal",
      deadlines: {
        submission: "31 Oct 2026",
        pre_bid_queries: "not found",
        validity: "90 days",
      },
      eligibility: ["ISO 27001"],
      evaluation: ["70% technical"],
      deliverables: ["PIVC workflow"],
      questions_to_answer: ["Describe architecture"],
      check_with_team: ["Onsite team in Hyderabad"],
    },
  ]);
  const rfpText = formatTypedReview(rfp, 7);
  assert(rfp.want === "PIVC for Eternal", "rfp want merged");
  assert(rfp.deadlines.pre_bid_queries === "not found", "missing deadline");
  assert(rfpText.includes("check with the team"), "rfp flag");

  const questions = mergeQuestionnaireReviews([
    {
      kind: "questionnaire",
      summary: [],
      groups: [{ topic: "Security", questions: ["Do you encrypt at rest?"] }],
    },
    {
      kind: "questionnaire",
      summary: [],
      groups: [
        { topic: "Security", questions: ["Do you encrypt in transit?"] },
        { topic: "Privacy", questions: ["Is data stored in India?"] },
      ],
    },
  ]);
  const qText = formatTypedReview(questions, 8);
  assert(qText.includes("Questionnaire (3 questions)"), qText);
  assert(qText.includes("not filling them in"), "no fill");
  assert(chunkText("a".repeat(25_000)).length >= 2, "chunking");
}

function testGmailPartsAndSize(): void {
  const attachments = collectAttachmentParts({
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "text/plain", body: { data: "aGVsbG8=" } },
      {
        filename: "MSA_Pinnacle.pdf",
        mimeType: "application/pdf",
        body: { attachmentId: "att-1", size: 12000 },
      },
      {
        filename: "logo.png",
        mimeType: "image/png",
        headers: [{ name: "Content-Disposition", value: "inline" }],
        body: { attachmentId: "att-img", size: 800 },
      },
    ],
  });
  assert(attachments.length === 1, `expected 1 attachment, got ${attachments.length}`);
  assert(attachments[0]?.id === "att-1", "attachment id");
  assert(matchAttachment(attachments, "MSA_Pinnacle.pdf").length === 1, "match by name");
  assert(matchAttachment(attachments, "att-1").length === 1, "match by id");
  assert(!attachmentTooLarge(1000), "small ok");
  assert(attachmentTooLarge(MAX_ATTACHMENT_BYTES + 1), "over 25 MB skipped");
  assert(senderDisplay('Priya Nair <priya@pinnacle.in>') === "Priya Nair", "sender display");
}

async function testLongTextPdf(): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pageCount = 55;
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = doc.addPage([612, 792]);
    page.drawText(`STAGE10 PAGE ${pageNumber} LIABILITY CAP INR FIFTY LAKH`, {
      x: 48,
      y: 720,
      size: 14,
      font,
      color: rgb(0, 0, 0),
    });
  }
  const bytes = await doc.save();
  const all = await extractPdfText(bytes);
  assert(all.totalPages === pageCount, `totalPages ${all.totalPages}`);
  assert(all.pages === pageCount, `extracted pages ${all.pages}`);
  assert(all.hasTextLayer, "text layer");
  assert(all.text.includes("STAGE10 PAGE 55"), "last page extracted");
  assert(all.text.includes("STAGE10 PAGE 1"), "first page extracted");
  const capped = await extractPdfText(bytes, 50);
  assert(capped.pages === 50, "cap still works when requested");
  assert(!capped.text.includes("STAGE10 PAGE 55"), "cap omits page 55");
  console.log(
    `long text PDF: pages=${all.pages} chars=${all.text.length} cap50_pages=${capped.pages}`,
  );
}

function testXlsx(): void {
  const bytes = buildSpreadsheetBuffer({
    Security: [
      ["Question", "Answer"],
      ["Do you encrypt data at rest?", ""],
      ["Is the SOC 2 report available?", ""],
    ],
    Privacy: [["Question"], ["Is customer data stored in India?"]],
  });
  const text = extractSpreadsheetText(bytes);
  assert(text.includes("--- sheet Security ---"), "sheet name");
  assert(text.includes("Do you encrypt data at rest?"), "xlsx question");
  assert(text.includes("Is customer data stored in India?"), "second sheet");
  assert(detectDocumentKind("vendor_security_questionnaire.xlsx", "", text) === "questionnaire", "xlsx kind");
  console.log(`xlsx: chars=${text.length} sheets=2`);
}

function testFollowupReplyHeaders(): void {
  // Original send: Vishnu -> Karthik, CC Sendhil. Vishnu also sits on To
  // (self-copy, which some mail apps add) and on Cc as a reply-all echo.
  const toHeader = `"Karthik" <karthik@elevenlabs.io>, vishnu.rajan@epicode.in`;
  const ccHeader = `Sendhil <sendhil@epicode.in>, Vishnu <vishnu.rajan@epicode.in>`;
  const { to, cc } = selectReplyRecipients(toHeader, ccHeader);

  assert(/karthik@elevenlabs\.io/i.test(to), "To contains Karthik");
  assert(!/vishnu\.rajan/i.test(to), "Vishnu dropped from To");
  assert(/sendhil@epicode\.in/i.test(cc), "Cc keeps Sendhil (internal colleague)");
  assert(!/vishnu\.rajan/i.test(cc), "Vishnu dropped from Cc");

  const mime = buildThreadReplyMime({
    to,
    cc,
    subject: "Re: Partnership follow-up",
    inReplyTo: "<original-123@mail.epicode.in>",
    references: "<original-123@mail.epicode.in>",
    body: "Hi Karthik,\n\nSmall nudge.\n\nThanks,\nVishnu",
  });

  assert(/^To: .*karthik@elevenlabs\.io/m.test(mime), "MIME To header is Karthik");
  assert(/^Cc: .*sendhil@epicode\.in/m.test(mime), "MIME Cc header is Sendhil");
  assert(!/vishnu\.rajan@epicode\.in/i.test(mime.split("\r\n\r\n")[0]!), "Vishnu absent from MIME headers");
  assert(
    /^In-Reply-To: <original-123@mail\.epicode\.in>/m.test(mime),
    "In-Reply-To wires the original Message-ID",
  );
  assert(
    /^References: <original-123@mail\.epicode\.in>/m.test(mime),
    "References wires the original Message-ID",
  );

  // Edge case: original send went only to self → promote first external Cc.
  const promoted = selectReplyRecipients(
    "vishnu.rajan@epicode.in",
    "Karthik <karthik@elevenlabs.io>, Sendhil <sendhil@epicode.in>",
  );
  assert(/karthik@elevenlabs\.io/i.test(promoted.to), "External Cc promoted to To");
  assert(/sendhil@epicode\.in/i.test(promoted.cc), "Remaining Cc preserved after promotion");
}

testMomDraft();
testNoteParsing();
testDocumentTypes();
testReviewMergeAndFormat();
testGmailPartsAndSize();
await testLongTextPdf();
testXlsx();
testFollowupReplyHeaders();
console.log("Stage 10 checks passed.");
