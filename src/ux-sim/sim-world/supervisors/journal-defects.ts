// SIM-WORLD supervisors · SUPERVISOR-JOURNAL-DEFECTS — the three defects the live correction journal showed on 11-27
// (since 15:00 KST: 519 acted · 51 failed), each replayed on the real card ⊕ runtime with fake deps:
//   SUP-JD-PARK     — generic: one action failing on one target every tick (end-zombie-pregate 21× · open-cell 29×) is
//                     parked after 3 failures in a row: no retry, one card to the L0, the other targets keep moving.
//   SUP-JD-DEFUNCT  — run-supervisor: inflight locks whose pid is `<defunct>` (an eln session that never reaped its child)
//                     are dead locks, not zombie runs.
//   SUP-JD-CELL-CAP — autopsy: the cells-per-day budget is a plan input — no open-cell is planned once it is used up.
//   SUP-JD-SILENCE  — silence-watch: 18 re-asks to ORCHESTRATOR (no tab) got 18 bells; now no bell for a reader-less
//                     address, one notice a day (kit/mail-route dormant reroute reader, else the sender), one bell per seat.
//   SUP-OPS-SLA-OP  — silence-watch absorbs seat-state/K-EAST/tools/op-overdue-doorbell.py (YAML-OPS-SCRIPTS-ABSORB): a request
//                     from OP is due after policy sla_min_op (15) · any other sender after sla_min (30). Five seeds.
// Expectations are independent literals (rule 11).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadCard } from '../../../loop-agent/card.js';
import { fileAgentMemory, type AgentMemory } from '../../../loop-agent/memory.js';
import { readJournal } from '../../../loop-agent/journal.js';
import { tickAgent, type AgentBody, type AgentPorts } from '../../../loop-agent/runtime.js';
import { createBody as createRunSupervisor, type PregateJob, type RunSupervisorDeps } from '../../../loop-agent/bodies/run-supervisor.js';
import { createBody as createAutopsy, type AutopsyDeps, type AutopsyRow, type CellRow, type Death } from '../../../loop-agent/bodies/autopsy.js';
import { createBody as createSilence, type SilenceDeps } from '../../../loop-agent/bodies/silence-watch.js';
import type { SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

const T0 = Date.parse('2026-11-27T06:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
const seedsOf = (ctx: SimWorldScenarioContext): number[] => [ctx.seed, ctx.seed + 1, ctx.seed + 2];

interface Rig { readonly memory: AgentMemory; readonly ports: AgentPorts; readonly posts: Array<{ key: string; to: string; body: string }> }
function rig(stateRoot: string, id: string, supervisor: string): Rig {
  mkdirSync(stateRoot, { recursive: true });
  const memory = fileAgentMemory(stateRoot, id, supervisor);
  memory.setLevel('live', supervisor, 'sim: live');
  const posts: Array<{ key: string; to: string; body: string }> = [];
  const ports: AgentPorts = {
    memory, post(key, to, body) { if (posts.some(p => p.key === key)) return null; posts.push({ key, to, body }); return 300 + posts.length; },
    beat() { /* not under test */ }, speak() { /* not under test */ }, llm: null,
  };
  return { memory, ports, posts };
}

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'SUP-JD-PARK',
    title: 'one action failing on one target 3× in a row is parked (no retry · one L0 card) · another target keeps acting · one retry after 24 h re-parks without a new card',
    async run(ctx) {
      for (const seed of seedsOf(ctx)) {
        const card = loadCard('run-supervisor');
        const r = rig(join(ctx.universeRoot, `park-s${seed}`), 'run-supervisor', 'TC');
        const tries: string[] = [];
        const body: AgentBody = {
          observe: () => ({ kpi: 2, subjects: [{ id: 'pregate:stuck', kind: 'x', summary: 'stuck' }, { id: 'pregate:ok', kind: 'x', summary: 'ok' }], facts: [`seed ${seed}`] }),
          plan: () => [{ action: 'end-zombie-pregate', target: 'pregate:stuck', why: 'w' }, { action: 'end-zombie-pregate', target: 'pregate:ok', why: 'w' }],
          actions: { 'end-zombie-pregate': { describe: 'd', run: target => { tries.push(target); return target === 'pregate:stuck' ? { ok: false, line: 'pid 50394 명령줄이 pregate 런처가 아니다' } : { ok: true, line: 'ended' }; } } },
        };
        const at = (i: number) => new Date(T0 + seed * MIN + i * 21 * MIN);
        for (let i = 0; i < 6; i++) await tickAgent(card, body, r.ports, at(i));
        const stuck1 = tries.filter(t => t === 'pregate:stuck').length; const ok1 = tries.filter(t => t === 'pregate:ok').length;
        const parks1 = r.posts.filter(p => p.key.startsWith('act-parked:')).map(p => p.to);
        ctx.recorder.event('sup:jd-park', { seed, stuck: stuck1, ok: ok1, parks: parks1 });
        if (stuck1 !== 3) return fail('not-parked', `seed ${seed}: stuck target tried ${stuck1}× in 6 ticks (want 3)`);
        if (ok1 !== 6) return fail('starved', `seed ${seed}: healthy target acted ${ok1}× in 6 ticks (want 6)`);
        if (JSON.stringify(parks1) !== '["TC"]') return fail('park-card', `seed ${seed}: park cards ${JSON.stringify(parks1)} (want ["TC"])`);
        await tickAgent(card, body, r.ports, new Date(at(2).getTime() + 25 * HOUR));
        await tickAgent(card, body, r.ports, new Date(at(2).getTime() + 25 * HOUR + 21 * MIN));
        const stuck2 = tries.filter(t => t === 'pregate:stuck').length;
        const parks2 = r.posts.filter(p => p.key.startsWith('act-parked:')).length;
        if (stuck2 !== 4) return fail('retry', `seed ${seed}: after 24 h the stuck target was tried ${stuck2 - 3}× (want exactly 1)`);
        if (parks2 !== 1) return fail('re-card', `seed ${seed}: ${parks2} park cards after the re-park (want 1)`);
      }
      return { ok: true };
    },
  },
  {
    id: 'SUP-JD-DEFUNCT',
    title: 'run-supervisor: inflight records whose pid is <defunct> are dead records (not zombie runs · closed without a kill) · a real 95-min launcher beside them is still ended',
    async run(ctx) {
      for (const seed of seedsOf(ctx)) {
        const card = loadCard('run-supervisor');
        const root = join(ctx.universeRoot, `defunct-s${seed}`);
        const r = rig(root, 'run-supervisor', 'TC');
        const jobs: PregateJob[] = [
          { id: '73e4a14301e3-light', pid: 50394, host: 'node-b', ageMin: 8669, alive: true },
          { id: '91d47e5e3274-full', pid: 29634, host: 'node-b', ageMin: 6567, alive: true },
          { id: '1a85907c62e6-full', pid: 98853, host: 'minim5', ageMin: 11136 + seed, alive: true },
          { id: 'aaaabbbbcccc-full', pid: 4242, host: 'node-b', ageMin: 95, alive: true },
        ];
        const kills: number[] = []; const closed: string[] = [];
        const deps: RunSupervisorDeps = {
          pregateJobs: () => jobs.filter(j => !kills.includes(j.pid) && !closed.includes(j.id)),
          closeRecord: id => { closed.push(id); return { ok: true, line: `${id} closed`, undo: 'mv back' }; },
          openRuns: () => [],
          proc: pid => (pid === 4242 ? { cmd: '/opt/homebrew/bin/python3 /hq/RES/tools/pregate.py 40300 --light', elapsedSec: 95 * 60 } : { cmd: '<defunct>', elapsedSec: 30 * HOUR / 1000 }),
          kill: pid => { kills.push(pid); return true; },
          closeRun: () => ({ ok: true, line: 'x' }),
          relaunch: () => ({ ok: true, pid: 9001, line: 'relaunched' }),
          killed: () => [], recordKilled: () => {}, markRelaunched: () => {},
        };
        const body = createRunSupervisor({ stateRoot: root, card }, deps);
        // RUN-SUP-STALE-RECORD-CLOSE: the 3 dead records are closed first (least invasive · max_per_tick 3), the real launcher next tick
        const rep = await tickAgent(card, body, r.ports, new Date(T0));
        const rep2 = await tickAgent(card, body, r.ports, new Date(T0 + 21 * MIN));
        ctx.recorder.event('sup:jd-defunct', { seed, kpi: [rep.kpi, rep2.kpi], acted: [rep.acted, rep2.acted], failed: [rep.failed, rep2.failed], kills, closed });
        if (rep.kpi !== 1) return fail('kpi', `seed ${seed}: zombie_runs ${rep.kpi} (want 1 — the 3 <defunct> records are dead records, not zombie runs)`);
        if (JSON.stringify(closed) !== '["73e4a14301e3-light","91d47e5e3274-full","1a85907c62e6-full"]') return fail('closed', `seed ${seed}: closed ${JSON.stringify(closed)}`);
        if (JSON.stringify(rep2.acted) !== '["end-zombie-pregate:pregate:aaaabbbbcccc-full"]') return fail('acted', `seed ${seed}: tick 2 acted ${JSON.stringify(rep2.acted)}`);
        if (rep.failed.length + rep2.failed.length !== 0) return fail('failed-rows', `seed ${seed}: failed ${JSON.stringify([rep.failed, rep2.failed])} (want none)`);
        if (JSON.stringify(kills) !== '[4242]') return fail('kills', `seed ${seed}: kills ${JSON.stringify(kills)} (want [4242])`);
      }
      return { ok: true };
    },
  },
  {
    id: 'SUP-JD-CELL-CAP',
    title: 'autopsy: 2 cells opened in the last 24 h → no open-cell planned, 0 failed rows · 25 h later the repeated class opens its one cell',
    async run(ctx) {
      for (const seed of seedsOf(ctx)) {
        const card = loadCard('autopsy');
        const root = join(ctx.universeRoot, `cap-s${seed}`);
        const r = rig(root, 'autopsy', 'OP');
        const deaths: Death[] = [];
        for (let i = 0; i < 4 + (seed % 3); i++) deaths.push({ id: `land:${42000 + i}:abc${i}:stale-base-revert`, kind: 'land-refused', ref: `pr:${42000 + i}`, at: new Date(T0 - (i + 1) * HOUR).toISOString(), cls: 'stale-base-revert', text: '' });
        const rows: AutopsyRow[] = [];
        const cells: CellRow[] = [
          { cls: 'land:baseline-failing-focused', cellId: 'AUTOPSY-LAND-BASELINE-FAILING-FOCUSED', at: new Date(T0 - 3 * HOUR).toISOString() },
          { cls: 'land:stale-head', cellId: 'AUTOPSY-LAND-STALE-HEAD', at: new Date(T0 - 2 * HOUR).toISOString() },
        ];
        const opened: string[] = [];
        const deps: AutopsyDeps = {
          deaths: () => ({ deaths: deaths.map(d => ({ ...d })), unknown: [] }),
          rows: () => rows.map(x => ({ ...x })), record: rs => { rows.push(...rs); },
          cells: () => cells.map(c => ({ ...c })),
          openCell: id => { opened.push(id); return { ok: true, line: `칸 ${id} 추가` }; },
          recordCell: c => { cells.push(c); },
        };
        const body = createAutopsy({ stateRoot: root, card }, deps);
        const failed: string[] = [];
        for (let i = 0; i < 6; i++) failed.push(...(await tickAgent(card, body, r.ports, new Date(T0 + i * 12 * MIN))).failed);
        ctx.recorder.event('sup:jd-cell-cap', { seed, failed, opened: [...opened] });
        if (failed.length) return fail('cap-as-failure', `seed ${seed}: failed ${JSON.stringify(failed)} (want none — the cap is a plan input)`);
        if (opened.length) return fail('over-cap', `seed ${seed}: opened ${JSON.stringify(opened)} with the day's 2 cells used`);
        await tickAgent(card, body, r.ports, new Date(T0 + 25 * HOUR));
        if (JSON.stringify(opened) !== '["AUTOPSY-LAND-STALE-BASE-REVERT"]') return fail('next-day', `seed ${seed}: opened ${JSON.stringify(opened)} (want ["AUTOPSY-LAND-STALE-BASE-REVERT"])`);
      }
      return { ok: true };
    },
  },
  {
    id: 'SUP-JD-SILENCE',
    title: 'silence-watch: 18 re-asks to a reader-less ORCHESTRATOR → no bell · one notice to OP a day · RES mail → GUARDIAN by the dormant reroute · a live TC with 5 requests → one bell',
    async run(ctx) {
      for (const seed of seedsOf(ctx)) {
        const card = loadCard('silence-watch');
        const root = join(ctx.universeRoot, `silence-s${seed}`);
        const r = rig(root, 'silence-watch', 'OP');
        const pending = new Map<number, { id: number; from: string; to: string; at: number }>();
        for (let i = 0; i < 18; i++) pending.set(190891 + i, { id: 190891 + i, from: 'OP', to: 'ORCHESTRATOR', at: T0 - (216 - i) * MIN });
        for (let i = 0; i < 5; i++) pending.set(191000 + i, { id: 191000 + i, from: 'OP', to: 'TC', at: T0 - (40 + i + seed) * MIN });
        pending.set(191066, { id: 191066, from: 'LAND-GRAPH', to: 'RES', at: T0 - 210 * MIN });
        const rung: Array<[string, number]> = []; const notices: Array<{ key: string; to: string; body: string }> = [];
        const deps: SilenceDeps = {
          overdue: (now, sla) => [...pending.values()].filter(m => now.getTime() - m.at >= sla * MIN).map(m => ({ id: m.id, from: m.from, to: m.to, ageMin: (now.getTime() - m.at) / MIN, summary: '[OP · re-ask] No reply yet' })),
          readers: (_now, addrs) => new Map(addrs.map(a => [a, a === 'TC'] as const)),
          reroute: m => (m.to === 'RES' ? 'GUARDIAN' : m.to === 'ORCHESTRATOR' ? 'OP' : null),
          stalled: () => [],
          ring: (to, id) => { rung.push([to, id]); return true; }, // TC hears the bell but has not answered yet
          post: (key, to, body) => { if (notices.some(n => n.key === key)) return null; notices.push({ key, to, body }); return 500 + notices.length; },
        };
        const body = createSilence({ stateRoot: root, card }, deps);
        let t = T0;
        for (let i = 0; i < 12; i++) { await tickAgent(card, body, r.ports, new Date(t)); t += 5 * MIN; }
        const rows = readJournal(r.memory.root, T0 - HOUR, t);
        ctx.recorder.event('sup:jd-silence', { seed, rung, notices: notices.map(n => `${n.to}|${n.key}`), rows: rows.length });
        if (JSON.stringify(rung.map(([to]) => to)) !== '["TC"]') return fail('bells', `seed ${seed}: rung ${JSON.stringify(rung)} (want one bell to TC)`);
        const want = ['OP|silence-bounce:ORCHESTRATOR:OP:2026-11-27', 'GUARDIAN|silence-bounce:RES:GUARDIAN:2026-11-27'];
        if (JSON.stringify(notices.map(n => `${n.to}|${n.key}`).sort()) !== JSON.stringify([...want].sort())) return fail('notices', `seed ${seed}: ${JSON.stringify(notices.map(n => `${n.to}|${n.key}`))}`);
        if (!notices.find(n => n.to === 'OP')!.body.includes('18통')) return fail('notice-body', `seed ${seed}: OP notice «${notices.find(n => n.to === 'OP')!.body}» lacks 18통`);
        if (rows.length !== 3) return fail('journal-flood', `seed ${seed}: ${rows.length} journal rows in 12 ticks (want 3: bounce ORCHESTRATOR · bounce RES · redeliver TC)`);
      }
      return { ok: true };
    },
  },
  {
    id: 'SUP-OPS-SLA-OP',
    title: 'silence-watch: an OP request 15–29 min old is overdue (sla_min_op 15 · the retired op-overdue-doorbell.py) · the same age from another sender is not (sla_min 30) · one bell per seat',
    async run(ctx) {
      for (const seed of [ctx.seed, ctx.seed + 1, ctx.seed + 2, ctx.seed + 3, ctx.seed + 4]) {
        const card = loadCard('silence-watch');
        const root = join(ctx.universeRoot, `sla-op-s${seed}`);
        const r = rig(root, 'silence-watch', 'OP');
        const age = 16 + (seed % 10); // 16..25 min — past 15, inside 30
        const pending = new Map<number, { id: number; from: string; to: string; at: number }>([
          [7001, { id: 7001, from: 'OP', to: 'TC', at: T0 - age * MIN }],          // due (OP · 15)
          [7002, { id: 7002, from: 'LAND-GRAPH', to: 'UX', at: T0 - age * MIN }],  // not yet (30)
          [7003, { id: 7003, from: 'LAND-GRAPH', to: 'JUD', at: T0 - 41 * MIN }],  // due (30)
          [7004, { id: 7004, from: 'OP', to: 'REL', at: T0 - 9 * MIN }],           // not yet (15)
        ]);
        const rung: string[] = [];
        const deps: SilenceDeps = {
          overdue: (now, sla) => [...pending.values()].filter(m => now.getTime() - m.at >= sla * MIN).map(m => ({ id: m.id, from: m.from, to: m.to, ageMin: (now.getTime() - m.at) / MIN, summary: 'please accept' })),
          readers: (_now, addrs) => new Map(addrs.map(a => [a, true] as const)),
          stalled: () => [],
          ring: to => { rung.push(to); return true; },
          post: () => null,
        };
        const out = await tickAgent(card, createSilence({ stateRoot: root, card }, deps), r.ports, new Date(T0));
        ctx.recorder.event('sup:ops-sla-op', { seed, age, kpi: out.kpi, rung });
        if (out.kpi !== 2) return fail('kpi', `seed ${seed}: KPI ${out.kpi} (want 2: #7001 OP→TC ${age} min · #7003 LAND-GRAPH→JUD 41 min)`);
        if (JSON.stringify([...rung].sort()) !== '["JUD","TC"]') return fail('bells', `seed ${seed}: rung ${JSON.stringify(rung)} (want JUD · TC)`);
      }
      return { ok: true };
    },
  },
];
