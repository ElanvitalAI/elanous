import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { handTask, LAUNCH_REFUSED_BUDGET_EVENT, taBudgetWallRefusal } from './task-hand.js';
import { parseWorkOrder, parseWorkOrderBudget, workOrderBudgetFailureReason } from './work-order.js';

/**
 * TA-BUDGET-WALL-REDACT — 예산 파싱 실패 사유의 무노출 회귀(OP #117315 · JUD HOLD #117304).
 *
 * `parseWorkOrderBudget` 의 거부 사유는 세 표면에 그대로 흐른다(`task-hand.ts` 발사 거부):
 *   ① 발사 응답 `reason`(`launch-refused-budget: <사유>`) ② 카드 history `detail` ③ debug 원장 `reason`.
 * 사유가 입력 토큰/time/usd 조각을 담으면 그 입력값이 세 표면에 새어 나가므로,
 * 사유는 «입력값 없는 안정 코드»(budget-…)만 말한다. 이 파일은 그 계약을 세 표면에서 잠근다.
 */

/** 사유 스누핑 탐침 — 시험 입력에만 쓰고 어떤 출력에도 나오면 안 된다. */
const CANARY = 'zzbudgetsecretzz';

/** 예산 거부 사유의 안정 코드 전체(이 목록 밖 사유는 계약 위반). */
const STABLE_BUDGET_REFUSALS = [
  'budget-invalid-format', 'budget-key-not-allowed', 'budget-duplicate-key',
  'budget-time-missing', 'budget-time-invalid', 'budget-time-noninteger', 'budget-time-out-of-range',
  'budget-usd-missing', 'budget-usd-invalid', 'budget-usd-not-positive',
] as const;

/** 형식이 깨진 예산 → 기대 사유 코드(예산 문자열이 CANARY 를 실은다). */
const MALFORMED_BUDGETS: Array<[string, string]> = [
  ['time=60s usd=1 zzbudgetsecretzz', 'budget-invalid-format'],
  ['zzbudgetsecretzz=1 time=60s usd=1', 'budget-key-not-allowed'],
  ['time=zzbudgetsecretzz time=60s usd=1', 'budget-duplicate-key'],
  ['usd=1', 'budget-time-missing'],
  ['time=zzbudgetsecretzz usd=1', 'budget-time-invalid'],
  ['time=0.5s usd=1', 'budget-time-noninteger'],
  ['time=7200s usd=1', 'budget-time-out-of-range'],
  ['time=60s', 'budget-usd-missing'],
  ['time=60s usd=zzbudgetsecretzz', 'budget-usd-invalid'],
  ['time=60s usd=0', 'budget-usd-not-positive'],
];

/** 모든 칸이 찬 정상 지시서(예산만 사례별로 바꾼다). */
const FULL_ORDER = {
  lifeId: 'life-redact', cellId: 'TA-BUDGET-REDACT', version: '0.2.33', landBy: '2026-11-21T00:00:00+09:00',
  identityTags: 'class=test · care=normal · rights=rw · origin=op · rework=0',
  priority: '신호 order 1 · 승수 S · 판정자 대표',
  verdictSignal: '관측: focused 테스트 통과 · 기대: bun test src/task-agent/work-order-budget.test.ts 0 fail',
  contract: 'bun test src/task-agent/work-order-budget.test.ts → 0 fail',
  boundary: 'src/task-agent/work-order.ts · 시험 src/task-agent/work-order-budget.test.ts',
  budget: 'time=60s usd=1',
  peers: '선행 없음', precedents: 'must-fix 서명 0',
  escalation: '판정선 밖이면 조율자(OP)에게',
};

