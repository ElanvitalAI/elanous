/**
 * LOOP-AUDIT-APPLY (대표 11-26 · seat-state/OP/evidence/20261126/loop-audit.md «keep 5 · merge 4 → 2 · retire 1»).
 * A graph that took over another declares `loop.absorbs: [id]`; registering it retires the absorbed trigger (never ticked,
 * not counted under «↻ loops (N)»). SIM: a scratch registry seeded with the 11-26 live rows (12 triggers, old owners
 * REL/RES) is re-registered from the real graphs/triggers/*.yaml; the merged release-traffic (⊕ res-reservation) and
 * res-burst-lease (⊕ res-ready-pool) graphs are walked on a virtual clock. Seeds ≥ 3; expectations are literals (rule 11).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { parse as parseYaml } from 'yaml';
import { listFires, listTriggers, openTriggerRegistry, readTriggerDecl, registerTrigger, tickTriggers, type TriggerDecl, type TriggerTickDeps } from './trigger-registry.js';
import type { ConditionProbes } from './trigger-conditions.js';
import { liveFacts } from './trigger-facts.js';
import { loopsBySeat, planLoopTabs, type LoopAgent } from '../els/loop-agents.js';
import { DEFAULT_ORG } from '../org/org-map.js';
import { runTrafficNode } from '../res-graphs/release-traffic.js';
import { runNode, type NodeDeps } from '../res-graphs/res-nodes.js';
import { loadReservation, markReady } from '../res-graphs/burst.js';

const REPO = join(import.meta.dir, '..', '..');
const SEEDS = [1, 2, 3];
let dir: string; let db: Database; let clock: Date;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'loop-audit-apply-'));
  mkdirSync(join(dir, 'seat'), { recursive: true });
  db = openTriggerRegistry(join(dir, 'state'));
  clock = new Date('2026-11-26T10:00:00Z');
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

const seat = () => join(dir, 'seat'); const state = () => join(dir, 'state'); const resRoot = () => join(seat(), 'RES', 'graph-state');
const probes = (): ConditionProbes => ({ now: () => clock, watch: async () => null, mtimeMs: () => null, readJson: () => undefined, readLines: () => [],
  cells: async () => [], idleSeats: async () => [], landedCount: async () => 0, handsUpCount: async () => 0, publishedVersions: async () => [], installedVersion: async () => null });

function old(graphId: string, owner: string, extra: Partial<TriggerDecl> = {}): TriggerDecl {
  return { graphId, file: `graphs/triggers/${graphId}.yaml`, owner, cron: '0 * * * *', goal: { kind: 'file-mtime', path: `{stateRoot}/${graphId}` },
    goalDeadlineMin: 20, maxAttempts: 2, backoffSec: [60], cutoverAfter: 1, staleAfterMin: 30, ...extra };
}
/** The 12 rows of the live registry on 11-26 11:3x (owners as they were: REL / RES before the absorb). */
const LIVE_1126: Array<[string, string]> = [['op-retro', 'OP'], ['op-bulletin', 'OP'], ['op-idle-triage', 'OP'], ['release-rocket', 'OP'], ['res-burst-lease', 'RES'],
  ['res-reservation', 'RES'], ['res-ready-pool', 'RES'], ['op-pulse', 'OP'], ['board-steward', 'OP'], ['space-advisor-tc', 'TC'], ['release-traffic', 'REL'], ['land-graph', 'TC']];
const agents = (): LoopAgent[] => listTriggers(db).map(r => ({ id: r.graphId, owner: r.owner, stage: r.stage, lastStatus: r.lastStatus, lastAt: r.lastAt }));

describe('absorbs: registering the absorber retires the absorbed trigger', () => {
  test('retire once, idempotent, the retired trigger is never ticked', async () => {
    registerTrigger(db, old('t-old', 'OP'));
    const first = registerTrigger(db, old('t-new', 'OP', { absorbs: ['t-old'] }));
    expect(first.retired).toEqual(['t-old']);
    expect(registerTrigger(db, old('t-new', 'OP', { absorbs: ['t-old'] })).retired).toEqual([]);
    expect(listTriggers(db).find(r => r.graphId === 't-old')!.stage).toBe('retired');
    const ran: string[] = [];
    const deps: TriggerTickDeps = { now: () => new Date('2026-11-26T10:00:30Z'), vars: { seatState: seat(), stateRoot: state() }, probes: probes(),
      runGraph: async (d, _i, runId) => { ran.push(d.graphId); return { status: 'done', runId }; }, postCard: async () => 'c', scheduleAction: async () => {} };
    await tickTriggers(db, deps);
    expect(ran).toEqual(['t-new']);
    expect(listFires(db, 't-old')).toHaveLength(0);
  });

  test('an absorb of a graph not registered (yet) is a no-op, not an error', () => {
    expect(registerTrigger(db, old('t-new', 'OP', { absorbs: ['never-registered'] })).retired).toEqual([]);
  });

  test('a bad absorbs list is refused at read time', () => {
    const self = join(dir, 'self.yaml');
    writeFileSync(self, 'graph_id: me\nloop:\n  owner: OP\n  absorbs: [me]\n  trigger: { cron: "0 * * * *" }\n  goal: { kind: file-mtime, path: x }\n');
    expect(() => readTriggerDecl(self, dir)).toThrow('loop.absorbs must be a list of other graph ids');
    const scalar = join(dir, 'scalar.yaml');
    writeFileSync(scalar, 'graph_id: me\nloop:\n  owner: OP\n  absorbs: op-retro\n  trigger: { cron: "0 * * * *" }\n  goal: { kind: file-mtime, path: x }\n');
    expect(() => readTriggerDecl(scalar, dir)).toThrow('loop.absorbs must be a list of other graph ids');
  });
});

