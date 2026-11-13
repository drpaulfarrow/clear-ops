# What the workforce can do, and how Paul uses it

You talk to one bot (Telegram, Discord or WhatsApp). A chief of staff answers quick questions itself and hands longer work to a worker that runs in the background and sends you one short message when it finishes. The full report is saved; say `show job <id>` for it.

## The workers

| Ask for | Worker | What you get |
|---|---|---|
| Research, "go deep on..." | researcher | A sourced brief (long and structured if you ask for depth) |
| Posts, emails, specs in your voice | writer | A draft |
| "Engineer: build X" | engineer | A pull request with tests; the maintainer reviews and merges it, and review fixes loop on their own (three rounds) |
| Runs after every engineer job (you do not ask for it) | maintainer | Runs the tests and CI, reads the diff, then merges or requests changes. It never edits code |
| Questions about earlier outputs or data | analyst | An answer |
| Inbox, agenda, drafts, holds, meeting prep, outreach | executive assistant | Gmail drafts and calendar holds on your own calendar; it sends an email, invites people or cancels an event with attendees only after you approve that exact item in chat (`send <id>`). Weekday 07:30 brief and 18:00 wrap |
| "I want an agent that..." | agent-creator | A schedule on an existing worker, or a new worker, as a pull request |
| Brand, site critique, page specs | design director | Images and specs for an engineer; no production code |
| "What should we do next?" | creative strategist | A ranked list of options. It only lists; nothing starts until you pick one |
| "Build the investor deck", "pressure-test our pricing" | pitch and strategy advisor | Slide-ready Markdown decks, one-pagers and candid consulting notes, from the saved research. Never invents traction or numbers |
| Prebid questions, module review, release news | Prebid expert | Sourced answers with dates and versions; read-only, never posts or files anything |
| "Build my CV", "tailor it for this role" | CV writer | Markdown CVs, bios and a facts file kept in a private folder, from facts you supply; asks you questions rather than inventing |
| GoDaddy records ("what does clearexchange.ai have?", "add a CNAME") | DNS agent | Reads your zones; prepares a change that shows the exact before and after. Nothing is written until you reply `dns apply <id>` |

## Rules of the road

- Jobs only start when you ask for them. Besides the schedules you set (including the weekday 07:30 brief and 18:00 wrap once Google is connected), the only jobs that start by themselves are the maintainer's reviews, the fix rounds of pull requests you asked for, and the rounds of a design loop you started. Suggestions from reviews, research or the strategist come back as options for you to choose.
- Send a voice note or an audio message instead of typing and the chief answers the transcript as if you had typed it; the audio itself is kept in your uploads. With no transcription key set, it says plainly that it cannot play it and asks you to type.
- Up to two engineering jobs per repository at once, each in its own working copy so they never fight over the same files (`ENGINEER_SLOTS`, at most 3); ask for a third while two are running and it queues, per repository. `/jobs` shows the queue.
- Say which repository a job is about: the product (the default), `self` (the workforce) or `site` (drpaulfarrow.com, your personal site). Every worker can read all of them.
- Ask for a new repository in chat ("create a repo called X", add "public" if you want it public). It is created under drpaulfarrow, private by default, with a README, and can be worked on straight away. Workers never delete repositories or change their settings, and never create one unless you asked.
- Anything outside the engineer's normal remit waits for `YES <id>`, `send <id>`, `cancel <id>` or `buy <id>` (an email, invitation or cancellation the assistant prepared, or an order a job prepared; you see its exact text, or the shop, the items, the total and a picture, first). An email, invitation or cancellation expires after 24 hours (`OUTBOUND_TTL_HOURS`) and an order after 20 minutes (`PURCHASE_WAIT_MINUTES`). Deploys of the product happen through GitHub Actions, not from the workforce.
- Buying works the same way: a job fills the basket and stops at the checkout page, pressing nothing, and nothing is bought until you approve that exact order with `buy <id>` or on the one-time approval page; there is no spending limit, and the README's "Buying things" section has the rest.
- There is no spend cap unless you set one (`DAILY_BUDGET_USD`; your call, 13 November 2026); `/spend` shows one figure, OpenRouter's own, and says so plainly if it cannot be read; `/resume` lifts a cap or a credit hold. A per-job cap (`JOB_BUDGET_USD` and friends) is counted in that same real money, call by call, so a job is never stopped for budget while it has really spent pennies; if a job is stopped for money you get one plain sentence naming what it really spent, the cap it hit and which measure that was.

## Commands

`/jobs` `/board` (a link to the read-only jobs board page) `/status` `/pending` `/spend [yesterday]` `/uploads` `/followups` `/booking <link>` `/google` `/resume` `/reset` `/help`, plus `show job <id>`, `retry <id>`, `cancel <id>` (outbound items), `done <id>`, `snooze <id> <when>`, `YES <id>`, `send <id>`, `dns apply <id>`, `dns cancel <id>`, `signup apply <id>`, `signup cancel <id>`, `buy <id>` (approve the order a job prepared) and `buy cancel <id>`. Each approval command is for one item, you send it yourself, and it expires.

## Things only you do

Add the secrets in GitHub (Settings > Secrets and variables > Actions), connect Google once with the link the chief sends, add your chat ids to the allowlist secrets, and top up Anthropic credit if a job reports it ran out. GitHub access is best set up once as a GitHub App ([GITHUB_APP.md](GITHUB_APP.md): numbered steps, secrets `GH_APP_ID` and `GH_APP_PRIVATE_KEY`, installed on All repositories so new repositories are covered with no token edits; `/status` shows it is working). Until then the `GH_TOKEN` secret is used. Creating repositories still needs a classic GitHub token, even with the App, because GitHub does not let an App create repositories on a personal account (`repo` and `workflow` scopes) as the `GH_TOKEN` secret; a fine-grained token cannot create repositories under a personal account, and it only reaches repositories you added under Repository access. If a job says it could not create or clone a repository, it tells you exactly which of these to change. Setup is in the [README](../README.md).
