# Aadi handoff

Regenerated from the repo at **`55211bb`** on `main` (31 Oct 2026). Do not treat older handoffs as current. Timezone for everything user-facing is **Asia/Kolkata**.

Aadi is Vishnu’s personal Telegram agent. One process, one owner, one SQLite file. The model decides; TypeScript executes tools.

---

## Architecture

### Runtime

- **Interface:** Telegram bot (grammY, long polling) in `src/bot.ts`. No HTTP server, no WhatsApp path wired up (owner-lock helpers for WhatsApp numbers exist in `src/security/owner_lock.ts` but the bot never uses them).
- **Brain:** `src/agent.ts` `runAgent` — up to **8** tool-use iterations. `complete()` in `src/llm.ts` talks to Claude (official `@anthropic-ai/sdk`) or OpenAI-compatible DeepSeek / Gemini / local Gemma.
- **Tools:** one file per tool under `src/tools/`, registered in `src/tools/index.ts` as `TOOL_ORDER` (fixed order so Anthropic’s cached tool prefix does not churn).
- **Store:** SQLite via `better-sqlite3` (`src/db.ts`). Path `AADI_DB_PATH` or `./aadi.db`. Live DB is the phone’s `~/aadi-agent/aadi.db`. Deploy never copies `*.db` or Google token files.
- **Stack:** TypeScript, Node 20+, ESM, `tsx` in dev (`npm start` / `npm run dev`).
- **Prompt:** `prompts/system.md` (cacheable) plus a dynamic block (Kolkata clock, send-intent context, recent upload, memories, folded history summary).

### Agent loop (`src/agent.ts`)

1. Load system prompt, memories, history (fold older turns into a summary).
2. Call `complete()` with **all** `TOOL_ORDER` function tools. Chat backend comes from `/model` (`getTaskBackend`) unless the caller passed one.
3. If `stopReason === "tool_use"`, run **client** tools in `src/tools/*`. Provider-side tools are not used on the default path.
4. Guards before accepting a final reply:
   - **Calendar:** if the user asked about schedule and `list_events` was not called, force it once.
   - **Deferred action:** if the reply says it will check/search later (`src/deferred_action.ts`), retry once (“Do that now”).
   - **Receipt:** if the reply claims sent/booked/searched/etc. without a successful matching tool this turn (`src/receipt.ts`), retry once, then replace the reply with a failure line.
5. After a successful `web_search`, append any missing source titles/URLs.
6. Turn wrapper (`src/turns.ts`): 60s timeout, Retry button, outcomes in `chat_turns`.

### Model fallback cascade (`src/llm.ts` + `src/llm_fallback.ts`)

`complete()` walks `getFallbackChain(primary)`:

1. The requested backend (from `/model` or the caller).
2. Then `FALLBACK_CHAIN` or the default rest: **`deepseek`, `gemini`, `haiku`, `claude`**.

Skip a backend if it has no API key, or if it is Anthropic (`claude` / `haiku`) and either side is **credit-flagged**. Credit/auth errors (402, insufficient credit, invalid key, unauthorized) set `llm_backend_flags` for **6 hours**; flagging Haiku also flags Claude and vice versa. DeepSeek/Gemini network failures cascade to the next usable backend; they do **not** jump straight to Claude if a non-Anthropic option remains.

`completeBackground()` (classification: bills, follow-ups, etc.) prefers DeepSeek when `DEEPSEEK_API_KEY` is set, else the `/model` brief backend.

Vision (photos) uses `imageVisionBackends()`: Gemini first, then other vision-capable backends in the same chain. PDFs stay on Anthropic in the chain (`hasPdf` skips non-Anthropic). DeepSeek document extract uses `json_object` (not `json_schema`) plus a one-shot retry if dates/amounts are empty (`src/document_llm.ts`).

Local Gemma (`backend=local-gemma`) is blocked on the phone and whenever Aadi is already running (`src/local_llm_guard.ts`). It is not in the default cascade.

### Which model does which task (`src/chat_backend.ts`)

