// ClearOps web app, slice 1 (docs/APP.md): the board in three views, the whole history, and one job
// with its trace and what it cost. Read-only: every request here is a GET, and the one form is sign-out.
// No framework and no build step. The page is drawn with DOM nodes, never by assembling HTML, so
// nothing a job says can become markup. The one exception is a saved report, which the service has
// already rendered and escaped (src/reports.ts) and which the page's policy keeps script-free.

const API = "/app/api";
const SIGN_IN = "/app/sign-in";
const BOARD_EVERY_MS = 5000;
const JOB_LIVE_EVERY_MS = 4000;
const JOB_IDLE_EVERY_MS = 30000;
const DONE_SHOWN = 12;

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

/* ---------- State ---------- */

const VIEWS = [["status", "Status"], ["timeline", "Timeline"], ["space", "By space"]];
const state = {
  view: VIEWS.some(([v]) => v === store("clearops.view")) ? store("clearops.view") : "status",
  detail: store("clearops.trace") === "full" ? "full" : "plain",
  board: undefined,
  boardRaw: "",
  history: [],
  historyNext: undefined,
  historyLoading: false,
  job: undefined,
  jobRaw: "",
  jobMissing: false,
  problem: undefined,
};

const route = () => {
  const m = /^#\/job\/([A-Za-z0-9_-]{1,64})$/.exec(location.hash);
  return m ? { name: "job", id: m[1] } : { name: "board" };
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

/* ---------- Pieces ---------- */

function statusTag(job) {
  if (job.status === "running") return h("span", { class: "tag run" }, h("span", { class: `dot ${job.alive === false ? "" : "live"}` }), job.alive === false ? "No live worker" : "Running");
  if (job.status === "queued") return job.held ? h("span", { class: "tag" }, icon("pause", 12), "Held") : h("span", { class: "tag" }, "Queued");
  if (job.status === "failed") return h("span", { class: "tag bad" }, icon("cross", 12), "Failed");
  return h("span", { class: "tag ok" }, icon("check", 12), "Done");
}

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
  return h("div", { class: "card-line" }, h("span", {}, `Finished ${ago(job.finishedAt, now) ?? ""}${job.pr ? " · has a pull request" : ""}`));
}

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
  );
}

function waitingCard(item, now) {
  return h(
    "div",
    { class: "card wait" },
    h("div", { class: "card-main" }, h("div", { class: "card-title" }, item.label), h("div", { class: "card-sub" }, `Asked ${ago(item.createdAt, now)} · open for another ${span(Date.parse(item.expiresAt) - now)}`)),
    h("div", { class: "card-sub" }, "Approve it in chat by sending:"),
    h("div", { class: "cmd" }, item.command),
    item.jobId ? h("a", { href: `#/job/${item.jobId}` }, "See the job") : null,
  );
}

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
      "div",
      { class: `spend ${s.capReached ? "capped" : ""}`, title: s.note },
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
    ? h("span", { class: `pill ${healthy ? "" : "warn"}`, title: `${board.health.headline} ${board.health.live}` }, healthy ? icon("check", 14) : icon("cross", 14), healthy ? "Healthy" : "Needs a look")
    : null;
  return h(
    "header",
    { class: "top" },
    h("a", { class: "brand", href: "#/" }, h("span", { class: "mark", "aria-hidden": "true" }, h("i"), h("i")), "ClearOps"),
    h("div", { class: "grow" }),
    spend,
    health,
    h("form", { method: "post", action: "/app/sign-out" }, h("button", { class: "btn quiet", type: "submit" }, icon("out", 16), "Sign out")),
  );
}

/* ---------- Board views ---------- */

function statusView(board, now) {
  const by = (status) => board.jobs.filter((j) => j.status === status);
  const done = by("done");
  const hidden = Math.max(0, done.length - DONE_SHOWN);
  return h(
    "div",
    { class: "cols" },
    column("wait", "Waiting on me", board.waiting.map((w) => waitingCard(w, now)), "Nothing needs your approval."),
    column("run", "Running", by("running").map((j) => jobCard(j, now)), "Nobody is working right now."),
    column("", "Queued", by("queued").map((j) => jobCard(j, now)), "The queue is empty."),
    column("ok", "Done in the last two days", done.slice(0, DONE_SHOWN).map((j) => jobCard(j, now)), "Nothing has finished in the last two days.", {
      hidden,
      node: hidden ? h("div", { class: "more" }, `${hidden} more in Timeline.`) : null,
    }),
    column("bad", "Failed in the last two days", by("failed").map((j) => jobCard(j, now)), "Nothing has fallen over."),
  );
}

function jobRow(job, now) {
  const at = job.finishedAt ?? job.startedAt ?? job.createdAt;
  return h(
    "a",
    { class: "row", href: `#/job/${job.id}` },
    h("span", { class: "row-time num" }, clock(at)),
    avatar(job.kind, "sm"),
    h("div", { class: "row-main" }, h("div", { class: "card-title" }, job.title), h("div", { class: "card-sub" }, jobSub(job))),
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
    board.paused ? h("div", { class: "banner" }, h("b", {}, "The queues are held. "), "A credit or key failure stopped new engineering jobs. Send /resume in chat once it is fixed.") : null,
    board.spend.capReached ? h("div", { class: "banner" }, h("b", {}, "Today's cap is reached. "), "New jobs wait until tomorrow, or until you send /resume in chat.") : null,
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
    const body = h("div", { class: "report" });
    // Rendered and escaped by the service (src/reports.ts); the page's policy allows no script.
    body.innerHTML = detail.outputHtml;
    for (const a of body.querySelectorAll("a[href]")) { a.setAttribute("rel", "noopener noreferrer"); a.setAttribute("target", "_blank"); }
    output = h("section", { class: "pane", "aria-label": "Saved output" }, h("h2", {}, "Saved output"), body);
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
    h("div", { class: "stats" }, cost, model, steps, time),
    h("div", { class: "panes" }, about, trace),
    output,
  );
}

/* ---------- Drawing and polling ---------- */

function draw() {
  const r = route();
  document.title = r.name === "job" && state.job ? `${state.job.job.title} · ClearOps` : "ClearOps";
  root.replaceChildren(h("div", { class: "shell" }, header(state.board), r.name === "job" ? jobPage() : boardPage()));
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

let timer;
async function tick() {
  clearTimeout(timer);
  const r = route();
  let wait = BOARD_EVERY_MS;
  if (!document.hidden) {
    const results = await Promise.all([refreshBoard(), r.name === "job" ? refreshJob(r.id) : false]);
    if (results.some(Boolean)) draw();
    if (r.name === "job") wait = state.job && (state.job.job.status === "running" || state.job.job.status === "queued") ? JOB_LIVE_EVERY_MS : JOB_IDLE_EVERY_MS;
  }
  timer = setTimeout(tick, wait);
}

window.addEventListener("hashchange", () => {
  state.job = undefined;
  state.jobRaw = "";
  state.jobMissing = false;
  state.problem = undefined;
  window.scrollTo(0, 0);
  draw();
  void tick();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void tick();
});

draw();
void tick();
