import { join } from "path";
import { statSync, readFileSync, existsSync } from "fs";
import { scanEpics, scanTasks } from "./lib/scanner";
import { parseProgress, parseIterResult } from "./lib/parser";
import { aggregateCosts } from "./lib/cost";
import { Cache } from "./lib/cache";

const args = process.argv.slice(2);
let port = 4242;
let projectDir = process.env.PROJECT_DIR || "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && args[i + 1]) port = parseInt(args[i + 1], 10);
  if (args[i] === "--project-dir" && args[i + 1]) projectDir = args[i + 1];
}

// Auto-discover project dir
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
console.log(`\x1b[36m║\x1b[0m  \x1b[1;33mJENA-FACTORY\x1b[0m  Mission Control      \x1b[36m║\x1b[0m`);
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
  try {
    statSync(filePath);
  } catch {
    return null;
  }
  const ext = filePath.split(".").pop() || "";
  const types: Record<string, string> = {
    html: "text/html",
    css: "text/css",
    js: "application/javascript",
    json: "application/json",
    png: "image/png",
    svg: "image/svg+xml",
  };
  return new Response(Bun.file(filePath), {
    headers: { "Content-Type": types[ext] || "application/octet-stream" },
  });
}

// SSE connections
const sseClients = new Set<ReadableStreamDefaultController>();

function broadcastSSE(data: unknown) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const controller of sseClients) {
    try {
      controller.enqueue(new TextEncoder().encode(msg));
    } catch {
      sseClients.delete(controller);
    }
  }
}

// Poll for changes every 5s
let lastHash = "";
setInterval(() => {
  try {
    const epics = scanEpics(flowDir, cache);
    const runs = scanRuns();
    const status = getStatus(runs);
    const hash = JSON.stringify({ epics: epics.map((e) => e.status), status });
    if (hash !== lastHash) {
      lastHash = hash;
      broadcastSSE({ type: "update", epics, status, timestamp: new Date().toISOString() });
    }
  } catch {}
}, 5000);

function scanRuns() {
  if (!existsSync(runsDir)) return [];
  const dirs = readdirSyncSafe(runsDir).sort().reverse();
  return dirs.map((id) => {
    const runPath = join(runsDir, id);
    const progress = parseProgress(join(runPath, "progress.txt"), cache);
    const receipts = scanReceipts(join(runPath, "receipts"));
    const branches = readJsonSafe(join(runPath, "branches.json"));
    const iterCosts = scanIterCosts(runPath, progress.iterations.length);
    const totalCost = iterCosts.reduce((s, c) => s + c, 0);
    return { id, ...progress, receipts, branches, iterCosts, totalCost };
  });
}

function scanReceipts(dir: string): Array<{ id: string; verdict: string; type: string; review?: string }> {
  if (!existsSync(dir)) return [];
  return readdirSyncSafe(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJsonSafe(join(dir, f)))
    .filter(Boolean);
}

function scanIterCosts(runPath: string, iterCount: number): number[] {
  const costs: number[] = [];
  for (let i = 1; i <= Math.max(iterCount, 20); i++) {
    const logFile = join(runPath, `iter-${String(i).padStart(3, "0")}.log`);
    if (!existsSync(logFile)) break;
    const result = parseIterResult(logFile, cache);
    costs.push(result?.total_cost_usd || 0);
  }
  return costs;
}

function getStatus(runs: ReturnType<typeof scanRuns>) {
  if (runs.length === 0) return { active: false };
  const latest = runs[0];
  const lastIter = latest.iterations[latest.iterations.length - 1];

  // Detect actively running iteration even if progress.txt hasn't been updated yet
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
  try {
    return Array.from(new Bun.Glob("*").scanSync({ cwd: dir, onlyFiles: false }));
  } catch {
    return [];
  }
}

function readJsonSafe(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

Bun.serve({
  port,
  hostname: "0.0.0.0",
  fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // API routes
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
      const epicId = path.slice("/api/tasks/".length);
      const tasks = scanTasks(flowDir, cache).filter((t) => t.epic === epicId);
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

    if (path.startsWith("/api/runs/")) {
      const runId = path.slice("/api/runs/".length);
      const runs = scanRuns();
      const run = runs.find((r) => r.id === runId);
      if (!run) return jsonResponse({ error: "Run not found" }, 404);
      return jsonResponse(run);
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

    // Fallback to index.html for SPA
    if (!path.startsWith("/api/")) {
      return serveStatic("/") || new Response("Not Found", { status: 404 });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`\n\x1b[32m✓ Listening on http://0.0.0.0:${port}\x1b[0m`);
