// OP-BEHAVIOR-SIM-EVAL (OP 배정 P0 · 0.3.34 · 19:5x «시뮬 월드·테스트 우주·이벤트 합성으로 확인»)
// 오늘 실사고 6개를 이벤트로 합성해 격리 우주의 eln OP 를 돌리고
// 인터럽트 수 · 시도 없는 보류 · 턴당 입력 토큰을 점수화하는 시나리오 하네스의 순수 코어 시험.
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BASELINE_POLICY,
  CONTRACT_POLICY,
  INCIDENT_SCENARIOS,
  compareRuns,
  incidentSeatItems,
  runIncidentScenario,
  scoreIncidentRun,
  type SimScoredRun,
  type SimUsageRow,
} from './op-behavior-sim.js';
import type { SeatEntry } from './seat-loop.js';

const at = (i: number) => `2026-11-23T18:${String(i).padStart(2, '0')}:00.000Z`;
const entry = (over: Partial<SeatEntry> & { at: string; status: SeatEntry['status'] }): SeatEntry =>
  ({ seat: 'OP', ...over }) as SeatEntry;
const item = (id: string) => ({ source: 'request', kind: 'request', id, title: id, text: id }) as SeatEntry['item'];

test('시나리오 목록 = 오늘 실사고 6종 그대로', () => {
  expect(INCIDENT_SCENARIOS.map((s) => s.id)).toEqual([
    'mail-flood-30', 'approval-prompt', 'tool-rejection', 'landing-zero', 'crown-question', 'long-session-2h',
  ]);
  expect(INCIDENT_SCENARIOS.map((s) => s.title)).toEqual([
    '우편 30통 폭주', '승인 프롬프트', '도구 거부', '착지 0', '결정급 질문', '2시간 긴 세션',
  ]);
});

test('우편 30통 폭주 합성 — 요청 30개·고유 id·전부 request', () => {
  const items = incidentSeatItems('mail-flood-30');
  expect(items).toHaveLength(30);
  expect(new Set(items.map((i) => i.id)).size).toBe(30);
  expect(items.every((i) => i.source === 'request' && i.kind === 'request')).toBe(true);
});

test('결정급 질문 합성 — 우편으로 온 되돌릴 수 있는 결정 질문 1건(CEO 발신)', () => {
  const items = incidentSeatItems('crown-question');
  expect(items).toHaveLength(1);
  expect(items[0]!.source).toBe('request');
  expect(items[0]!.kind).toBe('request');
  expect(items[0]!.from).toBe('CEO');
});

test('승인 프롬프트·도구 거부·착지 0·긴 세션 합성 — 각 1건씩 식별 가능한 id', () => {
  for (const id of ['approval-prompt', 'tool-rejection', 'landing-zero', 'long-session-2h'] as const) {
    const items = incidentSeatItems(id);
    expect(items).toHaveLength(1);
    expect(items[0]!.id.startsWith('sim-')).toBe(true);
  }
});

test('보류 후 시도 없음 = 1점 · 같은 항목 뒤 재시도 있으면 0점', () => {
  const deferredAlone = [
    entry({ at: at(1), status: 'wait', item: item('a') }),
  ];
  expect(scoreIncidentRun(deferredAlone, []).deferralsWithoutRetry).toBe(1);

  const deferredThenRetried = [
    entry({ at: at(1), status: 'wait', item: item('a') }),
    entry({ at: at(2), status: 'attempting', item: item('a') }),
  ];
  expect(scoreIncidentRun(deferredThenRetried, []).deferralsWithoutRetry).toBe(0);
});

test('인터럽트 = outcome-unknown 행 수', () => {
  const entries = [
    entry({ at: at(1), status: 'launched', item: item('a') }),
    entry({ at: at(2), status: 'outcome-unknown', item: item('a') }),
    entry({ at: at(3), status: 'outcome-unknown', item: item('b') }),
  ];
  expect(scoreIncidentRun(entries, []).interrupts).toBe(2);
});

test('턴당 입력 토큰 = inputTokens 합 / 턴 수(서로 다른 at 값)', () => {
  const entries = [
    entry({ at: at(1), status: 'launched', item: item('a') }),
    entry({ at: at(2), status: 'resolved', item: item('a') }),
  ];
  const usage: SimUsageRow[] = [{ inputTokens: 900 }, { inputTokens: 300 }];
  expect(scoreIncidentRun(entries, usage).inputTokensPerTurn).toBe(600);
  expect(scoreIncidentRun(entries, usage).turns).toBe(2);
});

