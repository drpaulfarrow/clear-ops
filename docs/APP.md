# The web app

Paul asked on 18 Nov 2026 for a proper interface in place of Discord. This is it, built in slices. It lives at `/app` on the service, behind GitHub sign-in for one account.

## What slice 1 does

The board and the job page. They only read.

- **The board**, in three views: by status (waiting on Paul, running, queued, done, failed), as a timeline, and by repository.
- **The whole history**: the timeline loads older finished jobs a page at a time, back to the first.
- **One job**: what it is, its model, what it cost, how long it ran, its saved trace (newest step first, updating while it runs), its pull request and its saved output.
- **Today's spend against the cap**, in the header, with whether the service is healthy.

`docs/app/board.png`, `docs/app/job.png` and `docs/app/phone.png` show it with made-up jobs.

## What slice 2 adds: chat with the chief

The app opens on a conversation with the chief, with the board beside it. A switch in the header shows the chat, both, or the board; a phone shows one at a time. `docs/app/home.png` and `docs/app/phone-chat.png` show it with made-up jobs.

- **It is its own conversation.** The chief keeps a separate thread of talk for the app, so it does not remember what was said in Discord, and Discord does not see what is said here.
- **Jobs started here report here**, and each appears in the conversation as a card that updates and opens the job page. They do not also post to Discord yet.
- **While the chief works** the conversation shows what it is doing, as Discord does.
- **Slash commands work as typed**: `/jobs`, `/spend`, `/resume`, `/trace <id>` and the rest. There is no menu of them yet.
- **Typed approval words do not work here.** `send`, `buy`, `dns apply`, `signup apply`, a one-time code, `act as me`, `read doc`, `yes <id>`, `/password` and device pairing are refused with one plain line, and still work in Discord. Since slice 3 the app approves with buttons instead (below).
- **Not yet**: attaching files, voice notes, pictures in replies (the caption is kept), a separate conversation per project.

### How the chat is kept safe (`src/web-chat.ts`, `src/orchestrator.ts`)

- A message enters only through `POST /app/api/chat`, behind the gate. It must be a JSON request from this site's own script: a form, or a page on another site, is refused even with Paul's cookie.
- It reaches the orchestrator as `web:paul` with a flag only that route sets. `web:paul` is on no allowlist, so every approval gate that checks `isAllowed` refuses it for itself, and the orchestrator lets it through only as exactly that sender, in exactly the app's conversation, with no files.
- Approval words are refused twice, in the route before the message is kept and in the orchestrator before any command is parsed.
- A message shaped like a one-time code is never written down: a placeholder is kept instead, and it never reaches the orchestrator.
- The transcript is one owner-only file, `DATA_DIR/app/chat.json`, capped at 500 messages, with tokens redacted. It holds what the chief told Paul, which can include what a job found. The status line is never saved.
- What the service says is rendered and escaped by `src/reports.ts` before the app sees it; Paul's own words travel as text.

## What slice 3 adds: approving and acting from the app

Paul's call on 18 Nov 2026, asked twice: approve from the app, one tap, for everything.

- **Waiting on me** shows each waiting email, calendar change, purchase, DNS change and sign-up in the gate's own words, the same text it sends in chat, with two buttons. One tap decides it. What happened is said in the app's conversation and in the chat where the item was first put to him.
- **The same cards sit at the foot of the chat**, wherever the item was first put to him, so a decision can be made without leaving the conversation.
- **A job's page** has buttons to stop it, move it to the front of its queue, try a failed one again, and run it again on one of the three models a job may be pinned to. A job run again keeps its brief, title and pull request, reports in the app, and carries over nothing it was permitted before. Reviews, fix rounds, design-loop jobs, bridge jobs and the assistant cannot be run again from here.
- **The cap and hold banners** have a button that sends `/resume`.
- **Typed approval words are still refused** in the app's chat. A button is tied to the exact item shown; a typed word is tied to nothing.

### How a tap is held to the same standard as the typed word (`src/app-approver.ts`, `src/index.ts`)

1. The request is behind the GitHub gate and must be this site's own script (a form or another site is refused).
2. It must name one item that is waiting now, of the right kind.
3. It must carry the fingerprint of the exact text the service showed for that item. If the item changed, or the card is stale, nothing is decided.
4. Only then is a grant minted: a random string, good for one use within a minute. This route is the only place that mints one.
5. The grant goes to that item's own gate, which first asks its old question (is this an allowlisted chat account?) and takes a grant only when the answer is no. The gate then runs every check it runs for a typed approval: expiry, daily caps, and that what was shown is still what is true. It records the decision as made by "the web app".

A purchase is offered only while its job still holds the basket, as before. Nothing a model, page, email, job or chat message says can produce a grant.

### What this changes in the rules
Three invariant tests said nothing but the orchestrator and a gate itself may approve mail, DNS or a sign-up. They now say the same about everything outside the app's approval route, and that route has its own invariant. `CLAUDE.md` gains one sentence saying so.

## Still to come

What it does not do yet: reviewing and merging a pull request from the app, cancelling or re-running a job, merging a pull request, changing caps or models, project spaces of Paul's own, voice, push notifications, search. Each is a later slice. Something waiting on Paul is shown with the words to send in chat, and nothing else about it.

## Switching it on (Paul, once, about five minutes)

The app is off, and every page under `/app` is closed, until these two secrets exist.

