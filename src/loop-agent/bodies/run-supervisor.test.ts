import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseKnowhowItems } from '../../seat-loop/seat-knowhow.js';
import { loadCard } from '../card.js';
import { fileAgentMemory } from '../memory.js';
import { tickAgent, voiceAgent, type AgentPorts, type VoiceLlm, type VoiceMessage } from '../runtime.js';
import { createBody, relaunchArgv, type KilledPregate, type OpenRun, type PregateJob, type RunSupervisorDeps } from './run-supervisor.js';
import { parseEtime } from './run-lifecycle-shared.js';

function rng(seed: number): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

// Seeded world: pregate launchers (some past 90 min) and open runs (some silent past 120 min, some only stalled).
function world(seed: number, opts: { pidReused?: boolean } = {}) {
  const r = rng(seed);
  const jobs = new Map<string, PregateJob & { pr: number }>();
  const nj = 2 + Math.floor(r() * 3);
  for (let i = 0; i < nj; i++) {
    const id = `${(0xabc000 + seed * 16 + i).toString(16).padStart(12, '0')}-full`;
    jobs.set(id, { id, pid: 5000 + seed * 10 + i, host: i % 2 ? 'node-b' : 'minim5', ageMin: r() < 0.6 ? 95 + Math.floor(r() * 60) : 10, alive: true, pr: 40000 + i });
  }
  if (![...jobs.values()].some(j => j.ageMin >= 90)) { const first = [...jobs.values()][0]!; jobs.set(first.id, { ...first, ageMin: 120 }); }
  const runs = new Map<string, OpenRun>();
  const nr = 2 + Math.floor(r() * 3);
  for (let i = 0; i < nr; i++) {
    const idle = r() < 0.5 ? 150 + Math.floor(r() * 100) : 40;
    runs.set(`run-${seed}-${i}`, { runId: `run-${seed}-${i}`, graphId: 'ta-sprint', startedAt: '2026-11-27T05:00:00Z', lastAt: '2026-11-27T07:00:00Z', idleMin: idle, stage: 'implement' });
  }
  const killed: KilledPregate[] = []; const kills: number[] = []; const stops: string[] = []; const relaunches: string[][] = []; const closed: string[] = [];
  const deps: RunSupervisorDeps = {
    pregateJobs: () => [...jobs.values()],
    openRuns: () => [...runs.values()],
    proc: pid => {
      const j = [...jobs.values()].find(x => x.pid === pid && x.alive);
      if (!j) return null;
      const head = j.id.split('-')[0];
      return opts.pidReused ? { cmd: '/usr/bin/some-other-daemon --serve', elapsedSec: j.ageMin * 60 }
        : { cmd: `/opt/homebrew/bin/python3 /x/RES/tools/pregate.py ${j.pr} --host ${j.host} --focused src/a.test.ts # ${head}`, elapsedSec: j.ageMin * 60 };
    },
    kill: pid => { const j = [...jobs.values()].find(x => x.pid === pid); if (!j) return false; kills.push(pid); jobs.delete(j.id); return true; },
    closeRun: runId => { stops.push(runId); runs.delete(runId); return { ok: true, line: `${runId} stop` }; },
    relaunch: argv => { relaunches.push([...argv]); return { ok: true, pid: 9000 + relaunches.length, line: `relaunched ${argv.slice(1).join(' ')}` }; },
    killed: () => killed.map(k => ({ ...k })),
    recordKilled: k => { killed.push(k); },
    closeRecord: (id) => { if (!jobs.has(id)) return { ok: false, line: `${id} gone` }; jobs.delete(id); closed.push(id); return { ok: true, line: `${id} closed`, undo: `mv closed-stale/${id}.lock ${id}.lock` }; },
    markRelaunched: (id, at) => {
      const k = killed.find(x => x.id === id && !x.relaunched);
      if (k) (k as { relaunched?: string }).relaunched = at;
      // the relaunched pregate is a fresh, young job under the same lock id
      const prev = killed.find(x => x.id === id)!;
      jobs.set(id, { id, pid: 9000 + relaunches.length, host: prev.host, ageMin: 1, alive: true, pr: 40000 });
    },
  };
  const zombies = () => [...jobs.values()].filter(j => j.alive && j.ageMin >= 90).length + [...runs.values()].filter(x => x.idleMin >= 120).length;
  return { jobs, runs, deps, killed, kills, stops, relaunches, zombies, closed };
}

