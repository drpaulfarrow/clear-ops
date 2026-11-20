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
- **Slash commands work as typed**: `/jobs`, `/spend`, `/resume`, `/trace <id>` and the rest. Since slice 8 typing a slash opens a menu of them.
- **Typed approval words do not work here.** `send`, `buy`, `dns apply`, `signup apply`, a one-time code, `act as me`, `read doc`, `yes <id>`, `/password` and device pairing are refused with one plain line, and still work in Discord. Since slice 3 the app approves with buttons instead (below).
- **Not yet**: a separate conversation per project. Files and voice notes came in slice 7, pictures in replies in slice 8, and chats of Paul's own beside the main one in slice 9.

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

## What slice 4 adds: reviewing and merging a pull request (`src/app-pulls.ts`)

The board has an Open pull requests column: every open pull request in the repositories ClearOps manages, newest first, read from GitHub itself (`docs/app/pulls.png`). Tapping one opens it on a page of its own: title, branch, author, description, every check on its head commit, and each changed file with its changes, opened one file at a time (`docs/app/pull.png`, a made-up pull request). Merge is one tap, and it is the only place the service itself merges anything. No model is involved. A job tied to a pull request has the same panel on its own page, above the trace.

The first version (18 Nov 2026) reached a pull request only through a job, by the address the worker typed in its report. Workers mistype that address or name another pull request first, and Paul could not find the two that were open (19 Nov 2026). The list is now GitHub's own and does not depend on any job.

- **Only a managed repository, by its alias, and a number.** `/app/api/pulls/<alias>/<number>`. The alias must be exactly one ClearOps manages. No address, owner or repository name is taken from a request.
- **The list never holds up a page.** The board answers from the last reading and reads again in the background, at most once a minute for each repository. A repository GitHub would not show is named under the list, so "none open" is never claimed for it.
- **The commit Paul was shown.** The tap carries the head commit of the view. The service looks again first and refuses if new commits were pushed, and GitHub is given the same commit so it refuses too.
- **Nothing blocked is merged.** Closed, a draft, in conflict, a check failed or still running, or GitHub not yet sure it can merge: the button is off and the panel says why. Look again asks GitHub afresh. Branch protection stays the backstop, and GitHub's own refusal is shown as said.
- **One write only.** A merge commit, as Paul's own merges are. It never squashes, rebases, pushes, approves, comments, closes or deletes a branch.
- **From this site's own script, signed in.** The same check as every other action in the app. What was merged is said in the app's chat.
- **Another party's text.** Titles, descriptions and diffs are cut to size (100 files, 20,000 characters a file, 300,000 in all), have secrets redacted, and are shown as plain text, never as HTML.

On this repository a merge redeploys the service once no job is running, and the panel says so. Not here yet: asking for changes, commenting, or merging with a check still red. Those are done on GitHub.

### A job and its pull request
A job is tied to a pull request only inside the repository the job works on (`forJob`). When its report names that repository under another owner (`dpaulfarrow/clear-ops` for `drpaulfarrow/clear-ops`), the owner is taken to be a slip: the job's link, its panel and what GitHub is asked all use the real repository, and the panel says what the report wrote. A pull request in any other repository is not the job's and gets no panel. When GitHub answers "not found" for the address a job names, the job no longer reads as waiting on Paul: it says GitHub does not show that pull request.

### What this changes in the rules
"Only the maintainer merges" was true of everything in the service. It is still true of every agent. The one addition is Paul's own tap, which has its own invariant test, and `CLAUDE.md` has one clause saying so. The engineer and maintainer denials are untouched. On 19 Nov 2026, on Paul's say, the tap went from "a job's own pull request" to "any open pull request in a repository ClearOps manages".

## What slice 5 adds: threads (`src/web-chat.ts`, `src/orchestrator.ts`)

Every job's page and every pull request's page has "Talk to Marlo about this": a chat box whose messages go to the chief with that job or pull request attached, so Paul does not have to say what he is talking about (`docs/app/thread.png`). Each is a conversation of its own, as a Discord thread is: its own transcript, its own running context with the chief, and the jobs started from it report back into it. The main chat stays for everything else. A card on the board says when its thread has something in it.

