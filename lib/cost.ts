export interface CostSummary {
  totalCost: number;
  perRun: Array<{ id: string; cost: number; iterCount: number }>;
  perEpic: Record<string, number>;
  modelBreakdown: Record<string, { cost: number; inputTokens: number; outputTokens: number; cacheReads: number }>;
}

export function aggregateCosts(runs: Array<{ id: string; totalCost: number; iterations: Array<{ epic: string; cost?: number }>; iterCosts: number[] }>): CostSummary {
  let totalCost = 0;
  const perRun: CostSummary["perRun"] = [];
  const perEpic: Record<string, number> = {};
  const modelBreakdown: CostSummary["modelBreakdown"] = {};

  for (const run of runs) {
    totalCost += run.totalCost;
    perRun.push({ id: run.id, cost: run.totalCost, iterCount: run.iterations.length });

    // Map costs to epics via iterations
    for (let i = 0; i < run.iterations.length; i++) {
      const iter = run.iterations[i];
      const cost = run.iterCosts[i] || 0;
      if (iter.epic) {
        perEpic[iter.epic] = (perEpic[iter.epic] || 0) + cost;
      }
    }
  }

  return { totalCost, perRun, perEpic, modelBreakdown };
}
