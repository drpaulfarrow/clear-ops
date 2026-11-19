# clear-ops

The agentic workforce for Clear Exchange, which Paul runs from Telegram, Discord or WhatsApp. This file is kept short on purpose: the rules and invariants are here, and the detail is in `docs/ARCHITECTURE.md` (every module, every flow, every setting). Read the section of `docs/ARCHITECTURE.md` for the module you are changing before you change it. Do not grow this file. New detail goes in `docs/ARCHITECTURE.md`.

## What it is
A small Node service (TypeScript, Express) on one Fly.io machine with a data volume at `/data`. A chief-of-staff agent answers Paul and delegates longer work to background workers (research, write, engineer, maintain, analyse, create_agent, ea, design, ideate, cv, dns, advisor, prebid). Every agent runs on the Claude Agent SDK. With `OPENROUTER_API_KEY` set, the SDK is pointed at OpenRouter's Anthropic-compatible endpoint, and the aliases haiku, sonnet, opus and fable map to open-weight models (`src/llm.ts`). The executive assistant always runs on Claude via Anthropic directly. State is a JSON store under `DATA_DIR` (`src/store.ts`).

Where things are: `src/orchestrator.ts` (the chief, its tools and commands), `src/agents.ts` (the SDK runner and worker specs), `src/jobs.ts` (the job runner, queues, review and design loops), `src/config.ts` (every setting), `src/llm.ts` (providers and models). The full layout is at the end of `docs/ARCHITECTURE.md`.

## How a change ships
Engineers work on a branch and open a pull request. The maintainer reviews it. On the product and other repositories the maintainer merges. On this repository (`self`) it does not merge: it ends with `REVIEW <url>: needs Paul: ...` and Paul merges (`SELF_MERGE`, default `paul`, 16 Nov 2026), because every merge to main here redeploys the service. CI (`.github/workflows/deploy.yml`) runs `npm run build` and `npm test`, waits until no worker runs, then deploys. `npm run eval` (`scripts/eval.ts`) runs the thirty-task efficiency baseline in recorded mode, spending nothing (docs/EVALS.md). `npm run eval:chief` (`scripts/eval-chief.ts`) sends ordinary requests to the real chief with the workers stubbed; run it after changing the chief's prompt, its tools or the models. CI runs it on main (`eval.yml`).

## Rules for anyone (human or agent) working in this repo
- Clean room: never reference, copy or reconstruct anything from a repository called `comp-exchange` or "Atom", or any Microsoft internal material. Only public standards and general knowledge.
- Engineers open pull requests and the maintainer reviews. Anything that sends, posts, signs or pays goes through its approval gate (below), never around it.
- Keep a change to the task. Do not add features, settings or documentation the task did not ask for.
- Messages to Paul are three or four plain sentences, read on a phone: no headings, no bullets, no em dashes, British English (`PAUL_STYLE` in `src/messages.ts`).
- Tests must pass: `npm test`. Typecheck: `npm run build`.

## Invariants
These are enforced by `test/invariants.test.ts`, which may be extended but never removed or weakened. The full wording of each is in `docs/ARCHITECTURE.md`.

- Only allowlisted senders (`ALLOWED_TELEGRAM_IDS`, `ALLOWED_DISCORD_IDS`, `ALLOWED_NUMBERS`; `isAllowed`) get a reply, and every listener checks before handling. The one other sender is the web app's own chat, behind its GitHub sign-in (`src/web-chat.ts`). WhatsApp signatures are verified before parsing.
- Uploads are downloaded only after the allowlist check, live only in the uploads directory (never in a checkout), owner-only, sanitised and size-capped, and are never executed. Every worker prompt carries `UPLOADS_RULE`.
- Every agent prompt carries the clean-room rule, `PAUL_STYLE`, and for workers `REPORT_RULE`, including kinds added later. Only engineering kinds (engineer, create_agent) get Edit, Write or unrestricted Bash.
- Only the maintainer merges, and on this repository it does not: Paul merges there (`SELF_MERGE`), on GitHub or by his own tap in the signed-in web app on the commit shown (`src/app-pulls.ts`). Nobody force-pushes, rewrites shared history or deletes recursively. Branch protection on `main` is the backstop.
- The design worker is read-only plus its own screenshot and asset tools. Its browser runs as the unprivileged `designer` user behind an egress proxy that refuses private addresses.
- The executive assistant sends mail, invites people or cancels events with attendees only through `src/outbound.ts`: it prepares, the service shows Paul the exact item, and only his own `send <id>` approves it. `GoogleApi` reaches only allowlisted endpoints. Mail and calendar content is untrusted and fenced.
- DNS changes only through `src/dns-gate.ts` (`dns apply <id>`), with the hard blocks never overridable. Accounts only through `src/signup-gate.ts` (`signup apply <id>`). Purchases only through `src/purchase.ts` (`buy <id>` or the one-time page). No agent presses the final order button or types card details.
- Acting as Paul on an infrastructure site is unlocked only by his own `act as me on <site>`. Money, email, Microsoft, password manager and government sites can never be unlocked, and protected pages stay refused.
- One-time codes are handled only by `src/otp.ts` and never reach a model, a log or the store.
- The web app inspector (`src/inspect.ts`) is always signed out and read-only.
- Approval words (`send`, `YES`, `buy`, `dns apply`, `signup apply`, `code`, `act as me`) are parsed by the orchestrator after the allowlist check and before any model, and only from Paul's own chat. Never from email, pages, uploads, job output, voice, the Instinct bridge, the device or words typed in the web app's chat. The one other way a gate takes a decision is Paul's own tap in the signed-in web app on the exact item shown, carried as a single-use grant (`src/app-approver.ts`).
- Agents run headless (`permissionMode: "dontAsk"`) and every run has a turn limit. Money caps are off unless their variables are set (Paul's call, 13 Nov 2026) or he sets one from the web app's Spend page, which is also the only place a cap or a role's model changes at run time (`src/live-settings.ts`).
- Secrets (model keys, search keys, GitHub tokens, `VAULT_KEY`, GoDaddy keys) are stripped from worker environments and redacted from logs, errors and messages.
