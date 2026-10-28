# clear-ops

An agentic workforce for Clear Exchange that you run from chat: Telegram, Discord or WhatsApp, any or all at once.

You message a bot. A chief-of-staff agent answers quick questions itself and delegates longer work to six workers: a researcher (web research, sourced briefs), a writer (specs, posts, emails in your voice), a senior engineer (implements on a branch with tests and opens a pull request), a maintainer (the one agent that reviews and merges, which runs automatically after every engineer job) an analyst (questions about previous outputs and data) and an agent-creator (turns a plain-language request for a new agent into either a recommended schedule on an existing worker or a new worker kind, delivered as a pull request the maintainer reviews). Every agent can read both repositories. Workers run in the background and message you when they finish. You direct; they deliver. The one thing that still waits for a `YES <id>` is a command run outside the engineer's normal remit, such as a deploy. Recurring jobs run on a schedule you set in chat.

Everything runs on the Claude Agent SDK. Conversation memory persists per phone number; jobs, approvals, schedules and standing notes persist in a JSON store on a volume.

## What you can say

```
What's the latest on SPUR? Keep it short.
Research TollBit's buyer-side moves this month and tell me if they're building an exchange.
Draft a two-line email to the Prebid board proposing the seller module. Formal.
Engineer: scaffold a Fastify service in the repo with a /health route and tests.
Every Monday at 7am, research what changed in SPUR, CoMP, TollBit and Cloudflare.
Remember: always price examples at half a cent per retrieval.
I want an agent that drafts publisher outreach.
show job 93137e
/jobs   /pending   /reset   /help
YES 1f3a9c
```

## Set up in five steps

### 1. Anthropic key
Create an API key at the Claude Console and keep it for step 4. The agents run on Anthropic's API and are billed by usage; every job has a spend cap.

### 2. A chat channel: Telegram, Discord, or both

**Discord (threads per job, like Slack).** At discord.com/developers, New Application, then Bot: Reset Token and copy it into `DISCORD_BOT_TOKEN`; on the same page turn on **Message Content Intent**. Under OAuth2, URL Generator: scope `bot`, permissions Send Messages, Create Public Threads, Send Messages in Threads, Read Message History; open the generated URL and add the bot to your server. Message it once; it replies with your user id for `ALLOWED_DISCORD_IDS`. In Discord, every job the chief starts gets its own thread under your message, and the engineer's report and the maintainer's review land in that thread. Each thread is its own conversation with the chief. DMs to the bot work too.

**Telegram (quickest to try).**
1. In Telegram, message `@BotFather`, send `/newbot`, pick a name and a username. Copy the token into `TELEGRAM_BOT_TOKEN`.
2. Start the service (step 4) and message your bot anything. It replies with your Telegram id because you are not allowlisted yet.
3. Put that id in `ALLOWED_TELEGRAM_IDS` and restart. From now on it answers only you.

Neither Telegram nor Discord needs a public URL: Telegram is long-polled and Discord uses a gateway connection, so the service runs anywhere, including on a laptop. Set `CHANNELS=telegram,discord` to run both; each conversation is answered where it came from.

<details>
<summary>Using WhatsApp instead (Meta Cloud API)</summary>

Set `CHANNEL=whatsapp`. At Meta for Developers, create an app of type Business and add the WhatsApp product. Under WhatsApp > API Setup you get a test number and a temporary token; for production, add your own number and create a permanent System User token with `whatsapp_business_messaging`. Note the Phone number ID and the token, add your personal number as a recipient, and point the webhook (`https://<host>/webhook`, verify token `WHATSAPP_VERIFY_TOKEN`, subscribe to `messages`) at the running service, which needs a public URL (ngrok locally). Twilio, 360dialog and Vonage sit on top of the same API if you prefer a provider; they need a small adapter in `src/whatsapp.ts`.
</details>

### 3. A clean repository for the engineer
Create an empty private repo (for example `clear-exchange`) and a fine-grained GitHub token with contents and pull requests read and write on that repo and on this one. Put the token in `GH_TOKEN` and the repo names in `PRODUCT_REPO` and `SELF_REPO`. That is all: on first start the service clones both into `workspace/` and `self/` and configures git to push with the token. The engineer only works in the product repo. It must not be, or contain, anything from previous employer repositories. Protect `main` in the repo settings: require a pull request and the CI check before merging. That makes the maintainer's role a rule GitHub enforces, not only a prompt. Add a workflow that runs the tests on pull requests so the maintainer has a green check to look for.

