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
}

export interface IterResult {
  total_cost_usd: number;
  duration_ms: number;
  num_turns: number;
  modelUsage?: Record<string, { costUSD: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens?: number }>;
}

// ── Progress Parser (V1 compat, unchanged) ───────────────────

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

// ── Iter Result (tail-read, V1 compat) ───────────────────────

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

  return null;
}

// ── Deep Parser (V2 — full iter-log scan) ────────────────────

export function parseIterDeep(logPath: string, cache: Cache): IterDeepData | null {
  if (!existsSync(logPath)) return null;

  // Use separate cache key for deep parse
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
    let resultLine: any = null;
    let lastTimestamp = "";

    for (const line of lines) {
      if (!line.startsWith("{")) continue;
      let parsed: any;
      try { parsed = JSON.parse(line); } catch { continue; }

      // Track timestamps from messages
      if (parsed.message?.usage) {
        // Approximate timestamp from uuid or just use order
      }

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

      // ── Assistant messages with tool_use ──
      if (parsed.type === "assistant" && parsed.message?.content) {
        const content = parsed.message.content;
        if (!Array.isArray(content)) continue;

        for (const block of content) {
          if (block.type === "tool_use") {
            const name = block.name || "unknown";
            const input = block.input || {};
            // Build a summary from the most useful field
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
              timestamp: lastTimestamp,
            });
            toolCounts[name] = (toolCounts[name] || 0) + 1;
          }
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
        // Track permission denials as errors
        if (parsed.subtype === "permission_denied") {
          errors.push(`Permission denied: ${parsed.tool_name || "unknown tool"}`);
        }
        continue;
      }
    }

    // Any subagent starts without notifications = still running
    for (const [, started] of subagentStarts) {
      subagents.push(started as SubagentEvent);
    }

    // Build model usage from result
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

    // Check result for errors
    if (resultLine?.is_error) {
      errors.push(resultLine.result || "Unknown error");
    }

    const deep: IterDeepData = {
      totalCostUsd: resultLine?.total_cost_usd || 0,
      durationMs: resultLine?.duration_ms || 0,
      durationApiMs: resultLine?.duration_api_ms || 0,
      numTurns: resultLine?.num_turns || 0,
      isError: resultLine?.is_error || false,
      resultSummary: (resultLine?.result || "").slice(0, 300),
      toolCalls,
      toolCounts,
      subagents,
      modelUsage,
      cacheHitRate,
      errors,
      rateLimits,
    };

    // Only cache if file is stable (>30s old)
    if (Date.now() - stat.mtimeMs > 30000) {
      cache.set(deepKey, deep, stat.mtimeMs);
    }

    return deep;
  } catch (err) {
    errors: [];
    return null;
  }
}
