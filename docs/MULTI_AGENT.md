# Aadi's agents

Aadi is one process with one user-facing assistant and six specialist agents.
Aadi reads Vishnu's message, decides who handles it, holds his approval, and
writes the reply. Each specialist owns one domain: its tools, its prompt and its
coded workflows. Agents talk through one typed task interface, in-process today
and over A2A (Agent2Agent, HTTP+JSON) for agents that run elsewhere.

```mermaid
flowchart TD
  V[Vishnu on Telegram] --> B[bot.ts: owner lock, commands, cards]
  B --> O[Aadi orchestrator<br/>src/agents/orchestrator.ts]
  O -->|1. direct answer, no model| R[Registry<br/>agents, capabilities, tool owners]
  O -->|2. one-domain turn| S1[that specialist's model loop]
  O -->|3. everything else| A[Aadi's model loop<br/>delegate_tasks / continue_task / cancel_task]
  A --> E[Workflow engine<br/>src/agents/engine.ts]
  S1 --> D
  A --> D[Dispatcher<br/>allowlist, owner, authorization, duplicate guard, record]
  E --> H{AgentHandle}
  H --> L[Local specialists<br/>email, calendar, sales, knowledge, operations, build]
  H --> X[RemoteA2AAgent<br/>@a2a-js/sdk client]
  L --> D
  D --> T[Tool handlers and the existing gated senders<br/>src/tools, src/security]
  E <--> DB[(SQLite: agent_* tables)]
  X -->|HTTP+JSON, bearer, allowlisted URL| RA[Remote agent]
  P[Other agent] -->|HTTP+JSON, bearer, 127.0.0.1| SV[A2A server<br/>read skills only] --> E
```

## Who owns what

Every tool has exactly one owner (`scripts/test-agent-routing.ts` checks this).
The tool code in `src/tools/` did not move; ownership is declared in
`src/agents/specialists/*.ts`.

| Agent | Tools it owns | Coded workflows |
| --- | --- | --- |
| Aadi | get_current_time, react_to_message, resolve_contact (shared with Email, Calendar and Sales) | routing, delegation, authorization, the reply |
| Email | search_emails, read_email, read_draft, draft_reply, draft_new_email, update_draft, draft_mom, resend_draft_card, confirm_send_pending_draft, discard_pending_draft, send_email, cancel_scheduled_send, start_sequence, stop_sequence, set_sequence_timezone | outbox, check_reply, prepare_followups |
| Calendar | list_events, propose_calendar_event, create_event, create_meeting, book_meeting, move_event, delete_calendar_event, add_calendar_attendee | next_meeting, check_conflicts, book_confirmed_meeting |
| Sales | account_status, list_accounts, add_account, update_account, remove_account, list_sales_facts, add_sales_fact, remove_sales_fact | pipeline, accounts_needing_followup |
| Knowledge | read_document, list_documents, read_attachment, list_attachments, read_drive_file, search_drive, read_sheet, search_qa_bank, learn_qa_bank, web_search, latest_release, search_memories, list_memories, remember, update_memory, forget_memory, search_history, search_notes | extract_bill |
| Operations | list_tasks, add_task, complete_task, delete_task, list_reminders, set_reminder, cancel_reminder, list_dates, list_upcoming_dates, add_date, remove_date, list_bills, mark_bill_paid, ignore_bill | track_bill_with_reminder |
| Build | none (it wraps `src/builds.ts`) | request_build, list_builds, build_status |

Each agent publishes three kinds of capability:

- **tool**: one of its tools, run by code. No model call.
- **workflow**: coded steps over its tools (for example `check_reply`). At most one small extraction call.
- **goal**: its own model loop with only its tools and its own prompt (`prompts/agents/<id>.md` on top of `_core.md`). The Build Agent has none.

Sales decides who to follow up and why; the Email Agent does every send, draft
and sequence. Operations owns reminders. There is no second follow-up engine.

### Sending mail

The four places that call Gmail's send are unchanged and are still the only
ones, pinned by `npm run test:security`:

| Path | File | Approval |
| --- | --- | --- |
| Draft card (Send / Edit / Discard) | `src/approvals.ts` | a tap, or `send_immediately` on Vishnu's own turn |
| send_email | `src/security/command_send.ts` | Vishnu's own turn, `SEND_ON_COMMAND_ENABLED` |
| Sequence steps | `src/security/sequence_send.ts` | the Start tap on the sequence |
| Scheduling templates | `src/security/auto_book.ts` | the three fixed templates |

They were not merged into one function. Each has its own claim-before-send
order and its own static checks, and the workspace rules name these files.
What is unified is the way in: every email tool belongs to the Email Agent and
runs through the dispatcher, and `/outbox` shows scheduled sends and sequences
together.

