import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileMemory } from '../judge-butler/memory.js';
import { GUARDIAN_DEMOTERS, GUARDIAN_ID, GUARDIAN_SUPERVISOR, type GuardianPorts, type GuardianView } from './body.js';
import { runResidentPulse, type PulseDeps } from './pulse.js';
import { dueSubAgents, memorySpawnLedger, renderKpiTable, SUB_AGENTS, worldEvents } from './subagents.js';
import { diffWorld, readPulseSnapshot, renderWorld, supervisorEntries } from './world.js';
import type { HostProbe } from './hosts.js';
import type { Proc } from './reaper.js';
import { accountEntries, judgeFuel, type UsageSnapshot } from './fuel.js';
import { credentialEntries, type CredentialIn, type ExposureIn } from './keys.js';

const T0 = new Date('2026-11-27T10:00:00.000Z');
const H = 3_600_000;

function harness(fuel: { snap?: UsageSnapshot | null; fresh?: UsageSnapshot | null; creds?: CredentialIn[]; exposures?: ExposureIn[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'guardian-pulse-'));
  const memory = fileMemory(root, { agent: GUARDIAN_ID, supervisor: GUARDIAN_SUPERVISOR, demoters: GUARDIAN_DEMOTERS });
  let refreshed = 0; let snap = fuel.snap ?? null;
  const posts: Array<{ key: string; to: string; body: string }> = []; const restarts: string[] = []; const routes: string[] = []; const killed: number[] = [];
  let probes: HostProbe[] = [
    { host: 'node-b', reachable: true, load1: 135, ncpu: 32 }, { host: 'minim5', reachable: true, load1: 1.9, ncpu: 18 },
    { host: 'node-c', reachable: true, load1: 3.8, ncpu: 14 }, { host: 'mbp', reachable: true, load1: 4.7, ncpu: 18 },
  ];
  const orphans: Proc[] = Array.from({ length: 5 }, (_, i) => ({ pid: 500 + i, ppid: 1, pgid: 500 + i, ageMs: 30 * H, cpu: 50, command: `bun /x/src/els/holder-main.ts --state-root /tmp/els-${i} --pane p${i}` }));
  const view = (now: Date): GuardianView => ({ now, probes, procs: new Map([['node-b', orphans.filter(p => !killed.includes(p.pid))]]), registry: new Map(), ready: { total: 20, p0: 1 }, hands: [{ seat: 'H1', host: null, state: 'idle', idleMs: 0 }] });
  const ports: GuardianPorts = { memory, kill: (_h, c) => { killed.push(...c.map(x => x.pid)); return { killed: c.map(x => x.pid), skipped: [] }; }, writeRoute: r => { routes.push(r.host ?? '-'); }, post: (key, to, body) => { posts.push({ key, to, body }); return posts.length; }, audit: () => {} };
  const deps = (now: Date): PulseDeps => ({
    stateRoot: root, now, memory,
    probes: () => probes,
    fuelSnapshot: () => snap,
    credentials: () => fuel.creds ?? [],
    scanSecrets: () => fuel.exposures ?? [],
    refreshFuel: () => { refreshed++; if (fuel.fresh !== undefined) snap = fuel.fresh; },
    supervisors: () => [
      { id: 'land-graph', owner: 'TC', everyMin: 10, lastAt: new Date(now.getTime() - 2 * H).toISOString(), lastStatus: 'done', badSince: null, via: 'trigger' }, // dead: 2h > 3 × 10m
      { id: 'judge-butler', owner: 'OP', everyMin: 10, lastAt: new Date(now.getTime() - 5 * 60_000).toISOString(), lastStatus: 'done', badSince: new Date(now.getTime() - 90 * 60_000).toISOString(), via: 'trigger' }, // bad 90m
      { id: 'op-pulse', owner: 'OP', everyMin: 10, lastAt: new Date(now.getTime() - 3 * 60_000).toISOString(), lastStatus: 'done', badSince: null, via: 'trigger' },
    ],
    restart: id => { restarts.push(id); },
    post: (key, to, body) => { posts.push({ key, to, body }); return posts.length; },
    heavy: () => ({ view: view(now), ports, close: () => {} }),
    beat: () => {},
  });
  return { root, memory, posts, restarts, routes, killed, deps, refreshed: () => refreshed, setProbes: (p: HostProbe[]) => { probes = p; } };
}

