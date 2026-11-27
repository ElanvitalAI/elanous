// Synthetic end-to-end scheduler -> graph tick. No real command or mail transport is used.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerReleaseGraphCommands, scheduleGraphTick } from './release-graph-cli.js';
import { listRuns, loadRun, tickRelease, type ExecDeps } from '../release-loop/release-graph-exec.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const version = '0.3.38';
const schedule = { version, rehearsalAt: '2026-11-27T08:00:00Z', cutAt: '2026-11-27T09:00:00Z', publishAt: '2026-11-27T10:00:00Z' };
function fixture(mode: 'live' | 'shadow' = 'live', time = '2026-11-27T09:00:00Z') {
  const root = mkdtempSync(join(tmpdir(), 'scheduled-tick-')); roots.push(root);
  const mail: string[] = []; const starts: string[] = [];
  const d: ExecDeps = {
    stateRoot: root, now: () => new Date(time), mode: () => mode,
    detect: async () => null,
    start: (step, _cmd, logPath, rcPath) => {
      starts.push(step.id); writeFileSync(logPath, 'synthetic executor only\n'); writeFileSync(rcPath, '0\n'); return 777;
    },
    alive: () => false,
    post: (_to, _kind, body) => { mail.push(body); return 'synthetic-mail'; },
    probes: { now: () => new Date(time), watch: async () => null, mtimeMs: () => null,
      readJson: () => ({ ok: true }), readLines: () => [], cells: async () => [], idleSeats: async () => [],
      landedCount: async () => 0, handsUpCount: async () => 0, publishedVersions: async () => [], installedVersion: async () => null },
    planOptions: { seatState: root, repo: root, instanceRoot: root, cli: 'synthetic' },
  };
  return { root, d, mail, starts };
}

test('live zero-runs emits synthetic red and never starts a graph with missing schedule', async () => {
  const f = fixture();
  expect(await scheduleGraphTick({ stateRoot: f.root, version, d: f.d, schedule: () => null })).toBe('red');
  expect(f.mail.some(m => m.includes('🔴') && m.includes(version) && m.includes('no run'))).toBe(true);
  expect(listRuns(f.root)).toEqual([]); expect(f.starts).toEqual([]);
});

test('live scheduler creates one run and the graph tick invokes only injected executors including cut', async () => {
  const f = fixture();
  const invoke = () => scheduleGraphTick({ stateRoot: f.root, version, d: f.d, schedule: () => schedule as never });
  expect(await invoke()).toBe('done');
  expect(await invoke()).toBe('none');
  expect(listRuns(f.root)).toEqual([version]);
  expect(loadRun(f.root, version)?.clock.cutAt).toBe('2026-11-27T09:00:00.000Z');
  await tickRelease(version, f.d);
  expect(f.starts.filter(s => s === 'cut')).toHaveLength(1);
  expect(loadRun(f.root, version)?.steps.cut.status).toBe('running');
  await tickRelease(version, f.d);
  expect(loadRun(f.root, version)?.steps.cut.status).toBe('done');
  expect(f.starts.filter(s => s === 'cut')).toHaveLength(1);
});

test('shadow never creates a scheduled live run or emits a red alert', async () => {
  const f = fixture('shadow');
  expect(await scheduleGraphTick({ stateRoot: f.root, version, d: f.d, schedule: () => schedule as never })).toBe('none');
  expect(listRuns(f.root)).toEqual([]); expect(f.mail).toEqual([]); expect(f.starts).toEqual([]);
});

async function invokeCli(f: ReturnType<typeof fixture>, suppliedSchedule: typeof schedule | null, config: { mode: string; version?: string } = { mode: 'live', version }, extra: string[] = []) {
  const cli = new Command();
  registerReleaseGraphCommands(cli, { stateRoot: f.root, exec: () => f.d, graphConfig: () => config,
    schedule: () => suppliedSchedule as never, heartbeat: () => {} });
  await cli.parseAsync(['node', 'synthetic', 'graph', 'tick', '--json', ...extra]);
}

test('actual CLI tick creates and cuts once with injected executor', async () => {
  const f = fixture();
  await invokeCli(f, schedule);
  expect(listRuns(f.root)).toEqual([version]);
  expect(f.starts.filter(s => s === 'cut')).toHaveLength(1);
  await invokeCli(f, schedule);
  expect(loadRun(f.root, version)?.steps.cut.status).toBe('done');
  expect(f.starts.filter(s => s === 'cut')).toHaveLength(1);
});

test('actual CLI tick reports zero-runs and invalid live configuration via injected mail', async () => {
  const f = fixture();
  await invokeCli(f, null);
  expect(f.mail.some(m => m.includes('🔴') && m.includes('no run'))).toBe(true);
  expect(listRuns(f.root)).toEqual([]); expect(f.starts).toEqual([]);
  await invokeCli(f, schedule, { mode: 'live' });
  expect(f.mail.some(m => m.includes('invalid configured live version'))).toBe(true);
  expect(listRuns(f.root)).toEqual([]); expect(f.starts).toEqual([]);
});

test('actual CLI virtual replay cannot create live runs or post alerts', async () => {
  const f = fixture();
  await invokeCli(f, null, { mode: 'live', version }, ['--at', '2026-11-27T09:00:00Z']);
  expect(listRuns(f.root)).toEqual([]); expect(f.mail).toEqual([]); expect(f.starts).toEqual([]);
});
