import { join } from "path";
import { statSync, readFileSync, existsSync } from "fs";
import { scanEpics, scanTasks, scanTasksWithState } from "./lib/scanner";
import { parseProgress, parseIterResult, parseIterDeep } from "./lib/parser";
import { aggregateCosts } from "./lib/cost";
import { Cache } from "./lib/cache";

const args = process.argv.slice(2);
let port = 4242;
let projectDir = process.env.PROJECT_DIR || "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && args[i + 1]) port = parseInt(args[i + 1], 10);
  if (args[i] === "--project-dir" && args[i + 1]) projectDir = args[i + 1];
}

if (!projectDir) {
  const cwd = process.cwd();
  if (existsSync(join(cwd, ".flow"))) {
    projectDir = cwd;
  } else {
    console.error("ERROR: No .flow/ directory found. Pass --project-dir or set PROJECT_DIR env.");
    process.exit(1);
  }
}

const flowDir = join(projectDir, ".flow");
const runsDir = join(projectDir, "scripts/ralph/runs");
const publicDir = join(import.meta.dir, "public");
const cache = new Cache();

console.log(`\x1b[36m╔══════════════════════════════════════╗\x1b[0m`);
console.log(`\x1b[36m║\x1b[0m  \x1b[1;35mJenaAI\x1b[1;33m-Factory\x1b[0m  Mission Control   \x1b[36m║\x1b[0m`);
console.log(`\x1b[36m╠══════════════════════════════════════╣\x1b[0m`);
console.log(`\x1b[36m║\x1b[0m  Project: ${projectDir.slice(-30).padEnd(26)} \x1b[36m║\x1b[0m`);
console.log(`\x1b[36m║\x1b[0m  Port:    ${String(port).padEnd(26)} \x1b[36m║\x1b[0m`);
console.log(`\x1b[36m╚══════════════════════════════════════╝\x1b[0m`);

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function serveStatic(path: string): Response | null {
  const filePath = join(publicDir, path === "/" ? "index.html" : path);
  try { statSync(filePath); } catch { return null; }
  const ext = filePath.split(".").pop() || "";
  const types: Record<string, string> = {
    html: "text/html", css: "text/css", js: "application/javascript",
    json: "application/json", png: "image/png", svg: "image/svg+xml",
  };
  return new Response(Bun.file(filePath), {
    headers: { "Content-Type": types[ext] || "application/octet-stream" },
  });
}

// SSE
const sseClients = new Set<ReadableStreamDefaultController>();

function broadcastSSE(data: unknown) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const controller of sseClients) {
    try { controller.enqueue(new TextEncoder().encode(msg)); }
    catch { sseClients.delete(controller); }
  }
}

// ── Data scanning ────────────────────────────────────────────

function scanRuns() {
  if (!existsSync(runsDir)) return [];
  const dirs = readdirSyncSafe(runsDir).sort().reverse();
  return dirs.map((id) => {
    const runPath = join(runsDir, id);
    const progress = parseProgress(join(runPath, "progress.txt"), cache);
    const receipts = scanReceipts(join(runPath, "receipts"));
    const branches = readJsonSafe(join(runPath, "branches.json"));

    // Scan iter costs AND model usage
    const iterCosts: number[] = [];
    const iterModelUsage: Array<Record<string, any> | null> = [];
    for (let i = 1; i <= Math.max(progress.iterations.length, 50); i++) {
      const logFile = join(runPath, `iter-${String(i).padStart(3, "0")}.log`);
      if (!existsSync(logFile)) break;
      const result = parseIterResult(logFile, cache);
      iterCosts.push(result?.total_cost_usd || 0);
      iterModelUsage.push(result?.modelUsage || null);
    }

    const totalCost = iterCosts.reduce((s, c) => s + c, 0);
    return { id, ...progress, receipts, branches, iterCosts, iterModelUsage, totalCost };
  });
}

function scanReceipts(dir: string): Array<{ id: string; verdict: string; type: string; review?: string }> {
  if (!existsSync(dir)) return [];
  return readdirSyncSafe(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJsonSafe(join(dir, f)))
    .filter(Boolean);
}

