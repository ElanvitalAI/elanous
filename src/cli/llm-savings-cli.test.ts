// `eln llm savings` CLI 시험 — SMART-ROUTER-DEMO-SAVINGS (OP #116366).
// 계약: 주입 행/주입 단가로 ① md 영수(고급 수/전체·절감·가격 비공개) ② JSON 수치 ③ 원장 행 →
//   요약 행 변환(workTier 어휘·estimated 어림 제외·창·runId 필터) ④ 강 모델 누락 오류.

import { describe, expect, test } from 'bun:test';
import { runLlmSavings, savingsCallsFromLedger, summarizeDailySavings, type SavingsLedgerRow } from './llm-savings-cli.js';
import type { SavingsCallRow, SavingsPriceOf } from '../model-tier/router-savings.js';

const PREMIUM_MODEL = 'strong-model';

const priceOf: SavingsPriceOf = (model, tokens) => {
  const perM = model === PREMIUM_MODEL ? { input: 10, output: 30 } : { input: 1, output: 3 };
  return (tokens.inputTokens * perM.input + tokens.outputTokens * perM.output) / 1_000_000;
};

const calls: SavingsCallRow[] = [
  { at: 1, role: 'planning', phase: 'turn', model: PREMIUM_MODEL, billing: 'subscription', tier: 'strong', inputTokens: 1_000, outputTokens: 2_000, apiEquivalentUsd: 0.07 },
  { at: 2, role: 'implement', model: 'cheap-model', billing: 'credit', tier: 'mid', inputTokens: 1_000, outputTokens: 2_000, costUsd: 0.004 },
  { at: 3, role: 'classify', model: 'mini-model', billing: 'credit', tier: 'weak', inputTokens: 500, outputTokens: 500, costUsd: 0.001 },
  { at: 4, role: 'review', model: 'cheap-model', billing: 'subscription', tier: 'mid', inputTokens: 800, outputTokens: 900, apiEquivalentUsd: 0.0107 },
];

function capture(): { lines: string[]; out: (l: string) => void } {
  const lines: string[] = [];
  return { lines, out: (l: string) => lines.push(l) };
}

describe('runLlmSavings', () => {
  test('md 영수 — 고급 1/4 · 절감 · 가격 비공개', async () => {
    const { lines, out } = capture();
    const r = await runLlmSavings({ premiumModel: PREMIUM_MODEL }, { rows: calls, priceOf, out });
    expect(r.error).toBeUndefined();
    const md = lines.join('\n');
    expect(md).toContain('1/4');
    expect(md).toContain('절감');
    expect(md).toMatch(/planning|implement/);
    expect(md).not.toMatch(/usd|USD|\$/);
  });

  test('json 모드 — 수치만(가격 문자열 없음)', async () => {
    const { out } = capture();
    const r = await runLlmSavings({ premiumModel: PREMIUM_MODEL, json: true }, { rows: calls, priceOf, out });
    expect(r.json).toMatchObject({ totalCalls: 4, premiumCalls: 1, unpricedCalls: 0 });
    expect(r.json!.savingsPct).toBeCloseTo(1 - 0.0857 / 0.195, 5);
    expect(JSON.stringify(r.json)).not.toMatch(/usd/i);
    expect(JSON.stringify(r.json)).not.toMatch(/\$/);
  });

  test('json 모드 — 한 줄 JSON 영수를 출력한다(액션이 반환값을 버려도 영수가 찍힌다)', async () => {
    const { lines, out } = capture();
    const r = await runLlmSavings({ premiumModel: PREMIUM_MODEL, json: true }, { rows: calls, priceOf, out });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!) as { totalCalls: number }).toMatchObject({ totalCalls: 4 });
    expect(lines[0]).not.toMatch(/usd|USD|\$/);
    expect(r.json).toBeDefined();
  });

  test('강 모델 누락 — 오류 안내', async () => {
    const { out } = capture();
    const r = await runLlmSavings({}, { rows: calls, priceOf, out });
    expect(r.error).toMatch(/premium-model/);
  });
});