describe('the audit verdict on the real declarations', () => {
  const files = readdirSync(join(REPO, 'graphs', 'triggers')).filter(f => /\.ya?ml$/.test(f) && f !== 'recipes.yaml' && !f.endsWith('.rhythm.yaml')).sort();

  test('declarations: retro/idle-triage/reservation/ready-pool yaml gone, absorbers declare them, owners per org (landing TC · REL/RES → OP)', () => {
    expect(files.filter(f => ['op-retro.yaml', 'op-idle-triage.yaml', 'res-reservation.yaml', 'res-ready-pool.yaml'].includes(f))).toEqual([]);
    const decls = Object.fromEntries(files.map(f => { const d = readTriggerDecl(join('graphs', 'triggers', f), REPO); return [d.graphId, d]; }));
    expect(decls['op-pulse']!.absorbs).toEqual(['op-retro']);
    expect(decls['board-steward']!.absorbs).toEqual(['op-idle-triage']);
    expect(decls['release-traffic']!.absorbs).toEqual(['res-reservation']);
    expect(decls['res-burst-lease']!.absorbs).toEqual(['res-ready-pool']);
    expect(decls['land-graph']!.owner).toBe('TC');
    expect(Object.values(decls).filter(d => d.owner === 'REL' || d.owner === 'RES').map(d => d.graphId)).toEqual([]);
  });

  test('re-registering over the 11-26 live registry: 4 retired, OP space «↻ loops (N)» shrinks and the stale list tab is replaced', () => {
    for (const [id, owner] of LIVE_1126) registerTrigger(db, old(id, owner), { now: clock });
    const before = loopsBySeat(agents(), DEFAULT_ORG.duties);
    // REL / RES duties default to REL / RES seats → their loops sit in their own spaces before the absorb
    expect((before.get('OP') ?? []).map(a => a.id).sort()).toEqual(['board-steward', 'op-bulletin', 'op-idle-triage', 'op-pulse', 'op-retro', 'release-rocket']);
    for (const f of files) registerTrigger(db, readTriggerDecl(join('graphs', 'triggers', f), REPO), { update: true, now: clock });
    const stages = Object.fromEntries(listTriggers(db).map(r => [r.graphId, r.stage]));
    expect(['op-retro', 'op-idle-triage', 'res-reservation', 'res-ready-pool'].map(id => stages[id])).toEqual(['retired', 'retired', 'retired', 'retired']);
    const after = loopsBySeat(agents(), DEFAULT_ORG.duties);
    // SUPERVISOR-REVIVE-1127: the v2 supervisors' triggers (<id>-agent) sit with their owners (process L0 RES → OP owner);
    // world-sweep (WORLD-REGISTRY · the guardian's ledger sweep · failure cards → OP) sits with OP too · so do cond-watch-sweep ·
    // fed-analyst-agent · steward-mail (landed after this expectation was written — main was red here before JUDGE-BUTLER-V3-LISTED) · and supervisor-auditor-agent (SUPERVISOR-AUDITOR-LOOP · L0 escalation-parent → OP) · and dev-review-post-impl (DEV-REVIEW-COMMON · first-pregate post-impl review) · and decision-bus (DECISION-TO-BUS-AUTO · CEO decisions → HQ bus pointers) · and gh-mirror (GH-PROXY-LAYER #40729 · landed without this list — main was red here) · and rail-canary-agent (RAIL-CANARY-AUTO-ROLLBACK · L0 escalation-parent → OP).
    expect((after.get('OP') ?? []).map(a => a.id).sort()).toEqual(['autopsy-agent', 'board-steward', 'cond-watch-sweep', 'decision-bus', 'dev-review-post-impl', 'fed-analyst-agent', 'gh-mirror', 'guardian', 'hand-steward-agent', 'macrophage-agent', 'op-bulletin', 'op-pulse', 'rail-canary-agent', 'release-rocket', 'release-rocket-agent', 'release-traffic', 'res-burst-lease', 'silence-watch-agent', 'steward-mail', 'supervisor-auditor-agent', 'watchers-check-agent', 'world-sweep']);
    // JUDGE-BUTLER-V3-LISTED: the butler's trigger owner is its L0 (agent.yaml wake.owner JUD) → its row sits in JUD's space
    expect((after.get('JUD') ?? []).map(a => a.id).sort()).toEqual(['judge-butler']);
    expect((after.get('TC') ?? []).map(a => a.id).sort()).toEqual(['land-graph', 'rail-watch', 'run-doctor-agent', 'run-supervisor-agent', 'space-advisor-tc', 'train-manager-agent']);
    expect(after.has('RES')).toBe(false);
    expect(after.has('REL')).toBe(false);
    const plan = planLoopTabs(after, [{ tab: 't1', title: '↻ loops (6)', workspace: 'OP' }, { tab: 't2', title: '↻ loops (2)', workspace: 'TC' }, { tab: 't3', title: '↻ loops (3)', workspace: 'RES' }]);
    // rail-watch (JUD-RELAX post-rail safety net) joins TC → its «↻ loops (2)» tab becomes (3).
    expect(plan).toEqual({ open: [{ ws: 'OP', count: 22 }, { ws: 'JUD', count: 1 }, { ws: 'TC', count: 6 }], close: [{ tab: 't1', id: 'loops' }, { tab: 't2', id: 'loops' }, { tab: 't3', id: 'loops' }] });
  });
});