Persisted in SQLite setting `llm_task_backends` (and effort in `llm_task_efforts`). `/model` edits this. Code defaults after the `v3-gemini-migration` generation: **Haiku 5.5 for all five tasks**. Vishnu can set each independently:

| Task | Setting key | Used for |
| --- | --- | --- |
| `chat` | Chat and questions | Normal Telegram turns |
| `brief` | Morning brief and weekly review | `/brief`, `/weekly`, scheduled brief |
| `documents` | PDFs, contracts, RFPs | Upload analysis, job steps |
| `meetings` | Meeting briefs and account status | Pre-meeting brief, `/accounts` status |
| `drafting` | Email drafting | Draft tools |

Display names: Haiku 5.5, Claude Sonnet 5.5, DeepSeek Flash, Gemini 3.6 Flash. Effort (`low` / `medium` / `high`) applies only to Haiku and Sonnet. Code model ids: `CLAUDE_MODEL`, `BACKGROUND_MODEL` (default `claude-haiku-5-5`), `DEEPSEEK_MODEL` (default `deepseek-flash`), `GEMINI_MODEL` (default `gemini-3.6-flash`).

`LLM_PROVIDER` must be `claude` (fail-fast). It does not choose the chat backend; `/model` does.

### Web search tiers (`src/web_search.ts`)

The model only calls the **function** tool `web_search`. Code picks the provider:

1. **DeepSeek Search API** `POST https://api.deepseek.com/v1/tools/search` (reuses `DEEPSEEK_API_KEY`)
2. **Gemini grounding** native `generateContent` + `google_search` (not the OpenAI-compat chat path)
3. **Claude** server `web_search_20250305` with `allowed_callers: ["direct"]`, skipped if Anthropic is keyless or credit-flagged

Override with `WEB_SEARCH_ORDER` and optional pin `WEB_SEARCH_PROVIDER`. Daily cap `WEB_SEARCH_DAILY_CAP` (default **100**, Kolkata day, setting `web_search_count:YYYY-MM-DD`). Cap hit → tool returns `Not searched: reached today's search limit`. All providers fail → `Not searched: no provider returned results` (no invented hits). Logs are `provider=` / `status=` / `hits=` only.

### Caching

Anthropic prompt cache, **three** breakpoints per request (`src/llm.ts`): tools, stable system prompt, latest message.

- **1h** TTL for chat-like usage tasks.
- **5m** TTL for brief, classification, document, contract review, memory extraction, `other`.

DeepSeek reports cache-read tokens; Gemini cache rates are zero in config. History folding (`src/chat_history.ts`): keep last **30** messages, fold **10** at a time, ~**8000** token budget; long tool outputs stubbed after **1500** chars. Tool list order is frozen so the cached tools prefix stays stable.

---

## Live features (command + safety gate)

Gates in one line: **owner lock** = ignore anyone except `OWNER_TELEGRAM_ID`. **Send/book/delete** = Telegram approval tap, unless an aadi.mdc exception below. **Receipt** = cannot claim the action without a successful tool this turn.

### Telegram commands

| Command | What it does | Gate |
| --- | --- | --- |
| `/start` | Greeting | Owner lock |
| `/reset` | Clears `messages` conversation history (not memories, not DB) | Owner lock |
| `/memory` | List memories; forget buttons | Owner lock; forget is a tool / button, not a silent delete of others’ data |
| `/brief` | Run morning brief now | Owner lock; read-only to Vishnu |
| `/weekly` | Run weekly review now | Owner lock |
| `/menu` | Command menu | Owner lock |
| `/model` | Per-task backend + effort panel | Owner lock; no spend |
| `/build <task>` | Cursor cloud agent against this repo | Owner lock; confirm card; CI; protected-path block; optional auto-merge |
| `/builds` | Recent `/build` runs | Owner lock |
| `/showkeyboard` `/hidekeyboard` | Reply keyboard | Owner lock |
| `/followups` | Scan + list waiting-on-reply threads | Owner lock; read Gmail |
| `/jobs` | Running/recent multi-step jobs; cancel from chat | Owner lock; jobs cannot send/book |
| `/health` | Version, turns, LLM credit flags, heartbeat, last-success per job | Owner lock |
| `/meetings` | Auto-handled meeting threads | Owner lock |
| `/cost` | Token cost report | Owner lock |
| `/accounts` | Deal list | Owner lock |
| `/backup` | Encrypted `aadi.db` to Telegram | Owner lock; requires `BACKUP_PASSWORD`; AES-256-CBC |
| `/next` | Pre-meeting brief for the next work meeting | Owner lock |
| `/wrapup` | Save call/meeting notes | Owner lock |