describe('savingsCallsFromLedger', () => {
  const NOW = Date.parse('2026-11-21T08:00:00Z');
  const event = (over: Record<string, unknown>): string => JSON.stringify({
    runId: 'run-1', site: 'agent-mission', role: 'planning', phase: 'turn', jobKind: 'mission',
    model: PREMIUM_MODEL, billingProvider: 'openai-codex', billing: 'subscription',
    inputTokens: 1_000, outputTokens: 2_000, cost: { kind: 'subscription', apiEquivalentUsd: 0.07 },
    workTier: 'strong', workTierTrigger: 'base', at: new Date(NOW).toISOString(),
    ...over,
  });
  const row = (id: number, at: number, data: string): SavingsLedgerRow => ({ id, ts: new Date(at).toISOString(), category: 'llm.usage', event: 'llm-usage', data });

  test('원장 행 → 요약 행(workTier·cost 칸 매핑) · estimated·창 밖 제외', () => {
    const rows: SavingsLedgerRow[] = [
      row(1, NOW, event({})),
      row(2, NOW, event({ role: 'implement', model: 'cheap-model', billing: 'credit', workTier: 'mid', cost: { kind: 'credit', usd: 0.004 } })),
      row(3, NOW, event({ role: 'classify', model: 'mini-model', workTier: 'weak', estimated: true })),
      row(4, NOW - 120_000, event({ role: 'research', model: 'cheap-model', workTier: 'mid' })),
      row(5, NOW, event({ role: 'review', model: 'cheap-model', workTier: 'mid', billing: 'credit', cost: {} })),
    ];
    const out = savingsCallsFromLedger(rows, { now: NOW, sinceMs: 60_000 });
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ role: 'planning', phase: 'turn', model: PREMIUM_MODEL, tier: 'strong', apiEquivalentUsd: 0.07 });
    expect(out[1]).toMatchObject({ role: 'implement', model: 'cheap-model', tier: 'mid', costUsd: 0.004 });
    expect(out[2]).toMatchObject({ role: 'review', tier: 'mid' });
    expect(out[2]!.costUsd).toBeNull();
    expect(out[2]!.apiEquivalentUsd).toBeNull();
  });

  test('runId 필터', () => {
    const rows: SavingsLedgerRow[] = [row(1, NOW, event({ runId: 'run-2' }))];
    expect(savingsCallsFromLedger(rows, { now: NOW, sinceMs: 60_000, runId: 'run-1' })).toHaveLength(0);
  });

  test('실제 원장 행(ts ISO 문자열) — 창 필터 실작동 · 해석 불가 ts 제외 · at=epoch 매핑', () => {
    const rows: SavingsLedgerRow[] = [
      row(1, NOW, event({})),
      row(2, NOW - 120_000, event({ role: 'research', model: 'cheap-model', workTier: 'mid' })),
      { id: 3, ts: 'not-a-date', category: 'llm.usage', event: 'llm-usage', data: event({}) } as SavingsLedgerRow,
    ];
    const out = savingsCallsFromLedger(rows, { now: NOW, sinceMs: 60_000 });
    expect(out).toHaveLength(1);
    expect(out[0]!.at).toBe(NOW);
  });

  test('다른 category/event 행은 못 읽는다(실측 원장 계약)', () => {
    const rows: SavingsLedgerRow[] = [row(1, NOW, event({})), { id: 2, ts: new Date(NOW).toISOString(), category: 'llm.gate', event: 'decision', data: event({}) } as SavingsLedgerRow];
    expect(savingsCallsFromLedger(rows, { now: NOW, sinceMs: 60_000 })).toHaveLength(1);
  });
});

