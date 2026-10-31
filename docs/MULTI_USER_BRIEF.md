# Multi-user brief (from current `main`)

Verified against the repo at **`55211bb`**. Aadi today is a **single-owner** agent. This is the map of what is already parameterized, what is hardcoded to Vishnu, and what would have to change before a second person could use it safely. (No separate paste-in section arrived with the request; this file is the full code-backed brief.)

---

## What “one user” means in code

- Telegram: `bot.use(ownerOnly(OWNER_TELEGRAM_ID))` in `src/bot.ts`. Anyone else is dropped with no reply.
- One process, one long-poll, one SQLite file (`aadi.db`).
- Two Google identities, both Vishnu’s: personal Gmail (`google-token.json`) and Epicode work (`google-token-work.json`). Hardcoded mailbox strings in `src/google/authorize.ts`: work `vishnu.rajan@epicode.in`, personal `vishnu.rajan294@gmail.com`. Pre-meeting code also falls back to that work address (`SELF_FALLBACK` in `src/meetings.ts`).
- System prompt `prompts/system.md` is written in first person about Vishnu (Bangalore, Epicode GTM, GoSchedule.ai, language mix).
- GitHub `/build` owner/repo are constants in `src/config.ts`: `Vishnu99229` / `aadi-agent`.
- Hosting is one Android phone. Two Aadi processes break Telegram polling.

There is **no** tenant id, **no** per-user database, **no** per-user Google token map, **no** per-user system prompt.

`isOwnerWhatsApp` in `src/security/owner_lock.ts` is unused. It is not a second channel.

---

## What is already “two lanes”, not two users

Inside the single owner, almost every object is tagged **work** or **personal**: tasks, reminders, bills, notes, documents, memories, follow-ups, drafts (`google_account`). Calendar/mail tools take `account: "work" | "personal"`. Auto-scheduling and auto-book run only on the **work** inbox. That is Vishnu’s work/life split, not multi-tenancy.

---

## Safety gates that assume one human

These gates are correct for Vishnu and **wrong** if two people share the bot:

| Gate | Today | Multi-user risk |
| --- | --- | --- |
| Owner lock | One numeric Telegram id | A second id never gets a reply unless you add a user table and stop using a global middleware |
| Send / book / delete | Approval in *this* chat, or `sendConfirmation` from *this* turn | A shared bot would send mail as Vishnu’s Google user. There is no “send as the requester” |
| Auto-schedule | Sends from Epicode as Vishnu, books Vishnu’s work calendar | Would spam Vishnu’s customers if another user triggered inbox scan |
| `/build` | Changes *this* repo and deploys *this* phone | A second user must not ship to Vishnu’s device |
| `/backup` | Encrypts the whole `aadi.db` | Would dump Vishnu’s mail metadata, deals, and memories |
| Receipt check | Stops the model lying about send/search | Still needed per user; does not isolate data |
| Job queue | Plans from owner text; cannot send/book | Jobs write into the shared `tasks` / `documents` tables |

Reading Gmail/Calendar is ungated beyond owner lock: whoever is the owner sees **all** of both mailboxes.

---

## What you would have to split

Minimum to onboard a second person without mixing data:

1. **Identity:** table of users (Telegram id, timezone, which Google tokens, which prompt). Replace `ownerOnly(singleId)` with `ownerOnly(set)` *and* bind every query to `user_id`.
2. **SQLite:** add `user_id` to every table listed in `docs/Aadi_Handoff.md`, or one DB file per user. Settings (`llm_task_backends`, web-search daily cap, morning brief) are currently global.
3. **Google:** one OAuth pair per user, not two hard-coded paths. Calendar write scope only on that user’s work token. Auto-book must not run on Vishnu’s Epicode inbox for someone else.
4. **Prompt:** stop baking Vishnu’s biography into `prompts/system.md`; load a per-user file.
5. **Host:** either one process multiplexing users (still one Telegram bot token, several ids) or one bot per customer. Phone RAM already forbids a local LLM beside Aadi; a second heavy process on the same phone is a freeze risk (`src/local_llm_guard.ts`).
6. **`/build` / deploy / `.env`:** stay Vishnu-admin-only. Never expose `CURSOR_API_KEY`, `GITHUB_TOKEN`, `BACKUP_PASSWORD`, or the phone SSH path to end users.
7. **Web search cap / LLM credit flags:** today they are process-global (`web_search_count:*`, `llm_backend_flags`). Per-user caps would be required so one person cannot burn DeepSeek Search or trip the Anthropic 6h flag for everyone.

---

## What you could share unchanged

- Tool registry and approval-card pattern.
- Receipt check, deferred-action retry, job done-checks, CSP timeout.
- Model fallback chain and web-search provider order (keys still live in the operator `.env`).
- CI `test:security` ideas (owner lock, send gate, no send in model tools) — but tests today assume a single `OWNER_TELEGRAM_ID=1`.

---

## Practical recommendation

Keep Aadi single-owner. If a second person needs an agent, clone the **process + DB + Google tokens + prompt + Telegram bot**, do not add them to this instance. The current security model (silently ignore everyone else, send only as Vishnu’s Google accounts, deploy this phone) is the product.
