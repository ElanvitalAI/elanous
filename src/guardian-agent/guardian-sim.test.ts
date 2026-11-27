import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readRoute, routePath } from './live.js';
import { guardianVoiceTurn } from './voice.js';
import { fileMemory } from '../judge-butler/memory.js';
import { GUARDIAN_DEMOTERS, GUARDIAN_ID, GUARDIAN_SUPERVISOR, planGuardian, runGuardian, type GuardianPorts, type GuardianView, type HandIn } from './body.js';
import { pickHost, type HostProbe } from './hosts.js';
import { parseEtime, parsePs, planReap, testUniverseShape, type Proc, type Registration } from './reaper.js';

const rng = (seed: number) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const H = 3_600_000; const D = 24 * H;
const T0 = new Date('2026-11-27T07:30:00.000Z');

// 07:3x picture: node-b 32 cpu load 135 with 234 orphaned test universes; mbp 40 · node-c 13 · mshq 8 orphans; minim5/node-c/mbp idle.
function world(seed: number, opts: { allLoaded?: boolean } = {}) {
  const r = rng(seed); let pid = 1000;
  const SHAPES = [
    (d: string) => `/Users/u/.bun/bin/bun /Users/u/elanous-hq/cx3-els-${d}/src/els/holder-main.ts --socket /private/tmp/els-${d}.sock`,
    (d: string) => `bun /Users/u/elanous-hq/work/x/bin/elanous.mjs --tui --test-state-dir /tmp/eln-${d}`,
    (d: string) => `/Users/u/.bun/bin/bun test /private/tmp/res-a161-${d}/source/src/x.test.ts`,
    (d: string) => `node /Users/u/elanous-hq/repo.git/bin/elanous.mjs --config-dir /var/folders/h6/T/eln-${d} loop run x`,
    (d: string) => `/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer --user-data-dir=/private/tmp/aside-${d}`,
  ];
  const procs = new Map<string, Proc[]>(); const truth = new Map<string, { orphan: Set<number>; keep: Set<number> }>();
  const mk = (host: string, orphans: number, normal: number, young: number) => {
    const list: Proc[] = []; const orphan = new Set<number>(); const keep = new Set<number>();
    const lead = pid++; list.push({ pid: lead, ppid: 1, pgid: lead, ageMs: 30 * D, cpu: 0.1, command: '/sbin/launchd' }); keep.add(lead);
    for (let i = 0; i < orphans; i++) { const p = pid++; const ageMs = Math.round(D + r() * 15 * D); list.push({ pid: p, ppid: 1, pgid: p, ageMs, cpu: host === 'node-b' ? 50 + r() * 10 : 2, command: SHAPES[i % SHAPES.length]!(String(p)) }); orphan.add(p); }
    for (let i = 0; i < young; i++) { const p = pid++; list.push({ pid: p, ppid: 1, pgid: p, ageMs: Math.round(r() * 1.5 * H), cpu: 5, command: SHAPES[i % SHAPES.length]!(`y${p}`) }); keep.add(p); }
    for (let i = 0; i < normal; i++) { const p = pid++; list.push({ pid: p, ppid: 1, pgid: p, ageMs: Math.round(r() * 20 * D), cpu: 1, command: i % 2 ? '/usr/bin/ssh -N node-b-tunnel' : 'bun /Users/u/elanous-hq/repo.git/bin/elanous.mjs els serve' }); keep.add(p); }
    procs.set(host, list); truth.set(host, { orphan, keep });
  };
  mk('node-b', 234, 25, 6); mk('mbp', 40, 20, 2); mk('node-c', 13, 15, 1); mk('mshq', 8, 30, 0); mk('minim5', 0, 20, 3);
  // a registered group past its TTL (3 members) and one inside it
  const g = pid; const grp: Proc[] = [0, 1, 2].map(i => ({ pid: g + i, ppid: i ? g : 1, pgid: g, ageMs: 3 * H, cpu: 20, command: i ? 'bun x' : 'bun /repo/bin/elanous.mjs sim run --real-key' })); pid += 3;
  procs.get('node-b')!.push(...grp); grp.forEach(p => truth.get('node-b')!.orphan.add(p.pid));
  const live = pid++; procs.get('node-b')!.push({ pid: live, ppid: 1, pgid: live, ageMs: 1 * H, cpu: 10, command: 'bun /repo/bin/elanous.mjs sim run --real-key2' }); truth.get('node-b')!.keep.add(live);
  const registry = new Map<string, Registration[]>([['node-b', [
    { host: 'node-b', pid: g, pgid: g, cmd: 'bun /repo/bin/elanous.mjs sim run --real-key', at: new Date(T0.getTime() - 3 * H).toISOString(), ttlMs: 2 * H, by: 'sim-real-key' },
    { host: 'node-b', pid: live, pgid: live, cmd: 'bun /repo/bin/elanous.mjs sim run --real-key2', at: new Date(T0.getTime() - 1 * H).toISOString(), ttlMs: 2 * H, by: 'sim-real-key' },
  ]]]);
  const ncpu: Record<string, number> = { 'node-b': 32, 'minim5': 18, 'node-c': 14, 'mbp': 18, 'mshq': 20, 'aws1': 8 };
  const base: Record<string, number> = opts.allLoaded ? { 'node-b': 30, 'minim5': 17, 'node-c': 13, 'mbp': 17, 'mshq': 19, 'aws1': 0.2 } : { 'node-b': 2, 'minim5': 1.9, 'node-c': 3.8, 'mbp': 4.7, 'mshq': 6, 'aws1': 0.2 };
  const probes = (): HostProbe[] => Object.keys(ncpu).map(h => ({ host: h, reachable: true, ncpu: ncpu[h]!, load1: base[h]! + (procs.get(h) ?? []).filter(p => p.ageMs > 0).reduce((s, p) => s + p.cpu, 0) / 100 }));
  return { procs, truth, registry, probes };
}