describe('guardian thin body — pulse aggregates, spawns sub-agents (one line each), decides the route', () => {
  test('first pulse at 10:00 (node-b 135/32 · a dead and a bad supervisor): all 7 spawn once, each in its own line; the body writes the route', () => {
    const h = harness();
    const r = runResidentPulse(h.deps(T0));
    expect(r.spawned.map(s => s.split('(')[0]).sort()).toEqual(['fuel', 'keys', 'lease', 'macrophage', 'patrol', 'post', 'pulse']);
    expect(r.spawned).toContain('lease(event host-overload)');
    expect(r.spawned).toContain('pulse(event supervisor-dead)');
    expect(h.restarts).toEqual(['land-graph']); // 맥박: dead → one restart
    expect(h.posts.some(p => p.to === 'TC' && p.body.includes('감독자 재기동'))).toBe(true);
    expect(h.posts.some(p => p.to === 'OP' && p.body.includes('재부착 제안') && p.body.includes('judge-butler'))).toBe(true); // bad 90m → reattach, never retire
    expect(h.killed.sort()).toEqual([500, 501, 502, 503, 504]); // 대식세포 reaped the orphans
    expect(h.routes).toEqual(['minim5']); // final load-switch decision by the body
    expect(r.route).toBe('minim5');
    const snap = readPulseSnapshot(h.root)!;
    expect(snap.kpi).toHaveLength(7);
    expect(renderKpiTable(snap.kpi)).toContain('✘ 맥박(pulse) — 감독자·호스트 heartbeat 결손 0: 감독자 결손 2/3');
    expect(renderKpiTable(snap.kpi)).toContain('· 순찰대(patrol) — 좀비 런 0 · 미분류 사망 0: not built yet');
    expect(renderWorld(snap.world)).toContain('node-b overloaded 4.22');
    // every spawn is one line, opened and closed
    const lines = h.memory.cases().filter(c => c.kind === 'spawn');
    expect(lines.filter(c => c.why.startsWith('open')).length).toBe(7);
    expect(lines.filter(c => c.why.startsWith('close')).length).toBe(7);
    expect(memorySpawnLedger(h.memory).openLines()).toEqual([]);
  });

  test('a pulse one minute later spawns nothing (cadence not due · events debounced 2 min); five minutes later the events re-spawn their owners', () => {
    const h = harness();
    runResidentPulse(h.deps(T0));
    expect(runResidentPulse(h.deps(new Date(T0.getTime() + 60_000))).spawned).toEqual([]);
    const r3 = runResidentPulse(h.deps(new Date(T0.getTime() + 5 * 60_000)));
    expect(r3.spawned.map(s => s.split('(')[0]).sort()).toEqual(['lease', 'macrophage', 'pulse']);
    expect(h.restarts).toEqual(['land-graph']); // restart is rate-limited to once per 30 min
  });

  test('a spawn line left open past its TTL is reaped by the parent', () => {
    const h = harness();
    const ledger = memorySpawnLedger(h.memory);
    ledger.open({ agent: 'patrol', by: 'GUARDIAN', why: 'cadence', resource: 'local', ttlMin: 10, at: new Date(T0.getTime() - 20 * 60_000).toISOString() });
    const r = runResidentPulse(h.deps(T0));
    expect(r.reaped).toEqual(['patrol-1']);
  });

  test('shadow records the world and spawns nothing; healthy world → only cadence spawns', () => {
    const h = harness();
    h.memory.setLevel('shadow', 'RES', 'drill', T0);
    const r = runResidentPulse(h.deps(T0));
    expect(r.spawned).toEqual([]); expect(h.restarts).toEqual([]); expect(h.killed).toEqual([]);
    expect(readPulseSnapshot(h.root)!.world.length).toBeGreaterThan(0);
  });
});

