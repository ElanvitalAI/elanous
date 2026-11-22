// TOKEN-BURN-BY-SEAT(0.3.33 P0 · OP #132084) — 자리·모델·시간(30분 버킷)별 토큰·비용 표.
// 완료선: #39502 llm.usage 원장 기반 표를 30분 카드(PLAN-TPS20-CADENCE-1111)에 붙인다.
// 실패 먼저(§35): summarizeUsageBySeat 는 아직 없다 — 네임스페이스 참조가 undefined 면 RED.
// 출처: #39564/#132084 · 미측정 행은 0 USD 로 꾸미지 않고 unknownRows 칸으로 남긴다(#39502 관례).
import { describe, expect, it } from 'bun:test';
import * as ledger from './llm-cost-ledger.js';
import type { LlmPricingUsd } from '../src/budget/llm-cost.js';

const PRICED_MODEL = 'fixture-priced-model';
const UNPRICED_MODEL = 'fixture-unpriced-model';

const FIXTURE_PRICING: Readonly<Record<string, LlmPricingUsd>> = {
  [PRICED_MODEL]: { inputPerM: 2, outputPerM: 12 },
};

// 원장 행 꼴 = `eln logs --json --json-data` 의 llm.usage 한 줄(ts·session_id·data).
const T0 = '2026-11-23T00:05:00.000Z'; // 00:00 버킷
const T1 = '2026-11-23T00:35:00.000Z'; // 00:30 버킷

function row(seat: string | undefined, model: string, inTok: number, outTok: number, ts: string): string {
  const data: Record<string, unknown> = { model, inputTokens: inTok, outputTokens: outTok };
  if (seat !== undefined) data.seat = seat;
  return JSON.stringify({ ts, category: 'llm.usage', data });
}

describe('summarizeUsageBySeat (TOKEN-BURN-BY-SEAT)', () => {
  it('buckets tokens and cost by seat × model × 30-minute window', () => {
    expect(typeof ledger.summarizeUsageBySeat).toBe('function');
    const lines = [
      row('MOB-1', PRICED_MODEL, 1_000_000, 1_000_000, T0), // known 2+12 = 14 USD
      row('MOB-1', PRICED_MODEL, 1_000_000, 0, T1),        // 00:30 버킷 분리 · 2 USD
      row('OP', PRICED_MODEL, 0, 1_000_000, T0),           // 12 USD
    ];
    const table = ledger.summarizeUsageBySeat!(lines, { configPricing: FIXTURE_PRICING });
    expect(table.rows).toHaveLength(3);
    const first = table.rows[0]!;
    expect(first.seat).toBe('MOB-1');
    expect(first.model).toBe(PRICED_MODEL);
    expect(first.bucketStartIso).toBe('2026-11-23T00:00:00.000Z');
    expect(first.calls).toBe(1);
    expect(first.inputTokens).toBe(1_000_000);
    expect(first.outputTokens).toBe(1_000_000);
    expect(first.usd).toBe(14);
    const second = table.rows[1]!; // 정렬 = 버킷→자리→모델: 00:00|OP 가 두 번째
    expect(second.seat).toBe('OP');
    expect(second.bucketStartIso).toBe('2026-11-23T00:00:00.000Z');
    expect(second.usd).toBe(12);
    const late = table.rows[2]!; // 00:30|MOB-1 분리 버킷
    expect(late.seat).toBe('MOB-1');
    expect(late.bucketStartIso).toBe('2026-11-23T00:30:00.000Z');
    expect(late.usd).toBe(2);
  });

  it('keeps unpriced rows as unknown counts instead of fabricating 0 USD', () => {
    const lines = [
      row('MOB-1', UNPRICED_MODEL, 5, 5, T0),
      row('MOB-1', UNPRICED_MODEL, 5, 5, T0),
    ];
    const table = ledger.summarizeUsageBySeat!(lines, { configPricing: FIXTURE_PRICING });
    const r = table.rows[0]!;
    expect(r.calls).toBe(2);
    expect(r.unknownRows).toBe(2);
    expect(r.usd).toBeUndefined(); // 0 으로 꾸미지 않는다
  });

  it('files rows without a seat under (no-seat) rather than dropping them', () => {
    const lines = [row(undefined, PRICED_MODEL, 1, 1, T0)];
    const table = ledger.summarizeUsageBySeat!(lines, { configPricing: FIXTURE_PRICING });
    expect(table.rows[0]!.seat).toBe('(no-seat)');
    expect(table.unstampedRows).toBe(1);
  });

  it('sorts by bucket then seat then model for a stable card table', () => {
    const lines = [
      row('OP', PRICED_MODEL, 1, 1, T0),
      row('MOB-1', PRICED_MODEL, 1, 1, T0),
      row('MOB-1', PRICED_MODEL, 1, 1, T1),
    ];
    const table = ledger.summarizeUsageBySeat!(lines, { configPricing: FIXTURE_PRICING });
    expect(table.rows.map((r) => `${r.bucketStartIso}|${r.seat}`)).toEqual([
      '2026-11-23T00:00:00.000Z|MOB-1',
      '2026-11-23T00:00:00.000Z|OP',
      '2026-11-23T00:30:00.000Z|MOB-1',
    ]);
  });
});

describe('formatUsageBySeatTable (30분 카드 표)', () => {
  it('renders one pasteable line per seat×model×bucket row', () => {
    expect(typeof ledger.formatUsageBySeatTable).toBe('function');
    const lines = [row('MOB-1', PRICED_MODEL, 1_000_000, 1_000_000, T0)];
    const table = ledger.summarizeUsageBySeat!(lines, { configPricing: FIXTURE_PRICING });
    const text = ledger.formatUsageBySeatTable!(table);
    expect(text).toContain('seat MOB-1');
    expect(text).toContain(`model ${PRICED_MODEL}`);
    expect(text).toContain('usd 14');
    expect(text).toContain('inTok 1000000');
    expect(text).toContain('outTok 1000000');
  });
});