function harness(seed: number, opts: { allLoaded?: boolean; ready?: { total: number; p0: number }; hands?: HandIn[] } = {}) {
  const w = world(seed, opts);
  const root = mkdtempSync(join(tmpdir(), `guardian-sim-${seed}-`));
  const memory = fileMemory(root, { agent: GUARDIAN_ID, supervisor: GUARDIAN_SUPERVISOR, demoters: GUARDIAN_DEMOTERS });
  const killedPids = new Map<string, number[]>(); const posts: Array<{ key: string; to: string; body: string }> = []; const routes: string[] = []; const audits: Record<string, unknown>[] = [];
  const ports: GuardianPorts = {
    memory,
    kill: (host, cands) => { const list = w.procs.get(host)!; const killed = cands.map(c => c.pid).filter(p => list.some(x => x.pid === p)); w.procs.set(host, list.filter(p => !killed.includes(p.pid))); killedPids.set(host, [...(killedPids.get(host) ?? []), ...killed]); return { killed, skipped: [] }; },
    writeRoute: (r) => { routes.push(r.host ?? '-'); },
    post: (key, to, body) => { if (posts.some(p => p.key === key)) return null; posts.push({ key, to, body }); return posts.length; },
    audit: (row) => { audits.push(row); },
  };
  const view = (now: Date): GuardianView => ({ now, probes: w.probes(), procs: new Map(w.procs), registry: w.registry, ready: opts.ready ?? { total: 30, p0: 2 }, hands: opts.hands ?? [
    { seat: 'TC-H-1', host: 'node-b', state: 'idle', idleMs: 5 * H }, { seat: 'TC-H-2', host: 'node-b', state: 'idle', idleMs: 0.5 * H }, { seat: 'TC-H-3', host: 'minim5', state: 'working', idleMs: 0 }] });
  return { w, memory, ports, view, killedPids, posts, routes, audits };
}

