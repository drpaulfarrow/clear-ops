// ClearOps web app (docs/APP.md). Slice 1: the board in three views, the whole history, and one job with
// its trace and what it cost. Slice 2: chat with the chief, with the jobs it starts shown as live cards.
// Everything it asks for is a GET except two things: the message Paul sends, and the sign-out form.
// No framework and no build step. The page is drawn with DOM nodes, never by assembling HTML, so
// nothing a job says can become markup. The one exception is text the service has already rendered
// and escaped (src/reports.ts): a saved report, and what the service says in chat. `rendered` is the
// only place that sets HTML, and the page's policy keeps it script-free.

const API = "/app/api";
const SIGN_IN = "/app/sign-in";
const BOARD_EVERY_MS = 5000;
const JOB_LIVE_EVERY_MS = 4000;
const JOB_IDLE_EVERY_MS = 30000;
const DONE_SHOWN = 12;
const DONE_SHOWN_BESIDE = 5;
const CHAT_BUSY_EVERY_MS = 1500;
const CHAT_QUIET_EVERY_MS = 5000;
const TEXT_MAX = 4000;
const FILES_MAX = 5;
const FILES_BYTES = 18 * 1024 * 1024;

const root = document.getElementById("app");

/* ---------- Small helpers ---------- */

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === undefined || kid === null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
  check: ["m5 12 5 5 9-10"],
  cross: ["M6 6l12 12M18 6 6 18"],
  pause: ["M9 5v14M15 5v14"],
  back: ["M19 12H5M11 6l-6 6 6 6"],
  out: ["M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l4-4-4-4M14 12H4"],
  link: ["M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"],
  send: ["M5 12h14M13 6l6 6-6 6"],
  clip: ["M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.4 3.4 0 0 1 4.8 4.8L10 17a1.8 1.8 0 0 1-2.6-2.6l7.2-7.2"],
  mic: ["M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z", "M5 11a7 7 0 0 0 14 0M12 18v3"],
  stop: ["M7 7h10v10H7z"],
  wave: ["M4 10v4M8 6v12M12 9v6M16 4v16M20 10v4"],
  plus: ["M12 5v14M5 12h14"],
  doc: ["M7 3h7l5 5v13H7z", "M14 3v5h5", "M10 13h6M10 17h6"],
  down: ["m6 9 6 6 6-6"],
  menu: ["M4 7h16M4 12h16M4 17h16"],
  search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "m20 20-3.6-3.6"],
};
function icon(name, size = 16, label) {
  const svg = document.createElementNS(SVG_NS, "svg");
  const set = (k, v) => svg.setAttribute(k, v);
  set("width", size); set("height", size); set("viewBox", "0 0 24 24"); set("fill", "none");
  set("stroke", "currentColor"); set("stroke-width", "2.2"); set("stroke-linecap", "round"); set("stroke-linejoin", "round");
  if (label) { set("role", "img"); set("aria-label", label); } else set("aria-hidden", "true");
  for (const d of ICONS[name]) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

const LONDON = "Europe/London";
const clockFmt = new Intl.DateTimeFormat("en-GB", { timeZone: LONDON, hour: "2-digit", minute: "2-digit", hour12: false });
const dayKeyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: LONDON, year: "numeric", month: "2-digit", day: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("en-GB", { timeZone: LONDON, weekday: "long", day: "numeric", month: "long" });
const clock = (iso) => (iso ? clockFmt.format(new Date(iso)) : "");
const dayKey = (iso) => dayKeyFmt.format(new Date(iso));

function span(ms) {
  const mins = Math.floor(Math.max(0, ms) / 60000);
  if (mins < 1) return "under a minute";
  if (mins < 90) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return mins % 60 ? `${hours} h ${mins % 60} min` : `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}
const ago = (iso, now) => (iso ? `${span(now - Date.parse(iso))} ago` : undefined);

function money(usd) {
  if (usd >= 0.1 || usd === 0) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(usd >= 0.01 ? 3 : 4)}`;
}

const modelName = (id) => (id ? id.split("/").pop() : undefined);

/** The agents' names. Placeholders until Paul names them; a kind without one goes by its role. */
const NAMES = { engineer: "Fitz", maintain: "Vera", research: "Scout", design: "Pip" };
const CHIEF = "Marlo";
const KNOWN_KINDS = new Set(["engineer", "maintain", "research", "design", "write", "analyse", "create_agent", "ea", "ideate", "cv", "dns", "advisor", "prebid", "voice"]);
/** The voice of ClearOps: who speaks when the Cleo button is used. */
const CLEO = "Cleo";
const who = (job) => (NAMES[job.kind] ? `${NAMES[job.kind]} · ${job.kindName}` : job.kindName.charAt(0).toUpperCase() + job.kindName.slice(1));
const avatar = (kind, size = "") => h("span", { class: `av ${KNOWN_KINDS.has(kind) ? `av-${kind}` : "av-chief"} ${size}`, "aria-hidden": "true" }, h("i"), h("i"));

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable; the view simply is not remembered.
  }
  return undefined;
}

/** Text the service has already rendered and escaped (src/reports.ts). The only place HTML is set. */
function rendered(html, cls) {
  const el = h("div", { class: cls });
  el.innerHTML = html;
  for (const a of el.querySelectorAll("a[href]")) {
    a.setAttribute("rel", "noopener noreferrer");
    a.setAttribute("target", "_blank");
  }
  return el;
}

/* ---------- State ---------- */

const VIEWS = [["status", "Status"], ["timeline", "Timeline"], ["space", "By space"]];
const state = {
  layout: ["split", "chat", "board"].includes(store("clearops.layout")) ? store("clearops.layout") : "split",
  chat: undefined,
  chatRaw: "",
  chatProblem: undefined,
  /** Cleo's own conversation is shown in the chat's place, and what it holds. */
  cleoOpen: false,
  cleoTalk: undefined,
  cleoProblem: undefined,
  /** Which conversation the home page shows: "" for the main one, a chat's id, or "new" for one not yet begun. */
  own: /^[a-f0-9]{8}$/.test(store("clearops.chat") ?? "") ? store("clearops.chat") : "",
  /** Paul's own chats as last heard, for the list. */
  chats: [],
  mainSaidAt: undefined,
  /** Renaming or deleting the chat on screen: which, whether it is being sent, and what went wrong. */
  chatEdit: undefined,
  chatBusy: false,
  chatSaid: undefined,
  chatsOpen: false,
  /** The space the board is narrowed to: a repository's alias, or "" for all of them. */
  space: /^[A-Za-z0-9._-]{1,64}$/.test(store("clearops.space") ?? "") ? store("clearops.space") : "",
  /** On a phone the rail is a drawer: whether it is open. */
  railOpen: false,
  /** A space of Paul's own being made or changed: { id?, name, repos, busy, error, removing }. */
  spaceForm: undefined,
  /** The job whose report is shown in full on its page. */
  reportOpen: undefined,
  /** The job whose report a link asked for, and the one already scrolled to, so each happens once per visit. */
  reportAsked: undefined,
  reportShown: undefined,
  sending: false,
  /** What the last button press did, said once at the top of the page. */
  notice: undefined,
  /** The button being acted on, so it cannot be pressed twice. */
  busy: undefined,
  rerunModel: undefined,
  view: VIEWS.some(([v]) => v === store("clearops.view")) ? store("clearops.view") : "status",
  detail: store("clearops.trace") === "full" ? "full" : "plain",
  board: undefined,
  boardRaw: "",
  history: [],
  historyNext: undefined,
  historyLoading: false,
  job: undefined,
  jobRaw: "",
  /** The Spend page as last read, and what is typed into each cap's box. */
  spend: undefined,
  spendRaw: "",
  spendDraft: {},
  /** The thread on the page being looked at: { key, view, raw, problem, sending }. One at a time. */
  thread: undefined,
  /** The pull request being reviewed: { key, data, loading, error, open }, one at a time. */
  pull: undefined,
  jobMissing: false,
  problem: undefined,
  /** The space whose page is open, as last read, and what is typed into its notes: { id, text, busy, said, bad }. */
  spacePage: undefined,
  spacePageRaw: "",
  spacePageMissing: false,
  notesDraft: undefined,
  /** The agent whose page is open, as last read. */
  agent: undefined,
  agentRaw: "",
  agentMissing: false,
  /** The search page: what is being looked for, what came back, and what went wrong. */
  search: { q: "", data: undefined, loading: false, problem: undefined },
};

const route = () => {
  // A job's page, or the same page with its report opened in full (the link a finished job's message carries).
  const m = /^#\/job\/([A-Za-z0-9_-]{1,64})(\/report)?$/.exec(location.hash);
  if (m) return { name: "job", id: m[1], report: !!m[2] };
  if (location.hash === "#/spend") return { name: "spend" };
  const sp = /^#\/space\/([a-z0-9][a-z0-9-]{0,39})$/.exec(location.hash);
  if (sp) return { name: "space", id: sp[1] };
  const a = /^#\/agent\/([a-z_]{1,24})$/.exec(location.hash);
  if (a) return { name: "agent", kind: a[1] };
  // The search page, with what is being looked for kept in the address so a reload or the back button keeps it.
  const s = /^#\/search(?:\/(.*))?$/.exec(location.hash);
  if (s) {
    let q = "";
    try {
      q = decodeURIComponent(s[1] ?? "").slice(0, 80);
    } catch {
      q = "";
    }
    return { name: "search", q };
  }
  const p = /^#\/pull\/([A-Za-z0-9._-]{1,64})\/([1-9]\d{0,8})$/.exec(location.hash);
  return p ? { name: "pull", repo: p[1], number: Number(p[2]) } : { name: "board" };
};

async function getJson(path) {
  const res = await fetch(`${API}${path}`, { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" });
  if (res.status === 401) {
    location.assign(SIGN_IN);
    throw new Error("signed out");
  }
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`The service answered ${res.status}.`);
  return res.text();
}

/** The few things the app changes: a message, a decision, a job action. Always this site's own JSON. */
async function postJson(path, body) {
  const res = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, credentials: "same-origin", body: JSON.stringify(body) });
  if (res.status === 401) {
    location.assign(SIGN_IN);
    throw new Error("signed out");
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    // A refusal with no body still has its status.
  }
  return { ok: res.ok, status: res.status, data };
}

function say(text, bad = false) {
  state.notice = text ? { text, bad } : undefined;
}

/** One press, one request: the button is held while it is in flight, and what happened is said plainly. */
async function act(key, path, body, after) {
  if (state.busy) return;
  state.busy = key;
  draw();
  try {
    const res = await postJson(path, body);
    say(res.ok ? res.data.text || "Done." : res.data.error || "That could not be done just now.", !res.ok);
    if (res.ok && after) after(res.data);
  } catch (err) {
    if (err.message !== "signed out") say("The service could not be reached, so nothing was done.", true);
  }
  state.busy = undefined;
  state.boardRaw = "";
  state.jobRaw = "";
  await Promise.all([refreshBoard(), route().name === "job" ? refreshJob(route().id) : route().name === "spend" ? refreshSpend() : false]);
  draw();
  void chatTick();
}

const DECIDE = { email: ["Send", "Do not send"], purchase: ["Buy", "Decline"], dns: ["Apply", "Cancel"], signup: ["Create account", "Cancel"] };

/* ---------- Pieces ---------- */

function statusTag(job) {
  if (job.status === "running") return h("span", { class: "tag run" }, h("span", { class: `dot ${job.alive === false ? "" : "live"}` }), job.alive === false ? "No live worker" : "Running");
  if (job.status === "queued") return job.held ? h("span", { class: "tag" }, icon("pause", 12), "Held") : h("span", { class: "tag" }, "Queued");
  if (job.status === "failed") return h("span", { class: "tag bad" }, icon("cross", 12), "Failed");
  // A run that ended is not a wish that was met. The tick is kept for what the service can confirm.
  const state = job.outcome?.state;
  if (state === "met") return h("span", { class: "tag ok" }, icon("check", 12), job.outcome.by === "you" ? "Done" : "Confirmed");
  if (state === "waiting") return h("span", { class: "tag wait" }, "Needs you");
  if (state === "not_met") return h("span", { class: "tag bad" }, icon("cross", 12), "Not done");
  return h("span", { class: "tag" }, "Finished");
}

/** Which pile a finished job belongs in: what it achieved, not merely that it ended. */
const pile = (job) => (job.status === "failed" ? "not_met" : job.status === "done" ? job.outcome?.state ?? "unconfirmed" : job.status);

function jobSub(job) {
  return [who(job), modelName(job.model), job.repositoryName].filter(Boolean).join(" · ");
}

function jobLine(job, now) {
  if (job.status === "running") {
    if (job.now) return h("div", { class: "card-line now" }, h("span", { class: "dot live" }), h("span", {}, job.now));
    return h("div", { class: "card-line" }, h("span", {}, `Running for ${span(now - Date.parse(job.startedAt ?? job.createdAt))}`));
  }
  if (job.status === "queued") {
    if (job.waitingBehind) return h("div", { class: "card-line" }, h("span", {}, `Waiting behind ${job.waitingBehind.title}${job.queuePosition ? `, place ${job.queuePosition}` : ""}`));
    if (job.held) return h("div", { class: "card-line" }, h("span", {}, "Held until the cap or the hold is lifted"));
    return h("div", { class: "card-line" }, h("span", {}, "About to start"));
  }
  if (job.status === "failed") return h("div", { class: "card-line bad" }, h("span", {}, `${job.failure ?? "Failed"} · ${ago(job.finishedAt, now) ?? ""}`));
  const state = job.outcome?.state;
  const tone = state === "met" ? " good" : state === "not_met" ? " bad" : state === "waiting" ? " wait" : "";
  return h("div", { class: `card-line${tone}` }, h("span", {}, `${job.outcome?.text ?? "The run finished."} ${ago(job.finishedAt, now) ?? ""}`));
}

/**
 * For a job with no figure of its own yet: what finished jobs of its kind on its model usually cost.
 * Worded as what jobs like it cost, never as this job's cost.
 */
const usualLine = (job) => (job.usual ? h("div", { class: "card-line usual" }, h("span", {}, `Jobs like this usually cost about ${money(job.usual.usd)}`)) : null);
const usualWords = (u) => `Jobs like this usually cost about ${money(u.usd)} on this model${u.lowUsd !== u.highUsd ? `, mostly ${money(u.lowUsd)} to ${money(u.highUsd)}` : ""}. An estimate from ${u.jobs} past jobs, not this job's cost.`;

/** That something has been said in a job's or a pull request's own thread. */
const threadNote = (note, now) => (note ? h("div", { class: "card-line" }, h("span", {}, `Thread: ${note.count} ${note.count === 1 ? "message" : "messages"}, the last ${ago(note.lastAt, now)}.`)) : null);

function jobCard(job, now) {
  return h(
    "a",
    { class: "card", href: `#/job/${job.id}` },
    h(
      "div",
      { class: "card-top" },
      avatar(job.kind, "sm"),
      h("div", { class: "card-main" }, h("div", { class: "card-title" }, job.title), h("div", { class: "card-sub" }, jobSub(job))),
      job.costUsd !== undefined ? h("div", { class: "card-cost num" }, money(job.costUsd)) : null,
    ),
    jobLine(job, now),
    usualLine(job),
    job.said ? h("div", { class: "card-said" }, job.said) : null,
    threadNote(job.thread, now),
  );
}

function waitingCard(item, now) {
  const key = `${item.what}:${item.id}`;
  const busy = state.busy !== undefined;
  const [yes, no] = DECIDE[item.what] ?? ["Approve", "Decline"];
  const decide = (verb) => () => void act(key, "/approvals", { what: item.what, id: item.id, verb, seen: item.seen });
  return h(
    "div",
    { class: "card wait" },
    h("div", { class: "card-main" }, h("div", { class: "card-title" }, item.label), h("div", { class: "card-sub" }, `Asked ${ago(item.createdAt, now)} · open for another ${span(Date.parse(item.expiresAt) - now)}`)),
    // With the item's own words and its fingerprint the app can decide it; without them it only names it.
    item.preview && item.seen
      ? [
          h("div", { class: "preview" }, item.preview),
          h(
            "div",
            { class: "links" },
            h("button", { class: "btn primary", type: "button", disabled: busy, onclick: decide("approve") }, state.busy === key ? "Working" : yes),
            h("button", { class: "btn", type: "button", disabled: busy, onclick: decide("decline") }, no),
          ),
        ]
      : [h("div", { class: "card-sub" }, "Approve it in chat by sending:"), h("div", { class: "cmd" }, item.command)],
    item.jobId ? h("a", { href: `#/job/${item.jobId}` }, "See the job") : null,
  );
}

const noticeBar = () => (state.notice ? h("div", { class: `banner${state.notice.bad ? " bad" : ""}`, role: "status" }, state.notice.text) : null);

function column(tone, title, cards, emptyText, extra) {
  return h(
    "section",
    { class: "col" },
    h("h2", { class: `col-head ${tone}` }, h("span", {}, title), h("span", { class: "num" }, cards.length + (extra?.hidden ?? 0))),
    cards.length ? cards : h("div", { class: "empty" }, emptyText),
    extra?.node ?? null,
  );
}

/** The one form in the app: ending the session. In the header, and on a phone in the drawer, where there is room for it. */
const signOut = (place) =>
  h("form", { method: "post", action: "/app/sign-out", class: `signout ${place}` }, h("button", { class: place === "in-rail" ? "rail-row rail-do" : "btn quiet", type: "submit", "aria-label": "Sign out" }, icon("out", 16), h("span", { class: place === "in-rail" ? "rail-name" : "wide-only", "aria-hidden": "true" }, "Sign out")));

