// SIM-WORLD supervisors · RETIRED-TRIGGER-FILTER (LOOP-AGENTS-AS-PLUGINS · 11-28 regression of #40634) — the 11-28 incident
// replayed on the REAL trigger registry (temp sqlite · the real absorb transaction) ⊕ the REAL run-doctor body ⊕ its REAL
// loop lane reader (liveLoopDeps · only retry/rail/post are ports) ⊕ the REAL kit/case-ledger and kit/heartbeat:
//   watchers-check's 02:10Z fire ended in exception · run-doctor opened a case at 02:14 · the agent shim then retired the
//   old graph (wake absorbs) · at 03:16 run-doctor carded OP «미정상화 사건 SLA 초과» on a loop that no longer exists.
//   SUP-LOOP-RETIRED (5 seeds):
//     R — a retired trigger with a past failure → no incident: its open case past SLA and its already escalated case are
//         both settled (resolved · «retired»), no card, no loop-exception subject, guardian «미정상화 사건» 0, its old beat
//         is no watcher (kit/heartbeat `retired`).
//     L — a live trigger failure next to it → the incident as before: case past SLA → ONE card to the owner → escalated.
// Expectations are independent literals (rule 11).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openTriggerRegistry, readTriggerDecl, registerTrigger, retiredTriggerIds } from '../../../loops/trigger-registry.js';
import { loadCard } from '../../../loop-agent/card.js';
import { fileAgentMemory } from '../../../loop-agent/memory.js';
import { tickAgent, type AgentPorts } from '../../../loop-agent/runtime.js';
import { createBody, type RunDoctorDeps } from '../../../loop-agent/bodies/run-doctor.js';
import { liveLoopDeps, type LoopExceptionDeps } from '../../../loop-agent/bodies/loop-exceptions.js';
import { moveCase, openCase, readCases, unnormalizedCases } from '../../../kit/case-ledger/index.js';
import { judgeWatchers, type Beat } from '../../../kit/heartbeat/index.js';
import type { SimWorldScenario, SimWorldScenarioOutcome } from '../types.js';

const REPO = resolve(import.meta.dir, '../../../..');
const MIN = 60_000; // 출처: #40574 — 1 minute in ms (the scenario clock unit, not a bound)
const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
/** The retired graph as it shipped before wave-1 (graphs/triggers/watchers-check.yaml · literal) — and a live loop beside it. */
const OLD = (id: string, cron: string) => `graph_id: ${id}
version: 1
loop:
  title: ${id}
  managed_by: trigger-registry
  owner: OP
  trigger: { cron: '${cron}' }
  goal: { kind: file-mtime, path: '{stateRoot}/watchers/alerts.json' }
  failure: { goal_deadline_min: 4, max_attempts: 2, backoff_sec: [60] }
entry_node: check
terminal_nodes: [done, failed]
nodes:
  - { node_id: check, kind: agent, recipe: 'cmd:trigger-watchers-check', max_visits: 1 }
  - { node_id: done, kind: gate, max_visits: 1 }
  - { node_id: failed, kind: gate, max_visits: 1 }
edges:
  - { from: check, on: outcome, map: { ok: done, fail: failed, error: failed } }
`;

/** One fire that ended in `exception` (the registry's own state machine is tested in trigger-registry tests). */
function exceptionFire(root: string, graphId: string, window: string, runId: string, at: string): void {
  const db = openTriggerRegistry(root);
  try {
    db.query(`INSERT INTO graph_trigger_fires (graph_id, window, stage, status, attempt, run_id, dispatched_at, error, updated_at)
      VALUES (?, ?, 'live', 'exception', 2, ?, ?, ?, ?)`).run(graphId, window, runId, window, 'goal not met after 2 attempts', at);
  } finally { db.close(); }
}