function harness(seed: number, opts: { pidReused?: boolean; llm?: VoiceLlm } = {}) {
  const root = mkdtempSync(join(tmpdir(), `rs-${seed}-`));
  const card = loadCard('run-supervisor');
  const memory = fileAgentMemory(root, card.id, card.supervisor);
  memory.setLevel('live', 'TC', 'sim: the L0 promoted it (card start_level = shadow)');
  const posts: Array<{ key: string; to: string; body: string }> = [];
  const ports: AgentPorts = {
    memory, post(key, to, body) { if (posts.some(p => p.key === key)) return null; posts.push({ key, to, body }); return 700 + posts.length; },
    beat: () => {}, speak: () => {}, llm: opts.llm ?? null,
  };
  const w = world(seed, opts);
  const body = createBody({ stateRoot: root, card }, w.deps);
  return { root, card, memory, posts, ports, body, ...w };
}

describe('run-supervisor card · knowhow', () => {
  test('card loads with L0 TC and four reversible rights', () => {
    const c = loadCard('run-supervisor');
    expect(c).toMatchObject({ id: 'run-supervisor', address: 'RUN-SUPERVISOR', supervisor: 'TC', kpi: { name: 'zombie_runs', target: 0, dir: 'at_most' } });
    expect(c.rights.actions).toEqual(['close-zombie-run', 'end-zombie-pregate', 'relaunch-pregate', 'close-stale-record']);
    expect(c.soulText).toContain('런 슈퍼바이저');
  });
  test('knowhow seed parses', () => {
    const t = readFileSync(resolve(import.meta.dir, '../../../graphs/loop-agents/run-supervisor/knowhow.md'), 'utf8');
    expect(parseKnowhowItems(t, 'RUN-SUPERVISOR').length).toBeGreaterThanOrEqual(3);
  });
  test('relaunch argv comes from the launcher command line · workers are never relaunched · etime parses', () => {
    expect(relaunchArgv('/usr/bin/python3 /h/RES/tools/pregate.py 40355 --host minim5 --focused src/a.test.ts', '/h/RES/tools/pregate'))
      .toEqual(['/h/RES/tools/pregate', '40355', '--host', 'minim5', '--focused', 'src/a.test.ts']);
    expect(relaunchArgv('python3 /tmp/pregate.py --worker --head abc', '/p')).toBeNull();
    expect(relaunchArgv('bun run something', '/p')).toBeNull();
    expect(parseEtime('1-02:03:04')).toBe(93_784);
    expect(parseEtime('05:06')).toBe(306);
  });
});

describe('sim: zombie → wake → close/kill/relaunch → KPI 0 (seeds)', () => {
  for (const seed of [1, 7, 42]) {
    test(`seed ${seed}`, async () => {
      const h = harness(seed);
      const z0 = h.zombies();
      const pregateZombies = [...h.jobs.values()].filter(j => j.ageMin >= 90).length;
      let t = new Date('2026-11-27T10:00:00Z');
      const r1 = await tickAgent(h.card, h.body, h.ports, t);
      expect(r1.kpi).toBe(z0);
      expect(r1.kpiOk).toBe(false);
      expect(r1.acted.length).toBeGreaterThan(0);
      let r = r1;
      for (let i = 0; i < 6 && !(r.kpiOk === true && h.killed.every(k => k.relaunched)); i++) { t = new Date(t.getTime() + 10 * 60_000); r = await tickAgent(h.card, h.body, h.ports, t); }
      expect(r.kpi).toBe(0);
      expect(r.kpiOk).toBe(true);
      expect(h.kills.length).toBe(pregateZombies);
      expect(h.relaunches.length).toBe(pregateZombies); // undo of every kill ran once
      expect(h.relaunches.every(a => a[0]!.endsWith('/RES/tools/pregate') && a.includes('--host'))).toBe(true);
      const acts = h.memory.cases(300).filter(c => c.kind === 'act');
      expect(acts.filter(c => c.subject.startsWith('end-zombie-pregate')).every(c => typeof c.extra?.undo === 'string' && String(c.extra.undo).startsWith('재발사'))).toBe(true);
      expect(h.posts.filter(p => p.key.startsWith('kpi-breach')).length).toBe(0);
    });
  }
  test('RUN-SUP-STALE-RECORD-CLOSE: an old record whose pid was reused → closed once (no kill · an action, not a failure) · never retried · no L0 card', async () => {
    const h = harness(5, { pidReused: true });
    for (const run of [...h.runs.keys()]) h.runs.delete(run); // only pregate records remain
    const old = [...h.jobs.values()].filter(j => j.ageMin >= 90).map(j => j.id).sort();
    let t = new Date('2026-11-27T10:00:00Z');
    const first = await tickAgent(h.card, h.body, h.ports, t);
    expect(first.kpi).toBe(0); // a dead record is not a zombie run
    for (let i = 1; i < 6; i++) { t = new Date(t.getTime() + 23 * 60_000); await tickAgent(h.card, h.body, h.ports, t); }
    expect(h.kills).toEqual([]);
    expect([...h.closed].sort()).toEqual(old); // each old record closed exactly once
    const cases = h.memory.cases(300);
    expect(cases.filter(c => c.kind === 'act-failed').length).toBe(0);
    expect(cases.filter(c => c.kind === 'act' && c.why.startsWith('closed-stale-record ')).length).toBe(old.length);
    expect(h.posts.filter(p => p.key.startsWith('kpi-breach') || p.key.startsWith('act-parked:')).length).toBe(0);
  });
  test('a record whose pid is <defunct> or gone is closed the same way (no kill)', async () => {
    const h = harness(4);
    for (const run of [...h.runs.keys()]) h.runs.delete(run);
    h.deps.proc = () => ({ cmd: '<defunct>', elapsedSec: 600_000 });
    const old = [...h.jobs.values()].filter(j => j.ageMin >= 90).length;
    const r = await tickAgent(h.card, h.body, h.ports, new Date('2026-11-27T10:00:00Z'));
    expect(r.kpi).toBe(0);
    expect(r.failed).toEqual([]);
    expect(h.closed.length).toBe(Math.min(old, 3)); // max_per_tick 3
    expect(h.kills).toEqual([]);
    expect(h.memory.cases(50).find(c => c.kind === 'tick')!.why).toContain('zombie_runs 0');
  });
  test('a young record with a non-launcher pid is left for now (below stale_record_min) — not closed, not killed', async () => {
    const h = harness(6, { pidReused: true });
    for (const run of [...h.runs.keys()]) h.runs.delete(run);
    for (const j of [...h.jobs.values()]) h.jobs.set(j.id, { ...j, ageMin: 30 });
    const r = await tickAgent(h.card, h.body, h.ports, new Date('2026-11-27T10:00:00Z'));
    expect(r.planned).toBe(0); expect(h.closed).toEqual([]); expect(h.kills).toEqual([]);
  });
});