function header(board) {
  const s = board?.spend;
  let spend = null;
  if (s) {
    const pct = s.usd !== undefined && s.capUsd ? Math.min(100, Math.round((s.usd / s.capUsd) * 100)) : undefined;
    const fill = h("i");
    if (pct !== undefined) fill.style.width = `${pct}%`;
    const figure = s.usd === undefined ? "No figure" : s.capUsd !== undefined ? `${money(s.usd)} of ${money(s.capUsd)}` : money(s.usd);
    spend = h(
      "a",
      { class: `spend ${s.capReached ? "capped" : ""}`, title: s.note, href: "#/spend", "aria-label": "Spend today. Open the spend page." },
      h(
        "div",
        { class: "spend-fig" },
        h("div", { class: "spend-row" }, h("span", { class: "muted" }, "Spend today"), h("b", { class: "num" }, figure)),
        pct !== undefined ? h("div", { class: "meter", role: "img", "aria-label": `${pct} percent of today's cap used` }, fill) : null,
      ),
      s.capReached ? h("span", { class: "tag wait" }, "Cap reached") : s.capLifted ? h("span", { class: "tag" }, "Cap lifted today") : null,
    );
  }
  const healthy = board?.health.level === "ok";
  const health = board
    ? h("span", { class: `pill ${healthy ? "" : "warn"}`, title: `${board.health.headline} ${board.health.live}` }, healthy ? icon("check", 14, healthy ? "Healthy" : "Needs a look") : icon("cross", 14, "Needs a look"), h("span", { class: "wide-only", "aria-hidden": "true" }, healthy ? "Healthy" : "Needs a look"))
    : null;
  return h(
    "header",
    { class: "top" },
    route().name === "board" && narrow.matches ? h("button", { class: "btn quiet rail-open", type: "button", "aria-expanded": String(state.railOpen), "aria-controls": "rail", "aria-label": "Spaces and who is on shift", onclick: () => setRail(!state.railOpen) }, icon("menu", 18)) : null,
    h("a", { class: "brand", href: "#/", "aria-label": "ClearOps" }, h("span", { class: "mark", "aria-hidden": "true" }, h("i"), h("i")), h("span", { class: "brand-name", "aria-hidden": "true" }, "ClearOps")),
    route().name === "board"
      ? h(
          "div",
          { class: "seg", role: "group", "aria-label": "What to show" },
          h("button", { type: "button", "aria-pressed": String(layout() === "chat"), onclick: () => setLayout("chat") }, "Chat"),
          roomy.matches ? h("button", { type: "button", "aria-pressed": String(layout() === "split"), onclick: () => setLayout("split") }, "Both") : null,
          h("button", { type: "button", "aria-pressed": String(layout() === "board"), onclick: () => setLayout("board") }, "Board"),
        )
      : null,
    route().name === "search" ? null : h("a", { class: "pill search-open", href: "#/search", "aria-label": "Search jobs, reports and chats" }, icon("search", 16), h("span", { class: "search-open-text", "aria-hidden": "true" }, "Search jobs, reports and chats")),
    h("div", { class: "grow" }),
    spend,
    health,
    // On a phone's board the drawer holds it, to leave room for the rest; on every other page it stays here.
    signOut(route().name === "board" ? "in-top" : "in-top always"),
  );
}

/* ---------- The rail: spaces, and who is on shift ---------- */

/** The space the board is narrowed to, as the board last listed it; undefined for all of them. */
const spaceOf = () => (state.space ? (state.board?.spaces ?? []).find((s) => s.id === state.space) : undefined);

/**
 * The space whose own chat is on screen, or "" when it is the main conversation or one of Paul's own
 * chats. Before the board has arrived the stored choice is taken at its word, so the right conversation
 * is asked for first; the service says so if there is no such space.
 */
const spaceChat = () => (state.space && (!state.board || spaceOf()?.managed) ? state.space : "");
/** The conversation on screen, as the service is asked for it; undefined for the main one. */
const threadOnScreen = () => (spaceChat() ? `space:${spaceChat()}` : state.own === "new" ? "chat:new" : state.own ? `chat:${state.own}` : undefined);

/** Whether a job is in a space: on that repository, or for one of Paul's own, on one of its repositories or started from its chat. */
const inSpace = (sp) => (j) => (sp.own ? sp.repos.includes(j.repository) || j.space === sp.id : j.repository === sp.id);

/** The board with only one space's jobs and pull requests. What waits on Paul's decision is never narrowed away. */
const scoped = (board) => (spaceOf() ? { ...board, jobs: board.jobs.filter(inSpace(spaceOf())), pulls: (board.pulls ?? []).filter((p) => (spaceOf().own ? spaceOf().repos.includes(p.repo) : p.repo === state.space)) } : board);

function setRail(open) {
  state.railOpen = open;
  if (!open) state.spaceForm = undefined;
  draw();
  if (open) railEl.querySelector("[aria-current='true']")?.focus({ preventScroll: true });
}

/**
 * Goes into one space, or back to all of them: the board is narrowed to it and the chat becomes that
 * space's own. A space that is not a managed repository has no chat, so there the board is all that
 * changes, and choosing it from the chat brings the board into view.
 */
function setSpace(id) {
  const was = threadOnScreen();
  state.cleoOpen = false;
  state.space = id;
  store("clearops.space", id);
  state.history = [];
  state.historyNext = undefined;
  state.railOpen = false;
  state.spaceForm = undefined;
  if (id && !spaceChat() && layout() === "chat") state.layout = "board";
  if (threadOnScreen() !== was) {
    state.chatsOpen = false;
    state.chatEdit = undefined;
    state.chat = state.own === "new" && !spaceChat() ? { generatedAt: new Date().toISOString(), messages: [], jobs: [], typing: false } : undefined;
    state.chatRaw = "";
    state.chatProblem = undefined;
    stickNext = true;
  }
  draw();
  void chatTick();
}

/** Makes, changes or removes a space of Paul's own: his own tap, sent as this site's own JSON like every other change. */
async function saveSpace(action) {
  const f = state.spaceForm;
  if (!f || f.busy) return;
  f.busy = true;
  f.error = undefined;
  drawRail(true);
  try {
    const res = await postJson("/spaces", action === "delete" ? { action, id: f.id } : { action, ...(f.id ? { id: f.id } : {}), name: f.name, repos: [...f.repos] });
    if (!res.ok) {
      f.busy = false;
      f.error = res.data.error || "That could not be done just now.";
      return void drawRail(true);
    }
    state.spaceForm = undefined;
    state.boardRaw = "";
    await refreshBoard();
    // A new space is gone into; a removed one is left for all of them.
    if (action === "create" && res.data.id) return void setSpace(res.data.id);
    if (action === "delete") return void setSpace("");
    draw();
  } catch (err) {
    f.busy = false;
    f.error = err.message === "signed out" ? undefined : "The service could not be reached, so nothing was changed.";
    drawRail(true);
  }
}

function spaceForm(board) {
  const f = state.spaceForm;
  const set = (patch) => () => { Object.assign(f, patch); drawRail(true); };
  if (f.removing) {
    return h(
      "div",
      { class: "space-form" },
      h("p", { class: "space-form-ask" }, `Remove "${f.name}"? Its chat goes for good. Its jobs are kept and stay where they are.`),
      f.error ? h("p", { class: "refused", role: "alert" }, f.error) : null,
      h("div", { class: "space-form-row" }, h("button", { class: "btn danger", type: "button", disabled: f.busy, onclick: () => void saveSpace("delete") }, "Remove it"), h("button", { class: "btn quiet", type: "button", disabled: f.busy, onclick: set({ removing: false, error: undefined }) }, "Keep it")),
    );
  }
  const repos = board.spaces.filter((sp) => sp.managed && !sp.own);
  const name = h("input", { class: "chat-name", id: "space-name", type: "text", maxlength: "48", autocomplete: "off", placeholder: "Name", value: f.name, "aria-label": "The space's name", oninput: (e) => { f.name = e.target.value; } });
  return h(
    "form",
    { class: "space-form", onsubmit: (e) => { e.preventDefault(); void saveSpace(f.id ? "update" : "create"); } },
    h("b", {}, f.id ? "Change this space" : "A space of your own"),
    name,
    repos.length
      ? h(
          "fieldset",
          { class: "space-form-repos" },
          h("legend", { class: "muted" }, "Repositories in it, if any"),
          repos.map((sp) => h("label", { class: "space-form-repo" }, h("input", { type: "checkbox", checked: f.repos.has(sp.id), onchange: (e) => { if (e.target.checked) f.repos.add(sp.id); else f.repos.delete(sp.id); } }), h("span", {}, sp.name))),
        )
      : null,
    f.error ? h("p", { class: "refused", role: "alert" }, f.error) : null,
    h("div", { class: "space-form-row" }, h("button", { class: "btn primary", type: "submit", disabled: f.busy }, f.id ? "Save" : "Create"), h("button", { class: "btn quiet", type: "button", disabled: f.busy, onclick: () => { state.spaceForm = undefined; drawRail(true); } }, "Cancel")),
    f.id ? h("button", { class: "btn quiet space-form-remove", type: "button", disabled: f.busy, onclick: set({ removing: true, error: undefined }) }, "Remove this space") : null,
  );
}

function rail(board) {
  if (!board) return [];
  const count = (waiting, active) => (waiting ? h("span", { class: "rail-count wait" }, `${waiting} waiting`) : active ? h("span", { class: "rail-count", "aria-label": `${active} active` }, String(active)) : null);
  const row = (id, name, waiting, active, fresh) => h("button", { class: "rail-row", type: "button", "aria-current": String(state.space === id || (!id && !spaceOf())), onclick: () => setSpace(id) }, fresh ? h("span", { class: "new-dot", role: "img", "aria-label": "Something new in its chat" }) : null, h("span", { class: "rail-name" }, name), count(waiting, active));
  // Each job is on one repository, so the repositories' spaces add up to everything; his own spaces
  // hold some of the same jobs again and are left out of the total.
  const sum = (key) => board.spaces.filter((s) => !s.own).reduce((n, s) => n + s[key], 0);
  const spaces = h(
    "section",
    { "aria-label": "Spaces" },
    h("h2", { class: "rail-head" }, "Spaces"),
    row("", "All spaces", board.waiting.length + sum("waiting"), sum("active"), !!spaceChat() && ["", ...state.chats.map((c) => c.id)].some(hasNew)),
    board.spaces.map((s) => row(s.id, s.name, s.waiting, s.active, hasNewAt(`space:${s.id}`, s.saidAt))),
    state.spaceForm
      ? spaceForm(board)
      : [
          spaceOf()?.managed ? h("a", { class: "rail-row rail-do", href: `#/space/${spaceOf().id}` }, icon("doc", 14), h("span", { class: "rail-name" }, "Notes and library")) : null,
          spaceOf()?.own ? h("button", { class: "rail-row rail-do", type: "button", onclick: () => { state.spaceForm = { id: spaceOf().id, name: spaceOf().name, repos: new Set(spaceOf().repos) }; drawRail(true); document.getElementById("space-name")?.focus(); } }, h("span", { class: "rail-name" }, "Change this space")) : null,
          h("button", { class: "rail-row rail-do", type: "button", onclick: () => { state.spaceForm = { name: "", repos: new Set() }; drawRail(true); document.getElementById("space-name")?.focus(); } }, icon("plus", 14), h("span", { class: "rail-name" }, "New space")),
        ],
  );
  const person = (r) => {
    const title = h("div", { class: "rail-who" }, h("b", {}, r.name ?? r.role.charAt(0).toUpperCase() + r.role.slice(1)), r.name ? h("span", { class: "muted" }, ` ${r.role}`) : null);
    const kids = [avatar(r.kind, "sm"), h("div", { class: "rail-main" }, title, h("div", { class: `rail-line ${r.state}` }, r.state === "working" ? h("i", { class: "live-dot", "aria-hidden": "true" }) : null, r.line))];
    return h("a", { class: "rail-person", href: `#/agent/${r.kind}` }, kids);
  };
  const shift = h("section", { "aria-label": "On shift" }, h("h2", { class: "rail-head" }, "On shift"), (board.roster ?? []).map(person));
  return [spaces, shift, signOut("in-rail")];
}

/* ---------- One space: notes and library ---------- */

async function refreshSpacePage(id) {
  try {
    const text = await getJson(`/spaces/${id}`);
    if (route().id !== id) return false;
    if (text === undefined) {
      state.spacePageMissing = true;
      state.spacePage = undefined;
      return true;
    }
    const changed = text !== state.spacePageRaw || state.problem || state.spacePageMissing;
    state.problem = undefined;
    state.spacePageMissing = false;
    if (changed) {
      state.spacePageRaw = text;
      state.spacePage = JSON.parse(text);
      return true;
    }
  } catch (err) {
    if (err.message === "signed out") return false;
    const had = state.problem;
    state.problem = "The service could not be reached. Trying again.";
    return !had;
  }
  return false;
}

/** Keeps what is typed into a space's notes: his own tap, sent as this site's own JSON like every other change. */
async function saveNotes(id) {
  const d = state.notesDraft;
  if (!d || d.id !== id || d.busy) return;
  d.busy = true;
  d.said = undefined;
  draw();
  try {
    const res = await postJson("/spaces", { action: "notes", id, notes: d.text });
    d.busy = false;
    if (!res.ok) {
      d.said = res.data.error || "The notes could not be saved just now.";
      d.bad = true;
    } else {
      d.text = res.data.text ?? d.text;
      d.saved = d.text;
      d.said = d.text ? "Saved. Marlo is given these with every message in this space's chat." : "Cleared.";
      d.bad = false;
      state.spacePageRaw = "";
      await refreshSpacePage(id);
    }
  } catch (err) {
    d.busy = false;
    d.said = err.message === "signed out" ? undefined : "The service could not be reached, so nothing was saved.";
    d.bad = true;
  }
  draw();
}

function spacePage() {
  const r = route();
  const back = h("a", { class: "btn", href: "#/" }, icon("back"), "Back");
  const sp = state.spacePage;
  if (state.spacePageMissing) return h("main", { class: "page" }, h("div", { class: "job-head" }, back), h("p", { class: "muted" }, "There is no such space."));
  if (!sp || sp.id !== r.id) return h("main", { class: "page" }, h("div", { class: "job-head" }, back), h("p", { class: "muted" }, state.problem ?? "Loading."));
  const now = Date.parse(sp.generatedAt);
  // What is typed is kept apart from what was last read, so a refresh never wipes it.
  if (!state.notesDraft || state.notesDraft.id !== sp.id) state.notesDraft = { id: sp.id, text: sp.notes?.text ?? "", saved: sp.notes?.text ?? "" };
  const d = state.notesDraft;
  const box = h("textarea", { id: "space-notes", class: "notes-box", rows: "8", maxlength: String(sp.notesMax), "aria-label": `Your notes for ${sp.name}`, placeholder: "What should Marlo keep in mind here? Who it is for, what matters, what to avoid.", oninput: (e) => { d.text = e.target.value; d.said = undefined; } });
  box.value = d.text;
  const head = h("div", { class: "job-head" }, back, h("div", { class: "job-id" }, h("div", { class: "job-title" }, h("h1", {}, sp.name)), h("div", { class: "muted" }, sp.own ? (sp.repositories.length ? `A space of your own, with ${sp.repositories.join(", ")}.` : "A space of your own, tied to no repository.") : "This repository's space.")));
  const notes = h(
    "section",
    { class: "pane", "aria-label": "Your notes" },
    h("h2", {}, "Your notes"),
    h("p", { class: "muted" }, `Only you write these. ${CHIEF} is given them with every message in this space's chat, as background from you, and cannot change them.`),
    box,
    h("div", { class: "row-banner" }, h("button", { class: "btn primary", type: "button", disabled: d.busy, onclick: () => void saveNotes(sp.id) }, d.busy ? "Saving" : "Save notes"), sp.notes ? h("span", { class: "muted" }, `Last saved ${ago(sp.notes.updatedAt, now)}.`) : h("span", { class: "muted" }, "None saved yet.")),
    d.said ? h("p", { class: d.bad ? "refused" : "muted", role: "status" }, d.said) : null,
  );
  const reports = h(
    "section",
    { "aria-label": "Reports" },
    h("h2", { class: "day" }, `Reports · ${sp.reports.length}${sp.moreReports ? "+" : ""}`),
    sp.reports.length
      ? h("div", { class: "rows" }, sp.reports.map((j) => h("a", { class: "row", href: `#/job/${j.id}/report` }, avatar(j.kind, "sm"), h("div", { class: "row-main" }, h("div", { class: "card-title" }, j.title), h("div", { class: "card-sub" }, `${NAMES[j.kind] ? `${NAMES[j.kind]} · ` : ""}${j.who} · ${ago(j.at, now) ?? ""}`)))))
      : h("div", { class: "empty" }, "No job in this space has written a report the app can show."),
    sp.moreReports ? h("div", { class: "more" }, "Older reports are found by searching.") : null,
  );
  const files = h(
    "section",
    { "aria-label": "Files you sent here" },
    h("h2", { class: "day" }, `Files you sent here · ${sp.files.length}${sp.moreFiles ? "+" : ""}`),
    sp.files.length ? h("div", { class: "rows" }, sp.files.map((f) => h("div", { class: "row plain" }, h("span", { class: "found-icon" }, icon("clip", 16)), h("div", { class: "row-main" }, h("div", { class: "card-title" }, f.name), h("div", { class: "card-sub" }, `Sent ${ago(f.at, now) ?? ""}`))))) : h("div", { class: "empty" }, "You have sent no files in this space's chat."),
    h("p", { class: "muted" }, "Names only. A file you send is kept for the workers to read and is not opened from here."),
  );
  return h("main", { class: "page" }, head, state.problem ? h("div", { class: "banner" }, h("b", {}, "Not up to date. "), state.problem) : null, notes, reports, files);
}

/* ---------- One agent ---------- */

async function refreshAgent(kind) {
  try {
    const text = await getJson(`/agents/${kind}`);
    if (route().kind !== kind) return false;
    if (text === undefined) {
      state.agentMissing = true;
      state.agent = undefined;
      return true;
    }
    const changed = text !== state.agentRaw || state.problem || state.agentMissing;
    state.problem = undefined;
    state.agentMissing = false;
    if (changed) {
      state.agentRaw = text;
      state.agent = JSON.parse(text);
      return true;
    }
  } catch (err) {
    if (err.message === "signed out") return false;
    const had = state.problem;
    state.problem = "The service could not be reached. Trying again.";
    return !had;
  }
  return false;
}