- **The address is the topic.** `web:job:<id>` or `web:pull:<alias>:<number>`. The app names a thread as `job:<id>` or `pull:<alias>:<number>`, and the service builds the address only for a job the store holds or a repository ClearOps manages. Nothing else in a request is ever used as an address.
- **What the chief is told.** For a job, the same context a Discord thread gets: its title, brief, status and the thread's recent messages, marked as from the store and not from Paul. For a pull request, which one and in which repository, and that a job about it works on that same pull request and merges nothing. The chief's own prompt, tools and model are unchanged.
- **Everything that held for the main chat holds in a thread.** Signed in, this site's own script, the app's own sender that no allowlist holds, approval words refused before they are kept, a one-time code never written down.
- **Kept apart.** The main conversation keeps its newest 500 messages and each thread its newest 200, so neither can push the other out. At most 200 threads are kept; the one quiet for longest goes first.
- **Typing is not interrupted.** The thread box is one element kept across redraws, and the caret and scroll are put back when the page under it redraws.

### Conflicts
A pull request whose branch conflicts with its base cannot be merged, and the panel now has "Ask Marlo to resolve the conflicts". It sends one ordinary message in Paul's name into that pull request's thread, asking for an engineer job to merge the base into the branch, resolve the conflicts, run the build and tests and push to that same pull request, and not to merge it. The chief decides how and starts the job like any other request; the button has no powers of its own.

### What this changes in the rules
The app's sender used to pass the orchestrator in exactly one conversation, `web:main`. It now passes in the main conversation or a well-formed thread (`isWebConversation`). The invariant test pins the pattern, and that the route's address is only ever one the service itself built.

## What slice 6 adds: the Spend page (`src/live-settings.ts`, `appSpend` in `src/app-data.ts`)

The spend meter in the header opens a page (`docs/app/spend.png`, made-up figures).

- **Today.** The provider's own figure for the day against the daily cap, as the header shows it.
- **Where it went.** What the provider charged today by who ran on which model ("Engineers on glm-5.3", "The chief on deepseek-v4.1-flash"), dearest first, then by project, then the jobs themselves. This is the line that shows a dear model on the wrong role. Every run is priced once, in the background, after it has ended: one request to OpenRouter for each of its calls, whose reply gives the charge and the model (`src/realcost.ts`, `priceAfter` in `src/jobs.ts`, `priceChat` in `src/orchestrator.ts`). So a job appears a little after it finishes, on the day it finished, and the chief's own replies appear as they are priced. What is left of the day's figure is jobs still running and calls the provider has not priced. Nothing here is an estimate, and pricing never holds a job up or feeds a cap.
- **Caps.** The daily cap, the cap on one engineering or review job, and the cap on any other job. Each is an amount between $0.50 and $500, or put back to the deploy's own setting.
- **Models.** Which model the chief, the workers, the engineers and the maintainer run on: one of the aliases this deploy already maps to a model. The executive assistant always runs on Claude and is not offered.

What Paul sets is kept in the store and laid over the deploy's own values, so the rest of the service reads `config` as before. A change applies to the next run and is said in the app's chat. Only the app's own route writes these settings (`POST /app/api/settings`, signed in, this site's own script); `config` is touched only for a setting that was changed here.

Two things to know. The eval (`npm run eval`) is meant to follow a change of model, and a change made here does not run it. And these settings live in the store on the data volume, so they survive a deploy: `fly.toml` no longer has the last word on a setting changed here until it is put back.

### What this changes in the rules
Caps and models were deploy-time only. `CLAUDE.md` gains a clause and there is an invariant test: one module writes these settings, one route calls it, and it can assign exactly three caps and four roles' models.

## What slice 7 adds: files and voice notes with a message (`webFiles` in `src/web-chat.ts`)

Both message boxes (the main chat and a thread) have a paperclip and, where the browser can record, a microphone. A screenshot can also be pasted straight into the box. What is chosen waits in a tray above the box and goes with the next message Paul sends, or on its own. A voice note is recorded in the browser, waits in the tray like any file, and is transcribed by the service as a voice note from any channel is.

