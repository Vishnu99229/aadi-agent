import "dotenv/config";
import { getAccount } from "../src/db.ts";
import { decodeAccount, findAccountByName } from "../src/account_logic.ts";
import { decodedAccounts } from "../src/accounts.ts";
import { handler as addAccount } from "../src/tools/add_account.ts";
import { handler as updateAccount } from "../src/tools/update_account.ts";

const PINNACLE_PEOPLE = [
  "Armaan Ibrahim",
  "Hardik Singh",
  "Girish Rao",
  "Ananya Saxena",
  "Ashish Mehta",
  "Gunaseelan Sundar",
  "Pradeep Bhushetti",
  "Madhusudan Yadav",
  "Hidayathulla N S",
  "Sumeet Monga",
  "Jawahaar Aravind",
  "Pinnacle Support",
];

const ETERNAL_PEOPLE = [
  "Ananya Saxena",
  "Girish Rao",
  "Ashish Mehta",
  "Madhusudan Yadav",
  "Hardik Singh",
  "Gunaseelan Sundar",
];

const SHRIRAM_PEOPLE = [
  "Armaan Ibrahim",
  "Hardik Singh",
  "Hidayathulla N S",
  "Pradeep Bhushetti",
  "Jawahaar Aravind",
  "Sumeet Monga",
  "Pinnacle Support",
];

function upsert(input: {
  name: string;
  aliases: string;
  email_domains?: string;
  people: string;
  relationship: "partner" | "end_client";
  via_partner?: string;
}): number {
  const exact = findAccountByName(decodedAccounts(), input.name).find(
    (item) => item.name.toLowerCase() === input.name.toLowerCase(),
  );
  if (exact) {
    updateAccount({
      id: exact.id,
      aliases: input.aliases,
      email_domains: input.email_domains ?? "",
      people: input.people,
      relationship: input.relationship,
      via_partner: input.via_partner,
    });
    return exact.id;
  }
  const created = JSON.parse(addAccount(input)) as { id: number };
  return created.id;
}

const pinnacleId = upsert({
  name: "Pinnacle Teleservices",
  aliases: ["Pinnacle", ...PINNACLE_PEOPLE].join(", "),
  email_domains: "pinnacle.in",
  people: PINNACLE_PEOPLE.join(", "),
  relationship: "partner",
});

const eternalId = upsert({
  name: "Eternal",
  aliases: "Zomato",
  people: ETERNAL_PEOPLE.join(", "),
  relationship: "end_client",
  via_partner: "Pinnacle Teleservices",
});

const shriramId = upsert({
  name: "Shriram Life",
  aliases: "Shriram, SLIC, PIVC",
  people: SHRIRAM_PEOPLE.join(", "),
  relationship: "end_client",
  via_partner: "Pinnacle Teleservices",
});

for (const id of [pinnacleId, eternalId, shriramId]) {
  const account = decodeAccount(getAccount(id)!);
  console.log(
    `Account ${account.id}: ${account.name} (${account.relationship}` +
      `${account.via_partner_id ? ` via ${account.via_partner_id}` : ""})`,
  );
}
