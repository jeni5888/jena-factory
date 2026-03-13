import { existsSync, readFileSync, statSync } from "fs";
import type { Cache } from "./cache";

// ── Basic Types (V1 compat) ──────────────────────────────────

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

// ── Deep Parse Types (V2) ────────────────────────────────────

export interface ToolCall {
  name: string;
  input_summary: string;
  timestamp: string;
}

export interface SubagentEvent {
  taskId: string;
  type: string;
  prompt_summary: string;
  status: string;
  summary: string;
  tokens: number;
  toolUses: number;
  durationMs: number;
}

export interface ModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

export interface RateLimitInfo {
  status: string;
  resetsAt: string;
}

/** Per-turn usage snapshot for sparkline charts */
export interface TurnSnapshot {
  turnIndex: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costEstimate: number;
  cumulativeCost: number;
  toolName?: string;
}

export interface IterDeepData {
  totalCostUsd: number;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  isError: boolean;
  resultSummary: string;

  toolCalls: ToolCall[];
  toolCounts: Record<string, number>;

  subagents: SubagentEvent[];

  modelUsage: Record<string, ModelUsageEntry>;
  cacheHitRate: number;

  errors: string[];
  rateLimits: RateLimitInfo[];

  /** Per-turn token snapshots for sparkline/heartbeat charts */
  turnSnapshots: TurnSnapshot[];

  /** Estimated cost from summing per-message usage (works even without result line) */
  estimatedCostUsd: number;

  /** Is the iteration still in progress (no result line found)? */
  isLive: boolean;
}

export interface IterResult {
  total_cost_usd: number;
  duration_ms: number;
  num_turns: number;
  modelUsage?: Record<string, { costUSD: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens?: number }>;
}

// ── Opus 4 pricing (per token) ───────────────────────────────
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheCreate: number }> = {
  "claude-opus-4-6":   { input: 15/1e6, output: 75/1e6, cacheRead: 1.5/1e6, cacheCreate: 18.75/1e6 },
  "claude-sonnet-4-6": { input: 3/1e6,  output: 15/1e6, cacheRead: 0.3/1e6, cacheCreate: 3.75/1e6 },
  "claude-haiku-4-5":  { input: 0.8/1e6, output: 4/1e6, cacheRead: 0.08/1e6, cacheCreate: 1/1e6 },
};
const DEFAULT_PRICING = PRICING["claude-opus-4-6"];

function estimateTurnCost(usage: any, model?: string): number {
  const p = (model && PRICING[model]) || DEFAULT_PRICING;
  const inp = usage.input_tokens || usage.inputTokens || 0;
  const out = usage.output_tokens || usage.outputTokens || 0;
  const cacheRead = usage.cache_read_input_tokens || usage.cacheReadInputTokens || 0;
  const cacheCreate = usage.cache_creation_input_tokens || usage.cacheCreationInputTokens || 0;
  return inp * p.input + out * p.output + cacheRead * p.cacheRead + cacheCreate * p.cacheCreate;
}

// ── Progress Parser ──────────────────────────────────────────

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

    const iterMatch = line.match(/^## (\S+) - iter (\d+)/);
    if (iterMatch) {
      if (currentIter) iterations.push(currentIter as Iteration);
      currentIter = { timestamp: iterMatch[1], iter: parseInt(iterMatch[2], 10) };
      continue;
    }

    if (currentIter) {
      // Handle both "key=value" per line and "key=val key2=val2" on same line
      const pairs = line.match(/(\w+)=(\S*)/g);
      if (pairs) {
        for (const pair of pairs) {
          const eqIdx = pair.indexOf("=");
          const key = pair.slice(0, eqIdx);
          const value = pair.slice(eqIdx + 1);
          if (key === "status") currentIter.status = value;
          if (key === "epic") currentIter.epic = value;
          if (key === "task") currentIter.task = value;
          if (key === "reason") currentIter.reason = value;
          if (key === "verdict") currentIter.verdict = value;
          if (key === "claude_rc") currentIter.claude_rc = parseInt(value, 10);
        }
      }
    }
  }
  if (currentIter) iterations.push(currentIter as Iteration);

  const result = { runId, started, fullId, iterations };
  try {
    const mtime = statSync(path).mtimeMs;
    if (Date.now() - mtime > 30000) {
      cache.set(path, result, mtime);
    }
  } catch {}

  return result;
}

