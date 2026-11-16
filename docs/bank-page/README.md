# The bank page, as it looks

Every image here was made by `npm run bank-preview` (`scripts/bank-preview.ts`): a real app built by
`buildApp`, a real browser (Playwright over the image's own Chromium), a **fake provider** and a
**fake bank page**, synthetic accounts and transactions, on a loopback address. No request leaves the
machine and no real bank, credential or account is involved. The script walks the real forms: Connect,
Go to HSBC, the bank's own page, back, Finish connecting, tick an account, save, Show balances, Show
transactions, Disconnect.

Each state is captured twice: `-phone.png` at 390x900 (2x scale) and `-desktop.png` at 1280x1000.

| Image | What it shows |
|---|---|
| `01-switched-off` | `BANK_ENABLED` unset: the page says so and calls nothing. |
| `02-not-connected` | On, nothing connected: what Connect does, and that nothing is read or stored until he comes back and chooses. |
| `03-confirm` | The confirm step: the bank, the consent length, the exact registered redirect URL, and that the action lasts ten minutes and works once. |
| `04-go-to-your-bank` | The waiting page: the bank's own address offered as a link (never a redirect), with what to do if it never comes back. |
| `05-back-from-the-bank` | The bank's own redirect back: the code is held in memory, useable once, and this page is not signed in. |
| `06-finish-connecting` | The signed-in tab, with the authorisation waiting to be exchanged. |
| `07-connected-nothing-chosen` | Connected but nothing ticked: nothing is readable, and a connection is not permission to read an account. |
| `08-one-account-chosen` | One account saved as readable, with the dates the transaction form starts from. |
| `09-balances` | One account's balances, read at that moment, with the provider's own type words and the consent's end date. |
| `10-transactions` | A date-bounded transaction list, with what was read, the currency and the total. |
| `11-read-stopped-at-the-bound` | A read that hit the paging safety bound: the page says there is more in that range and to narrow the dates. |
| `12-provider-failure` | The provider failing: one plain sentence, and nothing read or changed. |
| `13-disconnected` | Disconnect: local reads off, the provider's record deleted (or not), and the bank's own consent reported as the bank's, with what to do about it. |
| `14-record-unreadable` | The stored record cannot be read (its key changed, or the file was altered): nothing is read or written until a fresh connection is made. |

The numbers are the order the script captures them in, and running `npm run bank-preview` writes exactly these
files and no others.