function agentPage() {
  const back = h("a", { class: "btn", href: "#/" }, icon("back"), "Back");
  const a = state.agent;
  if (state.agentMissing) return h("main", { class: "page" }, h("div", { class: "job-head" }, back), h("p", { class: "muted" }, "There is no such agent."));
  if (!a) return h("main", { class: "page" }, h("div", { class: "job-head" }, back), h("p", { class: "muted" }, state.problem ?? "Loading."));
  const now = Date.parse(a.generatedAt);
  const title = a.name ?? a.role.charAt(0).toUpperCase() + a.role.slice(1);
  const head = h(
    "div",
    { class: "job-head" },
    back,
    avatar(a.kind, "lg"),
    h("div", { class: "job-id" }, h("div", { class: "job-title" }, h("h1", {}, title)), h("div", { class: "muted" }, `${a.name ? `The ${a.role}: ` : ""}${a.does}.`)),
  );
  const doing = h("div", { class: `agent-now ${a.now.state}` }, a.now.state === "working" ? h("i", { class: "live-dot", "aria-hidden": "true" }) : null, a.now.jobId ? h("a", { href: `#/job/${a.now.jobId}` }, a.now.line) : a.now.line);
  const tiles = h(
    "div",
    { class: "stats" },
    stat("Model", modelName(a.model) ?? h("small", {}, "Not known"), a.modelNote),
    a.limits ? stat("One job may run", [String(a.limits.maxTurns), h("small", {}, " turns")], a.limits.budgetUsd !== undefined ? `and spend up to ${money(a.limits.budgetUsd)}.` : "No money cap is set for its jobs.") : null,
  );
  const tools = h(
    "section",
    { class: "pane", "aria-label": "What it may use" },
    h("h2", {}, "What it may use"),
    h("ul", { class: "plain-list" }, a.tools.map((t) => h("li", {}, t))),
    a.refused ? h("p", { class: "muted" }, `${a.refused} ${a.refused === 1 ? "command is" : "commands are"} refused to it outright, whatever it is asked.`) : null,
  );
  // Finished is not the same as done, so the outcomes are counted apart and no single rate is made of them.
  const record = a.windows.length
    ? h(
        "section",
        { class: "pane", "aria-label": "How it has been doing" },
        h("h2", {}, "How it has been doing"),
        a.windows.map((w) => {
          const parts = [[w.met, "confirmed done", "good"], [w.unconfirmed, "not confirmed", ""], [w.waiting, "waiting on you", "wait"], [w.notMet, "did not get there", "bad"]].filter(([n]) => n);
          return h(
            "div",
            { class: "block" },
            h("h3", {}, `${w.label.charAt(0).toUpperCase()}${w.label.slice(1)}`),
            w.finished
              ? [
                  h("div", { class: "agent-count" }, h("b", { class: "num" }, String(w.finished)), ` finished: `, parts.map(([n, words, tone], i) => [i ? ", " : "", h("span", { class: tone ? `tone-${tone}` : "" }, `${n} ${words}`)]), "."),
                  w.why ? h("p", { class: "muted" }, `Why the ones that stopped did: ${w.why}.`) : null,
                  w.run ? h("p", { class: "muted" }, `${w.run.charAt(0).toUpperCase()}${w.run.slice(1)}.`) : null,
                  w.wait ? h("p", { class: "muted" }, `${w.wait.charAt(0).toUpperCase()}${w.wait.slice(1)}.`) : null,
                  h("p", { class: "muted" }, w.costUsd !== undefined ? `Cost: ${money(w.costUsd)} in all, the provider's own figures, for ${w.costedJobs} of the ${w.finished}.` : "Cost: the store holds no provider figure for these jobs."),
                ]
              : h("p", { class: "muted" }, "Nothing finished."),
          );
        }),
      )
    : null;
  const usual = a.usual.length
    ? h(
        "section",
        { class: "pane", "aria-label": "What a job of its usually costs" },
        h("h2", {}, "What a job of its usually costs"),
        h("div", { class: "rows" }, a.usual.map((u) => h("div", { class: "row plain" }, h("div", { class: "row-main" }, h("div", { class: "card-title" }, `${u.kind === "research, deep" ? "Deep research on " : "On "}${modelName(u.model)}`), h("div", { class: "card-sub" }, `${u.lowUsd !== u.highUsd ? `mostly ${money(u.lowUsd)} to ${money(u.highUsd)}, ` : ""}from ${u.jobs} jobs`)), h("div", { class: "row-right num" }, `about ${money(u.usd)}`)))),
        h("p", { class: "muted" }, "An estimate from finished jobs' own figures, not a price."),
      )
    : null;
  const replies = a.repliesToday?.length
    ? h("section", { class: "pane", "aria-label": "Its replies today" }, h("h2", {}, "Its replies today"), h("div", { class: "rows" }, a.repliesToday.map((m) => h("div", { class: "row plain" }, h("div", { class: "row-main" }, h("div", { class: "card-title" }, modelName(m.model)), h("div", { class: "card-sub" }, `${m.calls} ${m.calls === 1 ? "call" : "calls"}`)), h("div", { class: "row-right" }, h("span", { class: "card-cost num" }, money(m.usd)))))), h("p", { class: "muted" }, "The provider's own charges."))
    : null;
  const jobs = a.kind === "chief" ? null : h("section", { "aria-label": "Its newest jobs" }, h("h2", { class: "day" }, "Its newest jobs"), a.jobs.length ? h("div", { class: "grid" }, a.jobs.map((j) => jobCard(j, now))) : h("div", { class: "empty" }, "It has not had a job yet."));
  return h("main", { class: "page" }, head, state.problem ? h("div", { class: "banner" }, h("b", {}, "Not up to date. "), state.problem) : null, doing, tiles, tools, record, usual, replies, jobs);
}

/* ---------- Search ---------- */

/** A line of text with the words that were searched for marked. Built as text and elements, never as markup. */
function markedText(text, words) {
  const low = text.toLowerCase();
  const out = [];
  let i = 0;
  while (i < text.length) {
    let at = -1;
    let len = 0;
    for (const w of words) {
      const k = w ? low.indexOf(w, i) : -1;
      if (k >= 0 && (at < 0 || k < at)) {
        at = k;
        len = w.length;
      }
    }
    if (at < 0) {
      out.push(text.slice(i));
      break;
    }
    if (at > i) out.push(text.slice(i, at));
    out.push(h("mark", {}, text.slice(at, at + len)));
    i = at + len;
  }
  return out;
}

/** Opens the conversation a found message is in. It opens at the newest message, not at the one found. */
function openWhere(w) {
  if (w.in === "cleo") {
    if (layout() === "board") state.layout = "chat";
    location.hash = "#/";
    return void showCleo(true);
  }
  state.cleoOpen = false;
  if (w.in === "job") return void (location.hash = `#/job/${w.id}`);
  if (w.in === "pull") return void (location.hash = `#/pull/${w.repo}/${w.number}`);
  state.space = w.in === "space" ? w.id : "";
  store("clearops.space", state.space);
  if (w.in !== "space") {
    state.own = w.in === "chat" ? w.id : "";
    store("clearops.chat", state.own);
  }
  state.history = [];
  state.historyNext = undefined;
  state.chat = undefined;
  state.chatRaw = "";
  state.chatProblem = undefined;
  stickNext = true;
  if (layout() === "board") state.layout = "chat";
  location.hash = "#/";
  void chatTick();
}

function searchResults() {
  const { q, data, loading, problem } = state.search;
  if (problem) return [h("div", { class: "banner" }, problem)];
  if (q.trim().length < 2) return [h("p", { class: "muted" }, "Type two letters or more. It looks through job titles and briefs, saved reports, and what has been said in the app's chats, including the names of files you sent. Every word you type has to be there.")];
  if (!data) return [h("p", { class: "muted" }, loading ? "Searching." : "")];
  const now = Date.now();
  const words = data.words ?? [];
  const more = (flag) => (flag ? h("div", { class: "more" }, "More match than are shown. Add a word to narrow it.") : null);
  const group = (title, n, rows, flag) => (n ? h("section", { "aria-label": title }, h("h2", { class: "day" }, `${title} · ${n}${flag ? "+" : ""}`), h("div", { class: "rows" }, rows), more(flag)) : null);
  const out = [
    group("Jobs", data.jobs.length, data.jobs.map((j) => h("a", { class: "row", href: `#/job/${j.id}` }, avatar(j.kind, "sm"), h("div", { class: "row-main" }, h("div", { class: "card-title" }, markedText(j.title, words)), h("div", { class: "card-sub" }, `${NAMES[j.kind] ? `${NAMES[j.kind]} · ` : ""}${j.who} · ${j.repositoryName} · ${j.status === "done" ? "finished" : j.status} ${ago(j.at, now) ?? ""}`), j.snippet ? h("div", { class: "found" }, markedText(j.snippet, words)) : null))), data.more.jobs),
    group("Reports", data.reports.length, data.reports.map((r) => h("a", { class: "row", href: `#/job/${r.id}/report` }, h("span", { class: "found-icon" }, icon("doc", 18)), h("div", { class: "row-main" }, h("div", { class: "card-title" }, r.title), h("div", { class: "card-sub" }, `Report · ${ago(r.at, now) ?? ""}`), h("div", { class: "found" }, markedText(r.snippet, words))))), data.more.reports),
    group("Chats", data.messages.length, data.messages.map((m) => h("button", { class: "row row-button", type: "button", onclick: () => openWhere(m.where) }, m.from === "paul" ? h("span", { class: "av sm av-you", "aria-hidden": "true" }, h("i"), h("i")) : avatar(m.where.in === "cleo" ? "voice" : "chief", "sm"), h("div", { class: "row-main" }, h("div", { class: "card-title" }, m.title), h("div", { class: "card-sub" }, `${m.from === "paul" ? "You" : m.where.in === "cleo" ? CLEO : CHIEF} · ${ago(m.at, now) ?? ""}`), h("div", { class: "found" }, markedText(m.snippet, words))))), data.more.messages),
  ].filter(Boolean);
  return out.length ? out : [h("div", { class: "empty" }, `Nothing found for "${data.q}".`)];
}

/* ---------- Board views ---------- */

function statusView(board, now) {
  const by = (which) => board.jobs.filter((j) => pile(j) === which);
  const capped = (jobs) => {
    const hidden = Math.max(0, jobs.length - DONE_SHOWN);
    return { cards: jobs.slice(0, DONE_SHOWN).map((j) => jobCard(j, now)), extra: { hidden, node: hidden ? h("div", { class: "more" }, `${hidden} more in Timeline.`) : null } };
  };
  const met = capped(by("met"));
  const open = capped(by("unconfirmed"));
  const not = capped(by("not_met"));
  return h(
    "div",
    { class: "cols" },
    column("wait", "Waiting on me", [...board.waiting.map((w) => waitingCard(w, now)), ...by("waiting").map((j) => jobCard(j, now))], "Nothing needs you."),
    pullsColumn(board, now),
    column("run", "Running", by("running").map((j) => jobCard(j, now)), "Nobody is working right now."),
    column("", "Queued", by("queued").map((j) => jobCard(j, now)), "The queue is empty."),
    column("ok", "Confirmed done", met.cards, "Nothing in the last two days is confirmed as done.", met.extra),
    column("", "Finished, not confirmed", open.cards, "Nothing is waiting to be judged.", open.extra),
    column("bad", "Did not get there", not.cards, "Nothing has fallen short.", not.extra),
  );
}

function jobRow(job, now) {
  const at = job.finishedAt ?? job.startedAt ?? job.createdAt;
  return h(
    "a",
    { class: "row", href: `#/job/${job.id}` },
    h("span", { class: "row-time num" }, clock(at)),
    avatar(job.kind, "sm"),
    h("div", { class: "row-main" }, h("div", { class: "card-title" }, job.title), h("div", { class: "card-sub" }, jobSub(job)), job.outcome && job.outcome.state !== "unconfirmed" ? h("div", { class: "card-sub" }, job.outcome.text) : null),
    h("div", { class: "row-right" }, job.costUsd !== undefined ? h("span", { class: "card-cost num" }, money(job.costUsd)) : null, statusTag(job)),
  );
}

function timelineView(board, now) {
  const seen = new Set();
  const all = [...board.jobs, ...state.history].filter((j) => !seen.has(j.id) && seen.add(j.id));
  const active = all.filter((j) => j.status === "running" || j.status === "queued");
  const finished = all.filter((j) => j.status === "done" || j.status === "failed").sort((a, b) => (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt));
  const out = [];
  if (active.length) out.push(h("h2", { class: "day" }, "Now"), h("div", { class: "rows" }, active.map((j) => jobRow(j, now))));
  const today = dayKey(new Date(now).toISOString());
  const yesterday = dayKey(new Date(now - 86400000).toISOString());
  const groups = new Map();
  for (const j of finished) {
    const key = dayKey(j.finishedAt ?? j.createdAt);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(j);
  }
  for (const [key, jobs] of groups) {
    const label = key === today ? "Today" : key === yesterday ? "Yesterday" : dayFmt.format(new Date(jobs[0].finishedAt ?? jobs[0].createdAt));
    out.push(h("h2", { class: "day" }, label), h("div", { class: "rows" }, jobs.map((j) => jobRow(j, now))));
  }
  if (!out.length) out.push(h("div", { class: "empty" }, "No jobs yet."));
  const moreOlder = state.history.length ? state.historyNext !== undefined : board.hasOlder;
  if (moreOlder) out.push(h("div", { class: "center" }, h("button", { class: "btn", type: "button", disabled: state.historyLoading, onclick: loadOlder }, state.historyLoading ? "Loading" : "Load older jobs")));
  return h("div", {}, out);
}

function spaceView(board, now) {
  const groups = new Map();
  for (const j of board.jobs) {
    if (!groups.has(j.repository)) groups.set(j.repository, { name: j.repositoryName, jobs: [] });
    groups.get(j.repository).jobs.push(j);
  }
  if (!groups.size) return h("div", { class: "empty" }, "No jobs in the last two days.");
  const weight = (g) => g.jobs.filter((j) => j.status === "running" || j.status === "queued").length;
  return h(
    "div",
    { class: "page-stack" },
    [...groups.values()]
      .sort((a, b) => weight(b) - weight(a) || b.jobs.length - a.jobs.length)
      .map((g) => {
        const active = weight(g);
        return h(
          "section",
          { class: "space" },
          h("div", { class: "space-head" }, h("h2", {}, g.name), h("span", { class: "muted" }, `${active ? `${active} active, ` : ""}${g.jobs.length} in the last two days`)),
          h("div", { class: "grid" }, g.jobs.map((j) => jobCard(j, now))),
        );
      }),
  );
}

function boardPage() {
  if (!state.board) return h("main", { class: "page" }, h("p", { class: "muted" }, state.problem ?? "Loading the board."));
  const board = scoped(state.board);
  const now = Date.parse(board.generatedAt);
  const view = state.view === "timeline" ? timelineView(board, now) : state.view === "space" ? spaceView(board, now) : statusView(board, now);
  return h(
    "main",
    { class: "page" },
    h(
      "div",
      { class: "page-head" },
      h("h1", {}, spaceOf() ? `Board · ${spaceOf().name}` : "Board"),
      spaceOf() ? h("button", { class: "btn", type: "button", onclick: () => setSpace("") }, "Show all spaces") : null,
      h(
        "div",
        { class: "seg", role: "group", "aria-label": "Board view" },
        VIEWS.map(([id, label]) => h("button", { type: "button", "aria-pressed": String(state.view === id), onclick: () => setView(id) }, label)),
      ),
    ),
    state.problem ? h("div", { class: "banner" }, h("b", {}, "Not up to date. "), state.problem) : null,
    noticeBar(),
    board.paused ? h("div", { class: "banner row-banner" }, h("span", {}, h("b", {}, "The queues are held. "), "A credit or key failure stopped new engineering jobs."), h("button", { class: "btn", type: "button", onclick: () => void send("/resume") }, "Resume")) : null,
    board.spend.capReached ? h("div", { class: "banner row-banner" }, h("span", {}, h("b", {}, "Today's cap is reached. "), "New jobs wait until tomorrow."), h("button", { class: "btn", type: "button", onclick: () => void send("/resume") }, "Lift it for today")) : null,
    view,
  );
}

/* ---------- Job page ---------- */

const VERBS = { Bash: "Ran", Read: "Read", Edit: "Edited", Write: "Wrote", NotebookEdit: "Edited", Glob: "Looked for", Grep: "Searched", WebFetch: "Fetched", WebSearch: "Searched", Task: "Handed off", TodoWrite: "Planned" };
function verb(name) {
  if (VERBS[name]) return VERBS[name];
  return /^mcp__/.test(name ?? "") ? "Used" : name ?? "Step";
}
const toolText = (line) => {
  const m = /^mcp__.+__(.+)$/.exec(line.name ?? "");
  if (m) return m[1].replaceAll("_", " ");
  return line.text ?? (VERBS[line.name] ? "" : line.name ?? "");
};

function traceRows(detail, job, said) {
  const full = state.detail === "full";
  const lines = detail.trace.lines;
  const ended = lines.some((l) => l.ev === "end");
  // The step still in flight: the last tool call with nothing after it, on a job that is running.
  let liveIndex = -1;
  if (job.status === "running" && !ended) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].ev === "tool") { liveIndex = i; break; }
      if (lines[i].ev === "result" && !lines[i].sub) break;
    }
  }
  const rows = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    const sub = l.sub ? " sub" : "";
    if (l.ev === "say") {
      // The newest remark is already shown above the list, in the agent's own bubble.
      if (!l.text || l === said) continue;
      rows.push(h("li", { class: `t note${sub}` }, h("span", { class: "t-time num" }, clock(l.t)), h("span", { class: "t-verb" }, "Said"), h("span", { class: "t-text" }, l.text)));
    } else if (l.ev === "tool") {
      const live = i === liveIndex;
      rows.push(
        h("li", { class: `t${live ? " live" : ""}${sub}` }, h("span", { class: "t-time num" }, clock(l.t)), h("span", { class: "t-verb" }, live ? "Running" : verb(l.name)), h("span", { class: "t-text" }, toolText(l), live ? h("span", { class: "sr" }, " (in progress)") : null)),
      );
    } else if (l.ev === "result") {
      if (!l.error && !full) continue;
      if (!l.error && !l.text) continue;
      rows.push(h("li", { class: `t${l.error ? " bad" : ""}${sub}` }, h("span", { class: "t-time num" }, clock(l.t)), h("span", { class: "t-verb" }, l.error ? "Failed" : "Answer"), h("span", { class: "t-text" }, l.text ?? `${verb(l.name)} did not work`)));
    } else {
      rows.push(h("li", { class: "t note" }, h("span", { class: "t-time num" }, clock(l.t)), h("span", { class: "t-verb" }, l.ev === "start" ? "Started" : "Ended"), h("span", { class: "t-text" }, l.text ?? "")));
    }
  }
  return rows;
}

