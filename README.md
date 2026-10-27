# clear-ops

An agentic workforce for Clear Exchange that you run from WhatsApp.

You message a WhatsApp number. A chief-of-staff agent answers quick questions itself and delegates longer work to five workers: a researcher (web research, sourced briefs), a writer (specs, posts, emails in your voice), a senior engineer (implements on a branch with tests and opens a pull request), a maintainer (the one agent that reviews and merges, which runs automatically after every engineer job) and an analyst (questions about previous outputs and data). Every agent can read both repositories. Workers run in the background and message you when they finish. You direct; they deliver. The one thing that still waits for a `YES <id>` is a command run outside the engineer's normal remit, such as a deploy. Recurring jobs run on a schedule you set in chat.

Everything runs on the Claude Agent SDK. Conversation memory persists per phone number; jobs, approvals, schedules and standing notes persist in a JSON store on a volume.

## What you can say

```
What's the latest on SPUR? Keep it short.
Research TollBit's buyer-side moves this month and tell me if they're building an exchange.
Draft a two-line email to the Prebid board proposing the seller module. Formal.
Engineer: scaffold a Fastify service in the repo with a /health route and tests.
Every Monday at 7am, research what changed in SPUR, CoMP, TollBit and Cloudflare.
Remember: always price examples at half a cent per retrieval.
show job 93137e
/jobs   /pending   /reset   /help
YES 1f3a9c
```

## Set up in five steps

### 1. Anthropic key
Create an API key at the Claude Console and keep it for step 4.

### 2. WhatsApp number (Meta Cloud API)
1. At Meta for Developers, create an app of type Business and add the WhatsApp product.
2. Under WhatsApp > API Setup you get a test number and a temporary token. That is enough to try it. For production, add your own number and create a permanent token: Business Settings > System Users > add a system user with the `whatsapp_business_messaging` permission > generate token.
3. Note the Phone number ID (not the phone number) and the token.
4. Add your personal number as a recipient (test numbers can only message listed recipients).

### 3. A clean repository for the engineer
Create an empty private repo (for example `clear-exchange`) and a fine-grained GitHub token with contents and pull requests read and write on that repo and on this one. Put it in `GH_TOKEN` (the `gh` CLI reads it) and clone with it in the URL so git can push:
```bash
git clone https://x-access-token:<GITHUB_TOKEN>@github.com/<you>/clear-exchange workspace
git -C workspace config user.name "Clear Exchange engineer"
git -C workspace config user.email "engineer@clear.exchange"
```
The engineer only works here. It must not be, or contain, anything from previous employer repositories. Protect `main` in the repo settings: require a pull request and the CI check before merging. That makes the maintainer's role a rule GitHub enforces, not only a prompt. Add a workflow that runs the tests on pull requests so the maintainer has a green check to look for.

### 4. Run it
Locally first:
```bash
cp .env.example .env            # fill in the values
npm install
npm run simulate                 # chat in the terminal, no WhatsApp needed
```
Then with WhatsApp, which needs a public URL for the webhook:
```bash
npm run dev                      # listens on :8080
ngrok http 8080                  # in another terminal; copy the https URL
```
In Meta > WhatsApp > Configuration, set the callback URL to `https://<ngrok-host>/webhook`, the verify token to your `WHATSAPP_VERIFY_TOKEN`, click Verify and Save, then subscribe to the `messages` field. Send "hello" from your phone.

### 5. Deploy (Fly.io, London)
```bash
fly launch --no-deploy --copy-config
fly volumes create clear_ops_data --region lhr --size 3
fly secrets set ANTHROPIC_API_KEY=... WHATSAPP_TOKEN=... WHATSAPP_PHONE_NUMBER_ID=... \
  WHATSAPP_VERIFY_TOKEN=... WHATSAPP_APP_SECRET=... ALLOWED_NUMBERS=447...
fly deploy
fly ssh console -C "git clone https://x-access-token:<GITHUB_TOKEN>@github.com/<you>/clear-exchange /data/workspace"
fly ssh console -C "git clone https://x-access-token:<GITHUB_TOKEN>@github.com/<you>/clear-ops /data/self"
```
Point the Meta callback URL at `https://clear-ops.fly.dev/webhook`. Any host that runs a Docker container with a persistent volume works the same way (Azure Container Apps, Railway, a VPS).

## Self-improvement
The engineer can work on this workforce as well as on the product. Say "improve yourself: add a tool that reads my Google Calendar" or "give the researcher a stricter sourcing rule" and the chief starts an engineer job with target `self`. It works in `SELF_REPO_DIR`, a checkout of this repository, under the same process as any other task: branch, tests, pull request, then the maintainer reviews and merges. Nothing restarts itself. The GitHub Actions workflow in `.github/workflows/deploy.yml` runs the tests on the merge and deploys to Fly with a rolling strategy, so the old version keeps answering until the new one passes its health check. A few minutes after the engineer reports, the new workforce is live, and your conversation continues from the stored session.

Setup for this: clone this repository into `SELF_REPO_DIR` with a token that can push (same pattern as step 3), and add `FLY_API_TOKEN` as a repository secret so the workflow can deploy. The invariants in `CLAUDE.md` and `test/invariants.test.ts` are what stop a self-improvement from removing the allowlist, the signature check, the clean-room rule or the spend caps.

## Configuration
See `.env.example`. The important ones:

| Variable | Meaning |
|---|---|
| `ALLOWED_NUMBERS` | Only these numbers get a reply. E.164 digits, no plus. |
| `WHATSAPP_APP_SECRET` | Enables webhook signature checks. Set it in production. |
| `REPO_DIR` | The clean product repository the engineer works in. |
| `SELF_REPO_DIR` | A checkout of this repository, for self-improvement jobs. |
| `CHIEF_MODEL`, `WORKER_MODEL`, `ENGINEER_MODEL` | Model aliases: `fable`, `opus`, `sonnet`, `haiku`. |
| `JOB_BUDGET_USD` | Spend cap per research, write or analyse job and per chat turn. |
| `ENGINEER_BUDGET_USD` | Spend cap per engineering job. |

## Safety model
- Headless permission mode: tools not pre-approved are denied, never left waiting.
- Engineers work like senior engineers: branch, tests, pull request. They cannot merge, push the default branch, force-push, rewrite shared history, delete recursively or disable failing tests.
- One maintainer agent reviews and merges. It runs tests, checks CI, reads the diff, and either merges or requests changes. It cannot edit code. Branch protection on `main` is the hard backstop, since both agents use the same GitHub token.
- One side effect exists outside that remit (`run_command`, for deploys and migrations) and it needs `YES <id>`.
- The chief never sends email or messages anyone but you. Drafts come to you.
- Spend is capped per job; subagent nesting is limited.
- A broken session is dropped automatically so the conversation never jams; `/reset` does it by hand.

## Development
```bash
npm run build     # typecheck and compile
npm test          # offline test suite with a fake agent runner
```

## Extending
- A new worker: add a case to `workerSpec()` in `src/agents.ts` and the kind to `JobKind`.
- A new side effect: add an executor to `actionExecutors` in `src/jobs.ts`. It will automatically require approval.
- Email, calendar or GitHub tools: add an MCP server to the chief's `mcpServers` in `src/orchestrator.ts`, and gate any sending behind `propose_action`.
