// STEWARD-CAPS-SCALE: real policy and board tick, synthetic inputs, isolated side effects.
import { join } from 'node:path';
import { loadStewardCapsPolicy, stewardCaps } from '../../../steward/caps-policy.js';
import { boardTick, type BoardDeps } from '../../../steward/board/tick.js';
import { cardCandidates, cardsAllowed, type BoardCellIn } from '../../../steward/board/model.js';
import type { SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

const cells: BoardCellIn[] = Array.from({ length: 16 }, (_, i) => ({
  id: `CAP-${String(i).padStart(2, '0')}`, title: `cell ${i}`, status: 'yellow',
  priority: 'P1', space: 'TC', owner: `H${Math.floor(i / 4)}`, updatedAt: '2026-11-27T00:00:00Z',
}));
const breaches = Array.from({ length: 16 }, (_, i) => ({ key: `breach-${i}`, line: `breach ${i}` }));

function scene(ctx: SimWorldScenarioContext, label: string, hands: number | null) {
  const caps = stewardCaps(loadStewardCapsPolicy(), hands);
  const sent: string[] = []; let written: readonly string[] = [];
  const deps: BoardDeps = {
    dir: join(ctx.universeRoot, label), live: true, now: () => new Date('2026-11-27T12:00:00Z'),
    version: () => '0.3.40', nextVersion: () => '0.3.41', phase: () => 'build',
    cells: () => cells, hands: () => [], candidateCap: () => caps?.candidates ?? null,
    cardCap: () => caps?.boardCards ?? null, scopeOf: () => 'TC', isCoordinator: () => false,
    waitingOn: () => null, readOrder: () => ({ order: [] }), writeOrder: order => { written = order; },
    publishedAt: () => null, resetPhase: () => {}, returnCell: () => true,
    card: line => { sent.push(line); },
  };
  const result = boardTick(deps);
  const candidates = cardCandidates(breaches, caps?.candidates ?? null);
  const allowed = cardsAllowed(candidates, [], Date.parse('2026-11-27T12:00:00Z'), caps?.boardCards ?? null);
  return { caps, candidates: candidates.length, allowed: allowed.length, cards: result.cards.length, sent: sent.length, order: result.order.length, written: written.length };
}
const outcome = (ok: boolean, observed: unknown): SimWorldScenarioOutcome => ok
  ? { ok: true } : { ok: false, reason: 'caps-scale', diff: `observed ${JSON.stringify(observed)}` };

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'SUP-STEWARD-CAPS-NORMAL', title: 'verified hand pool scales steward limits and board selection',
    async run(ctx) {
      const small = scene(ctx, 'normal-small', 10); const large = scene(ctx, 'normal-large', 20);
      const forty = scene(ctx, 'normal-forty', 40);
      ctx.recorder.event('sup:steward-caps-normal', { small, large, forty });
      const wantSmall = { reclaim: 8, candidates: 3, boardCards: 3, splitPieces: 4, throughputCards: 8, landSlots: 1 };
      const wantLarge = { reclaim: 16, candidates: 6, boardCards: 6, splitPieces: 8, throughputCards: 16, landSlots: 2 };
      const wantForty = { reclaim: 32, candidates: 12, boardCards: 12, splitPieces: 16, throughputCards: 32, landSlots: 4 };
      return outcome(JSON.stringify(small.caps) === JSON.stringify(wantSmall) && JSON.stringify(large.caps) === JSON.stringify(wantLarge)
        && JSON.stringify(forty.caps) === JSON.stringify(wantForty)
        && small.candidates === 3 && small.allowed === 3 && large.candidates === 6 && large.allowed === 6
        && forty.candidates === 12 && forty.allowed === 12
        && [small, large, forty].every(r => r.cards === 1 && r.sent === 1 && r.order === 16 && r.written === 16), { small, large, forty });
    },
  },
  {
    id: 'SUP-STEWARD-CAPS-EDGE', title: 'unknown hand pool fails closed without losing board order',
    async run(ctx) {
      const unknown = scene(ctx, 'edge-unknown', null);
      ctx.recorder.event('sup:steward-caps-edge', { unknown });
      return outcome(unknown.caps === null && unknown.candidates === 0 && unknown.allowed === 0
        && unknown.cards === 0 && unknown.sent === 0 && unknown.order === 16 && unknown.written === 16, unknown);
    },
  },
];
