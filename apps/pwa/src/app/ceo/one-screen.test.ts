import { expect, test } from 'bun:test';
import { heartbeatText, oneScreenAnswer, spareSlots, UNMEASURED, type OneScreenGrid } from './one-screen';

const grid = {
  hq: { record: { holder: 'OP', generation: 1, acquiredAt: '2026-10-23T08:00:00Z', renewedAt: '2026-10-23T09:57:55Z', ttlSeconds: 900 }, ageSeconds: 125, expired: false, reason: null },
  members: [
    { context: 'OP', capacity: 3, running: 2, pending: 0, occupied: 2, reason: null },
    { context: 'TC', capacity: 5, running: 1, pending: 0, occupied: 1, reason: null },
  ],
  poolReason: null,
} as unknown as OneScreenGrid;

test('oneScreenAnswer names blockage and pending decision count without inventing zeros', () => {
  const answer = oneScreenAnswer({
    flow: { label: '공급 부족', reason: '빈 자리 2 · 발사 가능 칸 0' },
    release: { green: 7, yellow: 2 },
    decisions: 2,
    decisionTitles: ['발행 컷 승인', '칸 재배치'],
    merged: 2,
    risks: [{ kind: '멈춘 하니스 런', title: '하니스 런 실패' }],
    grid,
  });
  expect(answer.blocked).toContain('공급 부족');
  expect(answer.blocked).toContain('멈춘 하니스 런');
  expect(answer.decide).toBe('결정 대기 2건 · 발행 컷 승인');
  expect(answer.landed).toBe('2건');
  expect(answer.spare).toBe('5칸');
  expect(answer.heartbeat).toBe('2분 전');
  expect(answer.release).toBe('green 7 · 노랑 2');
});

test('spareSlots and heartbeatText keep unmeasured sources distinct from zero', () => {
  expect(spareSlots(grid)).toBe(5);
  expect(spareSlots({ ...grid, poolReason: 'pool down' })).toBeNull();
  expect(spareSlots({ ...grid, members: [{ ...grid.members[0]!, occupied: null }, grid.members[1]!] })).toBeNull();
  expect(heartbeatText(125)).toBe('2분 전');
  expect(heartbeatText(null)).toBe(UNMEASURED);
});
