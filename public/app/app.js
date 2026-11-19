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
const KNOWN_KINDS = new Set(["engineer", "maintain", "research", "design", "write", "analyse", "create_agent", "ea", "ideate", "cv", "dns", "advisor", "prebid"]);
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
};

const route = () => {
  const m = /^#\/job\/([A-Za-z0-9_-]{1,64})$/.exec(location.hash);
  if (m) return { name: "job", id: m[1] };
  if (location.hash === "#/spend") return { name: "spend" };
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
    h("a", { class: "brand", href: "#/" }, h("span", { class: "mark", "aria-hidden": "true" }, h("i"), h("i")), "ClearOps"),
    route().name === "board"
      ? h(
          "div",
          { class: "seg", role: "group", "aria-label": "What to show" },
          h("button", { type: "button", "aria-pressed": String(layout() === "chat"), onclick: () => setLayout("chat") }, "Chat"),
          narrow.matches ? null : h("button", { type: "button", "aria-pressed": String(layout() === "split"), onclick: () => setLayout("split") }, "Both"),
          h("button", { type: "button", "aria-pressed": String(layout() === "board"), onclick: () => setLayout("board") }, "Board"),
        )
      : null,
    h("div", { class: "grow" }),
    spend,
    health,
    h("form", { method: "post", action: "/app/sign-out" }, h("button", { class: "btn quiet", type: "submit", "aria-label": "Sign out" }, icon("out", 16), h("span", { class: "wide-only", "aria-hidden": "true" }, "Sign out"))),
  );
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
  const board = state.board;
  if (!board) return h("main", { class: "page" }, h("p", { class: "muted" }, state.problem ?? "Loading the board."));
  const now = Date.parse(board.generatedAt);
  const view = state.view === "timeline" ? timelineView(board, now) : state.view === "space" ? spaceView(board, now) : statusView(board, now);
  return h(
    "main",
    { class: "page" },
    h(
      "div",
      { class: "page-head" },
      h("h1", {}, "Board"),
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
    const select = h("select", { class: "pick", "aria-label": "Model to run it on", onchange: (e) => { state.rerunModel = e.target.value; } }, a.rerunModels.map((m) => h("option", { value: m, selected: m === chosen }, modelName(m))));
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
    v.body ? h("div", { class: "block" }, h("h3", {}, "Description"), h("p", { class: "prose pull-body" }, v.body)) : null,
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
  return h("main", { class: "page" }, back, noticeBar(), today, went, caps, models);
}

/* ---------- Threads: talking to the chief about one job or one pull request ---------- */

/** The thread the page being looked at belongs to: "job:<id>" or "pull:<alias>:<number>". */
function threadKeyOf(r) {
  return r.name === "job" ? `job:${r.id}` : r.name === "pull" ? `pull:${r.repo}:${r.number}` : undefined;
}

const threadInput = h("textarea", { id: "ask-thread", rows: "1", maxlength: String(TEXT_MAX), autocomplete: "off" });
const threadSend = h("button", { class: "send", type: "submit", "aria-label": "Send" }, icon("send", 18));
const threadLog = h("div", { class: "thread-log", role: "log", tabindex: "0" });
const threadEl = h(
  "section",
  { class: "pane thread", "aria-label": `Talk to ${CHIEF} about this` },
  h("div", { class: "pane-head" }, h("h2", {}, `Talk to ${CHIEF} about this`)),
  threadLog,
  h(
    "form",
    { class: "composer", onsubmit: (e) => { e.preventDefault(); void sendThread(threadInput.value); } },
    h("label", { class: "sr", for: "ask-thread" }, `Message ${CHIEF} about this`),
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
    else if (item.message.from === "paul") out.push(h("div", { class: "mine" }, h("div", { class: "bubble" }, item.message.text)));
    else out.push(h("div", { class: "theirs" }, avatar("chief"), h("div", { class: "theirs-body" }, h("div", { class: "theirs-who" }, h("b", {}, CHIEF), h("span", { class: "muted num" }, clock(item.message.at))), rendered(item.message.html ?? "", "report said"))));
  }
  if (!stream.length) out.push(h("p", { class: "muted" }, `Nothing said here yet. What you write goes to ${CHIEF} with this attached, so there is no need to say what it is about.`));
  const live = t.view.messages.find((m) => m.live);
  const unanswered = t.view.messages.filter((m) => !m.live).at(-1)?.from === "paul";
  if (live || t.view.typing || unanswered) out.push(h("div", { class: "working", role: "status" }, h("span", { class: "dot live" }), h("span", {}, live ? live.text : `${CHIEF} is working on it`)));
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
  if (!text || !key) return false;
  if (state.thread?.key !== key) state.thread = { key, view: undefined, raw: "", problem: undefined, sending: false };
  const t = state.thread;
  if (t.sending) return false;
  t.sending = true;
  threadSend.disabled = true;
  let ok = false;
  try {
    await postMessage({ text, thread: key });
    if (raw === threadInput.value) threadInput.value = "";
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
    cost = stat("Cost", h("small", {}, "No real figure"), job.status === "running" ? "A job's cost is recorded when it finishes." : "The store holds no provider figure for this job.");
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

  let output = null;
  if (detail.outputHtml !== undefined) {
    output = h("section", { class: "pane", "aria-label": "Saved output" }, h("h2", {}, "Saved output"), rendered(detail.outputHtml, "report"));
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
    threadPane(),
    h("div", { class: "panes" }, about, trace),
    output,
  );
}

/* ---------- Chat ---------- */

/** The board beside the chat: the same jobs, stacked, with the newest few finished. */
function besideBoard() {
  const board = state.board;
  if (!board) return [h("p", { class: "muted" }, state.problem ?? "Loading the board.")];
  const now = Date.parse(board.generatedAt);
  const by = (which) => board.jobs.filter((j) => pile(j) === which);
  const few = (jobs) => ({ cards: jobs.slice(0, DONE_SHOWN_BESIDE).map((j) => jobCard(j, now)), extra: { hidden: Math.max(0, jobs.length - DONE_SHOWN_BESIDE), node: null } });
  const met = few(by("met"));
  const open = few(by("unconfirmed"));
  const not = few(by("not_met"));
  return [
    h("div", { class: "page-head" }, h("h2", { class: "pane-title" }, "Board"), h("button", { class: "btn", type: "button", onclick: () => setLayout("board") }, "Open the board")),
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
      out.push(h("div", { class: "mine" }, h("div", { class: "bubble" }, item.message.text)));
      lastFrom = "paul";
    } else {
      const first = lastFrom !== "clearops";
      out.push(
        h(
          "div",
          { class: `theirs${first ? "" : " cont"}` },
          first ? avatar("chief") : h("span", { class: "av-gap", "aria-hidden": "true" }),
          h("div", { class: "theirs-body" }, first ? h("div", { class: "theirs-who" }, h("b", {}, CHIEF), h("span", { class: "muted num" }, clock(item.message.at))) : null, rendered(item.message.html ?? "", "report said")),
        ),
      );
      lastFrom = "clearops";
    }
  }
  if (!stream.length) out.push(h("div", { class: "chat-empty" }, avatar("chief", "lg"), h("p", {}, `Ask ${CHIEF} for anything. Jobs it starts appear here as cards you can open.`)));
  // Whatever is waiting for his decision sits at the foot of the conversation, with the same buttons as
  // on the board, wherever it was first put to him.
  const waiting = state.board?.waiting ?? [];
  if (waiting.length) {
    out.push(h("div", { class: "chat-day wait" }, waiting.length === 1 ? "Waiting on you" : `${waiting.length} things waiting on you`));
    for (const item of waiting) out.push(h("div", { class: "chat-card" }, waitingCard(item, now)));
  }
  // A decision that went through is said by the service in the conversation itself; one that did not is said here.
  if (state.notice?.bad) out.push(h("div", { class: "chat-card" }, noticeBar()));
  const live = chat.messages.find((m) => m.live);
  // His message is in and nothing has come back yet: say so, whether or not the service has signalled it.
  const unanswered = chat.messages.filter((m) => !m.live).at(-1)?.from === "paul";
  if (live || chat.typing || unanswered) out.push(h("div", { class: "working", role: "status" }, h("span", { class: "dot live" }), h("span", {}, live ? live.text : `${CHIEF} is working on it`)));
  if (state.chatProblem) out.push(h("div", { class: "banner" }, h("b", {}, "Not sent or not up to date. "), state.chatProblem));
  return out;
}

const input = h("textarea", { id: "ask", rows: "1", maxlength: String(TEXT_MAX), placeholder: `Ask ${CHIEF}, or type / for a command`, autocomplete: "off" });
const sendButton = h("button", { class: "send", type: "submit", "aria-label": "Send" }, icon("send", 18));
const logEl = h("div", { class: "chat-log", role: "log", "aria-label": `Conversation with ${CHIEF}`, tabindex: "0" });
const boardEl = h("aside", { class: "beside", "aria-label": "Jobs board" });
const fullBoardEl = h("div", { class: "full-board" });
const chips = ["What's waiting on me?", "/jobs", "/spend"].map((text) => h("button", { class: "chip", type: "button", onclick: () => void send(text) }, text));
const chatEl = h(
  "section",
  { class: "chat", "aria-label": "Chat" },
  logEl,
  h(
    "div",
    { class: "composer-wrap" },
    h("div", { class: "chips" }, chips),
    h(
      "form",
      { class: "composer", onsubmit: (e) => { e.preventDefault(); void send(input.value); } },
      h("label", { class: "sr", for: "ask" }, `Message ${CHIEF}`),
      input,
      sendButton,
    ),
  ),
);
const homeEl = h("div", { class: "home" }, chatEl, boardEl, fullBoardEl);
const headerEl = h("div", {});
const bodyEl = h("div", { class: "body" });
const shellEl = h("div", { class: "shell" }, headerEl, bodyEl);

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
  if (!res.ok) throw new Error(res.status === 413 ? "That message is too long." : "The message was not accepted.");
}

