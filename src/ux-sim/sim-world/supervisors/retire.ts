// SIM-WORLD supervisors · LOOP-AGENTS-AS-PLUGINS wave-1 «remove first» — the retired watchers-check trigger graph:
//   SUP-RETIRE-ABSORB: the old 5-min graph is live in a registry; registering the agent's shim retires it in the same
//                      transaction (top-level absorbs · kind trigger) · re-registering retires nothing twice · a tick at the old cron window
//                      runs nothing (no double fire for one job) · the shipped trigger dir holds one trigger for the job.
//   SUP-RETIRE-BEAT:   the keeper (watchers-check loop agent) carries the retired job: a DEAD supervisor beat is counted and
//                      named for the trigger registry (it refires · LOOP-AGENTS-AS-PLUGINS P1 — the keeper wakes nobody), the
//                      retired checker's own stale beat is history (no subject).
//   SUP-ROLE-KEPT:     FEDERATION-ORG §4 «역할 은퇴 0» — the two retired shadow watchers' roles live on as absorbs rows of the keepers
//                      (KPI · L0) and their event is caught there: an OP request nobody judged → silence-watch rings OP · a
//                      stalled seat next to an unowned ready P0 → hand-steward assigns it.
//   SUP-RETIRE-FAULTS: failure paths of the absorb — a garbled `absorbs` refuses the registration loudly · an absorb of a
//                      graph this install never had retires nothing · the keeper's agent.yaml asking for executor @4 is refused.
// Literal expectations (OPS-RULES 11); real registry (temp sqlite) · real shell (tickAgent) · fake beats.
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { listTriggers, openTriggerRegistry, readTriggerDecl, registerTrigger, tickTriggers } from '../../../loops/trigger-registry.js';
import { loadCard } from '../../../loop-agent/card.js';
import { fileAgentMemory } from '../../../loop-agent/memory.js';
import { tickAgent, type AgentPorts } from '../../../loop-agent/runtime.js';
import { lintAgentDir } from '../../../loop-agent/v3/agent-yaml.js';
import { createBody as silenceBody, type SilenceDeps } from '../../../loop-agent/bodies/silence-watch.js';
import { createBody as handStewardBody } from '../../../loop-agent/bodies/hand-steward.js';
import { HS_NOW, hsWorld } from './flow.js';
import { parse } from 'yaml';
import { createBody, type WatchersCheckDeps } from '../../../loop-agent/bodies/watchers-check.js';
import type { Beat } from '../../../kit/heartbeat/index.js';
import type { SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

const REPO = resolve(import.meta.dir, '../../../..');
const T0 = Date.parse('2026-11-28T00:00:00Z');
const MIN = 60_000;
const fail = (reason: string, diff: unknown): SimWorldScenarioOutcome => ({ ok: false, reason, diff: JSON.stringify(diff) });
/** The retired graph as it shipped before wave-1 (graphs/triggers/watchers-check.yaml · literal). */
const OLD = `graph_id: watchers-check
version: 1
loop:
  title: Watch the watchers
  managed_by: trigger-registry
  owner: OP
  trigger: { cron: '*/5 * * * *' }
  goal: { kind: file-mtime, path: '{stateRoot}/watchers/alerts.json' }
  failure: { goal_deadline_min: 4, max_attempts: 2, backoff_sec: [60] }
  cutover_after: 2
entry_node: check
terminal_nodes: [done, failed]
nodes:
  - { node_id: check, kind: agent, recipe: 'cmd:trigger-watchers-check', max_visits: 1 }
  - { node_id: done, kind: gate, max_visits: 1 }
  - { node_id: failed, kind: gate, max_visits: 1 }
edges:
  - { from: check, on: outcome, map: { ok: done, fail: failed, error: failed } }
`;

async function absorb(ctx: SimWorldScenarioContext): Promise<SimWorldScenarioOutcome> {
  const root = mkdtempSync(join(tmpdir(), `la-absorb-${ctx.seed}-`));
  mkdirSync(join(root, 'graphs', 'triggers'), { recursive: true });
  writeFileSync(join(root, 'graphs', 'triggers', 'watchers-check.yaml'), OLD);
  const db = openTriggerRegistry(join(root, 'state'));
  try {
    const now = new Date(T0 + Math.floor(ctx.random() * 50) * MIN);
    const old = registerTrigger(db, readTriggerDecl('graphs/triggers/watchers-check.yaml', root), { now });
    const agent = registerTrigger(db, readTriggerDecl('graphs/triggers/watchers-check-agent.yaml', REPO), { now });
    const again = registerTrigger(db, readTriggerDecl('graphs/triggers/watchers-check-agent.yaml', REPO), { now, update: true });
    const stages = Object.fromEntries(listTriggers(db).map(r => [r.graphId, r.stage]));
    ctx.recorder.event('absorb', { seed: ctx.seed, oldCreated: old.created, retired: agent.retired, again: again.retired, stages });
    if (!old.created || old.row.stage !== 'live') return fail('old-not-live', old.row);
    if (JSON.stringify(agent.retired) !== '["watchers-check"]') return fail('not-absorbed', agent.retired);
    if (again.retired.length !== 0) return fail('retired-twice', again.retired);
    if (stages['watchers-check'] !== 'retired' || stages['watchers-check-agent'] !== 'live') return fail('stages', stages);
    // trigger double fire: at the old cron window nothing runs for the retired graph
    const runs: string[] = [];
    const window = new Date(Date.UTC(2026, 10, 28, 1, 5 * (1 + Math.floor(ctx.random() * 10))));
    const events = await tickTriggers(db, { now: () => window, runGraph: async d => { runs.push(d.graphId); return { status: 'done', runId: `r-${runs.length}` }; },
      postCard: async () => 'card-0', scheduleAction: async () => {}, vars: { seatState: join(root, 'seat-state'), stateRoot: join(root, 'state') } }, { only: 'watchers-check' });
    ctx.recorder.event('old-window', { window: window.toISOString(), runs, events: events.length });
    if (runs.length !== 0) return fail('double-fire', runs);
    // the shipped trigger dir: one trigger for the job (the agent shim) — the old graph file is gone
    const shipped = readdirSync(join(REPO, 'graphs', 'triggers')).filter(f => f.startsWith('watchers-check'));
    if (JSON.stringify(shipped) !== '["watchers-check-agent.yaml"]') return fail('shipped-two', shipped);
    return { ok: true };
  } finally { db.close(); }
}

async function beat(ctx: SimWorldScenarioContext): Promise<SimWorldScenarioOutcome> {
  const root = mkdtempSync(join(tmpdir(), `la-beat-${ctx.seed}-`));
  const card = loadCard('watchers-check');
  const memory = fileAgentMemory(root, card.id, card.supervisor);
  const posts: string[] = [];
  const ports: AgentPorts = { memory, post(key, to, body) { posts.push(`${to}:${key}:${body.slice(0, 40)}`); return posts.length; }, beat: () => {}, speak: () => {}, llm: null };
  const deadAge = 60 + Math.floor(ctx.random() * 60);
  const at = (m: number) => new Date(T0 - m * MIN).toISOString();
  const beats: Beat[] = [
    { name: 'trigger-tick', at: at(1), saw: 1, everyMin: 2 }, { name: 'res-patrol', at: at(1), saw: 1, everyMin: 5 }, { name: 'release-graph-tick', at: at(1), saw: 1, everyMin: 2 },
    { name: 'loop:silence-watch', at: at(deadAge), saw: 1, everyMin: 10 },
    { name: 'watchers-check', at: at(deadAge), saw: 4, everyMin: 5 }, // the retired checker's last beat
  ];
  const deps: WatchersCheckDeps = {
    beats: () => beats.slice(), sourceHead: () => null, cardIds: () => ['silence-watch'],
    triggerIds: () => new Set(['watchers-check-agent', 'silence-watch-agent']), retiredIds: () => new Set(['watchers-check']),
  };
  const r = await tickAgent(card, createBody({ stateRoot: root, card }, deps), ports, new Date(T0));
  ctx.recorder.event('keeper-tick', { seed: ctx.seed, deadAge, kpi: r.kpi, acted: r.acted });
  if (r.kpi !== 1) return fail('kpi', { kpi: r.kpi, expect: 1 });
  if (r.acted.length !== 0) return fail('keeper-woke', r.acted);
  return { ok: true };
}

async function faults(ctx: SimWorldScenarioContext): Promise<SimWorldScenarioOutcome> {
  const root = mkdtempSync(join(tmpdir(), `la-faults-${ctx.seed}-`));
  const tree = join(root, 'graphs');
  cpSync(join(REPO, 'graphs', 'triggers'), join(tree, 'triggers'), { recursive: true });
  cpSync(join(REPO, 'graphs', 'loop-agents', 'watchers-check'), join(tree, 'loop-agents', 'watchers-check'), { recursive: true });
  const agentYaml = join(tree, 'loop-agents', 'watchers-check', 'agent.yaml');
  const original = readFileSync(agentYaml, 'utf8');
  const out: Record<string, string> = {};
  // (a) garbled absorbs → the registry refuses the declaration (never a silent half-registration)
  const block = /absorbs:.*\n  - \{ id: watchers-check, kind: trigger[^\n]*\n/u;
  if (!block.test(original)) return fail('absorbs-block', 'watchers-check agent.yaml has no absorbs trigger row');
  writeFileSync(agentYaml, original.replace(block, 'absorbs: watchers-check\n'));
  try { readTriggerDecl('graphs/triggers/watchers-check-agent.yaml', root); out.garbled = 'accepted'; } catch (e) { out.garbled = e instanceof Error ? e.message : String(e); }
  // (b) absorb of a graph this install never registered → nothing retired, the agent registers live
  writeFileSync(agentYaml, original.replace(block, `absorbs:\n  - { id: never-here-${ctx.seed}, kind: trigger }\n`));
  const db = openTriggerRegistry(join(root, 'state'));
  try {
    const r = registerTrigger(db, readTriggerDecl('graphs/triggers/watchers-check-agent.yaml', root), { now: new Date(T0) });
    out.unknown = `${r.row.stage} retired=${r.retired.length}`;
  } finally { db.close(); }
  // (c) executor version mismatch → lint refuses loudly (the install runs loop-agent@3)
  writeFileSync(agentYaml, original.replace('executor: loop-agent@3', 'executor: loop-agent@4'));
  const lint = lintAgentDir(join(tree, 'loop-agents', 'watchers-check'));
  out.executor = lint.ok ? 'ok' : lint.errors.find(e => e.includes('executor')) ?? lint.errors.join(' · ');
  ctx.recorder.event('faults', { seed: ctx.seed, ...out });
  if (out.garbled !== 'trigger watchers-check-agent: loop.absorbs must be a list of other graph ids') return fail('garbled-absorbs', out.garbled);
  if (out.unknown !== 'live retired=0') return fail('unknown-absorb', out.unknown);
  if (!out.executor.startsWith('requires executor loop-agent@4 — this install runs loop-agent@3')) return fail('executor', out.executor);
  return { ok: true };
}

async function roleKept(ctx: SimWorldScenarioContext): Promise<SimWorldScenarioOutcome> {
  // ① the roles are declared on the keepers (relation key absorbs · KPI · L0 = the keeper's supervisor) — role rows only:
  //    `kind: script` rows (YAML-OPS-SCRIPTS-ABSORB · retired ops scripts) and `kind: trigger` rows are other relations
  const rows = (id: string) => ((parse(readFileSync(join(REPO, 'graphs', 'loop-agents', id, 'agent.yaml'), 'utf8')) as { absorbs?: Array<Record<string, string>> }).absorbs ?? [])
    .filter(r => r.kind === 'role').map(r => `${r.id}:${r.kind}:${r.kpi}:${r.l0}`);
  const decl = { silence: rows('silence-watch'), hand: rows('hand-steward') };
  if (JSON.stringify(decl.silence) !== '["op-mail-coverage-watch:role:unanswered_mail_past_sla:supervisor","supervision-silence-watch:role:unanswered_mail_past_sla:supervisor"]') return fail('silence-absorbs', decl.silence);
  if (JSON.stringify(decl.hand) !== '["seat-stall-watch:role:idle_hands_with_ready_cells:supervisor"]') return fail('hand-absorbs', decl.hand);
  const port = (root: string, id: string): AgentPorts => ({ memory: fileAgentMemory(root, id, 'OP'), post: () => 1, beat: () => {}, speak: () => {}, llm: null });
  // ② op-mail-coverage's event: a request to OP past the SLA that nobody judged → rung once · KPI 1
  const age = 40 + Math.floor(ctx.random() * 60);
  const rung: string[] = [];
  const deps: SilenceDeps = { overdue: () => [{ id: 9001, from: 'TC', to: 'OP', ageMin: age, summary: '판단 요청' }], readers: (_n, a) => new Map(a.map(x => [x, true])),
    stalled: () => [], ring: (to, id) => { rung.push(`${to}:${id}`); return true; }, post: () => 1 };
  const rootA = mkdtempSync(join(tmpdir(), `la-role-a-${ctx.seed}-`));
  const sc = loadCard('silence-watch');
  const ra = await tickAgent(sc, silenceBody({ stateRoot: rootA, card: sc }, deps), port(rootA, 'silence-watch'), new Date(T0));
  // ③ seat-stall's event: a seat idle 40 min next to an unowned ready P0 → assigned (pull hint)
  const w = hsWorld({});
  const rootB = mkdtempSync(join(tmpdir(), `la-role-b-${ctx.seed}-`));
  const hc = loadCard('hand-steward');
  const rb = await tickAgent(hc, handStewardBody({ stateRoot: rootB, card: hc }, w.deps), port(rootB, 'hand-steward'), new Date(HS_NOW));
  ctx.recorder.event('role-kept', { seed: ctx.seed, decl, silence: { kpi: ra.kpi, acted: ra.acted, rung }, hand: { kpi: rb.kpi, acted: rb.acted } });
  if (ra.kpi !== 1 || JSON.stringify(rung) !== '["OP:9001"]') return fail('op-mail-coverage-role', { kpi: ra.kpi, rung });
  if (!rb.acted.includes('assign:ELS-SIM-12@UX-H7')) return fail('seat-stall-role', rb.acted);
  return { ok: true };
}

export const simWorldScenarios: readonly SimWorldScenario[] = [
  { id: 'SUP-RETIRE-ABSORB', title: 'wave-1: the agent shim absorbs the old watchers-check graph — retired in the registration · no second retire · no fire at the old window · one shipped trigger', run: absorb },
  { id: 'SUP-ROLE-KEPT', title: 'wave-1 «역할 은퇴 0»: op-mail-coverage · seat-stall roles are absorbs rows of silence-watch · hand-steward (KPI · L0) and their events are caught there', run: roleKept },
  { id: 'SUP-RETIRE-FAULTS', title: 'wave-1 failure paths: garbled absorbs refuses the registration · an unknown absorb retires nothing · executor @4 is refused by lint', run: faults },
  { id: 'SUP-RETIRE-BEAT', title: 'wave-1: the keeper carries the retired job — a DEAD supervisor counted (KPI 1 · the registry refires it, the keeper wakes nobody) · the retired checker\'s stale beat is no subject', run: beat },
];
