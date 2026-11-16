# The bank page: a read-only account connector

A private page showing the balances of, and a date-bounded transaction list for, the HSBC UK personal
accounts Paul chooses, read through an account information provider (Enable Banking's AIS API) when he
presses a button. It is **read-only by construction**: there is no payment, transfer or change
operation anywhere in it, and nothing is ever fetched on a schedule.

**It is off unless `BANK_ENABLED` and the three bank secrets are set, and it has never been run
against a real bank.** Everything below has been built and tested with synthetic replies only. No
Enable Banking application has been registered, no bank has been authorised and no real account data
has been read.

- `src/bank.ts`: the settings, the sealed connection record and the plain words the connector uses
  about itself. Every route under `/bank` is named here.
- `src/bank-api.ts`: the provider client. The operation allowlist, the one address, the RS256
  application JWT, the reply parsing and every failure sentence.
- `src/bank-gate.ts`: the connect gate. The connect action, the bank flow, the callback, the reads,
  the disconnect and the CSRF token the page's forms carry.
- `src/bank-router.ts`: the HTTP skin over the gate. The owner's session, the page's headers, and the
  one route that arrives without a session.
- `src/bank-page.ts`: the pages, drawn in the house style (`src/page-style.ts`), escaping everything
  the provider said.
- `scripts/bank-preview.ts` (`npm run bank-preview`): the synthetic preview that produced
  `docs/bank-page/`. A fake provider, a fake bank page and a real browser; no network.
- `test/bank-store.test.ts`, `test/bank-api.test.ts`, `test/bank-connect.test.ts`,
  `test/bank-page.test.ts`: the offline tests (a fake provider and a real app on a loopback port).
  `test/invariants.test.ts` carries the bank block that holds the shape of all of this.

## How it works

1. **The page.** `/bank` is behind the owner's password, the same sign-in as the reports and the jobs
   board (`src/sign-in.ts`), and it is in the same gate middleware: a bookmark without a session is
   sent to the sign-in page and then on to where he was going. The bank's own redirect back
   (`/bank/callback`) is the one route under `/bank` that arrives without a session, because the
   session cookie is `SameSite=Strict` and a cross-site redirect cannot carry it.
2. **Connect.** Pressing Connect mints a connect action: 24 random bytes, bound to the SHA-256
   fingerprint of the owner's own session cookie, valid ten minutes and usable once. The confirm page
   shows the bank, the consent length and the exact registered redirect URL; pressing Go to HSBC asks
   the provider for its bank list, picks the HSBC UK **personal** entry from that reply (never by name
   guess: the provider's own `psu_type` is preferred, a business entry is excluded, and an ambiguous
   list is refused rather than guessed), starts the authorisation and parks a flow in memory with 32
   random bytes of state, bound to the same session.
3. **The bank.** The waiting page offers the bank's own address as a link, which the owner follows. It
   is a link and not a redirect on purpose: every page here is served with `form-action 'self'`, and a
   browser applies that policy to the redirects of a form submission too, so a 303 to the bank would be
   blocked outright, and the bank's own domain cannot be named in the policy in advance because which
   bank the provider hands back is its answer. This service never sees a banking password or a one-time
   code.
4. **Back.** The bank's redirect to `/bank/callback` can only park the provider's one-time code against
   the state this service minted. It exchanges nothing, writes nothing and decides nothing, its query
   string is never logged, echoed, linked or kept beyond the code itself, and a second arrival for the
   same state is refused without touching the first code.
5. **Finish.** Only the owner's own signed-in POST, carrying that session's CSRF token, in the tab that
   started the flow, exchanges the code for a session. The code is taken (single use, before the call)
   and exchanged; a session with no accounts in it is not a connection: it is deleted again at the
   provider and the owner is told plainly. A restart in the middle invalidates the flow, which is the
   safe direction: nothing can be finished that this process did not start.
6. **Choose.** Nothing is readable until he ticks accounts. Every submitted value must be the keyed
   handle of an account the provider's session showed just now, and at least one is required: a
   connection whose selection is empty reads nothing, and the page says so rather than calling it
   success.
7. **Read.** Balances, and a transaction list over a checked London-date window, for one chosen account
   at a time. Every read resolves the handle against the stored selection first and the provider's
   session second, so an account that was never chosen is refused even though the session can see it.
   Transactions page to the end, or stop at the safety bound (`BANK_PAGES_MAX` pages, `BANK_ROWS_MAX`
   rows) and say they stopped there. Nothing read is stored anywhere.
8. **Disconnect.** Local reads are blocked first (written down before the provider is called, so a
   process that stops half way leaves a connection that cannot be read, not one that still can), then
   the documented session delete is called, then the local record is destroyed. The three things are
   reported as three separate lines: local reads off, the provider's own record deleted or not, and the
   bank's own consent, which this service cannot revoke and never claims to have revoked.

## What is kept, and under what

Between visits the connector keeps the least that keeps a connection alive: the provider's session id,
the chosen accounts as HMAC-SHA-256 handles with a masked label (the last four characters of an
identifier, never a full IBAN), the consent's scope, its expiry and the last-read time. **No balance
and no transaction is ever stored**, and no provider credential is stored at all: the signing key is
read from the environment, used to mint a short-lived JWT per request, and never written anywhere.

The record is sealed with AES-256-GCM under `BANK_CONNECTION_KEY`, a service secret kept outside the
repository, with `clear-ops-bank-connection-v1` as additional authenticated data, a fresh 12-byte nonce
each time, and the file at `DATA_DIR/bank/connection.enc`, owner-only (0700/0600). There is deliberately
**no plaintext fallback and no key derived from another secret**: the key comes from that one variable
and nothing else. A key under 16 characters, a changed key, an altered or truncated ciphertext, or a
missing file all become one of four states the page says out loud (off, never connected, unreadable, or
the connection), and the connector reads and writes nothing in the unreadable case. The Google token
store (`src/google.ts`) was read as a precedent and is deliberately not copied: it falls back to
another secret, which is exactly what is not done here.

## Configuration

| Variable | Meaning |
|---|---|
| `BANK_ENABLED` | `true` or `1` turns the connector on. **Unset means every route under `/bank` says it is switched off and calls nothing.** |
| `BANK_APPLICATION_ID` | The provider application's id, used as the JWT's `kid`. |
| `BANK_JWT_PRIVATE_KEY` | The RSA private key, PEM (newlines may be written as `\n`). Checked to be a real RSA key of at least 2048 bits. Never logged, rendered or handed to a worker. |
| `BANK_CONNECTION_KEY` | The key the connection record is sealed under, at least 16 characters, e.g. `openssl rand -base64 32`. |
| `BANK_REDIRECT_URL` | The exact address registered with the provider, https (default `PUBLIC_URL/bank/callback`). It must carry no query or fragment: the provider adds the code itself. |
| `BANK_API_BASE_URL` | The provider's own API, https. Only `api.enablebanking.com` is accepted; anything else leaves the connector off rather than calling somewhere else. |
| `BANK_COUNTRY` | Which country's banks the discovery call asks for. Default `GB`. |
| `BANK_WINDOW_DAYS` / `BANK_WINDOW_DAYS_MAX` | The window the transaction form offers (30) and the widest a read may cover (366). |
| `BANK_PAGES_MAX` / `BANK_ROWS_MAX` | The paging safety bound: 10 pages and 1,000 rows. Past either, the read stops and says it stopped there. |
| `BANK_JWT_ISSUER` / `BANK_JWT_AUDIENCE` / `BANK_JWT_TTL_SECONDS` | The JWT's issuer (`enablebanking.com`), audience (`api.enablebanking.com`) and life (300 seconds, at most an hour). |

All three secrets are stripped from every worker's environment: `LLM_STRIPPED` and `DIRECT_STRIPPED` in
`src/llm.ts`, `WORKER_STRIPPED` in `src/github-auth.ts` (which covers every `gh` and `git` subprocess a
worker runs), the worker environment in `src/agents.ts`, the installer's whitelist in `src/setup.ts` and
git's own environment in `src/bootstrap.ts`.

Every subprocess this service starts is covered too, and the test reads the call sites out of the source
rather than trusting a list: each `exec`, `execFile` and `spawn` in `src` must pass an environment of its
own. Almost all are built from nothing of the service's (git's `gitEnv`, the installer's whitelist, the
browser's own). The only two that must keep the service's environment, because they need a credential
that lives in it, are the founder's own approved shell command (`src/jobs.ts` `run_command`, which
deploys with `FLY_API_TOKEN`) and the `gh` call that watches the product's deploy (`src/design.ts`), and
both take the bank secrets out first with `withoutBankSecrets` (`src/bank.ts`), so no subprocess of this
service can read a bank key whatever it was started for.

