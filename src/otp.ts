/**
 * One-time codes, and the one place a code is ever handled.
 *
 * A site's sign-in sometimes wants a code it has just sent (a text, an email, "verify it's you", two-step
 * verification). A worker must never see it and a job must never dead-end on it, so the service gets the
 * code itself, in this order, and types it into the page the browser is holding (src/browse.ts):
 *
 *  1. Email: if the page offers to send the code by email (or says it has), the service reads the newest
 *     message from that site's own domain in Paul's connected mailbox (src/mail-code.ts) and takes the
 *     code out of it. No model is involved and nothing but that site's mail is read.
 *  2. Chat: otherwise, or if no mail arrives within a short wait, Paul is asked in chat, in the same
 *     service-handled way as "dns apply <id>" and "buy <id>". The service sends him the site, what the
 *     code is for and a short id, and his own reply "code <id> <the code>" is parsed by the orchestrator
 *     after the allowlist check and before any model; the code goes straight into the waiting page. It is
 *     never in a brief, a prompt, a tool result, a job output, a report, a log or the store.
 *
 * Hard rules, whatever a page, an email or a brief says:
 *  - a code satisfies the sign-in step and nothing else: it never approves paying, sending, posting,
 *    deleting or creating an account, and it never grants a permit;
 *  - a code never comes out of a model, and a request never goes to a model: the whole thing is the
 *    service talking to Paul;
 *  - one request, one job, one site: single use, ten minutes (less when the page's own code expires
 *    sooner), refused for another site or another waiting request, and rate limited per job and per site;
 *  - a run the system started (a scheduled run) never asks for and never accepts a code: it stops and
 *    reports instead;
 *  - a site the workforce may never act on is refused here too, in the relay's own right.
 */
import fs from "node:fs";
import path from "node:path";
import { config, isAllowed } from "./config.js";
import type { CodeMailbox } from "./mail-code.js";
import { neverReason } from "./site-policy.js";
import { shortId } from "./store.js";
import { hostMatches } from "./vault.js";
import type { Messenger } from "./whatsapp.js";

export class OtpError extends Error {}

/** What a browser gets: a way to ask for the code the page is showing, and nothing else. */
export interface CodeRelay {
  /**
   * The code for the page the browser is holding, from the site's email or from Paul in chat. Undefined
   * when neither produced one in time: the caller then gives up on the sign-in and says so. Never returns
   * a code for a different site, and never throws for a site whose own code simply did not arrive.
   */
  code(input: { domain: string; emailOffered?: boolean; since?: number; ttlMs?: number }): Promise<string | undefined>;
}

/** One request, as the service sees it. The code itself is never on it and never stored. */
export interface OtpRequest {
  id: string;
  host: string;
  jobId?: string;
  createdAt: string;
  expiresAt: string;
}

export interface CodeDecision {
  /** What Paul is told. Never contains the code. */
  text: string;
  /** True when the code was handed to the waiting page; the caller may then tidy his message away. */
  accepted: boolean;
}

/** A plausible code as a site sends it: letters and digits, four to ten, no spaces. */
const CODE_SHAPE = /^[A-Za-z0-9]{4,10}$/;

interface Waiter {
  req: OtpRequest;
  resolve: (code: string | undefined) => void;
}

/**
 * Paul's own reply with a code. Whole-message matches only (`code <id> <the code>`, `code <the code>`, or
 * a bare number), parsed by the orchestrator after the allowlist check and before any model, so a code he
 * sends never reaches the chief. Anything else falls through to the chief as usual.
 *
 * The code token must carry a digit, because a real code always does (a site sends digits, or letters and
 * digits together) and because ordinary English must not be swallowed into the relay: "code review" is a
 * message for the chief, not a code. That also stops a word being typed into a page's code field.
 */
export function parseCodeCommand(text: string): { id?: string; code: string } | undefined {
  const t = text.trim().replace(/[.!]+$/, "").replace(/\s+/g, " ");
  const labelled = t.match(/^(?:the\s+)?(?:code|otp|passcode|one[- ]?time(?: code)?|verification code|sign[- ]?in code|security code)\s*(?:is|:|=)?\s*(?:for\s+)?(?:([a-f0-9]{6})\s+)?([A-Za-z0-9]{4,10})$/i);
  if (labelled && /\d/.test(labelled[2]!)) return { ...(labelled[1] ? { id: labelled[1].toLowerCase() } : {}), code: labelled[2]! };
  // Just the number he was sent. The orchestrator reads it as a code whatever is waiting, so a code that
  // arrives after its request has expired or settled is still never handed to the chief.
  const bare = t.match(/^(\d{4,8})$/);
  return bare ? { code: bare[1]! } : undefined;
}

