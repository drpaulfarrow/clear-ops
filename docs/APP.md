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

Renaming, deleting and a mark for something new came the next day (`rename`, `close` and `mainSaidAt` in `src/web-chat.ts`; `docs/app/chat-manage.png`):

- **Rename and Delete** sit under the list for the chat being shown. Main has neither. Deleting cannot be undone, so it takes a second tap, in the page and never in a browser dialog. It removes the chat's messages and pictures and the chief's side of that conversation. Jobs started there are kept, and one that finishes later reports in Main.
- **Something new.** A dot marks a conversation the service has spoken in since it was last looked at, in the list and on the bar when it is another conversation than the one on screen. What has been looked at is kept in the browser only, so a phone and a laptop each keep their own, and the first sight of a conversation counts as looked at.
- **One more route that is not a GET**, `POST /app/api/chats`, taken from the site's own script like the rest. It names a chat only by an id the transcript keeps and can only rename or remove it. The invariant test's list of such routes grows by one and pins that.

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
- **A link only where there is something to read.** A job recorded as done whose whole output is the line saying the run was stopped (one that ran out of turns before 20 Nov 2026) wrote no report. Its message says "No report was written" and points at the job, its card says it did not do what was asked, and its page says why where the report would be. The SDK's own wording never reaches him. A job whose output is withheld or gone keeps the sentence as it was sent.
- **The report is first on the job's page**, directly under the figures. It was last, below the thread and a long trace, where a phone hid it. It starts short so the rest of the page stays within reach, with "Read it all" to open it.

## What a job usually costs, before it has a figure (`src/estimates.ts`)

A job has no cost until it has finished and the provider has priced it. Until then the app says what finished jobs of its kind have usually cost on its model, so Paul can see roughly what is coming and which model is cheaper for the same work. `docs/app/estimate.png` shows it with made-up figures.

- **Where it appears.** On a queued or running job's card ("Jobs like this usually cost about $0.61"), in its page's cost tile under "No figure yet", beside each model in the picker for running a job again ("glm-5.3 · usually $0.61"), and as a table on the Spend page, the dearest first.
- **What it is worked out from.** Only the provider's own figures (`realCost`) for jobs that ran to the end. The Agent SDK's estimate is never read. A failed, stopped or cancelled job is left out, and so is a figure the provider gave as a lower bound. A job's model is the one it was pinned to, or the one more than half of its charges were for (a worker's small helper calls go to a cheaper model and are part of what the job costs). Deep research is counted apart from ordinary research.
- **What the number is.** The median of the newest 30 such jobs (`ESTIMATE_RECENT`), with the range the middle half fell in, so one runaway job does not move it and old prices fall out.
- **When there is none.** With fewer than three such jobs of a kind on a model (`ESTIMATE_MIN_JOBS`), or when the job's model is not known, nothing is shown. Nothing is guessed.
- **What it is not.** It is not the job's cost and is never put where a cost goes: the card's own figure and the tile's number stay empty until the provider's figure arrives. It is always worded as what jobs like it usually cost. It feeds no cap and holds nothing up.

### What this changes in the rules

"Money is the provider's own figure or nothing" gains one stated exception, on Paul's ask for an estimate before a job starts (20 Nov 2026): this figure is not any one job's, it is worked out from provider figures only, and it is always labelled as an estimate. `test/estimates.test.ts` and `test/invariants.test.ts` hold it to that.

## The rail: spaces, and who is on shift (`spacesOf` and `rosterOf` in `src/app-data.ts`)

The first step towards project spaces and the agent roster, from Paul's mockup of 20 Nov 2026. `docs/app/rail.png` and `docs/app/rail-phone.png` show it with made-up jobs. On a screen wider than 900 pixels it is a column beside the chat; on a phone it is a drawer opened from the button at the top left. Beside the rail, the chat and the board fit together only on a screen wider than 1180 pixels; below that it is one or the other.

