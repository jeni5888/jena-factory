// JenaAI-Factory Client — Mission Control Dashboard
const $ = (sel) => document.querySelector(sel);

// ── State ────────────────────────────────────────────────────
let selectedEpic = null;
let allEpics = [];
let epicCosts = {};
let runStartedAt = null;
let elapsedInterval = null;
let toolFeedBuffer = [];
const MAX_TOOL_FEED = 25;

// ── Helpers ──────────────────────────────────────────────────
async function fetchJson(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

function fmt$(n) { return "$" + (n || 0).toFixed(2); }

function fmtTime(iso) {
  if (!iso) return "\u2014";
  try { return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }); }
  catch { return iso; }
}

function fmtDuration(ms) {
  if (!ms) return "\u2014";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  const h = Math.floor(m / 60);
  return h + "h " + (m % 60) + "m";
}

function fmtTokens(n) {
  if (!n) return "0";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

// ── Safe DOM ─────────────────────────────────────────────────
function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (k === "className") node.className = v;
    else if (k === "onclick") node.addEventListener("click", v);
    else if (k === "title") node.title = v;
    else if (k === "style") node.style.cssText = v;
    else node.setAttribute(k, v);
  }
  if (children != null) {
    if (typeof children === "string") node.textContent = children;
    else if (Array.isArray(children)) children.forEach(c => {
      if (c != null) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    else node.appendChild(children);
  }
  return node;
}

function clear(parent) { parent.textContent = ""; }

function setText(id, text) {
  const node = document.getElementById(id);
  if (node) node.textContent = text;
}

// Tool icons
const TOOL_ICONS = {
  Bash: { icon: "$", cls: "ti-Bash" },
  Read: { icon: "\u25b8", cls: "ti-Read" },
  Edit: { icon: "\u270e", cls: "ti-Edit" },
  Write: { icon: "\u2713", cls: "ti-Write" },
  Grep: { icon: "\u2315", cls: "ti-Grep" },
  Glob: { icon: "\u25c8", cls: "ti-Glob" },
  Agent: { icon: "\u25c8", cls: "ti-Agent" },
  Skill: { icon: "\u2726", cls: "ti-Skill" },
};

function getToolIcon(name) {
  return TOOL_ICONS[name] || { icon: "\u2022", cls: "" };
}

// Tool bar colors
const TOOL_COLORS = {
  Bash: "var(--green)", Read: "var(--blue)", Edit: "var(--amber)",
  Write: "var(--purple)", Grep: "var(--cyan)", Glob: "var(--cyan)",
  Agent: "var(--gold)", Skill: "var(--purple)",
};

// ── Elapsed Timer ────────────────────────────────────────────
function startElapsedTimer(startedIso) {
  if (elapsedInterval) clearInterval(elapsedInterval);
  if (!startedIso) { setText("elapsed-timer", "--:--"); return; }

  runStartedAt = new Date(startedIso).getTime();
  function tick() {
    const elapsed = Date.now() - runStartedAt;
    setText("elapsed-timer", fmtElapsed(elapsed));
  }
  tick();
  elapsedInterval = setInterval(tick, 1000);
}

function stopElapsedTimer() {
  if (elapsedInterval) { clearInterval(elapsedInterval); elapsedInterval = null; }
  setText("elapsed-timer", "--:--");
}

// ── Renderers ────────────────────────────────────────────────

function renderGlobalProgress(taskProgress) {
  if (!taskProgress) return;
  const { done, total, percent } = taskProgress;
  const fill = $("#global-progress-fill");
  const label = $("#global-progress-label");
  if (fill) fill.style.width = percent + "%";
  if (label) label.textContent = `${done}/${total} tasks (${percent}%)`;
}

function renderEpics(epics) {
  allEpics = epics;
  const grid = $("#epic-grid");
  if (!epics.length) { grid.textContent = "No epics found"; return; }

  const cards = epics.map(e => {
    const done = e.taskCounts?.done || 0;
    const ip = e.taskCounts?.in_progress || 0;
    const blocked = e.taskCounts?.blocked || 0;
    const todo = Math.max(0, (e.taskTotal || 0) - done - ip - blocked);
    const isActive = e.id === selectedEpic;
    const isDone = done === e.taskTotal && e.taskTotal > 0;
    const cost = epicCosts[e.id];

    const barSpans = [];
    if (done) barSpans.push(el("span", { className: "bar-done", style: `flex:${done}` }));
    if (ip) barSpans.push(el("span", { className: "bar-in_progress", style: `flex:${ip}` }));
    if (blocked) barSpans.push(el("span", { className: "bar-blocked", style: `flex:${blocked}` }));
    if (todo > 0) barSpans.push(el("span", { className: "bar-todo", style: `flex:${todo}` }));

    // Status badge
    let statusBadge = null;
    if (e.completion_review_status === "ship") {
      statusBadge = el("span", { className: "epic-status-badge badge-ship" }, "SHIP");
    } else if (isDone) {
      statusBadge = el("span", { className: "epic-status-badge badge-done" }, "DONE");
    } else if (ip > 0) {
      statusBadge = el("span", { className: "epic-status-badge badge-in_progress" }, "WIP");
    } else if (blocked > 0) {
      statusBadge = el("span", { className: "epic-status-badge badge-blocked" }, "BLOCKED");
    }

    const epicId = e.id;
    return el("div", {
      className: `epic-card${isActive ? " active" : ""}${isDone ? " done" : ""}`,
      onclick: () => selectEpic(epicId),
    }, [
      el("div", { className: "epic-id" }, e.id),
      el("div", { className: "epic-title", title: e.title }, e.title),
      el("div", { className: "epic-bar" }, barSpans),
      el("div", { className: "epic-meta" }, [
        el("span", { className: "epic-count" }, `${done}/${e.taskTotal}`),
        cost != null ? el("span", { className: "epic-cost" }, fmt$(cost)) : null,
        statusBadge,
      ]),
    ]);
  });
  clear(grid);
  cards.forEach(c => grid.appendChild(c));
}

async function selectEpic(epicId) {
  selectedEpic = epicId;
  renderEpics(allEpics);

  const zone = $("#task-detail-zone");
  zone.style.display = "block";

  const epic = allEpics.find(e => e.id === epicId);
  setText("task-detail-title", `TASKS \u2014 ${epicId}${epic ? " \u2014 " + epic.title : ""}`);

  const detail = $("#task-detail");
  detail.textContent = "Loading...";

  const tasks = await fetchJson(`/api/tasks/${encodeURIComponent(epicId)}`);
  if (!tasks || !tasks.length) { detail.textContent = "No tasks"; return; }

  const items = tasks.map(t => {
    const evidenceBadges = [];
    if (t.evidence) {
      if (t.evidence.commits?.length) evidenceBadges.push(el("span", {}, `${t.evidence.commits.length} commits`));
      if (t.evidence.tests?.length) evidenceBadges.push(el("span", {}, `${t.evidence.tests.length} tests`));
      if (t.evidence.prs?.length) evidenceBadges.push(el("span", {}, `${t.evidence.prs.length} PRs`));
    }

    let statusCls = "text-dim";
    if (t.status === "done") statusCls = "green";
    else if (t.status === "in_progress") statusCls = "amber";
    else if (t.status === "blocked") statusCls = "red";

    return el("div", { className: "task-item" }, [
      el("span", { className: `task-dot ${t.status}` }),
      el("span", { className: "task-id" }, t.id),
      el("span", { className: "task-title", title: t.title }, t.title),
      el("span", { className: `task-status ${statusCls}` }, t.status),
      evidenceBadges.length ? el("span", { className: "task-evidence" }, evidenceBadges) : null,
    ]);
  });

  clear(detail);
  items.forEach(i => detail.appendChild(i));
}

function renderStatus(status) {
  const badge = $("#status-badge");
  if (status.active) {
    badge.textContent = "RUNNING";
    badge.className = "status-badge running";
    startElapsedTimer(status.started);
  } else {
    badge.textContent = "IDLE";
    badge.className = "status-badge idle";
    stopElapsedTimer();
  }

  const taskEl = $("#status-task");
  if (status.currentTask) {
    taskEl.textContent = status.currentTask;
  } else {
    taskEl.textContent = "";
  }

  setText("iter-count", status.iteration ? `iter ${status.iteration}` : "iter \u2014");
  setText("cost-total", fmt$(status.totalCost));

  // Current task panel
  const ctPanel = $("#current-task-info");
  if (status.active && status.currentTask) {
    const nodes = [
      el("div", { className: "ct-id" }, status.currentTask),
    ];
    if (status.currentEpic) {
      nodes.push(el("div", { className: "ct-meta" }, [
        el("span", {}, "Epic: "),
        el("span", { className: "val" }, status.currentEpic),
        el("span", { style: "margin-left:8px" }, "Iter: "),
        el("span", { className: "val" }, String(status.iteration || "\u2014")),
        status.verdict ? el("span", { style: "margin-left:8px" }) : null,
        status.verdict ? el("span", { className: `verdict-${status.verdict}`, style: "font-weight:700" }, status.verdict) : null,
      ]));
    }
    clear(ctPanel);
    nodes.forEach(n => ctPanel.appendChild(n));
  } else {
    clear(ctPanel);
    ctPanel.appendChild(el("span", { className: "text-dim" }, "Idle"));
  }
}

function renderToolFeed(tools) {
  if (!tools || !tools.length) return;

  for (const t of tools) {
    toolFeedBuffer.push(t);
  }
  if (toolFeedBuffer.length > MAX_TOOL_FEED) {
    toolFeedBuffer = toolFeedBuffer.slice(-MAX_TOOL_FEED);
  }

  const feed = $("#tool-feed");
  clear(feed);

  const entries = toolFeedBuffer.slice().reverse();
  for (const t of entries) {
    const icon = getToolIcon(t.name);
    feed.appendChild(el("div", { className: "tool-entry" }, [
      el("span", { className: `tool-icon ${icon.cls}` }, icon.icon),
      el("span", { className: "tool-name" }, t.name),
      el("span", { className: "tool-summary", title: t.summary }, t.summary || ""),
    ]));
  }
}

function renderToolDist(toolCounts) {
  if (!toolCounts) return;
  const dist = $("#tool-dist");
  const entries = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) { dist.textContent = "No data"; return; }

  const max = entries[0][1] || 1;
  clear(dist);

  for (const [name, count] of entries.slice(0, 10)) {
    const pct = ((count / max) * 100).toFixed(0);
    const color = TOOL_COLORS[name] || "var(--text-dim)";
    dist.appendChild(el("div", { className: "td-row" }, [
      el("span", { className: "td-name" }, name),
      el("div", { className: "td-bar" }, [
        el("div", { className: "td-bar-fill", style: `width:${pct}%;background:${color}` }),
      ]),
      el("span", { className: "td-count" }, String(count)),
    ]));
  }
}

