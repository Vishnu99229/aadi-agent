import type { SpecialistDefinition } from "../specialist.js";

const DAY_MS = 86_400_000;

/**
 * The Sales Agent: the Epicode deal records. It decides which accounts need
 * attention. It never sends email: follow-ups go to the Email Agent.
 */
export const salesAgent: SpecialistDefinition = {
  id: "sales",
  name: "Sales Agent",
  description:
    "Keeps the Epicode accounts: stage, next step, who is waiting on whom, account status and sales facts. Decides which accounts need a follow-up.",
  version: "1.0.0",
  promptFile: "sales.md",
  tools: [
    { name: "account_status", effect: "read", retry: "safe" },
    { name: "list_accounts", effect: "read", retry: "safe" },
    { name: "list_sales_facts", effect: "read", retry: "safe" },
    { name: "add_account", effect: "write", retry: "never" },
    { name: "update_account", effect: "write", retry: "never" },
    { name: "remove_account", effect: "write", retry: "never" },
    { name: "add_sales_fact", effect: "write", retry: "never" },
    { name: "remove_sales_fact", effect: "write", retry: "never" },
  ],
  sharedTools: ["get_current_time", "react_to_message", "resolve_contact"],
  routing: {
    patterns: [/\b(?:accounts?|deals?|pipeline|prospects?|sales\s+facts?|crm|where\s+are\s+we\s+with)\b/i],
    commandKinds: ["sales_fact_add", "sales_fact_remove", "account"],
  },
  capabilities: [
    {
      name: "pipeline",
      description: "Every tracked account on one line each: stage, next step and who is waiting on whom.",
      kind: "workflow",
      effect: "read",
      retry: "safe",
      usesLlm: false,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      examples: ["Show my accounts.", "How does the pipeline look?"],
      triggers: [/^(?:show|list)\s+(?:me\s+)?(?:my\s+|the\s+)?(?:accounts|pipeline|deals)[.?!]*$/i],
      handler: async () => {
        const { formatAccountsList } = await import("../../accounts.js");
        return { text: formatAccountsList() };
      },
    },
    {
      name: "accounts_needing_followup",
      description:
        "The accounts where Epicode is waiting on the other side and nothing has happened for a while. Returns each account's name, stage and days of silence.",
      kind: "workflow",
      effect: "read",
      retry: "safe",
      usesLlm: false,
      inputSchema: {
        type: "object",
        properties: {
          quiet_days: { type: "integer", description: "Days without activity that count as quiet. Defaults to 5." },
        },
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { accounts: { type: "array", items: { type: "object" } } },
        required: ["accounts"],
      },
      handler: async (input) => {
        const { decodedAccounts } = await import("../../accounts.js");
        const quietDays = typeof input.quiet_days === "number" && input.quiet_days > 0 ? input.quiet_days : 5;
        const now = Date.now();
        const quiet = decodedAccounts()
          .filter((account) => account.waiting_on === "them")
          .map((account) => {
            const last = account.last_activity_at ? Date.parse(account.last_activity_at) : Number.NaN;
            const silentDays = Number.isNaN(last) ? undefined : Math.floor((now - last) / DAY_MS);
            return { name: account.name, stage: account.stage, next_step: account.next_step, silent_days: silentDays };
          })
          .filter((account) => account.silent_days === undefined || account.silent_days >= quietDays)
          .sort((left, right) => (right.silent_days ?? 9999) - (left.silent_days ?? 9999));
        return {
          text:
            quiet.length === 0
              ? "No account is waiting on a reply."
              : quiet
                  .map(
                    (account) =>
                      `${account.name} (${account.stage || "no stage"}): ${
                        account.silent_days === undefined ? "no activity on record" : `quiet ${account.silent_days} days`
                      }`,
                  )
                  .join("\n"),
          output: { accounts: quiet },
        };
      },
    },
  ],
};
