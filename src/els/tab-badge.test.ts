import { describe, expect, test } from 'bun:test';
import { mapPaneStateToBadge, tabBadge, TAB_MENU_ACTIONS, STALLED_AFTER_MS_DEFAULT, type TabBadgeInput } from './tab-badge.js';

const NOW = 1_000_000;

describe('tab badge', () => {
  test('PaneState → 규약 state 사상 — 전 케이스 리터럴', () => {
    expect(mapPaneStateToBadge('working')).toBe('working');
    expect(mapPaneStateToBadge('idle')).toBe('idle');
    expect(mapPaneStateToBadge('blocked')).toBe('needs-approval');
    expect(mapPaneStateToBadge('done')).toBe('done');
    expect(mapPaneStateToBadge('exited')).toBe('exited');
  });

  test('working 배지 라벨 리터럴', () => {
    const input: TabBadgeInput = { state: 'working', lastEventAtMs: NOW - 1000 };
    const badge = tabBadge(input, NOW);
    expect(badge.state).toBe('working');
    expect(badge.stalled).toBe(false);
    expect(badge.label).toBe('[▶ working]');
  });

  test('무사건 지연이 임계(기본 15분)를 넘으면 stalled 로 바뀐다', () => {
    const fresh: TabBadgeInput = { state: 'working', lastEventAtMs: NOW - STALLED_AFTER_MS_DEFAULT };
    const freshBadge = tabBadge(fresh, NOW);
    expect(freshBadge.stalled).toBe(false);
    expect(freshBadge.state).toBe('working');

    const stale: TabBadgeInput = { state: 'working', lastEventAtMs: NOW - STALLED_AFTER_MS_DEFAULT - 1 };
    const staleBadge = tabBadge(stale, NOW);
    expect(staleBadge.stalled).toBe(true);
    expect(staleBadge.state).toBe('stalled');
    expect(staleBadge.label).toBe('[⏸ stalled]');
  });

  test('마지막 사건 시각을 모르면 멈춤 표시를 내지 않는다', () => {
    const unknown: TabBadgeInput = { state: 'working' };
    const badge = tabBadge(unknown, NOW);
    expect(badge.stalled).toBe(false);
    expect(badge.state).toBe('working');
  });

  test('idle/done/exited 는 무사건 지연과 무관하게 멈춤 표시가 없다', () => {
    for (const state of ['idle', 'done', 'exited'] as const) {
      const badge = tabBadge({ state, lastEventAtMs: NOW - STALLED_AFTER_MS_DEFAULT * 10 }, NOW);
      expect(badge.stalled).toBe(false);
      expect(badge.state).toBe(state === 'exited' ? 'exited' : state);
    }
  });

  test('탭 메뉴 — stop/migrate 는 컨트롤 문 경유(우회 0)', () => {
    const stop = TAB_MENU_ACTIONS.find((a) => a.action === 'stop');
    const migrate = TAB_MENU_ACTIONS.find((a) => a.action === 'migrate');
    expect(stop?.via).toBe('door');
    expect(stop?.doorOp).toBe('stop');
    expect(migrate?.via).toBe('door');
    expect(migrate?.doorOp).toBe('stop');
    expect(migrate?.doorMode).toBe('migrate');
    const doorActions = TAB_MENU_ACTIONS.filter((a) => a.via === 'door').map((a) => a.action);
    expect(['read', 'do', 'stop', 'migrate']).toEqual(doorActions);
  });
});
