// TA-GRAPH-1124 H4 — legacy 엔진의 parity 기준선(픽스처 12 + 보조 1). 기대값은 parity-scenarios.ts 의 손으로 쓴 리터럴이고,
// 이 파일은 (1) legacy 가 그 리터럴대로 걷는지 (2) 기록된 기준선 파일이 리터럴과 같은지 (3) 비교기가 차이를 잡는지를 본다.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setLaunchGrokQuotaReaderForTesting } from '../../self-dev/dev-cli.js';
import { disableLandingFreeze, enableLandingFreeze } from '../../release-loop/landing-freeze.js';
import { runSelfImplement } from '../orchestrator.js';
import { compareEngines, diffWalks, runScenario, type SiWalk } from './parity.js';
import { SI_PARITY_SCENARIOS } from './parity-scenarios.js';

const PRIOR = { ELANOUS_STATE_DIR: process.env.ELANOUS_STATE_DIR, ELANOUS_POD_NAME: process.env.ELANOUS_POD_NAME, ELANOUS_SUBSTRATE: process.env.ELANOUS_SUBSTRATE };
const stateDir = mkdtempSync(join(tmpdir(), 'si-parity-test-'));

beforeAll(async () => {
  await Promise.all([import('../graph-stage-units.js'), import('../../task-orchestrator/surfaces/self-implement.js'), import('../../task-orchestrator/surfaces/pod-failure-reason.js')]);
  process.env.ELANOUS_STATE_DIR = stateDir;
  delete process.env.ELANOUS_POD_NAME;
  delete process.env.ELANOUS_SUBSTRATE;
}, 120_000); // Source: orchestrator.test.ts 와 같은 사전 import 예산(차가운 모듈 그래프 로드).

afterAll(() => {
  for (const [key, value] of Object.entries(PRIOR)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(stateDir, { recursive: true, force: true });
});

const BASELINE_PATH = join(import.meta.dir, '__fixtures__', 'si-parity-legacy-baseline.json');

describe('시나리오 표', () => {
  test('12 개 + 보조 2, id 는 서로 다르다(독립 리터럴 목록과 대조)', () => {
    expect(SI_PARITY_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      'normal-merge', 'gate-fail-rework-pass', 'must-fix-twice', 'empty-change', 'merge-conflict', 'regate-fail',
      'pr-open-failure', 'pr-declined', 'freeze-hold', 'pod-merge-ready', 'soft-stop', 'timeout', 'pod-worktree-completed', 'rework-child-rebind',
    ]);
  });
});

describe('legacy 엔진은 손으로 쓴 걸음 리터럴대로 걷는다', () => {
  for (const scenario of SI_PARITY_SCENARIOS) {
    test(`${scenario.id} — ${scenario.title}`, async () => {
      const actual = await runScenario(scenario.plan, runSelfImplement, {
        setFreeze: (on) => { if (on) enableLandingFreeze({ reason: 'si-parity-test', by: 'si-parity.test' }); else disableLandingFreeze(); },
        setGrokQuota: (quota) => setLaunchGrokQuotaReaderForTesting(quota ? () => quota : undefined),
      });
      expect(diffWalks(scenario.expected, actual)).toEqual([]);
      expect(actual).toEqual(scenario.expected);
    }, 60_000); // Source: 시나리오 하나 = runSelfImplement 한 번(가짜 seam · 실측 ~1s) 의 여유; timeout 시나리오는 implement 한도 100ms 를 쓴다.
  }
});

describe('기록된 기준선 파일', () => {
  test('si-parity-legacy-baseline.json 은 기대 리터럴과 같다 — 녹화가 기대를 조용히 바꾸지 않는다', () => {
    const recorded = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Record<string, SiWalk>;
    expect(Object.keys(recorded)).toEqual(SI_PARITY_SCENARIOS.map((scenario) => scenario.id));
    for (const scenario of SI_PARITY_SCENARIOS) expect(recorded[scenario.id]).toEqual(scenario.expected);
  });
});

describe('비교기(두 엔진 parity 판정)', () => {
  const sample: SiWalk = { walk: ['implement@0', 'gate@0'], stage: 'gate-failed', node: 'gate', ok: false, merged: false, seamCalls: ['implement', 'gate'] };

  test('같으면 차이 없음, 어느 칸이든 다르면 그 칸 이름과 기대·실제를 보고한다', () => {
    expect(diffWalks(sample, { ...sample })).toEqual([]);
    expect(diffWalks(sample, { ...sample, stage: 'merged' })).toEqual(['stage: 기대 "gate-failed" ≠ 실제 "merged"']);
    expect(diffWalks(sample, { ...sample, walk: ['implement@0', 'rework@1'] })).toEqual(['walk: 기대 ["implement@0","gate@0"] ≠ 실제 ["implement@0","rework@1"]']);
    expect(diffWalks(sample, { ...sample, seamCalls: ['implement'], merged: true })).toEqual([
      'merged: 기대 false ≠ 실제 true', 'seamCalls: 기대 ["implement","gate"] ≠ 실제 ["implement"]',
    ]);
  });

  test('compareEngines: 후보에 없는 시나리오·다른 걸음을 시나리오별로 잡는다(12/12 판정의 바탕)', () => {
    const baseline = { a: sample, b: { ...sample, stage: 'merged' } };
    expect(compareEngines(baseline, baseline)).toEqual([{ id: 'a', diffs: [] }, { id: 'b', diffs: [] }]);
    const rows = compareEngines(baseline, { a: sample });
    expect(rows).toEqual([{ id: 'a', diffs: [] }, { id: 'b', diffs: ['후보 엔진에 이 시나리오 결과가 없다'] }]);
    expect(compareEngines(baseline, { a: { ...sample, node: 'review' }, b: baseline.b })[0]).toEqual({ id: 'a', diffs: ['node: 기대 "gate" ≠ 실제 "review"'] });
  });
});

