import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { superviseRun, type SupervisorJobResult, type SupervisorStopReason } from '../self-dev/run-supervisor.js';

const CASES = [
  { reason: 'missing-path', runId: 'run-a4117f90-20261028-0000-4000-8000-000000000001',
    piece: { taskId: 'missing-path-piece', feature: 'missing path piece', status: 'failed', stage: 'error',
      targetPaths: ['src/gone.ts'],
      error: { code: 'ENOENT', message: "ENOENT: no such file or directory, open 'src/gone.ts'" } }, goalText: '없는 경로를 다시 접지한다' },
  { reason: 'scope-expansion', runId: 'run-b2aa6c1e-20261028-0000-4000-8000-000000000002',
    piece: { taskId: 'scope-expansion-piece', feature: 'scope expansion piece', status: 'failed', stage: 'error',
      error: { code: 'SCOPE_OUTSIDE', message: 'changed files outside the goal target paths' },
      changedFiles: ['src/other/expanded.ts'], targetPaths: ['src/self-dev/run-supervisor.ts'] }, goalText: '범위 확장을 좁힌다' },
  { reason: 'step-timeout', runId: 'run-c928719f-20261028-0000-4000-8000-000000000003',
    piece: { taskId: 'step-timeout-piece', feature: 'step timeout piece', status: 'failed', stage: 'timed-out',
      targetPaths: ['src/self-dev/run-supervisor.ts'],
      error: { code: 'ETIMEDOUT', message: 'review step exceeded its budget' } }, goalText: '좁은 시험' },
  { reason: 'no-piece', runId: 'run-d31870a2-20261028-0000-4000-8000-000000000004',
    piece: { taskId: 'no-piece-piece', feature: 'no piece piece', status: 'failed', stage: 'error',
      targetPaths: ['src/self-dev/run-supervisor.ts'],
      error: { code: 'BOOM', message: 'TypeError: undefined is not a function' } }, goalText: '조각 없이 실패했다' },
] as const;

export interface NeedsHumanReasonRepairSimulationCase {
  reason: typeof CASES[number]['reason'];
  runId: string;
  taskId: string;
  goalText: string;
  reruns: number;
  repairGoal?: string;
  stopReason?: SupervisorStopReason;
  why?: string;
  events: Array<{ event: string; data: Record<string, unknown> }>;
}

/** Runs the production supervisor with one injected failure per repair reason. */
export async function simulateNeedsHumanReasonRepair(): Promise<NeedsHumanReasonRepairSimulationCase[]> {
  const outcomes: NeedsHumanReasonRepairSimulationCase[] = [];
  const previousStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = join(process.cwd(), '.elanous-test');
  let logStore: import('../mss/logging/log-store.js').LogStore | null = null;
  let logSink: import('../mss/logging/log-store.js').StoreSink | null = null;
  let unregisterLogSink: (() => void) | null = null;
  if (process.env.NODE_ENV === 'test') {
    const storeModule = await import('../mss/logging/log-store.js');
    logStore = new storeModule.LogStore();
    logSink = new storeModule.StoreSink(logStore, 'self-dev.supervisor', { installExitHandlers: false });
    unregisterLogSink = debug.registerSink(logSink);
  } else {
    const { registerStandaloneLogSink } = await import('../domains/standalone-log-sink.js');
    await registerStandaloneLogSink('self-dev.supervisor');
  }
  try {
    for (const fixture of CASES) {
      const operatorDir = mkdtempSync(join(tmpdir(), 'needs-human-reason-repair-sim-'));
      const events: NeedsHumanReasonRepairSimulationCase['events'] = [];
      const decisions: Array<{ action: string; stopReason?: SupervisorStopReason; why: string }> = [];
      let repairGoal: string | undefined;
      let reruns = 0;
      try {
        await superviseRun({
          initial: [fixture.piece as unknown as SupervisorJobResult],
          repairGoalExecution: true,
          needsHumanReasonRepairExecution: true,
          runStore: { runId: fixture.runId, operatorDir },
          rerun: async (_previous, invocation) => {
            reruns++;
            repairGoal = invocation.repairGoals?.[fixture.piece.taskId];
            return [fixture.piece as unknown as SupervisorJobResult];
          },
          onDecision: (decision) => decisions.push(decision),
          observe: (event, data) => {
            events.push({ event, data });
            // Mirror the production single-run observer in self-implement-cli.ts.
            try { debug.log('self-dev.supervisor', event, { ...data, surface: 'single' }); } catch { /* fail-open */ }
          },
          sweepPendingMerges: async () => ({ pending: 0, merged: 0 }),
          taskAgentShadow: false,
          taskAgentRejudge: false,
        });
        const terminal = decisions.at(-1);
        outcomes.push({
          reason: fixture.reason,
          runId: fixture.runId,
          taskId: fixture.piece.taskId,
          goalText: fixture.goalText,
          reruns,
          ...(repairGoal === undefined ? {} : { repairGoal }),
          ...(terminal?.stopReason === undefined ? {} : { stopReason: terminal.stopReason }),
          ...(terminal === undefined ? {} : { why: terminal.why }),
          events,
        });
      } finally {
        rmSync(operatorDir, { recursive: true, force: true });
      }
    }
  } finally {
    logSink?.close();
    unregisterLogSink?.();
    logStore?.close();
    if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousStateDir;
  }
  return outcomes;
}