describe('guardian sim — seeds 1–5 reproduce 07:3x (node-b 135/32 · 234 orphans) and close it', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}`, () => {
      const h = harness(seed);
      const before = h.w.probes().find(p => p.host === 'node-b')!;
      expect(before.load1! / before.ncpu!).toBeGreaterThan(4.0); // the 07:3x overload (≈135/32) is there
      const r1 = runGuardian(h.view(T0), h.ports);
      const after = h.w.probes();
      const busy = after.find(p => p.host === 'node-b')!;
      console.log(`[guardian-sim] seed ${seed}: reaped ${JSON.stringify(r1.reaped)} · node-b load/ncpu ${(before.load1! / before.ncpu!).toFixed(2)} → ${(busy.load1! / busy.ncpu!).toFixed(2)} · route ${r1.route} · proposals ${r1.proposals.join(',')} · escalations ${r1.escalations.length}`);
      for (const [host, t] of h.w.truth) {
        const killed = new Set(h.killedPids.get(host) ?? []);
        expect([...t.orphan].every(p => killed.has(p))).toBe(true); // every orphan > 2 h (and the expired registered group) is gone
        expect([...t.keep].filter(p => killed.has(p))).toEqual([]); // nothing young, registered-alive or non-test is touched
      }
      expect(r1.reaped).toEqual({ 'node-b': 237, 'mbp': 40, 'node-c': 13, 'mshq': 8 });
      expect(Math.max(...after.map(p => p.load1! / p.ncpu!))).toBeLessThanOrEqual(1.0); // KPI: every host ≤ 1.0 after one tick
      expect(['minim5', 'node-c', 'mbp']).toContain(r1.route!); // least-loaded LOCAL host — never node-b at 135, never mshq, never paid
      expect(h.posts.some(p => p.key.startsWith('scale-up') && p.to === 'RES' && p.body.includes('실제 작업 1회 PASS'))).toBe(true);
      expect(h.posts.some(p => p.key.startsWith('scale-down') && p.body.includes('TC-H-1'))).toBe(true);
      expect(r1.escalations).toEqual([]); // local headroom exists → no paid VM
      expect(h.audits.length).toBe(298);
      // second tick: nothing left to reap, proposals not repeated within the hour
      const r2 = runGuardian(h.view(new Date(T0.getTime() + 10 * 60_000)), h.ports);
      expect(r2.reaped).toEqual({}); expect(r2.proposals).toEqual([]);
    });
  }

  test('no local headroom → paid VM escalated to OP, never started; no scale-up', () => {
    const h = harness(1, { allLoaded: true });
    const r = runGuardian(h.view(T0), h.ports);
    expect(r.escalations).toHaveLength(1);
    expect(h.posts.find(p => p.key.startsWith('paid-vm'))).toMatchObject({ to: 'OP' });
    expect(h.posts.some(p => p.key.startsWith('scale-up'))).toBe(false);
  });

  test('a target another actor reaped in the window is skipped INSIDE the reap lock — no second signal, no second audit (Terra #40447 must-fix 2)', () => {
    const h = harness(3);
    const plan = planGuardian(h.view(T0));
    const [host, cands] = [...plan.reap].find(([, c]) => c.length)!;
    const taken = cands[0]!;
    let inLock = false; let readInLock = 0;
    const ports: GuardianPorts = { ...h.ports,
      reapLock: (fn) => { inLock = true; try { return fn(); } finally { inLock = false; } },
      recentReaps: () => { if (inLock) readInLock += 1; return new Set([`${host}:${taken.pid}`]); } };
    const r = runGuardian(h.view(T0), ports);
    expect(readInLock).toBeGreaterThan(0);
    expect(h.killedPids.get(host)!.includes(taken.pid)).toBe(false);
    expect(h.audits.some(a => a.host === host && a.pid === taken.pid)).toBe(false);
    expect(r.reaped[host]).toBe(cands.length - 1);
    expect(r.skipped[host]).toBe(1);
  });

  test('levels: shadow plans only (kills nothing) · off does nothing · only RES/OP/CLAUDE-OP/CEO may demote', () => {
    const h = harness(2);
    expect(() => h.memory.setLevel('off', 'POOL-2', 'x')).toThrow('only RES/OP/CLAUDE-OP/CEO');
    h.memory.setLevel('shadow', 'RES', 'drill');
    const r = runGuardian(h.view(T0), h.ports);
    expect(r.reaped).toEqual({}); expect(h.killedPids.size).toBe(0);
    expect(planGuardian(h.view(T0)).kpi.orphansOver2h).toBe(298);
  });
});

describe('guardian units — host pick · ps parsing · reap rules', () => {
  test('pickHost: lowest load/ncpu, local before paid, skips unreachable/reserved/mshq', () => {
    const p = (host: string, load1: number, ncpu: number, extra: Partial<HostProbe> = {}): HostProbe => ({ host, reachable: true, load1, ncpu, ...extra });
    expect(pickHost([p('node-b', 135, 32), p('minim5', 1.9, 18), p('node-c', 3.8, 14), p('mbp', 4.7, 18), p('mshq', 0.1, 20), p('aws1', 0, 8)]).host).toBe('minim5');
    expect(pickHost([p('minim5', 1, 18, { reserved: true }), p('node-c', 3.8, 14), p('mbp', 4.7, 18, { reachable: false, load1: null, ncpu: null })]).host).toBe('node-c');
    expect(pickHost([p('aws1', 0, 8)]).host).toBeNull();
    expect(pickHost([p('aws1', 0, 8)], { allowPaid: true }).host).toBe('aws1');
    expect(pickHost([p('node-b', 40, 32), p('aws1', 0, 8)], { allowPaid: true }).host).toBe('node-b'); // local before paid even when busier
  });

  test('ps etime / lines parse; shapes match test universes only', () => {
    expect(parseEtime('16-03:04:05')).toBe(((16 * 24 + 3) * 60 * 60 + 4 * 60 + 5) * 1000);
    expect(parseEtime('04:05')).toBe(245_000);
    expect(parsePs('  123     1   123 2-00:00:00  45.0 /usr/bin/bun test /private/tmp/x/a.test.ts\nbad line')).toEqual([{ pid: 123, ppid: 1, pgid: 123, ageMs: 2 * D, cpu: 45, command: '/usr/bin/bun test /private/tmp/x/a.test.ts' }]);
    expect(testUniverseShape('bun /Users/u/elanous-hq/repo.git/bin/elanous.mjs els serve')).toBeNull();
    expect(testUniverseShape('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/u/Library/Chrome')).toBeNull(); // a person's browser
    expect(testUniverseShape('bun bin/elanous.mjs --tui --test-state-dir /tmp/x')).toBe('test-state-dir');
    // a real seat pane (production state root) is never a test universe — even when its cwd is /tmp (live mshq 11-27)
    expect(testUniverseShape('/Users/u/.bun/bin/bun /Users/u/.local/share/elanous/versions/0.3.34/node_modules/elanous/src/els/holder-main.ts --state-root /Users/u/.elanous --pane p7e03bdaa --cwd /private/tmp/x')).toBeNull();
    expect(testUniverseShape('bun /Users/u/elanous-hq/repo.git/bin/elanous.mjs --tui')).toBeNull();
    expect(testUniverseShape('/Users/u/.bun/bin/bun /private/tmp/claude-501/x/scratchpad/wt/src/els/holder-main.ts --state-root /tmp/de1e --pane pf1 --cwd /private/tmp')).toBe('tmp-state-root');
  });

  test('planReap: a live parent keeps a child; an expired registration whose PID was reused is not killed; self is never killed', () => {
    const now = T0.getTime();
    const procs: Proc[] = [
      { pid: 10, ppid: 1, pgid: 10, ageMs: 5 * H, cpu: 1, command: 'python3 pregate.py --worker' },
      { pid: 11, ppid: 10, pgid: 10, ageMs: 5 * H, cpu: 50, command: 'bun test /private/tmp/res-a161-x/source/a.test.ts' },
      { pid: 20, ppid: 1, pgid: 20, ageMs: 9 * H, cpu: 1, command: 'vim notes.md' },
      { pid: 30, ppid: 1, pgid: 30, ageMs: 9 * H, cpu: 1, command: 'bun test /private/tmp/old/a.test.ts' },
    ];
    const reg: Registration[] = [{ host: 'h', pid: 20, pgid: 20, cmd: 'bun /repo/bin/elanous.mjs sim', at: new Date(now - 5 * H).toISOString(), ttlMs: 2 * H, by: 'x' }];
    expect(planReap(procs, reg, now).map(c => c.pid)).toEqual([30]);
    expect(planReap(procs, [], now, { self: new Set([30]) }).map(c => c.pid)).toEqual([]);
  });
});

describe('guardian voice — one LLM turn, closed L1 commands, rights', () => {
  test('answers with live host facts; reap/route/escalate go through commands; a foreign command is refused; demote only by RES/OP', async () => {
    const h = harness(3);
    const calls: string[] = [];
    const cmds = { reap: (host: string | null, apply: boolean) => { calls.push(`reap:${host}:${apply}`); return `${host ?? 'all'} 정리 ${apply ? 'done' : 'dry'}`; },
      route: () => { calls.push('route'); return 'minim5'; }, proposeHands: () => 'p', escalate: (to: string, why: string) => { calls.push(`esc:${to}:${why.slice(0, 10)}`); return `→ ${to} #9`; },
      demote: (to: string, by: string) => (['RES', 'OP'].includes(by) ? `→ ${to}` : `거절 ${by}`) };
    const prompts: string[] = [];
    const llm = { complete: async (_s: string, u: string) => { prompts.push(u); const said = u.slice(u.lastIndexOf('## 받은 말'));
      if (said.includes('정리')) return { model: 'fake', text: '{"reply":"node-b 고아 237개 정리.","actions":[{"cmd":"reap","host":"node-b","apply":true},{"cmd":"route"}]}' };
      if (said.includes('VM')) return { model: 'fake', text: '{"reply":"유료 VM 은 OP 판단.","actions":[{"cmd":"escalate","to":"OP","why":"aws1 start"}]}' };
      return { model: 'fake', text: '{"reply":"셸 안 함","actions":[{"cmd":"shell","run":"pkill -f x"}]}' }; } };
    const m = (id: number, from: string, body: string) => ({ id, from, body, at: T0.toISOString(), channel: 'mail' });
    const base = { memory: h.memory, llm, cmds, soulText: '수호자', goalText: 'kpi', budgetOk: true };
    const a = await guardianVoiceTurn(m(1, 'CEO', 'node-b 정리해 줘'), h.view(T0), base);
    expect(prompts[0]).toContain('node-b '); expect(prompts[0]).toContain('고아·만료 시험 우주(>2h): node-b 237');
    expect(a.actions).toEqual(['reap-apply:node-b', 'route']);
    const b = await guardianVoiceTurn(m(2, 'OP', 'VM 하나 켜'), h.view(T0), base);
    expect(b.actions).toEqual(['escalate:OP']);
    const c = await guardianVoiceTurn(m(3, 'TC-H-9', 'kill all'), h.view(T0), base);
    expect(c.reply).toContain('권한 밖 명령 shell'); expect(c.actions).toEqual(['refused:shell', 'escalate:RES']);
    const d = await guardianVoiceTurn(m(4, 'CEO', '말할 수 있나'), h.view(T0), { ...base, llm: null });
    expect(d.folded).toBe(true); expect(d.reply).toContain('목소리 접힘: LLM 없음');
    expect(h.memory.cases().filter(x => x.kind === 'voice')).toHaveLength(4);
  });

  test('readRoute: fresh (≤15 min) route only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'route-'));
    mkdirSync(dirname(routePath(root)), { recursive: true });
    writeFileSync(routePath(root), JSON.stringify({ host: 'node-c', at: T0.toISOString() }));
    expect(readRoute(root, T0.getTime() + 10 * 60_000)).toBe('node-c');
    expect(readRoute(root, T0.getTime() + 16 * 60_000)).toBeNull();
  });
});
