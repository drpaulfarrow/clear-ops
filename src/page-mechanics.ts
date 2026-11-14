/**
 * The ordinary mechanics of a page a browsing worker meets on the way to what it was asked to do: a
 * two-step verification screen ("choose where to receive the code"), a cookie or consent wall, a region
 * chooser, an offer that covers the page. A competent human operator works these without asking anyone;
 * a worker that stops on one and hands it back to Paul is the clumsiness he named on 14 November 2026
 * ("behave as much like Instinct as possible: operate the site the way a person would").
 *
 * This module decides only WHAT to press, from the page's own numbered controls and its own visible
 * text. Nothing here presses anything and nothing here talks to Paul: src/browse.ts reads a decision and
 * presses it, only on the login's own site, never a consequential control (nothing that pays, sends
 * content, posts or deletes), and at most a handful of times. The page's text is untrusted content and
 * never reaches a model through this module.
 *
 * The one thing a page must never do is make the workforce ask Paul to work the page. Where a
 * verification screen offers a choice of where to send the code, the route that actually reaches him is
 * chosen here (text first, then WhatsApp, then a call; the authenticator app only when the vault holds
 * that site's two-factor setup key, because that is the only way we can generate the code ourselves).
 * The only message that ever mentions a code is the service's own, asking him for the code itself
 * (src/otp.ts); it never names a route and never asks him to choose one.
 */

/** A numbered control on the page, as src/browse.ts read it. */
export interface PageControl {
  /** The number the worker's own tools use for this control in the last page reading. */
  ref: number;
  tag: string;
  /** The control's own words: its text, its value or its label. Untrusted. */
  words: string;
  /** A radio or checkbox that is already chosen. */
  checked?: boolean;
}

/** The one next thing to press, and why, for the service's own log line. */
export interface PageAction {
  ref: number;
  words: string;
  why: string;
}

/**
 * Words that mean the page is asking for a code, or asking where to send one. A page merely *naming*
 * two-step verification is not one of these ("two-step verification is on for your account" is a
 * settings page), so the wording has to be an ask: enter a code, choose a route, we sent you one.
 */
