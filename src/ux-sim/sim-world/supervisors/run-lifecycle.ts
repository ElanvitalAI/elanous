// SIM-WORLD supervisors · run lifecycle (detect → diagnose → autopsy) — 대표 11-27 11:5x «감독자 일을 시뮬월드에서».
// Each scenario drives one LOOP-AGENT v2 body (src/loop-agent/bodies/{run-supervisor,run-doctor,autopsy}.ts) through
// its real card and runtime with fake deps (no network · no real processes · no Math.random), injects the subject
// events, ticks, and checks four things with INDEPENDENT LITERALS (rule 11): it woke (live · tick case), it produced the
// right reversible action, the KPI line was recorded, and it escalated to its L0 only on the out-of-policy path.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadCard } from '../../../loop-agent/card.js';
import { fileAgentMemory, type AgentMemory } from '../../../loop-agent/memory.js';
import { tickAgent, type AgentBody, type AgentPorts, type TickReport } from '../../../loop-agent/runtime.js';
import { createBody as createRunSupervisor, type KilledPregate, type OpenRun, type PregateJob, type RunSupervisorDeps } from '../../../loop-agent/bodies/run-supervisor.js';
import { createBody as createRunDoctor, type DiagnosisRow, type RedGate, type RetryRow, type RunDoctorDeps } from '../../../loop-agent/bodies/run-doctor.js';
import { createBody as createAutopsy, type AutopsyDeps, type AutopsyRow, type CellRow, type Death } from '../../../loop-agent/bodies/autopsy.js';
import type { SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

/** The simulated TA run's graph (a fixture name in the sim universe, not a product identity). */
const SIM_TA_GRAPH = 'sim-ta-run';
const T0 = Date.parse('2026-11-27T10:00:00Z');
const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });

interface Rig { readonly memory: AgentMemory; readonly ports: AgentPorts; readonly posts: Array<{ key: string; to: string }>; readonly beats: string[] }
function rig(stateRoot: string, id: string, supervisor: string): Rig {
  mkdirSync(stateRoot, { recursive: true });
  const memory = fileAgentMemory(stateRoot, id, supervisor);
  const posts: Array<{ key: string; to: string }> = []; const beats: string[] = [];
  const ports: AgentPorts = {
    memory,
    post(key, to) { if (posts.some(p => p.key === key)) return null; posts.push({ key, to }); return posts.length; },
    beat(b) { beats.push(b.name); },
    speak() { /* channel voice is not under test here */ },
    llm: null,
  };
  return { memory, ports, posts, beats };
}

/** The four checks shared by every scenario (expected values are literals passed by the caller). */
function check(r: Rig, report: TickReport, expect: { acted: readonly string[]; kpiText: string; l0: string }): string | null {
  if (report.level !== 'live') return `woke: level ${report.level} (want live)`;
  const tick = r.memory.cases(200).filter(c => c.kind === 'tick').at(-1);
  if (!tick) return 'woke: no tick case';
  for (const a of expect.acted) if (!report.acted.includes(a)) return `acted: ${JSON.stringify(report.acted)} lacks ${a}`;
  if (!tick.why.includes(expect.kpiText)) return `kpi line: «${tick.why}» lacks «${expect.kpiText}»`;
  if (r.posts.some(p => p.to === expect.l0)) return `escalation on the in-policy path: ${JSON.stringify(r.posts)}`;
  return null;
}
/** Out-of-policy path: tick until escalate_after_min passed; exactly one `kpi-breach:` post to the literal L0. */
async function breachPath(card: ReturnType<typeof loadCard>, body: AgentBody, r: Rig, stepMin: number, ticks: number, l0: string): Promise<string | null> {
  let t = T0;
  for (let i = 0; i < ticks; i++) { await tickAgent(card, body, r.ports, new Date(t)); t += stepMin * 60_000; }
  const cards = r.posts.filter(p => p.key.startsWith('kpi-breach:'));
  if (cards.length !== 1) return `kpi-breach posts ${cards.length} (want 1): ${JSON.stringify(cards)}`;
  if (cards[0]!.to !== l0) return `kpi-breach to ${cards[0]!.to} (want ${l0})`;
  return null;
}
const seedsOf = (ctx: SimWorldScenarioContext): number[] => [ctx.seed, ctx.seed + 1, ctx.seed + 2];

