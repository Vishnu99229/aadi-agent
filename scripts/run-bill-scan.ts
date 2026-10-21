// Manual bill-scan run: real Gmail + background LLM, in-memory DB, no Telegram sends.
// Usage: npm run bill-scan:manual
import type { Api } from "grammy";

const { runBillScan } = await import("../src/bills.ts");

const fakeApi = {
  async sendMessage() {
    console.log("[fake telegram] would send a New bill card");
    return {};
  },
} as unknown as Api;

try {
  await runBillScan(fakeApi);
  console.log("Manual bill scan: ok");
} catch (error) {
  console.error("Manual bill scan: failed");
  console.error(error);
  process.exitCode = 1;
}