Also on the bot menu (set at startup): `/followups`, `/model`, `/build`, `/builds`, `/health`, `/memory`, `/meetings`, `/reset`, `/jobs`.

Retry callback `retry:<turnId>` re-runs the last failed user text for that turn.

### Chat tools (no slash command)

Reading / searching / drafting is free. Side effects:

| Tool / flow | Gate |
| --- | --- |
| `search_emails`, `read_email`, `list_events`, `read_document`, `search_drive`, `web_search`, lists of tasks/bills/dates/notes/QA | Read-only |
| `draft_reply`, `draft_new_email` | Default: Send / Edit / Discard card (`pending_actions`). **Exception:** `send_immediately: true` on Vishnu’s own chat/voice turn (`sendConfirmation` present) — `allowOwnerChatSendDraft`. Never from email body text |
| `confirm_send_pending_draft` | Vishnu’s chat confirmation of a listed draft; still goes through `performDraftSend` |
| `propose_calendar_event` | Create Event approval card |
| `create_meeting` | Owner chat/voice is the approval (`allowOwnerChatCreateEvent`); work calendar + Meet; never from email text |
| `delete_calendar_event` | Owner chat/voice (`allowOwnerChatDeleteEvent`); never from email text |
| `add_calendar_attendee` | Owner chat/voice (`allowOwnerChatAddAttendee`); `sendUpdates=all`; never from email text |
| `draft_mom` | New work email, still Send / Edit / Discard |
| Auto-scheduling email (`sendSchedulingEmail`) | **No tap.** Only the three fixed templates (proposal / clarify / confirm) with a validated opening line; may create/patch calendar for booked meetings |
| Auto-book from Epicode inbox | Address gate + confidence + daily caps (`AUTO_BOOK_DAILY_CAP`, `AUTO_SEND_DAILY_CAP`); template body must match; `scripts/test-security.ts` forges From/Cc |
| Voice notes | Needs `SARVAM_API_KEY`; ≤30s; transcript is treated as Vishnu’s chat (same sendConfirmation) |
| Photos / PDFs / Drive | Ingest to `documents` (7-day expiry); analysis via document backends |
| Jobs (RFP / every-question) | Plan from **owner text only**; forbidden step types `send` / `book` / calendar writes; done-checks; $0.50 default budget; 3 attempts; stuck 10 min |

### Scheduled jobs (`src/index.ts` + `src/scheduler.ts`)

Self-scheduling `setTimeout`, Asia/Kolkata. Last success in `job_runs`. Catch-up: 4h for daily, 12h for weekly. Job timeout 5 min (job-queue 10 min). Heartbeat file written on success.

| Job | When | Gate |
| --- | --- | --- |
| `morning-brief` | `BRIEF_TIME` (default 08:00) | Off until setting `morning_brief=on` |
| `bill-scan` | `BILL_SCAN_TIME` (default 09:00); prefers DeepSeek off-peak | Classify only; no send |
| `followup-scan` | `FOLLOWUP_SCAN_TIME` (default 10:00) | Nudge Telegram; no auto-send mail |
| `important-dates` | 09:00 daily | Telegram ping |
| `promise-scan` | Weekdays 09:00; DeepSeek off-peak preferred | Creates open tasks from work Sent; not a mail send |
| `weekly-review` | `WEEKLY_REVIEW_TIME` default 19:00 Sundays | Telegram only |
| `weekly-backup` | Sundays 21:00 | Encrypted file to Telegram if `BACKUP_PASSWORD` set |
| `meeting-inbox` | every 10 min | Auto-schedule templates only |
| `meeting-poll` | every 2 min | Same |
| `meeting-pending` | every 1 min | Delayed auto-book after `AUTO_BOOK_DELAY_MINUTES` |
| `meeting-prebrief` | every 5 min | Telegram brief `PRE_MEETING_MINUTES` before work meetings with externals |
| `attachment-alerts` | every 10 min | Review / Ignore buttons; no analyse until Review |
| `build-poll` | every 1 min | CI + protected areas |
| `job-queue` | every 1 min | Done-checks; no send/book steps |
| Reminder tick | every 1 min | Telegram reminders |
| Document expiry | daily | Deletes `documents` older than 7 days |
| Approval expiry | hourly | Draft cards 3h; create-event cards 24h |

