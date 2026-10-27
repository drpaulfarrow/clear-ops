# clear-ops

An agentic workforce for Clear Exchange that you run from WhatsApp.

You message a WhatsApp number. A chief-of-staff agent answers quick questions itself and delegates longer work to four workers: a researcher (web research, sourced briefs), a writer (specs, posts, emails in your voice), an engineer (code on a branch in your repository, never pushed) and an analyst (questions about previous outputs and data). Workers run in the background and message you when they finish. Anything that would push code or run a command in the repo waits for you to reply `YES <id>`. Recurring jobs run on a schedule you set in chat.

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
Create an empty private repo (for example `clear-exchange`) and note its clone URL. The engineer only works here. It must not be, or contain, anything from previous employer repositories.

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
fly ssh console -C "git clone <your-repo-url> /data/workspace"
```
Point the Meta callback URL at `https://clear-ops.fly.dev/webhook`. Any host that runs a Docker container with a persistent volume works the same way (Azure Container Apps, Railway, a VPS).

## Configuration
See `.env.example`. The important ones:

| Variable | Meaning |
|---|---|
| `ALLOWED_NUMBERS` | Only these numbers get a reply. E.164 digits, no plus. |
| `WHATSAPP_APP_SECRET` | Enables webhook signature checks. Set it in production. |
| `REPO_DIR` | The clean repository the engineer works in. |
| `CHIEF_MODEL`, `WORKER_MODEL`, `ENGINEER_MODEL` | Model aliases: `fable`, `opus`, `sonnet`, `haiku`. |
| `JOB_BUDGET_USD` | Spend cap per job and per chat turn. |

## Safety model
- Headless permission mode: tools not pre-approved are denied, never left waiting.
- The engineer cannot push, delete recursively or reach the network. Pushing is an approved action.
- Only two side effects exist (`push_branch`, `run_command`) and both need `YES <id>`.
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