test('비교표 — 기준선 main vs 계약 적용의 전후 숫자를 시나리오별로 찍는다', () => {
  const run = (scenario: string, score: Partial<SimScoredRun['score']>): SimScoredRun => ({
    scenario, score: {
      interrupts: 0, deferralsWithoutRetry: 0, turns: 0, inputTokensPerTurn: 0,
      humanQuestions: 0, unattemptedRequests: 0, processedRequests: 0, ...score,
    },
  });
  const table = compareRuns(
    [run('mail-flood-30', { turns: 30, deferralsWithoutRetry: 3, processedRequests: 3 })],
    [run('mail-flood-30', { turns: 1, deferralsWithoutRetry: 0, processedRequests: 30 })],
  );
  const joined = table.join('\n');
  expect(joined).toContain('mail-flood-30');
  expect(joined).toContain('| 30 | 1 |'); // 턴 수 전후
  expect(joined).toContain('| 3 | 0 |'); // 시도 없는 보류 전후
  expect(joined).toContain('| 3 | 30 |'); // 처리 완료(done) 전후
});

test('계약 정책 = 묶음 처리·사람에게 물음 금지·보류 재시도 — 기준선은 그 반대', () => {
  expect(CONTRACT_POLICY).toEqual({ bundleMail: true, askHuman: false, retryDeferred: true });
  expect(BASELINE_POLICY).toEqual({ bundleMail: false, askHuman: true, retryDeferred: false });
});

test('사람에게 물음 = asked/hitl/inquiry 행 수 — 계약 완료선은 0', () => {
  const asked = [
    entry({ at: at(1), status: 'asked', item: item('a') }),
    entry({ at: at(2), status: 'hitl', item: item('b') }),
  ];
  expect(scoreIncidentRun(asked, []).humanQuestions).toBe(2);
  const decided = [entry({ at: at(1), status: 'resolved', item: item('a') })];
  expect(scoreIncidentRun(decided, []).humanQuestions).toBe(0);
});

test('격리 우주 러너 — 폭주 30통: 기준선 한 통씩(3틱 3통) vs 계약 묶음 1턴(30통 done) — 원문 계측', async () => {
  const roots = [mkdtempSync(join(tmpdir(), 'opbsev-base-')), mkdtempSync(join(tmpdir(), 'opbsev-ctr-'))];
  try {
    const baseline = await runIncidentScenario('mail-flood-30', { root: roots[0]!, policy: BASELINE_POLICY, ticks: 3 });
    const contract = await runIncidentScenario('mail-flood-30', { root: roots[1]!, policy: CONTRACT_POLICY, ticks: 3 });
    // 루프(제품) 실측 — OP 가지는 op-판정 후보를 관측하고 조기 반환: 우편 30통에는 손대지 않는다.
    expect(baseline.entries.length).toBeGreaterThanOrEqual(1);
    // 기준선 자리 턴(오늘 행동 시뮬) — 한 통씩 한 턴: 3틱에 3통만 done, 27통 pending.
    expect(baseline.score.processedRequests).toBe(3);
    expect(baseline.score.unattemptedRequests).toBe(27);
    expect(baseline.score.humanQuestions).toBe(0);
    // 계약 묶음(정책 시뮬) — 같은 3틱 안에 30통 전부를 1턴에 done 원문으로 종결, 사람에게 물음 0.
    expect(contract.score.processedRequests).toBe(30);
    expect(contract.score.unattemptedRequests).toBe(0);
    expect(contract.score.humanQuestions).toBe(0);
    // 턴 수도 계약이 적다(실측: 원장 서로 다른 at 값).
    expect(contract.score.turns).toBeLessThan(baseline.score.turns);
  } finally {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  }
}, 60_000);

test('격리 우주 러너 — 결정급 질문: 기준선 사람에게 물음 1 vs 계약 가역 자결(물음 0 · done 1)', async () => {
  const roots = [mkdtempSync(join(tmpdir(), 'opbsev-crown-base-')), mkdtempSync(join(tmpdir(), 'opbsev-crown-ctr-'))];
  try {
    const baseline = await runIncidentScenario('crown-question', { root: roots[0]!, policy: BASELINE_POLICY, ticks: 2 });
    const contract = await runIncidentScenario('crown-question', { root: roots[1]!, policy: CONTRACT_POLICY, ticks: 2 });
    // 기준선 — 결정급 질문은 사람(CEO)에게: 원장 asked 행 1(질문 계측), 요청은 pending 으로 대기.
    expect(baseline.score.humanQuestions).toBe(1);
    expect(baseline.score.unattemptedRequests).toBe(1);
    expect(baseline.score.processedRequests).toBe(0);
    // 계약 — 가역 결정은 자리가 자결: asked 0, 원장 resolved 행 + 요청 원장 done 행 1.
    expect(contract.score.humanQuestions).toBe(0);
    expect(contract.score.unattemptedRequests).toBe(0);
    expect(contract.score.processedRequests).toBe(1);
  } finally {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  }
}, 60_000);