---

## `.env` key names (never values)

Required at process start (`src/security/env_guard.ts`): `TELEGRAM_BOT_TOKEN`, `OWNER_TELEGRAM_ID`, `BRIEF_TIME`, `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`.

| Name | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot API |
| `OWNER_TELEGRAM_ID` | Sole Telegram user who gets replies |
| `BRIEF_TIME` | Morning brief clock `HH:MM` |
| `ANTHROPIC_API_KEY` | Claude / Haiku / Claude web-search fallback |
| `CLAUDE_MODEL` | Sonnet model id |
| `BACKGROUND_MODEL` | Haiku id for `/model` haiku and some background paths (default `claude-haiku-5-5`) |
| `LLM_PROVIDER` | Must be `claude` |
| `FOLLOWUP_AFTER_HOURS` | Hours before a sent mail is “waiting” (default 72) |
| `FOLLOWUP_SCAN_TIME` | Follow-up scan clock |
| `BILL_SCAN_TIME` | Bill scan clock |
| `WEEKLY_REVIEW_TIME` | Sunday review clock |
| `PRE_MEETING_MINUTES` | Comma list e.g. `15,10,5` |
| `SKIP_INTERNAL_RECURRING` | Skip internal recurring events in briefs (default true) |
| `GOOGLE_SHEET_ID` | Optional sheet; `none` disables |
| `GEMINI_API_KEY` | Gemini chat, vision, grounding |
| `GEMINI_MODEL` | Default `gemini-3.6-flash` |
| `DEEPSEEK_API_KEY` | Chat + Search API |
| `DEEPSEEK_MODEL` / `DEEPSEEK_REASONER_MODEL` | Default `deepseek-flash` |
| `SARVAM_API_KEY` | Voice transcription |
| `VOICE_NOTES_ENABLED` | Deploy.sh only: if true, `SARVAM_API_KEY` is required to deploy |
| `BACKUP_PASSWORD` | openssl AES-256-CBC for Telegram DB copies |
| `GOOGLE_VISION_API_KEY` | Optional photo OCR |
| `CURSOR_API_KEY` | `/build` cloud agents |
| `GITHUB_TOKEN` | `/build` PRs (repo `Vishnu99229/aadi-agent`) |
| `AUTO_DEPLOY` | Merge+phone deploy when CI is green and no protected paths |
| `MEETING_TIMEZONE` | Default Asia/Kolkata |
| `MEETING_HOURS` / `MEETING_BREAK` | Slot window `HH:MM-HH:MM` |
| `MEETING_BUFFER_MINUTES` | Buffer between meetings |
| `MEETING_DEFAULT_MINUTES` | Default duration |
| `MEETING_SLOTS_TO_OFFER` | How many slots to propose |
| `MEETING_MIN_NOTICE_HOURS` | Earliest bookable |
| `MEETING_HORIZON_DAYS` | How far to search |
| `MEETING_HOLDS_ON_PROPOSE` | Optional hold events |
| `AUTO_BOOK` | Inbox auto-book on/off |
| `MEETING_MODE` | `auto` or `assist` |
| `AUTO_BOOK_DELAY_MINUTES` | Delay before sending confirm |
| `AUTO_BOOK_DAILY_CAP` | Max auto-books / Kolkata day |
| `AUTO_SEND_DAILY_CAP` | Max auto scheduling emails / day |
| `AUTO_BOOK_MIN_CONFIDENCE` | Classifier threshold |
| `MEETING_TEST_SENDERS` | Extra From addresses treated as prospects |
| `WEB_SEARCH_ORDER` | Default `deepseek,gemini,claude` |
| `WEB_SEARCH_PROVIDER` | Optional pin, tried first |
| `WEB_SEARCH_DAILY_CAP` | Default 100 |
| `FALLBACK_CHAIN` | Override LLM rest chain (not in `.env.example`) |
| `AADI_DB_PATH` | SQLite path; tests use `:memory:` |
| `LOCAL_LLM_BASE_URL` / `LOCAL_LLM_MODEL` | Ollama; Mac-only |
| `LLM_*_COST_PER_MILLION` | Sonnet rates (input/output/cache write/read, plus `LLM_CACHE_CREATION_1H_COST_PER_MILLION`) |
| `BACKGROUND_*_COST_PER_MILLION` | Haiku rates |
| `GEMINI_*_COST_PER_MILLION` | Gemini rates |
| `DEEPSEEK_*_COST_PER_MILLION` | DeepSeek rates |
| `PHONE_HOST` | Deploy SSH host override (script, default `i2301`) |
| `DOTENV_CONFIG_PATH` | Tests only (`scripts/fixtures/test.env`) |

