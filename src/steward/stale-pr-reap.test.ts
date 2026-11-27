import { test, expect } from 'bun:test';
import { planStalePrCards } from './stale-pr-reap.js';

test('stale unreceipted PRs notify owners, then escalate after 24h without response', () => {
  const now = Date.parse('2026-01-03T00:00:00Z');
  const pr = { number: 42, owner: 'HAND', open: true, updatedAt: now - 12 * 3600_000, receipt: false, dirty: true, red: false };
  const first = planStalePrCards([pr], [], now, 6 * 3600_000);
  expect(first).toEqual([{ key: 'stale-pr:42:owner', to: 'HAND', pr: 42, action: 'commit-push-pregate-or-return' }]);
  const delivered = [{ key: first[0]!.key, createdAt: now, respondedAt: null }];
  expect(planStalePrCards([pr], delivered, now + 24 * 3600_000 - 1, 6 * 3600_000)).toEqual([]);
  expect(planStalePrCards([pr], delivered, now + 24 * 3600_000, 6 * 3600_000)).toEqual([{ key: 'stale-pr:42:op', to: 'OP', pr: 42, action: 'unanswered-owner' }]);
  expect(planStalePrCards([pr], [{ ...delivered[0]!, respondedAt: now + 1 }], now + 25 * 3600_000, 6 * 3600_000)).toEqual([]);
});

test('isolated ticks persist one card per PR and escalate only unanswered owners', () => {
  const now = Date.parse('2026-01-03T00:00:00Z');
  const base = { open: true, updatedAt: now - 12 * 3600_000, receipt: false, dirty: true, red: false };
  const prs = [{ ...base, number: 41, owner: 'HAND-A' }, { ...base, number: 42, owner: 'HAND-B' },
    { ...base, number: 43, owner: 'HAND-C', receipt: true }];
  const receipts: { key: string; createdAt: number; respondedAt: number | null }[] = [];
  const cards: ReturnType<typeof planStalePrCards> = [];
  const tick = (at: number) => {
    for (const card of planStalePrCards(prs, receipts, at, 6 * 3600_000)) {
      cards.push(card);
      receipts.push({ key: card.key, createdAt: at, respondedAt: null });
    }
  };
  tick(now);
  tick(now);
  expect(cards.map(c => [c.to, c.pr])).toEqual([['HAND-A', 41], ['HAND-B', 42]]);
  receipts[0]!.respondedAt = now + 1;
  tick(now + 24 * 3600_000);
  tick(now + 25 * 3600_000);
  expect(cards.map(c => [c.to, c.pr, c.action])).toEqual([
    ['HAND-A', 41, 'commit-push-pregate-or-return'],
    ['HAND-B', 42, 'commit-push-pregate-or-return'],
    ['OP', 42, 'unanswered-owner'],
  ]);
});

test('normal, recent, receipted, closed and already escalated PRs are excluded', () => {
  const now = 200 * 3600_000;
  const base = { number: 1, owner: 'HAND', open: true, updatedAt: now - 12 * 3600_000, receipt: false, dirty: true, red: false };
  const prs = [{...base, number: 1, receipt: true}, {...base, number: 2, dirty: false}, {...base, number: 3, updatedAt: now}, {...base, number: 4, open: false}];
  expect(planStalePrCards(prs, [], now, 6 * 3600_000)).toEqual([]);
  expect(planStalePrCards([base], [{key:'stale-pr:1:owner', createdAt: now - 25 * 3600_000, respondedAt: null}, {key:'stale-pr:1:op', createdAt: now - 1, respondedAt:null}], now, 6 * 3600_000)).toEqual([]);
});
