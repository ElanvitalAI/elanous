import { describe, expect, test } from 'bun:test';
import { assessSeatSurge, SEAT_SURGE_WINDOW_MS, type SeatSurgeEvent } from './seat-surge-monitor.js';

describe('seat surge rolling assessment', () => {
  test('counts only the rolling window, including its lower boundary and excluding future events', () => {
    const now = SEAT_SURGE_WINDOW_MS + 100;
    const events: SeatSurgeEvent[] = [
      { type: 'self-wake', seat: ' a ', at: 99 },
      { type: 'self-wake', seat: 'A', at: 100 },
      { type: 'self-wake', seat: 'A', at: now + 1 },
      { type: 'mail', from: 'A', to: 'B', at: now },
      { type: 'mail', from: 'B', to: 'A', at: now },
      { type: 'mail', from: 'A', to: 'A', at: now },
    ];
    expect(assessSeatSurge('a', events, now)).toMatchObject({ selfWakes: 1, sent: 1, received: 1, pingPong: [{ peer: 'B', alternations: 2 }] });
    expect(assessSeatSurge('A', events, now + SEAT_SURGE_WINDOW_MS + 2)).toMatchObject({ selfWakes: 0, sent: 0, received: 0, pingPong: [] });
  });
  test('finds pairwise alternating runs independently, resets on same direction and raises inclusive thresholds', () => {
    const pairs = [['A','B'], ['B','A'], ['A','C'], ['A','B'], ['A','B'], ['B','A']];
    const events: SeatSurgeEvent[] = pairs.map(([from, to], at) => ({ type: 'mail', from: from!, to: to!, at }));
    const status = assessSeatSurge('A', events, 10, { selfWakes: 1, sent: 4, received: 2, pingPong: 3 });
    expect(status.pingPong).toEqual([{ peer: 'B', alternations: 3 }, { peer: 'C', alternations: 1 }]);
    expect(status.triggers).toEqual(['sent', 'received', 'ping-pong:B']);
  });
});