Not env: `google-credentials.json`, `google-token.json` (personal Gmail), `google-token-work.json` (Epicode). Gitignored. Work calendar write scope is only on the work token.

---

## Security gates and the tests that enforce them

### Owner lock

`bot.use(ownerOnly(config.ownerTelegramId))` in `src/bot.ts`. Non-owner updates return without `next()`. `scripts/test-security.ts` checks stranger ids are ignored, owner is handled, and `bot.ts` must **import** `ownerOnly` (not inline a copy).

### Send / book / delete gate

`src/security/send_approval.ts`:

- `allowSendDraft` — Send button `approval:send:<id>` on a **pending** row.
- `allowCreateEvent` — Create button `approval:create:<id>`.
- Owner-chat exceptions: `allowOwnerChatSendDraft`, `allowOwnerChatCreateEvent`, `allowOwnerChatDeleteEvent`, `allowOwnerChatAddAttendee` — require a real `chatId` + `messageId` from Vishnu’s turn.

`approvals.ts` `sendDraft` must call `allowSendDraft` **before** `performDraftSend`. Text “send it” goes through `sendPendingDraftByText` → same `performDraftSend`. Auto-scheduling mail is **not** this gate; it is `sendSchedulingEmail` with a frozen template.

`test-security.ts` also: no `messages.send` / `drafts.send` / `events.insert|patch|delete` in model tool files; tools index has no `send_email` / `book_meeting`; forged inbox From/Cc cannot book; auto-book daily cap; template mismatch refuses send.

### Receipt check

`src/receipt.ts` + agent retry. Claimed actions: sent, booked, created, scheduled, saved, discarded, reminded, invited, deleted, updated, answered, completed, **searched**. `scripts/test-anti-laziness.ts` (send) and `scripts/test-web-search.ts` (live-news without search).

### Job done-checks and autonomy

`src/job_logic.ts`: each step type has a `done_condition` (`chunks_processed`, `answers_eq_questions`, `draft_ready`, `text_exists`, `count_gte`, `tasks_created`). A step is not `done` until `evaluateDoneCheck` passes. Forbidden types (send/book/calendar) are stripped in `sanitizePlan`. Budget pause at `budget_usd` (default $0.50). `scripts/test-jobs.ts`: injection of “send the contract to attacker@…” is dropped; over-budget pauses; retries; skip dependents.

`scripts/test-autonomy.ts`: JWZ threading + near-dupe + CSP timeout so the event loop cannot freeze on the phone.

### `/build` merge gate

`src/build_logic.ts` protected areas: `src/security/`, `deploy.sh` + `scripts/phone-*`, backup logic, `local_llm_guard.ts`, `.cursor/rules`, `.github/workflows`. Touching those → Telegram Deploy / Ask / Discard, no auto-merge. `scripts/test-merge-ready.ts`. `AUTO_DEPLOY=true` only merges when CI is green and protected list is empty. Phone apply: `scripts/phone-self-deploy.sh` (zip of main, rollback copy, never overwrites `aadi.db` / Google tokens).