function renderSubagents(agents) {
  const list = $("#subagent-list");
  if (!agents || !agents.length) {
    clear(list);
    list.appendChild(el("span", { className: "text-dim" }, "None"));
    return;
  }

  clear(list);
  for (const a of agents) {
    list.appendChild(el("div", { className: "sa-entry" }, [
      el("div", { className: "sa-header" }, [
        el("span", { className: "sa-icon" }, "\u25c8"),
        el("span", { className: "sa-type" }, a.type || "agent"),
        el("span", { className: `sa-status ${a.status}` }, a.status),
      ]),
      el("div", { className: "sa-prompt" }, a.prompt_summary || a.summary || ""),
      a.tokens || a.toolUses || a.durationMs ? el("div", { className: "sa-meta" }, [
        a.toolUses ? el("span", {}, `${a.toolUses} tools`) : null,
        a.tokens ? el("span", {}, fmtTokens(a.tokens) + " tokens") : null,
        a.durationMs ? el("span", {}, fmtDuration(a.durationMs)) : null,
      ]) : null,
    ]));
  }
}

function renderSubagentStats(agents) {
  if (!agents) return;
  const completed = agents.filter(a => a.status === "completed").length;
  const running = agents.filter(a => a.status === "running").length;
  const totalTokens = agents.reduce((s, a) => s + (a.tokens || 0), 0);

  setText("sa-dispatched", String(agents.length));
  setText("sa-completed", String(completed));
  setText("sa-running", String(running));
  setText("sa-tokens", fmtTokens(totalTokens));
}