// ── release-traffic ⊕ res-reservation: one graph, tick then reserve ─────────────────────────────────────────────────
describe.each(SEEDS)('SIM release-traffic absorbs res-reservation · seed %i', (seed) => {
  const V = '0.3.40';
  const shift = (iso: string) => new Date(Date.parse(iso) + seed * 7 * 60_000);
  const graph = parseYaml(readFileSync(join(REPO, 'graphs', 'triggers', 'release-traffic.yaml'), 'utf8')) as { entry_node: string; nodes: { node_id: string; recipe?: string }[]; edges: { from: string; map: Record<string, string> }[] };
  let config: Record<string, number>; let releaseState: Record<string, unknown>; let walked: string[];
  const flush = () => {
    mkdirSync(join(state(), 'release-graph', V), { recursive: true });
    writeFileSync(join(state(), 'release-graph', V, 'state.json'), JSON.stringify(releaseState));
    mkdirSync(resRoot(), { recursive: true }); writeFileSync(join(resRoot(), 'leases.json'), JSON.stringify([{ host: 'aws1', state: 'active', endsAt: '2026-11-27T12:00:00Z' }]));
  };
  const deps = (): TriggerTickDeps => ({
    now: () => clock, probes: probes(), vars: { seatState: seat(), stateRoot: state() }, postCard: async () => 'c', scheduleAction: async () => {},
    runGraph: async (_d, input, runId) => {
      // Walk the REAL yaml edges: tick → reserve → done.
      let node = graph.entry_node;
      for (let i = 0; i < 5 && node !== 'done' && node !== 'failed'; i++) {
        const recipe = graph.nodes.find(n => n.node_id === node)!.recipe!;
        const ctx = { graphId: 'release-traffic', runId, input: { window: input.window, stage: 'live', vars: { stateRoot: state(), seatState: seat() } } };
        const out = recipe === 'cmd:release-traffic-tick'
          ? runTrafficNode(ctx, { getSlots: h => config[h] ?? null, setSlots: (h, n) => { config[h] = n; return true; }, hostUp: () => true, requestCapacity: () => 'ok', updateAll: () => true,
            card: () => {}, owner: () => 'OP', root: resRoot(), live: true, now: () => clock, facts: () => liveFacts(state(), seat(), clock) })
          : runNode('reservation-sync', ctx, { now: () => clock } as NodeDeps);
        walked.push(`${node}=${String(out.outcome)}`);
        node = graph.edges.find(e => e.from === node)!.map[String(out.outcome)] ?? 'failed';
      }
      return node === 'done' ? { status: 'done', runId } : { status: 'failed', runId, error: `ended at ${node}` };
    },
  });
  const at = async (iso: string) => { clock = shift(iso); flush(); await tickTriggers(db, deps()); };

  beforeEach(() => {
    config = { 'node-b': 5, 'aws1': 2 }; walked = [];
    releaseState = { version: V, clock: { rehearsalAt: shift('2026-11-25T15:00:00Z').toISOString(), cutAt: shift('2026-11-25T19:00:00Z').toISOString(), publishAt: shift('2026-11-25T21:00:00Z').toISOString() }, steps: {} };
    flush();
    registerTrigger(db, readTriggerDecl(join('graphs', 'triggers', 'release-traffic.yaml'), REPO), { now: shift('2026-11-25T10:00:00Z') });
  });

  test('reservation follows the release clock (pre-cut reserve · publish + 45m lift) inside the release-traffic graph', async () => {
    await at('2026-11-25T12:00:00Z');
    expect(loadReservation(resRoot())?.active ?? false).toBe(false);
    for (const t of ['2026-11-25T17:01:00Z', '2026-11-25T18:00:00Z', '2026-11-25T19:05:00Z', '2026-11-25T20:30:00Z']) await at(t);
    expect(loadReservation(resRoot())).toMatchObject({ active: true, host: 'node-b', nonReleaseSlots: 1, version: V });
    (releaseState.steps as Record<string, unknown>).publish = { status: 'done', actualAt: shift('2026-11-25T21:01:00Z').toISOString() };
    for (const t of ['2026-11-25T21:05:00Z', '2026-11-25T21:31:00Z', '2026-11-25T21:46:00Z', '2026-11-25T22:30:00Z']) await at(t);
    expect(loadReservation(resRoot())).toMatchObject({ active: false, nonReleaseSlots: 0 });
    expect(config['node-b']).toBe(5);
    expect(walked.every(step => step.endsWith('=ok'))).toBe(true);
    expect(walked.filter(step => step.startsWith('reserve=')).length).toBe(walked.filter(step => step.startsWith('tick=')).length);
    const fires = listFires(db, 'release-traffic', 100);
    expect(fires.every(f => f.status !== 'exception')).toBe(true);
    expect(fires.length).toBeLessThanOrEqual(7);
  });
});

