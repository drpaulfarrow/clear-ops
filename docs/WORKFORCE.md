# What the workforce can do, and how Paul uses it

You talk to one bot (Telegram, Discord or WhatsApp). A chief of staff answers quick questions itself and hands longer work to a worker that runs in the background and sends you one short message when it finishes. The full report is saved; say `show job <id>` for it.

## The workers

| Ask for | Worker | What you get |
|---|---|---|
| Research, "go deep on..." | researcher | A sourced brief (long and structured if you ask for depth) |
| Posts, emails, specs in your voice | writer | A draft |
| "Engineer: build X" | engineer | A pull request with tests; the maintainer reviews and merges it, and review fixes loop on their own (three rounds) |
| Questions about earlier outputs or data | analyst | An answer |
| Inbox, agenda, drafts, holds, meeting prep, outreach | executive assistant | Gmail drafts and calendar holds on your own calendar; it never sends or invites. Weekday 07:30 brief and 18:00 wrap |
| "I want an agent that..." | agent-creator | A schedule on an existing worker, or a new worker, as a pull request |
| Brand, site critique, page specs | design director | Images and specs for an engineer; no production code |
| "What should we do next?" | creative strategist | A ranked list of options. It only lists; nothing starts until you pick one |

## Rules of the road

- Jobs only start when you ask for them. Suggestions from reviews, research or the strategist come back as options for you to choose.
- One engineering job per repository at a time; others queue, per repository. `/jobs` shows the queue.
- Say which repository a job is about: the product (the default), `self` (the workforce) or `site` (drpaulfarrow.com, your personal site). Every worker can read all of them.
- Ask for a new repository in chat ("create a repo called X", add "public" if you want it public). It is created under drpaulfarrow, private by default, with a README, and can be worked on straight away. Workers never delete repositories or change their settings, and never create one unless you asked.
- Anything outside the engineer's normal remit waits for `YES <id>`. Deploys of the product happen through GitHub Actions, not from the workforce.
- Daily spend is capped (`DAILY_BUDGET_USD`, default 20); `/spend` shows today's, `/resume` lifts a cap or a credit hold.

## Commands

`/jobs` `/status` `/pending` `/spend [yesterday]` `/uploads` `/followups` `/booking <link>` `/google` `/resume` `/reset` `/help`, plus `show job <id>`, `retry <id>`, `done <id>`, `snooze <id> <when>`, `YES <id>`.

## Things only you do

Add the secrets in GitHub (Settings > Secrets and variables > Actions), connect Google once with the link the chief sends, add your chat ids to the allowlist secrets, and top up Anthropic credit if a job reports it ran out. GitHub access is best set up once as a GitHub App ([GITHUB_APP.md](GITHUB_APP.md): numbered steps, secrets `GH_APP_ID` and `GH_APP_PRIVATE_KEY`, installed on All repositories so new repositories are covered with no token edits; `/status` shows it is working). Until then the `GH_TOKEN` secret is used. Creating repositories still needs a classic GitHub token, even with the App, because GitHub does not let an App create repositories on a personal account (`repo` and `workflow` scopes) as the `GH_TOKEN` secret; a fine-grained token cannot create repositories under a personal account, and it only reaches repositories you added under Repository access. If a job says it could not create or clone a repository, it tells you exactly which of these to change. Setup is in the [README](../README.md).