`test/invariants.test.ts` asserts all of that over every worker kind and every subprocess entry point,
and that no bank module is reachable from a model, a worker or the job store.

## The operation allowlist

Eight operations exist, and nothing else can be reached through the client:

| Operation | Request |
|---|---|
| `list-aspsps` | `GET /aspsps?country=&psu_type=` |
| `start-authorisation` | `POST /auth` |
| `create-session` | `POST /sessions` |
| `read-session` | `GET /sessions/{session}` |
| `delete-session` | `DELETE /sessions/{session}` (disconnect, and nothing else) |
| `account-details` | `GET /accounts/{account}/details` |
| `account-balances` | `GET /accounts/{account}/balances` |
| `account-transactions` | `GET /accounts/{account}/transactions?date_from=&date_to=&continuation_key=` |

`routeOf` is the only thing that turns a method and a path into a request, the query keys are checked
against the operation's own list, an identifier that is not `^[A-Za-z0-9._~:-]{1,128}$` is refused, and
every call re-checks that the address is the provider's own host over https before it leaves (a
redirect is an error, never something to follow). Anything payment-shaped is refused **before** the
allowlist is consulted, by a pattern that covers payment, transfer, funds confirmation, beneficiary,
standing order, direct debit, mandate, SEPA, instant, FX, top-up, refund and charge. There is no such
route to reach, and a future edit that added one would have to delete that check to make it reachable.

