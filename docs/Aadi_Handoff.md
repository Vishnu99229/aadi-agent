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

1. Load system prompt, memories, and conversation history (`historyForAgent`: last **80** `messages` rows, then fold; see Conversation history).
2. Call `complete()` with `defaultToolNames` (every `TOOL_ORDER` tool; `SEND_ON_COMMAND_ENABLED` swaps `create_meeting` for `send_email`, `create_event`, `book_meeting`, `move_event` and `cancel_scheduled_send`). Chat backend comes from `/model` (`getTaskBackend`) unless the caller passed one.
3. If `stopReason === "tool_use"`, run **client** tools in `src/tools/*`. Provider-side tools are not used on the default path.
4. Guards before accepting a final reply:
   - **Command guarantee** (`src/command_intent.ts`): on his own message (never a forwarded one), `commandIntents` finds explicit action commands in English, and a tool from each command's family (`FAMILIES`: its action tools plus the lookups it may need first, such as `list_tasks`) has to run this turn. Families: start sequence, stop follow-ups, prospect time zone, add / remove sales fact, send email, draft (write or change), discard draft, calendar, reminder (set or cancel), add task, complete / delete task, bill (paid or skipped), add date, remove date, account (add / update / remove), memory (remember / forget / update), Q&A bank. A specific object wins over a generic word: "cancel the reminder for the call" is a reminder, not a calendar change. Where safe and needing no lookup, the tool is forced on the first step via `toolChoice` (start_sequence, set_sequence_timezone, add_sales_fact, remove_sales_fact, add_task, add_date) on DeepSeek, Gemini and local backends; Claude Sonnet 5.5 rejects forced tool use (400), so it is never sent there, and stop_sequence is never forced ("pause all" stops everything). If the turn would end with no family tool: a sequence request runs `start_sequence` in code with the name from his words (`sequenceTargets`); otherwise retry once (`commandRetryPrompt`), then reply `commandNotRunMessage` ("I didn't carry that out…"). A reply whose first line repeats an earlier answer while this turn's tools returned something new is replaced by this turn's action result, or by `commandNotRunMessage` when only a lookup ran (`echoesEarlierReply`). Added after DeepSeek answered "start a sequence for Dorothy" from chat history on 2026-11-08 without calling the tool. `scripts/test-command-guarantee.ts`.
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

One override: while `SEND_ON_COMMAND_ENABLED` is on, `handleUserText`'s call to `runAgent` passes `backend: "claude"` when `looksLikeCommandTurn` matches his words, so turns that can act with no card run on Sonnet whatever `/model` says. It picks the model and grants nothing. `writeCommandEmail` always uses Sonnet with `noFallback`, at scheduled fire time too.

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

DeepSeek reports cache-read tokens; Gemini cache rates are zero in config. Tool list order is frozen so the cached tools prefix stays stable. Conversation history is a separate mechanism (next section), not Anthropic prompt cache.

### Conversation history (`src/chat_history.ts`, `historyForAgent` in `src/agent.ts`)

**(a) Raw-message window — not “keep last 30” as the fetch.** `HISTORY_KEEP_MAX = 30` is the **post-fold keep target**, not how many rows are read from SQLite. `HISTORY_FOLD = 10`. `HISTORY_TOKEN_BUDGET = 8000`.

`historyForAgent` in `src/agent.ts` loads `keepMax + fold * 5` = **80** rows via `getRecentMessages` in `src/db.ts` (newest `ORDER BY id DESC LIMIT`, then reverse). The default `limit = 10` is unused by the agent; the agent always passes that lookback. `storeOutboundText` calls `getRecentMessages(1)`.

`planHistoryWindow` in `src/chat_history.ts` then shrinks that window until `remaining.length <= keepMax` **and** estimated tokens `<= 8000`, taking up to `HISTORY_FOLD` (10) oldest remaining rows per block and always leaving at least one. So the **raw** turns in the LLM request are at most 30 messages **and** under ~8000 estimated tokens (4 chars ≈ 1 token). Already-folded ids (`conversation_summary_until_id`) are excluded via `message.id > untilId` before that loop. Tool rows longer than `TOOL_STUB_MIN_CHARS` (1500) are stubbed unless two or fewer user messages follow them.

