import { describe, expect, test } from 'bun:test';
import { createClaudeSubscriptions, createCodexSubscriptions, createSimClock } from './subscriptions.js';

const START = '2026-11-20T00:00:00Z';
const H = 3_600_000;
const SECRETISH = /(sk-[A-Za-z0-9]{8,}|Bearer\s|eyJ[A-Za-z0-9_-]{10,}|oauth-token|refresh_token|api[_-]?key\s*[:=])/i;

describe('SimClock', () => {
  test('now/advance/set', () => {
    const c = createSimClock(START);
    expect(c.now().toISOString()).toBe('2026-11-20T00:00:00.000Z');
    c.advance(90 * 60_000);
    expect(c.now().toISOString()).toBe('2026-11-20T01:30:00.000Z');
    c.set('2026-11-21T09:00:00+09:00');
    expect(c.now().toISOString()).toBe('2026-11-21T00:00:00.000Z');
  });
  test('시간대 없는 ISO 는 거부', () => {
    expect(() => createSimClock('2026-11-20T00:00:00')).toThrow('시간대');
    const c = createSimClock(START);
    expect(() => c.set('2026-11-20 09:00')).toThrow('시간대');
    expect(() => c.advance(-1)).toThrow();
  });
});

describe('codex 구독 ×3', () => {
  test('행 이름·공급자', () => {
    const c = createCodexSubscriptions(createSimClock(START));
    expect([c.default.row, c.team.row, c.third.row]).toEqual(['codex-default', 'codex-team', 'codex-third']);
    expect(c.default.observe()?.provider).toBe('openai-codex');
  });
  test('default 95% 도달 → observe usedPct 95', () => {
    const c = createCodexSubscriptions(createSimClock(START));
    c.default.setUsedPct('five-hour', 95);
    const s = c.default.observe();
    expect(s?.window).toMatchObject({ status: 'measured', usedPct: 95, resetAt: '2026-11-20T05:00:00.000Z', observedAt: '2026-11-20T00:00:00.000Z' });
    expect(c.default.call()).toEqual({ ok: true, device: 'MD-UX-SIM-LLM-PROVIDER-WORLD-SUBSCRIPTIONS-TS' });
    expect(c.team.observe()?.window).toMatchObject({ usedPct: 0 });
  });
  test('exhaust → 429 usage_limit_reached + resetsAt, 시계가 리셋을 지나면 0%', () => {
    const clock = createSimClock(START);
    const c = createCodexSubscriptions(clock);
    c.default.exhaust('five-hour', '2026-11-20T03:00:00Z');
    const r = c.default.call();
    expect(r).toEqual({
      ok: false, device: 'MD-UX-SIM-LLM-PROVIDER-WORLD-SUBSCRIPTIONS-TS', status: 429, code: 'usage_limit_reached',
      message: 'The usage limit has been reached (codex-default: five-hour). Resets at 2026-11-20T03:00:00.000Z.',
      resetsAt: '2026-11-20T03:00:00.000Z',
    });
    expect(c.default.observe()?.window).toMatchObject({ usedPct: 100, resetAt: '2026-11-20T03:00:00.000Z' });
    clock.advance(2 * H);
    expect(c.default.observe()?.window).toMatchObject({ usedPct: 100 });
    clock.advance(1 * H);
    expect(c.default.observe()?.window).toMatchObject({ usedPct: 0, resetAt: '2026-11-20T08:00:00.000Z' });
    expect(c.default.call().ok).toBe(true);
  });
  test('exhaust 시간대 없는 ISO 거부', () => {
    const c = createCodexSubscriptions(createSimClock(START));
    expect(() => c.third.exhaust('weekly', '2026-11-21T00:00:00')).toThrow('시간대');
    expect(() => c.third.setUsedPct('weekly', 101)).toThrow();
  });
  test('lease 슬롯 — 기본 임대 · 지정 · 해제(이름만)', () => {
    const clock = createSimClock(START);
    const c = createCodexSubscriptions(clock);
    expect(c.team.observe()?.lease).toEqual({ leaseId: 'sim-lease-codex-team', expiresAt: '2026-11-20T01:00:00.000Z' });
    c.team.setLease({ leaseId: 'lease-x', expiresAt: '2026-11-20T00:10:00Z' });
    expect(c.team.observe()?.lease).toEqual({ leaseId: 'lease-x', expiresAt: '2026-11-20T00:10:00Z' });
    c.team.clearLease();
    expect(c.team.observe()?.lease).toEqual({ leaseId: null, reason: 'sim-lease-cleared' });
  });
});

describe('Claude 구독 ×2', () => {
  test('행 이름 · 한 창이라도 100% 면 소진 · 각각 리셋', () => {
    const clock = createSimClock(START);
    const c = createClaudeSubscriptions(clock);
    expect([c.sub1.row, c.sub2.row]).toEqual(['claude-code-sub', 'claude-code-sub-2']);
    expect(c.sub1.observe()?.provider).toBe('anthropic');
    c.sub1.exhaust('weekly', '2026-11-23T00:00:00Z');
    expect(c.sub1.windows()).toEqual([
      { name: 'five-hour', usedPct: 0, resetsAt: '2026-11-20T05:00:00.000Z' },
      { name: 'weekly', usedPct: 100, resetsAt: '2026-11-23T00:00:00.000Z' },
    ]);
    const r = c.sub1.call();
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(429); expect(r.code).toBe('usage_limit_reached'); expect(r.resetsAt).toBe('2026-11-23T00:00:00.000Z'); }
    expect(c.sub1.observe()?.window).toMatchObject({ usedPct: 100, source: 'sim:weekly' });
    expect(c.sub2.call().ok).toBe(true);
    c.sub2.exhaust('five-hour', '2026-11-20T02:00:00Z');
    clock.advance(2 * H);
    expect(c.sub2.windows()[0]).toEqual({ name: 'five-hour', usedPct: 0, resetsAt: '2026-11-20T07:00:00.000Z' });
    expect(c.sub2.call().ok).toBe(true);
    expect(c.sub1.call().ok).toBe(false);
  });
  test('두 창 모두 소진이면 가장 늦은 리셋을 알린다', () => {
    const c = createClaudeSubscriptions(createSimClock(START));
    c.sub1.exhaust('five-hour', '2026-11-20T04:00:00Z');
    c.sub1.exhaust('weekly', '2026-11-22T00:00:00Z');
    const r = c.sub1.call();
    expect(!r.ok && r.resetsAt).toBe('2026-11-22T00:00:00.000Z');
  });
});

test('탐침: 어떤 출력에도 비밀 모양 문자열 0', () => {
  const clock = createSimClock(START);
  const cx = createCodexSubscriptions(clock);
  const cl = createClaudeSubscriptions(clock);
  const all = [cx.default, cx.team, cx.third, cl.sub1, cl.sub2];
  all.forEach((d, i) => { d.exhaust(i % 2 ? 'weekly' : 'five-hour', '2026-11-20T03:00:00Z'); });
  const dump = JSON.stringify(all.map((d) => [d.observe(), d.call(), d.windows()]));
  expect(dump).not.toMatch(SECRETISH);
  expect(dump).toContain("usage_limit_reached");
});
