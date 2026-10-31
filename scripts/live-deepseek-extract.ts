import { setTaskBackend } from "../src/chat_backend.ts";
import { analyzeText } from "../src/document_llm.ts";

const FIXTURE = `Vendor: Pinnacle Communications
Quote for number masking API support.
Due date: 15 November 2026
Amount: ₹48,000 plus GST
Action needed: email procurement the signed quote.`;

setTaskBackend("documents", "deepseek");
const analysis = await analyzeText(FIXTURE, "quote", 1, false);
const dates = analysis.dates.join("; ");
const money = analysis.money.join("; ");
const hasDate = analysis.dates.some((item) => /15/i.test(item) && /2026/.test(item));
const hasMoney = analysis.money.some(
  (item) => /48,?000/.test(item) && /₹|INR|Rs/i.test(item),
);
console.log(
  JSON.stringify({
    backend: "deepseek",
    dates_count: analysis.dates.length,
    money_count: analysis.money.length,
    has_date: hasDate,
    has_money: hasMoney,
    dates,
    money,
    fallback: analysis.fallback_summary,
  }),
);
if (!hasDate || !hasMoney) {
  console.error("live-deepseek-extract: dates or money missing");
  process.exit(1);
}
console.log("live-deepseek-extract: ok");
