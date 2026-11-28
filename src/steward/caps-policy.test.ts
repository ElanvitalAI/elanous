import { describe, expect, test } from 'bun:test';
import { loadStewardCapsPolicy, stewardCaps } from './caps-policy.js';
import { cardCandidates, cardsAllowed } from './board/model.js';

describe('steward pool-scaled policy', () => {
  test('literal H0, H10 and H40 caps come from policy', () => {
    const policy = loadStewardCapsPolicy();
    expect(stewardCaps(policy, 0)).toEqual({ reclaim: 0, candidates: 0, boardCards: 0, splitPieces: 0, throughputCards: 0, landSlots: 0 });
    expect(stewardCaps(policy, 10)).toEqual({ reclaim: 8, candidates: 3, boardCards: 3, splitPieces: 4, throughputCards: 8, landSlots: 1 });
    expect(stewardCaps(policy, 40)).toEqual({ reclaim: 32, candidates: 12, boardCards: 12, splitPieces: 16, throughputCards: 32, landSlots: 4 });
  });
  test('candidate selection keeps the independent sending window and dedupe', () => {
    const input = Array.from({ length: 15 }, (_, i) => ({ key: String(i), line: String(i) }));
    const candidates = cardCandidates(input, 12);
    expect(candidates).toHaveLength(12);
    expect(cardCandidates(input, 0)).toHaveLength(0);
    expect(cardCandidates(input, null)).toHaveLength(0);
    expect(cardsAllowed(candidates, [], 0, 3)).toHaveLength(3);
    expect(cardsAllowed(candidates, [{ at: 0, key: '0' }], 1, 3).map((b) => b.key)).toEqual(['1', '2']);
  });
  test('10 and 40 hands bound real board candidate and send selection independently', () => {
    const policy = loadStewardCapsPolicy();
    const detected = Array.from({ length: 50 }, (_, i) => ({ key: `card-${i}`, line: `card ${i}` }));
    const small = stewardCaps(policy, 10)!;
    const large = stewardCaps(policy, 40)!;
    expect(cardCandidates(detected, small.candidates).map(c => c.key)).toEqual(['card-0', 'card-1', 'card-2']);
    expect(cardsAllowed(detected, [], 0, small.boardCards).map(c => c.key)).toEqual(['card-0', 'card-1', 'card-2']);
    expect(cardCandidates(detected, large.candidates).map(c => c.key)).toEqual([
      'card-0', 'card-1', 'card-2', 'card-3', 'card-4', 'card-5',
      'card-6', 'card-7', 'card-8', 'card-9', 'card-10', 'card-11',
    ]);
    expect(cardsAllowed(detected, [], 0, large.boardCards).map(c => c.key)).toEqual([
      'card-0', 'card-1', 'card-2', 'card-3', 'card-4', 'card-5',
      'card-6', 'card-7', 'card-8', 'card-9', 'card-10', 'card-11',
    ]);
    expect(cardsAllowed(detected, [{ at: 0, key: 'card-0' }], 1, large.boardCards)).toHaveLength(11);
    expect(cardsAllowed(detected, [], 0, null)).toEqual([]);
  });
  test('unknown and invalid pool measurements never become zero', () => {
    const policy = loadStewardCapsPolicy();
    expect(stewardCaps(policy, null)).toBeNull();
    expect(stewardCaps(policy, -1)).toBeNull();
    expect(stewardCaps(policy, Number.NaN)).toBeNull();
  });
});
