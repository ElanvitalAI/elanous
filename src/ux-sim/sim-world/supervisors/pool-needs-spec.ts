// SIM-WORLD supervisors · POOL-PULL-NEEDS-SPEC (0.3.38 P1 · OP 11-27 16:30) — after ~100 held cells went to the pool,
// hand blocks rose 10→34: many pool cells had no done-when and hands asked TC «what is the KPI contract / done line».
// Per seed (ctx.seed … ctx.seed+4): a seeded board of 12 unowned yellow cells, some with a done-when and some without;
// four TC hands pull with the REAL workNext (in-memory compare-and-set ledger) until every hand gets exit 3, then the
// REAL boardTick lists the leftovers to OP. The expected sets come from how the world was built (not from product code).
//   policy on  → hands claim exactly the cells with a done-when · none without · OP gets ONE needs-spec line naming the
//                rest · a second tick with the same set sends nothing.
//   policy off → hands claim every cell (the pre-policy behaviour).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { boardTick, type BoardDeps } from '../../../steward/board/tick.js';
import type { BoardCellIn } from '../../../steward/board/model.js';
import { workNext, type BoardCell } from '../../../steward/space/work-next.js';
import type { SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

const AT = Date.parse('2026-11-27T16:30:00.000Z');
const HANDS = ['TC-H-1', 'TC-H-2', 'TC-H-3', 'TC-H-4'];
const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });

/** mulberry32 — one reproducible stream per seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

interface World { readonly cells: Map<string, BoardCell & { owner?: string; status: string }>; readonly withSpec: string[]; readonly noSpec: string[] }

function world(seed: number): World {
  const r = rng(seed);
  const cells: World['cells'] = new Map();
  const withSpec: string[] = []; const noSpec: string[] = [];
  for (let i = 0; i < 12; i++) {
    const id = `POOL-${String(i).padStart(2, '0')}`;
    // cell 0 always has a done-when, cell 1 never — every seed has both kinds
    const spec = i === 0 ? true : i === 1 ? false : r() < 0.5;
    const priority = (['P0', 'P1', 'P2', undefined] as const)[Math.floor(r() * 4)];
    cells.set(id, { id, title: `pool cell ${i}`, status: 'yellow', updatedAt: new Date(AT - Math.floor(r() * 7_200_000)).toISOString(),
      ...(priority ? { priority } : {}), ...(spec ? { doneCriterion: `focused test ${i} green` } : {}) });
    (spec ? withSpec : noSpec).push(id);
  }
  return { cells, withSpec, noSpec };
}

/** Every hand pulls until exit 3; a claimed cell closes green at once (the hand returns to the pool). */
function pullAll(w: World, requireDoneWhen: boolean): { claimed: string[]; exit3: number } {
  const claimed: string[] = [];
  let exit3 = 0;
  for (let round = 0; round < 20 && exit3 < HANDS.length; round++) {
    exit3 = 0;
    for (const seat of HANDS) {
      const r = workNext(seat, {
        now: () => AT, version: '9.9.9', cells: () => [...w.cells.values()], scopeOf: () => 'TC', lastActiveMs: () => undefined,
        isCoordinator: (s) => s === 'TC', isJudge: () => false, requireDoneWhen: () => requireDoneWhen,
        swap: (id, input) => {
          const c = w.cells.get(id);
          if (!c) return { outcome: 'missing' };
          if ((c.owner ?? null) !== input.expectedOwner) return { outcome: 'lost' };
          w.cells.set(id, { ...c, owner: input.to });
          return { outcome: 'swapped' };
        },
      });
      if (r.code === 3) { exit3++; continue; }
      if (r.code === 0) { claimed.push(r.cell.id); const c = w.cells.get(r.cell.id)!; w.cells.set(c.id, { ...c, status: 'green' }); }
    }
  }
  return { claimed: claimed.sort(), exit3 };
}

function boardDeps(w: World, dir: string, sent: string[], at: number): BoardDeps {
  return {
    dir, live: true, now: () => new Date(at), version: () => '9.9.9', nextVersion: () => '9.9.10', phase: () => 'build',
    cells: () => [...w.cells.values()] as BoardCellIn[], hands: () => [], scopeOf: () => 'TC', isCoordinator: (s) => s === 'TC', waitingOn: () => null,
    readOrder: () => ({ order: [] }), writeOrder: () => {}, publishedAt: () => null, resetPhase: () => {}, returnCell: () => false,
    requireDoneWhen: () => true, card: (line, to) => { if (to === 'OP' && line.includes('needs-spec')) sent.push(line); },
  };
}

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

async function run(ctx: SimWorldScenarioContext): Promise<SimWorldScenarioOutcome> {
  const rows: Array<Record<string, unknown>> = [];
  for (let k = 0; k < 5; k++) {
    const seed = (ctx.seed + k) >>> 0;
    // policy on
    const on = world(seed);
    const pulled = pullAll(on, true);
    if (pulled.exit3 !== HANDS.length) return fail('pool-never-empty', `seed ${seed}: ${pulled.exit3}/${HANDS.length} hands at exit 3`);
    const wrong = pulled.claimed.filter((id) => on.noSpec.includes(id));
    if (wrong.length) return fail('needs-spec-offered', `seed ${seed}: claimed without done-when ${wrong.join(',')}`);
    if (!same(pulled.claimed, [...on.withSpec].sort())) return fail('spec-cell-not-offered', `seed ${seed}: claimed ${pulled.claimed.join(',')} ≠ ${on.withSpec.join(',')}`);
    const dir = join(ctx.universeRoot, `s${seed}`, 'board'); mkdirSync(dir, { recursive: true });
    const sent: string[] = [];
    boardTick(boardDeps(on, dir, sent, AT));
    boardTick(boardDeps(on, dir, sent, AT + 10 * 60_000));
    const expected = `needs-spec ${on.noSpec.length}: `;
    if (sent.length !== 1) return fail('needs-spec-not-once', `seed ${seed}: ${sent.length} needs-spec lines to OP over 2 ticks`);
    if (!sent[0]!.includes(expected) || !sent[0]!.endsWith(` · ${[...on.noSpec].sort().join(' · ')}`)) return fail('needs-spec-set-wrong', `seed ${seed}: ${sent[0]}`);
    // policy off — every cell is offered
    const off = world(seed);
    const all = pullAll(off, false);
    if (!same(all.claimed, [...off.cells.keys()].sort())) return fail('policy-off-skips', `seed ${seed}: claimed ${all.claimed.length}/12`);
    rows.push({ seed, withSpec: on.withSpec.length, noSpec: on.noSpec.length, claimedOn: pulled.claimed.length, claimedOff: all.claimed.length });
  }
  ctx.recorder.event('pool-needs-spec', { rows });
  return { ok: true };
}

export const simWorldScenarios: readonly SimWorldScenario[] = [{
  id: 'SUP-POOL-NEEDS-SPEC',
  title: 'pool cells without a done-when are not offered by eln work next (cells with one are) · the board steward lists them to OP once · policy off offers all',
  run,
}];