- **Spaces.** One per managed repository, made automatically, plus any other repository a card on the board belongs to. Each says how many of its jobs wait on Paul, or failing that how many are running or queued. The counts are the board's own cards, so the rail never disagrees with it.
- **Choosing a space narrows the board** to that repository's jobs and pull requests, in all three views and in the history (`/app/api/history?space=<alias>`). What waits on Paul's own decision (a send, a purchase, a DNS change, a sign-up) belongs to no repository and is never narrowed away. The choice is kept in the browser, and a space the board no longer lists is forgotten.
- **Each space has a chat of its own** (`web:space:<alias>`, 20 Nov 2026; `docs/app/space-chat.png`). Choosing a space shows its conversation with the chief in place of the main one, and "All spaces" goes back to the main conversation and Paul's own chats. It is a conversation in full: it keeps as much as the main one, has its own session with the chief, and jobs started in it report in it. Every message sent there reaches the chief with one line from the service saying which repository the chat is about, so Paul does not have to name it (`threadContext` in `src/orchestrator.ts`). A space's row carries a mark when the service has said something there that he has not looked at. Only a repository in the registry has a chat; a space that is only an old alias on a card narrows the board and leaves the chat alone. The things waiting on his decision are listed in the main conversation only, as with his own chats.
- **Spaces of Paul's own** (`src/spaces.ts`, 20 Nov 2026; `docs/app/new-space.png`). "New space" in the rail makes one: a name, and any of the managed repositories, or none. It has a chat of its own like a repository's space, and its board shows the jobs on its repositories plus any job started from its chat. Nothing is moved: a space is a way of looking at the same jobs, so a job on a repository still shows in that repository's space too, and "All spaces" counts each job once. In its chat the chief is told the name Paul gave it and which repositories he put in it, or that it is tied to none. "Change this space" renames it, changes its repositories or removes it; removing one empties its chat and forgets the chief's side of it, and keeps every job. At most 20 are kept, a name is one line of up to 48 characters, and two spaces cannot share a name.
- **On shift.** Marlo, then Fitz, Vera, Scout and Pip, then any other kind of worker that has a job running or queued. Each line is read off the board's cards: building or reviewing (with the pull request's number where there is one), gone quiet (no live worker on a running job), waiting on Paul, held by the cap or by a paused queue, next up, or idle. A change that was reviewed and left for Paul is shown as the maintainer's hand-off, not the engineer's wait. Each of them opens their own page.
- **The icon.** The ClearOps mark is the tab icon and the home-screen icon (`icon.svg`, `icon-32.png`, `icon-180.png` in `public/app`, served from the same fixed table as the stylesheet and script).

### What this changes in the rules

The rail is read-only and built from what the board already sent; the history route gains one optional filter, taken only in the shape of an alias. No new route, and nothing in the rail writes.

Spaces of Paul's own add one route that is not a GET, `POST /app/api/spaces`, taken from this site's own script only like the others (`test/invariants.test.ts` pins the list). It makes, changes or removes a space and nothing else: it can name only repositories already in the registry, it starts no job and touches none, it reaches no model, and it cannot name a repository's own space, the main conversation, a thread or one of his chats. A space's id is made by the service at random.