function stat(label, value, note, extra) {
  return h("div", { class: "stat" }, h("div", { class: "stat-label" }, label), h("div", { class: "stat-value num" }, value), extra ?? null, note ? h("div", { class: "stat-note" }, note) : null);
}

/** His own answer, which outranks everything else said about the job. */
function verdictButtons(detail) {
  const id = detail.job.id;
  const yours = detail.actions.yourVerdict;
  const busy = state.busy !== undefined;
  const mark = (met) => () => void act(`verdict:${id}`, `/jobs/${id}/action`, { action: "verdict", met });
  return h(
    "div",
    { class: "links" },
    h("button", { class: `btn${yours === true ? " chosen" : ""}`, type: "button", "aria-pressed": String(yours === true), disabled: busy, onclick: mark(true) }, icon("check", 14), "Yes, it did"),
    h("button", { class: `btn${yours === false ? " chosen" : ""}`, type: "button", "aria-pressed": String(yours === false), disabled: busy, onclick: mark(false) }, icon("cross", 14), "No, it did not"),
    yours !== undefined ? h("button", { class: "btn quiet", type: "button", disabled: busy, onclick: mark(null) }, "Clear my answer") : null,
  );
}

/** What Paul may do to this job from here. Each is the job runner's own operation. */
function jobActions(detail) {
  const a = detail.actions;
  const job = detail.job;
  if (!a) return null;
  const busy = state.busy !== undefined;
  const key = `job:${job.id}`;
  const out = [];
  if (a.cancel) out.push(h("button", { class: "btn", type: "button", disabled: busy, onclick: () => void act(key, `/jobs/${job.id}/action`, { action: "cancel" }) }, "Stop this job"));
  if (a.front) out.push(h("button", { class: "btn", type: "button", disabled: busy, onclick: () => void act(key, `/jobs/${job.id}/action`, { action: "front" }) }, "Move to the front"));
  if (a.retry) out.push(h("button", { class: "btn", type: "button", disabled: busy, onclick: () => { say("Asked for a retry. The answer is in the chat."); void send(`retry ${job.id}`); draw(); } }, "Try again"));
  if (a.rerunModels.length) {
    const chosen = a.rerunModels.includes(state.rerunModel) ? state.rerunModel : a.rerunModels[0];
    const select = h("select", { class: "pick", "aria-label": "Model to run it on", onchange: (e) => { state.rerunModel = e.target.value; } }, a.rerunModels.map((m) => {
      // Where enough jobs of this kind have finished on a model to say, what one usually costs there.
      const usual = (a.rerunUsual ?? []).find((u) => u.model === m);
      return h("option", { value: m, selected: m === chosen }, usual ? `${modelName(m)} · usually ${money(usual.usd)}` : modelName(m));
    }));
    out.push(
      h(
        "span",
        { class: "rerun" },
        select,
        h(
          "button",
          { class: "btn", type: "button", disabled: busy, onclick: () => void act(key, `/jobs/${job.id}/action`, { action: "rerun", model: select.value }, (d) => { if (d.jobId) location.hash = `#/job/${d.jobId}`; }) },
          job.status === "running" || job.status === "queued" ? "Stop and run on this model" : "Run again on this model",
        ),
      ),
    );
  }
  return out.length ? h("div", { class: "actions" }, out) : null;
}

/* ---------- A job's pull request: review and merge ---------- */

const pullKey = (repo, number) => `${repo}/${number}`;

/** Asks GitHub, through the service, for a pull request as it is now. */
async function loadPull(repo, number) {
  const key = pullKey(repo, number);
  const before = state.pull?.key === key ? state.pull : undefined;
  state.pull = { key, data: before?.data, open: before?.open ?? new Set(), loading: true, error: undefined };
  draw();
  let data;
  let error;
  try {
    const res = await fetch(`${API}/pulls/${encodeURIComponent(repo)}/${number}`, { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" });
    if (res.status === 401) return void location.assign(SIGN_IN);
    const body = await res.json().catch(() => ({}));
    if (res.ok) data = body;
    else error = body.error || `The service answered ${res.status}.`;
  } catch {
    error = "The service could not be reached.";
  }
  if (state.pull?.key !== key) return;
  state.pull = { key, data: data ?? state.pull.data, open: state.pull.open, loading: false, error };
  draw();
}

const CHECK_TAG = { passed: ["ok", "check"], failed: ["bad", "cross"], running: ["run"], skipped: [""] };

/** One file's changes, line by line. Text only: what GitHub sent is never treated as markup. */
function diffLines(patch) {
  return patch.split("\n").map((line) => {
    const kind = line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "";
    return h("span", { class: `dl ${kind}` }, line || " ");
  });
}

function pullFile(p, f) {
  const open = p.open.has(f.name);
  return h(
    "details",
    { class: "file", open, ontoggle: (e) => { const was = p.open.has(f.name); if (e.target.open) p.open.add(f.name); else p.open.delete(f.name); if (was !== e.target.open) draw(); } },
    h("summary", {}, h("span", { class: "file-name" }, f.name), f.status !== "modified" ? h("span", { class: "tag" }, f.status) : null, h("span", { class: "num add" }, `+${f.additions}`), h("span", { class: "num del" }, `-${f.deletions}`)),
    // Only an open file's lines are built, so a long pull request stays light.
    open ? (f.patch ? h("pre", { class: "diff", tabindex: "0" }, diffLines(f.patch)) : h("p", { class: "muted" }, "No text changes to show here (a binary file, or one too large).")) : null,
    open && f.cut ? h("p", { class: "muted" }, "Only the first part is shown. GitHub has the rest.") : null,
  );
}

/**
 * Asks the chief, in the pull request's own thread, to have its conflicts resolved. It is an ordinary
 * message in Paul's name, sent because he pressed the button: the chief decides how, and starts the job.
 */
async function askToResolve(v) {
  const text = `Pull request #${v.number} in ${v.repository} (${v.url}) conflicts with ${v.base} and cannot be merged. Please start an engineer job on the ${v.repo} repository to merge ${v.base} into its branch ${v.branch}, resolve the conflicts, run the build and the tests, and push to that same pull request. No new pull request, and do not merge it: I will merge it myself once it is clean.`;
  const key = `pull:${v.repo}:${v.number}`;
  const sent = await sendThread(text, key);
  say(sent ? `Asked ${CHIEF} to resolve the conflicts. The answer is in this pull request's thread.` : "That could not be sent just now.", !sent);
  if (sent && route().name !== "pull") location.hash = `#/pull/${v.repo}/${v.number}`;
  else draw();
}

/** One pull request of a managed repository. `wrote` is the repository as a worker mistyped it in its report. */
function pullPane({ repo, number, wrote }) {
  const p = state.pull?.key === pullKey(repo, number) ? state.pull : undefined;
  const busy = state.busy !== undefined;
  const head = (extra) => h("div", { class: "pane-head" }, h("h2", {}, "Pull request"), extra ?? null);
  const slip = wrote ? h("p", { class: "muted" }, `The report wrote its address as ${wrote}. This is #${number} in the repository the job works on.`) : null;
  if (!p) return h("section", { class: "pane", "aria-label": "Pull request" }, head(), slip, h("div", { class: "links" }, h("button", { class: "btn", type: "button", onclick: () => void loadPull(repo, number) }, "Review it here")));
  const v = p.data;
  if (!v) {
    return h(
      "section",
      { class: "pane", "aria-label": "Pull request" },
      head(),
      slip,
      p.loading ? h("p", { class: "muted" }, "Asking GitHub.") : h("div", { class: "banner bad", role: "status" }, p.error),
      p.loading ? null : h("div", { class: "links" }, h("button", { class: "btn", type: "button", onclick: () => void loadPull(repo, number) }, "Try again")),
    );
  }
  const stateTag = v.state === "merged" ? h("span", { class: "tag ok" }, icon("check", 12), "Merged") : v.state === "closed" ? h("span", { class: "tag bad" }, "Closed") : v.draft ? h("span", { class: "tag" }, "Draft") : h("span", { class: "tag run" }, "Open");
  const merge =
    v.state === "open"
      ? h(
          "div",
          { class: "block" },
          h(
            "div",
            { class: "links" },
            h("button", { class: "btn primary", type: "button", disabled: busy || p.loading || !!v.blocked, onclick: () => void act(`merge:${p.key}`, `/pulls/${encodeURIComponent(repo)}/${number}/merge`, { sha: v.head }, () => void loadPull(repo, number)) }, "Merge"),
            h("button", { class: "btn", type: "button", disabled: busy || p.loading, onclick: () => void loadPull(repo, number) }, p.loading ? "Looking" : "Look again"),
            h("a", { class: "btn", href: v.url, rel: "noopener noreferrer", target: "_blank" }, icon("link"), "On GitHub"),
          ),
          v.conflicts
            ? h(
                "div",
                { class: "links" },
                h("button", { class: "btn", type: "button", disabled: busy || state.thread?.sending, onclick: () => void askToResolve(v) }, `Ask ${CHIEF} to resolve the conflicts`),
              )
            : null,
          v.blocked ? h("p", { class: "prose" }, v.blocked) : h("p", { class: "prose muted" }, `Merges ${v.branch} into ${v.base} at commit ${v.head.slice(0, 7)}, the one shown here.${v.redeploys ? " Merging redeploys ClearOps once no job is running." : ""}`),
        )
      : null;
  return h(
    "section",
    { class: "pane pull", "aria-label": "Pull request" },
    head(stateTag),
    slip,
    h("div", { class: "block" }, h("p", { class: "pull-title" }, `#${v.number} ${v.title}`), h("p", { class: "muted" }, `${v.repository} · ${v.branch} into ${v.base} · by ${v.author} · ${v.commits} ${v.commits === 1 ? "commit" : "commits"}`)),
    p.error ? h("div", { class: "banner bad", role: "status" }, `Not up to date. ${p.error}`) : null,
    h(
      "div",
      { class: "block" },
      h("h3", {}, "Checks"),
      v.checks.length
        ? h("div", { class: "links" }, v.checks.map((c) => h("span", { class: `tag ${CHECK_TAG[c.state][0]}` }, CHECK_TAG[c.state][1] ? icon(CHECK_TAG[c.state][1], 12) : null, `${c.name}: ${c.state}`)))
        : h("p", { class: "muted" }, "No checks ran on this commit."),
    ),
    merge,
    // A description is usually Markdown, so it is shown as the service rendered it; without that, as the plain text it is.
    v.body ? h("div", { class: "block" }, h("h3", {}, "Description"), v.bodyHtml ? rendered(v.bodyHtml, "report pull-body") : h("p", { class: "prose pull-body" }, v.body)) : null,
    h(
      "div",
      { class: "block" },
      h("h3", {}, "Changes"),
      h("p", { class: "muted num" }, `${v.changedFiles} ${v.changedFiles === 1 ? "file" : "files"}, `, h("span", { class: "add" }, `+${v.additions}`), " ", h("span", { class: "del" }, `-${v.deletions}`), v.changedFiles > v.files.length ? `. The first ${v.files.length} are here.` : ""),
      v.files.map((f) => pullFile(p, f)),
    ),
  );
}

/* ---------- Spend: today's figure, where it went, and the settings Paul may change ---------- */

async function refreshSpend() {
  try {
    const text = await getJson("/spend");
    const changed = text !== state.spendRaw;
    state.spendRaw = text;
    state.spend = JSON.parse(text);
    return changed;
  } catch {
    return false;
  }
}

/** One setting, one request. `value` null puts the deploy's own setting back. */
const setSetting = (key, value) => act(`setting:${key}`, "/settings", { key, value }, () => { delete state.spendDraft[key]; void refreshSpend().then(draw); });

function capRow(c) {
  const busy = state.busy !== undefined;
  const draft = state.spendDraft[c.key];
  const box = h("input", { class: "pick money", type: "number", inputmode: "decimal", min: String(c.min), max: String(c.max), step: "0.5", id: `cap-${c.key}`, value: draft ?? (c.usd !== undefined ? String(c.usd) : ""), placeholder: "Off", oninput: (e) => { state.spendDraft[c.key] = e.target.value; } });
  const save = () => {
    const n = Number(box.value);
    if (!box.value.trim() || !Number.isFinite(n)) return void (say("Type an amount in dollars.", true), draw());
    void setSetting(c.key, n);
  };
  return h(
    "div",
    { class: "setting" },
    h("label", { class: "setting-name", for: `cap-${c.key}` }, c.name),
    h("div", { class: "links" }, h("span", { class: "muted" }, "$"), box, h("button", { class: "btn", type: "button", disabled: busy, onclick: save }, "Set"), c.changed ? h("button", { class: "btn quiet", type: "button", disabled: busy, onclick: () => void setSetting(c.key, null) }, "Back to the deploy's own") : null),
    h("p", { class: "muted" }, c.usd === undefined ? "Off: no cap of this kind is set." : c.changed ? "Changed from the app." : "The deploy's own setting."),
  );
}

function roleRow(r, choices) {
  const busy = state.busy !== undefined;
  // The choices are the aliases this deploy maps to a model. A role set to something else in the
  // deploy's own settings is shown as it is, and can be moved onto one of them.
  const known = choices.some((c) => c.model === r.model);
  const select = h(
    "select",
    { class: "pick", id: `role-${r.key}`, disabled: busy, onchange: (e) => void setSetting(r.key, e.target.value) },
    known ? null : h("option", { value: "", selected: true, disabled: true }, modelName(r.model)),
    choices.map((c) => h("option", { value: c.alias, selected: c.model === r.model }, `${modelName(c.model)} (${c.alias})`)),
  );
  return h(
    "div",
    { class: "setting" },
    h("label", { class: "setting-name", for: `role-${r.key}` }, r.name),
    h("div", { class: "links" }, select, r.changed ? h("button", { class: "btn quiet", type: "button", disabled: busy, onclick: () => void setSetting(r.key, null) }, "Back to the deploy's own") : null),
    r.changed ? h("p", { class: "muted" }, "Changed from the app.") : null,
  );
}

function spendGroup(title, groups) {
  return h(
    "div",
    { class: "block" },
    h("h3", {}, title),
    groups.length ? h("div", { class: "rows" }, groups.map((g) => h("div", { class: "row plain" }, h("div", { class: "row-main" }, h("div", { class: "card-title" }, g.name), h("div", { class: "card-sub" }, `${g.jobs} ${g.jobs === 1 ? "job" : "jobs"}`)), h("div", { class: "row-right" }, h("span", { class: "card-cost num" }, money(g.usd)))))) : h("p", { class: "muted" }, "Nothing with a figure of its own yet today."),
  );
}

function spendPage() {
  const page = state.spend;
  const back = h("div", { class: "job-head" }, h("a", { class: "btn", href: "#/" }, icon("back"), "Board"), h("div", { class: "job-id" }, h("div", { class: "job-title" }, h("h1", {}, "Spend"))));
  if (!page) return h("main", { class: "page" }, back, h("p", { class: "muted" }, "Loading."));
  const s = page.spend;
  const today = h(
    "section",
    { class: "pane", "aria-label": "Today" },
    h("h2", {}, "Today"),
    h("div", { class: "stats" }, stat("Spent", s.usd !== undefined ? money(s.usd) : h("small", {}, "No figure"), s.note), stat("Daily cap", s.capUsd !== undefined ? money(s.capUsd) : h("small", {}, "Off"), s.capReached ? "Reached. New jobs wait until tomorrow." : s.capLifted ? "Lifted for today." : undefined)),
    s.capReached ? h("div", { class: "links" }, h("button", { class: "btn", type: "button", onclick: () => void send("/resume") }, "Lift it for today")) : null,
  );
  const went = h(
    "section",
    { class: "pane", "aria-label": "Where it went" },
    h("h2", {}, "Where it went today"),
    h("p", { class: "muted" }, "What the provider charged, by who ran on which model. A job is counted on the day it finished, a little after it ends, once each of its calls has been priced. The chief's own replies are counted as they are priced."),
    h(
      "div",
      { class: "block" },
      h("h3", {}, "By agent and model"),
      page.byAgentModel.length
        ? h("div", { class: "rows" }, page.byAgentModel.map((r) => h("div", { class: "row plain" }, h("div", { class: "row-main" }, h("div", { class: "card-title" }, `${r.who} on ${modelName(r.model)}`), h("div", { class: "card-sub" }, `${r.calls} ${r.calls === 1 ? "call" : "calls"}`)), h("div", { class: "row-right" }, h("span", { class: "card-cost num" }, money(r.usd))))))
        : h("p", { class: "muted" }, "Nothing has been priced yet today."),
    ),
    spendGroup("By project", page.byProject),
    h(
      "div",
      { class: "block" },
      h("h3", {}, "The rest"),
      h("p", { class: "prose" }, page.unattributedUsd !== undefined ? `${money(page.unattributedUsd)} of today is not in the lines here yet: jobs still running, and calls the provider has not priced.` : "Today's total cannot be split further from what the store holds."),
      page.withoutFigure ? h("p", { class: "muted" }, `${page.withoutFigure} ${page.withoutFigure === 1 ? "job" : "jobs"} finished today with no figure of ${page.withoutFigure === 1 ? "its" : "their"} own.`) : null,
    ),
    page.jobs.length ? h("div", { class: "block" }, h("h3", {}, "Jobs, dearest first"), h("div", { class: "rows" }, page.jobs.map((j) => h("a", { class: "row", href: `#/job/${j.id}` }, avatar(j.kind, "sm"), h("div", { class: "row-main" }, h("div", { class: "card-title" }, j.title), h("div", { class: "card-sub" }, `${j.who} · ${j.repositoryName}`)), h("div", { class: "row-right" }, h("span", { class: "card-cost num" }, money(j.costUsd))))))) : null,
  );
  const caps = h("section", { class: "pane", "aria-label": "Caps" }, h("h2", {}, "Caps"), h("p", { class: "muted" }, "A change applies at once and stays until you change it back. A job already running keeps the cap it started with."), page.settings.caps.map(capRow));
  const models = h("section", { class: "pane", "aria-label": "Models" }, h("h2", {}, "Models"), h("p", { class: "muted" }, "Which model each role runs on. It applies to the next run. The assistant for mail and calendar always runs on Claude and is not here."), page.settings.roles.map((r) => roleRow(r, page.settings.choices)));
  // What a job usually costs, so a model can be chosen with the price in view. Placed above the models
  // themselves: it is what a change there would change.
  const usual = h(
    "section",
    { class: "pane", "aria-label": "What a job usually costs" },
    h("h2", {}, "What a job usually costs"),
    h("p", { class: "muted" }, "From the provider's own figures for jobs that finished: the middle of what each kind cost on each model, and the range most fell in. An estimate, so it needs at least three finished jobs of a kind on one model and follows the newest thirty."),
    (page.usual ?? []).length
      ? h("div", { class: "rows" }, page.usual.map((u) => h("div", { class: "row plain" }, h("div", { class: "row-main" }, h("div", { class: "card-title" }, `${u.who} on ${modelName(u.model)}`), h("div", { class: "card-sub" }, `${u.lowUsd !== u.highUsd ? `mostly ${money(u.lowUsd)} to ${money(u.highUsd)}, ` : ""}from ${u.jobs} jobs`)), h("div", { class: "row-right num" }, `about ${money(u.usd)}`))))
      : h("p", { class: "muted" }, "Not enough finished jobs with a real figure yet to say."),
  );
  return h("main", { class: "page" }, back, noticeBar(), today, went, usual, caps, models);
}

/* ---------- Files and voice notes that go with a message ---------- */

/* ---------- The slash-command menu ---------- */

/** The commands the service offers, asked for once, the first time a slash is typed. */
let commands;
let commandsAsked = false;
async function loadCommands() {
  if (commandsAsked) return;
  commandsAsked = true;
  try {
    const text = await getJson("/commands");
    commands = text ? JSON.parse(text).commands : [];
  } catch {
    commandsAsked = false;
  }
}

/**
 * A menu above one message box that opens when what is typed starts with a slash. Choosing a command
 * only fills the box: it is sent like anything else Paul types, when he sends it. Arrow keys move,
 * Enter or Tab chooses, Escape closes; on a phone a tap chooses.
 */
function commandMenu(textarea) {
  const id = `${textarea.id}-commands`;
  const list = h("div", { class: "cmd-menu", id, role: "listbox", "aria-label": "Commands", hidden: true });
  let shown = [];
  let at = 0;
  let closedFor;
  const filled = (c) => (c.needs ? `${c.command} ` : c.command);
  const close = () => {
    shown = [];
    list.hidden = true;
    textarea.setAttribute("aria-expanded", "false");
    textarea.removeAttribute("aria-activedescendant");
  };
  const pick = (c) => {
    textarea.value = filled(c);
    textarea.dispatchEvent(new Event("input"));
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  };
  const draw = () => {
    list.replaceChildren(
      ...shown.map((c, i) =>
        h(
          "div",
          // The box keeps the focus, so the keyboard stays up on a phone.
          { class: "cmd-item", id: `${id}-${i}`, role: "option", "aria-selected": i === at ? "true" : "false", onpointerdown: (e) => e.preventDefault(), onclick: () => pick(c) },
          h("span", { class: "cmd-name" }, c.command, c.needs || c.takes ? h("span", { class: "muted" }, ` ${c.needs ?? `[${c.takes}]`}`) : null),
          h("span", { class: "cmd-about" }, c.about),
        ),
      ),
    );
    list.hidden = false;
    textarea.setAttribute("aria-expanded", "true");
    textarea.setAttribute("aria-activedescendant", `${id}-${at}`);
    list.children[at]?.scrollIntoView({ block: "nearest" });
  };
  const update = () => {
    const typed = textarea.value;
    if (!typed.startsWith("/") || typed.includes("\n")) return close();
    // The list is asked for once. Whatever is in the box by the time it arrives is what the menu answers.
    if (!commands) return void loadCommands().then(() => commands && document.activeElement === textarea && update());
    const want = typed.toLowerCase();
    const next = commands.filter((c) => c.command.startsWith(want));
    // Nothing to offer, he closed it for exactly this text, or the one match is already what is in the box.
    if (!next.length || closedFor === typed || (next.length === 1 && filled(next[0]) === typed)) return close();
    closedFor = undefined;
    if (next.map((c) => c.command).join() !== shown.map((c) => c.command).join()) at = 0;
    shown = next;
    draw();
  };
  textarea.setAttribute("aria-controls", id);
  textarea.setAttribute("aria-expanded", "false");
  textarea.setAttribute("aria-autocomplete", "list");
  textarea.addEventListener("input", update);
  textarea.addEventListener("blur", close);
  textarea.addEventListener("focus", update);
  // Registered before the box's own Enter-to-send, so a choice is taken here first.
  textarea.addEventListener("keydown", (e) => {
    if (list.hidden || e.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      at = (at + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length;
      draw();
    } else if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      // A command already typed in full is sent by Enter as usual.
      if (e.key === "Enter" && filled(shown[at]) === textarea.value) return close();
      pick(shown[at]);
    } else if (e.key === "Escape") {
      closedFor = textarea.value;
      close();
    } else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  });
  return { el: list, close };
}

const fileSize = (n) => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** A file's bytes as base64, which is how the app's one message route takes them. */
const asBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(",") + 1));
    reader.onerror = () => reject(new Error(`${file.name} could not be read.`));
    reader.readAsDataURL(file);
  });