function fakeLlm(): VoiceLlm {
  return {
    async complete(_system, user) {
      const said = user.slice(user.lastIndexOf('## 받은 말'));
      const target = /\b(pregate:[0-9a-f]{12}-full)\b/u.exec(user)?.[1];
      if (/끝내/u.test(said) && target) return { model: 'fake', text: JSON.stringify({ reply: `${target} 를 정확 PID 로 끝낸다.`, actions: [{ cmd: 'act', action: 'end-zombie-pregate', target }] }) };
      if (/pkill/u.test(said)) return { model: 'fake', text: JSON.stringify({ reply: '패턴 kill 은 하지 않는다.', actions: [{ cmd: 'shell', run: 'pkill -f pregate' }] }) };
      const kpi = /zombie_runs (\d+)/u.exec(user)?.[1];
      const subj = /대상 \d+: ([^\n]*)/u.exec(user)?.[1]?.slice(0, 80) ?? '';
      return { model: 'fake', text: JSON.stringify({ reply: `좀비 ${kpi ?? '?'} — 근거 ${subj}`, actions: [] }) };
    },
  };
}
const msg = (id: number, from: string, body: string): VoiceMessage => ({ id, from, body, at: '2026-11-27T10:00:00Z', channel: 'els:ws:supervisors', thread: 'els:ws:supervisors' });

describe('voice round-trip (fake LLM)', () => {
  test('answers from facts · acts inside rights · refuses pkill and escalates to TC', async () => {
    const h = harness(21, { llm: fakeLlm() });
    const deps = { card: h.card, body: h.body, ports: h.ports, now: new Date('2026-11-27T10:00:00Z') };
    const r1 = await voiceAgent(deps, msg(1, 'OP', '왜 KPI 가 나빠? 뭐가 막고 있어?'));
    expect(r1.folded).toBe(false);
    expect(r1.reply).toMatch(/좀비 \d+ — 근거 (pregate|run):/u);
    expect(r1.refs).toContain('els:ws:supervisors:1');
    const before = h.kills.length;
    const r2 = await voiceAgent(deps, msg(2, 'OP', '그 좀비 pregate 끝내줘'));
    expect(r2.actions.some(a => a.startsWith('act:end-zombie-pregate:'))).toBe(true);
    expect(h.kills.length).toBe(before + 1);
    const r3 = await voiceAgent(deps, msg(3, 'OPC', 'pkill 로 다 죽여'));
    expect(r3.escalated).toBe(true);
    expect(h.posts.some(p => p.to === 'TC' && p.key.startsWith('voice-esc:'))).toBe(true);
  });
});