// ── run-supervisor world ────────────────────────────────────────────────────────────────────────────────────────────
function supervisorWorld(seed: number, opts: { pidReused?: boolean; noRuns?: boolean; unkillable?: boolean }): RunSupervisorDeps & { closed: string[]; kills: number[] } {
  const jobs = new Map<string, PregateJob & { pr: number }>();
  jobs.set('aaaabbbbcccc-full', { id: 'aaaabbbbcccc-full', pid: 4242, host: 'minim5', ageMin: 95, alive: true, pr: 40300 });
  for (let i = 0; i < seed % 3; i++) jobs.set(`young${i}000000-light`, { id: `young${i}000000-light`, pid: 5000 + i, host: 'node-b', ageMin: 5, alive: true, pr: 40310 + i }); // seed noise, never a zombie
  const runs = new Map<string, OpenRun>();
  if (!opts.noRuns) runs.set('run-ta-stalled-1', { runId: 'run-ta-stalled-1', graphId: SIM_TA_GRAPH, startedAt: '2026-11-27T06:00:00Z', lastAt: '2026-11-27T07:30:00Z', idleMin: 150, stage: 'implement' });
  const killed: KilledPregate[] = []; const closed: string[] = []; const kills: number[] = [];
  return {
    closed, kills,
    pregateJobs: () => [...jobs.values()],
    openRuns: () => [...runs.values()],
    proc: pid => {
      const j = [...jobs.values()].find(x => x.pid === pid);
      if (!j) return null;
      return opts.pidReused ? { cmd: '/usr/sbin/unrelated-daemon --serve', elapsedSec: j.ageMin * 60 }
        : { cmd: `/opt/homebrew/bin/python3 /hq/RES/tools/pregate.py ${j.pr} --host ${j.host} --focused src/a.test.ts ${j.id.split('-')[0]}`, elapsedSec: j.ageMin * 60 };
    },
    kill: pid => { if (opts.unkillable) return false; const j = [...jobs.values()].find(x => x.pid === pid); if (!j) return false; kills.push(pid); jobs.delete(j.id); return true; },
    closeRecord: id => { if (!jobs.has(id)) return { ok: false, line: `${id} gone` }; jobs.delete(id); closed.push(id); return { ok: true, line: `${id} closed`, undo: 'mv back' }; },
    closeRun: runId => { runs.delete(runId); return { ok: true, line: `${runId} stop` }; },
    relaunch: () => ({ ok: true, pid: 9001, line: 'relaunched' }),
    killed: () => killed.map(k => ({ ...k })),
    recordKilled: k => { killed.push(k); },
    markRelaunched: () => { /* not reached in one tick */ },
  };
}

// ── run-doctor world ────────────────────────────────────────────────────────────────────────────────────────────────
function doctorWorld(seed: number, opts: { contentOnly?: boolean }): RunDoctorDeps & { spawnedHosts: string[] } {
  const red = (pr: number, h: string, host: string, exit: number): RedGate => ({ id: `${pr}-${h}-${host}`, pr, head: `${h}${'0'.repeat(28)}`, host, at: T0 - 120 * 60_000,
    stage: 'changed-tsc', exit, failure: 'changed-tsc_RED', mode: 'light', focused: ['src/a.test.ts'] });
  const reds = opts.contentOnly ? [red(40402, 'dddddddddddd', 'node-b', 1), red(40403, 'eeeeeeeeeeee', 'minim5', 1)]
    : [red(40400, 'aaaaaaaaaaaa', 'minim5', 124), red(40401, 'bbbbbbbbbbbb', 'node-b', 1)];
  const greens = new Map<number, number>([[39000 + seed, T0 - 600_000]]); // seed noise: an unrelated PR already green
  const diag: DiagnosisRow[] = []; const retries: RetryRow[] = []; const spawnedHosts: string[] = [];
  let clock = T0;
  return {
    spawnedHosts,
    redGates: () => reds.map(g => ({ ...g })),
    greens: () => new Map(greens),
    failedRuns: () => [],
    hosts: () => ['node-b', 'minim5'],
    inflight: () => false,
    diagnoses: () => diag.map(d => ({ ...d })),
    writeDiagnosis: row => { diag.push(row); },
    recordRunVisit: () => {},
    retries: () => retries.map(x => ({ ...x })),
    retry: (g, host) => { spawnedHosts.push(host); clock += 60_000; if (g.pr !== null) greens.set(g.pr, clock); return { ok: true, pid: 8001, line: `pregate ${g.pr} --host ${host}` }; },
    recordRetry: row => { retries.push(row); },
  };
}

