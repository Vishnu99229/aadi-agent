import type { AccountRecord } from "../src/account_logic.ts";
import { splitDraftRecipients } from "../src/draft_recipients.ts";
import type { ParsedMailbox } from "../src/followup_logic.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function box(email: string, name = ""): ParsedMailbox {
  return { email, name };
}

const accounts: AccountRecord[] = [
  {
    id: 1,
    name: "Aspirare",
    aliases: ["aspirare"],
    email_domains: ["aspirare.in"],
    relationship: "end_client",
    via_partner_id: null,
    people: ["Satyapramod"],
    stage: "active",
    next_step: "",
    next_step_due: null,
    waiting_on: "me",
    last_activity_at: null,
    created_at: "",
  },
];

{
  const split = splitDraftRecipients(
    [
      box("ashwini@epicode.in", "Ashwini"),
      box("satyapramod@aspirare.in", "Satyapramod"),
      box("sendhil@epicode.in", "Sendhil"),
    ],
    "reminder",
    accounts,
  );
  assert(
    split.to.map((item) => item.email).join() === "satyapramod@aspirare.in",
    "single external company stays in To",
  );
  assert(
    split.cc.map((item) => item.email).join() ===
      "ashwini@epicode.in,sendhil@epicode.in",
    "epicode colleagues go to Cc",
  );
}

{
  const split = splitDraftRecipients(
    [
      box("ashwini@epicode.in"),
      box("satyapramod@aspirare.in", "Satyapramod"),
      box("sudhir.r@arthagroup.co.in"),
      box("sendhil@epicode.in"),
    ],
    "Epicode <> Aspirare call",
    accounts,
  );
  assert(
    split.to.map((item) => item.email).join() === "satyapramod@aspirare.in",
    "prospect company stays in To when two externals are present",
  );
  assert(
    split.cc.map((item) => item.email).includes("sudhir.r@arthagroup.co.in"),
    "other externals move to Cc",
  );
  assert(
    split.cc.map((item) => item.email).includes("ashwini@epicode.in"),
    "epicode stays in Cc",
  );
}

{
  const split = splitDraftRecipients(
    [
      box("satyapramod@aspirare.in", "Satyapramod"),
      box("sudhir.r@arthagroup.co.in", "Sudhir"),
    ],
    "to Satyapramod",
    accounts,
  );
  assert(
    split.to.map((item) => item.email).join() === "satyapramod@aspirare.in",
    "named person stays in To",
  );
  assert(
    split.cc.map((item) => item.email).join() === "sudhir.r@arthagroup.co.in",
    "unnamed external moves to Cc",
  );
}

console.log("Draft recipient checks passed.");
