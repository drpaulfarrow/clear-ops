/**
 * The synthetic-only boundary every bank test file calls before anything else in this process.
 *
 * The bank connector's tests are synthetic-only by commission: no real credential, no real consent,
 * no real account data and no call that leaves for the provider, whatever the host happens to have in
 * its environment. That must not depend on anyone remembering it, so it is enforced twice here:
 *
 *  - **No real bank variable reaches a test process.** Every `BANK_` variable is deleted from
 *    `process.env` before the source modules are imported, so a stray `bankSettings()` (which reads
 *    the process environment by default) sees a clean environment even on a host that has real keys
 *    set, and tests build settings from synthetic literals only.
 *  - **The provider's own address is unreachable from a test process.** The global `fetch` is wrapped:
 *    a call that would leave for any host in `BANK_API_HOSTS` (the only hosts the client may call)
 *    fails loudly instead of going, so a test that accidentally constructs a real client — real keys
 *    included — still cannot make a real provider read. Everything else (a loopback test server, for
 *    instance) passes through untouched.
 *
 * This is a test-process boundary, not a service one: the service itself is off by default
 * (`BANK_ENABLED` unset) and its client re-checks its own settings on every call.
 */

/** Runs before the source modules are imported: call this at the top of every bank test file. */
export function bankTestBoundary(): void {
  for (const k of Object.keys(process.env)) if (k.startsWith("BANK_")) delete process.env[k];
  const real = globalThis.fetch;
  if ((real as unknown as { __bankTestBoundary?: boolean }).__bankTestBoundary) return;
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let host = "";
    try {
      host = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).host;
    } catch {
      // A malformed address never reaches the provider either; let the real fetch answer it.
    }
    if (host) {
      const { BANK_API_HOSTS } = await import("../src/bank.js");
      if (BANK_API_HOSTS.includes(host)) {
        throw new Error(`A bank test called the real provider at ${host}: bank tests are synthetic-only, and no call may leave for the provider whatever credentials exist.`);
      }
    }
    return real(input, init);
  }) as typeof fetch;
  (wrapped as unknown as { __bankTestBoundary: boolean }).__bankTestBoundary = true;
  globalThis.fetch = wrapped;
}
