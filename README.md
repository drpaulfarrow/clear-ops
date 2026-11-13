# clear-ops

An agentic workforce for Clear Exchange that you run from chat: Telegram, Discord or WhatsApp, any or all at once.

You message a bot. A chief-of-staff agent answers quick questions itself and delegates longer work to ten workers: a researcher (web research, sourced briefs), a writer (specs, posts, emails in your voice), a senior engineer (implements on a branch with tests and opens a pull request), a maintainer (the one agent that reviews and merges, which runs automatically after every engineer job) an analyst (questions about previous outputs and data), an executive assistant over your Gmail and Google Calendar (triage, drafts, agenda, meeting prep, holds; it never sends or invites), an agent-creator (turns a plain-language request for a new agent into either a recommended schedule on an existing worker or a new worker kind, delivered as a pull request the maintainer reviews) a brand and design director (looks at the live site in a headless browser, critiques it as your buyers would, and writes brand work and page specs for an engineer to build) and a creative strategist (reads the saved evidence and the repositories, researches the web, and lists ranked improvement ideas with the cheapest test for each; it only lists options and never starts a job) a Prebid expert (answers Prebid questions, designs and reviews the seller-side Prebid module, summarises releases, and explains the Prebid.js, Prebid Server (Go and Java), Prebid Mobile and prebid.github.io codebases, contribution rules, release process and Prebid.org governance, from primary sources and Paul's public forks with dates and versions; read-only, never invents fields or versions) and a CV writer (keeps a facts file and master CV in a private folder and tailors CVs, a LinkedIn summary and bios for a role, advisory engagement or investor audience from facts you supplied, asking you questions rather than inventing anything; it saves Markdown, never applies, sends or touches LinkedIn). Every agent can read both repositories, and every worker is told where they are checked out. Research is concise by default; ask for deep or multi-part research ("go deep on the competitor landscape") and the researcher writes a long, structured report with an executive summary, with more turns and budget, while your chat message stays short. Workers run in the background and message you when they finish. You direct; they deliver. The one thing that still waits for a `YES <id>` is a command run outside the engineer's normal remit, such as a deploy. Recurring jobs run on a schedule you set in chat.

While the chief is thinking you see it typing, plus one status line that updates in place with what it is actually doing ("Checking job 39abb7…", "Searching the web: SPUR news…", "Starting an engineer job…") and disappears when the answer arrives. On WhatsApp, which supports neither, you get a single "Working on it." if it takes more than a few seconds.

Every job has a short title of five words or fewer ("Fly deploy", "TollBit research"), and that is how it appears everywhere: the Discord thread, `/jobs`, queue messages and every report, as `Fly deploy · engineer · 16d5d3`. The chief picks it; jobs the workforce starts itself are named after the job they follow ("Review: Fly deploy", "Fix round 2: Fly deploy", "Design round 2: Customer-ready site"), scheduled runs take their schedule's title, and the worker still gets the full brief.

Everything the workforce sends you reads like a colleague on WhatsApp, not like a pull request: three or four plain sentences saying what was done, what you need to do if anything, and a link. No headings, "Outcome:", bullet lists or tables. Each worker writes two things: its full report, saved as the job's output (with any lines the workforce reads, such as the maintainer's verdicts), and a short message, which is all you see when the job finishes. Say `show job <id>` or ask the chief for the detail. The rule (`PAUL_STYLE` in `src/messages.ts`) is in every agent's prompt, and `src/messages.ts` strips anything that slips through before it reaches chat.

Everything runs on the Claude Agent SDK. Conversation memory persists per phone number; jobs, approvals, schedules and standing notes persist in a JSON store on a volume.

A one-page summary of what each worker does and how you use it is in [docs/WORKFORCE.md](docs/WORKFORCE.md).

## What you can say