// 출처: #39641 — 일 버킷 2일·day1 호출 2/고급 1(비중 0.5)/절감 0.075·day2 절감 0.9 — 고정 원장 행 리터럴(#39641 시나리오 ledgerCalls와 같은 산수).
describe('summarizeDailySavings — 원장 일일 재계산(jud-39614 필수 3)', () => {
  const DAY1 = Date.parse('2026-11-20T10:00:00Z');
  const DAY2 = Date.parse('2026-11-21T09:30:00Z');
  const call = (at: number, over: Record<string, unknown>): SavingsCallRow => ({
    at, role: 'planning', phase: 'turn', model: 'cheap-model', provider: 'prov', billing: 'credit',
    tier: 'mid', inputTokens: 1_000, outputTokens: 2_000, costUsd: 0.004, apiEquivalentUsd: null,
    ...over,
  } as SavingsCallRow);
  const priceOf: SavingsPriceOf = () => 0.04; // 강 단독 기준 단가(비공개 주입)

  test('UTC 날짜별 재계산 — 일별 totalCalls/premiumCalls/premiumShare/savingsPct(창 합계 아님)', () => {
    const calls: SavingsCallRow[] = [
      call(DAY1, {}),                                             // 11-20: 경량 1
      call(DAY1, { model: PREMIUM_MODEL, tier: 'strong', costUsd: null, apiEquivalentUsd: 0.07 }), // 11-20: 고급 1
      call(DAY2, {}),                                             // 11-21: 경량 1
      call(DAY2 - 3_600_000, {}),                                 // 11-21(1시간 전): 경량 1
    ];
    const daily = summarizeDailySavings(calls, { premiumModel: PREMIUM_MODEL, priceOf });
    expect(daily).toHaveLength(2);
    expect(daily[0]!.day).toBe('2026-11-20');
    expect(daily[0]!.totalCalls).toBe(2);
    expect(daily[0]!.premiumCalls).toBe(1);
    expect(daily[0]!.premiumShare).toBe(0.5);
    // 11-20: actual = 0.004 + 0.07, counterfactual = 0.04 × 2 → savings = 1 − 0.074/0.08 = 0.075
    expect((daily[0]!.savingsPct as number).toFixed(3)).toBe('0.075');
    expect(daily[1]!.day).toBe('2026-11-21');
    expect(daily[1]!.totalCalls).toBe(2);
    expect(daily[1]!.premiumCalls).toBe(0);
    expect(daily[1]!.premiumShare).toBe(0);
    // 11-21: actual = 0.008, counterfactual = 0.08 → savings = 0.9
    expect((daily[1]!.savingsPct as number).toFixed(3)).toBe('0.900');
  });

  test('매긴 호출이 없는 날 — savingsPct=null(과장 0 금지) · 빈 입력은 빈 표', () => {
    const empty: SavingsCallRow[] = [{ ...call(DAY1, { costUsd: null, apiEquivalentUsd: null }) } as SavingsCallRow];
    const daily = summarizeDailySavings(empty, { premiumModel: PREMIUM_MODEL, priceOf: () => null });
    expect(daily).toHaveLength(1);
    expect(daily[0]!.savingsPct).toBeNull();
    expect(daily[0]!.unpricedCalls).toBe(1);
    expect(summarizeDailySavings([], { premiumModel: PREMIUM_MODEL, priceOf })).toEqual([]);
  });

  test('runLlmSavings daily 모드 — json 영수에 일별 배열이 실린다', async () => {
    const { lines, out } = capture(); // 계약: deps.out = (line) => void — 배열이 아니라 capture 헬퍼
    const calls: SavingsCallRow[] = [
      call(DAY1, {}),
      call(DAY2, { model: PREMIUM_MODEL, tier: 'strong', costUsd: null, apiEquivalentUsd: 0.07 }),
    ];
    const r = await runLlmSavings({ premiumModel: PREMIUM_MODEL, json: true, daily: true }, { rows: calls, priceOf, out });
    expect(r.json).toBeDefined();
    expect(r.json!.daily).toHaveLength(2);
    // daily 슬롯은 readonly SavingsDayRow[] — 캐스트 없이 행 필드를 직접 읽는다(TS2352 수리).
    expect(r.json!.daily![0]!.day).toBe('2026-11-20');
    // 한 줄 JSON 영수에도 일별 표가 실린다(데모 계약 — 액션이 반환값을 버려도 증거가 남는다).
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('2026-11-20');
    expect(JSON.parse(lines[0]!) as { daily?: unknown[] }).toMatchObject({ daily: [{ day: '2026-11-20' }, { day: '2026-11-21' }] });
  });
});