### 4. Run it
Needs Node 22 or later (`node --version`) and git. The engineer and maintainer also need the GitHub CLI (`gh`).

macOS or Linux:
```bash
git clone https://github.com/drpaulfarrow/clear-ops
cd clear-ops
cp .env.example .env             # fill in the values
npm install
npm run dev                      # message your Telegram bot
```

Windows PowerShell (one command per line; `&&` only works in PowerShell 7):
```powershell
git clone https://github.com/drpaulfarrow/clear-ops
cd clear-ops
Copy-Item .env.example .env      # then edit .env in Notepad or VS Code
npm install
npm run dev
```

`npm run simulate` chats in the terminal instead of Telegram, for trying things without a bot. The `.env` file is read automatically.

### 5. Deploy from GitHub, with nothing installed locally
The workflow in `.github/workflows/deploy.yml` creates the Fly app and volume, pushes the secrets and deploys. You need two websites.

1. At fly.io, sign up (a card is required; this runs on one small machine, a few dollars a month). Then Account > Tokens > create a token.
2. In this GitHub repository: Settings > Secrets and variables > Actions > New repository secret, one for each of: `FLY_API_TOKEN`, `ANTHROPIC_API_KEY`, `GH_TOKEN`, `PRODUCT_REPO` (for example `drpaulfarrow/clear-exchange`), and the bot tokens for the channels you use: `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`. Leave the allowlists (`ALLOWED_TELEGRAM_IDS`, `ALLOWED_DISCORD_IDS`) out for now. A repository variable `CHANNELS` picks the channels; the default is `telegram,discord`.
3. Actions tab > ci > Run workflow. The first deploy creates the app and volume, and the service starts, clones both repositories and begins polling Telegram.
4. Message your bot on each channel. It replies with your id. Add those as the `ALLOWED_TELEGRAM_IDS` and `ALLOWED_DISCORD_IDS` secrets and run the workflow again. From then on it answers only you, and every merge to main redeploys on its own.

If the app name `clear-ops` is already taken on Fly, add a repository variable `FLY_APP` with another name. Logs are at fly.io under the app's Monitoring tab. Any host that runs a Docker container with a persistent volume works the same way; with Telegram there is no webhook to configure.

## Self-improvement
The engineer can work on this workforce as well as on the product. Say "improve yourself: add a tool that reads my Google Calendar" or "give the researcher a stricter sourcing rule" and the chief starts an engineer job with target `self`. It works in `SELF_REPO_DIR`, a checkout of this repository, under the same process as any other task: branch, tests, pull request, then the maintainer reviews and merges. Nothing restarts itself. The GitHub Actions workflow in `.github/workflows/deploy.yml` runs the tests on the merge and deploys to Fly with a rolling strategy, so the old version keeps answering until the new one passes its health check. A few minutes after the engineer reports, the new workforce is live, and your conversation continues from the stored session.

Setup for this: clone this repository into `SELF_REPO_DIR` with a token that can push (same pattern as step 3), and add `FLY_API_TOKEN` as a repository secret so the workflow can deploy. The invariants in `CLAUDE.md` and `test/invariants.test.ts` are what stop a self-improvement from removing the allowlist, the signature check, the clean-room rule or the spend caps.

## Adding an agent
Describe the agent you want in plain words; you do not need to say how to build it.

```
You: I want an agent that monitors IAB Tech Lab announcements weekly.
Bot: Started job 4c1d2e (create_agent). It will tell you whether this needs a new worker or just a schedule.
Bot: Job 4c1d2e finished. VERDICT: schedule. Kind: research. Cron: 0 7 * * 1. Brief: ...
     No code needed: it fits an existing kind. Say "set it up" and I will schedule it.
You: set it up
```

