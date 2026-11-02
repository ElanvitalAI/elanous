// P2 (2026-07-16) — 동시 구독 + presence. session_manage 구독 액션 노출 +
// presence 유예 TTL 셀프힐(reconcileSessionPresence).

import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let previousRoot: string | undefined;
let tmp: string;
beforeEach(async () => {
  previousRoot = process.env.ELANOUS_SESSION_ROOT;
  tmp = mkdtempSync(join(tmpdir(), 'sess-p2-'));
  process.env.ELANOUS_SESSION_ROOT = tmp;
  const { _clearSubscriberIndexForTest } = await import('../src/session/index.js');
  _clearSubscriberIndexForTest();
});
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.ELANOUS_SESSION_ROOT; else process.env.ELANOUS_SESSION_ROOT = previousRoot;
});

describe('session_manage 구독 액션 (전 서피스 노출)', () => {
  test('subscribe → subscribers → unsubscribe(leave) 왕복', async () => {
    const S = await import('../src/session/index.js');
    const { dispatchSessionQuery } = await import('../src/domains/session-query-tool.js');
    const m = S.createSession({ source: 'cli' }, tmp);

    const sub = await dispatchSessionQuery({ action: 'subscribe', sessionId: m.id, surface: 'telegram', endpoint: '42', role: 'ro' }, { root: tmp }) as { subscriber: string; role: string };
    expect(sub.subscriber).toBe('telegram:42');
    expect(sub.role).toBe('ro');

    const list = await dispatchSessionQuery({ action: 'subscribers', sessionId: m.id }, { root: tmp }) as { count: number; subscribers: Array<{ key: string; presence: string }> };
    expect(list.count).toBe(1);
    expect(list.subscribers[0].key).toBe('telegram:42');
    expect(list.subscribers[0].presence).toBe('active');

    const leave = await dispatchSessionQuery({ action: 'unsubscribe', sessionId: m.id, subscriberKey: 'telegram:42' }, { root: tmp }) as { left: boolean; remaining: number };
    expect(leave.left).toBe(true);
    expect(leave.remaining).toBe(0);
  });

  test('subscribe 잘못된 surface → error', async () => {
    const S = await import('../src/session/index.js');
    const { dispatchSessionQuery } = await import('../src/domains/session-query-tool.js');
    const m = S.createSession({ source: 'cli' }, tmp);
    const res = await dispatchSessionQuery({ action: 'subscribe', sessionId: m.id, surface: 'bogus' }, { root: tmp }) as { error?: string };
    expect(res.error).toBeDefined();
  });

  test('context 액션 — grounded 자기인지 문맥(누가 보고 있나)', async () => {
    const S = await import('../src/session/index.js');
    const { dispatchSessionQuery } = await import('../src/domains/session-query-tool.js');
    const m = S.createSession({ source: 'cli' }, tmp);
    S.subscribeSession(m.id, { surface: 'pwa', endpoint: 'p1' }, {}, tmp);
    const ctx = await dispatchSessionQuery({ action: 'context', sessionId: m.id }, { root: tmp }) as { found: boolean; subscribers: unknown[]; formatted: string };
    expect(ctx.found).toBe(true);
    expect(ctx.subscribers.length).toBe(1);
    expect(ctx.formatted).toContain('pwa:p1');
  });

  test('context — 없는 세션은 anti-confabulation', async () => {
    const { dispatchSessionQuery } = await import('../src/domains/session-query-tool.js');
    const res = await dispatchSessionQuery({ action: 'context', sessionId: 'deadbeef-no-such' }, { root: tmp }) as { error?: string };
    // resolveSessionId 가 못 찾으면 error(prefix 불일치).
    expect(res.error).toBeDefined();
  });
});

describe('presence 셀프힐 — reconcileSessionPresence(TTL)', () => {
  test('grace 유예가 TTL 초과 → left 전이', async () => {
    const S = await import('../src/session/index.js');
    const m = S.createSession({ source: 'cli' }, tmp);
    const key = S.subscriberKey('telegram', '9');
    S.subscribeSession(m.id, { surface: 'telegram', endpoint: '9' }, { now: '2026-07-16T00:00:00Z' }, tmp);
    S.setSubscriberPresence(m.id, key, 'grace', tmp); // lastSeenAt = 실시간(전이 시점)

    // now 를 lastSeenAt 훨씬 이후로 주입 → TTL 초과 → 이탈.
    const future = Date.parse(S.listSubscribers(m.id)[0]!.lastSeenAt) + 60_001;
    const evicted = S.reconcileSessionPresence(m.id, { ttlMs: 60_000, now: future }, tmp);
    expect(evicted).toEqual([key]);
    expect(S.listSubscribers(m.id, { presence: 'left' }, tmp).length).toBe(1);
  });

  test('grace 지만 TTL 이내 → 유지(무이탈)', async () => {
    const S = await import('../src/session/index.js');
    const m = S.createSession({ source: 'cli' }, tmp);
    const key = S.subscriberKey('pwa', 'p');
    S.subscribeSession(m.id, { surface: 'pwa', endpoint: 'p' }, {}, tmp);
    S.setSubscriberPresence(m.id, key, 'grace', tmp);
    const lastSeenAt = Date.parse(S.listSubscribers(m.id)[0]!.lastSeenAt);
    const evicted = S.reconcileSessionPresence(m.id, { ttlMs: 10 * 60_000, now: lastSeenAt + 10 * 60_000 }, tmp);
    expect(evicted).toEqual([]);
    expect(S.listSubscribers(m.id, { presence: 'grace' }, tmp).length).toBe(1);
  });

  test('sweepSessionPresence — 데몬 타이머용 배치(grace 세션만 스캔·일괄 이탈)', async () => {
    const S = await import('../src/session/index.js');
    // 세션 A: grace 초과 · 세션 B: active(무관) · 세션 C: grace 이내.
    const a = S.createSession({ source: 'cli' }, tmp);
    S.subscribeSession(a.id, { surface: 'pwa', endpoint: 'a' }, {}, tmp);
    S.setSubscriberPresence(a.id, S.subscriberKey('pwa', 'a'), 'grace', tmp);
    const b = S.createSession({ source: 'cli' }, tmp);
    S.subscribeSession(b.id, { surface: 'telegram', endpoint: 'b' }, {}, tmp); // active
    const future = Date.parse(S.listSubscribers(a.id)[0]!.lastSeenAt) + 60_001;
    const evicted = S.sweepSessionPresence({ ttlMs: 60_000, now: future }, tmp);
    expect(evicted).toBe(1);                                          // A 만 이탈
    expect(S.listSubscribers(a.id, { presence: 'left' }, tmp).length).toBe(1);
    expect(S.listSubscribers(b.id, { presence: 'active' }, tmp).length).toBe(1); // B 무관
  });
});