/**
 * What one message box needs to carry files: a paperclip, a microphone where the browser can record,
 * and a tray of what is waiting to go. Files are only held here until the message is sent; the service
 * saves them the way it saves a file sent in Discord.
 */
/**
 * A small picture of an image waiting in the tray, so the wrong screenshot is caught before it goes.
 * Drawn in the browser from the file itself and never sent: the service gets the file and nothing else.
 */
const thumbs = new WeakMap();
function thumbOf(file, redraw) {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || !window.createImageBitmap) return null;
  if (thumbs.has(file)) return thumbs.get(file);
  thumbs.set(file, null);
  createImageBitmap(file)
    .then((bitmap) => {
      const side = 64;
      const canvas = h("canvas", { class: "file-thumb", width: side, height: side, role: "img", "aria-label": `Preview of ${file.name}` });
      const scale = Math.max(side / bitmap.width, side / bitmap.height);
      const w = bitmap.width * scale;
      const hgt = bitmap.height * scale;
      canvas.getContext("2d").drawImage(bitmap, (side - w) / 2, (side - hgt) / 2, w, hgt);
      bitmap.close?.();
      thumbs.set(file, canvas);
      redraw();
    })
    .catch(() => undefined);
  return null;
}

/** A recording made here (the name `attachments` gives it), as against any other file. */
const VOICE_FILE = /^voice-note-\d{3,4}(?:-\d+)?\.(?:webm|m4a|ogg)$/;
/** How long each recording waiting in a tray runs, in seconds. */
const spokenFor = new WeakMap();
const minutes = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds) % 60).padStart(2, "0")}`;

function attachments(textarea) {
  const a = { files: [], note: undefined };
  const tray = h("div", { class: "files", role: "status" });
  const picker = h("input", { type: "file", multiple: true, class: "sr", tabindex: "-1", "aria-hidden": "true" });
  const draw = () => {
    tray.replaceChildren(
      ...a.files.map((f, i) => h("span", { class: "file-chip" }, thumbOf(f, () => a.files.includes(f) && draw()), VOICE_FILE.test(f.name) ? [icon("mic", 14), h("span", { class: "file-chip-name" }, "Voice note")] : h("span", { class: "file-chip-name" }, f.name), h("span", { class: "muted num" }, spokenFor.has(f) ? minutes(spokenFor.get(f)) : fileSize(f.size)), h("button", { type: "button", class: "file-chip-x", "aria-label": `Remove ${f.name}`, onclick: () => { a.files.splice(i, 1); a.note = undefined; draw(); } }, icon("cross", 12)))),
      ...(a.note ? [h("span", { class: "file-note" }, a.note)] : []),
    );
    tray.hidden = !a.files.length && !a.note;
  };
  a.add = (list) => {
    a.note = undefined;
    for (const f of list) {
      if (a.files.length >= FILES_MAX) { a.note = `At most ${FILES_MAX} files go with one message.`; break; }
      if (!f.size) { a.note = `${f.name} is empty.`; continue; }
      if (a.files.reduce((n, x) => n + x.size, 0) + f.size > FILES_BYTES) { a.note = `Together the files are too large. The most one message can carry is ${fileSize(FILES_BYTES)}.`; continue; }
      a.files.push(f);
    }
    draw();
  };
  a.clear = () => { a.files = []; a.note = undefined; draw(); };
  a.payload = () => Promise.all(a.files.map(async (f) => ({ name: f.name, type: f.type || undefined, data: await asBase64(f) })));
  picker.addEventListener("change", () => { a.add([...picker.files]); picker.value = ""; });
  // A screenshot pasted into the box goes with the message.
  textarea.addEventListener("paste", (e) => {
    const pasted = [...(e.clipboardData?.files ?? [])];
    if (!pasted.length) return;
    e.preventDefault();
    a.add(pasted.map((f, i) => (f.name && f.name !== "image.png" ? f : new File([f], `pasted-${clockFmt.format(new Date()).replace(":", "")}${pasted.length > 1 ? `-${i + 1}` : ""}.${(f.type.split("/")[1] || "png").replace("jpeg", "jpg")}`, { type: f.type }))));
  });
  const attach = h("button", { class: "tool", type: "button", "aria-label": "Attach files", onclick: () => picker.click() }, icon("clip", 18));
  // A voice note: tap to start, tap to stop. It waits in the tray like any file and goes when the message is sent.
  let recorder;
  const canRecord = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  const mic = h("button", { class: "tool", type: "button", "aria-label": "Record a voice note", "aria-pressed": "false" }, icon("mic", 18));
  mic.addEventListener("click", async () => {
    if (recorder) return void recorder.stop();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      a.note = "The microphone could not be used. Check the browser's permission for this site.";
      return void draw();
    }
    const parts = [];
    const began = Date.now();
    recorder = new MediaRecorder(stream);
    recorder.addEventListener("dataavailable", (e) => e.data.size && parts.push(e.data));
    recorder.addEventListener("stop", () => {
      for (const track of stream.getTracks()) track.stop();
      const type = (recorder.mimeType || "audio/webm").split(";")[0];
      recorder = undefined;
      mic.setAttribute("aria-pressed", "false");
      mic.classList.remove("on");
      mic.replaceChildren(icon("mic", 18));
      mic.setAttribute("aria-label", "Record a voice note");
      const blob = new Blob(parts, { type });
      const note = new File([blob], `voice-note-${clockFmt.format(new Date()).replace(":", "")}.${type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm"}`, { type });
      spokenFor.set(note, Math.max(1, (Date.now() - began) / 1000));
      a.add([note]);
    });
    recorder.start();
    mic.setAttribute("aria-pressed", "true");
    mic.classList.add("on");
    mic.replaceChildren(icon("stop", 18));
    mic.setAttribute("aria-label", "Stop recording");
  });
  a.tray = tray;
  a.tools = [picker, attach, canRecord ? mic : null];
  draw();
  return a;
}

/**
 * What the service said in one message: a picture a design job chose, when there is one, then its words.
 * The picture comes from the app's own route for the signed-in browser, and opens full size in a new tab.
 */
function said(m) {
  const src = m.picture ? `${API}/chat/picture/${encodeURIComponent(m.picture)}` : undefined;
  return [
    src ? h("a", { class: "pic", href: src, target: "_blank", rel: "noopener" }, h("img", { src, alt: m.caption || "A picture from a job", loading: "lazy", decoding: "async" })) : null,
    m.html ? rendered(m.html, "report said") : null,
    // A finished job's report: one tap from the message that announces it.
    // Only when there is one. A job that wrote none is named as that, with the way to run it again.
    m.report?.missing
      ? h("a", { class: "report-link none", href: `#/job/${m.report.job}` }, icon("doc", 18), h("span", { class: "report-link-main" }, h("b", {}, "No report was written"), h("span", { class: "muted" }, "Open the job to run it again")))
      : m.report
        ? h("a", { class: "report-link", href: `#/job/${m.report.job}/report` }, icon("doc", 18), h("span", { class: "report-link-main" }, h("b", {}, "Open the report"), h("span", { class: "muted" }, m.report.title)))
        : null,
  ];
}

/** The files a message of Paul's went with, under his words. */
const sentFiles = (names) => (names.length ? h("div", { class: "sent-files" }, names.map((n) => h("span", { class: "file-chip" }, icon("clip", 12), h("span", { class: "file-chip-name" }, n)))) : null);

/**
 * One of Paul's own messages. A voice note is shown as what the service heard, since that is what the
 * chief answers and a transcript can mishear: his words once it is transcribed, a line saying so while
 * it is being, and the plain file if it could not be. The recording itself is kept with his uploads.
 */
function mineBubble(m) {
  // What he said to Cleo, which she asked the chief for him: his words as they were heard.
  if (m.via === "cleo") return h("div", { class: "mine" }, h("div", { class: "bubble" }, h("div", { class: "voice" }, h("span", { class: "voice-tag" }, icon("wave", 14), `${CLEO} asked for you`), h("span", { class: "voice-said" }, m.text))));
  const files = m.files ?? [];
  const spoken = files.filter((n) => VOICE_FILE.test(n));
  const unheard = m.heard === "";
  // Only a note just sent is still being listened to; an older one with nothing heard is simply a recording.
  const listening = m.heard === undefined && spoken.length > 0 && Date.now() - Date.parse(m.at) < 120000;
  const voice =
    spoken.length || m.heard
      ? h(
          "div",
          { class: "voice" },
          h("span", { class: "voice-tag" }, icon("mic", 14), spoken.length ? "Voice note" : "As heard"),
          m.heard ? h("span", { class: "voice-said" }, m.heard) : listening ? h("span", { class: "voice-wait" }, "Listening to it") : unheard ? h("span", { class: "voice-wait" }, "Could not be transcribed") : null,
        )
      : null;
  return h("div", { class: "mine" }, h("div", { class: "bubble" }, m.text || null, voice, sentFiles(unheard ? files : files.filter((n) => !VOICE_FILE.test(n)))));
}

/* ---------- Threads: talking to the chief about one job or one pull request ---------- */

/** The thread the page being looked at belongs to: "job:<id>" or "pull:<alias>:<number>". */
function threadKeyOf(r) {
  return r.name === "job" ? `job:${r.id}` : r.name === "pull" ? `pull:${r.repo}:${r.number}` : undefined;
}

const threadInput = h("textarea", { id: "ask-thread", rows: "1", maxlength: String(TEXT_MAX), autocomplete: "off" });
const threadSend = h("button", { class: "send", type: "submit", "aria-label": "Send" }, icon("send", 18));
const threadFiles = attachments(threadInput);
const threadMenu = commandMenu(threadInput);
const threadLog = h("div", { class: "thread-log", role: "log", tabindex: "0" });
const threadEl = h(
  "section",
  { class: "pane thread", "aria-label": `Talk to ${CHIEF} about this` },
  h("div", { class: "pane-head" }, h("h2", {}, `Talk to ${CHIEF} about this`)),
  threadLog,
  threadMenu.el,
  threadFiles.tray,
  h(
    "form",
    { class: "composer", onsubmit: (e) => { e.preventDefault(); void sendThread(threadInput.value); } },
    h("label", { class: "sr", for: "ask-thread" }, `Message ${CHIEF} about this`),
    threadFiles.tools,
    threadInput,
    threadSend,
  ),
);
threadInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !narrow.matches) {
    e.preventDefault();
    void sendThread(threadInput.value);
  }
});

function threadItems() {
  const t = state.thread;
  if (!t?.view) return [h("p", { class: "muted" }, t?.problem ?? "Loading.")];
  const now = Date.parse(t.view.generatedAt);
  const stream = [...t.view.messages.filter((m) => !m.live).map((m) => ({ at: m.at, message: m })), ...t.view.jobs.map((j) => ({ at: j.createdAt, job: j }))].sort((a, b) => a.at.localeCompare(b.at));
  const out = [];
  for (const item of stream) {
    if (item.job) out.push(h("div", { class: "chat-card" }, jobCard(item.job, now)));
    else if (item.message.from === "paul") out.push(mineBubble(item.message));
    else out.push(h("div", { class: "theirs" }, avatar("chief"), h("div", { class: "theirs-body" }, h("div", { class: "theirs-who" }, h("b", {}, CHIEF), h("span", { class: "muted num" }, clock(item.message.at))), said(item.message))));
  }
  if (!stream.length) out.push(h("p", { class: "muted" }, `Nothing said here yet. What you write goes to ${CHIEF} with this attached, so there is no need to say what it is about.`));
  const live = t.view.messages.find((m) => m.live);
  const unanswered = t.view.messages.filter((m) => !m.live).at(-1)?.from === "paul";
  if (live || t.view.typing || unanswered) out.push(h("div", { class: "working", role: "status" }, avatar("chief", "busy"), h("span", {}, live ? live.text : `${CHIEF} is working on it`)));
  if (t.problem) out.push(h("div", { class: "banner" }, h("b", {}, "Not sent or not up to date. "), t.problem));
  return out;
}

function drawThread() {
  const stick = threadLog.scrollHeight - threadLog.scrollTop - threadLog.clientHeight < 120;
  threadLog.replaceChildren(...threadItems());
  if (stick) threadLog.scrollTop = threadLog.scrollHeight;
}

async function refreshThread() {
  const key = threadKeyOf(route());
  if (!key) return false;
  if (state.thread?.key !== key) {
    state.thread = { key, view: undefined, raw: "", problem: undefined, sending: false };
    threadInput.value = "";
    threadFiles.clear();
  }
  const t = state.thread;
  try {
    const text = await getJson(`/chat?thread=${encodeURIComponent(key)}`);
    if (state.thread !== t) return false;
    if (text === undefined) {
      t.problem = "This has no thread.";
      return true;
    }
    const changed = text !== t.raw || !!t.problem;
    t.raw = text;
    t.view = JSON.parse(text);
    if (!t.sending) t.problem = undefined;
    return changed;
  } catch (err) {
    if (err.message === "signed out" || state.thread !== t) return false;
    if (!t.view) t.problem = "The thread could not be loaded just now.";
    return !t.view;
  }
}