- **Saved like any channel's upload.** The orchestrator's own upload path (`src/uploads.ts`): the private uploads directory, sanitised names, owner-only files, the size cap, zip and PDF handling, never executed. The chief is told what arrived in the same words, and sees a picture inline.
- **The bytes come in the message.** The app sends each file as base64 in the one JSON message route, so the same-site check that guards every action in the app guards files too. Nothing is fetched from anywhere.
- **All or nothing.** At most 5 files and 18 MB together. If any file is not what the app sends, the message is refused whole.
- **The larger body is read only for a signed-in browser.** Anyone else meets the app-wide 100 KB limit before a large body is read.
- **A caption cannot approve.** Approval words are refused before a file is saved, as in the main chat.
- **The transcript keeps the names, never the contents.**

Pictures in replies, the slash-command menu and a preview of a picture before it goes came in slice 8. A sent message still shows a picture file by its name only.

### What this changes in the rules
The app's sender used to pass the orchestrator only with no files. It now carries files its own route received from Paul's signed-in browser. One line of an existing test said the opposite and is changed; the invariant test pins where the bytes come from and who gets the larger body.

## What slice 8 adds: pictures in replies, a command menu, and a look at a picture before it goes

`docs/app/pictures.png` and `docs/app/commands.png` show it with made-up jobs.

- **Pictures in replies** (`sendImage` and `picture` in `src/web-chat.ts`). A design job's chosen pictures now appear in the conversation or thread the job reports to, with the caption under them, where before only the caption was kept. A tap opens the picture full size.
  - The service keeps its own copy in `DATA_DIR/app/pictures`, owner-only, under the number of the message it came with. It is a PNG or a JPEG by its bytes, never by its name, and at most 10 MB. Anything else is not kept, and its caption still is.
  - The app reads it from `GET /app/api/chat/picture/<name>`, behind the sign-in like everything under `/app`. The name must be one of the transcript's own (a message number and `png` or `jpg`) that a kept message shows. No path comes from the request.
  - A picture goes when its message does, and anything in the folder that no kept message shows is removed at start.
- **The command menu** (`WEB_COMMANDS` in `src/web-chat.ts`, `commandMenu` in `public/app/app.js`). Typing a slash in either message box opens a list of commands with a line on each, narrowed as more is typed. Arrow keys move, Enter or Tab chooses, Escape closes; on a phone a tap chooses.
  - Choosing only fills the box. Nothing is sent until Paul sends it, and it is then checked and refused like anything typed.
  - The list is the chief's own commands less the owner-only ones the app refuses when typed (`/password`, `/pair`, `/unpair`, `/whoami`, `/google disconnect`). A test holds it against `/help` in both directions, so a command added to the chief fails the test until it is placed on the menu or named as left off.
- **A look before it goes.** A picture waiting in the tray shows a small preview, drawn in the browser from the file. Nothing extra is sent.

Not here: a preview on a message after it is sent. The service keeps a sent file only in the uploads directory, which the app does not read. Showing it again would mean either reading uploads back out to the browser or keeping a second copy outside that directory, and both touch the uploads rule, so it waits for Paul's say.

### What this changes in the rules

Nothing is loosened. One read route is added, for pictures the service itself put in the conversation. The invariant test pins that it takes a name and no path, that only `sendImage` keeps a picture, and that the app's chat never reads the uploads directory.

## What slice 9 adds: chats of Paul's own (`open` and `ownChats` in `src/web-chat.ts`)

Paul asked on 19 Nov 2026 to start a new chat on a new subject whenever he likes and pick between them. `docs/app/chats.png` shows it with made-up jobs.

- **A bar above the conversation** names the chat being shown and opens the list: Main, then his own, the one spoken in most recently first. New chat starts another. The app remembers which one was open.
- **Each is its own conversation with the chief**, as a job's thread is: what is said in one is not carried into another. Jobs started in a chat report there and show there as cards. The chief's notes and the jobs themselves are shared, as everywhere.
- **A chat is opened by its first message.** New chat only clears the page. The service makes the chat's id, at random, when that first message arrives, and names it from the first line of what is kept of the message, cut to 48 characters. A one-time code is never kept, so it never becomes a name.
- **Main is where the service reports**: decisions, settings changes and the cards for what is waiting on him appear there only. A chat of his own stays on its subject, and the header still says when something waits.
- **Limits.** 50 chats, each keeping as much as the main conversation. Opening one more drops the chat quiet for longest, with its messages and pictures. A job that finishes after its chat has gone reports in Main.