### Env / secrets

`.env` gitignored. `redactSecrets` strips Anthropic / DeepSeek / GitHub / Cursor / Bearer patterns. Tests use `AADI_DB_PATH=:memory:` and `scripts/fixtures/test.env`. `test-security.ts` refuses running against `aadi.db`.

### CI

`.github/workflows/ci.yml` on PR and push to `main`: `npx tsc --noEmit` then `npm test` (includes `test:security`, `test:anti-laziness`, `test:jobs`, `test:autonomy`, `test:merge-ready`, `test:web-search`, …). Dummy `TELEGRAM_BOT_TOKEN` / `ANTHROPIC_API_KEY` only.

Other enforcing tests: `test:direct-send`, `test:send-intent`, `test:create-meeting`, `test:delete-calendar`, `test:pending-drafts`, `test:stage12` (meeting auto-book forgeries).

---

## Hosting

### Phone

Permanent host: Android Termux. SSH `u0_a289@i2301` port **8022** (Tailscale MagicDNS; IP `100.79.235.3`). `scripts/phone-host.sh`. **One** Aadi at a time (Mac or phone) or Telegram long polling fights itself.

Boot (`scripts/phone-boot.sh` → `~/.termux/boot/start-aadi.sh`, install with `npm run phone:install-boot` only — **deploy and `/build` never overwrite it**):

1. `termux-wake-lock`
2. Sleep 20s
3. Broadcast Tailscale `CONNECT_VPN` to `com.tailscale.ipn/.IPNReceiver`, `MainActivity` fallback
4. Re-broadcast `CONNECT_VPN` every **10 minutes**
5. `sshd`
6. `tmux` session `aadi`: `cd ~/aadi-agent && while true; do npm start; sleep 5; done`

Mac Tailscale must be the **personal** account to reach the phone. Epicode tailnet cannot SSH.

### `/health`

`formatHealthReport()`: `VERSION` (`hash=` + `deployed=` IST), today’s turn counts, `llm credit: ok` or flagged backends, `.aadi-heartbeat` age, last-success for each `HEALTH_JOBS` name. Morning brief shows `off` until enabled.

### Deploy

`npm run deploy` / `deploy.sh`:

1. Refuse if Mac `.env` missing required keys
2. Snapshot phone `aadi.db` → Mac `backups/` (keep 10)
3. `git fetch`; refuse if Mac is behind `origin/main`
4. rsync excluding `node_modules`, `dist`, `*.db`, `backups`, `google-token*.json`, `.git`, `VERSION`
5. Phone `npm install`, `write-version.sh` with Mac HEAD, `pkill` tsx so tmux restarts Aadi

`/build` path: Cursor agent → PR → CI → maybe auto-merge → `phone-self-deploy.sh`.

Pause/resume: `npm run phone:pause` / `phone:resume`. Screen: `phone:wifi` then `phone:screen`.

### Known phone-freeze history (from **code**, not folklore)

- **RAM:** `src/local_llm_guard.ts` — phone ~7.4GB total; `gemma4:e4b` needs ~7GB; Aadi + Ollama together crash it. Guard refuses local models if Aadi’s tmux/process is up or available RAM &lt; 7000MB. Ollama is **not** in the boot script.
- **Event loop:** `src/scheduling_csp.ts` times out; `propose_calendar_event` comments that a slow Google call must not freeze the agent loop.
- **Tailscale after reboot:** boot script wait + `CONNECT_VPN` loop; Always-on VPN on, “Block connections without VPN” off (`RESTORE.md`).
- **Crash redelivery:** `processed_messages` claims `(chat_id, message_id)` so Telegram retries do not double-reply (`src/bot.ts`).
- **Two processes:** long polling conflict — pause phone before `npm run dev` on Mac.
- **Hung turns:** 60s `chat_turns` timeout + Retry. Interval jobs skip on overlap.
- **No downtime alerter:** heartbeat is a local file only. Nothing pages Telegram if the phone dies. That is an open item (below).