/** A message into this page's thread. The service attaches the topic; the words are only Paul's. */
async function sendThread(raw, key = threadKeyOf(route())) {
  const text = raw.trim();
  // Files in the tray go with what Paul typed in the box, never with a message a button wrote for him.
  const typed = raw === threadInput.value && key === threadKeyOf(route());
  const files = typed ? threadFiles.files.length : 0;
  if ((!text && !files) || !key) return false;
  if (state.thread?.key !== key) state.thread = { key, view: undefined, raw: "", problem: undefined, sending: false };
  const t = state.thread;
  if (t.sending) return false;
  t.sending = true;
  threadSend.disabled = true;
  let ok = false;
  try {
    await postMessage({ text, thread: key, ...(files ? { files: await threadFiles.payload() } : {}) });
    if (typed) {
      threadInput.value = "";
      threadFiles.clear();
    }
    t.problem = undefined;
    ok = true;
  } catch (err) {
    t.problem = err.message === "Failed to fetch" ? "The service could not be reached." : err.message;
    drawThread();
  } finally {
    t.sending = false;
    threadSend.disabled = false;
  }
  void threadTick();
  return ok;
}

function threadBusy() {
  const v = state.thread?.view;
  if (!v) return false;
  const last = v.messages[v.messages.length - 1];
  return v.typing || v.messages.some((m) => m.live) || (last && last.from === "paul") || v.jobs.some((j) => j.status === "running" || j.status === "queued");
}

let threadTimer;
async function threadTick() {
  clearTimeout(threadTimer);
  if (!threadKeyOf(route())) return;
  if (!document.hidden && (await refreshThread())) drawThread();
  threadTimer = setTimeout(threadTick, threadBusy() ? CHAT_BUSY_EVERY_MS : CHAT_QUIET_EVERY_MS);
}

/** The thread pane for the page being drawn. One element, kept across redraws, so what is being typed stays. */
function threadPane() {
  threadInput.setAttribute("placeholder", `Ask ${CHIEF} about this`);
  drawThread();
  return threadEl;
}

/** A pull request on a page of its own, opened from the board's list. */
function pullPage(r) {
  return h(
    "main",
    { class: "page" },
    h("div", { class: "job-head" }, h("a", { class: "btn", href: "#/" }, icon("back"), "Board")),
    noticeBar(),
    pullPane({ repo: r.repo, number: r.number }),
    threadPane(),
  );
}

function pullCard(pr, now) {
  return h(
    "a",
    { class: "card", href: `#/pull/${pr.repo}/${pr.number}` },
    h("div", { class: "card-main" }, h("div", { class: "card-title" }, `#${pr.number} ${pr.title}`), h("div", { class: "card-sub" }, [pr.repository, pr.branch, `by ${pr.author}`].filter(Boolean).join(" · "))),
    h("div", { class: "card-line" }, h("span", {}, `${pr.draft ? "Draft. " : ""}Opened ${ago(pr.openedAt, now)}. Tap to review.`)),
    threadNote(pr.thread, now),
  );
}

/** Every open pull request in the managed repositories, as GitHub lists them: not through any job. */
function pullsColumn(board, now, limit) {
  const all = board.pulls ?? [];
  const shown = limit ? all.slice(0, limit) : all;
  const unread = board.pullsUnread?.length ? h("div", { class: "more" }, `GitHub would not show: ${board.pullsUnread.join(", ")}.`) : null;
  const more = all.length > shown.length ? h("div", { class: "more" }, `${all.length - shown.length} more on the board.`) : null;
  return column("run", "Open pull requests", shown.map((pr) => pullCard(pr, now)), board.pullsLoading ? "Asking GitHub." : "None are open.", { hidden: all.length - shown.length, node: unread || more ? h("div", {}, more, unread) : null });
}

function jobPage() {
  if (state.jobMissing) return h("main", { class: "page" }, h("a", { class: "btn", href: "#/" }, icon("back"), "Board"), h("p", { class: "muted" }, "There is no job with that id."));
  const detail = state.job;
  if (!detail) return h("main", { class: "page" }, h("a", { class: "btn", href: "#/" }, icon("back"), "Board"), h("p", { class: "muted" }, state.problem ?? "Loading the job."));
  const job = detail.job;
  const now = Date.parse(detail.generatedAt);
  const f = detail.trace.figures;

  // Cost: the provider's own figure or nothing, with the job's cap where one is set.
  const cap = detail.limits.budgetUsd;
  let cost;
  if (job.costUsd !== undefined) {
    const fill = h("i");
    if (cap) fill.style.width = `${Math.min(100, Math.round((job.costUsd / cap) * 100))}%`;
    cost = stat("Cost", [money(job.costUsd), cap ? h("small", {}, ` of ${money(cap)} job cap`) : null], "The provider's own figure.", cap ? h("div", { class: "meter thin", "aria-hidden": "true" }, fill) : null);
  } else {
    cost = stat("Cost", h("small", {}, job.usual ? "No figure yet" : "No real figure"), job.usual ? usualWords(job.usual) : job.status === "running" ? "A job's cost is recorded when it finishes." : "The store holds no provider figure for this job.");
  }
  const model = stat("Model", modelName(job.model) ?? h("small", {}, "Not recorded"), job.modelPinned ? "Pinned for this job." : job.model ? "This role's current model." : "Only pinned and live jobs say which.");
  const steps = stat("Steps", [String(f.steps), h("small", {}, ` · limit ${detail.limits.maxTurns} turns`)], f.errors ? `${f.errors} of them failed.` : detail.trace.total ? "None failed." : "No trace is saved for this job.");
  const started = job.startedAt ?? job.createdAt;
  const time =
    job.status === "running"
      ? stat("Running for", span(now - Date.parse(started)), job.lastActivityAt ? `Last did something ${ago(job.lastActivityAt, now)}.` : undefined)
      : job.status === "queued"
        ? stat("Waiting for", span(now - Date.parse(job.createdAt)), job.waitingBehind ? `Behind ${job.waitingBehind.title}.` : job.held ? "Held." : undefined)
        : stat("Took", job.startedAt && job.finishedAt ? span(Date.parse(job.finishedAt) - Date.parse(job.startedAt)) : h("small", {}, "Not recorded"), job.finishedAt ? `Finished ${ago(job.finishedAt, now)}, at ${clock(job.finishedAt)}.` : undefined);

  const about = h(
    "section",
    { class: "pane side", "aria-label": "About this job" },
    h("h2", {}, "About"),
    job.outcome
      ? h(
          "div",
          { class: "block" },
          h("h3", {}, "Did it do what you asked?"),
          h("p", { class: "prose" }, job.outcome.text),
          job.said ? h("p", { class: "prose muted" }, `It told you: ${job.said}`) : null,
          detail.actions?.verdict ? verdictButtons(detail) : null,
        )
      : null,
    h("div", { class: "block" }, h("p", { class: "prose" }, detail.description ?? "This job's brief is empty or unreadable."), detail.more ? h("p", { class: "prose muted" }, detail.more) : null),
    detail.doneWhen ? h("div", { class: "block" }, h("h3", {}, "Done when"), h("p", { class: "prose" }, detail.doneWhen)) : null,
    detail.produced ? h("div", { class: "block" }, h("h3", {}, "Produced"), h("p", { class: "prose" }, detail.produced)) : null,
    detail.links.length ? h("div", { class: "block" }, h("h3", {}, "Links"), h("div", { class: "links" }, detail.links.map((l) => h("a", { class: "btn", href: l.url, rel: "noopener noreferrer", target: "_blank" }, icon("link"), `Open the ${l.what}`)))) : null,
    detail.related.length
      ? h("div", { class: "block" }, h("h3", {}, "Related"), detail.related.map((r) => h("a", { class: "rel", href: `#/job/${r.id}` }, avatar(r.kind, "sm"), h("span", {}, `${r.relation === "reviews" ? "Reviews" : "Reviewed by"}: ${r.title}`))))
      : null,
    h("div", { class: "block" }, h("h3", {}, "Id"), h("div", { class: "cmd" }, job.id)),
  );

  const said = [...detail.trace.lines].reverse().find((l) => l.ev === "say" && l.text && !l.sub);
  const rows = traceRows(detail, job, said);
  const trace = h(
    "section",
    { class: "pane main", "aria-label": "Trace" },
    h(
      "div",
      { class: "pane-head" },
      h("h2", {}, job.status === "running" ? "Live trace" : "Trace"),
      h(
        "div",
        { class: "seg", role: "group", "aria-label": "Trace detail" },
        h("button", { type: "button", "aria-pressed": String(state.detail === "plain"), onclick: () => setDetail("plain") }, "Steps"),
        h("button", { type: "button", "aria-pressed": String(state.detail === "full"), onclick: () => setDetail("full") }, "Steps and answers"),
      ),
    ),
    said ? h("div", { class: "say" }, avatar(job.kind, "sm"), h("p", {}, said.text)) : null,
    rows.length ? h("ol", { class: "trace", "aria-label": "Steps, newest first" }, rows) : h("div", { class: "empty" }, "No trace is saved for this job. Traces started on 17 November 2026 and are kept for 14 days."),
    detail.trace.total > detail.trace.lines.length ? h("p", { class: "muted" }, `Showing the newest ${detail.trace.lines.length} of ${detail.trace.total} lines.`) : null,
  );

  // The report is what a finished job is for, so it sits directly under the figures, not below the
  // thread and a long trace where a phone hid it (20 Nov 2026). It starts short, so the rest of the page
  // stays within reach, and opens in full on a tap or when the link in the chat brought him here.
  let output = null;
  if (detail.noReport) {
    // Recorded as done, but nothing was written: said plainly where the report would be.
    output = h("section", { class: "pane report-pane open", id: "report", "aria-label": "Report" }, h("h2", {}, "No report"), h("p", { class: "prose" }, detail.noReport));
  } else if (detail.outputHtml !== undefined) {
    const open = state.reportOpen === job.id;
    output = h(
      "section",
      { class: `pane report-pane${open ? " open" : ""}`, id: "report", "aria-label": "Report" },
      h("div", { class: "pane-head" }, h("h2", {}, "Report"), h("button", { class: "btn quiet", type: "button", "aria-expanded": String(open), onclick: () => { state.reportOpen = open ? undefined : job.id; draw(); } }, open ? "Show less" : "Read it all")),
      // Made from a file he uploaded: it is his to read here, and it is said that it goes nowhere else.
      detail.outputPrivate === "upload" ? h("p", { class: "muted report-private" }, "Made from a file you uploaded, so it is shown only here in the app: it has no report link and is not copied to the outputs repository.") : null,
      h("div", { class: "report-body" }, rendered(detail.outputHtml, "report")),
    );
  }

  return h(
    "main",
    { class: "page" },
    h(
      "div",
      { class: "job-head" },
      h("a", { class: "btn", href: "#/" }, icon("back"), "Board"),
      avatar(job.kind, "lg"),
      h("div", { class: "job-id" }, h("div", { class: "job-title" }, h("h1", {}, job.title), statusTag(job)), h("div", { class: "muted" }, [who(job), job.repositoryName, job.fixRound ? `fix round ${job.fixRound}` : null, job.failure].filter(Boolean).join(" · "))),
    ),
    state.problem ? h("div", { class: "banner" }, h("b", {}, "Not up to date. "), state.problem) : null,
    noticeBar(),
    jobActions(detail),
    h("div", { class: "stats" }, cost, model, steps, time),
    // Above the trace, not below it: a long trace on a phone hid it (19 Nov 2026).
    detail.pull ? pullPane(detail.pull) : null,
    output,
    threadPane(),
    h("div", { class: "panes" }, about, trace),
  );
}

/* ---------- Chat ---------- */

/** The board beside the chat: the same jobs, stacked, with the newest few finished. */
function besideBoard() {
  if (!state.board) return [h("p", { class: "muted" }, state.problem ?? "Loading the board.")];
  const board = scoped(state.board);
  const now = Date.parse(board.generatedAt);
  const by = (which) => board.jobs.filter((j) => pile(j) === which);
  const few = (jobs) => ({ cards: jobs.slice(0, DONE_SHOWN_BESIDE).map((j) => jobCard(j, now)), extra: { hidden: Math.max(0, jobs.length - DONE_SHOWN_BESIDE), node: null } });
  const met = few(by("met"));
  const open = few(by("unconfirmed"));
  const not = few(by("not_met"));
  return [
    h("div", { class: "page-head" }, h("h2", { class: "pane-title" }, spaceOf() ? `Board · ${spaceOf().name}` : "Board"), h("button", { class: "btn", type: "button", onclick: () => setLayout("board") }, "Open the board")),
    noticeBar(),
    board.paused ? h("div", { class: "banner row-banner" }, h("span", {}, h("b", {}, "The queues are held.")), h("button", { class: "btn", type: "button", onclick: () => void send("/resume") }, "Resume")) : null,
    board.spend.capReached ? h("div", { class: "banner row-banner" }, h("span", {}, h("b", {}, "Today's cap is reached.")), h("button", { class: "btn", type: "button", onclick: () => void send("/resume") }, "Lift it for today")) : null,
    column("wait", "Waiting on me", [...board.waiting.map((w) => waitingCard(w, now)), ...by("waiting").map((j) => jobCard(j, now))], "Nothing needs you."),
    pullsColumn(board, now, DONE_SHOWN_BESIDE),
    column("run", "Running", by("running").map((j) => jobCard(j, now)), "Nobody is working right now."),
    column("", "Queued", by("queued").map((j) => jobCard(j, now)), "The queue is empty."),
    column("ok", "Confirmed done", met.cards, "Nothing is confirmed as done.", met.extra),
    open.cards.length ? column("", "Finished, not confirmed", open.cards, "", open.extra) : null,
    not.cards.length ? column("bad", "Did not get there", not.cards, "", not.extra) : null,
  ];
}

