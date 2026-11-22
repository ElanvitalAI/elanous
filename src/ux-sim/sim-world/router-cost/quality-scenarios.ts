import { decideGuardedRoute, type GuardedRouteDecision } from '../../../llm/route-quality-guard.js';
import { summarizeDailySavings } from '../../../cli/llm-savings-cli.js';
import type { SavingsCallRow, SavingsPriceOf } from '../../../model-tier/router-savings.js';
import type { SimWorldDeviceDef, SimWorldScenario } from '../types.js';

// ── ROUTER-QUALITY-GUARD-95 시뮬 장치 ────────────────────────────────────────
// 가짜 품질 평가기: 모델별 점수 큐를 소비하는 결정론적 evaluate. 실제 LLM은 호출하지 않는다.

export interface FakeEvaluator {
  queue: number[];
  calls: string[];
  evaluate(model: string): number;
}

function createFakeEvaluator(): FakeEvaluator {
  const self: FakeEvaluator = {
    queue: [],
    calls: [],
    evaluate(model: string): number {
      self.calls.push(model);
      const score = self.queue.shift();
      if (score === undefined) throw new Error('fake evaluator queue exhausted');
      return score;
    },
  };
  return self;
}

export const simWorldDevices: readonly SimWorldDeviceDef<{ evaluator: FakeEvaluator }>[] = [{
  id: 'ROUTER-QUALITY-FAKE-EVALUATOR',
  title: 'deterministic per-call quality score evaluator (no real LLM)',
  create: () => ({ evaluator: createFakeEvaluator() }),
}];

const failure = (message: string) => ({ ok: false as const, reason: 'router quality guard violation', diff: message });

// ── ROUTER-QUALITY-GUARD-95 시나리오 ────────────────────────────────────────
// 묶음 과제 3개(chat 1 + codegen 2). 가벼운 선출 → 유형별 임계 게이트 → shadow 대차 1회/과제 →
// 미달 시 고급 상향. 기대: ① 첫 시도는 전부 가벼운 모델 ② t2(codegen 0.95)은 가벼운 유지
// ③ t1(chat 0.93 < 0.95)·t3(0.60 미달)은 고급 상향(그림자 점수를 그대로 인도 점수로 재사용)
// ④ 인도 품질 ≥ 유형별 적용 임계(전유형 바닥 ≥0.95 강제 — OP #132280 필수 1)
// ⑤ 프리미엄 평가 비중 3/6 ⑥ 원장 일일 재계산 표(UTC 일 버킷 2일)가 근거 이벤트로 남는다(jud-39614 ①②③).