---

## SQLite schema (every table)

Live file: phone `aadi.db`. Created/migrated in `src/db.ts`.

| Table | Purpose |
| --- | --- |
| `messages` | Chat history: user / assistant / tool rows (`tool_name` on tool rows) |
| `pending_actions` | Draft Send cards and Create Event cards (account, headers, expiry) |
| `tasks` | Open/done tasks; extra columns for promises (`kind`, `source_thread_id`, `deadline`, `recipient`, …) |
| `reminders` | One-off / daily / weekly / weekdays; may link task or bill |
| `followups` | Threads waiting on a reply (work + personal) |
| `documents` | Ingested PDFs/photos/Drive; 7-day delete |
| `jobs` | Multi-step job header (budget, Telegram progress message) |
| `job_steps` | Plan steps + `done_condition` + `done_check_passed` |
| `qa_bank` | RFP/questionnaire Q&A; `qa_bank_fts` FTS5 |
| `notes` | Wrap-up / call notes (`meeting_json`) |
| `attachment_alerts` | Work-inbox contract/RFP pings |
| `memories` | Long-term facts; `memories_fts` FTS5 |
| `pending_memory_confirms` | Unused-style confirm rows for memory updates |
| `usage_log` | Token/cost rows (ids, not bodies) |
| `bills` | Upcoming / paid / ignored renewals |
| `important_dates` | Birthdays etc. (`month_day`) |
| `settings` | Key/value: `/model`, morning brief on/off, keyboard, web-search daily counts, wrap-up pending, … |
| `llm_backend_flags` | 6h credit/auth flags |
| `builds` | `/build` pipeline state |
| `meeting_briefs` | Pre-meeting briefs + wrap-up state |
| `accounts` | Epicode deals (partner / end_client) |
| `pending_account_updates` | Confirm-stage buttons after wrap-up |
| `meeting_inbounds` | Deduped inbox messages for auto-schedule |
| `meeting_proposals` | Offered slots |
| `meeting_pending_bookings` | Delayed confirm + calendar hold |
| `meeting_draft_intents` | Intent attached to a Gmail draft id |
| `meeting_card_state` | Telegram card payload for an inbound |
| `job_runs` | Scheduler last success/attempt |
| `meeting_threads` | Auto-schedule conversation state |
| `meeting_auto_sends` | Count of proposal/clarify/confirm sends |
| `processed_messages` | Telegram update idempotency |
| `chat_turns` | Per-turn ok/failed/timeout + retry text |

---

## Open items

- **Downtime alerts — not built.** `/health` and `.aadi-heartbeat` are on-box only. If Termux/Tailscale/Aadi die, nobody is messaged. No watchdog chat, no external ping.
- **Gemini grounding quota.** Live fallback hit `429 RESOURCE_EXHAUSTED` on `google_search` (31 Oct 2026). Cascade then used Claude. Chat Gemini and DeepSeek Search were fine. No code TODO; operational quota.
- **TODOs in code:** none (`TODO` / `FIXME` / `XXX` not used in `src/` or `scripts/` as of this HEAD).
- **WhatsApp:** `isOwnerWhatsApp` exists; no WhatsApp transport.
- **`.env.example` drift:** still comments Gemini as `gemini-1.5-flash`; code default is `gemini-3.6-flash`. `FALLBACK_CHAIN`, `AADI_DB_PATH`, `VOICE_NOTES_ENABLED` are used but not listed there.
- **Untracked local scripts** (not on main): `scripts/live-gemini-check.ts`, `scripts/cleanup-oct27-stale.ts`, `scripts/list-oct27-catchup.ts`, `docs/ARCHITECTURE_DUMP.md`.

---

## Restore / secrets hygiene

See `RESTORE.md` for decrypting Telegram backups and copying `aadi.db` back. Never commit `.env`, tokens, or `*.db`. Logs: metadata (ids, status, provider) only — not mail bodies, OCR text, or search snippets.