```
What's the latest on SPUR? Keep it short.
Research TollBit's buyer-side moves this month and tell me if they're building an exchange.
Draft a two-line email to the Prebid board proposing the seller module. Formal.
Engineer: scaffold a Fastify service in the repo with a /health route and tests.
Every Monday at 7am, research what changed in SPUR, CoMP, TollBit and Cloudflare.
Remember: always price examples at half a cent per retrieval.
I want an agent that drafts publisher outreach.
Design: give me three brand directions for Clear Exchange.
Run the design loop: make the site something I can show customers.
What needs me in my inbox today?
Draft a reply to Sam saying half a cent works, and hold Thursday 2pm for the call.
Reach out to Jo at the FT (jo@ft.com) about licensing their archive.
Set up 30 minutes with sam@acme.com next week about the pilot.
/followups   done 3fa9c1   snooze 3fa9c1 monday   draft nudge 7b20e4   /booking <link>
What did Sam last say about pricing?
Prep me for my 10am.
connect Google   /google   /google disconnect
show job 93137e
/jobs   /status   /pending   /reset   /help   /uploads
/resume   retry 3552e7
/spend   /spend yesterday
What DNS records does clearexchange.ai have?
Add a CNAME publisher pointing to clear-exchange.fly.dev.   dns apply 3fa9c1   dns cancel 3fa9c1
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

### Voice notes
Send a voice note or an audio message instead of typing (a Telegram voice note, a Discord voice message, a WhatsApp audio message) and the chief answers the transcript as if you had typed it, so you never have to repeat yourself. The service transcribes the audio itself, on any channel, with one plain HTTPS call to an OpenAI-compatible speech-to-text endpoint: OpenRouter by default, whose key you already have for the models, so there is nothing new to set up and no second account. The audio is sent to that one provider and nowhere else; the file itself is kept in the uploads directory exactly as any other attachment, and `/uploads` and `/delete upload <name>` work on it as usual.

- The chief is told the transcript is a transcript, marked as coming from a voice note and possibly mishearing names and numbers, so it can check anything that looks wrong with you rather than guessing.
- `TRANSCRIBE_MODEL` picks the model (default `openai/whisper-large-v3`; `openai/whisper-large-v3-turbo` and `openai/gpt-4o-transcribe` are also offered). `TRANSCRIBE_API_KEY` and `TRANSCRIBE_BASE_URL` point the call at another OpenAI-compatible provider (Groq, OpenAI, Deepgram) if you ever want one.
- Guardrails: audio over `TRANSCRIBE_MAX_MB` (default 12) or longer than `TRANSCRIBE_MAX_SECONDS` (default 300, measured from the file where it can be), a call that takes more than `TRANSCRIBE_TIMEOUT_MS` (default 60000), and a file that is not audio in a format the provider accepts are all refused before or during the call, with a plain reason.
- With no key at all, or when the provider refuses or cannot be reached, nothing else changes: the chief says plainly that it cannot play the voice note and asks you to type it. A failed transcription never fails the turn. `TRANSCRIBE=off` switches transcription off even when a key is set.
- The key is a service secret: read from the environment, never logged, never written to the store or a repository, and stripped from every worker's environment, like the search and GoDaddy keys.

## Set up in five steps

### 1. A model key: Anthropic or OpenRouter
Create an API key at the Claude Console, or at openrouter.ai to run the agents on cheaper open models (see "Models through OpenRouter" below), and keep it for step 4. Either way the agents are billed by usage, and every job has a spend cap.

### 2. A chat channel: Telegram, Discord, or both

**Discord (threads per job, like Slack).** At discord.com/developers, New Application, then Bot: Reset Token and copy it into `DISCORD_BOT_TOKEN`; on the same page turn on **Message Content Intent**. Under OAuth2, URL Generator: scope `bot`, permissions Send Messages, Create Public Threads, Send Messages in Threads, Read Message History; open the generated URL and add the bot to your server. Message it once; it replies with your user id for `ALLOWED_DISCORD_IDS`. In Discord, every job you start gets its own thread named after the job's title, and its reports, the maintainer's review and any fix rounds land in that thread. The first job from a message gets a thread under that message; when the chief starts several jobs from one message, or you ask from inside a thread, the others get standalone threads in the channel, and the chief links each one (`#Fly deploy`). Job threads auto-archive after a week of quiet rather than a day, and a new report reopens an archived thread. If a thread cannot be opened (for example the bot lost Create Public Threads), the failure is logged and that job reports in the conversation instead. In DMs, Telegram and WhatsApp, jobs report in the chat. Each thread is its own conversation with the chief. DMs to the bot work too.

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
GitHub access can be a GitHub App (recommended: short-lived tokens, new repositories covered automatically, nothing to edit later; steps for a non-engineer in [docs/GITHUB_APP.md](docs/GITHUB_APP.md)) or a personal token, below. Both can be set: the App is used when configured and `GH_TOKEN` is the fallback. Creating repositories always needs a classic `GH_TOKEN`, because GitHub does not let an App installation create repositories on a personal account. `/status` shows which is active and which managed repositories it reaches, and the service says so at start-up and messages Paul once if the App cannot sign in or a managed repository is unreachable.

Create an empty private repo (for example `clear-exchange`) and a fine-grained GitHub token with contents and pull requests read and write on that repo and on this one. Put the token in `GH_TOKEN` and the repo names in `PRODUCT_REPO` and `SELF_REPO`. That is all: on first start the service clones both into `workspace/` and `self/` and configures git to push with the token. The engineer only works in the product repo. It must not be, or contain, anything from previous employer repositories. Protect `main` in the repo settings: require a pull request and the CI check before merging. That makes the maintainer's role a rule GitHub enforces, not only a prompt. Add a workflow that runs the tests on pull requests so the maintainer has a green check to look for.

#### More repositories, and new ones
The workforce manages a list of repositories, not just two: `product` (Clear Exchange), `self` (this workforce) and any in `MANAGED_REPOS`, which by default adds Paul's personal site as `site` (`drpaulfarrow/drpaulfarrowcom`, "drpaulfarrow.com"). Every agent can read all of them. In chat, say which one a job is about ("fix the footer on my site"); the chief passes `repo` to `start_job`, by alias or full `owner/name`, and it defaults to the product. Each repository has its own engineering queue, its own maintainer review and fix loop (three rounds, then a message to Paul) and its own CI merge flow; the daily spend cap counts them together.

