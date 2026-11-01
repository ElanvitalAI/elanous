import { randomUUID } from 'node:crypto';
import type { RetroPeriod } from './retro-aggregate.js';

export interface RetroCycleLifecycleReport {
  period: RetroPeriod;
  reportPath: string;
  hasProposal: boolean;
  proposalId?: string;
}

export interface RetroCycleActionRefs {
  runId: string;
  reportPath: string;
}

export type RetroCycleLog = (category: string, event: string, data: Record<string, unknown>) => void;

export interface RetroCycleLifecycleDeps {
  recordAction: (refs: RetroCycleActionRefs) => void;
  log: RetroCycleLog;
  createId?: () => string;
}

/** Assign one run identity and propagate it through the action record and queryable events. */
export function finishRetroCycleRun(report: RetroCycleLifecycleReport, deps: RetroCycleLifecycleDeps): string {
  const runId = `retro-${(deps.createId ?? randomUUID)()}`;
  deps.recordAction({ runId, reportPath: report.reportPath });
  deps.log('retro.cycle', 'collected', {
    runId,
    period: report.period,
    reportPath: report.reportPath,
    hasProposal: report.hasProposal,
  });
  if (report.hasProposal) {
    deps.log('retro.cycle', 'proposed', {
      runId,
      period: report.period,
      reportPath: report.reportPath,
      proposalId: report.proposalId ?? null,
    });
  }
  return runId;
}
