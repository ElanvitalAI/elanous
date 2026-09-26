import { describe, expect, it } from 'bun:test';
import { OVERLAY_STATE_KEYS, overlayDecisionObservation, decideTemplate, resolveGraphAuthority } from '../src/self-implement/graph-authority.js';
import type { GraphOverlaySpec } from '../src/self-implement/graph-overlay-yaml.js';
import { runSelfImplement } from '../src/self-implement/orchestrator.js';
import { seams } from '../src/self-implement/test-seams.js';
import type { RunLedgerEntry } from '../src/self-implement/run-ledger.js';

const overlay: GraphOverlaySpec = {
  overlayId: 'attempts-threshold',
  target: 'self-implement',
  stage: 'runtime',
  appliesWhen: 'attempts >= 3',
  patch: [{ op: 'replace', path: '/nodes/0/maxVisits', value: 2 }],
};

function payload(state: Record<string, unknown>) {
  return overlayDecisionObservation({
    graphId: 'self-implement',
    graphVersion: 'v1',
    stage: 'runtime',
    round: 3,
    considered: 1,
    applied: ['overlay'],
    selections: [{ overlayId: 'overlay', verdict: 'applies' as const }],
    rejections: [{ overlayId: 'rejected' }],
    state,
  });
}

describe('graph overlay decision observation state', () => {
  it('preserves existing payload keys and only condition-referenced runtime state keys', () => {
    const observation = payload({ attempts: 3, goal_id: 'goal-x', ignored: 'not-recorded' });

    expect(observation).toMatchObject({
      graphId: 'self-implement',
      graphVersion: 'v1',
      stage: 'runtime',
      round: 3,
      considered: 1,
      applied: ['overlay'],
      selections: [{ overlayId: 'overlay', verdict: 'applies' }],
      rejections: [{ overlayId: 'rejected' }],
      state: { attempts: 3, goal_id: 'goal-x' },
    });
    expect(observation.state).toEqual({ attempts: 3, goal_id: 'goal-x' });
  });

  it('records actual absent, non-applying, and applying decisions without synthesizing condition keys', () => {
    const authority = resolveGraphAuthority({ flag: true });
    const decide = (state: Record<string, unknown>) => decideTemplate({
      goalType: 'implement', authority, overlays: [overlay], state, stage: 'runtime',
    });
    const absent = decide({ goal_id: 'goal-x' });
    const belowThreshold = decide({ attempts: 2, goal_id: 'goal-x' });
    const atThreshold = decide({ attempts: 3, goal_id: 'goal-x' });
    const observations = [
      overlayDecisionObservation({ state: { goal_id: 'goal-x' }, selections: absent.selections }),
      overlayDecisionObservation({ state: { attempts: 2, goal_id: 'goal-x' }, selections: belowThreshold.selections }),
      overlayDecisionObservation({ state: { attempts: 3, goal_id: 'goal-x' }, selections: atThreshold.selections }),
    ];

    expect(observations).toEqual([
      { state: { goal_id: 'goal-x' }, selections: [{ overlayId: 'attempts-threshold', verdict: 'key-absent', detail: 'attempts' }] },
      { state: { attempts: 2, goal_id: 'goal-x' }, selections: [{ overlayId: 'attempts-threshold', verdict: 'does-not-apply' }] },
      { state: { attempts: 3, goal_id: 'goal-x' }, selections: [{ overlayId: 'attempts-threshold', verdict: 'applies' }] },
    ]);
    expect(atThreshold.appliedIds).toEqual(['attempts-threshold']);
  });

  it('collects launch and runtime observations from the actual orchestrator execution path', async () => {
    const ledger: RunLedgerEntry[] = [];
    await runSelfImplement({
      feature: 'graph overlay observation execution path',
      goalId: 'goal-x',
      seams: seams({
        writeRunLedger: (entry) => ledger.push(entry),
      }),
    });

    const decisions = ledger.filter((entry) => entry.event === 'graph-overlay-decision');
    const launch = decisions.find((entry) => entry.data.stage === 'launch');
    const runtime = decisions.find((entry) => entry.data.stage === 'runtime');

    expect(launch?.data).toMatchObject({ state: { goal_id: 'goal-x' } });
    expect(launch?.data.state).toEqual({ goal_id: 'goal-x' });
    expect(runtime?.data).toMatchObject({ state: { attempts: 0, goal_id: 'goal-x' } });
    expect(runtime?.data.state).toEqual({ attempts: 0, goal_id: 'goal-x' });
    expect(launch?.data).toMatchObject({ applied: expect.any(Array), considered: expect.any(Number), selections: expect.any(Array), rejections: expect.any(Array), graphId: expect.any(String) });
    expect(runtime?.data).toMatchObject({ applied: expect.any(Array), considered: expect.any(Number), selections: expect.any(Array), rejections: expect.any(Array), graphId: expect.any(String), round: 0 });
  });
});

// 🔴 목록 밖 키를 «조용히» 버리지 않는다 — 그러면 이 골이 없애려던 병을 한 층 아래에서 다시 짓는다.
//    반증: overlayDecisionObservation 에서 stateExtraKeys 를 지우면 이 시험이 빨강이어야 한다.
it('⛔ 어휘 밖 상태 키는 «값은 안 싣되 이름은 남긴다» — 조용한 유실이 아니다', () => {
  const observation = overlayDecisionObservation({
    state: { attempts: 3, goal_id: 'goal-x', track: 'S', retries: 0 },
  });
  // ⛔ `T & { state }` 교차라 `observation.state` 의 «정적» 타입은 입력 리터럴을 그대로 안고 있다.
  //    잰 것은 «런타임 값»이므로 넓혀서 비교한다 — 타입이 아니라 값을 묻는 자리다.
  const recorded: Readonly<Record<string, unknown>> = observation.state;
  expect(recorded).toEqual({ attempts: 3, goal_id: 'goal-x' });
  expect(observation.stateExtraKeys).toEqual(['retries', 'track']);
  // ⛔ 목록 «안»의 키만 왔으면 그 필드가 아예 «없다» — 「빈 배열」과 「안 잼」을 섞지 않는다
  expect(overlayDecisionObservation({ state: { goal_id: 'g' } }).stateExtraKeys).toBeUndefined();
  // ⭐ 어휘 자체가 한 자리에 산다 — 실행기가 주는 키가 여기서 갈린다
  expect([...OVERLAY_STATE_KEYS]).toEqual(['attempts', 'goal_id']);
});
