// A1 sample replay — the co-located gate (release checklist 0.3.32 P0 · CAPSULE-A1-POLICY remaining boundary).
// The judgment log must capture every isolation axis of the 11-18 46-minute «Responding» turn sample.
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from '../../../elanous-config-dir.js';
import { debug } from '../../../debug/log.js';
import { runSimWorlds } from '../kernel.js';
import { a1SampleDecision, bindSamplePolicyRows } from './a1-sample.js';

test('A1 sample replay passes against the green table row (judgment log covers all four axes)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'a1-sample-'));
  try {
    const result = await runSimWorlds({
      worldId: 'capsule-events',
      seed: 1,
      engine: 'legacy',
      only: 'A1',
      expectBaseFile: null,
      stateRoot: root,
      runId: 'a1-sample',
      isolate: 'inline',
    });
    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0]).toMatchObject({ scenario: 'A1', actual: 'pass', verdict: 'pass' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test('A1 sample isolates the host user turn.syncCapMs — 유효한 사용자 설정(5000)이어도 기본 경계 판정은 통과해야 한다 (terra r8 mustFix[2])', async () => {
  // 숙주 config가 유효한 사용자 설정 turn.syncCapMs=5000을 가져도 시나리오의 기본 경계 판정(기본 cap 10000)은
  // 그 설정과 무관해야 한다 — 격리 전에는 제품이 정상이어도 시뮬레이션이 실패한다(terra r8 mustFix[2]).
  // 사용자 설정 반영 자체는 시나리오 안의 별도 reflection 턴이 검증한다.
  const root = mkdtempSync(join(tmpdir(), 'a1-sample-hostcfg-'));
  try {
    const cfgDir = join(root, 'config');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ turn: { syncCapMs: 5000 } }));
    const savedOverride = getElanousConfigDirOverride();
    setElanousConfigDir(cfgDir);
    try {
      const result = await runSimWorlds({
        worldId: 'capsule-events',
        seed: 1,
        engine: 'legacy',
        only: 'A1',
        expectBaseFile: null,
        stateRoot: join(root, 'state'),
        runId: 'a1-sample-hostcfg',
        isolate: 'inline',
      });
      expect(result.scenarios).toHaveLength(1);
      expect(result.scenarios[0]).toMatchObject({ scenario: 'A1', actual: 'pass', verdict: 'pass' });
    } finally {
      if (savedOverride === undefined) resetElanousConfigDir(); else setElanousConfigDir(savedOverride);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test('A1 시나리오 턴 동안 프로세스 전역 config dir은 한 번도 바뀌지 않는다 — 시나리오별 주입 (terra r9 mustFix[0])', async () => {
  // terra r9 mustFix[0]: 시나리오가 턴 사이 프로세스 전역 config dir을 임시 경로로 바꾸면 병행 실행 중인
  // 실제 턴도 시험용 기본값·5000을 읽는다. 경계는 시나리오별이어야 한다 — 메인 턴은 주입
  // (capsulePolicyTurnConfig), 반영 턴은 fixture 파일 경로 핀(capsulePolicyTurnConfigPath · terra r10
  // mustFix[1] 실제 로딩 경로) — 그리고 전역 override는 턴 진행 중 관측돼서는 안 된다. 판정 행이 도착하는
  // 매 순간 전역 override를 샘플링한다.
  // RED(수리 전): 메인 턴 판정 행 도착 시점에 override가 임시 격리 경로로 잡힌다.
  const root = mkdtempSync(join(tmpdir(), 'a1-sample-boundary-'));
  const overridesAtRows: unknown[] = [];
  const originalLog = debug.log;
  const savedOverride = getElanousConfigDirOverride();
  try {
    (debug as { log: (category: string, event: string, data?: unknown) => void }).log =
      (category, event, data) => {
        if (category === 'turn-life') overridesAtRows.push(getElanousConfigDirOverride());
        try { originalLog.call(debug, category, event, data); } catch { /* mirror must not break the seat */ }
      };
    const result = await runSimWorlds({
      worldId: 'capsule-events',
      seed: 1,
      engine: 'legacy',
      only: 'A1',
      expectBaseFile: null,
      stateRoot: root,
      runId: 'a1-sample-boundary',
      isolate: 'inline',
    });
    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0]).toMatchObject({ scenario: 'A1', actual: 'pass', verdict: 'pass' });
    // 출처: #39534 — A1 관측자 통과 단언. 0 초과는 이 시험의 고정 계약(판정 행 ≥1), 임의 상한 튜닝 아님. 근거: r10 RED 게이트 rules-and-ratchets NUMGUARD 지적 라인.
    expect(overridesAtRows.length).toBeGreaterThan(0);
    expect(overridesAtRows.every(v => v === savedOverride)).toBe(true); // 턴 진행 중 전역 override 불변
  } finally {
    try { (debug as { log: unknown }).log = originalLog; } catch { /* already restored by the scenario */ }
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test('A1 judgment binding rejects rows from other sessions — 다른 세션 행만 있으면 실패 (HOLD #122689 음성 대조)', () => {
  // 위양성 차단: 전역 판단 로그의 4축 kind 집합이 다른 턴(다른 sessionId)의 행으로 채워져도
  // 이 시나리오의 판정은 실패해야 한다. 행 결속은 sessionId ⊕ dispatched tool ↔ kind 1:1.
  const foreignRows = [
    { event: 'turn-life:capsule-policy', data: { sessionId: 'other-session-0001', tool: 'Bash', kind: 'shell', mode: 'sync', syncCapMs: 20000, reason: 'capsule-sync-cap' } },
    { event: 'turn-life:capsule-policy', data: { sessionId: 'other-session-0001', tool: 'Agent', kind: 'agent', mode: 'sync', syncCapMs: 20000, reason: 'capsule-sync-cap' } },
    { event: 'turn-life:capsule-policy', data: { sessionId: 'other-session-0001', tool: 'RunDevHarness', kind: 'harness', mode: 'sync', syncCapMs: 20000, reason: 'capsule-sync-cap' } },
    { event: 'turn-life:capsule-policy', data: { sessionId: 'other-session-0001', tool: 'mcp__a1_sample__probe', kind: 'mcp', mode: 'sync', syncCapMs: 20000, reason: 'capsule-sync-cap' } },
  ];
  const verdict = bindSamplePolicyRows({
    rows: foreignRows,
    sessionId: 'a1-sample-this-session',
    dispatched: ['Bash', 'Agent', 'RunDevHarness', 'mcp__a1_sample__probe'],
  });
  expect(verdict.ok).toBe(false);
  expect(verdict.missing).toHaveLength(4);
});

test('A1 judgment binding rejects a mis-configured syncCapMs — 오배선(5000) 행은 실패 (JUD-B #127289 음성 대조)', () => {
  // 결속 단언: 결속된 판정 행의 syncCapMs·mode·reason은 시나리오 기대값(기본 cap 10000 · sync · capsule-sync-cap)과
  // 정확 일치해야 한다. 오배선 cap(예: 5000)으로 남은 행은 문자열 존재만으로는 통과할 수 없다.
  const misConfiguredRows = [
    { event: 'turn-life:capsule-policy', data: { sessionId: 'a1-sample-this-session', tool: 'Bash', kind: 'shell', mode: 'sync', syncCapMs: 5000, reason: 'capsule-sync-cap' } },
    { event: 'turn-life:capsule-policy', data: { sessionId: 'a1-sample-this-session', tool: 'Agent', kind: 'agent', mode: 'sync', syncCapMs: 5000, reason: 'capsule-sync-cap' } },
    { event: 'turn-life:capsule-policy', data: { sessionId: 'a1-sample-this-session', tool: 'RunDevHarness', kind: 'harness', mode: 'sync', syncCapMs: 5000, reason: 'capsule-sync-cap' } },
    { event: 'turn-life:capsule-policy', data: { sessionId: 'a1-sample-this-session', tool: 'mcp__a1_sample__probe', kind: 'mcp', mode: 'sync', syncCapMs: 5000, reason: 'capsule-sync-cap' } },
  ];
  const verdict = bindSamplePolicyRows({
    rows: misConfiguredRows,
    sessionId: 'a1-sample-this-session',
    dispatched: ['Bash', 'Agent', 'RunDevHarness', 'mcp__a1_sample__probe'],
  });
  expect(verdict.ok).toBe(false);
});

test('A1 judgment binding rejects divergent mode/reason — 문자열 존재가 아니라 정확 일치 (JUD-B #127289)', () => {
  const divergentRows = [
    { event: 'turn-life:capsule-policy', data: { sessionId: 'a1-sample-this-session', tool: 'Bash', kind: 'shell', mode: 'detach', syncCapMs: 10000, reason: 'capsule-sync-cap' } },
    { event: 'turn-life:capsule-policy', data: { sessionId: 'a1-sample-this-session', tool: 'Agent', kind: 'agent', mode: 'sync', syncCapMs: 10000, reason: 'requested-background' } },
    { event: 'turn-life:capsule-policy', data: { sessionId: 'a1-sample-this-session', tool: 'RunDevHarness', kind: 'harness', mode: 'sync', syncCapMs: 10000, reason: 'capsule-sync-cap' } },
    { event: 'turn-life:capsule-policy', data: { sessionId: 'a1-sample-this-session', tool: 'mcp__a1_sample__probe', kind: 'mcp', mode: 'sync', syncCapMs: 10000, reason: 'capsule-sync-cap' } },
  ];
  const verdict = bindSamplePolicyRows({
    rows: divergentRows,
    sessionId: 'a1-sample-this-session',
    dispatched: ['Bash', 'Agent', 'RunDevHarness', 'mcp__a1_sample__probe'],
  });
  expect(verdict.ok).toBe(false);
});

test('A1 judgment expectation is an independent literal — 상수 변이(cap 5000)는 기대치가 아니라 mismatch로 잡힌다 (JUD-B #127560 음성 대조)', () => {
  // #127560: EXPECTED_DECISION.syncCapMs 가 제품 CAPSULE_SYNC_CAP_MS 를 import 하면 상수 자체가 5000으로
  // 바뀌었을 때 기대치도 5000으로 동반 변이되어 오배선이 통과한다. 기대는 독립 리터럴 10000 이어야 한다.
  // 이 음성 대조는 모든 축이 "제품 상수가 만약 5000이었다면" 의 값을 가진 행을 주고 — 기대 리터럴이
  // 10000 이므로 전원 mismatch 로 ok:false 여야 한다 (기대가 import 였다면 ok:true 로 통과했을 것).
  const driftedRows = [
    { event: 'turn-life:capsule-policy', data: { sessionId: 'a1-sample-this-session', tool: 'Bash', kind: 'shell', mode: 'sync', syncCapMs: 5000, reason: 'capsule-sync-cap' } },
    { event: 'turn-life:capsule-policy', data: { sessionId: 'a1-sample-this-session', tool: 'Agent', kind: 'agent', mode: 'sync', syncCapMs: 5000, reason: 'capsule-sync-cap' } },
    { event: 'turn-life:capsule-policy', data: { sessionId: 'a1-sample-this-session', tool: 'RunDevHarness', kind: 'harness', mode: 'sync', syncCapMs: 5000, reason: 'capsule-sync-cap' } },
    { event: 'turn-life:capsule-policy', data: { sessionId: 'a1-sample-this-session', tool: 'mcp__a1_sample__probe', kind: 'mcp', mode: 'sync', syncCapMs: 5000, reason: 'capsule-sync-cap' } },
  ];
  const verdict = bindSamplePolicyRows({
    rows: driftedRows,
    sessionId: 'a1-sample-this-session',
    dispatched: ['Bash', 'Agent', 'RunDevHarness', 'mcp__a1_sample__probe'],
  });
  expect(verdict.ok).toBe(false);
  expect(verdict.mismatch ?? null).not.toBeNull(); // JUD-B #127605: undefined(빠진 필드)도 검출되어야 한다
});

test('A1 scenario decision tail rejects a mismatch-only verdict end-to-end — 누락·thin 없이 오판정값만 다른 행은 ok:true로 통과할 수 없다 (JUD-B #127605 종단 음성 대조)', () => {
  // 종단 판정 경로(a1SampleDecision — 시나리오 run() tail)에 대한 음성 대조. mismatch 필드가 반환 객체에
  // 빠져 undefined 였다면(JUD-B #127605 지적 상태) 이 검사는 ok:true로 통과했을 것이다.
  const driftedRows = [
    { event: 'turn-life:capsule-policy', data: { sessionId: 'a1-sample-this-session', tool: 'Bash', kind: 'shell', mode: 'sync', syncCapMs: 5000, reason: 'capsule-sync-cap' } },
    { event: 'turn-life:capsule-policy', data: { sessionId: 'a1-sample-this-session', tool: 'Agent', kind: 'agent', mode: 'sync', syncCapMs: 10000, reason: 'capsule-sync-cap' } },
    { event: 'turn-life:capsule-policy', data: { sessionId: 'a1-sample-this-session', tool: 'RunDevHarness', kind: 'harness', mode: 'sync', syncCapMs: 10000, reason: 'capsule-sync-cap' } },
    { event: 'turn-life:capsule-policy', data: { sessionId: 'a1-sample-this-session', tool: 'mcp__a1_sample__probe', kind: 'mcp', mode: 'sync', syncCapMs: 10000, reason: 'capsule-sync-cap' } },
  ];
  const dispatched = ['Bash', 'Agent', 'RunDevHarness', 'mcp__a1_sample__probe'];
  const bound = bindSamplePolicyRows({ rows: driftedRows, sessionId: 'a1-sample-this-session', dispatched });
  // 명시 값 검사 (JUD-B #127605): 오판정 행 자체를 짚어야 한다.
  expect(bound.missing).toHaveLength(0);
  expect(bound.thin).toBeNull();
  expect(bound.mismatch?.data).toMatchObject({ tool: 'Bash', syncCapMs: 5000 });
  const decision = a1SampleDecision(bound, dispatched);
  expect(decision.ok).toBe(false);
  // SimWorldScenarioOutcome(types.ts)은 판별 유니언 — reason·diff 는 ok:false 가지에만 있다.
  // ok:false 단언만으로는 타입이 좁혀지지 않으므로 가드를 둔다(changed-tsc TS2339 수리 · JUD-B #127626).
  if (decision.ok) throw new Error('JUD-B #127605 종단 음성 대조: mismatch-only 가 ok:true 로 통과하면 안 된다');
  expect(decision.reason).toBe('a judgment row diverges from the expected decision (mode·reason·syncCapMs exact match)');
  expect(decision.diff).toContain('"syncCapMs":5000');
});
