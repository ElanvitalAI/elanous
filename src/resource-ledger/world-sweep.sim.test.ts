// WORLD-REGISTRY sim — the sweep end to end over synthetic hosts onto a temp lease ledger (no ssh · no launchctl · no els).
// Seeds: ① an unregistered process appears → anomaly · ② a heartbeat lapses → zombie · ③ an owner registers → live ·
// ④ an unreachable host keeps its rows (no false zombies) and is itself an anomaly · ⑤ a quiet re-sweep adds no declarations.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readResourceLedger, recordWorldEvents } from './resource-ledger.js';
import { anomaliesOf, foldWorld } from './world-registry.js';
import { runSweep, type BeatLike, type ProbeOutcome, type SweepSources } from './world-discover.js';

let dir: string; let path: string;
const T0 = new Date('2026-11-27T01:00:00.000Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'world-sim-')); path = join(dir, 'resource-ledger', 'events.jsonl'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const probeText = (ps: string[], launchd: string[] = []) => ['@@LAUNCHCTL', ...launchd, '@@PLIST', '@@CRON', '@@PS', ...ps, '@@END'].join('\n');
const ok = (stdout: string): ProbeOutcome => ({ ok: true, stdout, error: null });

function world(over: Omit<Partial<SweepSources>, 'beats'> & { probes: Record<string, ProbeOutcome>; beats?: BeatLike[] }): SweepSources {
  const { probes, beats, ...rest } = over;
  return {
    localHost: 'mshq', hosts: Object.keys(probes),
    probe: (h) => probes[h] ?? { ok: false, stdout: '', error: 'no route' },
    loops: () => [], beats: () => beats ?? [], panes: () => [], hostRecords: () => [],
    ...rest,
  };
}
const view = (now: Date) => foldWorld(readResourceLedger(path), now);
const get = (id: string, now: Date) => view(now).actors.find(a => a.id === id);

test('seed ① unregistered long-running process → anomaly; ③ owner registers → live; ⑤ quiet re-sweep writes only sweep lines', () => {
  const ps = ['  4242 03:00:00 /bun /x/bin/elanous.mjs mystery serve'];
  runSweep(world({ probes: { mshq: ok(probeText(ps)) } }), T0, { path });
  const un = anomaliesOf(view(T0)).filter(a => a.kind === 'unregistered');
  expect(un.length).toBe(1);
  const id = un[0]!.id;
  expect(id.startsWith('process:') && id.endsWith('@mshq')).toBe(true);
  recordWorldEvents([{ event: 'world-actor', at: at(1).toISOString(), by: 'TC', actor: { id, kind: 'process', mode: 'owner', registered: true, owner: 'TC', purpose: 'mystery server' } }], path);
  const before = readResourceLedger(path).length;
  const r = runSweep(world({ probes: { mshq: ok(probeText(ps)) } }), at(2), { path });
  expect(get(id, at(2))!.state).toBe('live');
  expect(anomaliesOf(view(at(2))).filter(a => a.id === id).length).toBe(0);
  expect(readResourceLedger(path).length - before).toBe(2); // registries sweep line + mshq sweep line
  expect(r.scopes.map(s => s.declared)).toEqual([0, 0]);
});

test('seed ② a watcher heartbeat lapses past its SLA → zombie', () => {
  const beats: BeatLike[] = [{ name: 'res-patrol', at: T0.toISOString(), everyMin: 5 }];
  runSweep(world({ probes: {}, beats }), T0, { path });
  expect(get('watcher:res-patrol', T0)!.state).toBe('live');
  runSweep(world({ probes: {}, beats }), at(11), { path });
  const a = get('watcher:res-patrol', at(11))!;
  expect(a.state).toBe('zombie');
  expect(a.reason).toBe('heartbeat 11m old > SLA 10m (source watch:res-patrol)');
});

test('seed ②b a registered launchd job that disappears → zombie; an unregistered one → off', () => {
  runSweep(world({ probes: { mshq: ok(probeText([], ['123\t0\tcom.elanous.kept', '-\t0\tcom.elanous.oneoff'])) } }), T0, { path });
  recordWorldEvents([{ event: 'world-actor', at: T0.toISOString(), by: 'OP', actor: { id: 'launchd:com.elanous.kept@mshq', kind: 'launchd', mode: 'owner', registered: true, owner: 'OP' } }], path);
  runSweep(world({ probes: { mshq: ok(probeText([])) } }), at(5), { path });
  expect(get('launchd:com.elanous.kept@mshq', at(5))!.state).toBe('zombie');
  expect(get('launchd:com.elanous.oneoff@mshq', at(5))!.state).toBe('off');
});

test('a running process the owner ties to a watch beat stays zombie until that beat arrives', () => {
  recordWorldEvents([{ event: 'world-actor', at: T0.toISOString(), by: 'TC', actor: { id: 'launchd:com.elanous.train-manager@mshq', kind: 'launchd', mode: 'owner', registered: true, owner: 'TC', host: 'mshq', heartbeatSource: 'watch:train-manager', slaMin: 30 } }], path);
  const ld = ['91293\t-2\tcom.elanous.train-manager'];
  runSweep(world({ probes: { mshq: ok(probeText([], ld)) } }), at(1), { path });
  expect(get('launchd:com.elanous.train-manager@mshq', at(1))!.state).toBe('zombie');
  runSweep(world({ probes: { mshq: ok(probeText([], ld)) }, beats: [{ name: 'train-manager', at: at(2).toISOString(), everyMin: 1 }] }), at(3), { path });
  expect(get('launchd:com.elanous.train-manager@mshq', at(3))!.state).toBe('live');
});

test('seed ④ an unreachable host keeps its rows present and shows up as unreachable', () => {
  const ps = ['  77 05:00:00 /bun /x/src/els/holder-main.ts --state-root /tmp/orphan1 --pane p1'];
  runSweep(world({ probes: { "remote-a": ok(probeText(ps)) } }), T0, { path });
  const tu = view(T0).actors.filter(a => a.kind === 'test-universe');
  expect(tu.length).toBe(1);
  runSweep(world({ probes: { "remote-a": { ok: false, stdout: '', error: 'ssh timeout' } } }), at(5), { path });
  expect(get(tu[0]!.id, at(5))!.present).toBe(true);
  expect(anomaliesOf(view(at(5))).map(a => a.kind).sort()).toEqual(['unreachable', 'unregistered']);
});

test('a failing els does not close panes; an answering els that no longer lists one closes it', () => {
  runSweep(world({ probes: {}, panes: () => [{ pane_id: 'p1', workspace: 'OP', title: 'OP', host: 'mshq' }] }), T0, { path });
  runSweep(world({ probes: {}, panes: () => { throw new Error('els down'); } }), at(1), { path });
  expect(get('pane:OP/OP@mshq', at(1))!.present).toBe(true);
  runSweep(world({ probes: {}, panes: () => [] }), at(2), { path });
  expect(get('pane:OP/OP@mshq', at(2))!.state).toBe('off');
});
