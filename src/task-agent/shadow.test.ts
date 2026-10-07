import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { superviseRun, type SupervisorJobResult, type SupervisorStopReason } from '../self-dev/run-supervisor.js';
import { executeNextAction } from './actions.js';
import { recordTaskAgentShadowMove, shadowJudgeInput } from './shadow.js';

const job = (over: Partial<SupervisorJobResult> = {}): SupervisorJobResult =>
  ({ taskId: 't', feature: 'feature ask', status: 'done', ...over }) as SupervisorJobResult;

const SAMPLES: Array<[SupervisorStopReason, SupervisorJobResult[], string, string | null, string | null]> = [
  ['converged', [job({ prNumber: 7, merged: true })], 'propose-green', 'green', null],
  ['needs-human', [job({ prNumber: 8 })], 'review', 'review', null],
  ['harvestable-awaiting-human', [job({ harvestable: true, branch: 'self-impl/x' })], 'review', 'review', null],
  ['no-progress', [job()], 'narrow-relaunch', 'retry', 'narrow'],
  ['provider-exhausted', [job()], 'wait-retry', 'retry', 'wait'],
  ['step-timeout', [job()], 'wait-retry', 'retry', 'wait'],
  ['handed-off-to-salvage', [job({ salvage: 'launched' })], 'salvage-relaunch', 'retry', 'salvage'],
  ['max-rounds', [job()], 'decision-card', 'decision', null],
];

const noSweep = async () => ({ pending: 0, merged: 0 }) as never;

describe('TASK-AGENT-SHADOW — 멈춤 확정 → 판단부 → 실행부(shadow)', () => {
  test('종료 어휘 8표본 → shadow-move 하나씩 · 실제 명령 0', async () => {
    const events: Array<Record<string, unknown>> = [];
    let commands = 0;
    for (const [stopReason, results, move, kind, variant] of SAMPLES) {
      const out = await recordTaskAgentShadowMove({ runId: `run-${stopReason}`, stopReason, results }, {
        log: (category, event, data) => { expect([category, event]).toEqual(['task-agent', 'shadow-move']); events.push(data); },
        command: async () => { commands++; return { status: 0, stdout: '' }; },
      });
      expect(out.move).toBe(move as never);
      expect(out.executorKind).toBe(kind as never);
      expect(out.variant).toBe(variant as never);
      expect(out.executorResult).toBe('shadow');
      expect(out.wouldDo).toStartWith(`would ${kind}${variant ? `:${variant}` : ''}`);
    }
    expect(events).toHaveLength(8);
    expect(events.map((e) => e.stopReason)).toEqual(SAMPLES.map(([s]) => s));
    expect(events.every((e) => typeof e.runId === 'string' && typeof e.reason === 'string')).toBe(true);
    expect(commands).toBe(0);
  });

  test('PR 상태는 결과에 실린 값만 쓴다 — 병합이 아니면 OPEN · PR 없으면 비운다', () => {
    expect(shadowJudgeInput('converged', [job({ prNumber: 3, merged: true })])).toEqual({ stopReason: 'converged', pr: 3, prState: 'MERGED' });
    expect(shadowJudgeInput('converged', [job({ prNumber: 3 })])).toEqual({ stopReason: 'converged', pr: 3, prState: 'OPEN' });
    expect(shadowJudgeInput('no-progress', [job()])).toEqual({ stopReason: 'no-progress' });
  });

  test('G1 — must-fix 없는 no-progress 는 live 에서도 결정 카드가 아니라 좁힌 재발사 · wait-retry 는 대기 표지', async () => {
    const calls: string[][] = [];
    const deps = { mode: 'live', command: async (args: string[]) => { calls.push(args); return { status: 0, stdout: '' }; }, observe: () => {} };
    const base = { taskId: 'T', rationale: 'r', pr: 0, runId: 'run-9', original: 'verbatim ask', checklistId: '' };
    expect(await executeNextAction({ ...base, kind: 'retry', variant: 'narrow' }, deps)).toBe('done');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 2)).toEqual(['harness', 'say']);
    expect(calls[0]![2]).toStartWith('verbatim ask');
    expect(calls[0]![2]).toContain('Narrow relaunch');
    expect(calls.some((c) => c[0] === 'decisions')).toBe(false);
    expect(await executeNextAction({ ...base, kind: 'retry', variant: 'wait' }, deps)).toBe('waiting');
    expect(calls).toHaveLength(1);
  });

  test('G2 — 갈래마다 재발사 문면과 실패 칸이 다르다', async () => {
    const calls: string[][] = [];
    const failureCounts: Record<string, number> = {};
    const deps = { mode: 'live', failureCounts, command: async (args: string[]) => { calls.push(args); return { status: 1, stdout: '', stderr: 'x' }; }, observe: () => {} };
    const base = { taskId: 'T', rationale: 'r', pr: 0, runId: 'run-9', original: 'ask', checklistId: '', kind: 'retry' as const };
    for (const variant of ['narrow', 'salvage', 'alternative'] as const) await executeNextAction({ ...base, variant, salvageBranch: 'salvage/x' }, deps);
    expect(new Set(calls.map((c) => c[2])).size).toBe(3);
    expect(calls[1]![2]).toContain('salvage/x');
    expect(Object.keys(failureCounts).sort()).toEqual([
      JSON.stringify(['T', 'retry', 'alternative']),
      JSON.stringify(['T', 'retry', 'narrow']),
      JSON.stringify(['T', 'retry', 'salvage']),
    ].sort());
  });

  test('슈퍼바이저가 멈춤을 확정하면 기본 훅이 shadow-move 를 남긴다', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      await superviseRun({
        initial: [job({ stage: 'review-blocked', status: 'failed', salvage: 'launched' })],
        rerun: async (p) => p,
        sweepPendingMerges: noSweep,
        runStore: { runId: 'run-hook', dir: mkdtempSync(join(tmpdir(), 'task-agent-shadow-')) },
      });
      const shadow = log.mock.calls.filter((c) => c[0] === 'task-agent' && c[1] === 'shadow-move');
      expect(shadow).toHaveLength(1);
      expect(shadow[0]![2]).toMatchObject({ runId: 'run-hook', stopReason: 'handed-off-to-salvage', move: 'salvage-relaunch', executorKind: 'retry', executorResult: 'shadow' });
    } finally { log.mockRestore(); }
  });

  test('훅이 던져도 런의 결말은 같다', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const initial = [job({ stage: 'review-blocked', status: 'failed', salvage: 'launched' })];
      const opts = { initial, rerun: async (p: readonly SupervisorJobResult[]) => p, sweepPendingMerges: noSweep };
      const quiet = await superviseRun({ ...opts, taskAgentShadow: false });
      const sync = await superviseRun({ ...opts, taskAgentShadow: () => { throw new Error('boom'); } });
      const asyncThrow = await superviseRun({ ...opts, taskAgentShadow: async () => { throw new Error('boom'); } });
      expect(sync).toEqual(quiet);
      expect(asyncThrow).toEqual(quiet);
      expect(log.mock.calls.filter((c) => c[0] === 'task-agent' && c[1] === 'shadow-move-failed')).toHaveLength(2);
    } finally { log.mockRestore(); }
  });
});
