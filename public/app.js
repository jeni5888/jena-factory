// JenaAI-Factory Client — Mission Control Dashboard
const $ = (sel) => document.querySelector(sel);

// ── State ────────────────────────────────────────────────────
let selectedEpic = null;
let allEpics = [];
let epicCosts = {};
let runStartedAt = null;
let elapsedInterval = null;
let toolFeedBuffer = [];
let turnSnapshotBuffer = [];
let iterCostHistory = []; // [{iter, cost, verdict, task}]
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

const TOOL_ICONS = {
  Bash: { icon: "$", cls: "ti-Bash" }, Read: { icon: "\u25b8", cls: "ti-Read" },
  Edit: { icon: "\u270e", cls: "ti-Edit" }, Write: { icon: "\u2713", cls: "ti-Write" },
  Grep: { icon: "\u2315", cls: "ti-Grep" }, Glob: { icon: "\u25c8", cls: "ti-Glob" },
  Agent: { icon: "\u25c8", cls: "ti-Agent" }, Skill: { icon: "\u2726", cls: "ti-Skill" },
};
function getToolIcon(name) { return TOOL_ICONS[name] || { icon: "\u2022", cls: "" }; }

const TOOL_COLORS = {
  Bash: "#22c55e", Read: "#3b82f6", Edit: "#f59e0b",
  Write: "#a855f7", Grep: "#06b6d4", Glob: "#06b6d4",
  Agent: "#fbbf24", Skill: "#a855f7",
};

// ── Canvas Chart Helpers ─────────────────────────────────────

function getCanvasCtx(id) {
  const canvas = document.getElementById(id);
  if (!canvas) return null;
  // Set canvas resolution to match display size
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * (window.devicePixelRatio || 1);
  canvas.height = rect.height * (window.devicePixelRatio || 1);
  const ctx = canvas.getContext("2d");
  ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
  return { ctx, w: rect.width, h: rect.height };
}

