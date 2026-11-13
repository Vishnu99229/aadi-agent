import type { SpecialistDefinition, Stoppable } from "../specialist.js";
import { InputRequiredSignal } from "../types.js";

/** 09:00 Asia/Kolkata, some days before a YYYY-MM-DD date. */
export function reminderInstant(dueDate: string, daysBefore: number): Date {
  const due = new Date(`${dueDate}T09:00:00+05:30`);
  return new Date(due.getTime() - daysBefore * 86_400_000);
}

/**
 * The Operations Agent: tasks, reminders, bills and renewals, important dates
 * and tracked promises. Every reminder Aadi sets goes through this agent.
 */
export const operationsAgent: SpecialistDefinition = {
  id: "operations",
  name: "Operations Agent",
  description:
    "Keeps tasks, reminders, bills and renewals, important dates and tracked promises, and sends the daily brief and weekly review.",
  version: "1.0.0",
  promptFile: "operations.md",
  tools: [
    { name: "list_tasks", effect: "read", retry: "safe" },
    { name: "list_reminders", effect: "read", retry: "safe" },
    { name: "list_dates", effect: "read", retry: "safe" },
    { name: "list_upcoming_dates", effect: "read", retry: "safe" },
    { name: "list_bills", effect: "read", retry: "safe" },
    { name: "add_task", effect: "write", retry: "never" },
    { name: "complete_task", effect: "write", retry: "never" },
    { name: "delete_task", effect: "write", retry: "never" },
    { name: "set_reminder", effect: "write", retry: "never" },
    { name: "cancel_reminder", effect: "write", retry: "never" },
    { name: "add_date", effect: "write", retry: "never" },
    { name: "remove_date", effect: "write", retry: "never" },
    { name: "mark_bill_paid", effect: "write", retry: "never" },
    { name: "ignore_bill", effect: "write", retry: "never" },
  ],
  sharedTools: ["get_current_time", "react_to_message"],
  routing: {
    patterns: [
      /\b(?:remind(?:er|ers)?|tasks?|to-?dos?|bills?|renewals?|birthdays?|anniversar(?:y|ies)|subscriptions?|promise[ds]?)\b/i,
    ],
    commandKinds: ["reminder", "task_add", "task", "bill", "date_add", "date"],
  },
  capabilities: [
    {
      name: "track_bill_with_reminder",
      description:
        "Record a bill and set a reminder some days before it is due. Takes the bill's details from the input or from an earlier step that read the bill.",
      kind: "workflow",
      effect: "write",
      retry: "never",
      usesLlm: false,
      inputSchema: {
        type: "object",
        properties: {
          biller: { type: "string" },
          amount: { type: "number" },
          currency: { type: "string" },
          due_date: { type: "string", description: "YYYY-MM-DD." },
          days_before: { type: "integer", description: "Defaults to 3." },
          tag: { type: "string", enum: ["work", "personal"] },
        },
        additionalProperties: false,
      },
      handler: async (input, ctx) => {
        const fromSteps = Object.assign({}, ...Object.values(ctx.dependencies).map((dep) => dep.output ?? {})) as Record<
          string,
          unknown
        >;
        const answer = ctx.resume?.input ?? {};
        const pick = (name: string): unknown => answer[name] ?? input[name] ?? fromSteps[name];
        const biller = typeof pick("biller") === "string" ? String(pick("biller")).trim() : "";
        const dueDate = typeof pick("due_date") === "string" ? String(pick("due_date")).trim() : "";
        const amount = typeof pick("amount") === "number" ? (pick("amount") as number) : null;
        const currency = typeof pick("currency") === "string" ? String(pick("currency")) : "INR";
        const daysBefore = typeof input.days_before === "number" && input.days_before >= 0 ? input.days_before : 3;
        const tag = input.tag === "work" ? "work" : "personal";
        if (!biller || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
          throw new InputRequiredSignal({
            question: !biller
              ? "I couldn't tell who the bill is from. Who is the biller, and when is it due?"
              : `I couldn't find a due date on the ${biller} bill. When is it due?`,
            fields: !biller ? ["biller", "due_date"] : ["due_date"],
            from: "user",
          });
        }
        const { trackPayableBill } = await import("../../bills.js");
        const tracked = trackPayableBill({
          biller,
          amount,
          currency,
          dueDate,
          threadId: `agent:${ctx.request.taskId}`,
          snippet: "",
        });
        let remindAt = reminderInstant(dueDate, daysBefore);
        const soonest = new Date(Date.now() + 5 * 60_000);
        const late = remindAt.getTime() < soonest.getTime();
        if (late) {
          remindAt = soonest;
        }
        const offset = new Date(remindAt.getTime() + 330 * 60_000).toISOString().slice(0, 19);
        const reminder = await ctx.runTool("set_reminder", {
          text: `Pay ${biller}${amount === null ? "" : ` (${currency} ${amount})`}, due ${dueDate}`,
          tag,
          remind_at: `${offset}+05:30`,
        });
        return {
          text: `${biller} bill ${tracked.action === "skipped" ? "was already handled" : `is tracked (${tracked.action})`}, due ${dueDate}. ${reminder}${late ? " It is due in under " + daysBefore + " days, so the reminder is set for now." : ""}`,
          output: {
            biller,
            due_date: dueDate,
            bill: tracked.action,
            ...(tracked.action === "skipped" ? {} : { bill_id: tracked.bill.id }),
            remind_at: `${offset}+05:30`,
          },
        };
      },
    },
  ],
  jobs: async (api) => {
    const { registerMorningBrief } = await import("../../brief.js");
    const { registerWeeklyReview } = await import("../../weekly.js");
    const { registerBillScan } = await import("../../bills.js");
    const { registerImportantDateReminders } = await import("../../important_dates.js");
    const { registerPromiseScan } = await import("../../promises.js");
    const { registerReminderScheduler } = await import("../../reminders.js");
    const reminders = await registerReminderScheduler(api);
    const jobs: Stoppable[] = [
      registerMorningBrief(api),
      registerWeeklyReview(api),
      registerBillScan(api),
      registerImportantDateReminders(api),
      registerPromiseScan(api),
      { stop: () => clearInterval(reminders) },
    ];
    return jobs;
  },
};