describe('조건 훅은 필수 — 없으면 명시적으로 실패한다(규칙 14: 조건 없이 통과 금지)', () => {
  const freeze = SI_PARITY_SCENARIOS.find((scenario) => scenario.id === 'freeze-hold')!;
  const rebind = SI_PARITY_SCENARIOS.find((scenario) => scenario.id === 'rework-child-rebind')!;
  const plain = SI_PARITY_SCENARIOS.find((scenario) => scenario.id === 'soft-stop')!;

  test('freeze 시나리오를 setFreeze 없이 돌리면 엔진을 부르기 전에 던진다', async () => {
    let engineCalls = 0;
    const engine = async () => { engineCalls += 1; throw new Error('engine must not run'); };
    await expect(runScenario(freeze.plan, engine as never, {})).rejects.toThrow('hooks.setFreeze 가 필수다');
    expect(engineCalls).toBe(0);
  });

  test('재바인딩(grokExhausted) 시나리오를 setGrokQuota 없이 돌리면 던지고, 환경 변수는 건드리지 않는다', async () => {
    const before = process.env.ELANOUS_SUBSTRATE;
    await expect(runScenario(rebind.plan, (async () => { throw new Error('engine must not run'); }) as never, { setFreeze: () => {} })).rejects.toThrow('hooks.setGrokQuota 가 필수다');
    expect(process.env.ELANOUS_SUBSTRATE).toBe(before);
  });

  test('훅이 필요 없는 시나리오는 훅 없이도 돈다', async () => {
    expect(await runScenario(plain.plan, runSelfImplement, {})).toEqual(plain.expected);
  });
});

describe('설정 단계 예외에도 전역 상태를 각각 복원한다', () => {
  const freeze = SI_PARITY_SCENARIOS.find((scenario) => scenario.id === 'freeze-hold')!;
  const rebind = SI_PARITY_SCENARIOS.find((scenario) => scenario.id === 'rework-child-rebind')!;
  const engineNeverRuns = (async () => { throw new Error('engine must not run'); }) as never;

  test('setGrokQuota 가 던지면: 이미 건 substrate·freeze 를 되돌리고(동결 해제 포함) 오류는 «threw:» 로 삼키지 않고 전파한다', async () => {
    const calls: string[] = [];
    const before = process.env.ELANOUS_SUBSTRATE;
    // freeze + substrate + grokExhausted 를 한 계획에 모아 설정 순서(freeze → substrate → grok)의 마지막에서 던지게 한다.
    const plan = { ...rebind.plan, freeze: true, substrate: 'pod' as const };
    await expect(runScenario(plan, engineNeverRuns, {
      setFreeze: (on) => { calls.push(`freeze:${on}`); },
      setGrokQuota: (quota) => { calls.push(`grok:${quota ?? 'undefined'}`); if (quota === 'exhausted') throw new Error('quota device down'); },
    })).rejects.toThrow('quota device down');
    expect(process.env.ELANOUS_SUBSTRATE).toBe(before);
    // 적용 순서대로 freeze 켬 → grok 시도(던짐) → 복원: grok 해제 → freeze 해제 (substrate 는 환경 변수로 위에서 복원 확인)
    expect(calls).toEqual(['freeze:true', 'grok:exhausted', 'grok:undefined', 'freeze:false']);
  });

  test('setFreeze 가 처음에 던지면: 아무것도 적용되지 않았으므로 복원할 것도 없다(훅·환경 변수 불변)', async () => {
    const calls: string[] = [];
    const before = process.env.ELANOUS_SUBSTRATE;
    await expect(runScenario({ ...freeze.plan, substrate: 'pod' as const }, engineNeverRuns, {
      setFreeze: (on) => { calls.push(`freeze:${on}`); if (on) throw new Error('freeze device down'); },
    })).rejects.toThrow('freeze device down');
    expect(process.env.ELANOUS_SUBSTRATE).toBe(before);
    expect(calls).toEqual(['freeze:true', 'freeze:false']);
  });

  test('복원 훅 하나가 던져도 나머지 복원은 계속된다(첫 오류를 마지막에 전파)', async () => {
    const calls: string[] = [];
    const before = process.env.ELANOUS_SUBSTRATE;
    const plan = { ...rebind.plan, freeze: true, substrate: 'pod' as const };
    await expect(runScenario(plan, (async () => { throw new Error('engine boom (x)'); }) as never, {
      setFreeze: (on) => { calls.push(`freeze:${on}`); },
      setGrokQuota: (quota) => { calls.push(`grok:${quota ?? 'undefined'}`); if (quota === undefined) throw new Error('grok restore failed'); },
    })).rejects.toThrow('grok restore failed');
    expect(process.env.ELANOUS_SUBSTRATE).toBe(before); // grok 복원이 던졌어도 substrate·freeze 는 되돌려졌다
    expect(calls).toEqual(['freeze:true', 'grok:exhausted', 'grok:undefined', 'freeze:false']);
  });
});
