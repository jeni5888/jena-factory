import type { ModelUsageEntry } from "./parser";

export interface CostSummary {
  totalCost: number;
  perRun: Array<{ id: string; cost: number; iterCount: number }>;
  perEpic: Record<string, number>;
  modelBreakdown: Record<string, { cost: number; inputTokens: number; outputTokens: number; cacheReads: number; cacheCreation: number }>;
}

export function aggregateCosts(runs: Array<{
  id: string;
  totalCost: number;
  iterations: Array<{ epic: string; cost?: number }>;
  iterCosts: number[];
  iterModelUsage?: Array<Record<string, ModelUsageEntry> | null>;
}>): CostSummary {
  let totalCost = 0;
  const perRun: CostSummary["perRun"] = [];
  const perEpic: Record<string, number> = {};
  const modelBreakdown: CostSummary["modelBreakdown"] = {};

  for (const run of runs) {
    totalCost += run.totalCost;
    perRun.push({ id: run.id, cost: run.totalCost, iterCount: run.iterations.length });

    for (let i = 0; i < run.iterations.length; i++) {
      const iter = run.iterations[i];
      const cost = run.iterCosts[i] || 0;
      if (iter.epic) {
        perEpic[iter.epic] = (perEpic[iter.epic] || 0) + cost;
      }
    }

    // Aggregate model usage if available
    if (run.iterModelUsage) {
      for (const usage of run.iterModelUsage) {
        if (!usage) continue;
        for (const [model, data] of Object.entries(usage)) {
          if (!modelBreakdown[model]) {
            modelBreakdown[model] = { cost: 0, inputTokens: 0, outputTokens: 0, cacheReads: 0, cacheCreation: 0 };
          }
          modelBreakdown[model].cost += data.costUSD || 0;
          modelBreakdown[model].inputTokens += data.inputTokens || 0;
          modelBreakdown[model].outputTokens += data.outputTokens || 0;
          modelBreakdown[model].cacheReads += data.cacheReadInputTokens || 0;
          modelBreakdown[model].cacheCreation += data.cacheCreationInputTokens || 0;
        }
      }
    }
  }

  return { totalCost, perRun, perEpic, modelBreakdown };
}