**(b) Fold behaviour — re-folded (summary-of-summary), not truncated.** `summariseOlderMessages` in `src/agent.ts` summarises each successful block **together with the previous stored summary** (`buildSummarizerInput` in `src/chat_history.ts` prefixes `Previous summary:` when one exists, then `New turns:`), then the result **replaces** `conversation_summary` and advances `conversation_summary_until_id`. Older raw rows are not truncated in place; they stay in `messages` but are skipped on later turns by `until_id`. Before summarising, `buildSummarizerInput` caps each message at `TOOL_STUB_MIN_CHARS` (1500) characters and applies `redactAllSecrets` per message and to the joined input; the summary output is also passed through `redactAllSecrets`. The merged summary is injected as `Earlier conversation summary:` in `system.dynamic`. If a fold LLM call fails, later blocks in that turn are skipped (`break`); already-written summary/`until_id` stay.

**(c) `messages` is not searchable.** Runtime reads of the `messages` table go only through `getRecentMessages` (agent lookback; outbound last-assistant check). There is no SQL search, FTS, or tool that queries chat history. `search_memories` / `search_notes` / `search_qa_bank` hit other tables. `/reset` (`clearMessages`) deletes all `messages` rows and the two summary settings.

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
| `/jobs` | Running/recent multi-step jobs; cancel from chat | Owner lock; jobs cannot send/book |
| `/health` | Version, turns, LLM credit flags, heartbeat, last-success per job | Owner lock |
| `/meetings` | Auto-handled meeting threads | Owner lock |
| `/sequence <who>` | Offer a follow-up sequence: shows the Start card only (`handleSequenceCommand`, `requestSequenceCard`) | Owner lock; refuses forwarded; enrols only on tapping Start |
| `/scheduledsends` | Emails scheduled to send later, with a Cancel button each (`handleScheduledSendsCommand`, `handleScheduledSendCallback`) | Owner lock; refuses forwarded |
| `/sequences` | Active sequences with step, next send time and a Stop button each (`handleSequencesCommand`, `handleSequenceStopCallback`) | Owner lock; refuses forwarded |
| `/cost` | Token cost report | Owner lock |
| `/accounts` | Deal list | Owner lock |
| `/backup` | Encrypted `aadi.db` to Telegram | Owner lock; requires `BACKUP_PASSWORD`; AES-256-CBC |
| `/next` | Pre-meeting brief for the next work meeting | Owner lock |
| `/wrapup` | Save call/meeting notes | Owner lock |

Also on the bot menu (set at startup): `/model`, `/build`, `/builds`, `/health`, `/memory`, `/meetings`, `/reset`, `/jobs`.

Retry callback `retry:<turnId>` re-runs the last failed user text for that turn.

### Chat tools (no slash command)

Reading / searching / drafting is free. Side effects:

