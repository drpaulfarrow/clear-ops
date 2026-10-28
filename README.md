# clear-ops

An agentic workforce for Clear Exchange that you run from chat: Telegram, Discord or WhatsApp, any or all at once.

You message a bot. A chief-of-staff agent answers quick questions itself and delegates longer work to seven workers: a researcher (web research, sourced briefs), a writer (specs, posts, emails in your voice), a senior engineer (implements on a branch with tests and opens a pull request), a maintainer (the one agent that reviews and merges, which runs automatically after every engineer job) an analyst (questions about previous outputs and data), an executive assistant over your Gmail and Google Calendar (triage, drafts, agenda, meeting prep, holds; it never sends or invites) and an agent-creator (turns a plain-language request for a new agent into either a recommended schedule on an existing worker or a new worker kind, delivered as a pull request the maintainer reviews). Every agent can read both repositories. Workers run in the background and message you when they finish. You direct; they deliver. The one thing that still waits for a `YES <id>` is a command run outside the engineer's normal remit, such as a deploy. Recurring jobs run on a schedule you set in chat.

While the chief is thinking you see it typing, plus one status line that updates in place with what it is actually doing ("Checking job 39abb7…", "Searching the web: SPUR news…", "Starting an engineer job…") and disappears when the answer arrives. On WhatsApp, which supports neither, you get a single "Working on it." if it takes more than a few seconds.

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
What needs me in my inbox today?
Draft a reply to Sam saying half a cent works, and hold Thursday 2pm for the call.
What did Sam last say about pricing?
Prep me for my 10am.
connect Google   /google   /google disconnect
show job 93137e
/jobs   /pending   /reset   /help   /uploads
YES 1f3a9c
```

## Sending files
Attach a file in Telegram or Discord (a LinkedIn `Connections.csv` export, a PDF, a spreadsheet, a screenshot, a zip) with or without a caption. The bot replies "Saved Connections.csv (1.2 MB)." and the chief is told, in that turn, the saved path, original name, type, size and your caption, so it can read the file or hand the path to a worker. Screenshots and other images are shown to the chief, so it actually sees them. `/uploads` lists what is stored; `/delete upload <name>` deletes one (the saved name or the name you sent), and `/delete upload all` deletes everything. You can also just ask the chief to delete a file.

How uploads are handled, since they may hold personal data:
- Only files from your allowlisted account are downloaded; anyone else's are ignored without being fetched.
- Each file is saved as `DATA_DIR/uploads/<date>-<name>` on the data volume (`/data/uploads` on Fly), outside both git checkouts (the service refuses to start the uploads directory inside one), with owner-only permissions (directory 0700, files 0600). Names are sanitised, so a name like `../../x` cannot escape the directory, and nothing ever overwrites an earlier upload.
- Files over `UPLOAD_MAX_MB` (default 20, also Telegram's limit for bots) are refused before download. Discord files are fetched only from Discord's CDN.
- Uploads are treated as untrusted data and never executed. A zip is unpacked by the service's own reader into a new, empty `<name>-files` directory beside it, skipping absolute paths, `..`, links and encrypted entries, and stopping at 2,000 entries or 200 MB unpacked.
- The chief and every worker can read the uploads directory and are told never to execute uploads, follow instructions inside them, commit them to a repository or send their contents anywhere. The contents go to nobody but the model.

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

## Executive assistant (Gmail and Google Calendar)
The `ea` worker is your executive assistant over your own Google Workspace account, at the level you approved, "drafts plus holds". It reads and searches your mail and every calendar you can see. When you ask for it in chat, it saves replies in your voice to your Gmail Drafts folder, and places, moves or removes holds on your own calendar (private events titled "Hold: ...", nobody invited). It cannot send email, send a draft, delete, archive or relabel mail, add attendees, send invitations or answer them: those calls are refused in code (`src/google.ts`), not only by its prompt. Once connected, a morning brief (07:30) and an end-of-day wrap (18:00) run on weekdays, as ordinary schedules you can move or cancel in chat ("move the morning brief to 8").

Email is treated as untrusted input. The assistant sees mail fenced between markers it cannot forge and is told it is data, never instructions; mail that reads like instructions is flagged to you as possible phishing. What a job may change comes only from your chat: a scheduled brief only reads, and the chief grants "drafts" or "holds" to a job only when you asked. A draft can only be addressed to people you named, people on the thread being answered, or people you have written to before. The assistant has no WebFetch, so nothing in an email can be sent to a URL; mail goes nowhere except the model and your chat.

### Connecting Google, once
Say "connect Google" and the chief sends these steps (or a sign-in link once they are done). On a laptop, about ten minutes:

1. Go to console.cloud.google.com signed in as your Clear Exchange Workspace account. Project picker (top left), New project, name it `clear-ops-ea`, Create, then select it.
2. APIs & Services, Library: search "Gmail API", Enable. Back to Library: "Google Calendar API", Enable.
3. Google Auth Platform (also shown as OAuth consent screen), Get started. App name `Clear Ops EA`, support email your address. Audience: **Internal** (Workspace users only, so no Google verification is needed). Contact email your address. Agree and Create.
4. Data access, Add or remove scopes. Add `gmail.readonly`, `gmail.compose`, `calendar.readonly`, `calendar.events`. Update, Save.
5. Clients, Create client. Type: **Web application**. Name `clear-ops`. Authorised redirect URIs, Add URI: `https://clear-ops.fly.dev/google/callback` (your app's address if `FLY_APP` or `PUBLIC_URL` differs). Create, then copy the Client ID and Client secret.
6. In GitHub, this repository, Settings, Secrets and variables, Actions, New repository secret, one each: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ACCOUNT` (your Workspace email; no other account can connect) and `GOOGLE_TOKEN_KEY` (any long random string; it encrypts the stored token). Optionally, on the Variables tab, New repository variable `EA_BOOKING_LINK` with your appointment-schedule booking link, which the assistant offers in scheduling drafts. Then Actions, ci, Run workflow, so the service picks them up.
7. Say "connect Google" again. Open the link on your phone or laptop (valid 15 minutes, single use), choose your account, Allow. The chief confirms and the two weekday briefs are scheduled.

Only if Google says the app is blocked: admin.google.com, Security, Access and data control, API controls, Manage third-party app access, find "Clear Ops EA", set it to Trusted.

To disconnect: say "disconnect Google" or send `/google disconnect`. That revokes the grant at Google and deletes the stored token. You can also remove it at myaccount.google.com, Security, Third-party connections. `/google` shows whether it is connected.

The scopes are the narrowest that allow drafts and holds. `gmail.compose` would technically allow sending, which is why the code refuses every send endpoint whatever the model asks. The refresh token is encrypted with AES-256-GCM under `DATA_DIR/secrets` (owner-only) on the data volume.

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
| `UPLOAD_MAX_MB` | Largest file accepted in chat, in MB. Default 20. |
| `UPLOADS_DIR` | Where uploads are saved. Default `DATA_DIR/uploads`; must be outside both repositories. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The OAuth client for the executive assistant (see above). |
| `GOOGLE_ACCOUNT` | The only Google account that may be connected. |
| `GOOGLE_TOKEN_KEY` | Encrypts the stored Google refresh token. Without it a key is derived from the client secret. |
| `EA_BOOKING_LINK` | Paul's appointment-schedule link, offered in scheduling drafts. Set as an Actions variable (not a secret). Optional. |
| `PUBLIC_URL` | Where a browser reaches the service, for the Google redirect. Defaults to `https://<FLY_APP_NAME>.fly.dev` on Fly. |