// ── autopsy world ───────────────────────────────────────────────────────────────────────────────────────────────────
function autopsyWorld(seed: number, opts: { noEvidence?: boolean }): AutopsyDeps & { rowsOut: AutopsyRow[] } {
  const at = (min: number): string => new Date(T0 - min * 60_000).toISOString();
  const deaths: Death[] = opts.noEvidence
    ? [{ id: 'pr:40510', kind: 'pr-closed', ref: 'pr:40510', at: at(30), cls: null, text: 'wip' }]
    : [
      { id: 'land:40500:cccccccccccc:tsc', kind: 'land-refused', ref: 'pr:40500', at: at(90 + seed % 5), cls: 'tsc', text: '' },
      { id: 'pr:40501', kind: 'pr-closed', ref: 'pr:40501', at: at(60), cls: null, text: 'feat: x\nsuperseded by → #40502' },
      { id: 'run:run-dead-1', kind: 'run-died', ref: 'run:run-dead-1', at: at(20), cls: 'pod-died', text: '' },
    ];
  const rowsOut: AutopsyRow[] = []; const cells: CellRow[] = [];
  return {
    rowsOut,
    deaths: () => ({ deaths: deaths.map(d => ({ ...d })), unknown: [] }),
    rows: () => rowsOut.map(r => ({ ...r })),
    record: rs => { rowsOut.push(...rs); },
    cells: () => cells.map(c => ({ ...c })),
    openCell: cellId => ({ ok: true, line: `칸 ${cellId} 추가` }),
    recordCell: c => { cells.push(c); },
  };
}

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'SUP-RUN-SUPERVISOR',
    title: 'run-supervisor: a stalled TA run and a 95-minute pregate → stop line + exact-PID end · a record whose pid was reused is closed (no kill · no card · never retried) · an unkillable zombie cards TC once',
    async run(ctx) {
      for (const seed of seedsOf(ctx)) {
        const card = loadCard('run-supervisor');
        const r = rig(join(ctx.universeRoot, `s${seed}`), 'run-supervisor', 'TC');
        const body = createRunSupervisor({ stateRoot: join(ctx.universeRoot, `s${seed}`), card }, supervisorWorld(seed, {}));
        const report = await tickAgent(card, body, r.ports, new Date(T0));
        const bad = check(r, report, { acted: ['close-zombie-run:run:run-ta-stalled-1', 'end-zombie-pregate:pregate:aaaabbbbcccc-full'], kpiText: 'zombie_runs 2 ', l0: 'TC' });
        ctx.recorder.event('sup:run-supervisor', { seed, path: 'in-policy', acted: report.acted, kpi: report.kpi, posts: r.posts.length });
        if (bad) return fail('in-policy', `seed ${seed}: ${bad}`);
        const card2 = loadCard('run-supervisor');
        const r2 = rig(join(ctx.universeRoot, `s${seed}-breach`), 'run-supervisor', 'TC');
        const body2 = createRunSupervisor({ stateRoot: join(ctx.universeRoot, `s${seed}-breach`), card: card2 }, supervisorWorld(seed, { unkillable: true, noRuns: true }));
        const bad2 = await breachPath(card2, body2, r2, 21, 5, 'TC');
        ctx.recorder.event('sup:run-supervisor', { seed, path: 'out-of-policy', posts: r2.posts.map(p => p.key.split(':')[0]) });
        if (bad2) return fail('out-of-policy', `seed ${seed}: ${bad2}`);
        // RUN-SUP-STALE-RECORD-CLOSE: the 95-min record's pid now runs another program → closed once, no kill, no retry, no card
        const r3 = rig(join(ctx.universeRoot, `s${seed}-stale`), 'run-supervisor', 'TC');
        const w3 = supervisorWorld(seed, { pidReused: true, noRuns: true });
        const body3 = createRunSupervisor({ stateRoot: join(ctx.universeRoot, `s${seed}-stale`), card: card2 }, w3);
        const reps: number[] = []; const fails: string[] = [];
        for (let i = 0; i < 4; i++) { const x = await tickAgent(card2, body3, r3.ports, new Date(T0 + i * 23 * 60_000)); reps.push(x.kpi ?? -1); fails.push(...x.failed); }
        ctx.recorder.event('sup:run-supervisor', { seed, path: 'stale-record', closed: w3.closed, kills: w3.kills, kpi: reps });
        if (JSON.stringify(w3.closed) !== '["aaaabbbbcccc-full"]' || w3.kills.length) return fail('stale-record', `seed ${seed}: closed ${JSON.stringify(w3.closed)} · kills ${JSON.stringify(w3.kills)} (want closed ["aaaabbbbcccc-full"] · no kill)`);
        if (fails.length || reps.some(k => k !== 0)) return fail('stale-record-failure', `seed ${seed}: failed ${JSON.stringify(fails)} · kpi ${JSON.stringify(reps)} (want none · all 0)`);
        if (r3.posts.length) return fail('stale-record-card', `seed ${seed}: posts ${JSON.stringify(r3.posts)}`);
        if (!r3.memory.cases(100).some(c => c.kind === 'act' && c.why.startsWith('closed-stale-record aaaabbbbcccc'))) return fail('stale-record-journal', `seed ${seed}: no closed-stale-record act case`);
      }
      return { ok: true };
    },
  },
  {
    id: 'SUP-RUN-DOCTOR',
    title: 'run-doctor: a tsc-timeout RED (exit 124) is retried once on another host and a changed-tsc fail gets a card · content-only REDs are carded to TC',
    async run(ctx) {
      for (const seed of seedsOf(ctx)) {
        const card = loadCard('run-doctor');
        const root = join(ctx.universeRoot, `s${seed}`);
        const r = rig(root, 'run-doctor', 'TC');
        const deps = doctorWorld(seed, {});
        const body = createRunDoctor({ stateRoot: root, card }, deps);
        const first = await tickAgent(card, body, r.ports, new Date(T0));
        const bad1 = check(r, first, { acted: ['retry-other-host:red:40400-aaaaaaaaaaaa-minim5', 'diagnose:red:40401-bbbbbbbbbbbb-node-b'], kpiText: 're_success_ratio 0 ', l0: 'TC' });
        if (bad1) return fail('in-policy', `seed ${seed} tick 1: ${bad1}`);
        if (JSON.stringify(deps.spawnedHosts) !== '["node-b"]') return fail('in-policy', `seed ${seed}: retry hosts ${JSON.stringify(deps.spawnedHosts)} (want ["node-b"])`);
        const second = await tickAgent(card, body, r.ports, new Date(T0 + 10 * 60_000));
        const bad2 = check(r, second, { acted: [], kpiText: 're_success_ratio 0.5 ', l0: 'TC' });
        ctx.recorder.event('sup:run-doctor', { seed, path: 'in-policy', acted: first.acted, kpi: [first.kpi, second.kpi], posts: r.posts.length });
        if (bad2) return fail('in-policy', `seed ${seed} tick 2: ${bad2}`);
        const card2 = loadCard('run-doctor');
        const root2 = join(ctx.universeRoot, `s${seed}-breach`);
        const r2 = rig(root2, 'run-doctor', 'TC');
        const body2 = createRunDoctor({ stateRoot: root2, card: card2 }, doctorWorld(seed, { contentOnly: true }));
        const bad3 = await breachPath(card2, body2, r2, 31, 5, 'TC');
        ctx.recorder.event('sup:run-doctor', { seed, path: 'out-of-policy', posts: r2.posts.map(p => p.key.split(':')[0]) });
        if (bad3) return fail('out-of-policy', `seed ${seed}: ${bad3}`);
      }
      return { ok: true };
    },
  },
  {
    id: 'SUP-AUTOPSY',
    title: 'autopsy: a refused land, a PR closed unmerged and a dead run are classified · a death with no cause evidence is carded to OP',
    async run(ctx) {
      for (const seed of seedsOf(ctx)) {
        const card = loadCard('autopsy');
        const root = join(ctx.universeRoot, `s${seed}`);
        const r = rig(root, 'autopsy', 'OP');
        const deps = autopsyWorld(seed, {});
        const body = createAutopsy({ stateRoot: root, card }, deps);
        const first = await tickAgent(card, body, r.ports, new Date(T0));
        const bad1 = check(r, first, { acted: ['classify:pending'], kpiText: 'unclassified_deaths 3 ', l0: 'OP' });
        if (bad1) return fail('in-policy', `seed ${seed} tick 1: ${bad1}`);
        const classes = deps.rowsOut.map(x => `${x.id}=${x.cls}`).sort().join(' ');
        const want = 'land:40500:cccccccccccc:tsc=land:tsc pr:40501=pr:superseded run:run-dead-1=run:pod-died';
        if (classes !== want) return fail('wrong-class', `seed ${seed}: ${classes} (want ${want})`);
        const second = await tickAgent(card, body, r.ports, new Date(T0 + 11 * 60_000));
        const bad2 = check(r, second, { acted: [], kpiText: 'unclassified_deaths 0 ', l0: 'OP' });
        ctx.recorder.event('sup:autopsy', { seed, path: 'in-policy', acted: first.acted, classes, kpi: [first.kpi, second.kpi], posts: r.posts.length });
        if (bad2) return fail('in-policy', `seed ${seed} tick 2: ${bad2}`);
        const card2 = loadCard('autopsy');
        const root2 = join(ctx.universeRoot, `s${seed}-breach`);
        const r2 = rig(root2, 'autopsy', 'OP');
        const body2 = createAutopsy({ stateRoot: root2, card: card2 }, autopsyWorld(seed, { noEvidence: true }));
        const bad3 = await breachPath(card2, body2, r2, 31, 5, 'OP');
        ctx.recorder.event('sup:autopsy', { seed, path: 'out-of-policy', posts: r2.posts.map(p => p.key.split(':')[0]) });
        if (bad3) return fail('out-of-policy', `seed ${seed}: ${bad3}`);
      }
      return { ok: true };
    },
  },
];
