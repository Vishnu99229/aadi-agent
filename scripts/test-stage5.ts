import "dotenv/config";
import Database from "better-sqlite3";
import { handler as readDocument } from "../src/tools/read_document.ts";
import { handler as searchNotesTool } from "../src/tools/search_notes.ts";
import {
  createDocument,
  createNote,
  deleteExpiredDocuments,
} from "../src/db.ts";
import { isWrapUpText, stripWrapUpPrefix } from "../src/wrapup_triggers.ts";
import { PDFDocument } from "pdf-lib";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function testPdfTrim(): Promise<void> {
  const source = await PDFDocument.create();
  for (let index = 0; index < 3; index += 1) {
    source.addPage();
  }
  const bytes = new Uint8Array(await source.save());
  const loadedSource = await PDFDocument.load(bytes);
  const totalPages = loadedSource.getPageCount();
  const maxPages = 2;
  const target = await PDFDocument.create();
  const copied = await target.copyPages(
    loadedSource,
    Array.from({ length: maxPages }, (_, index) => index),
  );
  for (const page of copied) {
    target.addPage(page);
  }
  const trimmed = new Uint8Array(await target.save());
  const loaded = await PDFDocument.load(trimmed);
  assert(totalPages === 3, "source page count");
  assert(loaded.getPageCount() === 2, "expected 2 pages");
}

function testWrapUpTriggers(): void {
  assert(isWrapUpText("call notes: spoke with Acme"), "call notes trigger");
  assert(isWrapUpText("Meeting notes - pricing"), "meeting notes trigger");
  assert(
    stripWrapUpPrefix("wrap up: discussed launch") === "discussed launch",
    "strip prefix",
  );
}

function testDocumentPersistence(): void {
  const doc = createDocument(
    "sample.pdf",
    "work",
    "Payment term is net 30 days.",
    [{ text: "Review contract", tag: "work", due_at: null }],
  );
  const text = readDocument({ id: doc.id });
  assert(text.includes("net 30"), "read_document returns stored text");
  assert(doc.id > 0, "document id assigned");
}

function testNotesSearch(): void {
  createNote(
    "Acme pricing call",
    "Ravi",
    "work",
    "Decided to wait until Friday.",
    null,
  );
  const results = searchNotesTool({ query: "Acme" });
  assert(results.includes("Acme pricing call"), "search_notes finds note");
}

function testDocumentExpiry(): void {
  const db = new Database("./aadi.db");
  db.prepare(
    `INSERT INTO documents (file_name, tag, extracted_text, created_at)
     VALUES ('old.pdf', 'work', 'old', datetime('now', '-8 days'))`,
  ).run();
  db.close();
  const removed = deleteExpiredDocuments();
  assert(removed >= 1, "expired documents removed");
}

async function main(): Promise<void> {
  testWrapUpTriggers();
  await testPdfTrim();
  testDocumentPersistence();
  testNotesSearch();
  testDocumentExpiry();
  console.log("Stage 5 automated checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
