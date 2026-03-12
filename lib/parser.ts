import { existsSync, readFileSync, statSync } from "fs";
import type { Cache } from "./cache";

export interface Iteration {
  timestamp: string;
  iter: number;
  status: string;
  epic: string;
  task: string;
  reason?: string;
  verdict?: string;
  claude_rc?: number;
  cost?: number;
}

export interface ProgressData {
  runId: string;
  started: string;
  fullId: string;
  iterations: Iteration[];
}

export function parseProgress(path: string, cache: Cache): ProgressData {
  const empty: ProgressData = { runId: "", started: "", fullId: "", iterations: [] };
  if (!existsSync(path)) return empty;

  const cached = cache.get<ProgressData>(path);
  if (cached) return cached;

  const text = readFileSync(path, "utf-8");
  const lines = text.split("\n");

  let runId = "";
  let started = "";
  let fullId = "";
  const iterations: Iteration[] = [];
  let currentIter: Partial<Iteration> | null = null;

  for (const line of lines) {
    if (line.startsWith("Run: ")) runId = line.slice(5).trim();
    if (line.startsWith("Full ID: ")) fullId = line.slice(9).trim();
    if (line.startsWith("Started: ")) started = line.slice(9).trim();

    // New iteration header: ## 2026-03-09T23:05:57Z - iter 1
    const iterMatch = line.match(/^## (\S+) - iter (\d+)/);
    if (iterMatch) {
      if (currentIter) iterations.push(currentIter as Iteration);
      currentIter = { timestamp: iterMatch[1], iter: parseInt(iterMatch[2], 10) };
      continue;
    }

    if (currentIter) {
      const kvMatch = line.match(/^(\w+)=(.*)$/);
      if (kvMatch) {
        const [, key, value] = kvMatch;
        if (key === "status") currentIter.status = value;
        if (key === "epic") currentIter.epic = value;
        if (key === "task") currentIter.task = value;
        if (key === "reason") currentIter.reason = value;
        if (key === "verdict") currentIter.verdict = value;
        if (key === "claude_rc") currentIter.claude_rc = parseInt(value, 10);
      }
    }
  }
  if (currentIter) iterations.push(currentIter as Iteration);

  const result = { runId, started, fullId, iterations };
  // Only cache if file hasn't been modified in the last 30s (likely still being written)
  try {
    const mtime = statSync(path).mtimeMs;
    if (Date.now() - mtime > 30000) {
      cache.set(path, result, mtime);
    }
  } catch {}

  return result;
}

export interface IterResult {
  total_cost_usd: number;
  duration_ms: number;
  num_turns: number;
  modelUsage?: Record<string, { costUSD: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number }>;
}

export function parseIterResult(logPath: string, cache: Cache): IterResult | null {
  if (!existsSync(logPath)) return null;

  const cached = cache.get<IterResult>(logPath);
  if (cached) return cached;

  // Read last 5KB — the result line is at the end
  const stat = statSync(logPath);
  const fd = Bun.file(logPath);
  const size = stat.size;
  const tailSize = Math.min(size, 5000);

  try {
    const buf = readFileSync(logPath);
    const tail = buf.slice(size - tailSize).toString("utf-8");
    const lines = tail.split("\n").reverse();

    for (const line of lines) {
      if (!line.includes('"type":"result"')) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "result") {
          const result: IterResult = {
            total_cost_usd: parsed.total_cost_usd || 0,
            duration_ms: parsed.duration_ms || 0,
            num_turns: parsed.num_turns || 0,
            modelUsage: parsed.modelUsage,
          };
          cache.set(logPath, result, stat.mtimeMs);
          return result;
        }
      } catch {}
    }
  } catch {}

  return null;
}