describe('world · sub-agent units', () => {
  test('supervisor status: dead after 3 cadences · broken on exception · bad after 60 min · beat via watcher status', () => {
    const now = T0;
    const e = supervisorEntries([
      { id: 'a', owner: 'X', everyMin: 10, lastAt: new Date(now.getTime() - 31 * 60_000).toISOString(), lastStatus: 'done', badSince: null, via: 'trigger' },
      { id: 'b', owner: 'X', everyMin: 10, lastAt: new Date(now.getTime() - 5 * 60_000).toISOString(), lastStatus: 'exception', badSince: null, via: 'trigger' },
      { id: 'c', owner: 'X', everyMin: null, lastAt: null, lastStatus: null, badSince: new Date(now.getTime() - 61 * 60_000).toISOString(), via: 'trigger' },
      { id: 'beat:w', owner: null, everyMin: 5, lastAt: null, lastStatus: 'DEAD', badSince: null, via: 'beat', watcherStatus: 'DEAD' },
    ], now);
    expect(e.map(x => `${x.id}:${x.status}`)).toEqual(['a:dead', 'b:broken', 'c:bad', 'beat:w:dead']);
  });

  test('events → due sub-agents; diff reports changes', () => {
    const ev = worldEvents([{ kind: 'host', id: 'node-b', owner: null, status: 'overloaded', lastSeen: null, facts: {} }, { kind: 'account', id: 'codex:team', owner: null, status: 'low', lastSeen: null, facts: { used: 0.93 } }]);
    expect([...ev].sort()).toEqual(['fuel-90', 'host-overload']);
    const all = Object.fromEntries(SUB_AGENTS.map(s => [s.id, T0.toISOString()]));
    expect(dueSubAgents(ev, all, T0.getTime() + 3 * 60_000).map(d => `${d.spec.id}:${d.why}`)).toEqual(['lease:event host-overload', 'fuel:event fuel-90', 'macrophage:event host-overload']);
    expect(diffWorld([{ kind: 'host', id: 'node-b', owner: null, status: 'ok', lastSeen: null, facts: {} }], [{ kind: 'host', id: 'node-b', owner: null, status: 'overloaded', lastSeen: null, facts: {} }], 'now')).toEqual([{ at: 'now', kind: 'host', id: 'node-b', from: 'ok', to: 'overloaded' }]);
  });
});

describe('연료관 — accounts from the status snapshot · alerts before the 95 % cap · floor gone · stale refresh', () => {
  const snapAt = (ts: number): UsageSnapshot => ({ ts, accounts: [
    { provider: 'codex', account: 'team', usedPercent: 93, resetsIn: '2d 3h', status: 'ok' },
    { provider: 'codex', account: 'third', usedPercent: 96, status: 'ok' },
    { provider: 'codex', account: 'default', usedPercent: 40, status: 'ok' },
    { provider: 'zai', account: 'default', usedPercent: 100, status: 'ok' },
    { provider: 'openrouter', account: 'default', usedPercent: null, leftUsd: 0, status: 'ok' },
  ] });

  test('pulse folds the snapshot into account rows; ≥90 % spawns the 연료관 on its event; OP alerted per account hourly; floor gone = 🚨', () => {
    const h = harness({ snap: snapAt(T0.getTime() - 60_000) });
    const r = runResidentPulse(h.deps(T0));
    expect(r.spawned).toContain('fuel(event fuel-90)');
    const fuelPosts = h.posts.filter(p => p.key.startsWith('guardian-fuel'));
    expect(fuelPosts.map(p => p.key.split(':').slice(0, 3).join(':')).sort()).toEqual(['guardian-fuel-floor:2026-11-27T10', 'guardian-fuel:codex:team', 'guardian-fuel:codex:third', 'guardian-fuel:openrouter:default', 'guardian-fuel:zai:default'].sort());
    expect(fuelPosts.find(p => p.key.startsWith('guardian-fuel:codex:team'))!.body).toContain('93% · 리셋 2d 3h');
    expect(fuelPosts.find(p => p.key.startsWith('guardian-fuel-floor'))!.body).toContain('바닥 소진');
    expect(h.refreshed()).toBe(0); // fresh snapshot → no refresh
    const kpi = readPulseSnapshot(h.root)!.kpi.find(k => k.agent === 'fuel')!;
    expect(kpi.ok).toBe(false); expect(kpi.value).toContain('codex:third 96%');
    // the next fuel spawn within the hour repeats no alert
    runResidentPulse(h.deps(new Date(T0.getTime() + 5 * 60_000)));
    expect(h.posts.filter(p => p.key.startsWith('guardian-fuel'))).toHaveLength(5);
  });

  test('a stale snapshot is refreshed once by the 연료관, then judged on the fresh numbers', () => {
    const fresh: UsageSnapshot = { ts: T0.getTime(), accounts: [{ provider: 'codex', account: 'team', usedPercent: 20, status: 'ok' }] };
    const h = harness({ snap: { ...snapAt(T0.getTime() - 30 * 60_000), accounts: [{ provider: 'codex', account: 'team', usedPercent: 50, status: 'ok' }] }, fresh });
    runResidentPulse(h.deps(T0));
    expect(h.refreshed()).toBe(1);
    expect(readPulseSnapshot(h.root)!.kpi.find(k => k.agent === 'fuel')).toMatchObject({ ok: true, value: 'codex:team 20%' });
  });

  test('units: shares, statuses, stale flag', () => {
    const rows = accountEntries(snapAt(T0.getTime() - 20 * 60_000), T0.getTime());
    expect(rows.map(r => `${r.id}:${r.status}`)).toEqual(['codex:team:low', 'codex:third:exhausted', 'codex:default:ok', 'zai:default:exhausted', 'openrouter:default:exhausted']);
    const v = judgeFuel(rows);
    expect(v).toMatchObject({ low: ['codex:team'], floorGone: true, stale: true, ok: false });
    expect(judgeFuel([]).ok).toBeNull();
  });
});

