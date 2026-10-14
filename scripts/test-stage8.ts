import "dotenv/config";

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
  accountMatchesEmail,
  accountMatchesText,
  accountMatchesThread,
  decodeAccount,
  findAccountByName,
  findAccountsInText,
  formatAccountListLine,
  formatAccountStatus,
  latestActivityIso,
  suggestedNextStep,
  suggestedUpdateFromWrapUp,
} = await import("../src/account_logic.ts");
const { handler: addAccount } = await import("../src/tools/add_account.ts");
const { handler: updateAccountTool } = await import(
  "../src/tools/update_account.ts"
);
const { handler: listAccounts } = await import("../src/tools/list_accounts.ts");
const { handler: removeAccountTool } = await import(
  "../src/tools/remove_account.ts"
);
const {
  createNote,
  createTask,
  getAccount,
  updateAccountActivity,
} = await import("../src/db.ts");

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const stamp = Date.now();
const NAME = `Stage8 TestCo ${stamp}`;

function testCrudAndStaleOrder(): void {
  const created = JSON.parse(
    addAccount({
      name: NAME,
      aliases: "TestCo, Priya Test",
      email_domains: "testco-stage8.example",
      stage: "discussion",
    }),
  ) as { id: number };
  const older = JSON.parse(
    addAccount({
      name: `${NAME} Older`,
      email_domains: "older-stage8.example",
    }),
  ) as { id: number };
  updateAccountActivity(older.id, "2020-01-01T00:00:00.000Z");
  updateAccountActivity(created.id, "2026-10-01T00:00:00.000Z");
  const listed = listAccounts({});
  const olderLine = listed.indexOf(`#${older.id}`);
  const newerLine = listed.indexOf(`#${created.id}`);
  assert(olderLine >= 0 && newerLine >= 0, "both accounts listed");
  assert(olderLine < newerLine, "most stale first");
  const before = getAccount(created.id)!;
  assert(before.stage === "discussion", "stage stored");
  const unchanged = getAccount(created.id)!;
  assert(unchanged.stage === "discussion", "stage not silently changed");
  const updated = JSON.parse(
    updateAccountTool({
      id: created.id,
      stage: "proposal",
      next_step: "Send revised quote",
      waiting_on: "me",
    }),
  ) as { updated: boolean; stage: string };
  assert(updated.updated && updated.stage === "proposal", "update only when asked");
  const removed = JSON.parse(removeAccountTool({ id: older.id })) as {
    removed: boolean;
  };
  assert(removed.removed, "remove_account works");
}

function testMatchingAndStatus(): void {
  const row = getAccount(
    (
      JSON.parse(
        addAccount({
          name: `${NAME} Match`,
          aliases: "Vinfer Test",
          email_domains: "slic-stage8.example",
        }),
      ) as { id: number }
    ).id,
  )!;
  const account = decodeAccount(row);
  assert(
    accountMatchesEmail(account, "kyc@slic-stage8.example"),
    "match email domain",
  );
  assert(
    !accountMatchesEmail(account, "other@unrelated.com"),
    "reject other domain",
  );
  assert(
    accountMatchesText(account, "Call notes with Vinfer Test on KYC"),
    "match alias in notes",
  );
  const found = findAccountsInText(
    [account],
    "Wrap up: SLIC KYC with Vinfer Test",
  );
  assert(found.length === 1, "find account in wrap-up text");
  createTask("Send SLIC KYC deck to Vinfer Test", "work", null);
  createNote(
    "SLIC KYC working session",
    "Vinfer Test",
    "work",
    "They will share the API spec next week.",
    [{ text: "Share API spec", owner: "other", owner_email: null, tag: "work", due_at: null }],
  );
  const interactions = [
    {
      kind: "email" as const,
      date: "10 Oct 2026",
      dateMs: Date.parse("2026-10-10T10:00:00+05:30"),
      text: "KYC timeline",
    },
    {
      kind: "note" as const,
      date: "12 Oct 2026",
      dateMs: Date.parse("2026-10-12T10:00:00+05:30"),
      text: "SLIC KYC working session",
    },
  ];
  const openItems = [
    { kind: "follow-up" as const, text: "KYC timeline (kyc@slic-stage8.example)" },
    { kind: "task" as const, text: "Send SLIC KYC deck to Vinfer Test" },
    { kind: "promised" as const, text: "Share API spec" },
  ];
  const status = formatAccountStatus({
    account: { ...account, stage: "discussion", next_step: "", waiting_on: "nobody" },
    interactions,
    openItems,
  });
  assert(status.includes("Last interactions:"), "has interactions");
  assert(status.includes("KYC timeline"), "email thread line");
  assert(status.includes("follow-up:"), "open follow-up");
  assert(status.includes("promised:"), "promised item");
  assert(
    suggestedNextStep({
      account: { ...account, next_step: "" },
      openItems,
      interactions,
    }).includes("KYC timeline"),
    "suggested next step from a real follow-up",
  );
  assert(
    suggestedNextStep({
      account: { ...account, next_step: "" },
      openItems: [],
      interactions: [],
    }).includes("No suggested next step"),
    "do not invent a next step",
  );
  const activity = latestActivityIso(interactions);
  assert(activity?.startsWith("2026-10-12"), "last_activity from newest item");
  updateAccountActivity(account.id, activity!);
  assert(
    getAccount(account.id)?.last_activity_at?.startsWith("2026-10-12"),
    "last_activity_at persisted",
  );
  const line = formatAccountListLine(decodeAccount(getAccount(account.id)!));
  assert(line.includes(account.name) && line.includes("last 2026-10-12"), "list line");
  const lookup = findAccountByName([account], "slic-stage8.example");
  assert(lookup.length === 1, "find by domain");
}

