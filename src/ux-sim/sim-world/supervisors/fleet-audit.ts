// SIM-WORLD supervisors · SUPERVISOR-AUDITOR-LOOP — the loop agent supervisor-auditor (an agent.yaml instance of the shared kind
// fleet-audit.observe) on the REAL path: supervisorTick over graphs/loop-agents/supervisor-auditor/agent.yaml ⊕ the real kit
// readers over agent homes written in this universe (state.json · last-tick.json · journal rows · lessons) ⊕ the real trigger
// registry (requestFire → a registry tick dispatches). Only the doors are fakes: mail (deduped by key like appendOnce) · the HQ
// bus line · telegram. Literal expectations (OPS-RULES 11) · LLM 0 · no ssh · fake agents and a fake host only.
//   SUP-AUDITOR-HEALTHY:    3 healthy agents → no heal action · KPI 0 · one ledger · one bus line per tick · ONE summary mail per hour
//   SUP-AUDITOR-STALE:      a tick 60 min old → ONE registry fire across ticks at +0/+15 (the registry dispatches it once) → at
//                           +60 still stale → one owner card «틱 정지»
//   SUP-AUDITOR-WATCH-ONLY: breach 130 min ∧ 0 acts (3 refusals) → ONE owner card to its L0 with the top refusal · a breaching
//                           agent that acts is not watch-only
//   SUP-AUDITOR-FALSE-GREEN: KPI ok with an errored tick / with 4 refusals and 0 acts → flagged «거짓 초록» · no card
//   SUP-AUDITOR-RED:        two watch-only agents for 3h → telegram ONCE ⊕ one OP red mail · owner card ⊕ ✋ once each · 4 hourly summaries
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadCard } from '../../../loop-agent/card.js';
import { agentHome, fileAgentMemory, emptyAgentState } from '../../../loop-agent/memory.js';
import { appendJournal, type JournalRow } from '../../../loop-agent/journal.js';
import type { AgentPorts } from '../../../loop-agent/runtime.js';
import { supervisorTick } from '../../../loop-agent/v3/supervisor.js';
import { createFleetAuditBody, type FleetAuditDeps } from '../../../loop-agent/v3/fleet-audit-kind.js';
import { readFleetReading, type FleetMember } from '../../../kit/fleet-audit/index.js';
import { listFires, openTriggerRegistry, readTriggerDecl, registerTrigger, requestFire, tickTriggers, type TriggerTickDeps } from '../../../loops/trigger-registry.js';
import type { ConditionProbes } from '../../../loops/trigger-conditions.js';
import type { SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

const REPO = resolve(import.meta.dir, '../../../..');
const AUDITOR = 'supervisor-auditor';
const T0 = Date.parse('2026-11-28T08:00:00Z');
const MIN = 60_000; // 출처: one minute in ms (scenario clock unit, not a bound)
const fail = (reason: string, diff: unknown): SimWorldScenarioOutcome => ({ ok: false, reason, diff: typeof diff === 'string' ? diff : JSON.stringify(diff) });
const at = (min: number) => new Date(T0 + min * MIN);

interface FakeAgent {
  readonly id: string; readonly l0: string; readonly tickAgoMin: number; readonly kpiOk: boolean | null;
  readonly breachAgoMin?: number; readonly tickError?: string; readonly lessons?: number;
  readonly journal?: ReadonlyArray<{ readonly status: JournalRow['status']; readonly what: string; readonly agoMin: number }>;
}

/** Write one fake agent's home exactly as the runtime does (fileAgentMemory.writeState · last-tick.json · appendJournal). */
function seedAgent(stateRoot: string, a: FakeAgent): void {
  const mem = fileAgentMemory(stateRoot, a.id, a.l0);
  const tickAt = at(-a.tickAgoMin).toISOString();
  mem.writeState({ ...emptyAgentState(), lastTickAt: tickAt, ticks: 40, lastKpi: a.kpiOk === null ? null : a.kpiOk ? 0 : 3, kpiOk: a.kpiOk,
    breachSince: a.breachAgoMin !== undefined ? at(-a.breachAgoMin).toISOString() : null, kpiHistory: [{ at: tickAt, v: a.kpiOk === null ? null : a.kpiOk ? 0 : 3 }] });
  writeFileSync(join(agentHome(stateRoot, a.id), 'last-tick.json'), JSON.stringify({ id: a.id, at: tickAt, kpi: a.kpiOk ? 0 : 3, kpiOk: a.kpiOk, ...(a.tickError ? { error: a.tickError } : {}) }));
  appendJournal(agentHome(stateRoot, a.id), (a.journal ?? []).map((j, i) => ({ v: 1 as const, at: at(-j.agoMin).toISOString(), agent: a.id, status: j.status, action: 'open-cell',
    target: `cell-${i}`, what: j.what, why: 'sim', before: null, after: null, evidence: [], undo: null, source: 'tick' as const, by: a.id.toUpperCase() })));
  if (a.lessons) mem.writeLessons(Array.from({ length: a.lessons }, (_, i) => ({ id: `L-${i + 1}`, at: tickAt, text: 'sim lesson', pattern: 'sim', from: a.id, status: 'active' as const, hits: 1, lastUsedAt: null })));
}

/** A fake agent ticked at minute `min` (its state's lastTickAt only — the runtime's own field). */
function touch(stateRoot: string, id: string, l0: string, min: number): void {
  const mem = fileAgentMemory(stateRoot, id, l0); mem.writeState({ ...mem.readState(), lastTickAt: at(min).toISOString() });
}

const quietProbes = (now: () => Date): ConditionProbes => ({
  now, watch: async () => null, mtimeMs: () => null, readJson: () => undefined, readLines: () => [],
  cells: async () => [], idleSeats: async () => [], landedCount: async () => 0, handsUpCount: async () => 0,
  publishedVersions: async () => [], installedVersion: async () => null,
});

/** One auditor world: the fake fleet ⊕ the real auditor card/agent.yaml ⊕ collecting doors. */
function world(ctx: SimWorldScenarioContext, agents: readonly FakeAgent[], triggers: Readonly<Record<string, string>> = {}) {
  const stateRoot = join(ctx.universeRoot, 'state'); mkdirSync(stateRoot, { recursive: true });
  for (const a of agents) seedAgent(stateRoot, a);
  const db = openTriggerRegistry(stateRoot);
  const mails: Array<{ key: string; to: string; body: string; kind: string }> = []; const keys = new Set<string>();
  const busLines: string[] = []; const busKeys = new Set<string>(); const tg: string[] = [];
  const members: FleetMember[] = agents.map(a => ({ id: a.id, l0: a.l0, trigger: triggers[a.id] ?? null, cadenceMin: 15 }));
  const post = (key: string, to: string, body: string, kind: string) => { if (keys.has(key)) return null; keys.add(key); mails.push({ key, to, body, kind }); return mails.length; };
  const deps: FleetAuditDeps = {
    members: () => members,
    reading: (m, now, windowMin) => readFleetReading(stateRoot, m, now, windowMin),
    refire: (trigger, reason, now) => { const r = requestFire(db, trigger, now, reason); return r ? { ok: true, line: `queued ${r.window}` } : { ok: false, line: 'refused' }; },
    post,
    bus: (key, body) => { if (busKeys.has(key)) return 'duplicate'; busKeys.add(key); busLines.push(body); return 'posted'; },
    notify: (line) => { tg.push(line); return true; },
  };
  const card = loadCard(AUDITOR);
  const body = createFleetAuditBody({ stateRoot, card }, deps);
  const ports: AgentPorts = { memory: fileAgentMemory(stateRoot, AUDITOR, card.supervisor), post: (k, to, b, kind = 'request') => post(k, to, b, kind), beat: () => {} };
  const tick = async (min: number) => (await supervisorTick(card, body, ports, at(min))).report;
  return { stateRoot, db, mails, busLines, tg, tick, home: agentHome(stateRoot, AUDITOR), close: () => db.close() };
}
const ours = (mails: ReadonlyArray<{ key: string }>, prefix: string) => mails.filter(m => m.key.startsWith(prefix)).map(m => m.key);
const heal = (acted: readonly string[]) => acted.filter(a => !a.startsWith('report:'));

async function healthy(ctx: SimWorldScenarioContext): Promise<SimWorldScenarioOutcome> {
  const w = world(ctx, [
    { id: 'sim-agent-a', l0: 'TC', tickAgoMin: 5, kpiOk: true, lessons: 1, journal: [{ status: 'acted', what: 'reaped', agoMin: 20 }] },
    { id: 'sim-agent-b', l0: 'OP', tickAgoMin: 10, kpiOk: true, journal: [{ status: 'acted', what: 'carded', agoMin: 30 }] },
    { id: 'sim-agent-c', l0: 'OP', tickAgoMin: 2, kpiOk: true },
  ]);
  try {
    const r1 = await w.tick(0); const r2 = await w.tick(15);
    const ledger = readFileSync(join(w.home, 'audit', 'latest.md'), 'utf8');
    const rows = ledger.split('\n').filter(l => l.startsWith('| sim-agent-'));
    const obs = { kpi: [r1.kpi, r2.kpi], heal: [...heal(r1.acted), ...heal(r2.acted)], acted: [r1.acted.length, r2.acted.length], summaries: ours(w.mails, 'fleet-audit:summary:'),
      cards: ours(w.mails, 'fleet-audit:owner-card:').length + ours(w.mails, 'fleet-audit:l0-hand:').length, bus: w.busLines.length, tg: w.tg.length, rows: rows.length, flagged: rows.filter(l => !l.endsWith('| 정상 |')).length };
    ctx.recorder.event('sup:auditor-healthy', obs);
    if (JSON.stringify(obs) !== JSON.stringify({ kpi: [0, 0], heal: [], acted: [1, 1], summaries: ['fleet-audit:summary:2026-11-28T08'], cards: 0, bus: 2, tg: 0, rows: 3, flagged: 0 })) return fail('healthy-acted', obs);
    return { ok: true };
  } finally { w.close(); }
}

async function stale(ctx: SimWorldScenarioContext): Promise<SimWorldScenarioOutcome> {
  const decl = readTriggerDecl(join('graphs', 'triggers', 'fed-analyst-agent.yaml'), REPO);
  const w = world(ctx, [
    { id: 'sim-agent-stale', l0: 'TC', tickAgoMin: 60, kpiOk: true },
    { id: 'sim-agent-ok', l0: 'OP', tickAgoMin: 3, kpiOk: true },
  ], { 'sim-agent-stale': decl.graphId });
  try {
    registerTrigger(w.db, decl, { now: at(-600) });
    const runs: string[] = []; let clock = T0;
    const deps: TriggerTickDeps = {
      now: () => new Date(clock), vars: { seatState: join(ctx.universeRoot, 'seat-state'), stateRoot: w.stateRoot }, probes: quietProbes(() => new Date(clock)),
      runGraph: async (_d, input, runId) => { if (String(input.reason ?? '').startsWith('fleet-audit:')) runs.push(String(input.reason).slice(0, 40)); return { status: 'done', runId }; },
      postCard: async () => 'card-0', scheduleAction: async () => {},
    };
    const r1 = await w.tick(0); clock = T0 + MIN; await tickTriggers(w.db, deps);
    const r2 = await w.tick(15); clock = T0 + 16 * MIN; await tickTriggers(w.db, deps);
    touch(w.stateRoot, 'sim-agent-ok', 'OP', 57); // the healthy neighbour keeps ticking; the stale one does not
    const r3 = await w.tick(60);
    const queued = listFires(w.db, decl.graphId, 20).filter(f => f.window === at(0).toISOString()).length;
    const cards = w.mails.filter(m => m.key.startsWith('fleet-audit:owner-card:'));
    const obs = { heal: [heal(r1.acted), heal(r2.acted), heal(r3.acted)], runs: runs.length, queued, cards: cards.map(c => `${c.to}:${c.body.includes('틱 정지') ? 'stale' : '?'}`), kpi: r1.kpi };
    ctx.recorder.event('sup:auditor-stale', obs);
    if (JSON.stringify(obs) !== JSON.stringify({ heal: [['refire:sim-agent-stale'], [], ['owner-card:sim-agent-stale']], runs: 1, queued: 1, cards: ['TC:stale'], kpi: 0 })) return fail('stale-refire', obs);
    return { ok: true };
  } finally { w.close(); }
}

const refusals = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ status: 'refused' as const, what: 'open-cell: 권한 밖 행동 — 허용: case', agoMin: from + i * 5 }));