describe('열쇠지기 — credential metadata rows · stopped refresh = stale · exposure = one 🚨 per row', () => {
  test('a token that stopped refreshing spawns the keys sub-agent; exposures carded once; values never handled', () => {
    const creds: CredentialIn[] = [
      { provider: 'openai-codex', connected: true, expiresAt: T0.getTime() + H, lastRefresh: new Date(T0.getTime() - H).toISOString() },
      { provider: 'grok', connected: true, expiresAt: T0.getTime() - 9 * 24 * H, lastRefresh: new Date(T0.getTime() - 9 * 24 * H).toISOString() },
      { provider: 'gws', connected: false, expiresAt: null, lastRefresh: null },
    ];
    const h = harness({ creds, exposures: [{ store: 'logs', rowId: '9912', kind: 'token-prefix', prefix: 'sk-a', length: 51 }] });
    const r = runResidentPulse(h.deps(T0));
    expect(r.spawned).toContain('keys(event credential-expiring)');
    expect(h.posts.filter(p => p.key.startsWith('guardian-key-stale')).map(p => p.key.split(':').slice(1, 3).join(':')).sort()).toEqual(['oauth:grok', 'oauth:gws']);
    const card = h.posts.find(p => p.key.startsWith('guardian-expose'))!;
    expect(card.body).toContain('logs 행 9912'); expect(card.body).toContain('길이 51'); expect(card.body).toContain('값은 옮기지 않았다');
    expect(readPulseSnapshot(h.root)!.kpi.find(k => k.agent === 'keys')).toMatchObject({ ok: false, value: '자격 3 · 만료/정지 oauth:grok,oauth:gws · 노출 1' });
    runResidentPulse(h.deps(new Date(T0.getTime() + 5 * 60_000)));
    expect(h.posts.filter(p => p.key.startsWith('guardian-expose'))).toHaveLength(1);
  });

  test('units: stale only when refresh stopped > 7d and access expired, or disconnected', () => {
    const rows = credentialEntries([
      { provider: 'a', connected: true, expiresAt: T0.getTime() + H, lastRefresh: new Date(T0.getTime() - 30 * 24 * H).toISOString() },
      { provider: 'b', connected: true, expiresAt: T0.getTime() - H, lastRefresh: new Date(T0.getTime() - 8 * 24 * H).toISOString() },
    ], T0.getTime());
    expect(rows.map(r => `${r.id}:${r.status}`)).toEqual(['oauth:a:ok', 'oauth:b:stale']);
    expect(JSON.stringify(rows)).not.toMatch(/accessToken|refreshToken/);
  });
});