function getStatus(runs: ReturnType<typeof scanRuns>) {
  if (runs.length === 0) return { active: false };
  const latest = runs[0];
  const lastIter = latest.iterations[latest.iterations.length - 1];
  const hasRunningIter = latest.iterCosts.length > latest.iterations.length;
  const iterCount = Math.max(latest.iterations.length, latest.iterCosts.length);
  const isActive = hasRunningIter || (!!lastIter && !["BLOCKED", "STOP"].includes(lastIter.verdict || ""));

  return {
    active: isActive,
    runId: latest.id,
    currentTask: lastIter?.task || (hasRunningIter ? "working..." : undefined),
    currentEpic: lastIter?.epic,
    iteration: iterCount,
    verdict: lastIter?.verdict,
    started: latest.started,
    totalCost: latest.totalCost,
  };
}

function readdirSyncSafe(dir: string): string[] {
  try { return Array.from(new Bun.Glob("*").scanSync({ cwd: dir, onlyFiles: false })); }
  catch { return []; }
}

function readJsonSafe(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf-8")); }
  catch { return null; }
}

// ── Live data (deep parse of active iteration) ──────────────

function getLiveData() {
  const runs = scanRuns();
  const status = getStatus(runs);
  if (!status.active || !runs.length) return null;

  const latest = runs[0];
  const runPath = join(runsDir, latest.id);

  // Find the active iter-log (latest one)
  const iterCount = Math.max(latest.iterations.length, latest.iterCosts.length);
  let activeIterNum = iterCount;
  // Check if there's a log beyond known iterations
  for (let i = iterCount + 1; i <= iterCount + 2; i++) {
    const logFile = join(runPath, `iter-${String(i).padStart(3, "0")}.log`);
    if (existsSync(logFile)) activeIterNum = i;
  }

  const activeLogPath = join(runPath, `iter-${String(activeIterNum).padStart(3, "0")}.log`);
  const deep = parseIterDeep(activeLogPath, cache);

  return {
    status,
    deep,
    iterNum: activeIterNum,
  };
}

// ── SSE polling (2s) ─────────────────────────────────────────

let lastHash = "";
let lastLiveToolCount = 0;
setInterval(() => {
  try {
    const epics = scanEpics(flowDir, cache);
    const runs = scanRuns();
    const status = getStatus(runs);
    const live = getLiveData();

    // Build hash from status + tool count for change detection
    const toolCount = live?.deep?.toolCalls.length || 0;
    const hash = JSON.stringify({
      epics: epics.map((e) => e.status),
      status,
      tc: toolCount,
    });

    if (hash !== lastHash) {
      lastHash = hash;

      // Build SSE payload
      const payload: any = {
        type: "update",
        status,
        timestamp: new Date().toISOString(),
      };

      // Include live tool feed (last 8 new tools)
      if (live?.deep) {
        const newTools = live.deep.toolCalls.slice(lastLiveToolCount);
        payload.toolFeed = newTools.slice(-8).map(t => ({
          name: t.name,
          summary: t.input_summary,
        }));
        payload.agents = live.deep.subagents.filter(a => a.status === "running");
        payload.costs = {
          total: undefined, // Client already has this from initial load
          thisRun: status.totalCost,
          thisIter: live.deep.totalCostUsd,
          cacheHit: live.deep.cacheHitRate,
        };
        payload.toolCounts = live.deep.toolCounts;
        lastLiveToolCount = live.deep.toolCalls.length;
      }

      // Task progress
      const tasks = scanTasks(flowDir, cache);
      const done = tasks.filter(t => t.status === "done").length;
      payload.taskProgress = { done, total: tasks.length, percent: tasks.length ? Math.round((done / tasks.length) * 100) : 0 };

      broadcastSSE(payload);
    }
  } catch {}
}, 2000);

// ── HTTP Server ──────────────────────────────────────────────