function chatItems() {
  const chat = state.chat;
  if (!chat) return [h("p", { class: "muted" }, state.chatProblem ?? "Loading the conversation.")];
  const now = Date.parse(chat.generatedAt);
  const stream = [
    ...chat.messages.filter((m) => !m.live).map((m) => ({ at: m.at, message: m })),
    ...chat.jobs.map((j) => ({ at: j.createdAt, job: j })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const out = [];
  let lastDay;
  let lastFrom;
  for (const item of stream) {
    const day = dayKey(item.at);
    if (day !== lastDay) {
      const today = dayKey(new Date(now).toISOString());
      out.push(h("div", { class: "chat-day" }, day === today ? "Today" : dayFmt.format(new Date(item.at))));
      lastDay = day;
      lastFrom = undefined;
    }
    if (item.job) {
      out.push(h("div", { class: "chat-card" }, jobCard(item.job, now)));
      lastFrom = "job";
    } else if (item.message.from === "paul") {
      out.push(mineBubble(item.message));
      lastFrom = "paul";
    } else {
      const first = lastFrom !== "clearops";
      out.push(
        h(
          "div",
          { class: `theirs${first ? "" : " cont"}` },
          first ? avatar("chief") : h("span", { class: "av-gap", "aria-hidden": "true" }),
          h("div", { class: "theirs-body" }, first ? h("div", { class: "theirs-who" }, h("b", {}, CHIEF), h("span", { class: "muted num" }, clock(item.message.at))) : null, said(item.message)),
        ),
      );
      lastFrom = "clearops";
    }
  }
  if (!stream.length) out.push(h("div", { class: "chat-empty" }, avatar("chief", "lg"), h("p", {}, spaceChat() ? (spaceOf()?.own ? `The chat for ${spaceOf().name}, a space of your own. ${CHIEF} knows which space this is and what you put in it, and starts fresh: your other chats are not carried over.` : `The chat for ${spaceOf()?.name ?? "this space"}. ${CHIEF} knows what is said here is about that repository, and starts fresh: your other chats are not carried over.`) : state.own ? `A chat of its own. ${CHIEF} starts fresh here: what you said in your other chats is not carried over.` : `Ask ${CHIEF} for anything. Jobs it starts appear here as cards you can open.`)));
  // Whatever is waiting for his decision sits at the foot of the conversation, with the same buttons as
  // on the board, wherever it was first put to him.
  // In the main conversation only: a chat of his own stays on its subject, and the header still says something waits.
  const waiting = state.own || spaceChat() ? [] : state.board?.waiting ?? [];
  if (waiting.length) {
    out.push(h("div", { class: "chat-day wait" }, waiting.length === 1 ? "Waiting on you" : `${waiting.length} things waiting on you`));
    for (const item of waiting) out.push(h("div", { class: "chat-card" }, waitingCard(item, now)));
  }
  // A decision that went through is said by the service in the conversation itself; one that did not is said here.
  if (state.notice?.bad) out.push(h("div", { class: "chat-card" }, noticeBar()));
  const live = chat.messages.find((m) => m.live);
  // His message is in and nothing has come back yet: say so, whether or not the service has signalled it.
  const unanswered = chat.messages.filter((m) => !m.live).at(-1)?.from === "paul";
  if (live || chat.typing || unanswered) out.push(h("div", { class: "working", role: "status" }, avatar("chief", "busy"), h("span", {}, live ? live.text : `${CHIEF} is working on it`)));
  if (state.chatProblem) out.push(h("div", { class: "banner" }, h("b", {}, "Not sent or not up to date. "), state.chatProblem));
  return out;
}

/* ---------- Chats: the main conversation, and others of Paul's own beside it ---------- */

const chatBarEl = h("div", { class: "chat-bar" });

/**
 * When each conversation was last looked at, kept in this browser only. A conversation the service has
 * spoken in since then is marked as having something new. The first sight of one counts as looked at.
 */
const seen = (() => {
  try {
    const kept = JSON.parse(store("clearops.seen") ?? "{}");
    return kept && typeof kept === "object" ? kept : {};
  } catch {
    return {};
  }
})();
const saidAtOf = (own) => (own ? state.chats.find((c) => c.id === own)?.saidAt : state.mainSaidAt);
function keepSeen(key, at) {
  seen[key] = at;
  // Chats that are gone are forgotten here too. A space's chat is kept under "space:<id>".
  for (const k of Object.keys(seen)) if (k !== "main" && !k.startsWith("space:") && !state.chats.some((c) => c.id === k)) delete seen[k];
  store("clearops.seen", JSON.stringify(seen));
}
/** The conversation on screen, as it is kept here: "main", a chat's id, "new", or "space:<id>". */
const seenKey = () => (spaceChat() ? `space:${spaceChat()}` : state.own || "main");
function hasNewAt(key, at) {
  if (!at || key === seenKey()) return false;
  if (!seen[key]) keepSeen(key, at);
  return at > seen[key];
}
const hasNew = (own) => hasNewAt(own || "main", saidAtOf(own));
/** The conversation on screen has been looked at up to what the service last said in it. */
function lookedAt() {
  const key = seenKey();
  if (key === "new" || document.hidden) return;
  // A space's chat is read off the conversation itself: the board's word of it can be a few seconds behind.
  const at = spaceChat() ? [...(state.chat?.messages ?? [])].reverse().find((m) => m.from === "clearops" && !m.live)?.at : saidAtOf(state.own);
  if (at && !(seen[key] >= at)) keepSeen(key, at);
}

/** Renames or removes the chat being shown: his own tap, sent as this site's own JSON like every other change. */
async function manageChat(action, title) {
  const id = state.own;
  state.chatBusy = true;
  drawChatBar();
  try {
    const res = await postJson("/chats", { id, action, ...(action === "rename" ? { title } : {}) });
    if (!res.ok) throw new Error(typeof res.data.error === "string" ? res.data.error : "That did not work.");
    const said = res.data;
    state.chatEdit = undefined;
    state.chatSaid = undefined;
    if (action === "rename") state.chats = state.chats.map((c) => (c.id === id ? { ...c, title: said.title ?? c.title } : c));
    else {
      state.chats = state.chats.filter((c) => c.id !== id);
      state.chatBusy = false;
      return showChat("");
    }
  } catch (err) {
    state.chatSaid = err instanceof Error ? err.message : "That did not work.";
  }
  state.chatBusy = false;
  drawChatBar();
}

/** What can be done to the chat being shown, under the list: nothing for Main, which is always there. */
function chatManage() {
  const mine = state.chats.find((c) => c.id === state.own);
  if (!mine) return null;
  const set = (edit) => () => {
    state.chatEdit = edit;
    state.chatSaid = undefined;
    drawChatBar();
    if (edit === "rename") chatBarEl.querySelector(".chat-name")?.select();
  };
  if (state.chatEdit === "rename") {
    const name = h("input", { class: "chat-name pick", type: "text", value: mine.title, maxlength: "48", "aria-label": "Name of this chat", autocomplete: "off" });
    const save = () => name.value.trim() && void manageChat("rename", name.value);
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") save();
      if (e.key === "Escape") set(undefined)();
    });
    return h("div", { class: "chat-manage" }, name, h("button", { class: "btn primary", type: "button", disabled: state.chatBusy, onclick: save }, "Save"), h("button", { class: "btn quiet", type: "button", onclick: set(undefined) }, "Cancel"), state.chatSaid ? h("p", { class: "file-note" }, state.chatSaid) : null);
  }
  if (state.chatEdit === "delete") {
    // Removing a chat cannot be undone, so it takes a second, deliberate tap.
    return h("div", { class: "chat-manage" }, h("p", { class: "chat-manage-ask" }, `Delete "${mine.title}"? Its messages go for good. Jobs started in it are kept.`), h("button", { class: "btn danger", type: "button", disabled: state.chatBusy, onclick: () => void manageChat("delete") }, "Delete it"), h("button", { class: "btn quiet", type: "button", onclick: set(undefined) }, "Keep it"), state.chatSaid ? h("p", { class: "file-note" }, state.chatSaid) : null);
  }
  return h("div", { class: "chat-manage" }, h("span", { class: "muted chat-manage-label" }, "This chat"), h("button", { class: "btn quiet", type: "button", onclick: set("rename") }, "Rename"), h("button", { class: "btn quiet", type: "button", onclick: set("delete") }, "Delete"));
}
/** What the feed underneath is called: the space's chat, one of his own, or the main one. */
const feedTitle = () => (spaceChat() ? spaceOf()?.name ?? "This space" : ownTitle());
const ownTitle = () => (state.own === "new" ? "New chat" : state.own ? state.chats.find((c) => c.id === state.own)?.title ?? "Chat" : "Main");

/** Shows another conversation. Each is its own with the chief: what is said in one is not carried into another. */
function showChat(own) {
  state.cleoOpen = false;
  state.chatsOpen = false;
  state.chatEdit = undefined;
  state.chatSaid = undefined;
  if (own !== state.own) {
    state.own = own;
    store("clearops.chat", own === "new" ? "" : own);
    state.chat = own === "new" ? { generatedAt: new Date().toISOString(), messages: [], jobs: [], typing: false } : undefined;
    state.chatRaw = "";
    state.chatProblem = undefined;
    stickNext = true;
  }
  drawChat();
  if (own !== "new") void chatTick();
  if (!narrow.matches) input.focus();
}

function drawChatBar(now = Date.now(), fromRefresh = false) {
  // A routine refresh leaves the bar alone while a chat is being renamed or its deletion confirmed:
  // rebuilding it would wipe what he is typing or move a button from under his finger.
  if (fromRefresh && state.chatEdit && chatBarEl.querySelector(".chat-manage")) return;
  const row = (own, title, note) =>
    h(
      "button",
      { class: "chat-row", type: "button", role: "option", "aria-selected": own === state.own ? "true" : "false", onclick: () => showChat(own) },
      h("span", { class: "chat-row-title" }, hasNew(own) ? h("span", { class: "new-dot", role: "img", "aria-label": "Something new" }) : null, title),
      note ? h("span", { class: "muted num" }, note) : null,
    );
  // Her conversation is hers: its name, and the way back to the feed it was opened from.
  if (state.cleoOpen) return void chatBarEl.replaceChildren(...[h("div", { class: "chat-bar-top" }, h("div", { class: "chat-space" }, h("b", {}, CLEO), h("span", { class: "muted" }, `· spoken with you, apart from ${CHIEF}'s feeds`)), h("button", { class: "btn quiet chat-new cleo-back", type: "button", onclick: () => showCleo(false) }, icon("back", 16), h("span", {}, `${CHIEF}'s feed: ${feedTitle()}`)))]);
  // A space has one chat: its name, and no list to choose from.
  if (spaceChat()) return void chatBarEl.replaceChildren(...[h("div", { class: "chat-bar-top" }, h("div", { class: "chat-space" }, h("b", {}, spaceOf()?.name ?? "This space"), h("span", { class: "muted" }, `· this space's chat with ${CHIEF}`)), h("a", { class: "btn quiet chat-new space-more", href: `#/space/${spaceChat()}`, "aria-label": "Notes and library" }, icon("doc", 16), h("span", { "aria-hidden": "true" }, "Notes and library")))]);
  // replaceChildren writes anything that is not an element as text, the word "null" included, so the
  // list is left out when it is closed rather than passed as nothing.
  chatBarEl.replaceChildren(
    ...[
    h(
      "div",
      { class: "chat-bar-top" },
      h(
        "button",
        { class: "chat-pick", type: "button", "aria-haspopup": "listbox", "aria-expanded": state.chatsOpen ? "true" : "false", "aria-label": `Chat: ${ownTitle()}. Choose another`, onclick: () => { state.chatsOpen = !state.chatsOpen; state.chatEdit = undefined; drawChatBar(); } },
        h("span", { class: "chat-pick-title" }, ownTitle()),
        // Something new in a conversation that is not the one on screen.
        ["", ...state.chats.map((c) => c.id)].some(hasNew) ? h("span", { class: "new-dot", role: "img", "aria-label": "Something new in another chat" }) : null,
        icon("down", 16),
      ),
      h("button", { class: "btn quiet chat-new", type: "button", disabled: state.own === "new", onclick: () => showChat("new") }, icon("plus", 16), h("span", {}, "New chat")),
    ),
    state.chatsOpen
      ? h(
          "div",
          { class: "chat-list", role: "listbox", "aria-label": "Chats" },
          row("", "Main", "where jobs and decisions are reported"),
          state.chats.map((c) => row(c.id, c.title, `${c.count} ${c.count === 1 ? "message" : "messages"} · ${ago(c.lastAt, now)}`)),
          state.chats.length ? null : h("p", { class: "muted chat-list-note" }, `No other chats yet. New chat starts one, and ${CHIEF} keeps each apart.`),
          chatManage(),
        )
      : null,
    ].filter(Boolean),
  );
}

const input = h("textarea", { id: "ask", rows: "1", maxlength: String(TEXT_MAX), autocomplete: "off" });
// One line of prompt, whatever the width: a phone's box has no room for the long one beside the two buttons.
const tight = window.matchMedia("(max-width: 640px)");
const prompt = () => input.setAttribute("placeholder", tight.matches ? `Ask ${CHIEF}, or type /` : `Ask ${CHIEF}, or type / for a command`);
tight.addEventListener("change", prompt);
prompt();
const sendButton = h("button", { class: "send", type: "submit", "aria-label": "Send" }, icon("send", 18));
const mainFiles = attachments(input);
const mainMenu = commandMenu(input);
const logEl = h("div", { class: "chat-log", role: "log", "aria-label": `Conversation with ${CHIEF}`, tabindex: "0" });
const boardEl = h("aside", { class: "beside", "aria-label": "Jobs board" });
const fullBoardEl = h("div", { class: "full-board" });
const chips = ["What's waiting on me?", "/jobs", "/spend"].map((text) => h("button", { class: "chip", type: "button", onclick: () => void send(text) }, text));
/* ---------- Cleo: tap, speak, tap, and hear the answer ---------- */

/** The longest one spoken turn runs before it is sent on its own. */
const CLEO_MAX_MS = 60_000;
const canTalk = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder && (window.AudioContext || window.webkitAudioContext));
/** How long the page waits for her to come back from the chief, and how often it asks. */
const CLEO_BACK_MS = 75_000;
const CLEO_BACK_EVERY_MS = 1500;
/**
 * One turn at a time: idle, listening (recording him), thinking (waiting for her), speaking (playing her
 * answer), waiting (she has gone to ask the chief and will speak again when he answers).
 */
const cleo = { state: "idle", note: undefined, recorder: undefined, ctx: undefined, playing: undefined, done: undefined, timer: undefined };
const cleoButton = h("button", { class: "cleo", type: "button" });
const cleoCancel = h("button", { class: "btn quiet cleo-cancel", type: "button", onclick: () => stopTalking(false) }, "Cancel");
const cleoNote = h("div", { class: "cleo-note", role: "status" });
function drawCleo() {
  // Only where she can be heard and answered: voice is on, this browser can record, and the conversation has begun.
  const on = !!state.board?.voice && canTalk && state.own !== "new";
  cleoButton.hidden = !on && cleo.state === "idle";
  cleoButton.className = `cleo ${cleo.state}`;
  cleoButton.disabled = cleo.state === "thinking" || cleo.state === "waiting";
  const words = { idle: state.cleoOpen ? "Tap to talk" : CLEO, listening: "Tap to send", thinking: "Thinking", speaking: "Tap to stop", waiting: `Asking ${CHIEF}` }[cleo.state];
  cleoButton.setAttribute("aria-label", { idle: `Talk to ${CLEO}`, listening: `Send what you said to ${CLEO}`, thinking: `${CLEO} is thinking`, speaking: `Stop ${CLEO} speaking`, waiting: `${CLEO} is asking ${CHIEF}` }[cleo.state]);
  cleoButton.replaceChildren(...[icon(cleo.state === "speaking" ? "stop" : "wave", 18), h("span", {}, words)]);
  cleoCancel.hidden = cleo.state !== "listening";
  cleoNote.textContent = cleo.state === "listening" ? `${CLEO} is listening.` : cleo.state === "waiting" ? `${CLEO} is asking ${CHIEF}. She will tell you what he says.` : cleo.note ?? "";
  cleoNote.hidden = !cleoNote.textContent;
}
function cleoSays(note) {
  cleo.state = "idle";
  cleo.note = note;
  drawCleo();
}
async function startTalking() {
  cleo.note = undefined;
  // Made and woken inside his tap, which is the only time a phone lets a page make sound later.
  cleo.ctx ??= new (window.AudioContext || window.webkitAudioContext)();
  void cleo.ctx.resume();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return cleoSays("The microphone could not be used. Check the browser's permission for this site.");
  }
  const parts = [];
  const began = Date.now();
  const recorder = new MediaRecorder(stream);
  cleo.recorder = recorder;
  recorder.send = true;
  recorder.addEventListener("dataavailable", (e) => e.data.size && parts.push(e.data));
  recorder.addEventListener("stop", () => {
    clearTimeout(cleo.timer);
    for (const track of stream.getTracks()) track.stop();
    cleo.recorder = undefined;
    if (!recorder.send) return cleoSays(undefined);
    if (Date.now() - began < 400 || !parts.length) return cleoSays("That was too short to hear. Tap, speak, then tap again.");
    void sendTalk(new Blob(parts, { type: (recorder.mimeType || "audio/webm").split(";")[0] }));
  });
  recorder.start();
  cleo.timer = setTimeout(() => stopTalking(true), CLEO_MAX_MS);
  cleo.state = "listening";
  drawCleo();
}
function stopTalking(send) {
  if (!cleo.recorder) return;
  cleo.recorder.send = send;
  cleo.recorder.stop();
}
function stopSpeaking() {
  try {
    cleo.playing?.stop();
  } catch {
    // Already finished.
  }
  cleo.playing = undefined;
  cleo.done?.();
}
/** Plays one thing she says, and is done when it has ended or he has stopped it. Never fails: unheard is still said in writing. */
function speak(audio) {
  return new Promise((resolve) => {
    cleo.done = () => { cleo.done = undefined; resolve(); };
    void (async () => {
      try {
        const bytes = Uint8Array.from(atob(audio), (c) => c.charCodeAt(0));
        const sound = await cleo.ctx.decodeAudioData(bytes.buffer);
        const source = cleo.ctx.createBufferSource();
        source.buffer = sound;
        source.connect(cleo.ctx.destination);
        source.addEventListener("ended", () => { if (cleo.playing === source) { cleo.playing = undefined; cleo.done?.(); } });
        cleo.playing = source;
        cleo.state = "speaking";
        drawCleo();
        source.start();
      } catch {
        cleo.done?.();
      }
    })();
  });
}
/** What she says on coming back from the chief, or nothing if she has not come back in the time the page waits. */
async function comesBack(id) {
  const until = Date.now() + CLEO_BACK_MS;
  while (Date.now() < until) {
    await new Promise((later) => setTimeout(later, CLEO_BACK_EVERY_MS));
    const text = await getJson(`/voice/${id}`);
    // No longer held: her words are in her conversation all the same.
    if (!text) return undefined;
    const back = JSON.parse(text);
    if (back.ready) return back;
  }
  return undefined;
}
/** Her own conversation: what was said aloud, his words and hers. */
async function refreshCleo() {
  try {
    const text = await getJson("/cleo");
    if (text) state.cleoTalk = JSON.parse(text);
    state.cleoProblem = undefined;
  } catch (err) {
    if (err.message === "signed out") return;
    state.cleoProblem = `${CLEO}'s conversation could not be read just now.`;
  }
  if (state.cleoOpen && route().name === "board" && layout() !== "board") {
    stickNext = true;
    drawChat();
  }
}
/** Shows her conversation in the chat's place, or goes back to the feed underneath. */
function showCleo(open) {
  state.cleoOpen = open;
  state.chatsOpen = false;
  state.chatEdit = undefined;
  stickNext = true;
  drawChat();
  if (open) void refreshCleo();
}
function cleoItems() {
  const talk = state.cleoTalk;
  if (!talk) return [h("p", { class: "muted" }, state.cleoProblem ?? `Loading ${CLEO}'s conversation.`)];
  const today = dayKey(talk.generatedAt);
  const out = [];
  let lastDay;
  for (const m of talk.messages) {
    const day = dayKey(m.at);
    if (day !== lastDay) out.push(h("div", { class: "chat-day" }, day === today ? "Today" : dayFmt.format(new Date(m.at))));
    lastDay = day;
    if (m.from === "paul") out.push(h("div", { class: "mine" }, h("div", { class: "bubble" }, m.text)));
    else
      out.push(
        h(
          "div",
          { class: "theirs" },
          avatar("voice"),
          h(
            "div",
            { class: "theirs-body" },
            h("div", { class: "theirs-who" }, h("b", {}, CLEO), h("span", { class: "muted num" }, clock(m.at))),
            h("div", { class: "said-aloud" }, m.text),
            // She was reporting what the chief said: the way to where he wrote it.
            m.feed ? h("button", { class: "btn quiet to-feed", type: "button", onclick: () => openWhere(m.feed.where) }, avatar("chief", "sm"), h("span", {}, `${CHIEF}'s feed: ${m.feed.title}`), icon("send", 14)) : null,
          ),
        ),
      );
  }
  if (!talk.messages.length) out.push(h("div", { class: "chat-empty" }, avatar("voice", "lg"), h("p", {}, talk.on ? `Tap and speak. ${CLEO} answers what she can herself and asks ${CHIEF} for the rest, then tells you what he said. His written answers stay in his feeds.` : `${CLEO} is not switched on.`)));
  if (state.cleoProblem) out.push(h("div", { class: "banner" }, state.cleoProblem));
  return out;
}
async function sendTalk(blob) {
  cleo.state = "thinking";
  drawCleo();
  const where = threadOnScreen();
  try {
    const res = await postJson("/voice", { ...(where ? { thread: where } : {}), audio: { type: blob.type, data: await asBase64(blob) } });
    void refreshCleo();
    if (!res.ok) return cleoSays(res.data.error || `${CLEO} could not answer just now.`);
    if (!res.data.heard) return cleoSays(`${CLEO} did not catch anything. Tap and try again.`);
    const unspoken = `${CLEO} answered, but it could not be spoken. Her words are in her conversation.`;
    // She has gone to ask the chief: the page starts waiting for her while she says so.
    const back = res.data.pending ? comesBack(res.data.pending).catch(() => undefined) : undefined;
    if (res.data.audio) await speak(res.data.audio);
    if (!back) return cleoSays(res.data.said && !res.data.audio ? unspoken : undefined);
    cleo.state = "waiting";
    drawCleo();
    const answer = await back;
    void refreshCleo();
    void chatTick();
    if (!answer) return cleoSays(`${CLEO} is still waiting on ${CHIEF}. His answer will be written in his feed.`);
    if (answer.audio) await speak(answer.audio);
    cleoSays(answer.said && !answer.audio ? unspoken : undefined);
  } catch (err) {
    cleoSays(err.message === "signed out" ? undefined : `${CLEO} could not be reached or heard just now.`);
  }
}
// Talking to her opens her conversation: what is said aloud is shown there, apart from the chief's feed.
cleoButton.addEventListener("click", () => {
  if (cleo.state === "idle") {
    if (!state.cleoOpen) showCleo(true);
    void startTalking();
  } else if (cleo.state === "listening") stopTalking(true);
  else if (cleo.state === "speaking") stopSpeaking();
});

