# Aadi Multi-User / Productisation Brief

Verified against the repo at **`55211bb`**. Every “multi-user” feature below is **not built**.

## The honest starting point

Aadi today is single-tenant: ONE person (Vishnu), one Telegram bot, one `.env` with one set of Google/DeepSeek/etc. tokens, one SQLite db with no “which user” column. Every “multi-user” feature below is NOT built. Before building any of it: there are zero paying users. The first job is to get ONE person to want Aadi enough to pay — ideally for the GTM features (email, meetings, follow-ups), which are the defensible part. Everything here is wasted if nobody pays.

## What “multi-user” actually requires (the real work, in order)

### 1. Per-user identity and data isolation (the foundation)

- Every table needs a `user_id`; every query scoped to it. One user must never see another's data.
- Separate token store per user (encrypted at rest), not one `.env`. Current `.env` model does not scale.
- One bot that routes by Telegram user id, OR one bot per user. Decide early; affects everything.
- This is a real rebuild, not a feature. Weeks, not a Cursor prompt.

### 2. Self-service OAuth onboarding (unlocks non-technical users)

- Today only Vishnu can connect accounts (he edits `.env` in Cursor). A real user can't.
- Needed: user says “connect my Google Calendar” → Aadi sends an OAuth link → user approves on Google's own page → tokens stored in THAT user's isolated store. No keys, no Cursor, no dev steps.
- Works for anything with OAuth: Google, Slack, Notion, GitHub. Does NOT work for Swiggy/Zomato/Amazon (no consumer API/OAuth — those are deep-link or computer-use only).
- This is the single most valuable multi-user piece AND a prerequisite for any pilot.

### 3. The Google 100-user / CASA ceiling (hard external limit)

- Unverified Google app = 100 users max, all see the “unverified app” warning.
- Gmail/Calendar are “restricted” scopes → going past 100 needs Google verification + a CASA security audit (third-party, annual, paid). Plan for this at ~pilot→scale boundary, not day one.
- 5-user pilot fits under the cap with no audit. Keep pilots ≤ a handful on personal Gmail.

### 4. Cost and billing

- Per-user LLM cost is a few $/user/month on DeepSeek today — but climbs fast with web search, documents, and especially any computer use. Must charge users; need a per-user spend cap and a billing mechanism (even manual invoicing at first). No free scaling.

### 5. Legal / liability (the part that's easy to ignore and expensive to get wrong)

- Holding other people's email + tokens on a server under a personal name is a real liability.
- Needs: a registered business (a proprietorship is enough to start — also unblocks WhatsApp), a privacy policy + terms, and clarity that Aadi never stores OTPs/passwords/card data.
- Computer use (ordering/paying on users' accounts) multiplies this risk — do NOT offer it to other users until there's a company and proper terms.

### 6. The action-routing tiers (for the “everything-agent” vision)

- API/MCP first → deep link second → computer use last. Build the first two (safe, cheap).
- Computer use (cloud browser/phone sandboxes, one isolated per user) is tier 3, last resort, only for no-API services, only once there's a business + revenue. Reserve `COMPUTER_USE_ENABLED` flag now; don't build it yet. **That flag is not in the repo today.**

## Recommended sequence

1. Get ONE paying user on the GTM features as-is (connect their accounts by hand).
2. If they pay: build per-user isolation + self-service OAuth (items 1–2).
3. Register a business; add terms/privacy; set up billing (items 4–5).
4. Grow to ~5–10 under the Google cap; add deep-link actions (item 6 tiers 1–2).
5. Only then: Google verification/CASA for >100, and computer use tier 3 if genuinely needed.

## Do NOT

- Build multi-user infra before one person pays.
- Offer computer use / order-and-pay to other users before there's a registered company + terms.
- Store any user's OTP/password/card/account numbers, ever (current rule — keep it).
- Assume Swiggy/Zomato/Amazon can be “integrated” — they can't; deep-link or computer-use only.

---

## Verified against current `main` (what the code actually is)

This section is the repo, not the plan. It is why item 1 is a rebuild.

### What “one user” means in code

- Telegram: `bot.use(ownerOnly(OWNER_TELEGRAM_ID))` in `src/bot.ts`. Anyone else is dropped with no reply.
- One process, one long-poll, one SQLite file (`aadi.db`). No `user_id` column on any table (see `docs/Aadi_Handoff.md`).
- Two Google identities, both Vishnu’s: personal Gmail (`google-token.json`) and Epicode work (`google-token-work.json`). Hardcoded mailbox strings in `src/google/authorize.ts`. Pre-meeting code falls back to the work address (`SELF_FALLBACK` in `src/meetings.ts`).
- System prompt `prompts/system.md` is written about Vishnu (Bangalore, Epicode GTM, GoSchedule.ai).
- GitHub `/build` owner/repo are constants in `src/config.ts`.
- Hosting is one Android phone. Two Aadi processes break Telegram polling.
- `isOwnerWhatsApp` in `src/security/owner_lock.ts` is unused. It is not a second channel.

There is **no** tenant id, **no** per-user database, **no** per-user Google token map, **no** per-user system prompt, **no** `COMPUTER_USE_ENABLED`.

### Work vs personal is not multi-user

Inside the single owner, objects are tagged **work** or **personal**. Calendar/mail tools take `account: "work" | "personal"`. Auto-scheduling and auto-book run only on the **work** inbox. That is Vishnu’s work/life split, not tenancy.

### Safety gates that assume one human

| Gate | Today | If a second person shared this bot |
| --- | --- | --- |
| Owner lock | One numeric Telegram id | They never get a reply unless you add a user table |
| Send / book / delete | Approval in this chat, or `sendConfirmation` from this turn | Mail still sends as Vishnu’s Google user |
| Auto-schedule | Epicode as Vishnu, Vishnu’s work calendar | Would hit Vishnu’s customers |
| `/build` | This repo, this phone | Must stay admin-only |
| `/backup` | Whole `aadi.db` | Would dump Vishnu’s mail metadata, deals, memories |
| Job queue | Plans from owner text; cannot send/book | Writes into shared `tasks` / `documents` |
| LLM credit flags / web-search daily cap | Process-global | One user could burn the cap for everyone |

Reading Gmail/Calendar is ungated beyond owner lock: the owner sees **all** of both mailboxes.

### What isolation would have to split (when you actually build item 1)

1. Users table (Telegram id, timezone, tokens, prompt). Scope every query.
2. Encrypted per-user token store — not `.env`. Self-service Google OAuth (item 2); calendar write scope only on that user’s work token.
3. Per-user prompt; stop baking Vishnu’s biography into `prompts/system.md`.
4. Host: one bot routing by Telegram id, or one bot per customer. Phone RAM already forbids a local LLM beside Aadi (`src/local_llm_guard.ts`).
5. `/build`, deploy, `.env` names `CURSOR_API_KEY`, `GITHUB_TOKEN`, `BACKUP_PASSWORD`, and phone SSH stay Vishnu-admin-only.
6. Per-user spend cap (today: global `web_search_count:*`, `llm_backend_flags`, `usage_log` with no user column).

Reusable as-is later: tool registry, approval cards, receipt check, job done-checks, CSP timeout, model fallback, web-search provider order. CI `test:security` still assumes a single `OWNER_TELEGRAM_ID`.

Until someone pays, keep this instance single-owner. If a second person needs an agent before isolation exists, clone process + DB + tokens + prompt + bot — do not add them here.