1. On GitHub: Settings, Developer settings, OAuth Apps, New OAuth App.
2. Application name: `ClearOps`. Homepage URL: `https://clear-ops.fly.dev`. Authorization callback URL: `https://clear-ops.fly.dev/app/auth/callback`. Register.
3. Copy the Client ID. Press Generate a new client secret and copy that too.
4. In the clear-ops repository: Settings, Secrets and variables, Actions, New repository secret. Add `UI_GITHUB_CLIENT_ID` and `UI_GITHUB_CLIENT_SECRET`.
5. Re-run the latest deploy workflow. Then open `https://clear-ops.fly.dev/app`.

Only the GitHub account `drpaulfarrow` gets in. To allow a different account instead, add a repository variable `UI_GITHUB_LOGIN`.

## How the sign-in works (`src/app-auth.ts`)

- GitHub is asked for no scope. The token it returns can read the public profile and nothing else, is used for one request (`GET /user`) and is dropped. It is never stored, logged or put in a cookie.
- The login must be the allowed one. From the first sign-in GitHub's numeric id for it is kept in the store (`appGithubUser`), and the same login under another id is refused.
- The round trip is tied to the browser by a random `state` in a ten-minute HttpOnly cookie, compared in constant time. A callback that fails that check never reaches GitHub.
- A session is one HttpOnly, Secure, SameSite=Lax cookie: the time issued, the GitHub id and a signature made with the service's own key (`appSessionKey`). It lasts 30 days. Lax, not Strict, because the sign-in ends on a redirect that began at github.com.
- GitHub is asked who someone is at most ten times a minute.
- The client secret is a service secret: stripped from every worker's environment (`WORKER_STRIPPED` in `src/github-auth.ts`).

## Finished is not the same as done (`outcomeOf` in `src/app-data.ts`)

Paul's point on 18 Nov 2026: a run that ended is not a wish that was met, and the board showed them alike. A job's status in the store only says its worker's run ended without an error. The app now also says what came of it, from evidence the service itself holds and nothing else:

- **Confirmed** (the only tick): a purchase the service placed, an email it sent, a DNS change it applied, an account it created, or a review whose own verdict line says the pull request was merged.
- **Needs you**: something it prepared is waiting for your approval, or its review left the pull request for you.
- **Not done**: it was allowed to buy, send, change or sign up and the gate's record shows it did not (with why: expired, declined, never put to you), its review asked for changes, or the run failed.
- **Finished**: the run ended and the service holds nothing either way. Research, writing and analysis land here, because a worker saying it went well is not evidence.

Who is believed, in order (19 Nov 2026):

1. **Paul.** A finished job's page asks "Did it do what you asked?" with Yes and No buttons. His answer is kept on the job (`verdict`), outranks everything else, can be cleared, and changes nothing else about the job.
2. **The service's own records**, as above.
3. **The worker's own report.** Every worker now ends its report with a line saying how it turned out: `GOAL: met`, `GOAL: not met: <why>` or `GOAL: needs Paul: <what>` (`REPORT_RULE` in `src/messages.ts`; kept on the job as `claimed`). A worker that says it did not get there, or that it needs him, is taken at its word and shown as Not done or Needs you. A worker that says "met" still gets no tick: the card reads "It says it did what you asked. Nothing here confirms that." Nothing in the service acts on the line; no job is failed, retried or reviewed differently because of it. The line never reaches chat.

Jobs that finished before this have no such line and read as before.

A card also carries the first of what the worker told Paul, except for the kinds that work over his mail, calendar, CV and zones. The board's status view is piled the same way: Confirmed done, Finished not confirmed, Did not get there. Nothing here asks a model anything.

## The gate (`src/index.ts`)

One middleware over everything under `/app`, matched the way Express matches routes. The open list is the sign-in page, `/app/auth` and `/app/assets` (a fixed table of five files that hold no data). Everything else needs a session: a page is sent to the sign-in, a JSON route answers 401. A route added under `/app` later is behind the gate without anyone putting it there. Four routes are not a GET: ending the session, Paul's message to the chief, his decision on a waiting item, and an action on a job.

## What it shows, and the rules it keeps (`src/app-data.ts`)

The app shows more than the jobs board at `/jobs`, on Paul's instruction: spend, a job's cost and its trace. The rules those already live by are unchanged.

- **Money is the provider's own figure or nothing.** Today's spend goes through `spendDisplay`; when OpenRouter cannot be read the app says so and shows no number. A job's cost is `realCost` (`src/worker-stats.ts`), which never returns the Agent SDK's estimate. Until jobs record a provider figure, a job's cost reads "No real figure".
- **A trace is served as `src/trace.ts` stored it**: clipped, redacted, and names and outcomes only for the kinds that work over Paul's mail, calendar, CV and zones.
- **A saved output is served only where the reports view would serve it** (`reportFor`), rendered by `src/reports.ts`, which escapes everything.
- **A model is shown only where it is known**: a pinned job's own, or a running or queued job's current role model. A finished, unpinned job says "Not recorded".
- **The agents' names** (Fitz, Vera, Scout, Pip) are placeholders in `public/app/app.js` until Paul names them.

## The page itself (`src/app-pages.ts`, `public/app/`)

One stylesheet and one script, no framework and no build step, plus three open-licensed fonts served from the npm packages. The policy allows script, styles, fonts and requests from this service only, no inline script or style, and no frames. The script draws with DOM nodes, never by assembling HTML; the one exception is the saved output the service already rendered. It asks for the board every five seconds while the tab is visible, and for the conversation every second and a half while something is happening in it.