async function watchOnly(ctx: SimWorldScenarioContext): Promise<SimWorldScenarioOutcome> {
  const w = world(ctx, [
    { id: 'sim-agent-watch', l0: 'TC', tickAgoMin: 4, kpiOk: false, breachAgoMin: 130, journal: [...refusals(3, 10), { status: 'failed', what: 'redeliver: store locked', agoMin: 40 }] },
    { id: 'sim-agent-busy', l0: 'UX', tickAgoMin: 4, kpiOk: false, breachAgoMin: 130, journal: [{ status: 'acted', what: 'nudged', agoMin: 12 }, { status: 'acted', what: 'nudged', agoMin: 27 }] },
  ]);
  try {
    const r1 = await w.tick(0); const r2 = await w.tick(15);
    const cards = w.mails.filter(m => m.key.startsWith('fleet-audit:owner-card:'));
    const obs = { kpi: [r1.kpi, r2.kpi], heal: [heal(r1.acted), heal(r2.acted)], cards: cards.map(c => c.to),
      reason: cards[0]?.body.includes('가장 많은 거절: open-cell: 권한 밖 행동 — 허용: case ×3') ?? false, busy: w.mails.some(m => m.key.includes('sim-agent-busy')) };
    ctx.recorder.event('sup:auditor-watch-only', obs);
    if (JSON.stringify(obs) !== JSON.stringify({ kpi: [1, 1], heal: [['owner-card:sim-agent-watch'], []], cards: ['TC'], reason: true, busy: false })) return fail('watch-only-card', obs);
    return { ok: true };
  } finally { w.close(); }
}

