// SIM-WORLD supervisors · LOOP-AGENTS-AS-PLUGINS P1 — «감독의 감독» has ONE owner (대표 11-28 15:3x «감독자들이 다 도는지»):
//   SUP-HB-REGISTRY-OWNS: the REAL trigger registry (temp sqlite · the shipped run-supervisor-agent and autopsy-agent shims) with
//                         run-supervisor stalled (its tick never writes the goal file): the registry refires it, retries the
//                         missed goal and cards its owner (TC) — the real guardian pulse in the same universe, reading that
//                         registry through liveSupervisors, counts it in its 순찰대 KPI and sends nothing (no wake · no card).
//                         Before P1 the 순찰대 also woke it and carded TC itself — two wakes and two cards for one stall.
//   SUP-HB-OUTSIDE-CLOCK: the registry tick itself stops (its beat 30 min old) — nothing it fires can notice. The outside
//                         clock (src/loops/trigger-clock.ts on the nexus sweep · the shipped graphs/policies/trigger-clock.yaml)
//                         runs the tick's schedule entry once per 10 min, cards OP once after 20 min, forgets on recovery · a
//                         host without the schedule entry is never ticked.
// Literal expectations (OPS-RULES 11) · LLM 0 · no ssh · no mail outside the universe.
import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openTriggerRegistry, readTriggerDecl, registerTrigger, tickTriggers, type TriggerTickDeps } from '../../../loops/trigger-registry.js';
import type { ConditionProbes } from '../../../loops/trigger-conditions.js';
import { sweepTriggerClock } from '../../../loops/trigger-clock.js';
import { openMsgStore } from '../../../msg/msg-store.js';
import { fileMemory } from '../../../judge-butler/memory.js';
import { GUARDIAN_DEMOTERS, GUARDIAN_ID, GUARDIAN_SUPERVISOR, type GuardianPorts, type GuardianView } from '../../../guardian-agent/body.js';
import { resetGuardianDef } from '../../../guardian-agent/def.js';
import { liveSupervisors, runResidentPulse, type PulseDeps } from '../../../guardian-agent/pulse.js';
import type { SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

const REPO = resolve(import.meta.dir, '../../../..');
const T0 = Date.parse('2026-11-28T06:00:00Z');
const MIN = 60_000; // 출처: one minute in ms (scenario clock unit, not a bound)
const fail = (reason: string, diff: unknown): SimWorldScenarioOutcome => ({ ok: false, reason, diff: typeof diff === 'string' ? diff : JSON.stringify(diff) });
const quietProbes = (now: () => Date): ConditionProbes => ({
  now, watch: async () => null, mtimeMs: () => null, readJson: () => undefined, readLines: () => [],
  cells: async () => [], idleSeats: async () => [], landedCount: async () => 0, handsUpCount: async () => 0,
  publishedVersions: async () => [], installedVersion: async () => null,
});

async function registryOwns(ctx: SimWorldScenarioContext): Promise<SimWorldScenarioOutcome> {
  const stateRoot = join(ctx.universeRoot, 'state'); const seatState = join(ctx.universeRoot, 'seat-state');
  mkdirSync(seatState, { recursive: true });
  const db = openTriggerRegistry(stateRoot);
  let clock = T0;
  const writeTick = (id: string, atMs: number, kpi = 0) => {
    const home = join(stateRoot, 'loop-agents', id); mkdirSync(home, { recursive: true });
    const p = join(home, 'last-tick.json');
    writeFileSync(p, JSON.stringify({ id, at: new Date(atMs).toISOString(), level: 'live', kpi, kpiOk: true, kpiLine: `${id} kpi ${kpi}`, acted: [], refused: [] }));
    utimesSync(p, new Date(atMs), new Date(atMs));
  };
  try {
    for (const f of ['run-supervisor-agent', 'autopsy-agent']) registerTrigger(db, readTriggerDecl(join('graphs', 'triggers', `${f}.yaml`), REPO), { now: new Date(clock) });
    writeTick('run-supervisor', T0 - MIN); // its last tick before it stalled
    const runs: Record<string, number> = {}; const cards: Array<{ owner: string; body: string }> = [];
    const healthy = new Map([['autopsy-agent', 'autopsy']]); // the trigger whose tick writes its goal (the other one is stalled)
    const deps: TriggerTickDeps = {
      now: () => new Date(clock), vars: { seatState, stateRoot }, probes: quietProbes(() => new Date(clock)),
      runGraph: async (d, _input, runId) => {
        runs[d.graphId] = (runs[d.graphId] ?? 0) + 1;
        const ticks = healthy.get(d.graphId); if (ticks) writeTick(ticks, clock); // run-supervisor is stalled: its tick never writes the goal file
        return { status: 'done', runId };
      },
      postCard: async (owner, body) => { cards.push({ owner, body }); return `card-${cards.length}`; },
      scheduleAction: async () => {},
    };
    const end = 70 + Math.floor(ctx.random() * 10);
    for (let m = 1; m <= end; m += 1) { clock = T0 + m * MIN; await tickTriggers(db, deps); }
    // the real guardian pulse in the same universe — the registry read through the live reader
    resetGuardianDef();
    const memory = fileMemory(stateRoot, { agent: GUARDIAN_ID, supervisor: GUARDIAN_SUPERVISOR, demoters: GUARDIAN_DEMOTERS });
    const now = new Date(clock);
    const posts: Array<{ key: string; to: string; body: string }> = [];
    const post = (key: string, to: string, body: string) => { posts.push({ key, to, body }); return posts.length; };
    const view: GuardianView = { now, probes: [{ host: 'sim-host-1', reachable: true, load1: 2, ncpu: 18 }], procs: new Map(), registry: new Map(), ready: null, hands: null };
    const gports: GuardianPorts = { memory, kill: () => ({ killed: [], skipped: [] }), writeRoute: () => {}, post, audit: () => {} };
    const pdeps: PulseDeps = {
      stateRoot, now, memory, probes: () => [...view.probes], fuelSnapshot: () => null, refreshFuel: () => {}, credentials: () => [], scanSecrets: () => [],
      supervisors: () => liveSupervisors(stateRoot, now), post, heavy: () => ({ view, ports: gports, close: () => {} }), beat: () => {},
    };
    const report = runResidentPulse(pdeps);
    const patrol = report.kpi.find(k => k.agent === 'patrol')?.value ?? null;
    const owners = [...new Set(cards.map(c => c.owner))];
    const ids = [...new Set(cards.map(c => /^\[graph-trigger exception\] (\S+)/u.exec(c.body)?.[1] ?? '?'))];
    const guardianAboutIt = posts.filter(p => p.body.includes('run-supervisor')).map(p => p.key);
    ctx.recorder.event('hb:registry-owns', { end, runs, cardCount: cards.length, owners, ids, patrol, guardianAboutIt });
    if (!cards.length) return fail('registry-silent', `no exception card in ${end} min · runs ${JSON.stringify(runs)}`);
    if (JSON.stringify(owners) !== '["TC"]' || JSON.stringify(ids) !== '["run-supervisor-agent"]') return fail('registry-card-wrong', { owners, ids });
    if ((runs['run-supervisor-agent'] ?? 0) < 2) return fail('registry-no-refire', runs);
    if (guardianAboutIt.length) return fail('guardian-second-card', guardianAboutIt);
    if (!patrol?.endsWith('응답 없는 서브 1/2 (run-supervisor · 레지스트리 몫)')) return fail('rollup', patrol ?? '-');
    return { ok: true };
  } finally { db.close(); }
}

async function outsideClock(ctx: SimWorldScenarioContext): Promise<SimWorldScenarioOutcome> {
  const stateRoot = join(ctx.universeRoot, 'state'); mkdirSync(join(stateRoot, 'watchers'), { recursive: true });
  writeFileSync(join(stateRoot, 'graph-trigger-registry.db'), '');
  const ledger = join(stateRoot, 'watchers', 'beats.jsonl');
  const at = (m: number) => new Date(T0 + m * MIN);
  const stale = 20 + Math.floor(ctx.random() * 40);
  writeFileSync(ledger, `${JSON.stringify({ name: 'trigger-tick', at: at(-stale).toISOString(), saw: 3, everyMin: 2 })}\n`);
  const entry = { enabled: 1, command: `cd /x && bun bin/elanous.mjs loop trigger tick --state-root ${stateRoot} --json >/dev/null 2>&1 # elanous-loop=graph-trigger-tick`, raw: null };
  let cronFixed = false; const spawned: string[] = [];
  let nowMs = T0;
  const spawn = async (command: string) => { spawned.push(`${new Date(nowMs).toISOString().slice(11, 16)} ${command.includes('loop trigger tick') ? 'tick' : command}`);
    // a working tick beats (the full pass) — stamped with the scenario clock so a replay is byte-identical
    if (cronFixed) appendFileSync(ledger, `${JSON.stringify({ name: 'trigger-tick', at: new Date(nowMs).toISOString(), saw: 1, everyMin: 2 })}\n`); return { code: 0 }; };
  const sweep = async (m: number, schedules = [entry]) => { nowMs = at(m).getTime(); return sweepTriggerClock({ stateRoot, schedules, spawn, now: at(m) }); };
  const seq: string[] = [];
  for (const m of [0, 5, 10, 20, 25]) seq.push(`${m}:${(await sweep(m)).status}`);
  cronFixed = true;
  seq.push(`30:${(await sweep(30)).status}`);
  const recovered = await sweep(35);
  seq.push(`35:${recovered.status}`);
  const other = await sweepTriggerClock({ stateRoot, schedules: [], spawn, now: at(40) });
  const store = openMsgStore(join(stateRoot, 'msg', 'messages.db'));
  let cards: string[] = [];
  try { cards = store.list('OP', 0, 50).filter(m => m.from.toLowerCase() === 'trigger-clock').map(m => m.body.slice(0, 40)); } finally { store.close(); }
  ctx.recorder.event('hb:outside-clock', { stale, seq, spawned: spawned.length, cards: cards.length, other: other.status });
  if (seq.slice(0, 5).join(' ') !== '0:woke 5:stale 10:woke 20:carded 25:stale') return fail('clock-ladder', seq.join(' '));
  if (cards.length !== 1 || !cards[0]!.startsWith('[trigger-clock · 레지스트리 틱 멈춤]')) return fail('clock-card', cards);
  if (seq.slice(5).join(' ') !== '30:woke 35:recovered') return fail('clock-recovery', seq.join(' '));
  if (other.status !== 'not-installed' || spawned.length !== 4) return fail('clock-other-host', { other: other.status, spawned });
  return { ok: true };
}

export const simWorldScenarios: readonly SimWorldScenario[] = [
  { id: 'SUP-HB-REGISTRY-OWNS', title: 'P1: a stalled agent is the trigger registry\'s — refire · retry · exception card to its owner TC · the real guardian pulse counts it (순찰대 «응답 없는 서브 1/2 · 레지스트리 몫») and sends no second wake or card', run: registryOwns },
  { id: 'SUP-HB-OUTSIDE-CLOCK', title: 'P1: the registry tick itself stopped → the outside clock (nexus sweep · trigger-clock.yaml) runs the schedule entry once per 10 min · one OP card after 20 min · recovered when it beats · a host without the entry is never ticked', run: outsideClock },
];
