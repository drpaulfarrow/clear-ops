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
- **Approvals do not work here.** `send`, `buy`, `dns apply`, `signup apply`, a one-time code, `act as me`, `read doc`, `yes <id>`, `/password` and device pairing are refused with one plain line, and still work in Discord. Something prepared from the app (an email, a purchase) is approved in Discord by its id. The app approving things is a later slice and will be its own change.
- **Not yet**: attaching files, voice notes, pictures in replies (the caption is kept), a separate conversation per project.

### How the chat is kept safe (`src/web-chat.ts`, `src/orchestrator.ts`)

- A message enters only through `POST /app/api/chat`, behind the gate. It must be a JSON request from this site's own script: a form, or a page on another site, is refused even with Paul's cookie.
- It reaches the orchestrator as `web:paul` with a flag only that route sets. `web:paul` is on no allowlist, so every approval gate that checks `isAllowed` refuses it for itself, and the orchestrator lets it through only as exactly that sender, in exactly the app's conversation, with no files.
- Approval words are refused twice, in the route before the message is kept and in the orchestrator before any command is parsed.
- A message shaped like a one-time code is never written down: a placeholder is kept instead, and it never reaches the orchestrator.
- The transcript is one owner-only file, `DATA_DIR/app/chat.json`, capped at 500 messages, with tokens redacted. It holds what the chief told Paul, which can include what a job found. The status line is never saved.
- What the service says is rendered and escaped by `src/reports.ts` before the app sees it; Paul's own words travel as text.

## Still to come

What it does not do yet: approving anything, cancelling or re-running a job, merging a pull request, changing caps or models, project spaces of Paul's own, voice, push notifications, search. Each is a later slice. Something waiting on Paul is shown with the words to send in chat, and nothing else about it.

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

## The gate (`src/index.ts`)

One middleware over everything under `/app`, matched the way Express matches routes. The open list is the sign-in page, `/app/auth` and `/app/assets` (a fixed table of five files that hold no data). Everything else needs a session: a page is sent to the sign-in, a JSON route answers 401. A route added under `/app` later is behind the gate without anyone putting it there. Two routes are not a GET: the one that ends the session, and Paul's message to the chief.

## What it shows, and the rules it keeps (`src/app-data.ts`)

The app shows more than the jobs board at `/jobs`, on Paul's instruction: spend, a job's cost and its trace. The rules those already live by are unchanged.

- **Money is the provider's own figure or nothing.** Today's spend goes through `spendDisplay`; when OpenRouter cannot be read the app says so and shows no number. A job's cost is `realCost` (`src/worker-stats.ts`), which never returns the Agent SDK's estimate. Until jobs record a provider figure, a job's cost reads "No real figure".
- **A trace is served as `src/trace.ts` stored it**: clipped, redacted, and names and outcomes only for the kinds that work over Paul's mail, calendar, CV and zones.
- **A saved output is served only where the reports view would serve it** (`reportFor`), rendered by `src/reports.ts`, which escapes everything.
- **A model is shown only where it is known**: a pinned job's own, or a running or queued job's current role model. A finished, unpinned job says "Not recorded".
- **The agents' names** (Fitz, Vera, Scout, Pip) are placeholders in `public/app/app.js` until Paul names them.

## The page itself (`src/app-pages.ts`, `public/app/`)

One stylesheet and one script, no framework and no build step, plus three open-licensed fonts served from the npm packages. The policy allows script, styles, fonts and requests from this service only, no inline script or style, and no frames. The script draws with DOM nodes, never by assembling HTML; the one exception is the saved output the service already rendered. It asks for the board every five seconds while the tab is visible, and for the conversation every second and a half while something is happening in it.