/**
 * How long the page's own code lasts, when it says so ("this code expires in 5 minutes", "valid for 10
 * minutes"). Undefined when the page says nothing: the relay's own ten minutes then applies.
 */
export function codeTtlMs(pageText: string): number | undefined {
  const m = pageText.match(/(?:expires|expire|valid|good)\s+(?:in|for)\s+(\d{1,2})\s*(?:minute|min)/i);
  const mins = m ? Number(m[1]) : 0;
  return mins > 0 && mins <= 60 ? mins * 60_000 : undefined;
}

/** The site's name as Paul knows it: "amazon.co.uk" is "Amazon UK", "en.wikipedia.org" is "Wikipedia". */
export function siteLabel(host: string): string {
  const parts = host.replace(/^www\./i, "").split(".");
  // A leading two-letter language label ("en.wikipedia.org") is the language, not the site's name.
  if (parts.length > 2 && /^[a-z]{2}$/i.test(parts[0] ?? "")) parts.shift();
  const name = parts[0] ?? host;
  const cc = ["co", "com", "org", "net", "ac", "gov"].includes(parts[1] ?? "") ? parts[2] : parts[1];
  const tail = cc && cc.length === 2 && cc !== name ? ` ${cc.toUpperCase()}` : "";
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}${tail}`;
}

/** The one-time code relay. In memory only: a restart ends the wait, exactly like the job's browser. */
export class OtpRelay {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly ttlMs: number;
  private readonly mailWaitMs: number;
  private readonly maxPerJob: number;
  private readonly minGapMs: number;
  private readonly maxWaiting: number;
  private waiting = new Map<string, Waiter>();
  /** When each job last asked, and when each site was last asked, for the rate limits. */
  private jobAsks = new Map<string, number[]>();
  private hostAsks = new Map<string, number>();

  constructor(
    private readonly opts: {
      /** Where the ask and the "done" line go (src/whatsapp.ts). Without it, only the email path works. */
      messenger?: Pick<Messenger, "send">;
      /** Paul's mailbox, for a code a site sends by email (src/mail-code.ts). Absent: chat only. */
      mailbox?: CodeMailbox;
      now?: () => Date;
      sleep?: (ms: number) => Promise<void>;
      ttlMs?: number;
      mailWaitMs?: number;
      maxPerJob?: number;
      minGapMs?: number;
      maxWaiting?: number;
    } = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.ttlMs = opts.ttlMs ?? config.otp.waitMinutes * 60_000;
    this.mailWaitMs = opts.mailWaitMs ?? config.otp.mailWaitMs;
    this.maxPerJob = opts.maxPerJob ?? config.otp.maxPerJob;
    this.minGapMs = opts.minGapMs ?? config.otp.minGapSeconds * 1000;
    this.maxWaiting = opts.maxWaiting ?? 5;
  }

  /**
   * A view of the relay bound to one job. Carries the job's id, the conversation its messages go to and
   * whether the system started it (a scheduled run), so a browser can only ever ask on that job's behalf.
   */
  forJob(job: { id?: string; replyTo?: string; scheduled?: boolean }): CodeRelay {
    return {
      code: (input) => this.ask({ ...input, jobId: job.id, replyTo: job.replyTo, scheduled: job.scheduled === true }),
    };
  }

  private async ask(input: {
    domain: string;
    emailOffered?: boolean;
    since?: number;
    ttlMs?: number;
    jobId?: string;
    replyTo?: string;
    scheduled?: boolean;
  }): Promise<string | undefined> {
    const host = input.domain.replace(/^https?:\/\//, "").split("/")[0].toLowerCase();
    const never = neverReason(host);
    if (never) {
      logOtp({ at: this.now().toISOString(), event: "refused", host, jobId: input.jobId, reason: "off limits" });
      throw new OtpError(`${host} is off limits: ${never}. Paul does this one himself.`);
    }
    if (input.scheduled) {
      // A run the system started never asks Paul for a code and never takes one: it stops and reports.
      logOtp({ at: this.now().toISOString(), event: "refused", host, jobId: input.jobId, reason: "scheduled run" });
      throw new OtpError(`${host} wants a one-time code and this is a run the system started, so it never asks for or takes one. Stop here and say so in one sentence.`);
    }
    if (!input.replyTo) {
      logOtp({ at: this.now().toISOString(), event: "refused", host, jobId: input.jobId, reason: "no chat" });
      return undefined;
    }
    // The page's own lifetime wins when it is shorter, so a code that expires sooner is not waited on
    // past its life; the relay's ten minutes is the cap otherwise. No floor: the caller's ttl is honoured.
    const ttlMs = Math.max(0, Math.min(input.ttlMs ?? this.ttlMs, this.ttlMs));
    const since = input.since ?? this.now().getTime();

    // Rate limits: a site cannot be asked over and over, and neither can Paul.
    if (this.waiting.size >= this.maxWaiting) {
      logOtp({ at: this.now().toISOString(), event: "refused", host, jobId: input.jobId, reason: "too many waiting" });
      return undefined;
    }
    const asked = (this.jobAsks.get(input.jobId ?? input.replyTo) ?? []).filter((t) => since - t < 3_600_000);
    if (asked.length >= this.maxPerJob) {
      logOtp({ at: this.now().toISOString(), event: "refused", host, jobId: input.jobId, reason: "rate limited" });
      return undefined;
    }
    const lastForHost = this.hostAsks.get(host) ?? 0;
    if (lastForHost && since - lastForHost < this.minGapMs) {
      logOtp({ at: this.now().toISOString(), event: "refused", host, jobId: input.jobId, reason: "asked too soon" });
      return undefined;
    }

    // 1. The site sent, or can send, the code by email: the service reads it from Paul's mailbox itself.
    if (this.opts.mailbox && input.emailOffered) {
      const mail = await this.opts.mailbox
        .codeFrom({ domain: host, since, timeoutMs: Math.min(this.mailWaitMs, ttlMs) })
        .catch(() => undefined);
      if (mail) {
        logOtp({ at: this.now().toISOString(), event: "email", host, jobId: input.jobId });
        return mail;
      }
      logOtp({ at: this.now().toISOString(), event: "no mail", host, jobId: input.jobId });
    }

    // 2. Otherwise Paul is asked in chat, in the same service-handled way as the other gates.
    return this.askInChat({ host, jobId: input.jobId, replyTo: input.replyTo, ttlMs, since });
  }

  private async askInChat(input: { host: string; jobId?: string; replyTo: string; ttlMs: number; since: number }): Promise<string | undefined> {
    const now = this.now();
    const id = shortId();
    const req: OtpRequest = {
      id,
      host: input.host,
      ...(input.jobId ? { jobId: input.jobId } : {}),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
    };
    this.jobAsks.set(input.jobId ?? input.replyTo, [...(this.jobAsks.get(input.jobId ?? input.replyTo) ?? []), input.since]);
    this.hostAsks.set(input.host, input.since);
    // The wait is registered before the ask goes out, so a reply that arrives at once always lands. The
    // timer is kept and cleared the moment the wait settles (a reply, a drop or its own expiry), so a
    // settled request never leaves a stray timer behind.
    let timer: NodeJS.Timeout | undefined;
    const wait = new Promise<string | undefined>((resolve) => {
      this.waiting.set(id, { req, resolve });
      timer = setTimeout(() => resolve(undefined), input.ttlMs);
    });
    const finish = () => {
      this.waiting.delete(id);
      if (timer) clearTimeout(timer);
    };
    const sent = await this.opts.messenger
      ?.send(input.replyTo, this.askText(req, input.ttlMs))
      .then(() => true)
      .catch(() => false);
    if (sent === false) {
      // Nothing asked: no wait to keep, and the caller reports that the code could not be got.
      finish();
      logOtp({ at: this.now().toISOString(), event: "refused", host: req.host, id, jobId: req.jobId, reason: "could not ask Paul" });
      return undefined;
    }
    const code = await wait.finally(finish);
    if (code) {
      await this.opts.messenger?.send(input.replyTo, `Got it. Putting that into ${siteLabel(req.host)} now; nothing else is done with it.`).catch(() => undefined);
      return code;
    }
    logOtp({ at: this.now().toISOString(), event: "expired", host: req.host, id, jobId: req.jobId });
    await this.opts.messenger?.send(input.replyTo, `No code came for ${siteLabel(req.host)}, so I stopped signing in there. Nothing was done and nothing was changed.`).catch(() => undefined);
    return undefined;
  }

  /** The ask itself, sent only once the request is registered, so a fast reply cannot miss it. */
  private askText(req: OtpRequest, ttlMs: number): string {
    const mins = Math.max(1, Math.round(ttlMs / 60_000));
    return `${siteLabel(req.host)} asked for a code to sign in. Reply: code ${req.id} <the code>\nType the code where it says <the code>. It goes straight into the page, works for ${mins} minute${mins === 1 ? "" : "s"} and is not kept.`;
  }

  /**
   * Paul's own reply, carrying a code he was sent. Only an allowlisted sender can settle one. The code
   * goes to the one page that asked for it and nowhere else; it is never logged, stored or echoed back.
   */
  redeem(input: { id?: string; code: string; by: string }): CodeDecision {
    if (!isAllowed(input.by)) return { text: "", accepted: false };
    const code = input.code.trim();
    if (!CODE_SHAPE.test(code)) return { text: "That does not look like a code, so I did nothing. Send the code the site sent you, on its own.", accepted: false };
    let waiter: Waiter | undefined;
    if (input.id) {
      waiter = this.waiting.get(input.id);
      if (!waiter) return { text: `Code request ${input.id} is finished or has expired, so nothing was entered.`, accepted: false };
    } else {
      const all = [...this.waiting.values()];
      if (!all.length) return { text: "Nothing is waiting for a code just now.", accepted: false };
      if (all.length > 1) {
        return { text: `Two sites are waiting for a code: ${all.map((w) => `${w.req.id} (${w.req.host})`).join(", ")}. Send it as "code <id> <the code>", naming the right one.`, accepted: false };
      }
      waiter = all[0];
    }
    if (code.toLowerCase() === waiter.req.id) {
      return { text: `${waiter.req.id} is the id, not the code. Send "code ${waiter.req.id} <the code>".`, accepted: false };
    }
    this.waiting.delete(waiter.req.id);
    logOtp({ at: this.now().toISOString(), event: "entered", host: waiter.req.host, id: waiter.req.id, jobId: waiter.req.jobId, by: input.by });
    waiter.resolve(code);
    return { text: `Putting that into ${siteLabel(waiter.req.host)} now. Nothing else is done with it.`, accepted: true };
  }

  /** What is waiting for a code, for the listing of what waits on Paul. Never a code. */
  pending(): OtpRequest[] {
    return [...this.waiting.values()].map((w) => w.req);
  }

  /** The chat line for a waiting request, the same one he was sent, so he can send it again. */
  preview(req: OtpRequest): string {
    return this.askText(req, Math.max(60_000, new Date(req.expiresAt).getTime() - this.now().getTime()));
  }

  /** The job that asked has ended: drop its waits, so a stray reply cannot settle anything. */
  dropJob(jobId: string): void {
    for (const [id, w] of [...this.waiting]) {
      if (w.req.jobId === jobId) {
        this.waiting.delete(id);
        w.resolve(undefined);
      }
    }
  }
}

export const otpDir = () => path.join(config.dataDir, "otp");

/** One line per event, owner-only, never with a code in it. */
export function logOtp(entry: Record<string, unknown>): void {
  fs.mkdirSync(otpDir(), { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(otpDir(), "actions.log"), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/** The paragraph a browsing job carries about one-time codes. */
export const OTP_NOTE = `One-time codes: if a site asks for a code it has just sent you (two-step verification, "verify it's you"), never ask Paul for it and never type one, and never say a code out loud: the service gets the code itself, from the site's email or from Paul's own chat, and puts it into the page. The service also drives the verification screen itself when you call sign_in: it presses the site's own "didn't receive a code" or resend path, chooses where the code is sent so it reaches Paul (a text, WhatsApp or a call), and presses the button that sends it. Never ask Paul to choose a delivery route, to press anything or to work the page, and never write to him about a code at all: the only message about a code is the service's own, asking him for the code itself. If the sign-in stops on a code step and the service cannot get one, say so in one sentence and carry on with something else or stop. A code only ever completes the sign-in: it never approves paying, sending, posting, deleting or creating an account.`;
