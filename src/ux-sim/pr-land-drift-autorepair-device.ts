import { executeDriftPlan, planDriftRepair, type RepairAttempt, type RepairPlan } from '../cli/pr-land-drift-repair.js';
import { mayLaunchPrLandDriftRepair } from '../cli/pr-land-refusal.js';

export type PrLandDriftAutorepairCase = Omit<RepairAttempt, 'attemptsByHead' | 'attemptsByPr'> & {
  mode: 'off' | 'shadow' | 'live';
  actualDrift: boolean;
};

export type PrLandDriftAutorepairDecision = {
  input: PrLandDriftAutorepairCase;
  plan: RepairPlan;
  allowed: boolean;
};

export type PrLandDriftAutorepairResult = {
  decisions: PrLandDriftAutorepairDecision[];
  launched: { pr: number; head: string; files: string[] }[];
  escalated: string[];
  falseLaunches: number;
  missedDrifts: number;
  costUnits: number;
};

/** Runs production planning/gating/execution on supplied classification fixtures; launcher and GitHub are fake boundaries. */
export async function simulatePrLandDriftAutorepair(cases: readonly PrLandDriftAutorepairCase[]): Promise<PrLandDriftAutorepairResult> {
  const attemptsByHead = new Map<string, number>();
  const attemptsByPr = new Map<number, number>();
  const decisions: PrLandDriftAutorepairDecision[] = [];
  const launched: PrLandDriftAutorepairResult['launched'] = [];
  const escalated: string[] = [];

  for (const input of cases) {
    const headKey = `${input.pr}:${input.head}`;
    const plan = planDriftRepair({
      ...input,
      attemptsByHead: attemptsByHead.get(headKey) ?? 0,
      attemptsByPr: attemptsByPr.get(input.pr) ?? 0,
    });
    const allowed = mayLaunchPrLandDriftRepair({ mode: input.mode, verdict: input.result.verdict, action: plan.action });
    if (allowed) {
      attemptsByHead.set(headKey, (attemptsByHead.get(headKey) ?? 0) + 1);
      attemptsByPr.set(input.pr, (attemptsByPr.get(input.pr) ?? 0) + 1);
    }
    decisions.push({ input, plan, allowed });
    await executeDriftPlan(plan, allowed ? 'live' : input.mode === 'live' ? 'shadow' : input.mode,
      async (_goal, files) => { launched.push({ pr: input.pr, head: input.head, files: [...files] }); },
      mail => { escalated.push(mail); });
  }

  return {
    decisions,
    launched,
    escalated,
    falseLaunches: decisions.filter(({ input, allowed }) => allowed && !input.actualDrift).length,
    missedDrifts: decisions.filter(({ input, plan }) => input.actualDrift && plan.action === 'skip').length,
    costUnits: launched.length,
  };
}