test('TA-BUDGET-WALL-REDACT ①: parseWorkOrderBudget 사유는 안정 코드만 — 입력 토큰/time/usd 조각 무노출', () => {
  // 정상 예산은 그대로 통과한다(거부 계약은 실패 사유에만 있다).
  expect(parseWorkOrderBudget('time=60s usd=1')).toMatchObject({ ok: true, timeSec: 60 });
  for (const [budget, expected] of MALFORMED_BUDGETS) {
    const parsed = parseWorkOrderBudget(budget);
    expect([budget, parsed.ok]).toEqual([budget, false]);
    if (!parsed.ok) {
      expect([budget, parsed.reason]).toEqual([budget, expected]);
      expect([budget, parsed.reason.includes(CANARY)]).toEqual([budget, false]);
    }
  }
  // 거부 사유는 이 목록 밖을 말하지 않는다(안정 코드 계약).
  expect(STABLE_BUDGET_REFUSALS).toEqual(expect.arrayContaining(MALFORMED_BUDGETS.map(([, code]) => code)));
});

test('TA-BUDGET-WALL-REDACT ②: taBudgetWallRefusal 같은 안정 코드만 흘린다 — 빈 값·«모름»은 벽 없음', () => {
  const parsed = parseWorkOrder(JSON.stringify(FULL_ORDER));
  if (!parsed.ok) throw new Error(parsed.reason);
  expect(workOrderBudgetFailureReason('모름')).toBe(undefined);
  expect(workOrderBudgetFailureReason('')).toBe(undefined);
  expect(taBudgetWallRefusal(undefined)).toBe(undefined);
  expect(taBudgetWallRefusal({ ...parsed.order, budget: 'time=1800s usd=1' })).toBe(undefined);
  for (const [budget, expected] of MALFORMED_BUDGETS) {
    const refusal = taBudgetWallRefusal({ ...parsed.order, budget });
    expect([budget, refusal]).toEqual([budget, expected]);
  }
});

test('TA-BUDGET-WALL-REDACT ③: 예산 거부가 세 표면(응답·카드 history·debug 원장)에 입력 조각을 실리지 않는다', async () => {
  const parsed = parseWorkOrder(JSON.stringify(FULL_ORDER));
  if (!parsed.ok) throw new Error(parsed.reason);
  const root = mkdtempSync(join(tmpdir(), 'ta-budget-redact-'));
  try {
    const statePath = join(root, 'tasks.json');
    const launcher = (): never => { throw new Error('TA-BUDGET-WALL-REDACT: 발사가 허용되어선 안 된다'); };
    const r = await handTask({
      id: 'ta-budget-redact', text: '예산 무노출 회귀', seat: 'TC', checklistId: 'CL-1', checklistVersion: '1', noAutoMerge: true,
      workOrder: { ...parsed.order, budget: `time=${CANARY} usd=1` },
      statePath, prelaunchInspector: () => ({ reason: 'test' }), launcher,
    });
    expect(r.launched).toBe(false);
    // ① 발사 응답 — «launch-refused-budget: <안정 코드>» 만 말한다.
    const reason = r.reason ?? '';
    expect(reason.startsWith('launch-refused-budget: ')).toBe(true);
    expect(reason.includes(CANARY)).toBe(false);
    expect((STABLE_BUDGET_REFUSALS as readonly string[]).includes(reason.slice('launch-refused-budget: '.length))).toBe(true);
    // ② 카드 history — detail 이 같은 안정 코드만 담는다.
    const event = r.card.history.find((h) => h.event === LAUNCH_REFUSED_BUDGET_EVENT);
    expect(event).toBeDefined();
    const detail = String(event?.detail ?? '');
    expect(detail.includes(CANARY)).toBe(false);
    expect((STABLE_BUDGET_REFUSALS as readonly string[]).includes(detail)).toBe(true);
    // ③ debug 원장 — task-agent launch-refused-budget 줄에 입력 조각이 없다.
    const row = debug.events(500).find((e) => e.category === 'task-agent' && e.event === 'launch-refused-budget'
      && (e.data as { taskId?: string } | undefined)?.taskId === 'ta-budget-redact');
    expect(row).toBeDefined();
    expect(JSON.stringify(row ?? null).includes(CANARY)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});