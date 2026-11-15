# Commission: read-only bank account connector (synthetic data only, inert)

Build an owner-only, read-only account information connector for HSBC UK personal accounts through the Enable Banking AIS API, and a private owner page to show it. Everything in this task is developed and tested with synthetic data only. Production banking stays disabled.

## Scope
- Open one pull request against this repository. Do not merge it, do not deploy, do not touch other pull requests.
- Do not register an Enable Banking application, create or use any real credential, run any real bank authorisation, retrieve any real bank data, add a payment feature, or change the existing banking-site browser refusals (src/site-policy.ts).
- Version one: show balances for chosen accounts and an on-demand, date-bounded transaction list. No model calls on bank data, no scheduled fetching, no categorisation, no advice, no new agent, no persistence of transactions.

## Design requirements
1. Owner-only page behind an owner-bound, short-lived connect action. A board link or the Instinct bridge token alone is not proof of the owner.
2. Server-side HTTPS only to the documented Enable Banking API, with an allowlist of operations: ASPSP discovery, start authorisation, exchange code for session, read session, selected-account details, balances and date-bounded transactions, delete session. No payment operation exists or is reachable. Pick the HSBC UK personal entry from the discovery response, not by name guess.
3. Application JWT signing (RS256) with short-lived tokens; private keys never reach the browser, models, workers, logs, the repository or reports.
4. Callback checks: high-entropy state, owner and session binding, exact registered redirect URL, one-time code exchange, short expiry, replay rejection, fail closed with no code exchange on mismatch. Never log callback query strings. A restart may invalidate a pending flow.
5. Persist only what is needed to keep the selected connection: provider session id, selected account identifiers or hashes, masked labels, consent scope and expiry. Encrypt it with authenticated encryption under a dedicated key stored outside the repository. No plaintext fallback; a missing or invalid key stops the connector. Existing Google token code is a precedent to review, not proof of safety.
6. Add every bank secret and key name to all worker environment stripping lists (see LLM_STRIPPED and DIRECT_STRIPPED in src/agents.ts), with a test over every worker kind and subprocess entry point.
7. No generic worker tool can read bank data. Bank data never enters the job store, model conversation, uploads, report renderer, output mirror, Discord, or the Instinct bridge routes.
8. Only explicitly selected accounts are readable; a valid provider session must not imply access to all accounts. An empty account list is not success.
9. Pages: no third-party scripts, fonts or images; no-store caching; restrictive content security policy; no referrer leakage; no framing; no account or session ids in URLs. Escape all provider and transaction text. CSRF protection on connect and disconnect, and no state-changing GET.
10. Transaction paging runs to completion within a bounded window; truncation by a safety bound is shown. Show fetch time, range, currency and failures accurately.
11. Disconnect blocks local reads immediately, calls the documented session delete, and destroys local credentials. Report vendor deletion and bank-consent revocation separately; never claim bank consent is revoked from local state alone.

## Tests and evidence required in the pull request
- Provider allowlist rejects payment paths. Unauthenticated, wrong-owner and link-only requests are rejected.
- Callback missing, wrong, expired, replayed and cross-owner states fail closed.
- No bank secret in any worker or subprocess environment, snapshot, log, report or error message.
- Invalid key, tampered ciphertext and missing secret stop the connector.
- Unselected or foreign account ids are rejected even if the session can see them.
- Provider errors, rate limits, pagination, expired or revoked consent produce truthful private states.
- Rendered desktop and mobile screenshots of the owner page with synthetic data.
- State in the pull request description exactly what was and was not tested, and what remains unverified.

## Stopping
If a requirement cannot be met safely, stop and report it in the pull request description rather than weakening it. Stop at the run's budget target and report what was finished.