async function scene(universeRoot: string, seed: number) {
  const T = Date.parse('2026-11-28T02:10:00Z');
  const root = join(universeRoot, `lr-${seed}`);
  mkdirSync(join(root, 'graphs', 'triggers'), { recursive: true });
  writeFileSync(join(root, 'graphs', 'triggers', 'watchers-check.yaml'), OLD('watchers-check', '*/5 * * * *'));
  writeFileSync(join(root, 'graphs', 'triggers', 'release-traffic.yaml'), OLD('release-traffic', '*/10 * * * *'));
  const state = join(root, 'state');
  const db = openTriggerRegistry(state);
  try {
    for (const f of ['watchers-check.yaml', 'release-traffic.yaml']) registerTrigger(db, readTriggerDecl(`graphs/triggers/${f}`, root), { now: new Date(T - 60 * MIN) });
  } finally { db.close(); }
  // both loops' last fire ended in exception (the retired one at 02:10Z · the live one at 02:20Z)
  exceptionFire(state, 'watchers-check', '2026-11-28T02:10:00.000Z', 'run-wc', new Date(T + 2 * MIN).toISOString());
  exceptionFire(state, 'watchers-check', '2026-11-28T02:05:00.000Z', 'run-wc0', new Date(T - 3 * MIN).toISOString());
  exceptionFire(state, 'release-traffic', '2026-11-28T02:20:00.000Z', 'run-rt', new Date(T + 12 * MIN).toISOString());
  // the cases run-doctor already raised (the 11-28 ledger): watchers-check 02:10 detected → escalated (#203915) ·
  // watchers-check 02:05 detected (still open) · release-traffic 02:20 detected (still open)
  const by = 'RUN-DOCTOR';
  const open = (id: string, graph: string, atMin: number) => openCase(state, { domain: 'loop-exception', id, subject: `${graph} 예외`, owner: 'OP', slaMin: 60, by, why: 'last fire exception' }, new Date(T + atMin * MIN));
  open('loop:watchers-check@2026-11-28T02:10:00.000Z', 'watchers-check', 4);
  moveCase(state, 'loop-exception', 'loop:watchers-check@2026-11-28T02:10:00.000Z', 'escalated', { by, why: 'escalated to OP #203915 — out of policy or SLA · no-reason' }, new Date(T + 66 * MIN));
  open('loop:watchers-check@2026-11-28T02:05:00.000Z', 'watchers-check', 4);
  open('loop:release-traffic@2026-11-28T02:20:00.000Z', 'release-traffic', 4 + seed % 3);
  // the agent shim registers with wake absorbs → the registry retires the old graph in the same transaction
  const reg = openTriggerRegistry(state);
  let retired: string[]; let retiredSet: ReadonlySet<string>;
  try {
    retired = registerTrigger(reg, readTriggerDecl('graphs/triggers/watchers-check-agent.yaml', REPO), { now: new Date(T + 70 * MIN) }).retired;
    retiredSet = retiredTriggerIds(reg);
  } finally { reg.close(); }
  // run-doctor ticks on the real loop reader (ports: no retry spawn · no rail · posts recorded)
  const posts: Array<{ key: string; to: string }> = []; const retries: string[] = [];
  const live = liveLoopDeps(state, (key, to) => { if (posts.some(p => p.key === key)) return null; posts.push({ key, to }); return 203_900 + posts.length; });
  const loops: LoopExceptionDeps = { ...live, railAt: () => null, retry: (g, w) => { retries.push(`${g}@${w}`); return { ok: true, line: 're-armed' }; } };
  const deps: RunDoctorDeps = { redGates: () => [], greens: () => new Map(), failedRuns: () => [], hosts: () => [], inflight: () => false,
    diagnoses: () => [], writeDiagnosis: () => {}, recordRunVisit: () => {}, retries: () => [], retry: () => ({ ok: false, line: '' }), recordRetry: () => {}, loops };
  const card = loadCard('run-doctor');
  const ports: AgentPorts = { memory: fileAgentMemory(state, card.id, card.supervisor), post: () => null, beat: () => {}, speak: () => {}, llm: null };
  const now = new Date(T + (74 + seed) * MIN);
  const r = await tickAgent(card, createBody({ stateRoot: state, card }, deps), ports, now);
  const cases = Object.fromEntries(readCases(state, 'loop-exception').map(c => [c.id, c.history.map(h => h.state).join('>')]));
  const settledWhy = readCases(state, 'loop-exception').find(c => c.id === 'loop:watchers-check@2026-11-28T02:05:00.000Z')?.history.at(-1)?.why ?? null;
  // the retired checker's old beat is no watcher (kit/heartbeat · the guardian pulse and watchers-check read it this way)
  const at = (m: number) => new Date(now.getTime() - m * MIN).toISOString();
  const beats: Beat[] = [{ name: 'watchers-check', at: at(60 + seed), saw: 4, everyMin: 5 }, { name: 'loop:watchers-check', at: at(1), saw: 1, everyMin: 5 }];
  const watchers = judgeWatchers(beats, now, () => null, { retired: retiredSet }).map(v => `${v.name}:${v.status}`);
  const watchersBlind = judgeWatchers(beats, now).map(v => `${v.name}:${v.status}`);
  return { retired, cases, settledWhy, posts: posts.map(p => `${p.to}:${p.key}`), retries, acted: r.acted, unnormalized: unnormalizedCases(state, now), watchers, watchersBlind };
}

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'SUP-LOOP-RETIRED',
    title: 'run-doctor on the real registry: a retired (absorbed) trigger with a past failure raises no incident — its open and escalated cases are settled, no card, its old beat is no watcher · a live trigger failure next to it is carded as before',
    async run(ctx) {
      for (const seed of [ctx.seed, ctx.seed + 1, ctx.seed + 2, ctx.seed + 3, ctx.seed + 4]) {
        const o = await scene(ctx.universeRoot, seed);
        ctx.recorder.event('sup:loop-retired', { seed, ...o, unnormalized: o.unnormalized?.open ?? null });
        if (JSON.stringify(o.retired) !== '["watchers-check"]') return fail('absorb', `seed ${seed}: retired ${JSON.stringify(o.retired)}`);
        // R — the retired trigger: both cases settled, never carded
        if (o.cases['loop:watchers-check@2026-11-28T02:10:00.000Z'] !== 'detected>escalated>resolved') return fail('R-escalated-case', `seed ${seed}: ${JSON.stringify(o.cases)}`);
        if (o.cases['loop:watchers-check@2026-11-28T02:05:00.000Z'] !== 'detected>resolved') return fail('R-open-case', `seed ${seed}: ${JSON.stringify(o.cases)}`);
        if (o.settledWhy !== 'retired: the trigger is retired in the registry (absorbed) — no loop to normalize · its job lives in the absorber') return fail('R-why', `seed ${seed}: ${String(o.settledWhy)}`);
        if (o.acted.some(a => a.includes('watchers-check'))) return fail('R-acted', `seed ${seed}: ${JSON.stringify(o.acted)}`);
        if (JSON.stringify(o.watchers) !== '["loop:watchers-check:OK"]') return fail('R-beat', `seed ${seed}: ${JSON.stringify(o.watchers)}`);
        if (JSON.stringify(o.watchersBlind) !== '["loop:watchers-check:OK","watchers-check:DEAD"]') return fail('R-beat-control', `seed ${seed}: ${JSON.stringify(o.watchersBlind)}`);
        // L — the live trigger: past SLA → one card to OP → escalated (the incident as before)
        if (JSON.stringify(o.posts) !== '["OP:loop-exception:release-traffic:2026-11-28T02:20:00.000Z"]') return fail('L-card', `seed ${seed}: ${JSON.stringify(o.posts)}`);
        if (o.cases['loop:release-traffic@2026-11-28T02:20:00.000Z'] !== 'detected>escalated') return fail('L-case', `seed ${seed}: ${JSON.stringify(o.cases)}`);
        if (o.retries.length) return fail('L-retry', `seed ${seed}: ${JSON.stringify(o.retries)}`);
        if (o.unnormalized?.open !== 1 || JSON.stringify(o.unnormalized.ids) !== '["loop:release-traffic@2026-11-28T02:20:00.000Z"]') return fail('guardian-kpi', `seed ${seed}: ${JSON.stringify(o.unnormalized)}`);
      }
      return { ok: true };
    },
  },
];
