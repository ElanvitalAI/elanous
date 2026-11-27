// COST-OPTIMIZER-WINDOW-AWARE — 스냅숏 제공자 시험. 이미 있는 신호만 · 모르는 값은 생략 · 건너뜀마다 이벤트.
// 가짜 codex 점검 seam · 시계 주입 · 디스크·네트워크 0.
import { describe, expect, test } from 'bun:test';
import { readAccountWindowSnapshot, resolveWindowAccountsMode, type AccountWindowSnapshotDeps } from './account-window-snapshot.js';
import type { MembershipResolver } from '../plugins/smart-router/consumer.js';
import { WINDOW_ACCOUNT_EVENT, WINDOW_SNAPSHOT_TTL_MS } from './window-account-selector.js';

const NOW = WINDOW_SNAPSHOT_TTL_MS * 4;
const OLDER = NOW - WINDOW_SNAPSHOT_TTL_MS / 2;
const NEWER = NOW - WINDOW_SNAPSHOT_TTL_MS / 4;
const USED_HALF = 50;
/** SMART-ROUTER-TIER-FULL-WIRE(칸 43) — 등급 원천 주입(시험): subscription_window_aware 허용 등급(pro). */
const PRO_MEMBER: MembershipResolver = { currentTier: () => 'pro' };

type Inspect = ReturnType<NonNullable<AccountWindowSnapshotDeps['inspectCodex']>>;
const inspect = (over: Partial<Inspect> = {}): Inspect => ({
  current: { name: 'default', storeKey: 'openai-codex', home: '/h/default', source: 'default' },
  explicit: false,
  reason: 'not-reached',
  to: undefined,
  candidates: [
    { name: 'default', storeKey: 'openai-codex', home: '/h/default', reached: undefined, usedPercent: USED_HALF },
    { name: 'team', storeKey: 'openai-codex:team', home: '/h/team', reached: true, usedPercent: USED_HALF },
    { name: 'third', storeKey: 'openai-codex:third', home: '/h/third', reached: undefined, usedPercent: USED_HALF },
    { name: 'sick', storeKey: 'openai-codex:sick', home: '/h/sick', reached: undefined, unhealthy: true },
  ],
  observedAtByHome: { '/h/default': OLDER, '/h/team': NEWER, '/h/third': NOW - WINDOW_SNAPSHOT_TTL_MS * 3 },
  freshByHome: { '/h/default': true, '/h/team': true, '/h/third': false, '/h/sick': true },
  resetsAtByHome: {},
  ...over,
});

function read(provider: string, deps: Partial<AccountWindowSnapshotDeps> = {}) {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const snapshot = readAccountWindowSnapshot(provider, {
    now: () => NOW, config: () => ({ harness: {} }), inspectCodex: () => inspect(),
    emit: (category, event, data) => { if (category === WINDOW_ACCOUNT_EVENT) events.push({ event, data }); },
    ...deps,
  });
  return { snapshot, events };
}

describe('readAccountWindowSnapshot — codex quota signals only', () => {
  test('maps fresh signals to windows, reached to zero, stale to unknown; reset time stays unknown', () => {
    const { snapshot, events } = read('openai-codex');
    expect(snapshot).toEqual({
      candidates: [
        { provider: 'openai-codex', account: 'default', billing: 'subscription', window: { remaining: (100 - USED_HALF) / 100 } },
        { provider: 'openai-codex', account: 'team', billing: 'subscription', window: { remaining: 0 } },
        { provider: 'openai-codex', account: 'third', billing: 'subscription' },
      ],
      active: { provider: 'openai-codex', account: 'default' },
      selection: 'shadow', readAtMs: NOW, observedAtMs: OLDER,
    });
    expect(events).toEqual([{ event: 'snapshot-skip', data: { provider: 'openai-codex', reason: 'unhealthy-excluded', count: 1 } }]);
  });

  test('no fresh signal leaves the observation time unknown (the selector then refuses as stale)', () => {
    const { snapshot } = read('openai-codex', { inspectCodex: () => inspect({ freshByHome: {} }) });
    expect(snapshot?.observedAtMs).toBeUndefined();
  });

  test('active is the rotation target when the rotation would move the run (the child runs there)', () => {
    expect(read('openai-codex', { inspectCodex: () => inspect({ reason: 'rotated', to: 'third' }) }).snapshot?.active)
      .toEqual({ provider: 'openai-codex', account: 'third' });
    expect(read('openai-codex', { inspectCodex: () => inspect({ reason: 'no-candidate', to: undefined }) }).snapshot?.active)
      .toEqual({ provider: 'openai-codex', account: 'default' });
  });

  test('passes a measured future reset through to the actual account selector input', () => {
    const { snapshot } = read('openai-codex', { inspectCodex: () => inspect({ resetsAtByHome: { '/h/default': NOW + 60_000 } }) });
    expect(snapshot?.candidates[0]?.window).toEqual({ remaining: 0.5, resetsAtMs: NOW + 60_000 });
  });

  test('explicit account is carried so the selector keeps the human choice', () => {
    expect(read('openai-codex', { inspectCodex: () => inspect({ explicit: true }) }).snapshot?.explicit).toBe(true);
  });

  test('read failure returns no snapshot and emits an event without the error text', () => {
    const { snapshot, events } = read('openai-codex', { inspectCodex: () => { throw new Error('ACCOUNT-NAME-MARKER boom'); } });
    expect(snapshot).toBeUndefined();
    expect(events).toEqual([{ event: 'snapshot-skip', data: { provider: 'openai-codex', reason: 'read-failed', error: 'Error' } }]);
  });

  test('providers without per-account window data get an empty, unattributed state', () => {
    let called = false;
    const { snapshot } = read('anthropic', { inspectCodex: () => { called = true; return inspect(); } });
    expect(snapshot).toEqual({ candidates: [], active: { provider: 'anthropic', account: null }, selection: 'shadow', readAtMs: NOW });
    expect(called).toBe(false);
  });

  test('mode: only explicit `on` selects; unreadable config emits and stays shadow; forceShadow wins', () => {
    expect(resolveWindowAccountsMode({ harness: { windowAccounts: 'on' } })).toBe('on');
    expect(resolveWindowAccountsMode({ harness: { windowAccounts: 'live' as never } })).toBe('shadow');
    expect(resolveWindowAccountsMode(undefined)).toBe('shadow');
    expect(read('openai-codex', { config: () => ({ harness: { windowAccounts: 'on' } }), membership: PRO_MEMBER }).snapshot?.selection).toBe('on');
    // 칸 43 — 등급 게이트: 미달 등급(free)은 `on` 요청도 shadow 로 강등(fail-closed).
    expect(read('openai-codex', { config: () => ({ harness: { windowAccounts: 'on' } }), membership: { currentTier: () => 'free' } }).snapshot?.selection).toBe('shadow');
    expect(read('openai-codex', { config: () => ({ harness: { windowAccounts: 'on' } }), forceShadow: true, membership: PRO_MEMBER }).snapshot?.selection).toBe('shadow');
    const broken = read('openai-codex', { config: () => { throw new TypeError('bad'); } });
    expect(broken.snapshot?.selection).toBe('shadow');
    expect(broken.events[0]).toEqual({ event: 'snapshot-skip', data: { provider: 'openai-codex', reason: 'config-unreadable', error: 'TypeError' } });
  });
});
