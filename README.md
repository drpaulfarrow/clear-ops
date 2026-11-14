# clear-ops

An agentic workforce for Clear Exchange that you run from chat: Telegram, Discord or WhatsApp, any or all at once.

You message a bot. A chief-of-staff agent answers quick questions itself and delegates longer work to specialist workers (thirteen kinds, listed in [docs/WORKFORCE.md](docs/WORKFORCE.md)): a researcher (web research, sourced briefs), a writer (specs, posts, emails in your voice), a senior engineer (implements on a branch with tests and opens a pull request), a maintainer (the one agent that reviews and merges, which runs automatically after every engineer job) an analyst (questions about previous outputs and data), an executive assistant over your Gmail and Google Calendar (triage, drafts, agenda, meeting prep, holds; it sends an email, invites people or cancels an event with attendees only after you approve that exact item in chat with `send <id>`), an agent-creator (turns a plain-language request for a new agent into either a recommended schedule on an existing worker or a new worker kind, delivered as a pull request the maintainer reviews) a brand and design director (looks at the live site in a headless browser, critiques it as your buyers would, and writes brand work and page specs for an engineer to build) and a creative strategist (reads the saved evidence and the repositories, researches the web, and lists ranked improvement ideas with the cheapest test for each; it only lists options and never starts a job) a Prebid expert (answers Prebid questions, designs and reviews the seller-side Prebid module, summarises releases, and explains the Prebid.js, Prebid Server (Go and Java), Prebid Mobile and prebid.github.io codebases, contribution rules, release process and Prebid.org governance, from primary sources and Paul's public forks with dates and versions; read-only, never invents fields or versions) and a CV writer (keeps a facts file and master CV in a private folder and tailors CVs, a LinkedIn summary and bios for a role, advisory engagement or investor audience from facts you supplied, asking you questions rather than inventing anything; it saves Markdown, never applies, sends or touches LinkedIn), a pitch and strategy advisor (builds publisher, AI-company and investor pitches in your voice from the saved research, and pressure-tests them as a candid consultant; it never invents traction, customers, quotes or numbers) and a DNS agent (reads your GoDaddy zones, explains a change and prepares it; nothing is written until you reply `dns apply <id>`). Every agent can read every managed repository, and every worker is told where they are checked out. Research is concise by default; ask for deep or multi-part research ("go deep on the competitor landscape") and the researcher writes a long, structured report with an executive summary, with more turns and budget, while your chat message stays short. Workers run in the background and message you when they finish. You direct; they deliver. The one thing that still waits for a `YES <id>` is a command run outside the engineer's normal remit, such as a migration. Product and workforce deploys happen through GitHub Actions when a change merges to main, not from the workforce's machine. Recurring jobs run on a schedule you set in chat.

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
/board   /jobs   /status   /pending   /reset   /help   /uploads
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

- A voice note carries no caption, so when there is a transcript it is handed over as your message for that turn ("Paul's message (transcribed from his voice note…)"), not just as a file note: the chief answers what you said instead of only acknowledging a file. With a caption, the caption stays your message and the transcript is the note.
- The chief is told the transcript is a transcript, marked as coming from a voice note and possibly mishearing names and numbers, so it can check anything that looks wrong with you rather than guessing.
- `TRANSCRIBE_MODEL` picks the model (default `openai/whisper-large-v3`; `openai/whisper-large-v3-turbo` and `openai/gpt-4o-transcribe` are also offered). `TRANSCRIBE_API_KEY` and `TRANSCRIBE_BASE_URL` point the call at another OpenAI-compatible provider (Groq, OpenAI, Deepgram) if you ever want one.
- Guardrails: audio over `TRANSCRIBE_MAX_MB` (default 12) or longer than `TRANSCRIBE_MAX_SECONDS` (default 300, measured from the file where it can be), a call that takes more than `TRANSCRIBE_TIMEOUT_MS` (default 60000), and a file that is not audio in a format the provider accepts are all refused before or during the call, with a plain reason.
- With no key at all, or when the provider refuses or cannot be reached, nothing else changes: the chief says plainly that it cannot play the voice note and asks you to type it. A failed transcription never fails the turn. `TRANSCRIBE=off` switches transcription off even when a key is set.
- The key is a service secret: read from the environment, never logged, never written to the store or a repository, and stripped from every worker's environment, like the search and GoDaddy keys.


### Talking to Cleo (live voice in Discord)
Join any voice channel in the ClearOps server and the bot joins you and Cleo, the voice of ClearOps, says hello. Just talk: when you pause, she answers, usually within a second or two, and if you talk over her she stops. Small talk and quick questions she answers herself; anything that needs the workforce (start or check a job, ask about your mail or calendar, remember something) she hands to the chief exactly as if you had typed it in the voice channel's chat, says "One moment", waits up to `VOICE_ANSWER_WAIT_SECONDS` (12) for its reply and gives you the gist. Slower answers and job reports land in that chat and she tells you when they arrive. Leave the channel and she leaves too; after `VOICE_IDLE_MINUTES` (10) with nobody speaking she leaves on her own. After a restart she rejoins you if you are already in a channel.

- How it works: everything runs through OpenRouter on the key you already have, so there is nothing to warm up. Each turn is transcribed with the same speech-to-text call voice notes use, Cleo's brain (a fast model, `VOICE_MODEL`) writes the answer, and OpenRouter's text to speech (`VOICE_TTS_MODEL`, default Mistral Voxtral, voice `VOICE_TTS_VOICE` `gb_jane_neutral`) speaks it a sentence at a time. Only your audio is listened to, never anyone else's in the channel, and nothing is recorded or saved.
- What it cannot do: approve anything. A spoken request reaches the chief as "Voice request from Paul ...", so `send <id>`, `dns apply <id>`, `yes <id>` and the like can only ever be typed.
- The bot needs Connect and Speak in the voice channel. `VOICE=off` switches it off; `VOICE_SILENCE_MS` (700) is how long a pause ends your turn.

### Buying things
Ask in chat ("order more coffee pods on Amazon", "buy that book") and a job fills the basket in its browser, signing in with your vault login, and goes to the final checkout page. It never presses the button that places the order. Instead you get the shop, the items and the total, with a link to a one-time approval page showing a picture of the checkout and Approve or Decline buttons. Reply `buy <id>` or `buy cancel <id>` in chat if you prefer. There is no spending limit, but nothing is bought without your approval of that exact order. If the shop or the total changed since you saw it, nothing is pressed.

Card: for shops that ask for card details, add one card to the vault on a one-time page (ask ClearOps for the card link). Use a virtual card with a low limit. It is stored encrypted, never shown to an agent or in chat (only its last four digits), and entered by the service only on a checkout you approved. Amazon uses the card already saved in your Amazon account. "Remove the card" deletes it.

### The jobs board (a page on your phone)
Send `/board` and you get a link to a page on this service you can bookmark. It shows jobs at a glance, laid out for a phone: what is running now (each job's title, kind, the repository it is in, its id, how long it has been going and when its worker last did anything), what is queued (in order, its place on its repository's queue, the job it is waiting behind, or the queue hold after a credit or key failure), what finished in the last day (the outcome, with a link to a saved output or a pull request where the job already has one) and the next run of each schedule, in London time. It refreshes itself every ten seconds.

The link carries a long-lived token the service mints itself and keeps in the store; sending `/board` again gives the same link, and the token is never logged. Nothing on the page changes anything: it is one read-only route, with no button, no form and no model call, so it cannot cancel, resume, retry, spend or merge anything. It deliberately shows no spend, cost, budget or cap figure anywhere, and never a job's brief, output, transcript, file path, secret or anything from your mail, calendar or uploaded files: titles, kind, status, timings, repository, ids and a link that already exists only.

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

Set `CHANNELS=whatsapp`. At Meta for Developers, create an app of type Business and add the WhatsApp product. Under WhatsApp > API Setup you get a test number and a temporary token; for production, add your own number and create a permanent System User token with `whatsapp_business_messaging`. Note the Phone number ID and the token, add your personal number as a recipient, and point the webhook (`https://<host>/webhook`, verify token `WHATSAPP_VERIFY_TOKEN`, subscribe to `messages`) at the running service, which needs a public URL (ngrok locally). Twilio, 360dialog and Vonage sit on top of the same API if you prefer a provider; they need a small adapter in `src/whatsapp.ts`.
</details>

### 3. A clean repository for the engineer
GitHub access can be a GitHub App (recommended: short-lived tokens, new repositories covered automatically, nothing to edit later; steps for a non-engineer in [docs/GITHUB_APP.md](docs/GITHUB_APP.md)) or a personal token, below. Both can be set: the App is used when configured and `GH_TOKEN` is the fallback. Creating repositories always needs a classic `GH_TOKEN`, because GitHub does not let an App installation create repositories on a personal account. `/status` shows which is active and which managed repositories it reaches, and the service says so at start-up and messages Paul once if the App cannot sign in or a managed repository is unreachable.

Create an empty private repo (for example `clear-exchange`) and a fine-grained GitHub token with contents and pull requests read and write on that repo and on this one. Put the token in `GH_TOKEN` and the repo names in `PRODUCT_REPO` and `SELF_REPO`. That is all: on first start the service clones both into `workspace/` and `self/` and configures git to push with the token. The engineer works in whichever managed repository a job names (the product by default). The product repo must not be, or contain, anything from previous employer repositories. Protect `main` in the repo settings: require a pull request and the CI check before merging. That makes the maintainer's role a rule GitHub enforces, not only a prompt. Add a workflow that runs the tests on pull requests so the maintainer has a green check to look for.

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
2. In this GitHub repository: Settings > Secrets and variables > Actions > New repository secret, one for each of: `FLY_API_TOKEN`, `ANTHROPIC_API_KEY` (or `OPENROUTER_API_KEY` if you run the models through OpenRouter), `GH_TOKEN`, `PRODUCT_REPO` (for example `drpaulfarrow/clear-exchange`), and the bot tokens for the channels you use: `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`. Leave the allowlists (`ALLOWED_TELEGRAM_IDS`, `ALLOWED_DISCORD_IDS`) out for now. A repository variable `CHANNELS` picks the channels; the deploy defaults to `telegram,discord` when it is unset (locally the default is `telegram`, see the environment table). Add these only when you use the feature: the GitHub App secrets `GH_APP_ID`, `GH_APP_PRIVATE_KEY`, `GH_APP_INSTALLATION_ID` (see [docs/GITHUB_APP.md](docs/GITHUB_APP.md)); the search and browser secrets `BRAVE_API_KEY`, `EXA_API_KEY` and `VAULT_KEY`; the voice-note settings `TRANSCRIBE_API_KEY`, `TRANSCRIBE_MODEL` and `TRANSCRIBE_BASE_URL`; the sign-up settings `SIGNUP_EMAILS`, `SIGNUP_SITES`, `SIGNUP_TTL_HOURS` and `SIGNUP_DAILY_CAP` (see [docs/SIGNUP.md](docs/SIGNUP.md)); the Google secrets `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ACCOUNT`, `GOOGLE_TOKEN_KEY` (see the executive assistant section); the GoDaddy secrets `GODADDY_API_TOKEN`, or `GODADDY_API_KEY` and `GODADDY_API_SECRET` (see [docs/GODADDY.md](docs/GODADDY.md)); and the variables `FLY_APP`, `EA_BOOKING_LINK`, `GODADDY_DOMAINS`. The workflow stages every one of these into Fly, and missing ones are simply empty.
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

## Signing up for a site (only with your approval)
ClearOps can create an account for you on a site you name in chat ("register me on suno.com"). It is never autonomous: a sign-up is two steps and the second is yours.
1. **Prepare.** The chief starts a job of a kind that carries the browser (`research`, `ideate`, `advisor`, `prebid`) with the `signup` permit. The job reads the site's own sign-up page and calls `signup_prepare`; the service itself, not the model, then applies the rules and posts the exact plan in your chat: the site, the email address to be used, every detail that would be filled in, a link to the site's terms, and an id. Nothing is filled in.
2. **Approve.** You reply `signup apply <id>` (or `signup cancel <id>`). The service handles that whole message with no model, only from an allowlisted account, so nothing in a page, an email, a job output or an upload can produce it. Only then does it open the sign-up page, check the plan again against a hash of exactly what you saw, check the day's cap again, generate the password, fill the form and submit it.

The login goes into the vault (site, username and password) only when the site positively confirms the account: a success word such as "welcome", "account created" or "check your inbox". Anything else, a captcha wall, a server error, "already registered" or a rejected form, stores nothing, tells you it could not be confirmed, and leaves the site free to be prepared again. The password is generated by the service and never appears in chat, in a log or in a job output. The username is resolved once when the plan is prepared, so what you are shown, what the page is given and what the vault stores are the same value. A required consent box such as "I agree to the Terms of Service" appears in the plan and is ticked only if you approved it; one the plan does not name stops the sign-up instead. The email address must be one you named for sign-ups (`SIGNUP_EMAILS`); with none named, every sign-up is refused and the service says so. A site must still be one you have allowed agents to act on, or be on `SIGNUP_SITES`, and a site that already has a login in the vault is refused as a duplicate. Approvals expire after `SIGNUP_TTL_HOURS` (6) and there are at most `SIGNUP_DAILY_CAP` (3) approved per London day.

Fixed in code, whatever a page, an email or a job output says: never pay, never enter card, bank or billing details, never start a paid trial that needs them; never phone, identity, government or age verification; never an account on a money site, an email provider, Microsoft, a password manager, a government identity service or this workforce's own infrastructure; never a site you did not name; never a second account where a login is already stored; never a change to an existing account (password, recovery address, 2FA, contact details) and never deleting one; never posting, commenting or publishing as you. If a site asks for payment, a phone number or an identity, the service stops, tells you and stores the attempt as needing you. A verification email is normal: the assistant can read it (read only) and a follow-up job may open its link, but replying to it, forwarding it or sending anything is never done. One line per attempt and per approval is appended to `DATA_DIR/signup/actions.log`, never with a password in it. Details: [docs/SIGNUP.md](docs/SIGNUP.md).

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

There is one figure about money, and it is the provider's (your call, 13 November 2026). The service reads the usage OpenRouter reports for your API key (the cumulative amount charged to it, at `/api/v1/key`) at most once a minute, and today's spend is what has been charged since the London day began. The daily cap (`DAILY_BUDGET_USD`) counts that figure, so it trips on what OpenRouter actually bills. The start-of-day reading is kept on the volume, so a restart does not reset the day; the one gap is a restart that spans midnight, which re-bases the day on the first reading after it boots, so spend between midnight and that reading goes uncounted (it is a soft cap, and a single run is still bounded by its own cap). It is as accurate as OpenRouter's own accounting, which can lag a job by a few seconds and is read at most once a minute.

The Agent SDK's own cost for each run (from the table in `src/llm.ts`, rounded up from list prices) is still recorded and still backs the per-run budget cap that stops a runaway run, but it is internal: it is never shown, under any label. It is the stand-in the daily cap is judged on while OpenRouter cannot be read, so the queue is never held back by nothing.

If OpenRouter cannot be read (an outage, a rate limit, a reply that is not a number), `/spend` says so plainly and shows no figure in its place, and the once-a-day "cap is hit" message says the cap is being judged on an internal stand-in rather than printing one. A job is never held back on that stand-in alone while OpenRouter is reachable: the figure is re-read and the queue released if the real spend is under the cap.

`OPENROUTER_PRICES` is now only the per-run cap: set it for a model that has no row in `src/llm.ts`, or leave it unset while you use the default models. On Anthropic (`OPENROUTER_API_KEY` unset) nothing changes: the SDK's cost at Anthropic's list prices is the bill, so it is shown and named as Anthropic's own list price, and no usage endpoint is read. No new secret is needed either way. Put a credit limit on the OpenRouter key too, as the hard backstop.

Before relying on it: OpenRouter documents that Claude Code, which the Agent SDK runs on, is only guaranteed with Anthropic models, so try a research job, a draft and a small engineer job and read the results. Check WebSearch in particular, since it is a server-side tool. In OpenRouter's privacy settings, allow only providers with zero data retention: the chief and the follow-up drafts still see summaries and snippets of mail, and they go to whichever provider serves the model. Remove `OPENROUTER_API_KEY` to go back to Anthropic.

## Web search and browsing
Research-type workers (research, write, ideate, advisor, prebid, cv) and the chief get the service's own search: `web_search` on Brave (set `BRAVE_API_KEY`) and `exa_search` on Exa (set `EXA_API_KEY`), each appearing only when its key is set. The service calls the APIs itself, so search works on any model, including open models on OpenRouter, and the keys never reach a model or a worker. Results are fenced as untrusted content.

Research, ideate, advisor and prebid also get a real browser (`open`, `read`, `click`, `type`, `back`, `sign_in`; `src/browse.ts`) for pages WebFetch cannot read and for using sites. It is the design worker's headless Chromium with the same containment: it runs as the unprivileged `designer` user with a fresh profile per job, and every request goes through the egress proxy that refuses private addresses. Reading works anywhere. Acting (any request other than GET, HEAD or OPTIONS: submitting forms, signing in) works only on sites agents may act on (`src/site-policy.ts`): a starter list of research, standards, reference, news and travel-search sites, plus whatever you add or remove by telling ClearOps ("let agents act on example.com", "make example.com read-only"), plus any site with a login in the vault. Paying, sending, posting, deleting and the like are refused on every site: the agent reports what it would do instead. Banks and payments, email, Microsoft and work accounts, password managers, government identity and tax, and the workforce's own infrastructure can never be allowed or stored. The executive assistant, DNS agent, engineers and designer never get the browser. `BROWSE=off` turns it off; `BROWSE_MAX_ACTIONS` (default 60) caps actions per job.

### The login vault
Ask ClearOps to "add a login" and it sends a private one-time link (15 minutes) to a page on the service where you type the site, username, password and, optionally, the two-factor setup key. The page (and the card page below, and what both say back) is laid out for a phone, works with JavaScript switched off and loads nothing from anywhere; `docs/vault-pages/` shows what it looks like. Logins are never typed in chat. They are stored encrypted with `VAULT_KEY` (a Fly secret; set it as a GitHub Actions secret of the same name). An agent asks to `sign_in` and the service fills the form itself, only while the page is on that site over https; no model sees the password, and password fields are refused to agents. Signed-in sessions are saved encrypted so later jobs do not log in again. With a login stored, agents sign in and act on that site freely (your call, 13 Nov 2026), still never paying, sending, posting or deleting. "List the vault" and "remove the example.com login" manage it. Storing the two-factor key lets agents sign in without you, but the vault then holds both factors for that site.

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
| `JOB_BUDGET_USD` | A job's own spend cap, in the money OpenRouter actually charged for that job's calls: the service reads the provider's own figure for each call (`src/realcost.ts`) and stops the run only when the sum passes the cap. Off unless you set it (your call, 13 November 2026); turn limits and `JOB_MAX_RUNTIME_MINUTES` still stop a runaway run whatever you set. A job is never stopped while it has really spent pennies, and the Agent SDK's estimate is never used as the figure. |
| `DEEP_RESEARCH_BUDGET_USD` | The same cap for a deep research job, in the provider's money (off unless set); deep research also gets 200 turns instead of 60. |
| `ENGINEER_BUDGET_USD` | The same cap for an engineering, agent-creator or maintainer job, in the provider's money (off unless set). |
| `SDK_RUNAWAY_BUDGET_USD` | The Agent SDK's own per-run guard, priced from the rounded-up table in `src/llm.ts` (on OpenRouter about fifty times the real charge). It is not a bill and never a job's cap: the only thing it does is stop a run that has gone badly wrong. Default 1000, set in `fly.toml`. |
| `JOB_STALL_MINUTES` | A running job whose worker shows no activity for this long is stopped, its work kept and its queue moved on. Default 30. |
| `DAILY_BUDGET_USD` | Cap on spend in one Europe/London day. Counted from OpenRouter's own usage figure (`src/spend.ts`, at most one call a minute); while that cannot be read it is judged on an internal stand-in figure, and `/spend` then says the figure could not be read instead of showing one. Off unless you set it (your call, 13 November 2026). If set and reached, new jobs wait (one message to you per day), and `/resume` lifts it for the rest of that day; they also start when the next day begins. |
| `JOB_MAX_RUNTIME_MINUTES` | The longest any job may run before it is stopped the same way. Default 240. |
| `DESIGN_SITE_URL` | The live site the design worker reviews. Default https://clear-exchange.fly.dev. |
| `DESIGN_MODEL`, `DESIGN_BUDGET_USD` | The design worker's model (default `haiku`) and spend cap per design job, in the provider's money (off unless set). |
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
| `SIGNUP_EMAILS`, `SIGNUP_SITES`, `SIGNUP_TTL_HOURS`, `SIGNUP_DAILY_CAP` | Sign-ups: the address(es) you named for sign-ups (with none, every sign-up is refused), extra domains a sign-up may be prepared on, how long an approval lasts (hours, default 6) and how many may be approved per London day (default 3). See [docs/SIGNUP.md](docs/SIGNUP.md). |
| `PUBLIC_URL` | Where a browser reaches the service, for the Google redirect. Defaults to `https://<FLY_APP_NAME>.fly.dev` on Fly. |

## Safety model
- Headless permission mode: tools not pre-approved are denied, never left waiting.
- Engineers work like senior engineers: branch, tests, pull request. They cannot merge, push the default branch, force-push, rewrite shared history, delete recursively or disable failing tests.
- One maintainer agent reviews and merges. It runs tests, checks CI, reads the diff, and either merges or requests changes. It cannot edit code. Branch protection on `main` is the hard backstop, since both agents use the same GitHub token.
- The agent-creator has the engineer's tools and limits and works only on this repository. Every worker kind it adds must carry the clean-room rule, get read-only tools unless it is an engineer, and send nothing itself; `test/invariants.test.ts` checks every kind in `JOB_KINDS`, so a new kind that breaks these fails CI. It cannot be scheduled.
- The design worker is read-only apart from two tools of its own: screenshots and saving assets into its own folder. The browser and branch previews run as an unprivileged `designer` user with no secrets in their environment, and every request the browser makes goes through a small proxy that refuses local files, the machine itself and the private network, including redirects and anything a page loads. It builds nothing itself: every spec goes to an engineer and through the maintainer, and the loop is capped at three rounds.
- The only way an account is created for you is the sign-up gate, and only after your own `signup apply <id>`. A worker can only prepare one; the service shows you the exact site, address and fields with a hash of what you saw, and refuses paying, card and bank details, phone, identity, age and government verification, money sites, email providers, Microsoft, password managers, government identity services and this workforce's own infrastructure, a site you did not allow, a duplicate account, any change to an existing account and any post or publish as you. The generated password goes straight into the vault and is never in chat, in a log or in a job output. `test/invariants.test.ts` checks these.
- One side effect exists outside that remit (`run_command`, for commands such as migrations and other one-off operations; deploys of the product go through GitHub Actions, not from here) and it needs `YES <id>`.
- The chief never sends email or messages anyone but you. Drafts come to you. The executive assistant saves drafts in your Gmail Drafts folder and places holds with nobody invited; it sends an email, invites people or cancels an event with attendees only after you approve that exact item with `send <id>` in your own chat; deleting, archiving, relabelling and answering invitations are refused in code, and email it reads can never grant it a permission. An unlisted Telegram sender is told its own id once and nothing else.
- Spend is capped per job; subagent nesting is limited.
- A broken session is dropped automatically so the conversation never jams; `/reset` does it by hand.
- A deploy restarts the service. Jobs that were running are re-queued on start with a note to inspect the working folder and carry on, since the clones live on the volume. After three interruptions a job is stopped and you are told.
- "Running" means a worker is really running it. Every worker has a heartbeat (each step it takes), and a watchdog checks every minute. A job whose worker shows no activity for `JOB_STALL_MINUTES` (default 30), or that runs past `JOB_MAX_RUNTIME_MINUTES` (default 240), is stopped: an engineering job's uncommitted work is stashed in its checkout (`git stash list` shows `clear-ops <id>: <title>`) with its branch noted, the next job in its queue starts, and you get one sentence saying what stalled and what happened. `retry <id>` carries it on from the kept work. A job left marked running with no live worker (a restart that never re-attached) is restarted within a minute, or stopped after three interruptions, and a queue whose lock is free never sits idle. Ask the chief "is that job actually alive?" and it checks when the worker last did anything; ask it to cancel a job (its slot goes to the next one, its work is kept) or to move a queued job to the front.
- Reviews close themselves. If the maintainer requests changes on a pull request, an engineer is sent back to fix it on the same branch and the maintainer reviews it again, up to three rounds. You hear about it only if it is still stuck after that, or if the blocker is something only you can do (a secret, a GitHub setting, account access, a product decision), and then once, with exactly what to do. Engineers and the maintainer bring branches up to date with main themselves, by merging, so nobody has to click "Update branch".
- Up to two engineering jobs (engineer or agent-creator) work on each managed repository at once (`ENGINEER_SLOTS`, at most 3), each in its own working copy (the checkout, and a git worktree beside it), so they never fight over the same files. Ask for a third while two are running and it is queued: `/jobs` shows `queued behind <title> (<id>)`, and it starts by itself, in the order you asked, when one finishes or fails. Two in parallel can touch the same files, so expect the odd merge conflict, which the review loop sorts out. The product and the workforce queue separately, and the queue survives restarts. Research, writing, analysis and the maintainer's reviews never wait.
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
