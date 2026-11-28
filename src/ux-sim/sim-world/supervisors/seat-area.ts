// SIM-WORLD supervisors · SEAT-AREA-GUARD (0.3.39 P0 · Claude OP 11-28) — 11-28 measured: `eln seat pool` listed MK and UX
// (coordinators under OP, ladder depth 3) as general hands, so the resource steward (`[steward RO-n]`) and the 행정관 pushed any
// stalled P0 at an idle MK — RES-ABSORB-GUARDIAN · ELS-REMOTE-TAB-RELAY · ELN-OP-SELF-HEAL-LOOP · LAND-RECEIPT-RAW-RETENTION
// after the CEO (19:1x–19:3x) made MK the docs-P0 owner.
// Per seed (ctx.seed … ctx.seed+4): MK is ALWAYS the longest-idle seat (the incident's shape), UX and 2–3 TC hands idle in a
// seeded order; the board has infra P0 cells with no area (1–3, seeded), one docs P0 (MK's id namespace), one surface cell
// (UX — by path or by id, seeded) and one off-area cell for MK that names a non-MK path. The REAL policy file
// (graphs/policies/seat-roles.yaml) through the REAL reader (kit/seat-area) drives every REAL consumer:
//   planner   planNextActions (rule b) → pull hints: infra → a TC hand · docs → MK · surface → UX · each «area match: …»
//   table     buildMatchingTable (the resource steward's RO rows) → the same pairs
//   door      seatAssign → infra to MK refused `off-area` (no owner write, no mail) · docs to MK assigned, the mail carries
//             «area match: cell DOCS-… ~ DOCS-*» · a human's --force passes and says so
//   pull      workNext as MK → the docs cell, never an infra one · as a TC hand → an infra cell
//   steward   the REAL hand-steward body under ctx.engine (legacy = agent.yaml v2 step order · graph = supervisorTick) →
//             hints infra → TC · docs → MK · surface → UX
//   control   the pre-policy board (legacySeatRoles) hands the top infra P0 to MK — the defect this guard removes.
// Expected seats come from how the world was built (rule 11: independent literals), never from product code.
import { join } from 'node:path';
import { legacySeatRoles, loadSeatRoles, seatRolesPath, seatTakesCell, type SeatRolesPolicy } from '../../../kit/seat-area/index.js';
import { loadCard } from '../../../loop-agent/card.js';
import { fileAgentMemory } from '../../../loop-agent/memory.js';
import { tickAgent, type AgentBody, type AgentPorts, type TickReport } from '../../../loop-agent/runtime.js';
import { cardFromCompiled, lintSupervisor, supervisorTick } from '../../../loop-agent/v3/supervisor.js';
import { createBody as handBody, type Cell, type Hand, type HandStewardDeps, type Hint } from '../../../loop-agent/bodies/hand-steward.js';
import { planNextActions, type NaCell, type NaHand, type NextActionState } from '../../../loops/op-next-action.js';
import type { ChecklistItem } from '../../../release-loop/checklist.js';
import { buildMatchingTable } from '../../../resource-opt/matching-table.js';
import type { HandPoolEntry } from '../../../seat/hand-pool.js';
import { seatAssign, type SeatAssignDeps } from '../../../seat/seat-assign.js';
import { workNext, type BoardCell } from '../../../steward/space/work-next.js';
import type { SimWorldEngine, SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

const T0 = Date.parse('2026-11-28T10:20:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });

/** mulberry32 — one reproducible stream per seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

type Want = 'TC' | 'MK' | 'UX' | 'not-MK';
interface WorldCell { readonly id: string; readonly title: string; readonly priority: 'P0' | 'P1'; readonly done: string; readonly want: Want; readonly ageMin: number }
interface World { readonly seats: Array<{ seat: string; idleMin: number }>; readonly cells: WorldCell[]; readonly tc: string[] }

function world(seed: number): World {
  const r = rng(seed);
  const tcN = 2 + Math.floor(r() * 2);
  const tc = Array.from({ length: tcN }, (_, i) => `TC-H-CX-${i + 2}`);
  // MK longest idle (the incident) · UX and the TC hands after it in a seeded order
  const rest = ['UX', ...tc].map((seat) => ({ seat, idleMin: 5 + Math.floor(r() * 30) }));
  const seats = [{ seat: 'MK', idleMin: 60 }, ...rest];
  const infraN = 1 + Math.floor(r() * 3);
  const infra: WorldCell[] = ['LAND-RECEIPT-RAW-RETENTION', 'RES-ABSORB-GUARDIAN', 'ELN-OP-SELF-HEAL-LOOP'].slice(0, infraN).map((id, i) => ({
    id: `${id}-S${seed}`, title: `infra P0 ${i}: receipts kept until land — no target path declared`, priority: 'P0' as const,
    done: `test universe receipt ${i} survives sweep`, want: 'TC' as const, ageMin: 400 - i })); // infra[0] = the oldest (top of the board)
  const docs: WorldCell = { id: `DOCS-USER-FIRST-S${seed}`, title: 'user-first docs on docs.elanous.ai', priority: 'P0', done: 'docs page live', want: 'MK', ageMin: 300 };
  const uxByPath = r() < 0.5;
  const ux: WorldCell = uxByPath
    ? { id: `SIDE-TAB-HANG-S${seed}`, title: '대상 경로: src/els/side-tab.ts — a tab never hangs on attach', priority: 'P0', done: 'attach 3/3 in the test universe', want: 'UX', ageMin: 200 }
    : { id: `PWA-REACHABLE-S${seed}`, title: 'PWA reachable on a narrow screen', priority: 'P0', done: 'narrow screenshot shows the composer', want: 'UX', ageMin: 200 };
  // names a path outside MK's areas: never MK (a TC hand or UX may take it)
  const offMk: WorldCell = { id: `LAND-GRAPH-TICK-S${seed}`, title: '대상 경로: src/land-graph/land-graph.ts — one tick per land', priority: 'P1', done: 'tick test green', want: 'not-MK', ageMin: 100 };
  return { seats, cells: [...infra, docs, ux, offMk], tc };
}

const fits = (w: World, cell: WorldCell, seat: string): boolean =>
  cell.want === 'TC' ? w.tc.includes(seat) : cell.want === 'not-MK' ? seat !== 'MK' : seat === cell.want;

const item = (c: WorldCell): ChecklistItem => ({ id: c.id, title: c.title, status: 'yellow', priority: c.priority, doneCriterion: c.done, updatedAt: iso(T0 - c.ageMin * 60_000), updatedBy: 'OP' } as ChecklistItem);

// ── planner (rule b) ─────────────────────────────────────────────────────────────────────────────────────────────
function planner(w: World, policy: SeatRolesPolicy): Map<string, { seat: string; evidence: string }> {
  const hands: NaHand[] = w.seats.map((s) => ({ seat: s.seat, home: 'OP', state: 'idle', since: T0 - s.idleMin * 60_000 }));
  const cells: NaCell[] = w.cells.map((c) => ({ id: c.id, title: c.title, status: 'yellow', priority: c.priority, doneCriterion: c.done, updatedAt: iso(T0 - c.ageMin * 60_000) }));
  const state: NextActionState = { now: iso(T0), version: '0.3.39', released: '0.3.38', cells, hands, directives: [], handRaises: [],
    land: { readyToLand: 0, landedLastHour: 3, mode: 'live' }, releases: [], bulletin: { ageMin: 5 },
    seatFit: (seat, cell) => { const f = seatTakesCell(seat, cell, policy); return f.ok ? f : { ok: false, reason: f.reason }; } };
  const out = new Map<string, { seat: string; evidence: string }>();
  for (const a of planNextActions(state).actions) if (a.do === 'pull' && a.target?.cell && a.target.seat) out.set(a.target.cell, { seat: a.target.seat, evidence: a.evidence });
  return out;
}

// ── seatAssign door ──────────────────────────────────────────────────────────────────────────────────────────────
function door(w: World, policy: SeatRolesPolicy) {
  const board = new Map(w.cells.map((c) => [c.id, item(c)] as const));
  const mails: Array<{ to: string; body: string }> = [];
  const owners: Array<{ cell: string; seat: string }> = [];
  const pool = (): HandPoolEntry[] => w.seats.map((s) => ({ seat: s.seat, home: 'OP', state: 'idle', lent: false, closeCandidate: false, since: T0 - s.idleMin * 60_000 }));
  const deps: SeatAssignDeps = {
    now: () => new Date(T0), coordinators: () => ({ hq: 'OP', spaces: [] }), federationSeats: () => new Set(['OP', ...w.seats.map((s) => s.seat)]),
    findCell: (id) => { const i = board.get(id); return i ? { version: '0.3.39', item: i } : undefined; },
    writers: () => [], assign: (_v, id, seat) => { owners.push({ cell: id, seat }); const i = board.get(id)!; board.set(id, { ...i, owner: seat }); return { from: null, outcome: 'assigned' }; },
    post: (m) => { mails.push({ to: m.to, body: m.body }); return { id: 700 + mails.length }; }, wake: async () => ({ result: 'injected' }),
    pool: () => ({ hosts: ['sim-host'], scope: 'sim', source: 'code-default' }), handPool: () => pool(), targetVersion: () => '0.3.39',
    seatFit: (seat, it) => seatTakesCell(seat, it, policy),
  };
  return { deps, mails, owners };
}

// ── workNext ───────────────────────────────────────────────────────────────────────────────────────────────────────
function pull(w: World, seat: string, policy: SeatRolesPolicy): string | null {
  const cells = new Map(w.cells.map((c) => [c.id, { id: c.id, title: c.title, status: 'yellow', priority: c.priority, doneCriterion: c.done, updatedAt: iso(T0 - c.ageMin * 60_000) } as BoardCell & { owner?: string }]));
  const r = workNext(seat, { now: () => T0, version: '0.3.39', cells: () => [...cells.values()], scopeOf: () => 'OP', lastActiveMs: () => undefined,
    isCoordinator: (s) => s === 'OP', isJudge: () => false, seatFit: (s, c) => seatTakesCell(s, c, policy),
    swap: (id, input) => { const c = cells.get(id); if (!c) return { outcome: 'missing' }; if ((c.owner ?? null) !== input.expectedOwner) return { outcome: 'lost' }; cells.set(id, { ...c, owner: input.to }); return { outcome: 'swapped' }; } });
  return r.code === 0 ? r.cell.id : null;
}

// ── hand-steward body under the engine ─────────────────────────────────────────────────────────────────────────────
async function tick(engine: SimWorldEngine, body: AgentBody, p: AgentPorts, t: Date): Promise<TickReport> {
  const card = loadCard('hand-steward');
  if (engine === 'graph') return (await supervisorTick(card, body, p, t)).report;
  const c = lintSupervisor('hand-steward').compiled;
  if (!c) throw new Error('hand-steward agent.yaml refused');
  return tickAgent(cardFromCompiled(card, c), body, p, t, { policies: c.policies });
}
/** The three cells of the incident (agent.yaml max_per_tick 3 — one tick acts on all of them). */
async function steward(engine: SimWorldEngine, root: string, w: World, board: readonly WorldCell[], policy: SeatRolesPolicy): Promise<Record<string, Hint>> {
  const hands: Hand[] = w.seats.map((s) => ({ seat: s.seat, state: 'idle', since: T0 - s.idleMin * 60_000 }));
  const cells: Cell[] = board.map((c) => ({ id: c.id, title: c.title, status: 'yellow', priority: c.priority, paths: [] }));
  const hints: Record<string, Hint> = {};
  const deps: HandStewardDeps = {
    readHands: () => hands, readCells: () => ({ version: '0.3.39', cells }), readHints: () => ({ ...hints }),
    hint: (cell, seat) => { hints[cell] = { seat, until: iso(T0 + 45 * 60_000) }; }, unhint: (cell) => { if (!hints[cell]) return false; delete hints[cell]; return true; },
    modelFor: () => ({ line: 'model: easy', tier: 'easy' }), post: (_k, _to, _b) => 900, wake: () => 'wake typed',
    seatFit: (seat, cell) => { const f = seatTakesCell(seat, cell, policy); return f.ok ? f : { ok: false, reason: f.reason }; },
  };
  const p: AgentPorts = { memory: fileAgentMemory(root, 'hand-steward', 'sim'), post: () => 901, beat: () => undefined, llm: null };
  await tick(engine, handBody({ stateRoot: root } as Parameters<typeof handBody>[0], deps), p, new Date(T0));
  return hints;
}

async function run(ctx: SimWorldScenarioContext): Promise<SimWorldScenarioOutcome> {
  const policy = loadSeatRoles(seatRolesPath());
  const rows: Array<Record<string, unknown>> = [];
  for (let k = 0; k < 5; k++) {
    const seed = (ctx.seed + k) >>> 0;
    const w = world(seed);
    const infra = w.cells.filter((c) => c.want === 'TC');
    const docs = w.cells.find((c) => c.want === 'MK')!;
    const ux = w.cells.find((c) => c.want === 'UX')!;
    // planner
    const plan = planner(w, policy);
    for (const c of w.cells) {
      const got = plan.get(c.id);
      if (got && !fits(w, c, got.seat)) return fail('planner-off-area', `seed ${seed}: ${c.id} (${c.want}) hinted to ${got.seat}`);
      if (got && !got.evidence.includes('area match: ')) return fail('planner-no-area-line', `seed ${seed}: ${c.id} evidence «${got.evidence}»`);
    }
    if (plan.get(docs.id)?.seat !== 'MK') return fail('planner-docs-not-mk', `seed ${seed}: ${docs.id} → ${plan.get(docs.id)?.seat ?? 'none'}`);
    if (plan.get(ux.id)?.seat !== 'UX') return fail('planner-ux-not-ux', `seed ${seed}: ${ux.id} → ${plan.get(ux.id)?.seat ?? 'none'}`);
    if (!w.tc.includes(plan.get(infra[0]!.id)?.seat ?? '')) return fail('planner-infra-not-tc', `seed ${seed}: ${infra[0]!.id} → ${plan.get(infra[0]!.id)?.seat ?? 'none'}`);
    // matching table (resource steward rows)
    const table = buildMatchingTable({ now: T0, version: '0.3.39', hqSeat: 'OP', panes: w.seats.map((s) => ({ seat: s.seat, state: 'IDLE', since: T0 - s.idleMin * 60_000 })),
      cells: w.cells.map((c) => ({ id: c.id, title: c.title, status: 'yellow', priority: c.priority, updatedAt: iso(T0 - c.ageMin * 60_000) })), prs: [], greenLanes: [], judgeQueue: [],
      seatFit: (seat, id) => { const c = w.cells.find((x) => x.id === id); return c ? seatTakesCell(seat, item(c), policy) : { ok: true }; } });
    for (const row of table.rows) {
      if (row.kind !== 'assign') continue;
      const c = w.cells.find((x) => x.id === row.cell)!;
      if (!fits(w, c, row.seat)) return fail('table-off-area', `seed ${seed}: ${row.id} ${row.cell} (${c.want}) → ${row.seat}`);
    }
    const tableMk = table.rows.find((r) => r.kind === 'assign' && r.seat === 'MK');
    if (!tableMk || tableMk.kind !== 'assign' || tableMk.cell !== docs.id) return fail('table-mk-not-docs', `seed ${seed}: MK row ${JSON.stringify(tableMk ?? null)}`);
    // the door
    const d = door(w, policy);
    const refused = await seatAssign({ seat: 'MK', cellId: infra[0]!.id, actor: 'OP', caller: 'sim' }, d.deps);
    if (refused.ok || refused.code !== 'off-area') return fail('door-infra-to-mk', `seed ${seed}: ${JSON.stringify(refused).slice(0, 200)}`);
    if (d.owners.length || d.mails.length) return fail('door-refusal-wrote', `seed ${seed}: owners ${d.owners.length} · mails ${d.mails.length}`);
    const ok = await seatAssign({ seat: 'MK', cellId: docs.id, actor: 'OP', caller: 'sim' }, d.deps);
    if (!ok.ok) return fail('door-docs-refused', `seed ${seed}: ${ok.reason}`);
    if (!d.mails[0]?.body.includes(`area match: cell ${docs.id} ~ DOCS-*`)) return fail('door-mail-no-area', `seed ${seed}: ${d.mails[0]?.body.split('\n').slice(0, 6).join(' | ')}`);
    const forced = await seatAssign({ seat: 'MK', cellId: infra[0]!.id, actor: 'OP', caller: 'sim', force: true }, d.deps);
    if (!forced.ok || !d.mails[1]?.body.includes('area match: none — forced by OP')) return fail('door-force', `seed ${seed}: ${JSON.stringify(forced).slice(0, 160)}`);
    // pull
    const mkPull = pull(w, 'MK', policy);
    if (mkPull !== docs.id) return fail('pull-mk', `seed ${seed}: MK work next → ${mkPull}`);
    const tcPull = pull(w, w.tc[0]!, policy);
    if (!infra.some((c) => c.id === tcPull)) return fail('pull-tc', `seed ${seed}: ${w.tc[0]} work next → ${tcPull}`);
    // the hand-steward body under the engine
    const hints = await steward(ctx.engine, join(ctx.universeRoot, `s${seed}-${ctx.engine}`), w, [infra[0]!, docs, ux], policy);
    for (const [cell, h] of Object.entries(hints)) {
      const c = w.cells.find((x) => x.id === cell)!;
      if (!fits(w, c, h.seat)) return fail('steward-off-area', `seed ${seed} ${ctx.engine}: ${cell} (${c.want}) hinted to ${h.seat}`);
    }
    if (hints[docs.id]?.seat !== 'MK' || hints[ux.id]?.seat !== 'UX' || !w.tc.includes(hints[infra[0]!.id]?.seat ?? '')) {
      return fail('steward-pairs', `seed ${seed} ${ctx.engine}: ${JSON.stringify(hints)}`);
    }
    // control: the pre-policy board gives MK (longest idle) the top infra P0
    const before = planner(w, legacySeatRoles());
    if (before.get(infra[0]!.id)?.seat !== 'MK') return fail('control-not-reproduced', `seed ${seed}: pre-policy ${infra[0]!.id} → ${before.get(infra[0]!.id)?.seat ?? 'none'}`);
    rows.push({ seed, engine: ctx.engine, tc: w.tc.length, infra: infra.length, ux: ux.id, hinted: Object.keys(hints).length, tableAssign: table.rows.filter((r) => r.kind === 'assign').length });
  }
  ctx.recorder.event('seat-area-guard', { rows });
  return { ok: true };
}

export const simWorldScenarios: readonly SimWorldScenario[] = [{
  id: 'SUP-SEAT-AREA-GUARD',
  title: 'idle MK + infra P0 → a TC hand, never MK · docs P0 → MK · surface cell → UX — planner · matching table · seat assign door · work next · hand steward (seat-roles.yaml)',
  run,
}];