export const simWorldScenarios: readonly SimWorldScenario[] = [{
  id: 'ROUTER-QUALITY-GUARD-95',
  title: 'lightweight-first guarded routing holds per-type floors with one premium shadow per task and lands the daily recalc surface',
  devices: ['ROUTER-QUALITY-FAKE-EVALUATOR'],
  async run(ctx) {
    const { evaluator } = ctx.device<{ evaluator: FakeEvaluator }>('ROUTER-QUALITY-FAKE-EVALUATOR');
    // 큐 = 과제별 (가벼운 점수, shadow 프리미엄 점수). t1(chat 0.93 < 0.95)·t3(codegen 0.60)이 게이트 실패를 만든다.
    evaluator.queue = [0.93, 0.99, 0.97, 0.99, 0.60, 0.99];
    const floors = { chat: 0.95 } as const;
    const tasks = [
      { task: 'bundle-t1-chat', taskType: 'chat' },
      { task: 'bundle-t2-codegen', taskType: 'codegen' },
      { task: 'bundle-t3-codegen', taskType: 'codegen' },
    ] as const;
    const decisions: ({ task: string } & GuardedRouteDecision)[] = [];
    for (const t of tasks) {
      const decision = await decideGuardedRoute({
        lightweight: 'light-mini',
        premium: 'premium-max',
        evaluate: (model) => evaluator.evaluate(model),
        taskType: t.taskType,
        floors,
      });
      decisions.push({ task: t.task, ...decision });
      ctx.recorder.event('router-95:decided', {
        task: t.task,
        model: decision.model,
        escalated: decision.escalated,
        qualityScore: decision.qualityScore,
        firstAttemptScore: decision.firstAttemptScore,
        shadowScore: decision.shadowScore,
        shadowDelta: decision.shadowDelta,
        taskType: decision.taskType,
        appliedFloor: decision.appliedFloor,
      });
    }
    // ① lightweight-first: 매 과제의 첫 호출은 가벼운 모델(호출 순서 [가벼운, 그림자 프리미엄]×3 → calls 0·2·4).
    const firstProbeOfTask = [evaluator.calls[0], evaluator.calls[2], evaluator.calls[4]];
    if (!firstProbeOfTask.every(c => c === 'light-mini'))
      return failure(`first probe was not lightweight: ${JSON.stringify(evaluator.calls)}`);
    // ① shadow 대차: 프리미엄 평가는 과제당 정확히 1회(총 3회 — 실패 분은 그림자 점수 재사용).
    const premiumCalls = evaluator.calls.filter(c => c === 'premium-max').length;
    if (premiumCalls !== 3) return failure(`premium evaluated ${premiumCalls} times, expected exactly 3 (one shadow per task)`);
    if (evaluator.calls.length !== 6) return failure(`evaluate called ${evaluator.calls.length} times, expected 6 (light + shadow) × 3 tasks`);
    // ② 유지/상향: t2 가벼운 유지 · t1(0.93 < 0.95)·t3 실패는 고급 상향.
    if (decisions[0]!.model !== 'premium-max' || !decisions[0]!.escalated) return failure('t1 (0.93 < floor 0.95) did not escalate to premium');
    if (decisions[1]!.model !== 'light-mini' || decisions[1]!.escalated) return failure('t2 did not stay lightweight');
    if (decisions[2]!.model !== 'premium-max' || !decisions[2]!.escalated) return failure('t3 did not escalate to premium');
    // ② 유형별 임계 근거: appliedFloor = floors[taskType] ?? 기본 0.95(전유형 ≥0.95 강제 — OP #132280).
    if (decisions[0]!.appliedFloor !== 0.95) return failure(`t1 appliedFloor ${decisions[0]!.appliedFloor}, expected chat floor 0.95`);
    if (decisions[1]!.appliedFloor !== 0.95 || decisions[2]!.appliedFloor !== 0.95)
      return failure('codegen tasks must apply the default 0.95 floor');
    // ④ 인도 품질: 모든 과제의 최종 품질 ≥ 적용 임계.
    if (!decisions.every(d => d.qualityScore >= d.appliedFloor))
      return failure(`delivered quality below applied floor: ${JSON.stringify(decisions.map(d => d.qualityScore))}`);
    ctx.recorder.event('router-95:bundle-receipt', {
      tasks: tasks.length,
      lightweightKept: decisions.filter(d => !d.escalated).length,
      escalated: decisions.filter(d => d.escalated).length,
      premiumShare: premiumCalls / evaluator.calls.length,
      minDeliveredQuality: Math.min(...decisions.map(d => d.qualityScore)),
    });
    // ③ 원장 일일 재계산: 고정 원장 행(2일)을 UTC 일 버킷으로 재계산해 근거를 남긴다(가격 비공개 — 비율만).
    const D1 = Date.parse('2026-11-20T10:00:00Z');
    const D2 = Date.parse('2026-11-21T09:30:00Z');
    const strongSoloPrice: SavingsPriceOf = () => 0.04; // 시뮬 주입 단가(«강 단독» 기준) — 영수엔 비율만.
    const ledgerCalls: SavingsCallRow[] = [
      { at: D1, model: 'light-mini', tier: 'mid', inputTokens: 1_000, outputTokens: 2_000, costUsd: 0.004, apiEquivalentUsd: null },
      { at: D1, model: 'premium-max', tier: 'strong', inputTokens: 1_000, outputTokens: 2_000, costUsd: null, apiEquivalentUsd: 0.07 },
      { at: D2, model: 'light-mini', tier: 'mid', inputTokens: 1_000, outputTokens: 2_000, costUsd: 0.004, apiEquivalentUsd: null },
      { at: D2 - 3_600_000, model: 'light-mini', tier: 'mid', inputTokens: 1_000, outputTokens: 2_000, costUsd: 0.004, apiEquivalentUsd: null },
    ];
    const daily = summarizeDailySavings(ledgerCalls, { premiumModel: 'premium-max', priceOf: strongSoloPrice });
    if (daily.length !== 2) return failure(`daily recalc produced ${daily.length} day buckets, expected 2`);
    if (daily[0]!.day !== '2026-11-20' || daily[1]!.day !== '2026-11-21')
      return failure(`daily recalc day order wrong: ${JSON.stringify(daily.map(d => d.day))}`);
    ctx.recorder.event('router-95:daily-recalc', { days: daily.length, rows: daily });
    return { ok: true };
  },
}];