## Safety model
- Headless permission mode: tools not pre-approved are denied, never left waiting.
- Engineers work like senior engineers: branch, tests, pull request. They cannot merge, push the default branch, force-push, rewrite shared history, delete recursively or disable failing tests.
- One maintainer agent reviews and merges. It runs tests, checks CI, reads the diff, and either merges or requests changes. It cannot edit code. Branch protection on `main` is the hard backstop, since both agents use the same GitHub token.
- The agent-creator has the engineer's tools and limits and works only on this repository. Every worker kind it adds must carry the clean-room rule, get read-only tools unless it is an engineer, and send nothing itself; `test/invariants.test.ts` checks every kind in `JOB_KINDS`, so a new kind that breaks these fails CI. It cannot be scheduled.
- One side effect exists outside that remit (`run_command`, for deploys and migrations) and it needs `YES <id>`.
- The chief never sends email or messages anyone but you. Drafts come to you. The executive assistant saves drafts in your Gmail Drafts folder and places holds with nobody invited; sending, deleting, relabelling, inviting and answering invitations are refused in code, and email it reads can never grant it a permission. An unlisted Telegram sender is told its own id once and nothing else.
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
- Tools for a worker: give its jobs an MCP server through `toolsFor` in `buildApp()` (`src/index.ts`), as the executive assistant does, and gate any sending behind `propose_action`.