const VERIFY_WORDS = /verification code|two[- ]step (verification )?code|two[- ]factor( authentication)? code|verify (it'?s|it is) you|verify your (identity|sign[- ]?in)|one[- ]time (code|password)|authentication code|security code|passcode|enter (the|your) code|choose where to (receive|get|send)|where (to|would you like to) (receive|get|send)|send (a |the )?code to|resend the code|sent you a code|code (was|has been) sent/i;

/** True when the page's own text is asking to verify a sign-in. */
export function asksForVerification(text: string): boolean {
  return VERIFY_WORDS.test(text);
}

/**
 * Words that are never pressed on a verification screen, whatever the page says: paying, sending
 * content to anyone, posting, deleting, changing an account. A code is a sign-in and nothing else, so a
 * control that would do one of these is left alone and the sign-in stops instead (src/otp.ts).
 */
const NEVER_PRESS = /\b(pay|payment|buy|purchase|order|checkout|check out|subscribe|upgrade|donate|transfer|withdraw|delete|remove|close|deactivate|unsubscribe|post|publish|tweet|comment|reply|share|apply|contract|e-?sign|message|email|contact|invite|forward|phone number|change (my )?(password|number))\b/i;

const AUTH_ROUTE = /\b(authenticator|authentication app|code generator|totp|google authenticator)\b/i;
const TEXT_ROUTE = /\b(text|sms|text message|text me|mobile|by phone)\b/i;
const WHATSAPP_ROUTE = /\bwhatsapp\b/i;
const CALL_ROUTE = /\b(call|voice call|call me|phone call|automated call)\b/i;

/**
 * How well a control reaches Paul, for choosing where a code is sent: 4 the authenticator app (only
 * when the vault holds that site's two-factor setup key, so we can generate the code ourselves), 3 a
 * text, 2 WhatsApp, 1 a call. 0 when the control is not a delivery route at all.
 *
 * Text first because it arrives at once on the phone he carries; WhatsApp next because it is the same
 * phone through an app; a call last because the code is read out and cannot be read again. A route we
 * cannot use (an authenticator we hold no key for) is not a route.
 */
export function routeRank(words: string, totpHeld = false): number {
  if (!words) return 0;
  if (AUTH_ROUTE.test(words)) return totpHeld ? 4 : 0;
  if (TEXT_ROUTE.test(words)) return 3;
  if (WHATSAPP_ROUTE.test(words)) return 2;
  if (CALL_ROUTE.test(words)) return 1;
  return 0;
}

/** The site's own "I did not get it" path: the link a person presses when no code has arrived. */
const RESEND = /\b(didn'?t (receive|get)|did not (receive|get)|not (receiv|get)ing|no code|resend|send (a )?new code|send (it )?again|having trouble|trouble (receiv|get)|other (ways|options)|try another way|more options|choose another (way|method))\b/i;

/** The control that actually sends the code. */
const SEND_CODE = /\b(send (me )?(a |the )?(new )?(otp|code|one[- ]time code|text|sms)|send otp|send code|text me|get (a |the )?code|request (a )?(new )?code|resend (the )?(code|otp))\b/i;

const words = (w: string) => String(w ?? "").replace(/\s+/g, " ").trim().toLowerCase();

export interface VerificationOptions {
  /** The vault holds this site's two-factor setup key, so the authenticator route can be used. */
  totp?: boolean;
  /** Controls already pressed in this run, so nothing is pressed twice. */
  done?: Iterable<string>;
}

/**
 * The one next thing to press on a verification screen, or undefined when there is nothing left to
 * press safely. Order, which is the order a person works such a page in: the site's own "didn't receive
 * a code" or resend path first, then the route that reaches Paul (or the authenticator, when we hold the
 * key), then the control that sends the code. Each is pressed at most once, so a screen that has to be
 * walked through ("Didn't receive a code?" then the route, then "Send OTP") is walked through rather
 * than pressed in a circle, and a route is never changed once one is chosen.
 */
export function verificationStep(items: PageControl[], text: string, opts: VerificationOptions = {}): PageAction | undefined {
  const done = new Set([...opts.done ?? []].map(words));
  const routes = items.filter((i) => routeRank(i.words, opts.totp === true) > 0);
  // A page with routes on it is a verification screen even when its own wording is unusual; a page with
  // neither the wording nor a route is not one, so nothing here is pressed on an ordinary page.
  if (!asksForVerification(text) && !routes.length) return undefined;
  const usable = items.filter((i) => i.words && !done.has(words(i.words)) && !NEVER_PRESS.test(i.words));
  const resend = usable.find((i) => RESEND.test(i.words));
  if (resend) return { ref: resend.ref, words: resend.words, why: "ask the site for the code again" };
  // One route is chosen and then left alone: a chosen radio, or a route already pressed in this run.
  const chosen = routes.some((i) => i.checked) || routes.some((i) => done.has(words(i.words)));
  const route = chosen
    ? undefined
    : usable
        .filter((i) => routeRank(i.words, opts.totp === true) > 0 && !i.checked)
        .sort((a, b) => routeRank(b.words, opts.totp === true) - routeRank(a.words, opts.totp === true))[0];
  if (route) return { ref: route.ref, words: route.words, why: "choose where the code is sent" };
  // A control that names a route ("Text me on my number ending in 802") is pressed as the route and not
  // again as a send button, so nothing on the screen is pressed twice in a row.
  const send = usable.find((i) => SEND_CODE.test(i.words) && routeRank(i.words, opts.totp === true) === 0);
  if (send) return { ref: send.ref, words: send.words, why: "send the code" };
  return undefined;
}

/* ---------- the interruptions a page puts in front of a visitor ---------- */

/** The page is talking about cookies or consent. */
const COOKIE_PAGE = /\bcookies?\b|consent|privacy choices|tracking/i;
const COOKIE_ACCEPT = /\b(accept|allow|agree|got it|ok|okay|continue)\b/i;
/** A control that leads deeper into settings, or refuses, rather than clearing the wall. */
const COOKIE_DEEPER = /\b(reject|decline|deny|refuse|manage|settings|preferences|necessary|essential|customi[sz]e|learn more|more options|opt out|withdraw)\b/i;
/** A bare accept button, taken only on a page that is actually talking about cookies. */
const BARE_ACCEPT = /^(accept|accept all|accept all cookies|accept cookies|allow all|allow cookies|allow all cookies|i accept|i agree|agree|got it|ok|okay|continue|continue to (the )?site|close)$/i;

/** Paul is in the UK and the machine runs in London; a region chooser is answered for him. */
const REGION_PAGE = /\b(region|country|locale|shipping to|deliver to|delivering to|where are you|your location)\b/i;
const REGION_UK = /\b(united kingdom|great britain|england|scotland|wales|northern ireland|uk|gb)\b/i;

/**
 * An offer or newsletter modal, dismissed the way a person dismisses one. Exact words only, so nothing
 * else on the page is caught, and a bare "Close" is left to the worker's own click.
 */
const DISMISS = /^(no thanks|no, thanks|no thankyou|not now|maybe later|skip|skip this|dismiss|✕|×|no, continue|continue without|no thanks, continue)$/i;

/**
 * The one next thing to press to get an interruption out of the way, or undefined when there is
 * nothing that plainly is one. Deliberately narrow: a plain accept on a cookie wall, the control that
 * names Paul's own region, or a plain "no thanks" / "not now" / "close" on a modal. Anything else on
 * the page, and anything consequential, is left alone.
 */
export function interruptionStep(items: PageControl[], text: string, done: Iterable<string> = []): PageAction | undefined {
  const pressed = new Set([...done].map(words));
  const usable = items.filter((i) => i.words && i.words.length <= 60 && !pressed.has(words(i.words)) && !NEVER_PRESS.test(i.words) && !COOKIE_DEEPER.test(i.words));
  if (COOKIE_PAGE.test(text)) {
    const accept = usable.find((i) => (BARE_ACCEPT.test(i.words.trim()) || (/\bcookie|consent|privacy/i.test(i.words) && COOKIE_ACCEPT.test(i.words))) && COOKIE_ACCEPT.test(i.words));
    if (accept) return { ref: accept.ref, words: accept.words, why: "clear the cookie notice" };
  }
  if (REGION_PAGE.test(text)) {
    const region = usable.find((i) => REGION_UK.test(i.words));
    if (region) return { ref: region.ref, words: region.words, why: "answer the region chooser" };
  }
  const dismiss = usable.find((i) => DISMISS.test(i.words.trim()));
  if (dismiss) return { ref: dismiss.ref, words: dismiss.words, why: "dismiss the interruption" };
  return undefined;
}

/** The paragraph a browsing job carries about the ordinary mechanics of a site. */
export const PAGE_MECHANICS_NOTE = `Site mechanics: work the ordinary steps of a site yourself, the way a person would, before you write anything to Paul. The service already clears a cookie or consent wall, a region chooser, an offer that covers the page and a two-step verification screen for you (sign_in drives the verification screen: it presses the site's own "didn't receive a code" path, chooses where the code is sent so it reaches Paul, and presses the button that sends it). Everything else you do with click and type: accept or dismiss what is in the way, use the site's own search, follow its own sign-in and checkout steps. Only stop for something only Paul can do (a password or login you do not have, a captcha, an identity check, a payment) and never for something you could have done yourself.`;