function testWrapUpConfirmIsExplicit(): void {
  const account = decodeAccount(
    getAccount(
      (
        JSON.parse(
          addAccount({
            name: `${NAME} Wrap`,
            aliases: "WrapCo",
            stage: "discussion",
            next_step: "Intro call",
            waiting_on: "nobody",
          }),
        ) as { id: number }
      ).id,
    )!,
  );
  const none = suggestedUpdateFromWrapUp(account, {
    title: "Random chat",
    people: "WrapCo",
    content: "Caught up. No decisions.",
    decisions: [],
    action_items: [],
  });
  assert(none === undefined, "no button when wrap-up has nothing to change");
  const offer = suggestedUpdateFromWrapUp(account, {
    title: "Proposal review",
    people: "WrapCo",
    content: "They asked for a proposal. Vishnu will send it Friday.",
    decisions: ["Move to proposal"],
    action_items: [{ text: "Send proposal Friday", owner: "vishnu" }],
  });
  assert(offer?.stage === "proposal", "stage from explicit wrap-up wording");
  assert(offer?.next_step === "Send proposal Friday", "next step from action item");
  assert(offer?.waiting_on === "me", "waiting on me");
}

function testPartnerEndClientModel(): void {
  const partner = decodeAccount(
    getAccount(
      (
        JSON.parse(
          addAccount({
            name: `${NAME} Pinnacle`,
            aliases: "Pinnacle",
            email_domains: "pinnacle-stage8.example",
            relationship: "partner",
          }),
        ) as { id: number }
      ).id,
    )!,
  );
  const eternal = decodeAccount(
    getAccount(
      (
        JSON.parse(
          addAccount({
            name: `${NAME} Eternal`,
            aliases: "Eternal, Zomato",
            email_domains: "eternal-stage8.example",
            people: "Ananya Saxena, Girish Rao",
            relationship: "end_client",
            via_partner: `${NAME} Pinnacle`,
          }),
        ) as { id: number }
      ).id,
    )!,
  );
  assert(eternal.relationship === "end_client", "eternal is end_client");
  assert(eternal.via_partner_id === partner.id, "eternal linked to pinnacle");
  assert(eternal.people.includes("Ananya Saxena"), "people stored for display");
  assert(
    accountMatchesThread(
      eternal,
      {
        from: "ops@eternal-stage8.example",
        to: "vishnu@epicode.in",
        subject: "Voice panel",
      },
      partner,
    ),
    "end client own domain matches",
  );
  assert(
    accountMatchesThread(
      eternal,
      {
        from: "sales@pinnacle-stage8.example",
        to: "vishnu@epicode.in",
        subject: "Eternal voice panel deal",
      },
      partner,
    ),
    "pinnacle thread with Eternal in the subject matches the end client",
  );
  assert(
    accountMatchesThread(
      eternal,
      {
        from: "sales@pinnacle-stage8.example",
        to: "vishnu@epicode.in",
        subject: "Sandbox",
        body: "Please provision Zomato voice panel access",
      },
      partner,
    ),
    "end client matches name in the body",
  );
  assert(
    !accountMatchesThread(
      eternal,
      {
        from: "Ananya Saxena <ananya.saxena@pinnacle-stage8.example>",
        to: "vishnu@epicode.in",
        subject: "Weekly partner sync",
        body: "Agenda for tomorrow",
      },
      partner,
    ),
    "pinnacle contact does not match the end client",
  );
  assert(
    accountMatchesThread(partner, {
      from: "Ananya Saxena <ananya.saxena@pinnacle-stage8.example>",
      to: "vishnu@epicode.in",
      subject: "Weekly partner sync",
    }),
    "pinnacle domain matches only the partner",
  );
  const partnerStatus = formatAccountStatus({
    account: { ...partner, people: ["Hardik Singh"] },
    interactions: [],
    openItems: [],
    linkedEndClients: [eternal],
  });
  assert(partnerStatus.includes("People: Hardik Singh"), "people are display-only");
  assert(partnerStatus.includes("Relationship: partner"), "partner label");
  assert(partnerStatus.includes("End clients:"), "lists end clients");
  assert(partnerStatus.includes(eternal.name), "end client name on partner status");
  const eternalStatus = formatAccountStatus({
    account: eternal,
    interactions: [
      {
        kind: "email",
        date: "10 Oct 2026",
        dateMs: Date.parse("2026-10-10T10:00:00+05:30"),
        text: "Eternal voice panel deal",
      },
    ],
    openItems: [],
    viaPartnerName: partner.name,
  });
  assert(eternalStatus.includes(`Via partner: ${partner.name}`), "via partner line");
  assert(
    eternalStatus.includes("Eternal voice panel deal"),
    "includes the pinnacle thread",
  );
  const line = formatAccountListLine(eternal, partner.name);
  assert(line.includes("end client via"), "list line shows via partner");
}

testCrudAndStaleOrder();
testMatchingAndStatus();
testWrapUpConfirmIsExplicit();
testPartnerEndClientModel();
console.log("Stage 8 checks passed.");
