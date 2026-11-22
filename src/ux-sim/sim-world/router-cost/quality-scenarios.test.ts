import { describe, expect, test } from 'bun:test';
import { simWorldDevices, simWorldScenarios, type FakeEvaluator } from './quality-scenarios.js';
import type { SimWorldScenarioContext } from '../types.js';

type RecordedEvent = { kind: string; data: Record<string, unknown> };

function makeCtx(): { ctx: SimWorldScenarioContext; events: RecordedEvent[] } {
  const events: RecordedEvent[] = [];
  const devices = new Map<string, unknown>();
  for (const def of simWorldDevices) devices.set(def.id, (def.create as () => unknown)());
  const ctx = {
    recorder: { event: (kind: string, data: unknown) => { events.push({ kind, data: data as Record<string, unknown> }); } },
    device: <T>(id: string) => devices.get(id) as T,
    random: () => 0.5,
    universeRoot: '/tmp/router95-universe',
  } as unknown as SimWorldScenarioContext;
  return { ctx, events };
}

function decidedEvents(events: RecordedEvent[]): RecordedEvent[] {
  return events.filter(e => e.kind === 'router-95:decided');
}

// 출처: #39641 — 과제 3·호출 6·프리미엄 3(비중 0.5)·전유형 임계 0.95·최저 인도 0.99·일 버킷 2(절감 0.075/0.9) 리터럴(jud-39614 e00bc107ef1f · OP #132280 필수 1).
describe('sim-world router-cost quality-scenarios (ROUTER-QUALITY-GUARD-95)', () => {
  test('scenario list exposes the 95% guard scenario', () => {
    expect(simWorldScenarios.map(s => s.id)).toContain('ROUTER-QUALITY-GUARD-95');
  });

  test('① shadow 대조 — 같은 과제·같은 rubric으로 두 모델 점수가 결정에 남는다(프리미엄 평가는 과제당 정확히 1회)', async () => {
    const scenario = simWorldScenarios.find(s => s.id === 'ROUTER-QUALITY-GUARD-95')!;
    const { ctx, events } = makeCtx();
    const evaluator = ctx.device<{ evaluator: FakeEvaluator }>('ROUTER-QUALITY-FAKE-EVALUATOR').evaluator;
    const result = await scenario.run(ctx);
    expect(result.ok).toBe(true);
    const decided = decidedEvents(events);
    expect(decided.length).toBe(3);
    for (const e of decided) {
      // shadowScore = 같은 rubric으로 프리미엄을 평가한 점수(과제마다 존재)
      expect(typeof e.data.shadowScore).toBe('number');
      expect(typeof e.data.firstAttemptScore).toBe('number');
      expect(typeof e.data.qualityScore).toBe('number');
    }
    // 과제당 (light 1회, premium shadow 1회) — 프리미엄 평가는 과제당 정확히 1회
    expect(evaluator.calls.filter(c => c === 'light-mini').length).toBe(3);
    expect(evaluator.calls.filter(c => c === 'premium-max').length).toBe(3);
  });

  test('② task-type별 임계 — chat 0.93은 전유형 바닥 0.95에 미달 → 상향(OP #132280 · 0.95 미만 바닥은 입력 거부)', async () => {
    const scenario = simWorldScenarios.find(s => s.id === 'ROUTER-QUALITY-GUARD-95')!;
    const { ctx, events } = makeCtx();
    const result = await scenario.run(ctx);
    expect(result.ok).toBe(true);
    const decided = decidedEvents(events);
    // t1(chat): appliedFloor 0.95 → 0.93 미달 → 상향(그림자 점수 0.99 인도)
    const t1 = decided.find(e => e.data.task === 'bundle-t1-chat')!;
    expect(t1.data.taskType).toBe('chat');
    expect(t1.data.appliedFloor).toBe(0.95);
    expect(t1.data.model).toBe('premium-max');
    expect(t1.data.escalated).toBe(true);
    expect(t1.data.qualityScore).toBe(0.99);
    expect(t1.data.shadowScore).toBe(0.99);
    // t2·t3(codegen): appliedFloor 0.95 — t2 0.97 유지 · t3 0.60 미달 → 상향
    const t2 = decided.find(e => e.data.task === 'bundle-t2-codegen')!;
    expect(t2.data.taskType).toBe('codegen');
    expect(t2.data.appliedFloor).toBe(0.95);
    expect(t2.data.model).toBe('light-mini');
    const t3 = decided.find(e => e.data.task === 'bundle-t3-codegen')!;
    expect(t3.data.appliedFloor).toBe(0.95);
    expect(t3.data.model).toBe('premium-max');
    expect(t3.data.escalated).toBe(true);
    expect(t3.data.qualityScore).toBe(0.99);
    expect(t3.data.shadowScore).toBe(0.99);
    // 인도 품질은 적용 임계 이상
    for (const e of decided) {
      expect((e.data.qualityScore as number) >= (e.data.appliedFloor as number)).toBe(true);
    }
  });

  test('③ 원장 일일 재계산 표면 — bundle-receipt 이벤트에 과제 수·유지·상향·최저 인도 품질이 남는다', async () => {
    const scenario = simWorldScenarios.find(s => s.id === 'ROUTER-QUALITY-GUARD-95')!;
    const { ctx, events } = makeCtx();
    const result = await scenario.run(ctx);
    expect(result.ok).toBe(true);
    const receipt = events.find(e => e.kind === 'router-95:bundle-receipt');
    expect(receipt).toBeDefined();
    expect(receipt!.data.tasks).toBe(3);
    expect(receipt!.data.lightweightKept).toBe(1);
    expect(receipt!.data.escalated).toBe(2);
    expect(receipt!.data.premiumShare).toBe(0.5); // 프리미엄 평가 3 / 전체 평가 6
    expect(receipt!.data.minDeliveredQuality).toBe(0.97); // min(0.99, 0.97[가벼운 유지 t2], 0.99)
  });

  test('④ 일일 재계산 근거 — router-95:daily-recalc 이벤트에 UTC 일자별 프리미엄 비중·절감이 남는다', async () => {
    const scenario = simWorldScenarios.find(s => s.id === 'ROUTER-QUALITY-GUARD-95')!;
    const { ctx, events } = makeCtx();
    const result = await scenario.run(ctx);
    expect(result.ok).toBe(true);
    const recalc = events.find(e => e.kind === 'router-95:daily-recalc');
    expect(recalc).toBeDefined();
    expect(recalc!.data.days).toBe(2);
    const rows = recalc!.data.rows as Array<{ day: string; totalCalls: number; premiumCalls: number; premiumShare: number; savingsPct: number | null }>; // 출처: #39641 — 일일 재계산 이벤트 행 필드명(day)
    expect(rows.map(r => r.day)).toEqual(['2026-11-20', '2026-11-21']);
    expect(rows[0]!.totalCalls).toBe(2);
    expect(rows[0]!.premiumCalls).toBe(1);
    expect(rows[0]!.premiumShare).toBe(0.5);
    expect(rows[0]!.savingsPct).toBeCloseTo(0.075, 3);
    expect(rows[1]!.premiumShare).toBe(0);
    expect(rows[1]!.savingsPct).toBeCloseTo(0.9, 3);
  });
});