// ── res-burst-lease ⊕ res-ready-pool: no lease due → the pool chain makes one stale host ready ─────────────────────────
describe.each(SEEDS)('SIM res-burst-lease absorbs res-ready-pool · seed %i', (seed) => {
  const graph = parseYaml(readFileSync(join(REPO, 'graphs', 'triggers', 'res-burst-lease.yaml'), 'utf8')) as { entry_node: string; nodes: { node_id: string; recipe?: string }[]; edges: { from: string; map: Record<string, string> }[] };
  const recipes = parseYaml(readFileSync(join(REPO, 'graphs', 'triggers', 'recipes.yaml'), 'utf8')) as Record<string, { command: string }>;
  const nodeCmd = (recipe: string) => recipes[recipe.replace(/^cmd:/, '')]!.command.split('res-nodes.ts" ')[1]!;
  let calls: string[];
  const walk = (runId: string, failStep: string | null): string[] => {
    const deps: NodeDeps = { now: () => clock, actuate: (step, host) => { calls.push(`${step}:${host}`); return step === failStep ? { status: 1, stdout: '', stderr: 'sim fail' } : { status: 0, stdout: '{"ok":true}\n', stderr: '' }; } };
    const path: string[] = []; let node = graph.entry_node;
    for (let i = 0; i < 30 && node !== 'done' && node !== 'failed'; i++) {
      const out = runNode(nodeCmd(graph.nodes.find(n => n.node_id === node)!.recipe!), { graphId: 'res-burst-lease', runId, input: { window: `w-${runId}`, stage: 'live', vars: { seatState: seat(), stateRoot: state() } }, nodeInput: {} }, deps);
      path.push(node); node = graph.edges.find(e => e.from === node)!.map[String(out.outcome)] ?? 'failed';
    }
    return [...path, node];
  };
  beforeEach(() => { calls = []; mkdirSync(resRoot(), { recursive: true }); });

  test('stale host → pool chain → ready → stopped; next run: nothing stale → mark only', () => {
    const hosts = ['aws1', 'aws2', 'gcp1', 'gcp2', 'gcp3'];
    // seed decides which hosts are already fresh; the rest are never verified
    for (const h of hosts.slice(0, seed)) markReady(resRoot(), h, 'ready', 'sim', clock);
    const path = walk(`p${seed}`, null);
    expect(path).toEqual(['route', 'pool_pick', 'pool_start', 'pool_sanitize', 'pool_catchup', 'pool_auth', 'pool_smoke', 'pool_ready', 'stop', 'mark', 'done']);
    expect(calls[0]).toMatch(/^start:/);
    expect(calls.at(-1)).toMatch(/^stop:/);
  });

  test('a failing ready step marks the host failed and the run ends failed (no silent done)', () => {
    const failing = ['step:catchup', 'catchup', 'sanitize', 'auth'][seed % 4]!;
    const path = walk(`f${seed}`, failing);
    expect(path.at(-1)).toBe('failed');
    expect(path).toContain('fail');
  });
});
