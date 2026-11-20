import { describe, expect, test } from 'bun:test';
import type { SimClock } from './contract.js';
import { createAcpDevice, createOpenRouterDevice } from './credit-acp.js';

/** 시험용 최소 stub 시계(진짜 구현은 subscriptions.ts 몫). */
function stubClock(iso = '2026-11-20T00:00:00+09:00'): SimClock {
  let t = new Date(iso).getTime();
  return { now: () => new Date(t), advance: (ms) => { t += ms; }, set: (s) => { t = new Date(s).getTime(); } };
}
const SECRET_SHAPE = /sk-|ghp_|ems_|emt_|eyJ|[A-Za-z0-9]{32,}/;

describe('openrouter credit device', () => {
  test('balance 5 + call 6 -> 402 insufficient_credits, no secret shapes', () => {
    const d = createOpenRouterDevice(stubClock(), { balanceUsd: 5 });
    const r = d.call({ estimateUsd: 6 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(402);
    expect(r.code).toBe('insufficient_credits');
    expect(r.message).toBe('OpenRouter credits insufficient: balance $5.00 is below call cost $6.00');
    expect(SECRET_SHAPE.test(r.message)).toBe(false);
    expect(d.events().map((e) => [e.kind, e.usd])).toEqual([['insufficient', 6]]);
    expect(d.observe()?.balance).toMatchObject({ status: 'measured', usd: 5 });
  });

  test('autoTopUp on (20) balance 5 + call 6 -> ok, topup event 20, balance 19', () => {
    const d = createOpenRouterDevice(stubClock(), { balanceUsd: 5 });
    d.setAutoTopUp({ enabled: true, amountUsd: 20 });
    const r = d.call({ estimateUsd: 6 });
    expect(r).toEqual({ ok: true, device: 'openrouter', costUsd: 6 });
    expect(d.events().map((e) => [e.kind, e.usd])).toEqual([['topup', 20], ['charge', 6]]);
    const s = d.observe()!;
    expect(s.balance).toMatchObject({ usd: 19, totalCreditsUsd: 25, totalUsageUsd: 6 });
    expect(s.autoTopUp).toMatchObject({ status: 'measured', enabled: true, amountUsd: 20 });
  });

  test('autoTopUp amount too small still ends in 402 with topup then insufficient events', () => {
    const d = createOpenRouterDevice(stubClock(), { balanceUsd: 1 });
    d.setAutoTopUp({ enabled: true, amountUsd: 2 });
    const r = d.call({ estimateUsd: 6 });
    expect(r.ok).toBe(false);
    expect(d.events().map((e) => [e.kind, e.usd])).toEqual([['topup', 2], ['insufficient', 6]]);
  });

  test('daily spend accumulates to 300 and monthly follows; byRole recorded', () => {
    const clock = stubClock();
    const d = createOpenRouterDevice(clock, { balanceUsd: 1000 });
    d.setSpendCap({ dailyUsd: 300, monthlyUsd: 900 });
    for (let i = 0; i < 3; i++) d.call({ role: 'review', estimateUsd: 50 });
    d.call({ role: 'authoring', estimateUsd: 150 });
    const s = d.observe()!;
    expect(s.spend?.todayUsd).toBe(300);
    expect(s.spend?.monthUsd).toBe(300);
    expect(s.spend?.byRole).toEqual({ review: { todayUsd: 150, monthUsd: 150 }, authoring: { todayUsd: 150, monthUsd: 150 } });
    expect(d.spendCap()).toEqual({ dailyUsd: 300, monthlyUsd: 900 });
    expect(s.balance).toMatchObject({ usd: 700 });
    expect(s.spend?.observedAt).toBe('2026-11-19T15:00:00.000Z');
  });

  test('clock rollover resets today at next UTC day and month at next month', () => {
    const clock = stubClock('2026-11-20T00:00:00Z');
    const d = createOpenRouterDevice(clock, { balanceUsd: 100 });
    d.call({ role: 'review', estimateUsd: 10 });
    clock.advance(24 * 3600 * 1000);
    expect(d.observe()?.spend).toMatchObject({ todayUsd: 0, monthUsd: 10 });
    clock.set('2026-12-01T00:00:00Z');
    expect(d.observe()?.spend).toMatchObject({ todayUsd: 0, monthUsd: 0, byRole: { review: { todayUsd: 0, monthUsd: 0 } } });
  });

  test('row name and row-state shape', () => {
    const d = createOpenRouterDevice(stubClock());
    expect(d.row).toBe('openrouter');
    expect(d.deviceId).toBe('MD-UX-SIM-LLM-PROVIDER-WORLD-CREDIT-ACP-TS');
    expect(d.observe()).toMatchObject({ row: 'openrouter', provider: 'openrouter' });
    expect(() => d.setBalanceUsd(-1)).toThrow();
  });
});

describe('claude-acp device', () => {
  test('hostOnly, maxSessions 2: sessions 2 -> 503 session_limit', () => {
    const d = createAcpDevice(stubClock(), { maxSessions: 2 }); // 출처: 내부 문서 `MANUAL-ux-simulation-devices-2026-08-23` — LLM-AUTO-PROVIDER-E2E 시뮬 장치
    expect(d.hostOnly).toBe(true);
    expect(d.row).toBe('claude-acp');
    expect(d.call()).toEqual({ ok: true, device: 'claude-acp' });
    d.setSessions(2);
    const r = d.call();
    expect(r).toEqual({
      ok: false, device: 'claude-acp', status: 503, code: 'session_limit',
      message: 'claude-acp session limit reached: 2 of 2 sessions in use',
    });
    expect(d.observe()?.device).toMatchObject({ status: 'measured', alive: true, sessions: 2 });
  });

  test('dead device -> 503 device_down, observe alive false, no secret shapes', () => {
    const d = createAcpDevice(stubClock(), { maxSessions: 3 }); // 출처: 내부 문서 `MANUAL-ux-simulation-devices-2026-08-23` — LLM-AUTO-PROVIDER-E2E 시뮬 장치
    d.setAlive(false);
    const r = d.call();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(503);
    expect(r.code).toBe('device_down');
    expect(SECRET_SHAPE.test(r.message)).toBe(false);
    expect(d.observe()?.device).toMatchObject({ alive: false, sessions: 0 });
    d.setAlive(true);
    expect(d.call().ok).toBe(true);
  });

  test('window is optional and shows usedPct 85 when set', () => {
    const d = createAcpDevice(stubClock(), { maxSessions: 1 }); // 출처: 내부 문서 `MANUAL-ux-simulation-devices-2026-08-23` — LLM-AUTO-PROVIDER-E2E 시뮬 장치
    expect(d.observe()?.window).toBeUndefined();
    d.setWindow({ usedPct: 85, resetAt: '2026-11-20T05:00:00Z' });
    expect(d.observe()?.window).toMatchObject({ status: 'measured', usedPct: 85, resetAt: '2026-11-20T05:00:00Z' });
    expect(() => d.setWindow({ usedPct: 101 })).toThrow();
  });

  test('maxSessions must be integer >= 1', () => {
    expect(() => createAcpDevice(stubClock(), { maxSessions: 0 })).toThrow(); // 출처: 내부 문서 `MANUAL-ux-simulation-devices-2026-08-23` — LLM-AUTO-PROVIDER-E2E 시뮬 장치
  });
});