| Tool / flow | Gate |
| --- | --- |
| `search_emails`, `read_email`, `list_events`, `read_document`, `search_drive`, `web_search`, lists of tasks/bills/dates/notes/QA | Read-only |
| `draft_reply`, `draft_new_email` | Default: Send / Edit / Discard card (`pending_actions`). **Exception:** `send_immediately: true` on Vishnu’s own chat/voice turn (`sendConfirmation` present) — `allowOwnerChatSendDraft`. Never from email body text | While `SEND_ON_COMMAND_ENABLED` is on, `sendCreatedDraftNow` refuses, so `send_immediately` makes a Send card
| `confirm_send_pending_draft` | Vishnu’s chat confirmation of a listed draft; still goes through `performDraftSend` |
| `propose_calendar_event` | Create Event approval card |
| `create_meeting` | Owner chat/voice is the approval (`allowOwnerChatCreateEvent`); work calendar + Meet; never from email text. While `SEND_ON_COMMAND_ENABLED` is on it refuses, and `book_meeting` takes over |
| `delete_calendar_event` | Owner chat/voice (`allowOwnerChatDeleteEvent`); never from email text. While `SEND_ON_COMMAND_ENABLED` is on, `notAnEventCommand` also applies |
| `add_calendar_attendee` | Owner chat/voice (`allowOwnerChatAddAttendee`); `sendUpdates=all`; never from email text. While `SEND_ON_COMMAND_ENABLED` is on, the attendee goes through `resolveCommandAttendee`: in his own words, exactly one address |
| `draft_mom` | New work email, still Send / Edit / Discard |
| `start_sequence` | Owner chat/voice (`allowOwnerChatStartSequence`) plus a clear phrase (`isExplicitSequenceRequest`). Only shows the Start card. Not in `FORWARDED_TOOLS` |
| `stop_sequence` | Owner chat/voice (`allowOwnerChatStopSequence`). `matchSequencesForStop` by name, company, address or "all"; asks first when more than one matches; the result says exactly what stopped. Not in `FORWARDED_TOOLS` |
| Sequence follow-up email (`sendSequenceStep`, `src/security/sequence_send.ts`) | **No tap per email and no content check**, a deliberate exception: Vishnu taps Start once, and every written follow-up goes out as written (his decision, 2026-11-07). `evaluateSequenceSendGate`: `SEQUENCES_ENABLED`; work account and work sender; recipient exactly the enrolled `prospect_email`; no Cc or Bcc; never `blockedAutoSendDomains` (partner, end client, `epicode.in`), self or do-not-contact; one open sequence per person (several people at one company each get their own); manual bumps count toward the 4; body is the stored written draft; live Message-ID present; Mon-Fri 09:00-17:00 in the prospect's own zone, with no IST floor (`inSendWindow`), so US prospects get mail in their morning; `SEQUENCE_DAILY_SEND_CAP`; `SEQUENCE_MIN_SPACING_MINUTES`. `claimSalesStepSending` runs before the Gmail call, so a crash can't double-send. `scripts/test-security.ts` allows `messages.send` in exactly this file, `auto_book.ts` and `command_send.ts`; `scripts/test-sequence-send.ts` covers the gate |
| Email on command (`send_email` → `sendCommandEmail`, `src/security/command_send.ts`) | **No tap and no content check**, a deliberate exception, and only with `SEND_ON_COMMAND_ENABLED`. Fires on Vishnu's own chat or voice turn (`allowOwnerChatCommandSend`); not in `FORWARDED_TOOLS`. `notASendCommand` refuses "draft", "write", "prepare", "remind me", "don't send" and similar; "reply to X" sends. Each recipient must be in his own words (`namedInOwnWords`), or be an address Aadi offered him, then `resolveRecipient` must find exactly one address on the thread, in his mail, or in a memory he gave or confirmed; zero or several asks, by buttons when several. `evaluateCommandSendGate` allows only those addresses, and no email that mentions an attachment. `claimCommandSend` runs before the Gmail call, keyed on the command, so a retry can't double-send. While the toggle is on, `sendCreatedDraftNow` refuses, so `send_immediately` makes a Send card. Written by `writeCommandEmail`, Sonnet only, no fallback; card and account numbers are stripped from its input |
| Calendar on command (`create_event`, `move_event`, `delete_calendar_event`) | **No tap**, only with `SEND_ON_COMMAND_ENABLED`, on Vishnu's own chat or voice turn; not in `FORWARDED_TOOLS`. `createOwnerCalendarEvent` invites nobody. `moveOwnerCalendarEvent` tells existing attendees. `notAnEventCommand` refuses "don't", "should I", "remind me to", "propose" and similar. Off: `create_event` and `move_event` are hidden and refuse |
| Meeting on command (`book_meeting` → `bookResolvedMeeting`, `createCommandEvent`) | **No tap**, only with `SEND_ON_COMMAND_ENABLED`. The invite takes the email path: `recipientSlots` needs each attendee in his own words, `resolveRecipient` needs exactly one address, zero or several asks. `evaluateCommandEventGate` then `claimCommandSend` then `events.insert`, so a repeat can't invite twice. A clash is a warning in the reply, not a stop. While on, `create_meeting` refuses and `add_calendar_attendee` resolves through `resolveCommandAttendee` |
| `cancel_scheduled_send` | Owner chat/voice (`allowOwnerChatCancelScheduledSend`), through `cancelScheduledSendFromTool`. By name, address, subject or "all"; asks first when more than one matches. Closes the task too. Not in `FORWARDED_TOOLS` |
| Scheduled email on command (`send_email` with `send_on` → `fireScheduledSend`) | Same checks as sending now, on Vishnu's own turn. `createScheduledSend` saves the row and a normal task together; `recheckRecipients` looks the recipients up again at fire time and `holdScheduledSend` holds and asks if they changed. `claimScheduledSend` runs after writing, right before `sendCommandEmail`, and needs the task open, so a cancel by any route stops it. A step stuck in `sending` is reported and never resent. Cancel: `cancel_scheduled_send`, the Cancel button or `/scheduledsends`, or closing the task. Off: nothing fires |
| Sequence time zone and step 3 times | `resolveProspectTimezone` (`src/sequence_timezone.ts`) runs at Start, and before the first send if Start's lookup failed: (a) the UTC offset on the newest Date header of their own mail, named as a US or Indian zone when one matches that day, so daylight saving follows; (b) a place in their signature or the thread; (c) the company's HQ when clearly identifiable; (d) IST. (b) and (c) come from one background model call (`LOCATION_SYSTEM`). A +0000 header loses to a place they name, since it's often a mail server's clock. Stored as `prospect_timezone` (IANA name or `+HH:MM`) with `prospect_timezone_source`; `/sequences` shows "Munil Shah, Talkdesk - US Pacific". Vishnu corrects it with `set_sequence_timezone` ("Munil is in New York"), source `owner`, never looked up again. Step 3 offers up to 3 of his free times (`MEETING_HOURS` and free/busy) that also fall in 09:00-18:00 on their weekday (`slotInProspectHours`); with none, it asks them for a time. With his default 10:00-18:30 IST hours, US zones never overlap, so US step 3 always asks |
| Auto-scheduling email (`sendSchedulingEmail`) | **No tap** for a lone prospect. Only the three fixed templates (proposal / clarify / confirm) with a validated opening line. `autoSendBlockedParty` blocks the three automatic paths when the sender, reply From, or a non-self attendee/Cc is a partner domain or `epicode.in`: first proposal (`processInboundMeetingMessage`) becomes the not-replying card; a reply (`processReplyOnProposal`) is handed over; a delayed confirm (`processDuePendingBookings`) is not sent and the private calendar event is left in place. `handleMeetingBookCallback` ("Actually, offer slots") and `sendCreatedDraftNow` (send-it) are not blocked |
| Auto-book from Epicode inbox | Prospects only (`AUTO_HANDLE_SENDER_TYPES`). Confidence `AUTO_BOOK_MIN_CONFIDENCE`, daily caps (`AUTO_BOOK_DAILY_CAP`, `AUTO_SEND_DAILY_CAP`); template body must match. Domain block is `blockedAutoSendDomains`: `PARTNER_DOMAINS`, `email_domains` on partner and end-client accounts, and `epicode.in`. `scripts/test-security.ts` forges From/Cc; `scripts/test-stage12.ts` covers the partner guard |
| Voice notes | Needs `SARVAM_API_KEY`; ≤30s; transcript is treated as Vishnu’s chat (same sendConfirmation). A non-forwarded voice note gets one voice note back (`deliverVoiceTurn`), captioned with Aadi’s words only (`voiceCaption`); the agent is told to answer as speech (`voiceAnswer: "spoken"`), and long answers are cut at a sentence with "Want me to send that in writing?" (`speechText`). Cards made during the turn are held (`collectVoiceCards`, `holdForVoiceNote`) and the first card's buttons ride on the voice note with the short text they need; `installCaptionEditFallback` turns a later text edit of that message into a caption edit. Text only when he asks in writing (`wantsItInWriting`, `voiceAnswer: "written"`) or the voice fails, then the full text and every card |
| Photos / PDFs / Drive | Ingest to `documents` (7-day expiry); analysis via document backends |
| Jobs (RFP / every-question) | Plan from **owner text only**; forbidden step types `send` / `book` / calendar writes; done-checks; $0.50 default budget; 3 attempts; stuck 10 min |