## What is never done, whatever anyone says

- **No payment operation exists.** Not "disabled by a flag": there is no payment, transfer, standing
  order, beneficiary, funds-confirmation or PISP call in the client, and no route to one.
- **No model sees any bank data.** Bank data reaches the owner's page and nothing else: not the job
  store, not a brief, not a prompt, not a tool result, not a transcript, not an upload, not a job
  output, not the outputs mirror, not chat, and not the voice bridge's routes.
- **No generic worker tool can read it.** There is no bank tool in any worker's toolset, and the bank
  modules are imported by `src/index.ts` alone.
- **Nothing runs on a schedule.** No cron entry, no background timer: every read is a button.
- **No balance and no transaction is written to disk**, in the store, a log or anywhere else.
- **The banking-site refusals are untouched.** `src/site-policy.ts` is unchanged by this work: the
  browser still may not act on a banking site, and this connector does not go through the browser.
- **No secret reaches a browser, a log or a report.** The signing key is never rendered, every
  outgoing line is scrubbed (`scrub`), no reply body is copied into a sentence whole, and the
  application id, the key's own first bytes and the code are scrubbed from anything that could be
  printed.

## Pages

Every answer under `/bank` is `no-store`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, `Cross-Origin-Opener-Policy: same-origin` and carries
`default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none';
base-uri 'none'; img-src 'none'; object-src 'none'`: one inline stylesheet, no script, no font, no
image, nothing fetched, and a form may post only to this service. No account handle, session id or
state is ever put in a URL (the handles travel in form bodies, and the callback's own query string is
the bank's, read once and never echoed). Every word that came from the provider is escaped by
`src/page-style.ts` before it is drawn. Every changing action is a POST carrying the session's CSRF
token; there is no state-changing GET, and the one GET without a session changes nothing.

## Disconnect

Three separate facts, never merged into one claim:

- **Local reads off.** Recorded before the provider is called, so it holds even if the rest fails, and
  every later read refuses the connection.
- **The provider's record.** The documented session delete is called; the page says whether it was
  deleted or could not be reached (in which case the session id is kept for one reason only, so the
  delete can be tried again, and local reads stay off).
- **The bank's own consent.** This service cannot revoke it and never says it has. The page names the
  consent's expiry and tells him to revoke ClearOps' access in the HSBC UK app or online banking.

## What has been tested, and what has not

Tested, with synthetic data only (`test/bank-api.test.ts`, `test/bank-connect.test.ts`,
`test/bank-page.test.ts`, `test/bank-store.test.ts`, and the bank block of `test/invariants.test.ts`):

- the allowlist refusing every payment-shaped path, method and query key, and every call going only to
  the provider's own host over https;
- the connect action, the flow and the CSRF token bound to the owner's own session: an unauthenticated
  request, another session's cookie, and a board or bridge token alone are all refused;
- the callback with a missing, wrong, expired, replayed or another session's state: each fails closed,
  no code is exchanged, and the query string is never echoed or logged;
- the sealed record: a missing or short key, a changed key, a tampered ciphertext and a missing file
  each stop the connector rather than reading or writing;
- an unselected account, and one the provider's session cannot see, refused even though the session can
  see it; an empty selection reading nothing and an account list of nothing being deleted at the
  provider rather than called a connection;
- provider failures, rate limits, pagination, a truncated read and expired or revoked consent each
  producing a truthful state on the page;
- every bank secret stripped from every worker kind and every subprocess entry point, and no bank module
  reachable from a model, a worker or the job store;
- the rendered page, escaped, on a desktop and a phone viewport (`docs/bank-page/`, made by
  `npm run bank-preview` against a fake provider and a fake bank page).

**Not tested, and not verified by anyone yet:**

- **Any real Enable Banking call.** No application has been registered, no key has been issued and no
  request has left for the provider. The paths, field names, the RS256 JWT, the `psu_type` values and
  the reply shapes come from the provider's public documentation and general knowledge of the AIS
  standard, written without a live application. The first real run may well find a field this parser
  does not read; it is written to say plainly when a reply is not in a shape it understands rather than
  guessing, but the shapes themselves are unverified.
- **A real bank authorisation, and the real redirect.** The callback has been exercised with synthetic
  query strings on a loopback address. Whether HSBC's own page and the provider's redirect behave
  exactly as documented is unverified.
- **A real consent's expiry or revocation.** The page's wording and states are built from the
  documented shapes, not from a real revoked consent.
- **The real delete on disconnect.** The call is the documented one; that the provider's record really
  goes, and what it reports, is unverified.
- **Real account data of any kind.** None has been read, and none should be until Paul decides to
  register an application and connect deliberately.