// ── Iter Result (tail-read) ──────────────────────────────────

export function parseIterResult(logPath: string, cache: Cache): IterResult | null {
  if (!existsSync(logPath)) return null;

  const cached = cache.get<IterResult>(logPath);
  if (cached) return cached;

  const stat = statSync(logPath);
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

  // No result line yet — estimate cost from per-message usage
  try {
    return estimateIterResult(logPath, stat);
  } catch {}

  return null;
}

/** Estimate cost for in-progress iterations by scanning message usage fields */
function estimateIterResult(logPath: string, stat: ReturnType<typeof statSync>): IterResult | null {
  const text = readFileSync(logPath, "utf-8");
  const lines = text.split("\n");

  let totalCost = 0;
  let numTurns = 0;
  let lastUsageKey = "";
  let prevCacheRead = 0;
  const modelTokens: Record<string, { inp: number; out: number; cacheRead: number; cacheCreate: number; cost: number }> = {};

  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    let parsed: any;
    try { parsed = JSON.parse(line); } catch { continue; }

    if (parsed.type !== "assistant" || !parsed.message?.usage) continue;

    const usage = parsed.message.usage;
    const inp = usage.input_tokens || 0;
    const out = usage.output_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const cacheCreate = usage.cache_creation_input_tokens || 0;

    // Deduplicate identical usage snapshots (same API call = same values)
    const usageKey = `${inp}:${out}:${cacheRead}:${cacheCreate}`;
    if (usageKey === lastUsageKey) continue;
    lastUsageKey = usageKey;

    // cache_read is cumulative — compute delta
    const cacheReadDelta = Math.max(0, cacheRead - prevCacheRead);
    prevCacheRead = cacheRead;

    const model = parsed.message?.model || "claude-opus-4-6";
    const p = (model && PRICING[model]) || DEFAULT_PRICING;
    const turnCost = inp * p.input + out * p.output + cacheReadDelta * p.cacheRead + cacheCreate * p.cacheCreate;
    totalCost += turnCost;
    numTurns++;

    if (!modelTokens[model]) modelTokens[model] = { inp: 0, out: 0, cacheRead: 0, cacheCreate: 0, cost: 0 };
    const mt = modelTokens[model];
    mt.inp += inp;
    mt.out += out;
    mt.cacheRead += cacheReadDelta;
    mt.cacheCreate += cacheCreate;
    mt.cost += turnCost;
  }

  if (numTurns === 0) return null;

  const modelUsage: Record<string, any> = {};
  for (const [model, t] of Object.entries(modelTokens)) {
    modelUsage[model] = {
      inputTokens: t.inp,
      outputTokens: t.out,
      cacheReadInputTokens: t.cacheRead,
      cacheCreationInputTokens: t.cacheCreate,
      costUSD: t.cost,
    };
  }

  return {
    total_cost_usd: totalCost,
    duration_ms: 0, // Unknown for in-progress
    num_turns: numTurns,
    modelUsage,
  };
}

// ── Deep Parser (V2) ─────────────────────────────────────────

