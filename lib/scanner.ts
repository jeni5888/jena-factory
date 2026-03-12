import { join } from "path";
import { existsSync, readFileSync } from "fs";
import type { Cache } from "./cache";

export interface Epic {
  id: string;
  title: string;
  status: string;
  depends_on_epics: string[];
  branch_name?: string;
  completion_review_status?: string;
  plan_review_status?: string;
  created_at?: string;
  updated_at?: string;
}

export interface Task {
  id: string;
  epic: string;
  title: string;
  status: string;
  depends_on: string[];
  priority?: string;
  assignee?: string;
  claimed_at?: string;
  spec_path?: string;
  created_at?: string;
  updated_at?: string;
}

export interface TaskEvidence {
  commits: string[];
  tests: string[];
  screenshots: string[];
  prs: string[];
}

export interface TaskWithState extends Task {
  evidence?: TaskEvidence;
  blocked_reason?: string;
}

export function scanEpics(flowDir: string, cache: Cache): Epic[] {
  const epicsDir = join(flowDir, "epics");
  if (!existsSync(epicsDir)) return [];

  const files = Array.from(new Bun.Glob("*.json").scanSync({ cwd: epicsDir }));
  return files
    .map((f) => {
      const path = join(epicsDir, f);
      return cache.getJson<Epic>(path);
    })
    .filter(Boolean)
    .sort((a, b) => {
      const numA = parseInt(a!.id.match(/\d+/)?.[0] || "0", 10);
      const numB = parseInt(b!.id.match(/\d+/)?.[0] || "0", 10);
      return numA - numB;
    }) as Epic[];
}

export function scanTasks(flowDir: string, cache: Cache): Task[] {
  const tasksDir = join(flowDir, "tasks");
  if (!existsSync(tasksDir)) return [];

  const files = Array.from(new Bun.Glob("*.json").scanSync({ cwd: tasksDir }));
  return files
    .map((f) => {
      const path = join(tasksDir, f);
      return cache.getJson<Task>(path);
    })
    .filter(Boolean)
    .sort((a, b) => {
      const [eA, tA] = (a!.id.match(/(\d+)\D+(\d+)$/) || []).slice(1).map(Number);
      const [eB, tB] = (b!.id.match(/(\d+)\D+(\d+)$/) || []).slice(1).map(Number);
      return (eA || 0) - (eB || 0) || (tA || 0) - (tB || 0);
    }) as Task[];
}

/** Enrich tasks with state data from .flow/state/tasks/ if available */
export function scanTasksWithState(flowDir: string, cache: Cache): TaskWithState[] {
  const tasks = scanTasks(flowDir, cache);
  const stateDir = join(flowDir, "state", "tasks");
  if (!existsSync(stateDir)) return tasks;

  return tasks.map((task) => {
    // Try multiple naming conventions for state files
    const patterns = [
      `${task.id}.state.json`,
      `${task.id}.json`,
    ];

    for (const pattern of patterns) {
      const statePath = join(stateDir, pattern);
      if (!existsSync(statePath)) continue;

      const state = cache.getJson<any>(statePath);
      if (!state) continue;

      return {
        ...task,
        assignee: state.assignee || task.assignee,
        claimed_at: state.claimed_at || task.claimed_at,
        evidence: state.evidence || undefined,
        blocked_reason: state.blocked_reason || undefined,
      };
    }

    return task;
  });
}
