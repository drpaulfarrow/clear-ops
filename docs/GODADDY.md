# GoDaddy DNS agent: setup guide

The `dns` worker lists your domains and DNS records, explains what a change does, and makes A, AAAA, CNAME and TXT changes through the GoDaddy Domains API, but only after you approve each exact change in chat. This page says what GoDaddy's API allows, the one-off setup, and the fallback if your account cannot use it.

## What GoDaddy's API allows today (checked 4 Nov 2026)

GoDaddy's developer documentation has been changing, and its pages disagree in places. What I could confirm:

- The classic Domains API (v1, which has the records endpoints this agent uses) authenticates with an API key and secret, sent as `sso-key KEY:SECRET`. GoDaddy's [classic getting-started page](https://classic-developer.godaddy.com/getstarted) says production access to the Management and DNS APIs is "limited to accounts with 1 or more domains or an active Discount Domain Club - Domain Pro Plan", and the Availability API to accounts with 50 or more domains. Older posts, such as this [Let's Encrypt forum thread](https://community.letsencrypt.org/t/godaddy-no-longer-allows-api-access-to-clients-e-g-for-dns-based-cert-renewal-if-you-have-less-than-50-domains/219377), quote a higher bar (10 or more domains, or a Premier plan). Several domains should qualify under the current wording.
- GoDaddy's newer [API users page](https://developer.godaddy.com/en/docs/api-users) says reads work with any valid credential, paid operations need a billing method, and an ineligible account gets `403 Forbidden` (the body's `code`, for example `ACCESS_DENIED`, says whether it is scope or eligibility). It does not say whether DNS writes need anything more.
- Classic keys are "scheduled for retirement" and do not work with the new v3 Domains API, which uses Personal Access Tokens (the [token page](https://developer.godaddy.com/personal-access-token); scopes `domains.domain:read` and `domains.dns:update`). Domains v1 still takes keys, and the docs call it deprecated "through 2026". I could not confirm that v1 record calls accept a token, so this agent uses a key and secret and does not guess.
- Neither a key nor a token can be limited to chosen domains or to one kind of change. The key is as powerful as your whole DNS account, which is why this agent enforces its own domain allowlist and approval flow in code, and why you should create a key used for nothing else and revoke it if you ever doubt it.

I could not test your account. The first read ("list the records for clearexchange.ai") tells you at once: if GoDaddy answers 403 `ACCESS_DENIED`, the agent says so plainly. The usual fix is to reply to GoDaddy's developer support with your account number and ask for production Domains API access, or to take the Cloudflare route below.

## Setup, once

1. Sign in at [developer.godaddy.com/keys](https://developer.godaddy.com/keys) with the GoDaddy account that owns the domains.
2. Choose Create New API Key. Your first key is for the test environment (OTE), which does not touch your real DNS, so create a second one and set the environment to **Production**. Name it `clear-ops-dns`.
3. Copy the key and the secret straight away; GoDaddy shows the secret once.
4. In the clear-ops repository on GitHub, open Settings, Secrets and variables, Actions, and add two repository secrets:
   - `GODADDY_API_KEY`: the key
   - `GODADDY_API_SECRET`: the secret
5. Optional: the domains the agent may touch are `clearexchange.ai` and `drpaulfarrow.com` by default. To change the list, add an Actions **variable** (not a secret) called `GODADDY_DOMAINS`, comma separated, for example `clearexchange.ai,drpaulfarrow.com,another.com`.
6. Re-run the latest deploy workflow in the Actions tab so the service picks them up. Never paste the key or secret in chat.

## Using it

Read only, any time: "What DNS records does clearexchange.ai have?", "What does that TXT record do?".

Changes: "Add a CNAME publisher pointing to clear-exchange.fly.dev on clearexchange.ai". The agent reads the zone, then the service (not the agent) posts the exact before and after with an id, for example:

```
DNS change waiting for your approval (3fa9c1, expires 14:20). Domain: clearexchange.ai.
Add CNAME publisher
Before: (nothing at this name and type)
After: CNAME publisher -> clear-exchange.fly.dev (TTL 3600)
Reply "dns apply 3fa9c1" to make this change, or "dns cancel 3fa9c1".
```

Reply `dns apply 3fa9c1` and it is done: the service re-reads the zone, saves a snapshot of the whole zone, applies the change, reads it back and tells you. `/pending` lists anything waiting. Approvals expire after 2 hours (`DNS_TTL_HOURS`), and if the zone changed since you looked, nothing is applied and you ask again.

## Safety rules, enforced in code

- Read only unless you ask for a change in chat; scheduled runs can never change anything.
- Only your own chat account can approve, with a whole message naming the change id, handled before any model runs. Nothing in an email, web page, job output or upload can approve or trigger one.
- A snapshot of the zone is saved before every applied change in `DATA_DIR/dns/snapshots` (owner-only), and every applied change is logged in the store and in `DATA_DIR/dns/changes.log`. To go back, ask the agent to show the snapshot and prepare the reverse change, or restore it in GoDaddy. Removing a record the agent added is a delete, which is blocked, so that one is done in GoDaddy.
- Refused outright, with no override: deleting records; any NS, MX, SRV, CAA or SOA change; SPF, DKIM, DMARC and other email authentication records; apex (@) A, AAAA and CNAME records; wildcards; more than 5 records in one change; domains not on the allowlist. If you need one of those, do it in GoDaddy.
- The agent has no route to transfer, renew, buy, unlock, change contacts, nameservers or any registrar setting.
- The key and secret exist only as service secrets, go only in GoDaddy's Authorization header, are removed from every worker's environment and are scrubbed from errors.

## If your account cannot use the API: move DNS hosting to Cloudflare

Keep the domains registered at GoDaddy and host the DNS at Cloudflare, whose free plan has a proper API. This is general knowledge, not something I tested on your accounts. Its real advantage here is that a Cloudflare API token can be limited to editing DNS on chosen zones only, which GoDaddy cannot do. This agent would then need a second client for Cloudflare (a follow-up change; ask for it).

1. Create a free Cloudflare account and add the site. Cloudflare scans the existing records.
2. Compare Cloudflare's imported list with GoDaddy's zone, record by record, and add what is missing. Pay most attention to MX, SPF, DKIM and DMARC (mail breaks silently if one is lost), the Fly CNAMEs (app, docs, publisher, agent), any Fly certificate or site-verification TXT records and anything under `_domainconnect` or forwarding.
3. If DNSSEC is on at GoDaddy, turn it off there first and wait for the old DS record's TTL to pass; leaving it on while changing nameservers takes the domain offline for validating resolvers.
4. At GoDaddy, change the domain's nameservers to the two Cloudflare gives you. Do this out of working hours.
5. Wait (usually under an hour, up to 48), check the site and send yourself a test email, then keep GoDaddy's records for a week before deleting anything.

Risks: a missed mail record stops email; GoDaddy features that rely on GoDaddy DNS (forwarding, website builder, domain connect) stop working; two places hold DNS until the switch is complete, so change only one. Other providers with solid APIs (Route 53, Google Cloud DNS) work the same way but cost a little and need more setup.