export function parseIterDeep(logPath: string, cache: Cache): IterDeepData | null {
  if (!existsSync(logPath)) return null;

  const deepKey = logPath + "::deep";
  const cached = cache.get<IterDeepData>(deepKey);
  if (cached) return cached;

  const stat = statSync(logPath);

  try {
    const text = readFileSync(logPath, "utf-8");
    const lines = text.split("\n");

    const toolCalls: ToolCall[] = [];
    const toolCounts: Record<string, number> = {};
    const subagentStarts = new Map<string, Partial<SubagentEvent>>();
    const subagents: SubagentEvent[] = [];
    const errors: string[] = [];
    const rateLimits: RateLimitInfo[] = [];
    const turnSnapshots: TurnSnapshot[] = [];
    let resultLine: any = null;
    let turnIndex = 0;
    let cumulativeCost = 0;

    // Dedup: track last seen usage fingerprint to skip repeats
    let lastUsageKey = "";
    // Track previous cache_read (it's cumulative, we need deltas)
    let prevCacheRead = 0;

    // Accumulate model usage from per-message data (only unique turns)
    const liveModelUsage: Record<string, ModelUsageEntry> = {};

    for (const line of lines) {
      if (!line.startsWith("{")) continue;
      let parsed: any;
      try { parsed = JSON.parse(line); } catch { continue; }

      // ── Result line ──
      if (parsed.type === "result") {
        resultLine = parsed;
        continue;
      }

      // ── Rate limit events ──
      if (parsed.type === "rate_limit_event") {
        const info = parsed.rate_limit_info;
        if (info) {
          rateLimits.push({
            status: info.status || "unknown",
            resetsAt: info.resetsAt ? new Date(info.resetsAt * 1000).toISOString() : "",
          });
        }
        continue;
      }

      // ── Assistant messages with tool_use + usage tracking ──
      if (parsed.type === "assistant" && parsed.message?.content) {
        const content = parsed.message.content;
        const usage = parsed.message?.usage;
        const model = parsed.message?.model || "claude-opus-4-6";

        // Track per-turn usage for sparkline — deduplicate identical snapshots
        if (usage) {
          const inp = usage.input_tokens || 0;
          const out = usage.output_tokens || 0;
          const cacheRead = usage.cache_read_input_tokens || 0;
          const cacheCreate = usage.cache_creation_input_tokens || 0;

          // Fingerprint: skip if identical to last seen usage
          const usageKey = `${inp}:${out}:${cacheRead}:${cacheCreate}`;
          if (usageKey !== lastUsageKey) {
            lastUsageKey = usageKey;

            // cache_read is cumulative — compute delta for this turn
            const cacheReadDelta = Math.max(0, cacheRead - prevCacheRead);
            prevCacheRead = cacheRead;

            // Cost uses per-turn values: inp, out, cacheCreate are per-turn; cacheReadDelta is the delta
            const p = (model && PRICING[model]) || DEFAULT_PRICING;
            const turnCost = inp * p.input + out * p.output + cacheReadDelta * p.cacheRead + cacheCreate * p.cacheCreate;
            cumulativeCost += turnCost;

            turnSnapshots.push({
              turnIndex: turnIndex++,
              inputTokens: inp,
              outputTokens: out,
              cacheReadTokens: cacheReadDelta,
              cacheCreateTokens: cacheCreate,
              costEstimate: turnCost,
              cumulativeCost,
            });

            // Accumulate model usage (only unique turns, using deltas)
            if (!liveModelUsage[model]) {
              liveModelUsage[model] = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 };
            }
            const mu = liveModelUsage[model];
            mu.inputTokens += inp;
            mu.outputTokens += out;
            mu.cacheReadInputTokens += cacheReadDelta;
            mu.cacheCreationInputTokens += cacheCreate;
            mu.costUSD += turnCost;
          }
        }

        if (!Array.isArray(content)) continue;

        let lastToolName: string | undefined;
        for (const block of content) {
          if (block.type === "tool_use") {
            const name = block.name || "unknown";
            const input = block.input || {};
            let summary = "";
            if (input.description) summary = input.description;
            else if (input.command) summary = input.command;
            else if (input.file_path) summary = input.file_path;
            else if (input.pattern) summary = input.pattern;
            else if (input.prompt) summary = input.prompt?.slice(0, 80);
            else if (input.skill) summary = input.skill + (input.args ? " " + input.args : "");
            else if (input.old_string) summary = input.file_path || "edit";
            else summary = Object.keys(input).slice(0, 3).join(", ");

            toolCalls.push({
              name,
              input_summary: (summary || "").slice(0, 120),
              timestamp: "",
            });
            toolCounts[name] = (toolCounts[name] || 0) + 1;
            lastToolName = name;
          }
        }
        // Tag the last snapshot with tool name
        if (lastToolName && turnSnapshots.length > 0) {
          turnSnapshots[turnSnapshots.length - 1].toolName = lastToolName;
        }
        continue;
      }

      // ── System messages: subagents ──
      if (parsed.type === "system") {
        if (parsed.subtype === "task_started") {
          subagentStarts.set(parsed.task_id, {
            taskId: parsed.task_id,
            type: parsed.task_type || "local_agent",
            prompt_summary: (parsed.description || parsed.prompt || "").slice(0, 120),
            status: "running",
            summary: "",
            tokens: 0,
            toolUses: 0,
            durationMs: 0,
          });
        }
        if (parsed.subtype === "task_notification") {
          const started = subagentStarts.get(parsed.task_id);
          const agent: SubagentEvent = {
            taskId: parsed.task_id || "",
            type: started?.type || "local_agent",
            prompt_summary: started?.prompt_summary || parsed.summary || "",
            status: parsed.status || "completed",
            summary: parsed.summary || "",
            tokens: parsed.usage?.total_tokens || 0,
            toolUses: parsed.usage?.tool_uses || 0,
            durationMs: parsed.usage?.duration_ms || 0,
          };
          subagents.push(agent);
          subagentStarts.delete(parsed.task_id);
        }
        if (parsed.subtype === "permission_denied") {
          errors.push(`Permission denied: ${parsed.tool_name || "unknown tool"}`);
        }
        continue;
      }
    }

    // Still-running subagents
    for (const [, started] of subagentStarts) {
      subagents.push(started as SubagentEvent);
    }

    const isLive = !resultLine;

    // Use result line if available, otherwise use accumulated live data
    const modelUsage: Record<string, ModelUsageEntry> = {};
    if (resultLine?.modelUsage) {
      for (const [model, data] of Object.entries(resultLine.modelUsage as Record<string, any>)) {
        modelUsage[model] = {
          inputTokens: data.inputTokens || 0,
          outputTokens: data.outputTokens || 0,
          cacheReadInputTokens: data.cacheReadInputTokens || 0,
          cacheCreationInputTokens: data.cacheCreationInputTokens || 0,
          costUSD: data.costUSD || 0,
        };
      }
    } else {
      // Use live accumulated data
      Object.assign(modelUsage, liveModelUsage);
    }

    // Cache hit rate
    let totalInput = 0, totalCacheRead = 0;
    for (const m of Object.values(modelUsage)) {
      totalInput += m.inputTokens + m.cacheCreationInputTokens;
      totalCacheRead += m.cacheReadInputTokens;
    }
    const cacheHitRate = totalInput + totalCacheRead > 0
      ? (totalCacheRead / (totalInput + totalCacheRead)) * 100
      : 0;

    if (resultLine?.is_error) {
      errors.push(resultLine.result || "Unknown error");
    }

    const finalCost = resultLine?.total_cost_usd || cumulativeCost;

    const deep: IterDeepData = {
      totalCostUsd: finalCost,
      durationMs: resultLine?.duration_ms || 0,
      durationApiMs: resultLine?.duration_api_ms || 0,
      numTurns: resultLine?.num_turns || turnIndex,
      isError: resultLine?.is_error || false,
      resultSummary: (resultLine?.result || "").slice(0, 300),
      toolCalls,
      toolCounts,
      subagents,
      modelUsage,
      cacheHitRate,
      errors,
      rateLimits,
      turnSnapshots,
      estimatedCostUsd: cumulativeCost,
      isLive,
    };

    // Only cache if file is stable (>30s old)
    if (Date.now() - stat.mtimeMs > 30000) {
      cache.set(deepKey, deep, stat.mtimeMs);
    }

    return deep;
  } catch {
    return null;
  }
}