To add an existing repository: ask the chief for a workforce change that adds `alias=owner/name` to the default managed list (`repos.extra` in `src/config.ts`; the `MANAGED_REPOS` env var overrides it if you set one), give the `GH_TOKEN` access to it (fine-grained: Settings, Developer settings, Personal access tokens, open the token, Repository access, add the repository; Contents, Pull requests and Workflows read and write), and redeploy. It is cloned on the next start. If the clone fails, the service messages Paul once with exactly which access to add and never logs the token.

To get a new repository, ask the chief in chat ("create a repo called pitch-notes", "make it public" if wanted). The chief starts an engineer job with the `create_repo` permit, which exists only for jobs Paul asked for in chat (never from email, job output, an idea list, a schedule or a fix round). The repository is created under `REPO_OWNER`, private unless Paul says public, with a README and an initial commit on the default branch made by GitHub, then added to the managed list (saved in `DATA_DIR/state.json`, so it survives restarts), cloned and ready to work on. The workforce never deletes repositories, changes visibility or settings, force pushes, or pushes to a default branch. Creating a repository needs a classic `GH_TOKEN` (scopes `repo` and `workflow`), even when the GitHub App is set up, because an App cannot create repositories on a personal account; if the token cannot, the job tells Paul in plain English: make a classic token at GitHub Settings, Developer settings, Personal access tokens, Tokens (classic), replace the `GH_TOKEN` secret in the clear-ops repository and re-run the latest deploy workflow.

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
2. In this GitHub repository: Settings > Secrets and variables > Actions > New repository secret, one for each of: `FLY_API_TOKEN`, `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY`, `GH_TOKEN`, `PRODUCT_REPO` (for example `drpaulfarrow/clear-exchange`), and the bot tokens for the channels you use: `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`. Leave the allowlists (`ALLOWED_TELEGRAM_IDS`, `ALLOWED_DISCORD_IDS`) out for now. A repository variable `CHANNELS` picks the channels; the default is `telegram,discord`.
3. Actions tab > ci > Run workflow. The first deploy creates the app and volume, and the service starts, clones both repositories and begins polling Telegram.
4. Message your bot on each channel. It replies with your id. Add those as the `ALLOWED_TELEGRAM_IDS` and `ALLOWED_DISCORD_IDS` secrets and run the workflow again. From then on it answers only you, and every merge to main redeploys on its own.

If the app name `clear-ops` is already taken on Fly, add a repository variable `FLY_APP` with another name. Logs are at fly.io under the app's Monitoring tab. Any host that runs a Docker container with a persistent volume works the same way; with Telegram there is no webhook to configure.

## Self-improvement
The engineer can work on this workforce as well as on the product. Say "improve yourself: add a tool that reads my Google Calendar" or "give the researcher a stricter sourcing rule" and the chief starts an engineer job with target `self`. It works in `SELF_REPO_DIR`, a checkout of this repository, under the same process as any other task: branch, tests, pull request, then the maintainer reviews and merges. Nothing restarts itself. The GitHub Actions workflow in `.github/workflows/deploy.yml` runs the tests on the merge and deploys to Fly with a rolling strategy, so the old version keeps answering until the new one passes its health check. A few minutes after the engineer reports, the new workforce is live, and your conversation continues from the stored session.

Setup for this: clone this repository into `SELF_REPO_DIR` with a token that can push (same pattern as step 3), and add `FLY_API_TOKEN` as a repository secret so the workflow can deploy. The invariants in `CLAUDE.md` and `test/invariants.test.ts` are what stop a self-improvement from removing the allowlist, the signature check, the clean-room rule or the spend caps.

## Executive assistant (Gmail and Google Calendar)
The `ea` worker is your executive assistant over your own Google Workspace account, at the level you approved, "drafts plus holds". It reads and searches your mail and every calendar you can see. When you ask for it in chat, it saves replies in your voice to your Gmail Drafts folder, and places, moves or removes holds on your own calendar (private events titled "Hold: ...", nobody invited). It cannot delete, archive or relabel mail, or answer invitations, and it can send an email, invite people or cancel an event with attendees only through the approval flow below: everything else is refused in code (`src/google.ts`), not only by its prompt. Once connected, a morning brief (07:30) and an end-of-day wrap (18:00) run on weekdays, as ordinary schedules you can move or cancel in chat ("move the morning brief to 8").

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

### Follow-ups, outreach and scheduling
**Follow-ups.** The assistant keeps a list of three kinds of thing: threads where someone is waiting on you (the last word is their question or request, addressed to you, and you have not replied; or a direct email left unanswered for days), commitments you made in sent mail ("I'll send the deck Friday", "let me check and come back to you", with the day read from the sentence or two working days by default), and threads where you asked something and are waiting on them. Newsletters and notifications are ignored. Each item has a due date and a stale date (waiting on you: due next working day, stale after three; your promises: stale on the day; waiting on them: chase after three working days, stale after five). The 07:30 brief scans and lists them with ids, and items that go stale are nudged in chat at 11:00 or 16:00 on weekdays, once each (again if a snooze runs out). Replying to the thread closes the item on the next scan.

