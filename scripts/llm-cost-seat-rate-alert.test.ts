// TOKEN-BURN-BY-SEAT JUD-3 HOLD 수리(OP #132677 · 0.3.33) — 같은 자리 10분 100콜↑ 경보.
// 완료선: 원장 집계에 10분 창 자리별 호출 수 · 100 초과면 30분 카드에 경보 줄 + 우편 1통(OP) · 새 깃발 0.
// 실패 먼저(§35): detectSeatRateAlerts 는 아직 없다 — 네임스페이스 참조가 undefined 면 RED.
// 출처: #132677/#39654 · 회귀 = 합성 101콜 → 경보 1 · 99콜 → 0(경계 100콜은 초과 아님).
import { describe, expect, it } from 'bun:test';
import * as ledger from './llm-cost-ledger.js';

// 원장 행 꼴 = `eln logs --json --json-data` 의 llm.usage 한 줄(ts·category·data).
function row(seat: string | undefined, ts: string): string {
  const data: Record<string, unknown> = { model: 'fixture-model', inputTokens: 1, outputTokens: 1 };
  if (seat !== undefined) data.seat = seat;
  return JSON.stringify({ ts, category: 'llm.usage', data });
}

const BASE = Date.parse('2026-11-23T01:00:00.000Z');
function ts(secondsAfterBase: number): string {
  return new Date(BASE + secondsAfterBase * 1_000).toISOString();
}

function manyCalls(seat: string | undefined, count: number, spanSeconds: number): string[] {
  // 같은 10분 창 안에 count 호출을 고르게 흩뿌린다(첫·마지막 모두 창 안).
  return Array.from({ length: count }, (_, i) => row(seat, ts(Math.floor((spanSeconds * i) / Math.max(count - 1, 1)))));
}

describe('detectSeatRateAlerts (TOKEN-BURN-BY-SEAT JUD-3 · OP #132677)', () => {
  it('synthetic 101 calls in one 10-minute window → exactly 1 alert', () => {
    expect(typeof ledger.detectSeatRateAlerts).toBe('function');
    const lines = manyCalls('MOB-1', 101, 540); // 9분에 걸쳐 101콜 — 한 10분 창 안
    const alerts = ledger.detectSeatRateAlerts!(lines);
    expect(alerts).toHaveLength(1);
    const a = alerts[0]!;
    expect(a.seat).toBe('MOB-1');
    expect(a.calls).toBe(101);
    expect(a.threshold).toBe(100);
    expect(a.windowMs).toBe(10 * 60 * 1_000);
  });

  it('synthetic 99 calls in one 10-minute window → no alert', () => {
    const lines = manyCalls('MOB-1', 99, 540);
    expect(ledger.detectSeatRateAlerts!(lines)).toHaveLength(0);
  });

  it('exactly 100 calls in a window is not «above 100» → no alert', () => {
    const lines = manyCalls('OP', 100, 540);
    expect(ledger.detectSeatRateAlerts!(lines)).toHaveLength(0);
  });

  it('100 calls split across two 10-minute windows never trips — sliding window spans the true burn', () => {
    // 01:00:00~01:09:59 에 60콜, 01:10:00~01:19:59 에 60콜: 어느 한 10분 창도 60을 넘지 않는다.
    const early = Array.from({ length: 60 }, (_, i) => row('TC', ts(i * 10)));
    const late = Array.from({ length: 60 }, (_, i) => row('TC', ts(600 + i * 10)));
    expect(ledger.detectSeatRateAlerts!([...early, ...late])).toHaveLength(0);
  });

  it('two seats over threshold in the same window → one alert per seat', () => {
    const lines = [...manyCalls('MOB-1', 101, 300), ...manyCalls('UX', 150, 300)];
    const alerts = ledger.detectSeatRateAlerts!(lines);
    expect(alerts).toHaveLength(2);
    expect(alerts.map((a) => a.seat).sort()).toEqual(['MOB-1', 'UX']);
  });

  it('unstamped rows are counted as (no-seat), not silently dropped from the burn watch', () => {
    const lines = manyCalls(undefined, 101, 540);
    const alerts = ledger.detectSeatRateAlerts!(lines);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.seat).toBe('(no-seat)');
  });

  it('rows without a parsable ts never enter a window (ledger ts 신뢰 — #39502 관례)', () => {
    const lines = [row('MOB-1', 'not-a-date'), ...manyCalls('MOB-1', 101, 540)];
    const alerts = ledger.detectSeatRateAlerts!(lines);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.calls).toBe(101); // 파싱 불능 1행은 창 집계에서 제외
  });

  it('formatSeatRateAlert renders the 30-minute-card alert line with the threshold', () => {
    expect(typeof ledger.formatSeatRateAlert).toBe('function');
    const text = ledger.formatSeatRateAlert!({ seat: 'MOB-1', windowStartIso: '2026-11-23T01:00:00.000Z', windowEndIso: '2026-11-23T01:10:00.000Z', calls: 101, threshold: 100, windowMs: 600_000 }); // 출처: #132677/#39654 — 경보 문턱 100콜 회귀값(합성 101→경보 1 · 99→0)
    expect(text).toContain('alert seat MOB-1');
    expect(text).toContain('calls 101');
    expect(text).toContain('> 100');
    expect(text).toContain('2026-11-23T01:00:00.000Z');
  });
});