/** Draw a heartbeat/EKG-style chart */
function drawHeartbeat(canvasId, data, color, fillColor) {
  const c = getCanvasCtx(canvasId);
  if (!c || !data.length) return;
  const { ctx, w, h } = c;

  ctx.clearRect(0, 0, w, h);

  const maxVal = Math.max(...data, 0.001);
  const barW = Math.max(1, (w - 4) / data.length - 1);
  const padBottom = 14;
  const chartH = h - padBottom;

  // Grid lines
  ctx.strokeStyle = "rgba(55,65,81,0.3)";
  ctx.lineWidth = 0.5;
  for (let i = 1; i <= 3; i++) {
    const y = (chartH / 4) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  // Draw line
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";

  for (let i = 0; i < data.length; i++) {
    const x = 2 + i * ((w - 4) / data.length) + barW / 2;
    const y = chartH - (data[i] / maxVal) * (chartH - 4);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Fill under the line
  if (fillColor) {
    const lastX = 2 + (data.length - 1) * ((w - 4) / data.length) + barW / 2;
    ctx.lineTo(lastX, chartH);
    ctx.lineTo(2 + barW / 2, chartH);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();
  }

  // Glow dot at the end
  if (data.length > 0) {
    const lastI = data.length - 1;
    const lastX = 2 + lastI * ((w - 4) / data.length) + barW / 2;
    const lastY = chartH - (data[lastI] / maxVal) * (chartH - 4);
    ctx.beginPath();
    ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(lastX, lastY, 6, 0, Math.PI * 2);
    ctx.fillStyle = color.replace(")", ",0.2)").replace("rgb", "rgba");
    ctx.fill();
  }

  // Labels
  ctx.fillStyle = "#6B7280";
  ctx.font = "9px monospace";
  ctx.textAlign = "left";
  ctx.fillText(fmt$(maxVal), 2, 10);
  ctx.textAlign = "right";
  ctx.fillText(data.length + " turns", w - 2, h - 2);
}

/** Draw a bar chart for iteration costs */
function drawIterCostBars(canvasId, iters) {
  const c = getCanvasCtx(canvasId);
  if (!c || !iters.length) return;
  const { ctx, w, h } = c;

  ctx.clearRect(0, 0, w, h);

  const maxCost = Math.max(...iters.map(i => i.cost || 0), 0.01);
  const barW = Math.max(3, Math.min(20, (w - 20) / iters.length - 2));
  const padBottom = 16;
  const chartH = h - padBottom;

  // Grid
  ctx.strokeStyle = "rgba(55,65,81,0.3)";
  ctx.lineWidth = 0.5;
  for (let i = 1; i <= 3; i++) {
    const y = (chartH / 4) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  const totalW = iters.length * (barW + 2);
  const offsetX = Math.max(0, (w - totalW) / 2);

  for (let i = 0; i < iters.length; i++) {
    const it = iters[i];
    const barH = Math.max(1, (it.cost / maxCost) * (chartH - 4));
    const x = offsetX + i * (barW + 2);
    const y = chartH - barH;

    // Color by verdict
    let clr = "#3b82f6"; // blue default
    if (it.verdict === "SHIP") clr = "#22c55e";
    else if (it.verdict === "REWORK") clr = "#f59e0b";
    else if (it.verdict === "BLOCKED" || it.verdict === "STOP") clr = "#ef4444";

    // Bar
    ctx.fillStyle = clr;
    ctx.beginPath();
    ctx.roundRect(x, y, barW, barH, 1);
    ctx.fill();

    // Glow for the latest bar
    if (i === iters.length - 1) {
      ctx.shadowColor = clr;
      ctx.shadowBlur = 8;
      ctx.fillStyle = clr;
      ctx.beginPath();
      ctx.roundRect(x, y, barW, barH, 1);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  // Labels
  ctx.fillStyle = "#6B7280";
  ctx.font = "9px monospace";
  ctx.textAlign = "left";
  ctx.fillText(fmt$(maxCost), 2, 10);
  ctx.textAlign = "right";
  const totalCost = iters.reduce((s, i) => s + (i.cost || 0), 0);
  ctx.fillText(`${iters.length} iters \u2022 ${fmt$(totalCost)} total`, w - 4, h - 2);

  // Verdict legend
  ctx.textAlign = "left";
  const legend = [
    { label: "SHIP", color: "#22c55e" },
    { label: "REWORK", color: "#f59e0b" },
    { label: "BLOCKED", color: "#ef4444" },
  ];
  let lx = 4;
  const ly = h - 2;
  for (const l of legend) {
    ctx.fillStyle = l.color;
    ctx.fillRect(lx, ly - 6, 6, 6);
    lx += 8;
    ctx.fillStyle = "#6B7280";
    ctx.fillText(l.label, lx, ly);
    lx += ctx.measureText(l.label).width + 8;
  }
}

/** Draw cumulative cost line chart */
function drawCumulativeCost(canvasId, snapshots) {
  const c = getCanvasCtx(canvasId);
  if (!c || !snapshots.length) return;
  const { ctx, w, h } = c;

  ctx.clearRect(0, 0, w, h);

  const costs = snapshots.map(s => s.cumulativeCost);
  const maxCost = Math.max(...costs, 0.001);
  const padBottom = 14;
  const chartH = h - padBottom;

  // Grid
  ctx.strokeStyle = "rgba(55,65,81,0.3)";
  ctx.lineWidth = 0.5;
  for (let i = 1; i <= 3; i++) {
    const y = (chartH / 4) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  // Area fill
  ctx.beginPath();
  for (let i = 0; i < costs.length; i++) {
    const x = (i / (costs.length - 1 || 1)) * (w - 4) + 2;
    const y = chartH - (costs[i] / maxCost) * (chartH - 4);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  const lastX = ((costs.length - 1) / (costs.length - 1 || 1)) * (w - 4) + 2;
  ctx.lineTo(lastX, chartH);
  ctx.lineTo(2, chartH);
  ctx.closePath();
  const gradient = ctx.createLinearGradient(0, 0, 0, chartH);
  gradient.addColorStop(0, "rgba(251,191,36,0.3)");
  gradient.addColorStop(1, "rgba(251,191,36,0.02)");
  ctx.fillStyle = gradient;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.strokeStyle = "#fbbf24";
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  for (let i = 0; i < costs.length; i++) {
    const x = (i / (costs.length - 1 || 1)) * (w - 4) + 2;
    const y = chartH - (costs[i] / maxCost) * (chartH - 4);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Glow dot at end
  if (costs.length > 0) {
    const lx = ((costs.length - 1) / (costs.length - 1 || 1)) * (w - 4) + 2;
    const ly = chartH - (costs[costs.length - 1] / maxCost) * (chartH - 4);
    ctx.beginPath();
    ctx.arc(lx, ly, 3, 0, Math.PI * 2);
    ctx.fillStyle = "#fbbf24";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(lx, ly, 6, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(251,191,36,0.2)";
    ctx.fill();
  }

  // Labels
  ctx.fillStyle = "#6B7280";
  ctx.font = "9px monospace";
  ctx.textAlign = "left";
  ctx.fillText(fmt$(maxCost), 2, 10);
  ctx.textAlign = "right";
  ctx.fillText(fmt$(costs[costs.length - 1] || 0) + " current", w - 2, h - 2);
}

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

    let statusBadge = null;
    if (e.completion_review_status === "ship") statusBadge = el("span", { className: "epic-status-badge badge-ship" }, "SHIP");
    else if (isDone) statusBadge = el("span", { className: "epic-status-badge badge-done" }, "DONE");
    else if (ip > 0) statusBadge = el("span", { className: "epic-status-badge badge-in_progress" }, "WIP");
    else if (blocked > 0) statusBadge = el("span", { className: "epic-status-badge badge-blocked" }, "BLOCKED");

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
  taskEl.textContent = status.currentTask || "";
  setText("iter-count", status.iteration ? `iter ${status.iteration}` : "iter \u2014");
  setText("cost-total", fmt$(status.totalCost));

  // Cost rate ($/min)
  if (runStartedAt && status.totalCost > 0) {
    const elapsedMin = (Date.now() - runStartedAt) / 60000;
    if (elapsedMin > 0.5) {
      setText("cost-rate", fmt$(status.totalCost / elapsedMin) + "/min");
    }
  }

  const ctPanel = $("#current-task-info");
  if (status.active && status.currentTask) {
    const nodes = [el("div", { className: "ct-id" }, status.currentTask)];
    if (status.currentEpic) {
      nodes.push(el("div", { className: "ct-meta" }, [
        el("span", {}, "Epic: "), el("span", { className: "val" }, status.currentEpic),
        el("span", { style: "margin-left:8px" }, "Iter: "), el("span", { className: "val" }, String(status.iteration || "\u2014")),
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
  for (const t of tools) toolFeedBuffer.push(t);
  if (toolFeedBuffer.length > MAX_TOOL_FEED) toolFeedBuffer = toolFeedBuffer.slice(-MAX_TOOL_FEED);

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
    const color = TOOL_COLORS[name] || "#6B7280";
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
    clear(list); list.appendChild(el("span", { className: "text-dim" }, "None")); return;
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
    if (!models.length) { clear(mb); mb.appendChild(el("span", { className: "text-dim" }, "\u2014")); return; }
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
  if (!errors || !errors.length) { panel.style.display = "none"; return; }
  panel.style.display = "block";
  clear(feed);
  for (const err of errors) feed.appendChild(el("div", { className: "error-entry" }, err));
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
      el("span", { className: `verdict ${iter.verdict ? "verdict-" + iter.verdict : ""}` }, iter.verdict || "\u2014"),
    ]));
  }

  // Build iteration cost history for the bar chart
  iterCostHistory = run.iterations.map((it, i) => ({
    iter: it.iter,
    cost: run.iterCosts?.[i] || 0,
    verdict: it.verdict || "",
    task: it.task || "",
  }));
  drawIterCostBars("chart-iter-costs", iterCostHistory);
}

function renderRuns(runs) {
  const list = $("#run-history");
  if (!runs || !runs.length) { list.textContent = "No runs"; return; }
  clear(list);
  for (const r of runs.slice(0, 15)) {
    list.appendChild(el("div", { className: "run-item", onclick: () => loadRunDetail(r.id) }, [
      el("span", { className: "run-id" }, r.id),
      el("span", { className: "run-iters" }, `${r.iterCount} iters`),
      el("span", { className: `run-verdict ${r.lastVerdict ? "verdict-" + r.lastVerdict : ""}` }, r.lastVerdict || "\u2014"),
      el("span", { className: "run-cost" }, fmt$(r.totalCost)),
    ]));
  }
}

/** Render charts from turn snapshot data */
function renderCharts(snapshots) {
  if (!snapshots || !snapshots.length) return;
  turnSnapshotBuffer = snapshots;

  // Heartbeat: cost per turn
  const costPerTurn = snapshots.map(s => s.costEstimate || 0);
  setText("heartbeat-label", `${snapshots.length} turns`);
  drawHeartbeat("chart-heartbeat", costPerTurn, "#22c55e", "rgba(34,197,94,0.08)");

  // Cumulative cost
  setText("cumcost-label", fmt$(snapshots[snapshots.length - 1]?.cumulativeCost || 0));
  drawCumulativeCost("chart-cumcost", snapshots);
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
    for (const e of epics) { total += e.taskTotal || 0; done += e.taskCounts?.done || 0; }
    renderGlobalProgress({ done, total, percent: total ? Math.round((done / total) * 100) : 0 });
  }
  if (status) renderStatus(status);
  if (runs) {
    renderRuns(runs);
    if (runs[0]) loadRunDetail(runs[0].id);
  }
  if (tokens) renderCosts(null, tokens);

  if (live && live.active !== false && live.deep) {
    const deep = live.deep;
    toolFeedBuffer = deep.toolCalls.slice(-MAX_TOOL_FEED).map(t => ({ name: t.name, summary: t.input_summary }));
    renderToolFeed([]);
    renderToolDist(deep.toolCounts);
    renderSubagents(deep.subagents);
    renderSubagentStats(deep.subagents);
    renderErrors(deep.errors);
    renderCosts({
      thisRun: live.totalCost,
      thisIter: deep.totalCostUsd || deep.estimatedCostUsd,
      cacheHit: deep.cacheHitRate,
    }, null);
    // Charts!
    if (deep.turnSnapshots?.length) {
      renderCharts(deep.turnSnapshots);
    }
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
        if (data.agents) { renderSubagents(data.agents); renderSubagentStats(data.agents); }
        if (data.costs) renderCosts(data.costs, null);
        if (data.turnSnapshots?.length) renderCharts(data.turnSnapshots);

        // Periodic full reload
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

// Redraw charts on resize
window.addEventListener("resize", () => {
  if (turnSnapshotBuffer.length) renderCharts(turnSnapshotBuffer);
  if (iterCostHistory.length) drawIterCostBars("chart-iter-costs", iterCostHistory);
});