async function falseGreen(ctx: SimWorldScenarioContext): Promise<SimWorldScenarioOutcome> {
  const w = world(ctx, [
    { id: 'sim-agent-err', l0: 'OP', tickAgoMin: 6, kpiOk: true, tickError: 'observe error: ENOENT ledger' },
    { id: 'sim-agent-idle', l0: 'TC', tickAgoMin: 6, kpiOk: true, journal: refusals(4, 5) },
    { id: 'sim-agent-fine', l0: 'TC', tickAgoMin: 6, kpiOk: true, journal: [{ status: 'acted', what: 'ok', agoMin: 9 }] },
  ]);
  try {
    const r = await w.tick(0);
    const rows = readFileSync(join(w.home, 'audit', 'latest.md'), 'utf8').split('\n').filter(l => l.startsWith('| sim-agent-'));
    const flagged = rows.filter(l => l.endsWith('| 거짓 초록 |')).map(l => l.split(' | ')[0]!.slice(2));
    const obs = { kpi: r.kpi, flagged, heal: heal(r.acted), cards: ours(w.mails, 'fleet-audit:owner-card:').length, bus: w.busLines[0]?.includes('거짓 초록') ?? false };
    ctx.recorder.event('sup:auditor-false-green', obs);
    if (JSON.stringify(obs) !== JSON.stringify({ kpi: 0, flagged: ['sim-agent-err', 'sim-agent-idle'], heal: [], cards: 0, bus: true })) return fail('false-green-flag', obs);
    return { ok: true };
  } finally { w.close(); }
}