If the agent needs its own role, method or tools (for example "an agent that drafts publisher outreach"), the agent-creator writes the new worker kind with a proper prompt, least-privilege tools and tests, and opens a pull request on this repository. The maintainer reviews and merges it as usual, CI deploys it, and a few minutes later you can use the new kind by name. If it should run on a schedule, the report includes the recommended cron for the chief to set up once it is live.

## Configuration
See `.env.example`. The important ones:

| Variable | Meaning |
|---|---|
| `CHANNELS` | Any of `telegram`, `discord`, `whatsapp`, comma separated. Default `telegram`. |
| `ALLOWED_TELEGRAM_IDS`, `ALLOWED_DISCORD_IDS` | Only these ids get a reply. |
| `ALLOWED_NUMBERS` | WhatsApp: only these numbers get a reply. E.164 digits, no plus. |
| `WHATSAPP_APP_SECRET` | WhatsApp: enables webhook signature checks. Set it in production. |
| `GH_TOKEN` | Fine-grained token with contents and pull requests read/write on both repos. |
| `PRODUCT_REPO`, `SELF_REPO` | The two repositories as `owner/name`, cloned on first start. |
| `REPO_DIR`, `SELF_REPO_DIR` | Where the clones live. |
| `CHIEF_MODEL`, `WORKER_MODEL`, `ENGINEER_MODEL` | Model aliases: `fable`, `opus`, `sonnet`, `haiku`. |
| `JOB_BUDGET_USD` | Spend cap per research, write or analyse job and per chat turn. |
| `ENGINEER_BUDGET_USD` | Spend cap per engineering, agent-creator or maintainer job. |

## Safety model
- Headless permission mode: tools not pre-approved are denied, never left waiting.
- Engineers work like senior engineers: branch, tests, pull request. They cannot merge, push the default branch, force-push, rewrite shared history, delete recursively or disable failing tests.
- One maintainer agent reviews and merges. It runs tests, checks CI, reads the diff, and either merges or requests changes. It cannot edit code. Branch protection on `main` is the hard backstop, since both agents use the same GitHub token.
- The agent-creator has the engineer's tools and limits and works only on this repository. Every worker kind it adds must carry the clean-room rule, get read-only tools unless it is an engineer, and send nothing itself; `test/invariants.test.ts` checks every kind in `JOB_KINDS`, so a new kind that breaks these fails CI. It cannot be scheduled.
- One side effect exists outside that remit (`run_command`, for deploys and migrations) and it needs `YES <id>`.
- The chief never sends email or messages anyone but you. Drafts come to you. An unlisted Telegram sender is told its own id once and nothing else.
- Spend is capped per job; subagent nesting is limited.
- A broken session is dropped automatically so the conversation never jams; `/reset` does it by hand.
- A deploy restarts the service. Jobs that were running are re-queued on start with a note to inspect the working folder and carry on, since the clones live on the volume. After three interruptions a job is stopped and you are told.
- Reviews close themselves. If the maintainer requests changes on a pull request, an engineer is sent back to fix it on the same branch and the maintainer reviews it again, up to three rounds. You hear about it only if it is still stuck after that, or if the blocker is something only you can do (a secret, a GitHub setting, account access, a product decision), and then once, with exactly what to do. Engineers and the maintainer bring branches up to date with main themselves, by merging, so nobody has to click "Update branch".
- Only one engineering job (engineer or agent-creator) works on each repository at a time, so two never fight over the same checkout. Ask for another while one is running and it is queued behind it: `/jobs` shows `queued behind <id>`, and it starts by itself, in the order you asked, when the running one finishes or fails. The product and the workforce queue separately, and the queue survives restarts. Research, writing, analysis and the maintainer's reviews never wait.

## Development
```bash
npm run build     # typecheck and compile
npm test          # offline test suite with a fake agent runner
```

## Extending
- A new worker: ask for it in chat ("I want an agent that...") and the agent-creator does it. By hand: add a case to `workerSpec()` in `src/agents.ts`, the kind to `JobKind` and `JOB_KINDS`, and the kind to the chief's prompt.
- A new side effect: add an executor to `actionExecutors` in `src/jobs.ts`. It will automatically require approval.
- Email, calendar or GitHub tools: add an MCP server to the chief's `mcpServers` in `src/orchestrator.ts`, and gate any sending behind `propose_action`.