function renderCosts(costs, tokens) {
  if (costs) {
    setText("cost-run", fmt$(costs.thisRun));
    setText("cost-iter", fmt$(costs.thisIter));

    const hit = costs.cacheHit;
    if (hit != null) {
      setText("cache-hit-val", hit.toFixed(1) + "%");
      const bar = $("#cache-bar-fill");
      if (bar) bar.style.width = hit.toFixed(0) + "%";
    }
  }

  if (tokens) {
    setText("cost-all", fmt$(tokens.totalCost));
    setText("cost-total", fmt$(tokens.totalCost));

    epicCosts = tokens.perEpic || {};

    const mb = $("#model-breakdown");
    const models = Object.entries(tokens.modelBreakdown || {});
    if (!models.length) {
      clear(mb);
      mb.appendChild(el("span", { className: "text-dim" }, "\u2014"));
      return;
    }
    clear(mb);
    for (const [name, data] of models) {
      const shortName = name.replace("claude-", "").replace(/-\d+$/, "");
      mb.appendChild(el("div", { className: "model-entry" }, [
        el("div", { className: "model-name" }, shortName),
        el("div", { className: "model-stats" }, [
          el("span", {}, fmt$(data.cost)),
          el("span", {}, fmtTokens(data.inputTokens) + " in"),
          el("span", {}, fmtTokens(data.outputTokens) + " out"),
          el("span", {}, fmtTokens(data.cacheReads) + " cache"),
        ]),
      ]));
    }
  }
}

function renderErrors(errors) {
  const panel = $("#error-panel");
  const feed = $("#error-feed");
  if (!errors || !errors.length) {
    panel.style.display = "none";
    return;
  }
  panel.style.display = "block";
  clear(feed);
  for (const err of errors) {
    feed.appendChild(el("div", { className: "error-entry" }, err));
  }
}

