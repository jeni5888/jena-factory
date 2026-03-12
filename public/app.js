// JENA-FACTORY Client — DOM-safe rendering (no innerHTML with untrusted data)
const $ = (sel) => document.querySelector(sel);

let selectedEpic = null;
let allEpics = [];

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

function fmt$(n) { return "$" + (n || 0).toFixed(2); }

function fmtTime(iso) {
  if (!iso) return "\u2014";
  try { return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }); }
  catch { return iso; }
}

function fmtDate(iso) {
  if (!iso) return "\u2014";
  try { const d = new Date(iso); return d.toLocaleDateString("de-DE") + " " + d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }); }
  catch { return iso; }
}

// Safe DOM helpers
function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (k === "className") node.className = v;
    else if (k === "onclick") node.addEventListener("click", v);
    else if (k === "title") node.title = v;
    else if (k === "style") node.style.cssText = v;
    else node.setAttribute(k, v);
  }
  if (children) {
    if (typeof children === "string") node.textContent = children;
    else if (Array.isArray(children)) children.forEach(c => { if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    else node.appendChild(children);
  }
  return node;
}

function clearAndAppend(parent, nodes) {
  parent.textContent = "";
  if (Array.isArray(nodes)) nodes.forEach(n => parent.appendChild(n));
  else parent.appendChild(nodes);
}

// Epic grid
function renderEpics(epics) {
  allEpics = epics;
  const grid = $("#epic-grid");
  if (!epics.length) { grid.textContent = "No epics found"; return; }

  const cards = epics.map(e => {
    const done = e.taskCounts?.done || 0;
    const ip = e.taskCounts?.in_progress || 0;
    const blocked = e.taskCounts?.blocked || 0;
    const todo = e.taskTotal - done - ip - blocked;
    const isActive = e.id === selectedEpic;

    const barSpans = [];
    if (done) barSpans.push(el("span", { className: "bar-done", style: `flex:${done}` }));
    if (ip) barSpans.push(el("span", { className: "bar-in_progress", style: `flex:${ip}` }));
    if (blocked) barSpans.push(el("span", { className: "bar-blocked", style: `flex:${blocked}` }));
    if (todo > 0) barSpans.push(el("span", { className: "bar-todo", style: `flex:${todo}` }));

    const epicId = e.id;
    return el("div", { className: `epic-card${isActive ? " active" : ""}`, onclick: () => selectEpic(epicId) }, [
      el("div", { className: "epic-id" }, e.id),
      el("div", { className: "epic-title", title: e.title }, e.title),
      el("div", { className: "epic-bar" }, barSpans),
      el("div", { className: "epic-count" }, `${done}/${e.taskTotal} done`),
    ]);
  });
  clearAndAppend(grid, cards);
}

async function selectEpic(epicId) {
  selectedEpic = epicId;
  renderEpics(allEpics);
  const taskList = $("#task-list");
  taskList.textContent = "Loading...";

  const tasks = await fetchJson(`/api/tasks/${encodeURIComponent(epicId)}`);
  if (!tasks || !tasks.length) { taskList.textContent = "No tasks"; return; }

  const items = tasks.map(t =>
    el("div", { className: "task-item" }, [
      el("span", { className: `task-dot ${t.status}` }),
      el("span", { className: "task-id" }, t.id),
      el("span", { className: "task-title" }, t.title),
    ])
  );
  clearAndAppend(taskList, items);
}

function renderStatus(status) {
  const badge = $("#status-badge");
  if (status.active) {
    badge.textContent = "RUNNING";
    badge.className = "status-badge running pulse";
  } else {
    badge.textContent = "IDLE";
    badge.className = "status-badge idle";
  }

  setText("run-id", status.runId || "\u2014");
  setText("run-task", status.currentTask || "\u2014");
  setText("run-epic", status.currentEpic || "\u2014");
  setText("run-iter", status.iteration || "\u2014");

  const verdictEl = $("#run-verdict");
  verdictEl.textContent = status.verdict || "\u2014";
  verdictEl.className = "value" + (status.verdict ? ` verdict-${status.verdict}` : "");

  setText("run-started", fmtDate(status.started));
  setText("run-cost", fmt$(status.totalCost));
}

function setText(id, text) {
  const node = document.getElementById(id);
  if (node) node.textContent = text;
}

function renderRuns(runs) {
  const list = $("#runs-list");
  if (!runs.length) { list.textContent = "No runs"; return; }

  const items = runs.slice(0, 10).map(r =>
    el("div", { className: "run-item", onclick: () => window.open(`/api/runs/${encodeURIComponent(r.id)}`, "_blank") }, [
      el("span", { className: "run-id" }, r.id),
      el("span", { className: "run-iters" }, `${r.iterCount} iters`),
      el("span", { className: "run-cost" }, fmt$(r.totalCost)),
    ])
  );
  clearAndAppend(list, items);
}

function renderCosts(tokens) {
  if (!tokens) return;
  setText("cost-all", fmt$(tokens.totalCost));
  $("#cost-total").textContent = fmt$(tokens.totalCost);

  const epicDiv = $("#cost-per-epic");
  const entries = Object.entries(tokens.perEpic || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) { epicDiv.textContent = "No data"; return; }

  const maxCost = entries[0]?.[1] || 1;
  const nodes = entries.slice(0, 10).flatMap(([epic, cost]) => [
    el("div", { className: "cost-row" }, [
      el("span", { className: "label" }, epic),
      el("span", { className: "value" }, fmt$(cost)),
    ]),
    (() => {
      const bar = el("div", { className: "cost-bar" });
      bar.appendChild(el("div", { className: "cost-bar-fill", style: `width:${((cost / maxCost) * 100).toFixed(0)}%` }));
      return bar;
    })(),
  ]);
  clearAndAppend(epicDiv, nodes);
}

function renderTimeline(run) {
  const container = $("#timeline");
  if (!run || !run.iterations?.length) { container.textContent = "No iterations"; return; }

  const items = run.iterations.slice().reverse().slice(0, 30).map(iter =>
    el("div", { className: "timeline-entry" }, [
      el("span", { className: "time" }, fmtTime(iter.timestamp)),
      el("span", { className: "iter" }, `iter ${iter.iter}`),
      el("span", { className: "task" }, iter.task || iter.epic || "\u2014"),
      el("span", { className: `verdict ${iter.verdict ? "verdict-" + iter.verdict : ""}` }, iter.verdict || "\u2014"),
    ])
  );
  clearAndAppend(container, items);
}

async function loadAll() {
  const [epics, status, runs, tokens] = await Promise.all([
    fetchJson("/api/epics"),
    fetchJson("/api/status"),
    fetchJson("/api/runs"),
    fetchJson("/api/tokens"),
  ]);

  if (epics) renderEpics(epics);
  if (status) renderStatus(status);
  if (runs) {
    renderRuns(runs);
    if (runs[0]) {
      const detail = await fetchJson(`/api/runs/${encodeURIComponent(runs[0].id)}`);
      if (detail) renderTimeline(detail);
    }
  }
  if (tokens) renderCosts(tokens);
}

function connectSSE() {
  const evtSource = new EventSource("/api/events");
  evtSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "update") loadAll();
    } catch {}
  };
  evtSource.onerror = () => { evtSource.close(); setTimeout(connectSSE, 5000); };
}

loadAll();
connectSSE();