### Scheduled jobs (`src/index.ts` + `src/scheduler.ts`)

Self-scheduling `setTimeout`, Asia/Kolkata. Last success in `job_runs`. Catch-up: 4h for daily, 12h for weekly. Job timeout 5 min (job-queue 10 min). Heartbeat file written on success.

| Job | When | Gate |
| --- | --- | --- |
| `morning-brief` | `BRIEF_TIME` (default 08:00) | Off until setting `morning_brief=on` |
| `bill-scan` | `BILL_SCAN_TIME` (default 09:00); prefers DeepSeek off-peak | Classify only; no send |
| `important-dates` | 09:00 daily | Telegram ping |
| `promise-scan` | Weekdays 09:00; DeepSeek off-peak preferred | Creates open tasks from work Sent; not a mail send |
| `weekly-review` | `WEEKLY_REVIEW_TIME` default 19:00 Sundays | Telegram only |
| `weekly-backup` | Sundays 21:00 | Encrypted file to Telegram if `BACKUP_PASSWORD` set |
| `sequence-detect` | every 30 min when `SEQUENCES_ENABLED` | `runSequenceDetection`: offers a Start card only, creates no active sequence |
| `scheduled-send` | every minute when `SEND_ON_COMMAND_ENABLED` | `runScheduledSendTick`: closed tasks cancel, stuck sends are reported, due sends go out, written fresh on Sonnet. Late ones fire when the phone is back |
| `sequence-send` | every 5 min when `SEQUENCES_ENABLED` | `runSequenceTick`: `evaluateStopRules` on every active sequence (out-of-office sorted first by `classifyInbound`), the 5-day ping (`pingWaitingCards`), then at most one send, with all stop rules checked again right before it. Also a line on `/health` (`off` when disabled). No per-send message and no digest |
| `meeting-inbox` | every 10 min | `processInboundMeetingMessage`. `gatherMeetingContext` (thread, sender's recent mail, memories, `searchHistory`, accounts) runs before `detectMeetingRequest`. Auto-send only for `prospect_enquiry` (`AUTO_HANDLE_SENDER_TYPES`). Partner / own domains get the not-replying card instead |
| `meeting-poll` | every 2 min | Same |
| `meeting-pending` | every 1 min | `processDuePendingBookings` after `AUTO_BOOK_DELAY_MINUTES`. A blocked partner/own confirm is not patched and not mailed; the event inserted with `sendUpdates: "none"` stays on the calendar |
| `meeting-prebrief` | every 5 min | Telegram brief `PRE_MEETING_MINUTES` before work meetings with externals |
| `attachment-alerts` | every 10 min | Review / Ignore buttons; no analyse until Review |
| `build-poll` | every 1 min | CI + protected areas |
| `job-queue` | every 1 min | Done-checks; no send/book steps |
| `message-embed` | every 5 min, including once at startup | `registerMessageEmbed` / `runMessageEmbed`. Embeds user and assistant rows only, outside the chat turn |
| Reminder tick | every 1 min | Telegram reminders |
| Document expiry | daily | Deletes `documents` older than 7 days |
| Approval expiry | hourly | Draft cards 3h; create-event cards 24h |

`runMessageEmbed` redacts with `redactAllSecrets`, caps at `TOOL_STUB_MIN_CHARS`, and skips text shorter than `EMBED_MIN_CHARS` (`skip_reason` `short`, null vector). Stored text is `documentEmbedText` (`title: none | text: …`). Queries use `queryEmbedText` (`task: search result | query: …`). `searchHistory` scores only the current `EMBED_MODEL` and `EMBED_SCHEME`, drops the newest `HISTORY_KEEP_MAX` messages, and returns `SEARCH_HISTORY_NO_MATCH` when nothing reaches `SEARCH_HISTORY_MIN_SCORE` (0.68). The tool is `search_history`, last in `TOOL_ORDER`.

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
| `SELF_EMAIL_ADDRESSES` | Extra mailboxes treated as Vishnu by `loadFollowupSelfAddresses` in `src/mail_helpers.ts` (plus both accounts' profile and send-as aliases). A sent email whose To is only those addresses is dropped by `isAlgorithmicallyExcluded` |
| `PARTNER_DOMAINS` | Comma-separated. Default `supertroninfotech.com,supertronindia.com,pinnacle.in,shriramlife.com` when unset; setting it replaces the default, it doesn't add to it. `pinnacle.in` is the From domain on Pinnacle Teleservices mail and that account's `email_domains` |
| `SEND_ON_COMMAND_ENABLED` | Turns on `send_email` (no card, no content check), calendar on command and scheduled sends, routes those turns to Sonnet (`looksLikeCommandTurn`), and makes `send_immediately` a Send card. Default off, which leaves today's behaviour unchanged |
| `SEQUENCES_ENABLED` | Kill switch for sequence detection and sending. Default off |
| `SEQUENCE_STEP_DAYS`, `SEQUENCE_PITCH_MIN_CONFIDENCE`, `SEQUENCE_DAILY_SEND_CAP`, `SEQUENCE_MIN_SPACING_MINUTES` | Defaults 2 days, 0.75, 15 a day, 3 minutes |
| `WEB_SEARCH_ORDER` | Default `deepseek,gemini,claude` |
| `WEB_SEARCH_PROVIDER` | Optional pin, tried first |
| `WEB_SEARCH_DAILY_CAP` | Default 100 |
| `EMBED_DAILY_TOKEN_CAP` | Kolkata-day cap for `runMessageEmbed`. Default 200000 |
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
- Owner-chat exceptions: `allowOwnerChatSendDraft`, `allowOwnerChatCommandSend`, `allowOwnerChatCreateEvent`, `allowOwnerChatDeleteEvent`, `allowOwnerChatMoveEvent`, `allowOwnerChatAddAttendee`, `allowOwnerChatCancelScheduledSend` — require a real `chatId` + `messageId` from Vishnu’s turn.

Sequence stop rules live in `evaluateStopRules` (`src/sequence_rules.ts`) and run in `applyStopRules` (`src/sequence_runner.ts`). `colleagueWroteOnThread` stops a sequence when anyone else at `epicode.in` writes on its thread after enrolment, to the prospect or to Vishnu; the `SENT` label keeps his own aliases out of it. `runPromiseScan` skips `isSalesSequenceSentMessage`, so a sequence email never becomes a promise task. The old follow-up tracker (`/followups`, the Waiting on panel, the daily "N days with no reply" pings, `track_thread` / `stop_tracking` / `list_waiting`, the `followups` table) was removed on 2026-11-08; "follow up on my email to X" and "remind me to follow up with X" now offer the sequence Start card (`isExplicitSequenceRequest`). Its shared mail helpers moved unchanged to `src/mail_helpers.ts`. `prepareSequenceStep` writes each follow-up from `salesFactsText()`: `docs/sales_facts.md` merged with the facts Vishnu adds by chat (`add_sales_fact`, `list_sales_facts`, `remove_sales_fact`, table `sales_facts_added`), read fresh for every follow-up. There is no checker: a writer failure waits and retries hourly. The four chat tools are owner-only and out of `FORWARDED_TOOLS`. A reply from anyone at the prospect's company still stops every sequence to that company (unchanged stop rule), and so does his own email to anyone there.

`approvals.ts` `sendDraft` must call `allowSendDraft` **before** `performDraftSend`. Text “send it” goes through `sendPendingDraftByText` → same `performDraftSend`. Auto-scheduling mail is **not** this gate; it is `sendSchedulingEmail` with a frozen template. Sequence follow-ups aren't either: they go through `sendSequenceStep` and `evaluateSequenceSendGate`.

Send-path inventory, enforced by `test-security.ts`:

| Call | Only in | Reached through |
| --- | --- | --- |
| `users.drafts.send` | `src/approvals.ts` | `performDraftSend` (Send tap, or "send it" on a shown draft) and `sendCreatedDraftNow` (`send_immediately`, refused while `SEND_ON_COMMAND_ENABLED` is on) |
| `users.messages.send` | `src/security/auto_book.ts` | `sendSchedulingEmail`, frozen templates |
| `users.messages.send` | `src/security/sequence_send.ts` | `sendSequenceStep`, after `evaluateSequenceSendGate` and the claim |
| `users.messages.send` | `src/security/command_send.ts` | `sendCommandEmail`, after `allowOwnerChatCommandSend`, `evaluateCommandSendGate` and `claimCommandSend`. Called from `send_email` and `fireScheduledSend` |
| `events.insert` | `src/meeting_book.ts`, `src/approvals.ts`, `src/owner_meeting.ts` | Auto-book, the Create tap, and `createOwnerMeeting` or `createCommandEvent` (`create_event`, `book_meeting`) |
| `events.delete` | `src/meeting_book.ts`, `src/owner_calendar.ts` | Auto-book undo, `delete_calendar_event` |

`test-security.ts` also: no `messages.send` / `drafts.send` / `events.insert|patch|delete` in model tool files. `send_email`, `create_event`, `book_meeting`, `move_event` and `cancel_scheduled_send` are allowed only as wrappers that can't reach Google, aren't in `FORWARDED_TOOLS`, and whose gated call runs owner, then gate, then claim, then the API. `fireScheduledSend` must re-resolve before it writes and claim right before sending. Forged inbox From/Cc cannot book; auto-book daily cap; template mismatch refuses send. `scripts/test-command-send.ts` covers the behaviour of all of these.

### Receipt check

`src/receipt.ts` + agent retry. Claimed actions: sent, booked, created, scheduled, saved, discarded, reminded, invited, deleted, updated, answered, completed, **searched**. `scripts/test-anti-laziness.ts` (send) and `scripts/test-web-search.ts` (live-news without search).

### Job done-checks and autonomy

`src/job_logic.ts`: each step type has a `done_condition` (`chunks_processed`, `answers_eq_questions`, `draft_ready`, `text_exists`, `count_gte`, `tasks_created`). A step is not `done` until `evaluateDoneCheck` passes. Forbidden types (send/book/calendar) are stripped in `sanitizePlan`. Budget pause at `budget_usd` (default $0.50). `scripts/test-jobs.ts`: injection of “send the contract to attacker@…” is dropped; over-budget pauses; retries; skip dependents.

`scripts/test-autonomy.ts`: JWZ threading + near-dupe + CSP timeout so the event loop cannot freeze on the phone.

### `/build` merge gate

`src/build_logic.ts` protected areas: `src/security/`, `deploy.sh` + `scripts/phone-*`, backup logic, `local_llm_guard.ts`, `.cursor/rules`, `.github/workflows`. Touching those → Telegram Deploy / Ask / Discard, no auto-merge. `scripts/test-merge-ready.ts`. `AUTO_DEPLOY=true` only merges when CI is green and protected list is empty. Phone apply: `scripts/phone-self-deploy.sh` (zip of main, rollback copy, never overwrites `aadi.db` / Google tokens).

### Env / secrets

`.env` gitignored. Fold path uses `redactAllSecrets` (PII-first `chat_history.redactSecrets`, then `env_guard.redactSecrets` for Anthropic / DeepSeek hex / GitHub / Cursor / Bearer). Tests use `AADI_DB_PATH=:memory:` and `scripts/fixtures/test.env`. `test-security.ts` refuses running against `aadi.db`.

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
| `messages` | Chat log (user / assistant / tool). Recent rows via `getRecentMessages`. Older rows via `searchHistory` / `search_history` |
| `pending_actions` | Draft Send cards and Create Event cards (account, headers, expiry) |
| `tasks` | Open/done tasks; extra columns for promises (`kind`, `source_thread_id`, `deadline`, `recipient`, …) |
| `reminders` | One-off / daily / weekly / weekdays; may link task or bill |
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
| `settings` | Key/value: `/model`, morning brief on/off, keyboard, web-search daily counts, wrap-up pending, `conversation_summary` + `conversation_summary_until_id`, … |
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
| `message_embeddings` | One row per embedded or skipped message. `runMessageEmbed` writes it. `listSearchableEmbeddings` reads vectors for the current model and scheme |
| `meeting_threads` | Auto-schedule conversation state |
| `command_sends` | One row per `send_email` command: `idem_key`, status (`sending`, `sent`, `unconfirmed`), `sent_message_id`. No bodies |
| `scheduled_sends` | Emails to send later: `send_at`, `task_id`, status (`scheduled`, `held`, `sending`, `sent`, `cancelled`, `failed`), `request`, `sent_message_id`. The body is written at fire time and never stored |
| `command_send_choices` | Requests waiting on Vishnu's tap when a name matched several addresses |
| `sales_sequences` | One row per pitch thread: prospect, `prospect_timezone` and `prospect_timezone_source` (from `resolveProspectTimezone` or his correction), status, step, `next_step_at`. Partial unique index on `prospect_key`, the prospect's address: one open sequence per person |
| `sales_sequence_steps` | Each step's written draft, status (`planned`, `sending`, `sent`, `skipped`; `blocked` is no longer used), `sent_message_id`, `claimed_at` |
| `sales_facts_added` | Sales facts Vishnu added by chat: `section` (or none, shown under "Added facts") and `fact`. Merged with `docs/sales_facts.md` when a follow-up is written |
| `sales_do_not_contact` | Addresses that said no, or that Vishnu marked Never |
| `sales_pitch_scans` | Cached classifier answers per sent message |
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
