import { describe, it, expect, spyOn } from 'bun:test';
import { debug } from '../debug/log.js';
import { runSelfOrchestrateCliCommand, type OrchestrateCliDeps } from './orchestrate-cli.js';
import type { DevPipelineSpec } from './dev-pipeline.js';
import type { SelfDevJobResult } from './orchestrate.js';

// ⭐⭐⭐ 2026-10-22 — 매달린 `dependsOn` 거부가 «관측»으로 남고 다음 라운드가 같은 제안을
//   다시 쓰지 «않는가»를 검증한다(PRB review must-fix 1·2·3).
//   거부 사유가 값으로만 돌아와 호출자가 버리면 운영에서 「쪼개지 않았다」는 사실과
//   그 사유가 로그·원장 어느 곳에도 남지 않는다. 여기는 두 축을 다 잰다:
//   ⓐ `decompose-rejected` 관측이 실제 남는가(applyDecomposeProposals 안)
//   ⓑ `rejectedFeatures` 상태가 라운드를 넘어 같은 제안의 «재제안»을 막는가
describe('decompose rejection — dangling dependsOn 관측과 라운드 간 중복 제안 방지', () => {
  /** 매달린 선행 간선(`ghost`)이 있는 제안 — shadow-first 가드가 거부한다. */
  const danglingProposal = () => ({
    shardId: 'run-single',
    pieces: [
      { id: 'p1', feature: 'part one', dependsOn: ['ghost'], hotPathOverlaps: [] },
      { id: 'p2', feature: 'part two', dependsOn: [], hotPathOverlaps: [] },
    ],
    hotPathOverlaps: [],
  });

  it('records dangling-dependsOn decompose rejections and skips re-proposal in later rounds', async () => {
    const specs: DevPipelineSpec[] = [];
    let call = 0;
    let readCalls = 0;
    const executeReroute = (async (spec: DevPipelineSpec) => {
      specs.push(spec);
      call++;
          return call <= 2
            ? { results: [{ taskId: 'task-single', feature: 'big goal', status: 'done', stage: 'pr-opened', runId: 'run-single' } as SelfDevJobResult], exitCode: 1 }
            : { results: [{ taskId: 't', feature: 'f', status: 'done', stage: 'merged', merged: true } as SelfDevJobResult], exitCode: 0 };
    }) as OrchestrateCliDeps['executeReroute'];

    const spy = spyOn(debug, 'log');
    try {
      await runSelfOrchestrateCliCommand(
        { goals: [{ feature: 'big goal' }], runtime: {}, supervise: { rounds: 3, stallRounds: 99 } },
        {
          executeReroute,
          readProposals: () => {
            readCalls++;
            return {
              proposals: new Map([['run-single', danglingProposal()]]),
              goalPlanRevisions: new Map(),
              scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/x',
            };
          },
        },
      );
      // ⓐ 관측 채널 두 곳에 거부가 남는다 — 조각 채널(decompose-rejected)과 슈퍼바이저 채널(applied).
      const decomposeLogs = spy.mock.calls.filter((c) => c[0] === 'self-dev.decompose' && c[1] === 'decompose-rejected');
      expect(decomposeLogs.length).toBeGreaterThanOrEqual(1);
      expect(decomposeLogs[0]?.[2]).toMatchObject({ reason: 'dangling-dependsOn', danglingIds: ['ghost'] });
      const supervisorLogs = spy.mock.calls.filter((c) => c[0] === 'self-dev.supervisor' && c[1] === 'decompose-rejected.applied');
      expect(supervisorLogs.length).toBeGreaterThanOrEqual(1);
      expect((supervisorLogs[0]?.[2] as { rejected: unknown[] }).rejected).toHaveLength(1);
      // ⓑ 다음 라운드는 같은 제안을 다시 읽지만(원장은 그대로) 재거부 관측은 «한 번만» 남는다.
      expect(readCalls).toBeGreaterThanOrEqual(2);
      expect(decomposeLogs.length).toBe(1);
      expect(supervisorLogs.length).toBe(1);
      // 거부된 골은 원본 그대로 다시 건다 — 조각으로 승격되지 않는다.
      const second = specs[1] as { parallel?: { goals?: { feature: string }[] } };
      expect(second.parallel?.goals?.map((g) => g.feature)).toEqual(['big goal']);
    } finally {
      spy.mockRestore();
    }
  });
});