```
/followups                        what is open
done 3fa9c1                       close one
snooze 3fa9c1 monday              also 2d, 1w, tomorrow, next week, 3 Nov
draft nudge 7b20e4                a chaser (or reply) drafted into Gmail, never sent
```

**Outreach.** "Reach out to Jo Bloggs at the FT about licensing their archive for AI answers, jo@ft.com" starts an assistant job that may save drafts. It checks your email history with the person, searches the web for public facts about them and their organisation, reads a few of your sent emails for voice, and saves a personalised draft in your Gmail Drafts. You get a link that opens each draft, ready for you to review and send. Batches work too: "draft outreach to the top 10 leads in job 4c1d2e's output" gives one draft each, at most 25 per job. A draft only goes to an address you gave, someone on the thread, or someone you have written to before; an address found only on the web or in a file is reported to you and the draft is saved with no recipient, so you add it yourself.

**Scheduling.** "Set up 30 minutes with sam@acme.com next week about the pilot" starts a job that may save drafts and place holds. It finds free time on your calendar, places private holds on two or three slots on different days (nobody invited), and drafts the email to Sam with those times and your booking link. When a meeting with Sam is confirmed on your calendar (Sam books through your appointment schedule, or you accept Sam's invitation), the service removes the other holds and tells you. It only ever removes holds it placed for that meeting, and only while they are still holds; if you add a guest to one, it is left alone. Set your booking link once with `/booking https://calendar.app.google/...` (or the `EA_BOOKING_LINK` variable); `/booking` shows it.

Drafts stay in Drafts and holds have no attendees, with no approval needed, exactly as before.

### Sending email, inviting and cancelling (only with your approval of each item)
Added 2 November 2026 at your request. It is never autonomous: a send, an invitation or a cancellation is two steps, and the second is yours.
1. **Prepare.** When you ask in chat ("send Sam the draft", "email lee@acme.com saying...", "invite sam@acme.com to a call on Thursday at 2", "cancel my catch up with Lucy on Tuesday"), the chief starts an `ea` job with the `send` permit. The job can only prepare: it calls `prepare_send_draft` (a draft the assistant created), `prepare_send_email`, `prepare_invite` or `prepare_cancel_event`. The service itself, not the model, then posts the exact text in your chat: To, Cc and Bcc, subject and body for an email; title, time, attendees, location and description for an invitation; the event title, time and the attendees who will be emailed a cancellation for a cancellation (read from your calendar by the service, not taken from the model), with an id and an expiry.
2. **Approve.** You reply `send <id>` (or `send it` when exactly one is waiting), or `cancel <id>`. The service handles that message with no model, only from an allowlisted account, and only when the whole message is the command, so nothing in an email, calendar entry, job output or upload can produce it. It then sends and replies with one line (who it went to, subject, message id, how many of today's allowance are used). For a cancellation, `send <id>` deletes the event with `sendUpdates=all`, so Google emails every attendee a cancellation; `cancel <id>` keeps the event.
To change something waiting, ask in chat; the new version replaces the old one and gets a new id. `/pending` lists what is waiting.

What keeps it safe: an action expires after 24 hours (`OUTBOUND_TTL_HOURS`) and can be cancelled; approving one never authorises another; a draft is re-read just before sending and compared by hash with what you saw, and if it changed nothing is sent and the new version is shown for a fresh approval; a draft with attachments, or one the assistant did not create, is refused; at most 10 sends, invitations and cancellations a day (`OUTBOUND_DAILY_CAP`, London day) and 10 recipients per message (`OUTBOUND_MAX_RECIPIENTS`); every recipient must be a plain, well-formed address and a recipient must be one you named, on the thread, or someone you have written to; text that looks like a key, token or a path to your uploads or secrets is refused; invitations are created on your own calendar only, with `sendUpdates=all`. Every action stays in the store as its log: who approved, when, recipients, subject and the Gmail message or calendar event id. The send endpoints are reachable only through `GoogleApi.approved`, which needs a single-use grant bound to that exact request, minted only by `src/outbound.ts` after the approval. A cancellation only covers an event on your primary calendar that you organise and that has other attendees, re-read just before it runs (if it changed, nothing is cancelled and you see the new version); holds are removed without approval, and an event someone else organised is refused because deleting it would answer their invitation. Google needs no new consent for this: the existing `calendar.events` scope already allows deleting events, so you do not reconnect. RSVPing, deleting or archiving mail, deleting other people's events and relabelling remain forbidden. Scheduled runs (briefs, nudges) never get the `send` permit.

Scopes: no reconnect is needed. Google's documentation lists `gmail.compose` as authorising `users.drafts.send` and `users.messages.send`, and `calendar.events` as authorising `events.insert` with `sendUpdates`. The scopes stay `gmail.readonly`, `gmail.compose`, `calendar.readonly` and `calendar.events`.

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

## CV writer
Ask in chat: "Build my CV from the one I just sent", "Tailor my CV for this role", "A one-paragraph bio for an advisory pitch". The `cv` worker keeps `facts.md` (roles, dates, achievements, numbers only where you supplied them), `master-cv.md` and `bios.md` in `DATA_DIR/cv` (owner-only, never in a repository), saves tailored versions there as Markdown (it pastes into Word or Google Docs; DOCX or PDF would need a new dependency and is not built), and puts the full text in its saved report, which is what you open from chat. Anything it lacks becomes a numbered question for you; anything that might be Microsoft confidential goes in a "Check before use" list and out of the drafts. It has web search and fetch (LinkedIn is blocked), your uploads and one save tool, no mail tool: to draw on your sent mail, ask for an assistant job first. It works with the job seekers agent: that agent's role summary is the input to a tailored CV, and the CV report names the file for a cover note. It never applies, sends, posts or logs in anywhere.

## Pitch and strategy advisor
Ask in chat: "Build the investor deck", "Draft the publisher one-pager and a five-slide outline", "Pressure-test our pricing", "Are we ready to fundraise?". The `advisor` worker reads the saved research (market and competitors, publisher targets, routing and pricing, specs, survey and persona reports) and both repositories, checks the public web, and either builds a pitch in your voice (publisher, AI-company buyer or investor) or acts as a candid consultant: what the evidence supports, red-team questions, the cheapest experiment for each open point and ranked priorities. Decks are saved as slide-ready Markdown (Marp format, which converts to PPTX or PDF with the free Marp tool; PPTX itself would need a new dependency and is not built) in `DATA_DIR/decks` (owner-only, never in a repository), with the full text in its saved report, which is mirrored to the private outputs repository. It never invents traction, customers, quotes or numbers (each is sourced or marked ASSUMPTION), labels simulated-buyer results as simulated, and leads with the service provided. It has web search and fetch, your uploads and one save tool, no Bash, mail or job tools, and sends and posts nothing. One-off; schedule it only if you ask.

## Prebid expert
Ask in chat: "Ask the Prebid expert how bid timeouts should map to our tmax", "Review PR 21 against current Prebid practice", "What changed in Prebid in the last month?". The `prebid` worker has only WebSearch, WebFetch, Read, Glob and Grep (no Edit, Write, Bash or secrets), reads docs.prebid.org, the Prebid GitHub projects, release notes and IAB Tech Lab material, states the date and version of everything it finds, says "not found" rather than inventing fields, modules or versions, and writes a full report with a short message to you. It never posts, files issues or messages anyone, and starts no jobs. Your own Prebid forks are not managed repositories, so it reads upstream. A weekly watch is available on request (Mondays 08:00 London).

## DNS agent (GoDaddy)
The `dns` worker lists your GoDaddy domains and records, explains what a change does, and prepares A, AAAA, CNAME and TXT changes for you to approve in chat. It is read only by default; with the `dns` permit (granted by the chief only when you ask for a change in chat, never to scheduled runs) it can only PREPARE. The service reads the zone and shows you the exact records before and after with an id; you reply `dns apply <id>` (or `dns cancel <id>`) yourself, a whole-message command handled before any model runs. Approvals expire after `DNS_TTL_HOURS` (2). Before an applied change the service saves a snapshot of the whole zone under `DATA_DIR/dns/snapshots` and logs it. Hard blocks in code: no deleting, no NS, MX, SRV, CAA, SOA, SPF, DKIM or DMARC changes, no apex A, AAAA or CNAME, no wildcards, at most 5 records at once, only the domains in `GODADDY_DOMAINS` (default `clearexchange.ai,drpaulfarrow.com`), and no registrar action of any kind. `GODADDY_API_TOKEN` (a Personal Access Token, sent as Bearer to the v3 API, preferred) or `GODADDY_API_KEY` and `GODADDY_API_SECRET` (v1 fallback) are service secrets only, never in a worker's environment. Setup, what GoDaddy's API allows and the Cloudflare fallback: [docs/GODADDY.md](docs/GODADDY.md).

## Design loop
The design worker can see. It takes desktop and mobile screenshots of the live site (`DESIGN_SITE_URL`, by default https://clear-exchange.fly.dev), of any branch of the product (it runs that branch locally, so it can review work before it merges) and of its own boards, and looks at them. It critiques the screenshots as three buyers in turn: a publisher's head of revenue or partnerships, the product lead at an AI company buying content, and an investor. It writes brand work (logo direction, palette, type, tone of voice, UI principles) and specs precise enough for an engineer to build without asking. It writes no production code, opens no pull requests and merges nothing.

Ask for one piece of design work ("Design: critique the publisher page as a news publisher would") and you get one report. Ask for the loop ("make the site something I can show customers") and it runs itself:

1. The designer screenshots the site, runs the persona critiques and writes a spec for the highest-impact issues.
2. An engineer builds it on the product, queued behind any engineering job already running there, and the maintainer reviews and merges as usual (with automatic fix rounds if it requests changes).
3. Once CI has deployed the merge, the designer screenshots the live site again and writes the next spec.
4. After three implemented rounds, or sooner if the critiques find no high-impact issues, it sends a closing report with before and after images.

You hear from it only when something is your call, such as picking one of three brand directions: the boards arrive as images in Telegram or Discord with a lettered question. Reply with your choice ("B, but warmer") and the loop carries on. Screenshots and assets live under `DATA_DIR/design/<job id>`.

## Models through OpenRouter
Set `OPENROUTER_API_KEY` (a GitHub Actions secret of the same name for the Fly deploy) and every agent, the chief included, runs through OpenRouter instead of Anthropic. Nothing else changes: the Agent SDK is pointed at OpenRouter's Anthropic-compatible endpoint (`src/llm.ts`), and the model aliases the roles use map to OpenRouter models. Defaults: `haiku` is `deepseek/deepseek-v4.1-flash`, `sonnet` is `z-ai/glm-5.3`, `opus` and `fable` are `moonshotai/kimi-k3.1-pro`; every role defaults to `haiku`. Change them with `OPENROUTER_HAIKU_MODEL`, `OPENROUTER_SONNET_MODEL` and `OPENROUTER_OPUS_MODEL` (repository variables of the same names), or give a role a full OpenRouter id.

The executive assistant is the exception: it reads your mail and calendar, so it always runs on Claude Sonnet on Anthropic's API directly (`EA_MODEL`, default `sonnet`), and keeps `ANTHROPIC_API_KEY` in use alongside the OpenRouter key. Without that key its jobs fail rather than fall back to OpenRouter. Follow-up work ("Draft nudge <id>" jobs) and everything else, the chief included, uses the open models; the follow-up tracker and stale nudges themselves run no model.

Spend caps keep working because each model in use has a price row handed to the SDK; the defaults are rounded up from list prices. A model without a row is priced as a guess, so the start-up log says so: add it to `OPENROUTER_PRICES`. Put a credit limit on the OpenRouter key too, as the hard backstop.

Before relying on it: OpenRouter documents that Claude Code, which the Agent SDK runs on, is only guaranteed with Anthropic models, so try a research job, a draft and a small engineer job and read the results. Check WebSearch in particular, since it is a server-side tool. In OpenRouter's privacy settings, allow only providers with zero data retention: the chief and the follow-up drafts still see summaries and snippets of mail, and they go to whichever provider serves the model. Remove `OPENROUTER_API_KEY` to go back to Anthropic.

## Web search and browsing
Research-type workers (research, write, ideate, advisor, prebid, cv) and the chief get the service's own search: `web_search` on Brave (set `BRAVE_API_KEY`) and `exa_search` on Exa (set `EXA_API_KEY`), each appearing only when its key is set. The service calls the APIs itself, so search works on any model, including open models on OpenRouter, and the keys never reach a model or a worker. Results are fenced as untrusted content.

Research, ideate, advisor and prebid also get a real browser (`open`, `read`, `click`, `type`, `back`, `src/browse.ts`) for pages WebFetch cannot read and sites that need navigating. It is the design worker's headless Chromium with the same containment: it runs as the unprivileged `designer` user with a fresh profile per job, every request goes through the egress proxy that refuses private addresses, and it is read-only by construction: the page may only make GET, HEAD and OPTIONS requests, so it can follow links and run searches but cannot sign in, post, buy or submit anything; password fields and downloads are refused. The executive assistant, DNS agent, engineers and designer never get these tools. `BROWSE=off` turns it off; `BROWSE_MAX_ACTIONS` (default 60) caps actions per job.

## Configuration
See `.env.example`. The important ones:

| Variable | Meaning |
|---|---|
| `CHANNELS` | Any of `telegram`, `discord`, `whatsapp`, comma separated. Default `telegram`. |
| `ALLOWED_TELEGRAM_IDS`, `ALLOWED_DISCORD_IDS` | Only these ids get a reply. |
| `ALLOWED_NUMBERS` | WhatsApp: only these numbers get a reply. E.164 digits, no plus. |
| `WHATSAPP_APP_SECRET` | WhatsApp: enables webhook signature checks. Set it in production. |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID` | Sign in to GitHub as a GitHub App instead of a personal token (see [docs/GITHUB_APP.md](docs/GITHUB_APP.md)). The installation id is optional: it is found on `REPO_OWNER`'s account. In GitHub Actions the secrets are named `GH_APP_ID`, `GH_APP_PRIVATE_KEY`, `GH_APP_INSTALLATION_ID` (secret names cannot start with `GITHUB_`) and the deploy maps them. |
| `GH_TOKEN` | GitHub token. The fallback when the App is not configured, and the only way to create repositories (a GitHub App cannot create repositories on a personal account). Fine-grained: contents, pull requests and workflows read/write on every managed repository. To let the workforce create repositories it must be a classic token with the `repo` and `workflow` scopes (fine-grained tokens cannot create repositories under a personal account). |
| `PRODUCT_REPO`, `SELF_REPO` | The product and this workforce as `owner/name`, cloned on first start. |
| `MANAGED_REPOS` | More managed repositories: comma-separated `alias=owner/name` (optionally `\|another name`). Default `site=drpaulfarrow/drpaulfarrowcom\|drpaulfarrow.com`. Cloned on first start into `REPOS_DIR/<alias>`. |
| `GODADDY_API_TOKEN`, `GODADDY_API_KEY`, `GODADDY_API_SECRET`, `GODADDY_DOMAINS`, `DNS_TTL_HOURS` | GoDaddy DNS agent: Personal Access Token, or production API key and secret (secrets), the domains it may touch (comma separated, default `clearexchange.ai,drpaulfarrow.com`) and how long an approval lasts (hours, default 2). See [docs/GODADDY.md](docs/GODADDY.md). |
| `OUTPUTS_REPO` | The private repository every finished job's output is copied to as Markdown into folders by type (`designs/`, `research/`, `advice/`, `ideas/`, `engineering/`, `reviews/`, `ops/`, as `<folder>/<date>-<id>-<title>.md`, plus an index README). ea and cv outputs and anything derived from an uploaded file are never copied. Default `drpaulfarrow/clear-outputs`. Nothing is pushed unless GitHub reports it private; the GitHub token needs Contents read and write on it. |
| `REPOS_DIR`, `REPO_OWNER` | Where those clones live (default `DATA_DIR/repos`) and the account new repositories are created under (default `drpaulfarrow`). |
| `REPO_DIR`, `SELF_REPO_DIR` | Where the clones live. |
| `CHIEF_MODEL`, `WORKER_MODEL`, `ENGINEER_MODEL` | Model aliases: `fable`, `opus`, `sonnet`, `haiku`. All three default to `haiku` in code and in `fly.toml`. The maintainer uses `ENGINEER_MODEL`. Set one of them to `sonnet` (or `opus`) to put that role back on a stronger model. |
| `JOB_BUDGET_USD` | Spend cap per research, write or analyse job and per chat turn. |
| `DEEP_RESEARCH_BUDGET_USD` | Spend cap per deep research job (default 20); deep research also gets 200 turns instead of 60. |
| `ENGINEER_BUDGET_USD` | Spend cap per engineering, agent-creator or maintainer job (code default 25; `fly.toml` sets 10). |
| `JOB_STALL_MINUTES` | A running job whose worker shows no activity for this long is stopped, its work kept and its queue moved on. Default 30. |
| `DAILY_BUDGET_USD` | Cap on the cost of jobs finished in one Europe/London day. Default 20. Once reached, new jobs wait (one message to you per day), and `/resume` lifts it for the rest of that day; they also start when the next day begins. |
| `JOB_MAX_RUNTIME_MINUTES` | The longest any job may run before it is stopped the same way. Default 240. |
| `DESIGN_SITE_URL` | The live site the design worker reviews. Default https://clear-exchange.fly.dev. |
| `DESIGN_MODEL`, `DESIGN_BUDGET_USD` | The design worker's model (default `haiku`) and spend cap per design job (default 10). |
| `CHROMIUM_PATH` | Headless browser for screenshots. The Docker image installs `chromium`. |
| `DESIGN_USER` | The unprivileged account the browser and branch previews run as. Default `designer`, created in the Docker image. The browser will not run as root. |
| `UPLOAD_MAX_MB` | Largest file accepted in chat, in MB. Default 20. |
| `UPLOADS_DIR` | Where uploads are saved. Default `DATA_DIR/uploads`; must be outside both repositories. |
| `TRANSCRIBE` | Voice notes: `off` switches transcription off. On by default. |
| `TRANSCRIBE_API_KEY` | The speech-to-text key, if you use a provider other than OpenRouter. Left empty, the OpenRouter key the models already use (`OPENROUTER_API_KEY`) is used, so voice notes work with no new secret. Read from the environment only, never logged, never in a worker's environment. |
| `TRANSCRIBE_BASE_URL`, `TRANSCRIBE_MODEL` | Any OpenAI-compatible `/audio/transcriptions` endpoint and its model. Defaults `https://openrouter.ai/api/v1` and `openai/whisper-large-v3`. |
| `TRANSCRIBE_MAX_MB`, `TRANSCRIBE_MAX_SECONDS`, `TRANSCRIBE_TIMEOUT_MS`, `TRANSCRIBE_LANGUAGE` | Voice notes: most megabytes sent (default 12), longest clip in seconds (default 300), how long to wait (default 60000), and the language (`en`; empty auto-detects). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The OAuth client for the executive assistant (see above). |
| `GOOGLE_ACCOUNT` | The only Google account that may be connected. |
| `GOOGLE_TOKEN_KEY` | Encrypts the stored Google refresh token. Without it a key is derived from the client secret. |
| `EA_BOOKING_LINK` | Paul's appointment-schedule link, offered in scheduling drafts. Set as an Actions variable (not a secret). Optional; `/booking <link>` in chat sets it at runtime and takes precedence. |
| `OUTBOUND_DAILY_CAP` | Most sends, invitations and cancellations per London day. Default 10. |
| `OUTBOUND_MAX_RECIPIENTS` | Most recipients (To, Cc, Bcc) or attendees per item. Default 10. |
| `OUTBOUND_TTL_HOURS` | How long a prepared send or invitation waits for approval. Default 24. |
| `PUBLIC_URL` | Where a browser reaches the service, for the Google redirect. Defaults to `https://<FLY_APP_NAME>.fly.dev` on Fly. |

## Safety model
- Headless permission mode: tools not pre-approved are denied, never left waiting.
- Engineers work like senior engineers: branch, tests, pull request. They cannot merge, push the default branch, force-push, rewrite shared history, delete recursively or disable failing tests.
- One maintainer agent reviews and merges. It runs tests, checks CI, reads the diff, and either merges or requests changes. It cannot edit code. Branch protection on `main` is the hard backstop, since both agents use the same GitHub token.
- The agent-creator has the engineer's tools and limits and works only on this repository. Every worker kind it adds must carry the clean-room rule, get read-only tools unless it is an engineer, and send nothing itself; `test/invariants.test.ts` checks every kind in `JOB_KINDS`, so a new kind that breaks these fails CI. It cannot be scheduled.
- The design worker is read-only apart from two tools of its own: screenshots and saving assets into its own folder. The browser and branch previews run as an unprivileged `designer` user with no secrets in their environment, and every request the browser makes goes through a small proxy that refuses local files, the machine itself and the private network, including redirects and anything a page loads. It builds nothing itself: every spec goes to an engineer and through the maintainer, and the loop is capped at three rounds.
- One side effect exists outside that remit (`run_command`, for deploys and migrations) and it needs `YES <id>`.
- The chief never sends email or messages anyone but you. Drafts come to you. The executive assistant saves drafts in your Gmail Drafts folder and places holds with nobody invited; it sends an email, invites people or cancels an event with attendees only after you approve that exact item with `send <id>` in your own chat; deleting, archiving, relabelling and answering invitations are refused in code, and email it reads can never grant it a permission. An unlisted Telegram sender is told its own id once and nothing else.
- Spend is capped per job; subagent nesting is limited.
- A broken session is dropped automatically so the conversation never jams; `/reset` does it by hand.
- A deploy restarts the service. Jobs that were running are re-queued on start with a note to inspect the working folder and carry on, since the clones live on the volume. After three interruptions a job is stopped and you are told.
- "Running" means a worker is really running it. Every worker has a heartbeat (each step it takes), and a watchdog checks every minute. A job whose worker shows no activity for `JOB_STALL_MINUTES` (default 30), or that runs past `JOB_MAX_RUNTIME_MINUTES` (default 240), is stopped: an engineering job's uncommitted work is stashed in its checkout (`git stash list` shows `clear-ops <id>: <title>`) with its branch noted, the next job in its queue starts, and you get one sentence saying what stalled and what happened. `retry <id>` carries it on from the kept work. A job left marked running with no live worker (a restart that never re-attached) is restarted within a minute, or stopped after three interruptions, and a queue whose lock is free never sits idle. Ask the chief "is that job actually alive?" and it checks when the worker last did anything; ask it to cancel a job (its slot goes to the next one, its work is kept) or to move a queued job to the front.
- Reviews close themselves. If the maintainer requests changes on a pull request, an engineer is sent back to fix it on the same branch and the maintainer reviews it again, up to three rounds. You hear about it only if it is still stuck after that, or if the blocker is something only you can do (a secret, a GitHub setting, account access, a product decision), and then once, with exactly what to do. Engineers and the maintainer bring branches up to date with main themselves, by merging, so nobody has to click "Update branch".
- Only one engineering job (engineer or agent-creator) works on each managed repository at a time, so two never fight over the same checkout. Ask for another while one is running and it is queued behind it: `/jobs` shows `queued behind <title> (<id>)`, and it starts by itself, in the order you asked, when the running one finishes or fails. The product and the workforce queue separately, and the queue survives restarts. Research, writing, analysis and the maintainer's reviews never wait.
- A job that ends in an API or SDK error instead of real work (no Anthropic credit, a rejected API key, rate limits or overload after the retries, an execution error, or no output at all) is recorded as failed, never done, with the reason in `/jobs` (`failed: out of Anthropic credit`), in job_status and in its saved output. Nothing follows a failed job: no review, no fix round, no "Finished". You get one short message saying which job failed, why and what to do; when an outage fails several jobs at once they come in a single message, and more of the same within 15 minutes are gathered into one follow-up. A credit or key failure also pauses both engineering queues, so queued jobs are not burned one after another (`/jobs` shows `held until /resume`). Once you have topped up or fixed the key, send `/resume` (or tell the chief): the pause lifts, the jobs that failed rerun under the same ids, and the queues start again. `retry <id>` reruns one failed job.

## Development
```bash
npm run build     # typecheck and compile
npm test          # offline test suite with a fake agent runner
```

## Extending
- A new worker: ask for it in chat ("I want an agent that...") and the agent-creator does it. By hand: add a case to `workerSpec()` in `src/agents.ts`, the kind to `JobKind` and `JOB_KINDS`, and the kind to the chief's prompt.
- A new side effect: add an executor to `actionExecutors` in `src/jobs.ts`. It will automatically require approval.
- Tools for a worker: give its jobs an MCP server through `toolsFor` in `buildApp()` (`src/index.ts`), as the executive assistant does, and gate any sending behind `propose_action`.