## How a message is routed

`pickRoute` uses registry data only. No model call decides the route.

1. **Direct answer.** The text matches a capability's `triggers` ("What's my next meeting?", "Show my scheduled emails.", "Show my latest Cursor build."). Code runs it. No model call.
2. **One domain.** The text matches exactly one agent's routing patterns. That agent's loop runs the turn with its own tools and prompt. If it needs anything else it calls `escalate_to_aadi`, and the same turn continues with Aadi's full prompt and tools.
3. **Everything else** goes to Aadi's loop, which can call `delegate_tasks` with a small plan: tasks, each naming an agent and capability, with `depends_on` between them.

`AGENT_ROUTING` sets how much of this is on: `full` (default), `fast` (direct
answers only), `off` (Aadi's loop takes every turn). Tools run through their
owner in every mode.

Settings said in plain words ("Turn voice replies off.") are handled in
`bot.ts` before routing (`src/settings_logic.ts`).

## Authorization

Aadi issues one grant per turn (`src/agents/auth.ts`). It lives in memory.
Tasks carry only its reference, and nothing about it is written to the
database or sent to another agent.

| Grant | From | May do |
| --- | --- | --- |
| owner_chat | Vishnu's own message or voice note | everything his turn could do before |
| forwarded | a forwarded message | the forwarded tool list: read and draft |
| background | scheduled jobs | read, and Aadi's own records |
| remote_agent | a request over A2A | only tools and workflows marked `remoteExposed` (reads) |
| none | a task with no grant | anything that acts outside Aadi stops as `auth-required` |

The dispatcher checks this on every tool call, whichever loop asked. The tool's
own gate in `src/security/` then runs as before, with Vishnu's own words: a
delegated goal's wording is never treated as his words, so a recipient named
only in a goal, an email or a remote reply does not resolve.

Results from agents, emails, web pages, documents and remote agents go back to
a model marked as data, not instructions.

## Latest release of software

"What's the latest release of X?" is a Knowledge Agent lookup. One tool,
`latest_release` (`src/releases.ts` over `src/release_logic.ts`), reads the
project's official GitHub Releases (or git tags), compares version numbers and
dates in code, and reports:

- the **latest stable** release (highest non-prerelease version, not whatever
  was published last);
- the **latest major** release (the x.0.0 that began that line), separately
  from a later patch;
- any **newer prerelease**;
- what the project's **changelog** says at the top;
- sibling **SDK** repositories, each with their own version numbers.

A web search on the same question puts the project's own release pages first
and tells the model to call `latest_release`. Nothing about any one project or
version is hardcoded: the same path answers A2A, Kubernetes, Node.js or a
project that does not exist yet. If the project is not on GitHub, the model
answers only from the vendor's own release notes or documentation.

## Who a name means

"The latest email from Hardik" names a person, not an address. One service,
`src/contacts.ts`, works out who that is for the Email, Calendar and Sales
agents (`src/contact_logic.ts` holds the matching and wording, with no I/O).

- **Where it looks:** known contacts (follow-up prospects and addresses Vishnu
  told Aadi himself, never automatic memories), Gmail correspondence on both
  accounts, calendar attendees, and account records (which give the company and
  a full name). Newsletters, automated senders and Vishnu's own addresses are
  not people.
- **How it matches:** a first name or a full name, whatever the capitals and
  spacing, optionally with the company ("Hardik from Pinnacle"). A company name
  on its own is not a person and is searched as written.
- **One match** is used. The same full name on a company address and a personal
  address is one person with both addresses. **Several** are never narrowed:
  the result is `many`. **None** is `none`.

It is used in three places:

| Where | One | Several | Nobody |
| --- | --- | --- | --- |
| `search_emails` (a name in `from:`, `to:` or `cc:`) | the name is swapped for the address | on Vishnu's own turn: asks, searches nothing | searched as written; if that finds nothing and the name is nowhere in his mail, asks |
| `resolve_contact` (shared tool) | returns name, address, company | asks | asks, or says it is a company |
| `email.check_reply` (workflow) | checks that address | the task pauses as `input-required` and resumes with the answer | searched as written |

**Asking** (`src/contact_questions.ts`): the tool opens a question for the chat
and the loop that called it stops, so the reply is the question itself ("Which
Hardik are you referring to?" with the choices, as text and as buttons) and the
model cannot go on to pick someone. Vishnu's next message is read against it:
a number, a company, a full name or an address that fits exactly one choice
resumes **the request he already made**. A reply that fits two asks again, and
a reply that is not an answer drops the question and is handled as a new
message. For `none`, an address or a fuller name does the same. His choice
stands for an hour for that name, then the name is looked up afresh.

What this does not change: it authorizes nothing. Only Vishnu's own chat or
voice turn can open a question, and only his own reply or tap can answer it (a
forward cannot). Every send and booking still resolves its recipient from his
own words in `src/security/` and `src/command_recipients.ts`, which were not
touched and do not read his choice. A typed answer re-runs his request as his
own turn; a tap is not a typed turn, so a re-run from a tap can read and draft
but anything that sends still needs its own approval. Background jobs and
forwarded messages search as they always did.

The reply check that blocks "I sent it" when no tool sent anything
(`src/receipt.ts`) now tells a claim from a description: after a successful
read, on a request that asked only to look something up, "her email was sent on
Tuesday" is a summary. "I sent…", a go-ahead, a requested or attempted send,
and live-lookup claims are checked exactly as before.

## Task lifecycle

States: `submitted`, `working`, `input-required`, `auth-required`,
`completed`, `failed`, `canceled`, `rejected` (the A2A states).

```
submitted -> working -> completed
                     -> failed            (error; uncertain_outcome if a send may have gone)
                     -> input-required    -> submitted (continue_task, same task and context)
                     -> auth-required     -> submitted
                     -> submitted         (retry after backoff)
any non-final state  -> canceled
never started        -> rejected          (not authorized, unknown capability, bad input, too deep)
```

1. `delegate` / `delegateWorkflow` validates every task (agent, capability, input schema, depth, dependencies) and writes the workflow, tasks and dependencies in one transaction, before anything runs.
2. The engine runs it at once, in the same call. Tasks with no unmet dependency start together, three at a time per workflow.
3. A task is claimed with a lease in one statement, so it runs once at a time. Each attempt, state change, result, artifact and checkpoint is written as it happens.
4. A dependency that fails stops only the tasks that depend on it.
5. A paused task keeps its id and conversation. `continue_task` answers it; an unanswered one is dropped after three days. What it is waiting on is in `agent_approvals`.
6. Every 60 seconds `agent-recovery` picks up tasks whose retry time has come or whose lease belongs to a process that is gone. After a restart this runs at boot.

Retries and repeats:

- **Reads** retry on network errors and timeouts with capped exponential backoff.
- **Writes to Aadi's own records** are not repeated within a turn (same tool, same input, runs once).
- **Anything that sends, books or deletes** is never retried on its own. If the outcome is unknown the agent's `reconcile` is asked whether it happened. If it can't tell, the task ends as `failed` with `uncertain_outcome` and Vishnu is told to check. A lost acknowledgment does not cause a second email.
- An `idempotency_key` returns the first result for a repeated request.

This is at-least-once for reads and at-most-once for sends. It is not
exactly-once, and nothing claims to be.

Limits: 3 tasks at a time per workflow, delegation depth 2, 6 tasks per
`delegate_tasks` call, 6 model steps and $0.25 per delegated goal, a deadline
per task, finished workflows deleted after 14 days.

Tables (`src/agents/store.ts`): `agent_workflows`, `agent_tasks`,
`agent_task_deps`, `agent_task_attempts`, `agent_task_events`,
`agent_artifacts`, `agent_checkpoints`, `agent_idempotency`,
`agent_conversations`, `agent_conversation_messages`, `agent_approvals`.

Big jobs (`src/job_worker.ts`) now run their steps back to back as soon as they
are started, instead of one step per 60-second tick. The tick remains as the
recovery scan.

## A2A

Library: `@a2a-js/sdk` 1.3 (A2A 1.0), HTTP+JSON binding. Both sides are off
until configured.

**Aadi using a remote agent** (`src/agents/a2a/remote.ts`)

- `A2A_REMOTE_AGENTS=id=url,...` is the allowlist. Only https, or http on loopback. Each agent's bearer token is `A2A_REMOTE_<ID>_TOKEN`.
- At boot, and every minute until it succeeds, Aadi fetches the agent card from that URL, keeps only HTTP+JSON interfaces on the same origin, and registers each skill as a capability. Redirects are refused. The token is sent to that origin only.
- Nothing in a card is trusted: skill text is capped and only shown to the model as a description, and every remote skill counts as acting outside Aadi, so it needs Vishnu's own turn.
- A delegated task becomes an A2A task. The remote `taskId` is stored on the local task and the conversation's `contextId` is reused, so a follow-up goes to the same remote task. Streaming is used when the card offers it, otherwise a blocking send.
- Messages carry the task's input and a correlation id. No grant, token or chat history.
- After a restart or a lost connection Aadi asks the remote agent for the task's status (`GetTask`) and never sends the request again. If the request may or may not have arrived, the task ends as `uncertain_outcome`.

**Aadi as an A2A agent** (`src/agents/a2a/server.ts`)

- `A2A_SERVER_ENABLED=true` with `A2A_SERVER_TOKEN` (24+ characters). Listens on `127.0.0.1:A2A_SERVER_PORT` only. Every route, the card included, needs the bearer token.
- The card lists only capabilities marked `remoteExposed`. Today that is `knowledge.web_search`. Nothing that reads Vishnu's mail, calendar, memory or files, and nothing that writes.
- A request runs under a `remote_agent` grant. The dispatcher lets it run only tools that are themselves open to other agents, so an exposed workflow cannot reach a private tool.

Do not put the phone's port on the public internet. To use it from another
machine, keep it on Tailscale or an SSH tunnel.

## Commands

The menu has 15 commands. The old names still work and are hidden.

| Old | Now |
| --- | --- |
| /sequences, /scheduledsends | /outbox |
| /sequence <name> | /outbox <name> |
| /next | /meetings next |
| /wrapup <notes> | /meetings wrapup <notes> |
| /model, /voice, /showkeyboard, /hidekeyboard | /settings |
| /builds | /jobs (big jobs, code builds and agent workflows) |

Unchanged: /start, /menu, /brief, /weekly, /meetings, /accounts, /memory,
/build, /cost, /health, /backup, /reset.

## Adding an agent

**In this process**

1. Create `src/agents/specialists/<id>.ts` exporting a `SpecialistDefinition`: `id`, `name`, `description`, `promptFile`, `tools` (each with `effect` and `retry`), `capabilities` (coded workflows with an input schema and a `run`), and `routing` patterns.
2. Add `prompts/agents/<id>.md` with what only this agent needs to know.
3. Add the definition to `SPECIALISTS` in `src/agents/index.ts`.

That is all. The orchestrator, engine and dispatcher have no per-agent code:
routing, the `delegate_tasks` catalogue and tool ownership come from the
registry. Boot fails if a tool has two owners or none.

**Somewhere else**

1. Run an A2A agent (HTTP+JSON) with a bearer token. `scripts/a2a-example-agent.ts` is a working one.
2. Add `id=url` to `A2A_REMOTE_AGENTS` and its token as `A2A_REMOTE_<ID>_TOKEN` in `.env`.

Its skills then appear to Aadi as `<id>` capabilities marked (remote).

## Tests

| Command | What it proves |
| --- | --- |
| `npm run test:agent-engine` | dependencies, bounded parallel runs, retries, lost acknowledgment, reconcile, idempotency, claims, cancel, deadlines, authorization, multi-turn, recovery after `kill -9` |
| `npm run test:agent-routing` | one owner per tool, routing table, zero-model direct answers, specialist loop and hand-back, dispatcher authorization, the command menu |
| `npm run test:agent-scenarios` | scenarios A to E with a scripted model and fixture tools |
| `npm run test:a2a` | real HTTP on loopback against a separately running example agent, and Aadi's own endpoint |
| `npm run test:contacts` | who a name means: unique, duplicate, full and unknown names, the follow-up answer by text and by tap, the three agents, who may ask and answer, and the reply check on read-only turns. Real bot handlers and tools; scripted model, fake Telegram, Gmail and Calendar |
| `npm run test:latest-release` | latest version/release: version ordering, major vs patch vs prerelease vs SDK, dates vs versions, changelog cross-check, routing, web_search nudge, Knowledge Agent turn with official citations. Invented projects only; fake GitHub and search |
| `npm run live:latest-release` | the real chat model, real web search and real GitHub on a release question (default: latest A2A protocol release); nothing reaches Telegram, Gmail or Calendar |
| `npm run live:agent-routing` | the real chat model on invented data; nothing is read, sent or booked |

The first six are part of `npm test`.

## Known limits

- Scenarios A to E run with a scripted model. Only `live:agent-routing` uses the real one, and it uses fixture tools.
- A specialist's prompt and tool list are smaller than Aadi's but are cached separately, so a first turn to an agent can cost more than the same turn on Aadi's warm cache.
- The four mail senders remain four functions (see "Sending mail").
- The concurrency limit is per workflow, not global.
- A remote agent that refuses the connection is reported as an uncertain outcome and not retried, even though nothing was sent.
- Remote agents' progress updates show state only. Remote skills are all treated as acting outside Aadi.
- The A2A server keeps its view of tasks in memory (the SDK's in-memory task store), so after a restart a remote caller's old task ids are not found. The work itself is still in SQLite.
- Only `knowledge.web_search` is open to other agents.
- Who a name means has only been run against fake Gmail and Calendar so far (see "Who a name means"). A first name shared with someone from one old thread asks once an hour.
- `list_events` has no person filter: the Calendar Agent resolves the name with `resolve_contact` and matches attendees itself.