Bun.serve({
  port,
  hostname: "0.0.0.0",
  fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // ── Existing API routes ──

    if (path === "/api/epics") {
      const epics = scanEpics(flowDir, cache);
      const tasks = scanTasks(flowDir, cache);
      const enriched = epics.map((epic) => {
        const epicTasks = tasks.filter((t) => t.epic === epic.id);
        const counts: Record<string, number> = {};
        for (const t of epicTasks) counts[t.status] = (counts[t.status] || 0) + 1;
        return { ...epic, taskCounts: counts, taskTotal: epicTasks.length };
      });
      return jsonResponse(enriched);
    }

    if (path.startsWith("/api/tasks/")) {
      const epicId = decodeURIComponent(path.slice("/api/tasks/".length));
      const tasks = scanTasksWithState(flowDir, cache).filter((t) => t.epic === epicId);
      return jsonResponse(tasks);
    }

    if (path === "/api/runs") {
      const runs = scanRuns();
      return jsonResponse(
        runs.map((r) => ({
          id: r.id,
          started: r.started,
          iterCount: Math.max(r.iterations.length, r.iterCosts.length),
          totalCost: r.totalCost,
          branches: r.branches,
          lastVerdict: r.iterations[r.iterations.length - 1]?.verdict,
        }))
      );
    }

    if (path.match(/^\/api\/runs\/[^/]+$/)) {
      const runId = decodeURIComponent(path.slice("/api/runs/".length));
      const runs = scanRuns();
      const run = runs.find((r) => r.id === runId);
      if (!run) return jsonResponse({ error: "Run not found" }, 404);
      return jsonResponse(run);
    }

    // ── NEW: Tool usage for a run ──
    if (path.match(/^\/api\/runs\/[^/]+\/tools$/)) {
      const runId = decodeURIComponent(path.slice("/api/runs/".length).replace("/tools", ""));
      const runPath = join(runsDir, runId);
      if (!existsSync(runPath)) return jsonResponse({ error: "Run not found" }, 404);

      const toolCounts: Record<string, number> = {};
      const allTools: Array<{ iter: number; name: string; summary: string }> = [];

      for (let i = 1; i <= 100; i++) {
        const logFile = join(runPath, `iter-${String(i).padStart(3, "0")}.log`);
        if (!existsSync(logFile)) break;
        const deep = parseIterDeep(logFile, cache);
        if (!deep) continue;
        for (const [name, count] of Object.entries(deep.toolCounts)) {
          toolCounts[name] = (toolCounts[name] || 0) + count;
        }
        for (const t of deep.toolCalls) {
          allTools.push({ iter: i, name: t.name, summary: t.input_summary });
        }
      }

      return jsonResponse({ toolCounts, recentTools: allTools.slice(-50) });
    }

    // ── NEW: Subagents for a run ──
    if (path.match(/^\/api\/runs\/[^/]+\/agents$/)) {
      const runId = decodeURIComponent(path.slice("/api/runs/".length).replace("/agents", ""));
      const runPath = join(runsDir, runId);
      if (!existsSync(runPath)) return jsonResponse({ error: "Run not found" }, 404);

      const agents: Array<any> = [];
      for (let i = 1; i <= 100; i++) {
        const logFile = join(runPath, `iter-${String(i).padStart(3, "0")}.log`);
        if (!existsSync(logFile)) break;
        const deep = parseIterDeep(logFile, cache);
        if (!deep) continue;
        for (const a of deep.subagents) {
          agents.push({ ...a, iter: i });
        }
      }

      return jsonResponse({ agents });
    }

    // ── NEW: Live data (active iteration deep parse) ──
    if (path === "/api/live") {
      const live = getLiveData();
      if (!live) return jsonResponse({ active: false });
      return jsonResponse({
        active: true,
        ...live.status,
        iterNum: live.iterNum,
        deep: live.deep,
      });
    }

    if (path === "/api/tokens") {
      const runs = scanRuns();
      return jsonResponse(aggregateCosts(runs));
    }

    if (path === "/api/status") {
      const runs = scanRuns();
      return jsonResponse(getStatus(runs));
    }

    if (path === "/api/events") {
      const stream = new ReadableStream({
        start(controller) {
          sseClients.add(controller);
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "connected" })}\n\n`));
        },
        cancel(controller) {
          sseClients.delete(controller);
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // Static files
    const staticResp = serveStatic(path);
    if (staticResp) return staticResp;

    if (!path.startsWith("/api/")) {
      return serveStatic("/") || new Response("Not Found", { status: 404 });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`\n\x1b[32m✓ Listening on http://0.0.0.0:${port}\x1b[0m`);