async function send(raw) {
  const text = raw.trim();
  if (!text || state.sending) return;
  state.sending = true;
  sendButton.disabled = true;
  try {
    await postMessage({ text });
    if (raw === input.value) {
      input.value = "";
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
  const stick = stickNext || logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 120;
  logEl.replaceChildren(...chatItems());
  if (stick) logEl.scrollTop = logEl.scrollHeight;
  stickNext = false;
}

/* ---------- Drawing and polling ---------- */

const narrow = window.matchMedia("(max-width: 900px)");
/** On a phone there is no room for both, so "both" shows the chat. */
const layout = () => (narrow.matches && state.layout === "split" ? "chat" : state.layout);
narrow.addEventListener("change", () => draw());

function draw() {
  const r = route();
  document.title = r.name === "spend" ? "Spend · ClearOps" : r.name === "job" && state.job ? `${state.job.job.title} · ClearOps` : r.name === "pull" ? `Pull request #${r.number} · ClearOps` : "ClearOps";
  if (!shellEl.isConnected) root.replaceChildren(shellEl);
  headerEl.replaceChildren(header(state.board));
  if (r.name === "job" || r.name === "pull") {
    shellEl.className = "shell";
    // The thread pane is one element moved into each new drawing of the page. Moving it drops the
    // caret and the scroll, so both are put back: a redraw must not interrupt someone typing.
    const caret = document.activeElement === threadInput ? [threadInput.selectionStart, threadInput.selectionEnd] : undefined;
    const atEnd = threadLog.scrollHeight - threadLog.scrollTop - threadLog.clientHeight < 120;
    const top = threadLog.scrollTop;
    bodyEl.replaceChildren(r.name === "job" ? jobPage() : pullPage(r));
    threadLog.scrollTop = atEnd ? threadLog.scrollHeight : top;
    if (caret) {
      threadInput.focus({ preventScroll: true });
      threadInput.setSelectionRange(caret[0], caret[1]);
    }
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
  homeEl.className = `home show-${mode}`;
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
    const finished = state.board.jobs.filter((j) => j.status === "done" || j.status === "failed");
    const oldest = finished.length ? finished[finished.length - 1].finishedAt : undefined;
    const before = state.historyNext ?? oldest ?? state.board.generatedAt;
    const text = await getJson(`/history?before=${encodeURIComponent(before)}`);
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
  try {
    const text = await getJson("/chat");
    const changed = text !== state.chatRaw;
    if (changed) {
      state.chatRaw = text;
      state.chat = JSON.parse(text);
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
    const [boardChanged, jobChanged] = await Promise.all([refreshBoard(), r.name === "job" ? refreshJob(r.id) : r.name === "spend" ? refreshSpend() : false]);
    // Away from the board, a new reading of the board only refreshes the header: redrawing the page
    // under someone reading a diff would lose their place.
    if (r.name === "board" ? boardChanged : jobChanged) draw();
    else if (boardChanged) headerEl.replaceChildren(header(state.board));
    if (r.name === "pull" || r.name === "spend") wait = JOB_IDLE_EVERY_MS;
    if (r.name === "job") wait = state.job && (state.job.job.status === "running" || state.job.job.status === "queued") ? JOB_LIVE_EVERY_MS : JOB_IDLE_EVERY_MS;
  }
  timer = setTimeout(tick, wait);
}

/** A pull request opened from the list is fetched straight away: opening it is the ask. */
function openPullRoute() {
  const r = route();
  if (r.name === "pull" && state.pull?.key !== pullKey(r.repo, r.number)) void loadPull(r.repo, r.number);
}

window.addEventListener("hashchange", () => {
  if (!state.busy) state.notice = undefined;
  state.job = undefined;
  state.jobRaw = "";
  state.jobMissing = false;
  state.problem = undefined;
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

draw();
void tick();
void chatTick();
openPullRoute();
void threadTick();
