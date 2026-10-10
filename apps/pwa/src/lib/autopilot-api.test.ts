// Missions ↔ Schedules 연결(🅢 재분배 ③ · 2026-09-28).
import { describe, expect, it } from 'bun:test';
import { missionCardToSummary, missionSchedulesHref, type MissionCardWire } from './autopilot-api';
describe('missionSchedulesHref — 이 미션을 부르는 스케줄', () => {
  it('크론 계보의 레지스트리 id 로만 거른다(태스크·행동·id 없는 크론은 빼고)', () => {
    expect(missionSchedulesHref([
      { kind: 'cron', id: 'abc', name: 'a', status: 'ok', detail: null },
      { kind: 'task', id: 't1', name: 't', status: 'done', detail: null },
      { kind: 'cron', name: 'no-id', status: 'pending', detail: null },
      { kind: 'cron', id: 'x/y', name: 'b', status: 'stale', detail: null },
    ])).toBe('/scheduler?ids=abc,x%2Fy');
    expect(missionSchedulesHref([{ kind: 'task', id: 't1', name: 't', status: 'done', detail: null }])).toBeNull();
  });
});

describe('missionCardToSummary', () => {
  it('preserves updatedAt milliseconds from the unified mission card', () => {
    const updatedAt = Date.parse('2026-07-12T03:00:00Z');
    const card: MissionCardWire = {
      id: 'apm_1', title: 'Mission', description: null,
      status: 'active', priority: 'normal', goalSlug: null,
      taskCount: 0, taskStatusCounts: {}, surfaceKindCounts: {},
      autopilot: { origin: 'manual', apmStatus: 'running' },
      createdAt: updatedAt - 86_400_000, updatedAt, closedAt: null,
    };
    expect(missionCardToSummary(card).updatedAt).toBe(updatedAt);
  });
});