function renderTimeline(run) {
  const container = $("#timeline");
  if (!run || !run.iterations?.length) { container.textContent = "No iterations"; return; }

  clear(container);
  const iters = run.iterations.slice().reverse().slice(0, 40);
  for (const iter of iters) {
    const cost = run.iterCosts?.[iter.iter - 1];
    container.appendChild(el("div", { className: "timeline-entry" }, [
      el("span", { className: "time" }, fmtTime(iter.timestamp)),
      el("span", { className: "iter" }, `iter ${iter.iter}`),
      el("span", { className: "task" }, iter.task || iter.epic || "\u2014"),
      el("span", { className: "cost" }, cost != null ? fmt$(cost) : ""),
      el("span", {
        className: `verdict ${iter.verdict ? "verdict-" + iter.verdict : ""}`,
      }, iter.verdict || "\u2014"),
    ]));
  }
}

function renderRuns(runs) {
  const list = $("#run-history");
  if (!runs || !runs.length) { list.textContent = "No runs"; return; }

  clear(list);
  for (const r of runs.slice(0, 15)) {
    list.appendChild(el("div", {
      className: "run-item",
      onclick: () => loadRunDetail(r.id),
    }, [
      el("span", { className: "run-id" }, r.id),
      el("span", { className: "run-iters" }, `${r.iterCount} iters`),
      el("span", { className: `run-verdict ${r.lastVerdict ? "verdict-" + r.lastVerdict : ""}` }, r.lastVerdict || "\u2014"),
      el("span", { className: "run-cost" }, fmt$(r.totalCost)),
    ]));
  }
}

async function loadRunDetail(runId) {
  const detail = await fetchJson(`/api/runs/${encodeURIComponent(runId)}`);
  if (detail) renderTimeline(detail);
}

// ── Data Loading ─────────────────────────────────────────────

async function loadAll() {
  const [epics, status, runs, tokens, live] = await Promise.all([
    fetchJson("/api/epics"),
    fetchJson("/api/status"),
    fetchJson("/api/runs"),
    fetchJson("/api/tokens"),
    fetchJson("/api/live"),
  ]);

  if (epics) {
    if (tokens) epicCosts = tokens.perEpic || {};
    renderEpics(epics);

    let done = 0, total = 0;
    for (const e of epics) {
      total += e.taskTotal || 0;
      done += e.taskCounts?.done || 0;
    }
    renderGlobalProgress({ done, total, percent: total ? Math.round((done / total) * 100) : 0 });
  }

  if (status) renderStatus(status);
  if (runs) {
    renderRuns(runs);
    if (runs[0]) loadRunDetail(runs[0].id);
  }
  if (tokens) renderCosts(null, tokens);

  if (live && live.active && live.deep) {
    const deep = live.deep;
    toolFeedBuffer = deep.toolCalls.slice(-MAX_TOOL_FEED).map(t => ({
      name: t.name,
      summary: t.input_summary,
    }));
    renderToolFeed([]);
    renderToolDist(deep.toolCounts);
    renderSubagents(deep.subagents);
    renderSubagentStats(deep.subagents);
    renderErrors(deep.errors);
    renderCosts({
      thisRun: live.totalCost,
      thisIter: deep.totalCostUsd,
      cacheHit: deep.cacheHitRate,
    }, null);
  }
}

// ── SSE Connection ───────────────────────────────────────────

function connectSSE() {
  const statusEl = $("#connection-status");
  statusEl.textContent = "Connecting...";

  const evtSource = new EventSource("/api/events");

  evtSource.onopen = () => {
    statusEl.textContent = "Connected";
    statusEl.style.color = "var(--green)";
  };

  evtSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "connected") return;

      if (data.type === "update") {
        if (data.status) renderStatus(data.status);
        if (data.taskProgress) renderGlobalProgress(data.taskProgress);
        if (data.toolFeed?.length) renderToolFeed(data.toolFeed);
        if (data.toolCounts) renderToolDist(data.toolCounts);
        if (data.agents) renderSubagents(data.agents);
        if (data.costs) renderCosts(data.costs, null);

        // Periodic full reload for consistency
        if (Math.random() < 0.1) {
          fetchJson("/api/epics").then(epics => { if (epics) renderEpics(epics); });
          fetchJson("/api/tokens").then(tokens => { if (tokens) renderCosts(null, tokens); });
        }
      }
    } catch {}
  };

  evtSource.onerror = () => {
    statusEl.textContent = "Disconnected";
    statusEl.style.color = "var(--red)";
    evtSource.close();
    setTimeout(connectSSE, 3000);
  };
}

// ── Init ─────────────────────────────────────────────────────
loadAll();
connectSSE();