Not here yet: renaming or deleting a chat, and a marker for a chat with something new in it.

### What this changes in the rules

One invariant is widened, on Paul's ask: which conversations the app's sender may speak in. It was the main one or the thread of a job or a pull request; it is now also a chat of his own. What the invariant protects is unchanged and still pinned by the test: the address is only ever one the service made, a request names a chat only by an id the transcript already keeps or asks for a new one with one fixed word, a chat is opened only by the message route after the same-site check, reading never opens one, and approval words are refused in a chat as everywhere in the app.

## A voice note is shown as what was heard (`heard` in `src/web-chat.ts`)

Paul's point on 19 Nov 2026: a voice note came back as a file chip and a line saying it was saved and how to delete it, which is how a file is treated, not a note. `docs/app/voice.png` shows it now.

- **His message shows his words.** Once the note is transcribed, the transcript appears on his own message under a "Voice note" label. That is what the chief answers, and a transcript can mishear, so he can see what was understood. While it is being transcribed the message says so.
- **No file receipt for it in the app.** The "Saved ... /delete upload" line is no longer sent for a voice note here. The recording is still kept with his uploads, as before, and `/uploads` lists it.
- **If it could not be transcribed** it is a file after all: the message says so, shows the file, and the usual receipt follows.
- **A transcript that reads as a one-time code is not written down**, as a typed one is not.
- **In the tray** a recording waiting to go reads "Voice note" with how long it runs.
- **Other channels are unchanged.** Discord, Telegram and WhatsApp still send the saved-file receipt for a voice note.

Not here: playing the recording back in the app. That would mean reading uploads back out to the browser, which is the same open question as thumbnails on sent pictures.

## A job's report is one tap from the answer, and first on its page

Paul's ask on 20 Nov 2026: when a job makes a document, it should come up in the answer, or at least be linked there. `docs/app/report-link.png` shows it.

- **The finished message links to the report.** On every channel a finished job's message ends "Full report: show job <id>." (`reportPointer` in `src/messages.ts`). The app reads that sentence back and shows an "Open the report" button in its place, for a job the store holds. The transcript keeps the sentence as sent.
- **The link opens the report in full**: the job's page with the report expanded and scrolled to (`#/job/<id>/report`).
- **The report is first on the job's page**, directly under the figures. It was last, below the thread and a long trace, where a phone hid it. It starts short so the rest of the page stays within reach, with "Read it all" to open it.

## Still to come

What it does not do yet: a cost estimate before a job starts, project spaces of Paul's own (each with its own chat), live voice with Cleo, push notifications, search. Each is a later slice.

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
2. **The service's own records**, as above, and now **GitHub's own word on a job's pull request** (`src/pr-state.ts`): merged means done, closed without merging means not done, and this is the only record of a merge Paul makes himself. It outranks an earlier review verdict. This counts only for the job whose pull request it is: a fix round the service handed it to, or a job GitHub says the pull request was opened during. A job that only diagnosed, reviewed or pushed to someone else's pull request is not done because it merged; it reads as finished, not confirmed, and says the pull request it worked on was merged. GitHub is asked in the background, read-only, with the credential the service already uses for that repository; a page never waits for it, a merged pull request is asked about once, and an open one again every few minutes. Until GitHub has answered, a job reads as it did before.
3. **The worker's own report.** Every worker now ends its report with a line saying how it turned out: `GOAL: met`, `GOAL: not met: <why>` or `GOAL: needs Paul: <what>` (`REPORT_RULE` in `src/messages.ts`; kept on the job as `claimed`). A worker that says it did not get there, or that it needs him, is taken at its word and shown as Not done or Needs you. A worker that says "met" still gets no tick: the card reads "It says it did what you asked. Nothing here confirms that." Nothing in the service acts on the line; no job is failed, retried or reviewed differently because of it. The line never reaches chat.

Jobs that finished before this have no such line and read as before. Their pull requests are still looked up, so old jobs Paul has merged move from Waiting on me to Confirmed done.

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