A space's chat adds one kind of address to the app's conversations (`space:<alias>` beside a job's thread, a pull request's thread and Paul's own chats), which `test/invariants.test.ts` pins. It is taken only for a repository in the registry, and it changes nothing about who may say what: a message there comes in by the same route, as the same sender on no allowlist, and is refused every typed approval word before any model, exactly as in the main conversation. The line the chief is given about the repository is the service's own and says so.

## Cleo: talking in the app (`src/web-voice.ts`)

Cleo is who Paul talks to, and Marlo is who does the work and writes in the feeds. The two are kept apart: what is said aloud is Cleo's own conversation (`docs/app/cleo.png`), and a feed holds what Marlo wrote (`docs/app/cleo-feed.png`).

The Cleo button in the chat's message box is the voice. Tap it and her conversation takes the chat's place, already listening; speak, tap again, and she answers aloud. "Marlo's feed" at the top goes back to the feed that was open.

- **Who she is.** The same Cleo as in a Discord voice channel (`src/voice.ts`): a quick model with one tool, which hands what Paul asked to the chief in his words. In the app she is told who Marlo is, what the feed that is open is called, and to say plainly when an answer is his.
- **What she can see: the board, as it stands when he speaks** (`src/cleo-brief.ts`). At the start of each turn she is shown what is running, queued, waiting for his approval, which pull requests are open, what finished lately, who is on shift and today's spend, made from the same board the app shows him (`appBoard`). So "is anything running?" or "what's waiting on me?" she answers herself, in one go, with no wait for Marlo and no extra call. It is titles, states, counts and spend: of a waiting item she sees the line that names it and nothing of its content or of what would approve it, and she cannot see inside a job or a report. It is read afresh each turn and remembered nowhere, because an answer about the board is out of date within the minute. At most `CLEO_BRIEF_MAX` characters; if the board cannot be read she is shown nothing and asks Marlo as before.
- **She speaks twice when she has to ask.** Small talk, quick general questions and what the board answers she answers herself, in one go. Anything else Marlo would know or do, she says she is asking him ("Okay, I'll ask Marlo"), and that comes back at once. When he has answered she speaks again ("I checked with Marlo, and he says ..."), and says the rest is in his feed. The page collects the second part with a read (`GET /app/api/voice/:id`) and plays it; her words are in her conversation either way. If he has not answered in `WEB_VOICE_ANSWER_WAIT_MS` (45 seconds) she says he is still on it and that his answer will be written in the feed.
- **Where Marlo's answer goes.** The feed that was open when Paul tapped: the main one, one of his own chats, or a space's chat. What she hands the chief arrives there as the app's own sender. The question is written there too, in Paul's words as transcribed and marked "Cleo asked for you", so the answer has its question above it and the chief reads the conversation back whole. Under what she reported back, her conversation has a button to that feed.
- **What is kept.** His words as transcribed and what she said, in her conversation (`GET /app/api/cleo`, `appCleo` in `src/app-search.ts`), as plain text, the newest `WEB_KEEP` of them. No feed shows them, counts them or is marked as having something new because of them, and search finds them under "Cleo". What was said while a chat or space was open goes with it when that chat or space is removed. The audio is not kept: his recording is held for the length of the request, her second answer for at most five minutes so the page can collect it, and neither is written anywhere.
- **What she cannot do.** Approve anything. A spoken request reaches the chief only under the voice prefix ("Voice request from Paul ..."), which no approval command can match, and she tells him an approval is his own tap on the item in the app. Nothing can be typed to her: typing goes to Marlo, in his feed.
- **Limits.** A turn is at most a minute (the page sends it on its own then) and 2 MB. One turn is in hand at a time, and that includes the wait for Marlo: until she has come back, another turn is refused with "Cleo is still waiting on Marlo". She remembers the talk so far, up to twenty turns, until he has been quiet for `VOICE_IDLE_MINUTES`.
- **When it is there.** Only when voice is switched on and can be transcribed (`voiceEnabled`), in a browser that can record. Then she is also on the roster as "Ready to talk", with a page of her own.
- **What it costs.** Each turn is one transcription and one call to her model and one text-to-speech call, with the board adding up to about 800 tokens to what her model reads; a turn she asks Marlo about is a second call to her model and a second text-to-speech call, and Marlo's own reply. All through OpenRouter, all counted in the day's spend like everything else.
- **What it is not, yet.** An open call. She speaks only in answer to a tap, so a job that finishes later is announced in the feed as text, not aloud. She does not open feeds or spaces for him. Hands-free with the phone locked is not something a web page can do reliably.

### What this changes in the rules

`POST /app/api/voice` is the ninth route under `/app` that is not a GET, and the eighth that takes the same-site check; `test/invariants.test.ts` pins the list, and a test of its own pins the rest: this site's own script only, switched on, a conversation that exists, and only then is anything listened to. Two callers may say a message is from the app: the chat route and Cleo's voice, and the test names both. The rule that nothing spoken can approve anything is held by the same code as Discord voice: the voice brain is the only thing that calls the chief, and it wraps the request first. The recording is measured before it is decoded, read only for a signed-in browser, and never written or logged.

What she is shown of the board gives her nothing to do (21 Nov 2026): she still has one tool, which hands a request to the chief, and a third test in `test/invariants.test.ts` pins that the brief uses only a waiting item's label, reads nothing but the board it is handed, and is left out without a word when it cannot be read.

Her conversation adds no way in (21 Nov 2026). It is not an address: nothing can be sent to it, the chief is never asked there, and no approval is read from it. The two routes that serve it (`GET /app/api/cleo`, `GET /app/api/voice/:id`) only read, and a second test in `test/invariants.test.ts` pins that, that no feed holds what was said aloud, and that her coming back is the same single reply of the same brain, so there is still one place the chief is asked from.

## A space's notes and library (`appSpace` in `src/app-data.ts`, `spaceNotes` in `src/spaces.ts`)

"Notes and library" in a space's chat bar and in the rail opens the space's own page (`#/space/<id>`, `docs/app/space-page.png`), for a repository's space or one of Paul's own.

- **His notes.** One box of plain text, up to 4,000 characters, which only he writes. They are kept in the store by the space's id and given to the chief with every message in that space's chat, marked as his background for the space and not as a request to act on. The chief cannot change them, and no other conversation is given them. Saving with nothing in the box clears them, and removing one of his own spaces removes its notes.
- **Reports.** The reports of the space's jobs, newest first: the same jobs its board shows, and only reports the app would show anyway (`reportFor`). The newest 50 are listed; older ones are found by searching.
- **Files he sent here.** The names of the files he sent in the space's chat, with when. Names only: a file he sends is kept for the workers to read and is not opened from the app, which is how the uploads rule stands.

### What this changes in the rules

`POST /app/api/spaces` gains a fourth action, `notes`, and it is the one thing that route can do to a repository's own space. It keeps text and nothing else, for a space that exists, tidied and redacted. `test/invariants.test.ts` pins that nothing else in the service writes a space's notes: no agent, no tool of the chief's, no channel listener. `GET /app/api/spaces/<id>` is read-only. The uploads rule is untouched: no route serves an upload.

## One agent's page (`appAgent` in `src/app-data.ts`)

Anyone on the roster opens a page of their own (`#/agent/<kind>`, `docs/app/agent.png`), read-only:

- **Who it is and what it is doing**: its name and role, what it does in one line, and the roster's own line for this minute, which opens the job it is about.
- **Its model**, and where that is decided: the Spend page for the workers, the engineers, the maintainer and the chief; the assistant is always on Claude and says so.
- **How far one job may run**: its turn limit and its money cap, or that none is set.
- **What it may use**, in plain words ("Search the web", "Run python3 only"), and how many commands are refused to it outright. Its prompt is not shown.
- **How it has been doing**, over the last 24 hours and the last 7 days. Finished is not the same as done, so the outcomes are counted apart (confirmed done, not confirmed, waiting on Paul, did not get there) and no single success rate is made of them. Beside them: why the ones that stopped did, typical and worst run time and queue wait, and what those jobs cost in all, which is the provider's own figures added up with the number of jobs they cover, or a line saying there is none.
- **What a job of its usually costs** on each model, where there is enough to say (the estimate described above).
- **Its newest ten jobs.**

The chief's page has no jobs of its own: it shows its model, what it may do, and what the provider charged today for its own replies.

`GET /app/api/agents/<kind>` is behind the same gate as everything else and writes nothing. Only "chief" or a kind of worker is an agent; any other name is answered with 404.

## Search (`src/app-search.ts`)

The magnifying glass in the header opens a page with one box (`docs/app/search.png`). It finds, by plain words:

- **Jobs**, by title, and by brief unless the job is a kind that works over Paul's mail, calendar, CV or zones, or over a document of his. Those are found by title alone, as their cards show them.
- **Reports**, only where `src/reports.ts` would serve them (`reportText`), so an assistant, CV or upload-derived output is never read. The newest 400 finished jobs are looked through, and a report's Markdown marks are left out of what is shown.
- **Chats**: what has been said in the app's own conversations (the main one, Paul's own chats, each space's chat, and the threads of jobs and pull requests), by a message's words, by what was heard in a voice note, or by the name of a file sent with it. A file's contents are not read. A message whose conversation is gone is not offered.

Every word typed has to be there, in any order and any case; two letters is the least it takes. No pattern is built from what he types. Each list shows the newest few (8 jobs, 8 reports, 12 messages) and says when there are more. A job opens its page, a report opens in full, and a message opens its conversation, at the newest message rather than the one found. What is being looked for is kept in the address (`#/search/<words>`), so a reload or the back button keeps it.

`GET /app/api/search?q=` is behind the same gate as everything else, read-only, and reaches no model. A result is drawn as text with the found words marked, never as markup.

On a phone's board, "Sign out" moved from the header into the rail's drawer to make room for the magnifying glass. On every other page it is where it was.

## Still to come

What it does not do yet: opening a file Paul sent from the app, notes the chief can add to, an open call with Cleo (she answers a tap, and does not speak unasked), push notifications, searching inside the files Paul has sent. Each is a later slice.

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

- **Money is the provider's own figure or nothing.** Today's spend goes through `spendDisplay`; when OpenRouter cannot be read the app says so and shows no number. A job's cost is `realCost` (`src/worker-stats.ts`), which never returns the Agent SDK's estimate. Until jobs record a provider figure, a job's cost reads "No real figure". The one figure that is not a job's own is what finished jobs of its kind usually cost on its model (`src/estimates.ts`): worked out from those provider figures alone, shown only as an estimate, and never where a cost goes.
- **A trace is served as `src/trace.ts` stored it**: clipped, redacted, and names and outcomes only for the kinds that work over Paul's mail, calendar, CV and zones.
- **A saved output is served only where the reports view would serve it** (`reportFor`), rendered by `src/reports.ts`, which escapes everything.
- **A model is shown only where it is known**: a pinned job's own, or a running or queued job's current role model. A finished, unpinned job says "Not recorded".
- **The agents' names** (Fitz, Vera, Scout, Pip) are placeholders in `public/app/app.js` until Paul names them.

## The page itself (`src/app-pages.ts`, `public/app/`)

One stylesheet and one script, no framework and no build step, plus three open-licensed fonts served from the npm packages. The policy allows script, styles, fonts and requests from this service only, no inline script or style, and no frames. The script draws with DOM nodes, never by assembling HTML; the one exception is the saved output the service already rendered. It asks for the board every five seconds while the tab is visible, and for the conversation every second and a half while something is happening in it.