async function red(ctx: SimWorldScenarioContext): Promise<SimWorldScenarioOutcome> {
  const w = world(ctx, [
    { id: 'sim-agent-f', l0: 'TC', tickAgoMin: 3, kpiOk: false, breachAgoMin: 130, journal: refusals(2, 8) },
    { id: 'sim-agent-g', l0: 'TC', tickAgoMin: 3, kpiOk: false, breachAgoMin: 130 },
  ]);
  try {
    const tgAt: number[] = [];
    for (let m = 0; m <= 195; m += 15) {
      // the fake agents keep ticking (fresh tick) and keep breaching with no action — the watch-only world
      for (const id of ['sim-agent-f', 'sim-agent-g']) touch(w.stateRoot, id, 'TC', m - 3);
      const before = w.tg.length; await w.tick(m); if (w.tg.length > before) tgAt.push(m);
    }
    const n = (p: string) => ours(w.mails, p).length;
    const obs = { tgAt, tg: w.tg.length, red: n('fleet-audit:red:'), owner: ours(w.mails, 'fleet-audit:owner-card:').map(k => k.split(':')[2]), hand: ours(w.mails, 'fleet-audit:l0-hand:').map(k => k.split(':')[2]),
      handTo: w.mails.filter(m => m.key.startsWith('fleet-audit:l0-hand:')).map(m => m.to), summaries: n('fleet-audit:summary:') };
    ctx.recorder.event('sup:auditor-red', obs);
    const want = { tgAt: [180], tg: 1, red: 1, owner: ['sim-agent-f', 'sim-agent-g'], hand: ['sim-agent-f', 'sim-agent-g'], handTo: ['OP', 'OP'], summaries: 4 };
    if (JSON.stringify(obs) !== JSON.stringify(want)) return fail('red-notify', obs);
    return { ok: true };
  } finally { w.close(); }
}

export const simWorldScenarios: readonly SimWorldScenario[] = [
  { id: 'SUP-AUDITOR-HEALTHY', title: 'supervisor-auditor (fleet-audit kind): healthy fleet → no heal action · KPI 0 · ledger 3 rows · bus line per tick · one summary mail per hour', run: healthy },
  { id: 'SUP-AUDITOR-STALE', title: 'supervisor-auditor: a tick 60 min old → one registry request (dispatched once across two ticks) → still stale at +60 → one owner card «틱 정지»', run: stale },
  { id: 'SUP-AUDITOR-WATCH-ONLY', title: 'supervisor-auditor: KPI breach 130 min ∧ 0 acts → one owner card to its L0 with the top refusal · a breaching agent that acts is not carded', run: watchOnly },
  { id: 'SUP-AUDITOR-FALSE-GREEN', title: 'supervisor-auditor: KPI ok with an errored tick or with refusals only → «거짓 초록» in the ledger and the bus line · no card', run: falseGreen },
  { id: 'SUP-AUDITOR-RED', title: 'supervisor-auditor: two watch-only agents for 3h → telegram once ⊕ one OP red mail · owner card ⊕ ✋ once each · 4 hourly summaries', run: red },
];
