// WORLD-REGISTRY on the lease ledger — fold · judge · parsers · seed · ledger validation.
// Expectations are literals (independent of the product's renderers).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readResourceLedger, recordWorldEvents } from './resource-ledger.js';
import type { WorldActorFields, WorldLedgerEvent } from './world-ledger-events.js';
import { anomaliesOf, eventsFor, foldWorld, judgeActor, summarize, summaryLine } from './world-registry.js';
import { localHostKey, normalizeHost, observeLoops, observeProbe, parseEtime, parseProbe, processSignature, universeDirOf } from './world-discover.js';
import { CENSUS_SEED, seedApplied, seedEvents } from './world-seed.js';
import { mayWrite } from './world-types.js';

let dir: string; let path: string;
const T0 = new Date('2026-11-27T01:00:00.000Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000).toISOString();
const decl = (actor: WorldActorFields, when = at(0), by = 'OP'): WorldLedgerEvent => ({ event: 'world-actor', at: when, by, actor });
const sweep = (scope: string, s: { appeared?: string[]; gone?: string[]; beats?: Record<string, string>; ok?: boolean; error?: string }, when = at(0)): WorldLedgerEvent =>
  ({ event: 'world-sweep', at: when, by: 'loop:guardian', scope, ok: s.ok ?? true, ...(s.error ? { error: s.error } : {}), appeared: s.appeared ?? [], gone: s.gone ?? [], beats: s.beats ?? {}, counts: {} });
const actor = (events: WorldLedgerEvent[], id: string, now = T0) => foldWorld(events, now).actors.find(a => a.id === id)!;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'world-reg-')); path = join(dir, 'resource-ledger', 'events.jsonl'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('judgeActor', () => {
  const base = { kind: 'loop' as const, registered: true, declaredState: 'live' as const, present: false, heartbeatAt: null, heartbeatSource: null, slaMin: null, seenAt: null };
  test('unregistered + present → unregistered; absent → off', () => {
    expect(judgeActor({ ...base, registered: false, present: true }, T0).state).toBe('unregistered');
    expect(judgeActor({ ...base, registered: false }, T0).state).toBe('off');
  });
  test('heartbeat older than SLA → zombie; within → live', () => {
    expect(judgeActor({ ...base, slaMin: 10, heartbeatAt: '2026-11-27T00:49:00.000Z' }, T0).state).toBe('zombie');
    expect(judgeActor({ ...base, slaMin: 10, heartbeatAt: '2026-11-27T00:51:00.000Z' }, T0).state).toBe('live');
  });
  test('SLA but never a beat → zombie with the source named', () => {
    expect(judgeActor({ ...base, slaMin: 60, heartbeatSource: 'watch:macrophage' }, T0).reason).toBe('no heartbeat ever (source watch:macrophage · SLA 60m)');
  });
  test('declared off wins; a vanished registered launchd job → zombie; a closed pane → off', () => {
    expect(judgeActor({ ...base, declaredState: 'off', slaMin: 1 }, T0).state).toBe('off');
    expect(judgeActor({ ...base, kind: 'launchd', seenAt: '2026-11-27T00:00:00.000Z' }, T0).state).toBe('zombie');
    expect(judgeActor({ ...base, kind: 'pane', seenAt: '2026-11-27T00:00:00.000Z' }, T0).state).toBe('off');
  });
});

describe('fold', () => {
  test('owner registers → live; retire is never', () => {
    const a = actor([decl({ id: 'loop:x', kind: 'loop', mode: 'owner', registered: true, owner: 'TC' })], 'loop:x');
    expect(a.state).toBe('live');
    expect(a.retire).toBe('never');
  });
  test('a discovery never sets registered and never overwrites a registered owner field', () => {
    const a = actor([
      decl({ id: 'launchd:a@h', kind: 'launchd', mode: 'owner', registered: true, owner: 'OP', purpose: 'owner text', host: 'h' }),
      decl({ id: 'launchd:a@h', kind: 'launchd', mode: 'discover', registered: false, purpose: 'sweep text' }, at(1), 'loop:guardian'),
    ], 'launchd:a@h');
    expect(a.registered).toBe(true);
    expect(a.purpose).toBe('owner text');
  });
  test('presence: appeared → present with seenAt; gone → absent; a failed sweep changes nothing', () => {
    const ev = [decl({ id: 'process:p@h', kind: 'process', mode: 'discover', host: 'h', heartbeatSource: 'seen' }), sweep('h', { appeared: ['process:p@h'] })];
    expect(actor(ev, 'process:p@h').present).toBe(true);
    expect(actor([...ev, sweep('h', { ok: false, error: 'ssh' }, at(5))], 'process:p@h').present).toBe(true);
    expect(actor([...ev, sweep('h', {}, at(5))], 'process:p@h').seenAt).toBe(at(5));
    expect(actor([...ev, sweep('h', {}, at(5))], 'process:p@h').heartbeatAt).toBe(at(5));
    expect(actor([...ev, sweep('h', { gone: ['process:p@h'] }, at(6))], 'process:p@h').state).toBe('off');
  });
  test('anomalies and the one-line summary', () => {
    const ev = [
      decl({ id: 'process:p@h', kind: 'process', mode: 'discover', host: 'h' }), sweep('h', { appeared: ['process:p@h'] }),
      decl({ id: 'loop:noowner', kind: 'loop', mode: 'owner', registered: true }),
      decl({ id: 'loop:ok', kind: 'loop', mode: 'owner', registered: true, owner: 'JUD' }),
      sweep('gcp2', { ok: false, error: 'timeout' }),
    ];
    const view = foldWorld(ev, T0);
    expect(anomaliesOf(view).map(a => `${a.kind}:${a.id}`).sort()).toEqual(['no-owner:loop:noowner', 'unreachable:host:gcp2', 'unregistered:process:p@h']);
    expect(summaryLine(summarize(view.actors))).toBe('세계: live 2 · zombie 0 · unregistered 1 · no-owner 1 (shadow 0 · off 0 · total 3)');
    expect(eventsFor(ev, 'process:p@h').length).toBe(2);
  });
});

describe('lease ledger', () => {
  test('world events append to and read back from the same events.jsonl as leases', () => {
    recordWorldEvents([decl({ id: 'loop:x', kind: 'loop', mode: 'owner', registered: true, owner: 'TC' })], path);
    appendFileSync(path, `${JSON.stringify({ event: 'lease-ended', at: at(1), id: 'L1', reason: 'done', stoppedBy: 'RES' })}\n`);
    const events = readResourceLedger(path);
    expect(events.map(e => e.event)).toEqual(['world-actor', 'lease-ended']);
    expect(foldWorld(events, T0).actors.map(a => a.id)).toEqual(['loop:x']);
  });
  test('an invalid world event is refused before it reaches the ledger', () => {
    expect(() => recordWorldEvents([{ event: 'world-actor', at: at(0), by: 'OP', actor: { id: '', kind: 'loop', mode: 'owner' } }], path)).toThrow('resource ledger invalid world event at line 1');
    expect(() => recordWorldEvents([{ event: 'world-actor', at: at(0), by: 'OP', actor: { id: 'x', kind: 'planet' as never, mode: 'owner' } }], path)).toThrow('resource ledger invalid world event at line 1');
    expect(() => readFileSync(path)).toThrow();
  });
});

describe('write ownership', () => {
  test('guardian · RES · OP write any row; others only their own or unowned', () => {
    expect(mayWrite('loop:guardian', 'TC')).toBe(true);
    expect(mayWrite('OP', 'JUD')).toBe(true);
    expect(mayWrite('TC', 'TC')).toBe(true);
    expect(mayWrite('TC', 'JUD')).toBe(false);
    expect(mayWrite('MK', null)).toBe(true);
  });
});

describe('probe parser', () => {
  const probe = [
    '@@LAUNCHCTL',
    '67235\t0\tcom.elanous.postoffice',
    '-\t0\tcom.elanous.resinfra.pinch1',
    '@@PLIST',
    'com.elanous.resinfra.pinch1\t300\t1795700000\t/Users/u/Library/LaunchAgents/com.elanous.resinfra.pinch1.plist',
    'com.elanous.unloaded\t\t\t/Users/u/Library/LaunchAgents/com.elanous.unloaded.plist',
    '@@CRON',
    'PATH=/usr/bin',
    '*/5 * * * * /bin/sh /x/tools/loop-check.sh',
    '# 0 3 * * * /bin/sh /x/tools/old.sh',
    '# a comment',
    '@@PS',
    '  228 01-00:38:47 /bun /x/versions/0.3.37-dev.0-f60be7fb7c19/node_modules/elanous/bin/elanous.mjs side serve',
    '  327 01-00:38:47 /bun /x/src/els/holder-main.ts --state-root /tmp/elsdrag1126 --pane p4',
    '  688 02:00:00 /bun /x/src/els/holder-main.ts --state-root /tmp/elsdrag1126 --pane pf',
    '  900 00:12 /bun /x/bin/elanous.mjs msg list',
    '@@END',
  ].join('\n');
  test('sections parse into typed rows', () => {
    const r = parseProbe(probe);
    expect(r.complete).toBe(true);
    expect(r.launchd).toEqual([{ label: 'com.elanous.postoffice', pid: 67235, lastExit: 0 }, { label: 'com.elanous.resinfra.pinch1', pid: null, lastExit: 0 }]);
    expect(r.plists.length).toBe(2);
    expect(r.cron.map(c => c.enabled)).toEqual([true, false]);
    expect(r.processes.length).toBe(4);
    expect(parseProbe('@@LAUNCHCTL\n1\t0\tcom.elanous.a\n').complete).toBe(false);
  });
  test('observations: launchd (loaded + plist-only) · cron (enabled present, disabled absent) · one long process · one universe; short CLI dropped', () => {
    const obs = observeProbe('mshq', parseProbe(probe), T0);
    expect(obs.map(o => o.decl.id.replace(/:[0-9a-f]{10,12}@/, ':#@')).sort()).toEqual([
      'cron:#@mshq', 'cron:#@mshq',
      'launchd:com.elanous.postoffice@mshq', 'launchd:com.elanous.resinfra.pinch1@mshq', 'launchd:com.elanous.unloaded@mshq',
      'process:#@mshq', 'test-universe:#@mshq',
    ]);
    const pinch = obs.find(o => o.decl.id === 'launchd:com.elanous.resinfra.pinch1@mshq')!;
    expect(pinch.beat).toEqual({ source: 'log', at: new Date(1795700000 * 1000).toISOString() });
    expect(pinch.decl.wake).toBe('every 300s');
    expect(obs.filter(o => o.decl.kind === 'cron').map(o => o.present).sort()).toEqual([false, true]);
    expect(obs.find(o => o.decl.kind === 'test-universe')!.decl.meta).toEqual({ dir: '/tmp/elsdrag1126', processes: 2 });
  });
  test('etime · universe dir · signature', () => {
    expect(parseEtime('01-00:38:47')).toBe(86400 + 38 * 60 + 47);
    expect(parseEtime('02:05')).toBe(125);
    expect(universeDirOf('bun x.ts --config-dir=/tmp/u1 run')).toBe('/tmp/u1');
    expect(universeDirOf('bun bin/elanous.mjs side serve')).toBeNull();
    expect(processSignature('/a/versions/0.3.1-abc/x.mjs --pid 123456')).toBe('/a/versions/*/x.mjs --pid N');
  });
});

describe('loops · hosts', () => {
  test('a registry loop is registered; a missing owner does not erase a seeded owner', () => {
    const [o] = observeLoops([{ id: 'land-graph', kind: 'graph', enabled: true, registered: true, mode: 'live', lastRunAt: at(0), expectEveryMinutes: 10 }]);
    const a = actor([decl({ id: 'loop:land-graph', kind: 'loop', mode: 'owner', registered: true, owner: 'JUD' }, at(0), 'census-1127'), decl(o!.decl, at(1), 'loop:guardian')], 'loop:land-graph');
    expect(a.owner).toBe('JUD');
    expect(a.slaMin).toBe(20);
  });
  test('disabled loop → off; shadow loop → shadow', () => {
    expect(observeLoops([{ id: 'a', enabled: false, registered: true }, { id: 'b', enabled: true, registered: true, mode: 'shadow' }]).map(o => o.decl.declaredState)).toEqual(['off', 'shadow']);
  });
  test('machine names fold onto host-registry keys', () => {
    const hosts = [{ host: 'mshq', aliases: ['Joosungui-MacStudio'], lastHeartbeatMs: 0 }, { host: 'node-b', aliases: ['MacStudioB1'], lastHeartbeatMs: 0 }];
    expect(localHostKey(hosts, 'Joosungui-MacStudio.local')).toBe('mshq');
    expect(localHostKey([], 'box.local')).toBe('box');
    expect(normalizeHost('MacStudioB1', hosts)).toBe('node-b');
    expect(normalizeHost('elsewhere', hosts)).toBe('elsewhere');
  });
});

describe('census seed', () => {
  test('binds @HQ to the local host, is recognised as applied, and dead supervisors are zombies until they beat', () => {
    const ev = seedEvents('mshq', T0);
    expect(ev.length).toBe(CENSUS_SEED.length);
    expect(seedApplied([])).toBe(false);
    expect(seedApplied(ev)).toBe(true);
    recordWorldEvents(ev, path);
    const view = foldWorld(readResourceLedger(path), T0);
    const get = (id: string) => view.actors.find(a => a.id === id)!;
    expect(get('launchd:com.elanous.postoffice@mshq').host).toBe('mshq');
    expect(get('supervisor:macrophage').state).toBe('zombie');
    expect(get('launchd:com.elanous.train-manager@mshq').state).toBe('zombie');
    expect(get('loop:guardian').owner).toBe('RES');
  });
});
