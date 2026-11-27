// BULLETIN-DELIVERY-WAKE — a kind-bulletin mail from OP reaches every coordinator: no expiry, never a turn of its own,
// read on the seat's next idle. Seeded world (3 seeds): each coordinator is busy for random stretches (up to 3 h) while
// bulletins arrive every 15–30 min; the bulletin must still be live — and so readable — when the seat first goes idle.
// Expectations are literals (rule 11); the 30-min passive TTL contrast is computed from the literal 30 minutes.
import { describe, expect, test } from 'bun:test';
import { isLive, postExpiry } from './directive-expiry.js';
import { seatMailRoute } from '../tui/seat-mail-turn-policy.js';

const NOW = new Date('2026-11-26T09:00:00.000Z');

describe('bulletin expiry and route', () => {
  test('kind bulletin carries no expiry; a notice still lapses after 30 min', () => {
    expect(postExpiry({ kind: 'bulletin', now: NOW })).toEqual({ rule: 'bulletin' });
    expect(postExpiry({ kind: 'bulletin', senderAbove: true, now: NOW })).toEqual({ rule: 'bulletin' });
    expect(postExpiry({ kind: 'notice', now: NOW })).toEqual({ expiresAt: '2026-11-26T09:30:00.000Z', rule: 'passive' });
    // explicit flags still win
    expect(postExpiry({ kind: 'bulletin', expires: '2h', now: NOW })).toEqual({ expiresAt: '2026-11-26T11:00:00.000Z', rule: 'flag' });
  });

  test('a bulletin from OP (above) rides the next idle instead of opening a turn; crown and needs-reply still open one', () => {
    expect(seatMailRoute({ kind: 'bulletin', senderAbove: true })).toEqual({ route: 'passive', reason: 'bulletin' });
    expect(seatMailRoute({ kind: 'bulletin', senderAbove: false })).toEqual({ route: 'passive', reason: 'bulletin' });
    expect(seatMailRoute({ kind: 'bulletin', senderAbove: true, crownDirective: 'C-1' })).toEqual({ route: 'turn', reason: 'crown' });
    expect(seatMailRoute({ kind: 'bulletin', senderAbove: true, needsAck: true })).toEqual({ route: 'turn', reason: 'needs-reply' });
    // an ordinary order from above is unchanged
    expect(seatMailRoute({ kind: 'info', senderAbove: true })).toEqual({ route: 'turn', reason: 'order' });
  });
});

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

interface Outcome { posted: number; readAtIdle: number; turnsOpened: number; lapsedUnderNoticeTtl: number }

/** One day of four coordinators; returns what reached them. */
function world(seed: number): Outcome {
  const r = rng(seed);
  const seats = ['TC', 'MK', 'UX', 'JUD'];
  const ONE_MINUTE_MS = 60_000;
  const start = NOW.getTime();
  const out: Outcome = { posted: 0, readAtIdle: 0, turnsOpened: 0, lapsedUnderNoticeTtl: 0 };
  // Busy stretches per seat: alternate busy (10–180 min) and idle (2–20 min) through 24 h.
  const idleStarts = new Map<string, number[]>();
  for (const seat of seats) {
    const starts: number[] = [];
    let t = start;
    while (t < start + 26 * 60 * ONE_MINUTE_MS) { t += (10 + Math.floor(r() * 170)) * ONE_MINUTE_MS; starts.push(t); t += (2 + Math.floor(r() * 18)) * ONE_MINUTE_MS; }
    idleStarts.set(seat, starts);
  }
  for (let t = start; t < start + 24 * 60 * ONE_MINUTE_MS; t += (15 + Math.floor(r() * 15)) * ONE_MINUTE_MS) {
    const stamped = postExpiry({ kind: 'bulletin', senderAbove: true, now: new Date(t) });
    for (const seat of seats) {
      out.posted += 1;
      if (seatMailRoute({ kind: 'bulletin', senderAbove: true }).route === 'turn') out.turnsOpened += 1;
      const idleAt = idleStarts.get(seat)!.find((s) => s >= t)!;
      if (isLive({ expiresAt: stamped.expiresAt ?? null }, idleAt)) out.readAtIdle += 1;
      if (idleAt - t >= 30 * ONE_MINUTE_MS) out.lapsedUnderNoticeTtl += 1;
    }
  }
  return out;
}

describe('seeded delivery world (3 seeds)', () => {
  for (const seed of [11, 26, 1126]) {
    test(`seed ${seed}: every bulletin is live at the coordinator's next idle and none opens a turn`, () => {
      const o = world(seed);
      expect(o.posted).toBeGreaterThan(6 * 40); // 출처: #40268 — 6 seats × ≥48 bulletins/24 h at ≤30-min spacing (40 = margin)
      expect(o.readAtIdle).toBe(o.posted);
      expect(o.turnsOpened).toBe(0);
      // the world is not trivial: under the old 30-min notice TTL some of these would have lapsed unread
      expect(o.lapsedUnderNoticeTtl).toBeGreaterThan(0); // 출처: #40082 — 30-min passive TTL; the world must hold at least one wait past it
    });
  }
});