const chatEl = h(
  "section",
  { class: "chat", "aria-label": "Chat" },
  chatBarEl,
  logEl,
  h(
    "div",
    { class: "composer-wrap" },
    h("div", { class: "chips" }, chips),
    mainMenu.el,
    mainFiles.tray,
    h("div", { class: "cleo-line" }, cleoNote, cleoCancel),
    h(
      "form",
      { class: "composer", onsubmit: (e) => { e.preventDefault(); void send(input.value); } },
      h("label", { class: "sr", for: "ask" }, `Message ${CHIEF}`),
      mainFiles.tools,
      input,
      cleoButton,
      sendButton,
    ),
  ),
);
const railEl = h("nav", { class: "rail", id: "rail", "aria-label": "Spaces and who is on shift" });
/**
 * Draws the rail. A routine redraw leaves it alone while a space is being made or changed: rebuilding
 * it would wipe what he is typing. The form's own buttons ask for it outright.
 */
function drawRail(asked = false) {
  if (!asked && state.spaceForm && railEl.querySelector(".space-form")) return;
  railEl.replaceChildren(...rail(state.board));
}
// Behind the rail when it is a drawer: a tap outside it closes it.
const scrimEl = h("button", { class: "scrim", type: "button", tabindex: "-1", "aria-label": "Close", onclick: () => setRail(false) });
const homeEl = h("div", { class: "home" }, railEl, scrimEl, chatEl, boardEl, fullBoardEl);
const headerEl = h("div", {});
const bodyEl = h("div", { class: "body" });
const shellEl = h("div", { class: "shell" }, headerEl, bodyEl);

// The search page is one element kept between drawings, so its box is never rebuilt under his typing.
const searchInput = h("input", { id: "search", class: "search-box", type: "search", maxlength: "80", autocomplete: "off", enterkeyhint: "search", placeholder: "Search jobs, reports and chats", "aria-label": "Search jobs, reports and chats" });
const searchOut = h("div", { class: "search-out", "aria-live": "polite" });
const searchEl = h("main", { class: "page search" }, h("div", { class: "job-head" }, h("a", { class: "btn", href: "#/" }, icon("back"), "Back"), h("div", { class: "job-id" }, h("div", { class: "job-title" }, h("h1", {}, "Search")))), searchInput, searchOut);
const drawSearch = () => searchOut.replaceChildren(...searchResults());
let searchTimer;
let searchAsked = 0;
async function runSearch(q) {
  const mine = ++searchAsked;
  state.search.q = q;
  state.search.problem = undefined;
  if (q.trim().length < 2) {
    state.search.data = undefined;
    state.search.loading = false;
    return void drawSearch();
  }
  state.search.loading = true;
  drawSearch();
  try {
    const text = await getJson(`/search?q=${encodeURIComponent(q.trim())}`);
    // Only the answer to what is in the box now is shown.
    if (mine !== searchAsked) return;
    state.search.data = text ? JSON.parse(text) : undefined;
  } catch (err) {
    if (mine !== searchAsked || err.message === "signed out") return;
    state.search.problem = "The search could not be run just now.";
  }
  state.search.loading = false;
  drawSearch();
}
searchInput.addEventListener("input", () => {
  const q = searchInput.value;
  // Kept in the address without a new entry in the history for every letter.
  history.replaceState(null, "", q.trim() ? `#/search/${encodeURIComponent(q)}` : "#/search");
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void runSearch(q), 250);
});

function grow() {
  input.style.height = "auto";
  input.style.height = `${Math.min(160, input.scrollHeight)}px`;
}
input.addEventListener("input", grow);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void send(input.value);
  }
});

/** Paul's own words to the chief: the main conversation, or with `thread` the thread of a job or a pull request. */
async function postMessage(body) {
  const res = await fetch(`${API}/chat`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, credentials: "same-origin", body: JSON.stringify(body) });
  if (res.status === 401) {
    location.assign(SIGN_IN);
    throw new Error("Signed out.");
  }
  if (!res.ok) {
    const said = await res.json().catch(() => ({}));
    throw new Error(res.status === 413 ? "That is too large to send." : typeof said.error === "string" && said.error.length > 12 ? said.error : "The message was not accepted.");
  }
  return res.json().catch(() => ({}));
}

async function send(raw) {
  const text = raw.trim();
  // Files in the tray go with what Paul typed in the box, never with a chip or a button's message.
  const typed = raw === input.value;
  const files = typed ? mainFiles.files.length : 0;
  if ((!text && !files) || state.sending) return;
  state.sending = true;
  sendButton.disabled = true;
  try {
    const where = threadOnScreen();
    const said = await postMessage({ text, ...(where ? { thread: where } : {}), ...(files ? { files: await mainFiles.payload() } : {}) });
    // A new chat exists once its first message is in: the service names it and says which it is.
    const opened = where === "chat:new" && /^chat:[a-f0-9]{8}$/.test(said.thread ?? "") ? said.thread.slice(5) : undefined;
    if (opened && state.own === "new") {
      state.own = opened;
      store("clearops.chat", opened);
      state.chat = undefined;
      state.chatRaw = "";
    }
    if (typed) {
      input.value = "";
      mainFiles.clear();
      grow();
    }
    state.chatProblem = undefined;
    stickNext = true;
  } catch (err) {
    state.chatProblem = err.message === "Failed to fetch" ? "The service could not be reached." : err.message;
    drawChat();
  } finally {
    state.sending = false;
    sendButton.disabled = false;
  }
  void chatTick();
}

let stickNext = true;
function drawChat() {
  drawCleo();
  chatEl.classList.toggle("with-cleo", state.cleoOpen);
  logEl.setAttribute("aria-label", `Conversation with ${state.cleoOpen ? CLEO : CHIEF}`);
  if (!state.cleoOpen) lookedAt();
  drawChatBar(Date.now(), true);
  const stick = stickNext || logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 120;
  logEl.replaceChildren(...(state.cleoOpen ? cleoItems() : chatItems()));
  if (stick) logEl.scrollTop = logEl.scrollHeight;
  stickNext = false;
}

/* ---------- Drawing and polling ---------- */

const narrow = window.matchMedia("(max-width: 900px)");
/** On a phone there is no room for both, so "both" shows the chat. */
// Beside the rail there is room for the chat and the board together only on a wide screen.
const roomy = window.matchMedia("(min-width: 1181px)");
const layout = () => (!roomy.matches && state.layout === "split" ? "chat" : state.layout);
narrow.addEventListener("change", () => { state.railOpen = false; draw(); });
roomy.addEventListener("change", () => draw());
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.railOpen) setRail(false); });

function draw() {
  const r = route();
  document.title = r.name === "space" && state.spacePage ? `${state.spacePage.name} · ClearOps` : r.name === "agent" && state.agent ? `${state.agent.name ?? state.agent.role} · ClearOps` : r.name === "search" ? "Search · ClearOps" : r.name === "spend" ? "Spend · ClearOps" : r.name === "job" && state.job ? `${state.job.job.title} · ClearOps` : r.name === "pull" ? `Pull request #${r.number} · ClearOps` : "ClearOps";
  if (!shellEl.isConnected) root.replaceChildren(shellEl);
  headerEl.replaceChildren(header(state.board));
  if (r.name === "job" || r.name === "pull") {
    shellEl.className = "shell";
    // The thread pane is one element moved into each new drawing of the page. Moving it drops the
    // caret and the scroll, so both are put back: a redraw must not interrupt someone typing.
    const caret = document.activeElement === threadInput ? [threadInput.selectionStart, threadInput.selectionEnd] : undefined;
    const atEnd = threadLog.scrollHeight - threadLog.scrollTop - threadLog.clientHeight < 120;
    const top = threadLog.scrollTop;
    // Brought here by a report's link: it is opened in full, and shown, once the job has loaded.
    if (r.name === "job" && r.report && state.reportAsked !== r.id) state.reportOpen = state.reportAsked = r.id;
    bodyEl.replaceChildren(r.name === "job" ? jobPage() : pullPage(r));
    if (r.name === "job" && r.report && state.reportShown !== r.id && document.getElementById("report")) {
      state.reportShown = r.id;
      document.getElementById("report").scrollIntoView({ block: "start" });
    }
    threadLog.scrollTop = atEnd ? threadLog.scrollHeight : top;
    if (caret) {
      threadInput.focus({ preventScroll: true });
      threadInput.setSelectionRange(caret[0], caret[1]);
    }
    return;
  }
  if (r.name === "agent") {
    shellEl.className = "shell";
    bodyEl.replaceChildren(...[agentPage()]);
    return;
  }
  if (r.name === "space") {
    shellEl.className = "shell";
    // The notes box keeps its caret and its scroll across a redraw.
    const was = document.activeElement?.id === "space-notes" ? [document.activeElement.selectionStart, document.activeElement.selectionEnd, document.activeElement.scrollTop] : undefined;
    bodyEl.replaceChildren(...[spacePage()]);
    const box = document.getElementById("space-notes");
    if (was && box) {
      box.focus({ preventScroll: true });
      box.setSelectionRange(was[0], was[1]);
      box.scrollTop = was[2];
    }
    return;
  }
  if (r.name === "search") {
    shellEl.className = "shell";
    if (searchEl.parentNode !== bodyEl) {
      bodyEl.replaceChildren(...[searchEl]);
      if (searchInput.value !== r.q || state.search.q !== r.q) {
        searchInput.value = r.q;
        void runSearch(r.q);
      }
      searchInput.focus();
    }
    drawSearch();
    return;
  }
  if (r.name === "spend") {
    shellEl.className = "shell";
    // A box being typed in keeps the caret across a redraw.
    const active = document.activeElement?.id?.startsWith("cap-") ? document.activeElement.id : undefined;
    bodyEl.replaceChildren(spendPage());
    if (active) document.getElementById(active)?.focus({ preventScroll: true });
    return;
  }
  const mode = layout();
  shellEl.className = `shell${mode === "board" ? "" : " fixed"}`;
  homeEl.className = `home show-${mode}${state.railOpen && narrow.matches ? " rail-open" : ""}`;
  drawRail();
  if (homeEl.parentNode !== bodyEl) {
    bodyEl.replaceChildren(homeEl);
    stickNext = true;
  }
  if (mode !== "board") drawChat();
  if (mode === "split") boardEl.replaceChildren(...besideBoard().filter(Boolean));
  if (mode === "board") fullBoardEl.replaceChildren(boardPage());
}

function setLayout(next) {
  state.layout = next;
  store("clearops.layout", next);
  stickNext = true;
  draw();
}
function setView(view) {
  state.view = view;
  store("clearops.view", view);
  draw();
}
function setDetail(detail) {
  state.detail = detail;
  store("clearops.trace", detail);
  draw();
}

async function loadOlder() {
  if (state.historyLoading || !state.board) return;
  state.historyLoading = true;
  draw();
  try {
    const finished = scoped(state.board).jobs.filter((j) => j.status === "done" || j.status === "failed");
    const oldest = finished.length ? finished[finished.length - 1].finishedAt : undefined;
    const before = state.historyNext ?? oldest ?? state.board.generatedAt;
    const text = await getJson(`/history?before=${encodeURIComponent(before)}${spaceOf() ? `&space=${encodeURIComponent(state.space)}` : ""}`);
    const page = JSON.parse(text);
    state.history.push(...page.jobs);
    state.historyNext = page.next;
    if (!page.next) state.board.hasOlder = false;
  } catch (err) {
    if (err.message !== "signed out") state.problem = "The older jobs could not be loaded just now.";
  }
  state.historyLoading = false;
  draw();
}

async function refreshBoard() {
  try {
    const text = await getJson("/board");
    const changed = text !== state.boardRaw || state.problem;
    state.problem = undefined;
    if (changed) {
      state.boardRaw = text;
      state.board = JSON.parse(text);
      // A finished page of history stays finished; only whether more exists is carried over.
      if (state.history.length && state.historyNext === undefined) state.board.hasOlder = false;
      // A space that is no longer listed is not one the board can be narrowed to.
      if (state.space && !(state.board.spaces ?? []).some((sp) => sp.id === state.space)) { state.space = ""; state.history = []; state.historyNext = undefined; }
      return true;
    }
  } catch (err) {
    if (err.message === "signed out") return false;
    const had = state.problem;
    state.problem = "The service could not be reached. Trying again.";
    return !had;
  }
  return false;
}

async function refreshJob(id) {
  try {
    const text = await getJson(`/jobs/${id}`);
    if (route().id !== id) return false;
    if (text === undefined) {
      state.jobMissing = true;
      state.job = undefined;
      return true;
    }
    const changed = text !== state.jobRaw || state.problem || state.jobMissing;
    state.problem = undefined;
    state.jobMissing = false;
    if (changed) {
      state.jobRaw = text;
      state.job = JSON.parse(text);
      return true;
    }
  } catch (err) {
    if (err.message === "signed out") return false;
    const had = state.problem;
    state.problem = "The service could not be reached. Trying again.";
    return !had;
  }
  return false;
}

async function refreshChat() {
  const where = threadOnScreen();
  // A chat not yet begun has nothing to read: it exists once its first message is sent.
  if (where === "chat:new") return false;
  try {
    const text = await getJson(where ? `/chat?thread=${encodeURIComponent(where)}` : "/chat");
    if (threadOnScreen() !== where) return false;
    // A chat that is no longer kept, or a space that is no longer there: back to the main conversation.
    if (text === undefined) {
      if (where?.startsWith("space:")) {
        state.space = "";
        store("clearops.space", "");
      } else {
        state.own = "";
        store("clearops.chat", "");
      }
      state.chat = undefined;
      state.chatRaw = "";
      return refreshChat();
    }
    const changed = text !== state.chatRaw;
    if (changed) {
      state.chatRaw = text;
      state.chat = JSON.parse(text);
      state.chats = state.chat.chats ?? [];
      state.mainSaidAt = state.chat.mainSaidAt;
    }
    return changed;
  } catch (err) {
    if (err.message === "signed out") return false;
    if (!state.chat) state.chatProblem = "The conversation could not be loaded just now.";
    return !state.chat;
  }
}

/** The chat is asked more often while something is plainly happening in it. */
function chatBusy() {
  const chat = state.chat;
  if (!chat) return false;
  const last = chat.messages[chat.messages.length - 1];
  return chat.typing || chat.messages.some((m) => m.live) || (last && last.from === "paul") || chat.jobs.some((j) => j.status === "running" || j.status === "queued");
}

let chatTimer;
async function chatTick() {
  clearTimeout(chatTimer);
  if (!document.hidden) {
    const changed = await refreshChat();
    if (changed && route().name === "board" && layout() !== "board") drawChat();
  }
  chatTimer = setTimeout(chatTick, chatBusy() ? CHAT_BUSY_EVERY_MS : CHAT_QUIET_EVERY_MS);
}

let timer;
async function tick() {
  clearTimeout(timer);
  const r = route();
  let wait = BOARD_EVERY_MS;
  if (!document.hidden) {
    const [boardChanged, jobChanged] = await Promise.all([refreshBoard(), r.name === "job" ? refreshJob(r.id) : r.name === "agent" ? refreshAgent(r.kind) : r.name === "space" ? refreshSpacePage(r.id) : r.name === "spend" ? refreshSpend() : false]);
    // Away from the board, a new reading of the board only refreshes the header: redrawing the page
    // under someone reading a diff would lose their place.
    if (r.name === "board" ? boardChanged : jobChanged) draw();
    else if (boardChanged) headerEl.replaceChildren(header(state.board));
    if (r.name === "pull" || r.name === "spend" || r.name === "agent" || r.name === "space") wait = JOB_IDLE_EVERY_MS;
    if (r.name === "job") wait = state.job && (state.job.job.status === "running" || state.job.job.status === "queued") ? JOB_LIVE_EVERY_MS : JOB_IDLE_EVERY_MS;
  }
  timer = setTimeout(tick, wait);
}

/** A pull request opened from the list is fetched straight away: opening it is the ask. */
function openPullRoute() {
  const r = route();
  if (r.name === "pull" && state.pull?.key !== pullKey(r.repo, r.number)) void loadPull(r.repo, r.number);
}

/**
 * The home-screen shortcut "Talk to Cleo" opens the app at #/cleo: her conversation in the chat's place,
 * with her button ready. Nothing is listened to until he taps it. The address is put back to the home
 * page's, so going back or reloading does not open her again.
 */
function fromShortcut() {
  if (location.hash !== "#/cleo") return false;
  history.replaceState(null, "", "#/");
  if (layout() === "board") state.layout = "chat";
  state.cleoOpen = true;
  void refreshCleo();
  return true;
}

window.addEventListener("hashchange", () => {
  fromShortcut();
  if (!state.busy) state.notice = undefined;
  state.job = undefined;
  state.jobRaw = "";
  state.jobMissing = false;
  state.agent = undefined;
  state.agentRaw = "";
  state.agentMissing = false;
  state.spacePageRaw = "";
  state.spacePageMissing = false;
  state.problem = undefined;
  state.reportAsked = state.reportShown = undefined;
  window.scrollTo(0, 0);
  draw();
  void tick();
  openPullRoute();
  void threadTick();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  void tick();
  void chatTick();
  void threadTick();
});

fromShortcut();
draw();
void tick();
void chatTick();
openPullRoute();
void threadTick();
