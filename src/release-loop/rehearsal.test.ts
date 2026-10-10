import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { listLoops } from '../loops/registry.js';
import { registerReleaseCommands } from '../cli/release-cli.js';
import { runGraph } from '../graph-runner/runner.js';
import type { LightRcResult } from './light-rc.js';
import type { ReleaseSchedule } from './release-schedule.js';
import { planRehearsal, runRehearsalTick, type RehearsalDeps, type StepId } from './rehearsal.js';

const cut = '2026-10-10T13:00:00Z';
const schedule = { version: '0.2.23', cutAt: cut, publishAt: '2026-10-10T15:30:00Z' } as ReleaseSchedule;
const at = (minutes: number) => new Date(Date.parse(cut) - minutes * 60_000);
const roots: string[] = [];
const newRoot = () => { const root = mkdtempSync(join(tmpdir(), 'release-rehearsal-')); roots.push(root); return root; };
afterEach(() => { resetElanousConfigDir(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const stamp = (root: string, step: StepId) => JSON.parse(readFileSync(join(root, 'release', schedule.version, 'rehearsal', `${step}.json`), 'utf8'));
const rc = (overrides: Partial<LightRcResult> = {}): LightRcResult => ({ version: schedule.version, base: 'abc', introduced: 0, preexisting: 3, unclassified: 0, alwaysInclude: 1, alwaysIncludeMissing: [], shards: 4, remote: 'node-b', gateExitCode: 0, ok: true, ...overrides });
function harness(now: Date, result: LightRcResult = rc(), dirty = false) {
  const calls: string[] = [], notifications: string[] = [], gitCalls: string[] = [];
  const deps: RehearsalDeps = {
    now: () => now, schedules: () => [schedule],
    git: (args) => { gitCalls.push(args.join(' ')); return { rc: 0, stdout: args[0] === 'status' ? dirty ? ' M file.ts\n' : '' : args[0] === 'rev-parse' ? '1234567890abcdef\n' : '' }; },
    lightRc: async (version, checkout) => { expect(checkout).toBe('/fake/checkout'); calls.push(version); return result; },
    notify: (text) => { notifications.push(text); },
  };
  return { deps, calls, notifications, gitCalls };
}

test('next future cut picks earliest cut, then version; exact boundaries and already stamped stages', () => {
  const later = { ...schedule, version: '0.2.25', cutAt: '2026-10-10T14:00:00Z' };
  const equal = { ...schedule, version: '0.2.24' };
  expect(planRehearsal([later, equal, schedule], at(540), {})).toEqual({ status: 'not-yet', version: schedule.version, cutAt: cut, nextStepAt: at(420).toISOString() });
  expect(planRehearsal([schedule], new Date(at(420).getTime() - 1), {}).status).toBe('not-yet');
  expect(planRehearsal([schedule], at(420), {})).toMatchObject({ status: 'due', run: 'rc-7h', supersede: [] });
  expect(planRehearsal([schedule], at(150), { 'rc-7h': true })).toMatchObject({ status: 'due', run: 'rc-150m', supersede: [] });
  expect(planRehearsal([schedule], at(150), {})).toMatchObject({ status: 'due', run: 'rc-150m', supersede: ['rc-7h'] });
  expect(planRehearsal([schedule], at(120), { 'rc-150m': true })).toMatchObject({ status: 'due', run: null, supersede: ['rc-7h'] });
  expect(planRehearsal([schedule], at(45), {})).toMatchObject({ status: 'due', run: null, supersede: ['rc-7h', 'rc-150m'] });
  expect(planRehearsal([schedule], at(30), { 'rc-7h': true, 'rc-150m': true }).status).toBe('nothing-due');
  expect(planRehearsal([schedule], new Date(cut), {}).status).toBe('no-schedule');
  expect(planRehearsal([], at(420), {}).status).toBe('no-schedule');
});

test('two identical -7h ticks claim the stage once; outcome and SHA stay in the stamp', async () => {
  const root = newRoot(), h = harness(at(420));
  const opts = { ledgerRoot: root, checkout: '/fake/checkout', apply: true };
  const [first, second] = await Promise.all([runRehearsalTick(opts, h.deps), runRehearsalTick(opts, h.deps)]);
  expect(first.status).toBe('due');
  expect(second.status).toBe('not-yet');
  expect(h.calls).toEqual([schedule.version]);
  expect(h.gitCalls).toEqual(['status --porcelain', 'fetch -q origin main', 'checkout -q --detach origin/main', 'rev-parse HEAD']);
  expect(h.notifications).toHaveLength(1);
  expect(h.notifications[0]).toContain('새 회귀 0 · 기존 3 · 미분류 0 · node-b');
  expect(h.notifications[0]!.split('\n')).toHaveLength(1);
  expect(stamp(root, 'rc-7h')).toMatchObject({ outcome: 'ok', sha: '1234567890abcdef', result: { introduced: 0 }, startedAt: at(420).toISOString() });
  expect(existsSync(join(root, 'release', schedule.version, 'rehearsal', 'rc-150m.json'))).toBe(false);
  expect(readdirSync(join(root, 'release', schedule.version, 'rehearsal'))).toEqual(['rc-7h.json']);
});

test('false delivery survives restart and retries without rerunning RC; preview never sends', async () => {
  const root = newRoot(), first = harness(at(420));
  first.deps.notify = (text) => { first.notifications.push(text); return false; };
  const opts = { ledgerRoot: root, checkout: '/fake/checkout', apply: true };
  expect(await runRehearsalTick(opts, first.deps)).toMatchObject({ notificationFailures: 1 });
  expect(stamp(root, 'rc-7h')).toMatchObject({ outcome: 'ok', result: { introduced: 0 } });
  expect(stamp(root, 'rc-7h').notifiedAt).toBeUndefined();
  const restarted = harness(at(400));
  expect((await runRehearsalTick({ ...opts, apply: false }, restarted.deps)).status).toBe('not-yet');
  expect(restarted.notifications).toEqual([]);
  expect(await runRehearsalTick(opts, restarted.deps)).toMatchObject({ status: 'not-yet', notificationFailures: 0 });
  expect(restarted.calls).toEqual([]);
  expect(restarted.gitCalls).toEqual([]);
  expect(restarted.notifications).toEqual(first.notifications);
  expect(stamp(root, 'rc-7h').notifiedAt).toBe(at(400).toISOString());
  await runRehearsalTick(opts, restarted.deps);
  expect(restarted.notifications).toHaveLength(1);
});

test('an already claimed running stage is never retried as an RC or announced as a result', async () => {
  const root = newRoot(), h = harness(at(420));
  const dir = join(root, 'release', schedule.version, 'rehearsal');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'rc-7h.json'), JSON.stringify({ version: schedule.version, cutAt: cut, step: 'rc-7h', outcome: 'running', startedAt: at(420).toISOString() }));
  const result = await runRehearsalTick({ ledgerRoot: root, apply: true, checkout: '/fake/checkout' }, h.deps);
  expect(result.status).toBe('not-yet');
  expect(h.calls).toEqual([]);
  expect(h.notifications).toEqual([]);
  expect(stamp(root, 'rc-7h').outcome).toBe('running');
});

test('stale running claim from a dead owner alerts interruption without re-running, then retries failed notification', async () => {
  const root = newRoot(), h = harness(at(120));
  const dir = join(root, 'release', schedule.version, 'rehearsal');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'rc-7h.json'), JSON.stringify({ version: schedule.version, cutAt: cut, step: 'rc-7h', outcome: 'running', startedAt: at(420).toISOString(), ownerPid: 2147483647 }));
  h.deps.notify = () => false;
  const opts = { ledgerRoot: root, apply: true, checkout: '/fake/checkout' };
  await runRehearsalTick(opts, h.deps);
  expect(stamp(root, 'rc-7h')).toMatchObject({ outcome: 'interrupted', endedAt: at(120).toISOString() });
  expect(stamp(root, 'rc-7h').notifiedAt).toBeUndefined();
  expect(h.calls).toEqual([schedule.version]); // Only the distinct rc-150m is allowed to run.
  expect(stamp(root, 'rc-150m').outcome).toBe('ok');
  const later = harness(at(100));
  await runRehearsalTick(opts, later.deps);
  expect(later.calls).toEqual([]);
  expect(later.notifications).toHaveLength(2);
  expect(later.notifications[0]).toContain('interrupted');
  expect(stamp(root, 'rc-7h').notifiedAt).toBe(at(100).toISOString());
});

test('the interrupted transition is exclusive: a live lock holder blocks it; a dead holder is never unlinked, the next generation is taken', async () => {
  const root = newRoot(), dir = join(root, 'release', schedule.version, 'rehearsal');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'rc-7h.json');
  writeFileSync(path, JSON.stringify({ version: schedule.version, cutAt: cut, step: 'rc-7h', outcome: 'running', startedAt: at(420).toISOString(), ownerPid: 2147483647 }));
  const lock0 = `${path}.interrupt.lock`;
  writeFileSync(lock0, JSON.stringify({ pid: process.pid, token: 'live' }));
  const h = harness(new Date(Date.parse(cut) + 60_000));
  h.deps.schedules = () => [];
  const opts = { ledgerRoot: root, apply: true };
  await runRehearsalTick(opts, h.deps);
  expect(stamp(root, 'rc-7h').outcome).toBe('running');
  expect(h.notifications).toEqual([]);
  expect(readFileSync(lock0, 'utf8')).toContain('live');
  writeFileSync(lock0, JSON.stringify({ pid: 2147483647, token: 'dead' }));
  await runRehearsalTick(opts, h.deps);
  expect(stamp(root, 'rc-7h').outcome).toBe('interrupted');
  expect(h.notifications).toHaveLength(1);
  expect(readFileSync(lock0, 'utf8')).toContain('dead'); // never removed by another tick
  expect(existsSync(`${path}.interrupt.lock.1`)).toBe(false); // own generation released
  await runRehearsalTick(opts, h.deps);
  expect(h.notifications).toHaveLength(1);
});

test('two concurrent tick processes on a dead-owner stamp (with and without a dead transition lock) transition and announce it exactly once', async () => {
  const root = newRoot(), dir = join(root, 'release', schedule.version, 'rehearsal');
  mkdirSync(dir, { recursive: true });
  const sent = join(root, 'sent.log');
  const script = join(root, 'tick.ts');
  writeFileSync(script, `import { appendFileSync } from 'node:fs';
import { runRehearsalTick } from ${JSON.stringify(resolve(import.meta.dir, 'rehearsal.ts'))};
const [root, sent, go] = process.argv.slice(2);
while (Date.now() < Number(go)) { /* align both ticks */ }
await runRehearsalTick({ ledgerRoot: root, apply: true }, { now: () => new Date(${JSON.stringify(new Date(Date.parse(cut) + 60_000).toISOString())}), schedules: () => [],
  notify: (text) => { appendFileSync(sent, text + '\\n'); } });
`);
  for (let round = 0; round < 6; round++) {
    rmSync(join(dir, 'rc-7h.json.interrupt.lock'), { force: true });
    // Odd rounds: both processes must also recover the same dead transition lock.
    if (round % 2) writeFileSync(join(dir, 'rc-7h.json.interrupt.lock'), JSON.stringify({ pid: 2147483647, token: 'dead' }));
    writeFileSync(join(dir, 'rc-7h.json'), JSON.stringify({ version: schedule.version, cutAt: cut, step: 'rc-7h', outcome: 'running', startedAt: at(420).toISOString(), ownerPid: 2147483647 }));
    rmSync(sent, { force: true });
    const go = String(Date.now() + 1500);
    const procs = [0, 1].map(() => Bun.spawn(['bun', script, root, sent, go], { stdout: 'pipe', stderr: 'pipe' }));
    const codes = await Promise.all(procs.map(proc => proc.exited));
    expect(codes).toEqual([0, 0]);
    const lines = readFileSync(sent, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('interrupted');
    expect(stamp(root, 'rc-7h')).toMatchObject({ outcome: 'interrupted' });
    expect(stamp(root, 'rc-7h').notifiedAt).toBeDefined();
  }
}, 60_000);

test('a corrupt stamp left by a crash neither blocks other stages and notifications nor re-runs its stage', async () => {
  const root = newRoot(), dir = join(root, 'release', schedule.version, 'rehearsal');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'rc-7h.json'), '{"version":"0.2.23","st');
  const h = harness(at(120));
  const result = await runRehearsalTick({ ledgerRoot: root, apply: true, checkout: '/fake/checkout' }, h.deps);
  expect(result).toMatchObject({ status: 'due', run: 'rc-150m', supersede: [] });
  expect(h.calls).toEqual([schedule.version]);
  expect(stamp(root, 'rc-150m').outcome).toBe('ok');
  expect(h.notifications).toHaveLength(1);
  expect(readFileSync(join(dir, 'rc-7h.json'), 'utf8')).toBe('{"version":"0.2.23","st');
  expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
});

test('a live long-running claim is preserved, but a dead claim is reported after its cut even without a schedule', async () => {
  const root = newRoot(), dir = join(root, 'release', schedule.version, 'rehearsal');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'rc-7h.json');
  writeFileSync(path, JSON.stringify({ version: schedule.version, cutAt: cut, step: 'rc-7h', outcome: 'running', startedAt: at(420).toISOString(), ownerPid: process.pid }));
  const h = harness(new Date(Date.parse(cut) + 60_000));
  h.deps.schedules = () => [];
  const opts = { ledgerRoot: root, apply: true };
  await runRehearsalTick(opts, h.deps);
  expect(stamp(root, 'rc-7h').outcome).toBe('running');
  expect(h.notifications).toEqual([]);
  writeFileSync(path, JSON.stringify({ version: schedule.version, cutAt: cut, step: 'rc-7h', outcome: 'running', startedAt: at(420).toISOString(), ownerPid: 2147483647 }));
  const result = await runRehearsalTick(opts, h.deps);
  expect(result).toMatchObject({ status: 'no-schedule', stamps: [{ outcome: 'interrupted' }] });
  expect(h.calls).toEqual([]);
  expect(h.notifications).toHaveLength(1);
  expect(h.notifications[0]).toContain('⛔ 리허설 0.2.23 rc-7h · interrupted');
  await runRehearsalTick(opts, h.deps);
  expect(h.notifications).toHaveLength(1);
});

test('an aged notification lock owned by a live sender is never stolen; dead owner can be recovered', async () => {
  const root = newRoot(), first = harness(at(420));
  first.deps.notify = () => false;
  const opts = { ledgerRoot: root, apply: true, checkout: '/fake/checkout' };
  await runRehearsalTick(opts, first.deps);
  const lock = join(root, 'release', schedule.version, 'rehearsal', 'rc-7h.json.notify.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'live' }));
  utimesSync(lock, new Date(0), new Date(0));
  const h = harness(at(400));
  expect((await runRehearsalTick(opts, h.deps)).notificationFailures).toBe(1);
  expect(h.notifications).toEqual([]);
  expect(readFileSync(lock, 'utf8')).toContain('live');
  expect(stamp(root, 'rc-7h').notifiedAt).toBeUndefined();
  writeFileSync(lock, JSON.stringify({ pid: 2147483647, token: 'dead' }));
  utimesSync(lock, new Date(0), new Date(0));
  expect((await runRehearsalTick(opts, h.deps)).notificationFailures).toBe(0);
  expect(h.notifications).toHaveLength(1);
  expect(readFileSync(lock, 'utf8')).toContain('dead'); // a dead holder's lock is skipped, never unlinked
  expect(existsSync(`${lock}.1`)).toBe(false); // own generation released
});

test('notification locks have no generation cap and two processes recovering the same dead notify lock send once', async () => {
  const root = newRoot(), first = harness(at(420));
  first.deps.notify = () => false;
  const opts = { ledgerRoot: root, apply: true, checkout: '/fake/checkout' };
  await runRehearsalTick(opts, first.deps);
  const lock = join(root, 'release', schedule.version, 'rehearsal', 'rc-7h.json.notify.lock');
  for (let generation = 0; generation < 20; generation++) writeFileSync(generation ? `${lock}.${generation}` : lock, JSON.stringify({ pid: 2147483647, token: `dead-${generation}` }));
  const sent = join(root, 'sent.log');
  const script = join(root, 'tick.ts');
  writeFileSync(script, `import { appendFileSync } from 'node:fs';
import { runRehearsalTick } from ${JSON.stringify(resolve(import.meta.dir, 'rehearsal.ts'))};
const [root, sent, go] = process.argv.slice(2);
while (Date.now() < Number(go)) { /* align both ticks */ }
await runRehearsalTick({ ledgerRoot: root, apply: true }, { now: () => new Date(${JSON.stringify(at(410).toISOString())}), schedules: () => [],
  notify: async (text) => { appendFileSync(sent, text + '\\n'); await new Promise((r) => setTimeout(r, 200)); } });
`);
  const go = String(Date.now() + 1500);
  const procs = [0, 1].map(() => Bun.spawn(['bun', script, root, sent, go], { stdout: 'pipe', stderr: 'pipe' }));
  expect(await Promise.all(procs.map(proc => proc.exited))).toEqual([0, 0]);
  expect(readFileSync(sent, 'utf8').trim().split('\n')).toHaveLength(1);
  expect(stamp(root, 'rc-7h').notifiedAt).toBeDefined();
  expect(readFileSync(`${lock}.19`, 'utf8')).toContain('dead-19');
}, 60_000);

test('overlapping retries do not send the same completed stage twice', async () => {
  const root = newRoot(), h = harness(at(420));
  h.deps.notify = () => false;
  const opts = { ledgerRoot: root, apply: true, checkout: '/fake/checkout' };
  await runRehearsalTick(opts, h.deps);
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let attempts = 0;
  h.deps.notify = async () => { attempts++; started(); await waiting; return true; };
  const first = runRehearsalTick(opts, h.deps);
  await entered;
  utimesSync(join(root, 'release', schedule.version, 'rehearsal', 'rc-7h.json.notify.lock'), new Date(0), new Date(0));
  const second = await runRehearsalTick(opts, h.deps);
  expect(second.notificationFailures).toBe(1);
  release();
  await first;
  expect(attempts).toBe(1);
  expect(h.calls).toEqual([schedule.version]);
  expect(stamp(root, 'rc-7h').notifiedAt).toBeDefined();
});

test('delivery retry persists after the schedule is removed or its cut has elapsed', async () => {
  for (const schedules of [[], [schedule]]) {
    const root = newRoot(), h = harness(at(420));
    h.deps.notify = () => false;
    await runRehearsalTick({ ledgerRoot: root, apply: true, checkout: '/fake/checkout' }, h.deps);
    const restarted = harness(new Date(Date.parse(cut) + 60_000));
    restarted.deps.schedules = () => schedules;
    expect((await runRehearsalTick({ ledgerRoot: root, apply: true }, restarted.deps)).status).toBe('no-schedule');
    expect(restarted.notifications).toHaveLength(1);
    expect(restarted.calls).toEqual([]);
    expect(stamp(root, 'rc-7h').notifiedAt).toBeDefined();
  }
});

test('throwing delivery retries superseded and no-checkout alerts on the next tick', async () => {
  const root = newRoot(), failed = harness(at(30));
  failed.deps.notify = () => { throw new Error('offline'); };
  const opts = { ledgerRoot: root, apply: true };
  expect(await runRehearsalTick(opts, failed.deps)).toMatchObject({ notificationFailures: 2 });
  for (const step of ['rc-7h', 'rc-150m'] as const) expect(stamp(root, step)).toMatchObject({ outcome: 'superseded' });
  const restarted = harness(at(20));
  expect((await runRehearsalTick(opts, restarted.deps)).notificationFailures).toBe(0);
  expect(restarted.calls).toEqual([]);
  expect(restarted.notifications).toHaveLength(2);
  for (const step of ['rc-7h', 'rc-150m'] as const) expect(stamp(root, step).notifiedAt).toBe(at(20).toISOString());

  const missing = newRoot(), m = harness(at(420));
  const env = process.env.ELANOUS_REHEARSAL_GIT_CWD;
  try {
    delete process.env.ELANOUS_REHEARSAL_GIT_CWD;
    m.deps.notify = () => { throw new Error('offline'); };
    expect((await runRehearsalTick({ ledgerRoot: missing, apply: true }, m.deps)).notificationFailures).toBe(1);
    const retry = harness(at(400));
    await runRehearsalTick({ ledgerRoot: missing, apply: true }, retry.deps);
    expect(retry.calls).toEqual([]);
    expect(retry.notifications).toHaveLength(1);
    expect(retry.notifications[0]).toContain('ELANOUS_REHEARSAL_GIT_CWD');
    expect(stamp(missing, 'rc-7h')).toMatchObject({ outcome: 'no-checkout', notifiedAt: at(400).toISOString() });
  } finally { if (env === undefined) delete process.env.ELANOUS_REHEARSAL_GIT_CWD; else process.env.ELANOUS_REHEARSAL_GIT_CWD = env; }
});

test('late wake runs only rc-150m; from -45m on both unstamped steps are superseded', async () => {
  const root = newRoot(), h = harness(at(120));
  await runRehearsalTick({ ledgerRoot: root, apply: true, checkout: '/fake/checkout' }, h.deps);
  expect(h.calls).toEqual([schedule.version]);
  expect(stamp(root, 'rc-150m').outcome).toBe('ok');
  expect(stamp(root, 'rc-7h').outcome).toBe('superseded');
  expect(h.notifications).toHaveLength(2);
  await runRehearsalTick({ ledgerRoot: root, apply: true, checkout: '/fake/checkout' }, h.deps);
  expect(h.calls).toEqual([schedule.version]);
  expect(h.notifications).toHaveLength(2);
  const lateRoot = newRoot(), late = harness(at(30));
  await runRehearsalTick({ ledgerRoot: lateRoot, apply: true, checkout: '/fake/checkout' }, late.deps);
  expect(late.calls).toEqual([]);
  expect(late.gitCalls).toEqual([]);
  expect(stamp(lateRoot, 'rc-7h').outcome).toBe('superseded');
  expect(stamp(lateRoot, 'rc-150m').outcome).toBe('superseded');
  expect(late.notifications).toHaveLength(2);
});

test('unmeasured is not green; absent or dirty checkout has one notification and never runs RC', async () => {
  const unknown = newRoot(), u = harness(at(420), rc({ unclassified: null, ok: false }));
  await runRehearsalTick({ ledgerRoot: unknown, apply: true, checkout: '/fake/checkout' }, u.deps);
  expect(stamp(unknown, 'rc-7h').outcome).toBe('unmeasured');
  expect(u.calls).toHaveLength(1);
  const missing = newRoot(), m = harness(at(420));
  const prior = process.env.ELANOUS_REHEARSAL_GIT_CWD;
  try {
    delete process.env.ELANOUS_REHEARSAL_GIT_CWD;
    await runRehearsalTick({ ledgerRoot: missing, apply: true }, m.deps);
  } finally { if (prior === undefined) delete process.env.ELANOUS_REHEARSAL_GIT_CWD; else process.env.ELANOUS_REHEARSAL_GIT_CWD = prior; }
  expect(stamp(missing, 'rc-7h').outcome).toBe('no-checkout');
  expect(m.calls).toHaveLength(0);
  expect(m.gitCalls).toHaveLength(0);
  expect(m.notifications).toHaveLength(1);
  expect(m.notifications[0]).toContain('ELANOUS_REHEARSAL_GIT_CWD');
  const dirty = newRoot(), d = harness(at(420), rc(), true);
  await runRehearsalTick({ ledgerRoot: dirty, apply: true, checkout: '/fake/checkout' }, d.deps);
  expect(stamp(dirty, 'rc-7h').outcome).toBe('checkout-dirty');
  expect(d.gitCalls).toEqual(['status --porcelain']);
  expect(d.calls).toHaveLength(0);
  expect(d.notifications).toHaveLength(1);
});

test('regression, unclassified failures, git failure and runner throw remain distinct in stamps and alerts', async () => {
  for (const [result, outcome] of [[rc({ introduced: 2, ok: false }), 'regression'], [rc({ unclassified: 1, ok: false }), 'unmeasured']] as const) {
    const root = newRoot(), h = harness(at(420), result);
    await runRehearsalTick({ ledgerRoot: root, apply: true, checkout: '/fake/checkout' }, h.deps);
    expect(stamp(root, 'rc-7h').outcome).toBe(outcome);
    expect(h.notifications).toHaveLength(1);
  }
  const root = newRoot(), h = harness(at(420));
  h.deps.lightRc = async () => { throw new Error('runner failure\nsecret detail'); };
  await runRehearsalTick({ ledgerRoot: root, apply: true, checkout: '/fake/checkout' }, h.deps);
  expect(stamp(root, 'rc-7h')).toMatchObject({ outcome: 'error', summary: 'runner failure' });
  expect(h.notifications[0]).not.toContain('secret detail');
  const fetchRoot = newRoot(), f = harness(at(420));
  f.deps.git = (args) => ({ rc: args[0] === 'fetch' ? 1 : 0, stdout: '', stderr: 'offline' });
  await runRehearsalTick({ ledgerRoot: fetchRoot, apply: true, checkout: '/fake/checkout' }, f.deps);
  expect(stamp(fetchRoot, 'rc-7h').outcome).toBe('error');
  expect(f.calls).toHaveLength(0);
});

test('a failed RC gate never reports a clean measurement as ok', async () => {
  for (const result of [rc({ ok: false, gateExitCode: 0 }), rc({ ok: true, gateExitCode: 1 })]) {
    const root = newRoot(), h = harness(at(420), result);
    await runRehearsalTick({ ledgerRoot: root, apply: true, checkout: '/fake/checkout' }, h.deps);
    expect(stamp(root, 'rc-7h')).toMatchObject({ outcome: 'error', result });
    expect(h.calls).toEqual([schedule.version]);
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]).toStartWith('⛔ 리허설');
    expect(h.notifications[0]).toContain('· error ·');
    expect(h.notifications[0]).toContain(`gate rc ${result.gateExitCode}`);
    if (!result.ok) expect(h.notifications[0]).toContain('RC 실패');
    expect(h.notifications[0]).not.toContain('· ok ·');
  }
});

test('a cut rescheduled after rc-7h claim still cannot execute rc-7h again for that version', async () => {
  const root = newRoot(), h = harness(at(420));
  await runRehearsalTick({ ledgerRoot: root, apply: true, checkout: '/fake/checkout' }, h.deps);
  const moved = { ...schedule, cutAt: new Date(Date.parse(cut) + 60 * 60_000).toISOString() };
  h.deps.schedules = () => [moved];
  const next = await runRehearsalTick({ ledgerRoot: root, apply: true, checkout: '/fake/checkout' }, h.deps);
  expect(next).toMatchObject({ status: 'not-yet', nextStepAt: new Date(Date.parse(moved.cutAt) - 150 * 60_000).toISOString() });
  expect(h.calls).toEqual([schedule.version]);
  expect(stamp(root, 'rc-7h').cutAt).toBe(cut);
});

test('empty, elapsed, not-yet and preview do not touch git, RC, notifications or stamp directory', async () => {
  for (const [schedules, now, expected] of [[[], at(420), 'no-schedule'], [[schedule], new Date(cut), 'no-schedule'], [[schedule], at(540), 'not-yet'], [[schedule], at(420), 'due']] as const) {
    const root = newRoot(), h = harness(now);
    h.deps.schedules = () => [...schedules];
    const result = await runRehearsalTick({ ledgerRoot: root, checkout: '/fake/checkout', apply: expected === 'due' ? false : true }, h.deps);
    expect(result.status).toBe(expected);
    expect(h.calls).toEqual([]);
    expect(h.notifications).toEqual([]);
    expect(h.gitCalls).toEqual([]);
    expect(existsSync(join(root, 'release', schedule.version, 'rehearsal'))).toBe(false);
  }
});

test('CLI preview is read-only and JSON remains one line; loop registry names the cron graph', async () => {
  const root = newRoot();
  setElanousConfigDir(root);
  const program = new Command();
  registerReleaseCommands(program, { ledgerRoot: root });
  const output: string[] = [];
  const oldWrite = process.stdout.write, oldError = console.error;
  try {
    process.stdout.write = ((chunk: string) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write;
    console.error = () => {};
    await program.parseAsync(['release', 'rehearsal', 'tick', '--json'], { from: 'user' });
  } finally { process.stdout.write = oldWrite; console.error = oldError; }
  expect(output).toHaveLength(1);
  expect(JSON.parse(output[0]!)).toMatchObject({ ok: true, status: 'no-schedule' });
  expect(existsSync(join(root, 'release', schedule.version, 'rehearsal'))).toBe(false);
  const repo = resolve(import.meta.dir, '..', '..');
  const loop = listLoops({ root: repo, stateRoot: root, schedules: [] }).find(item => item.id === 'release-rehearsal');
  expect(loop).toMatchObject({ id: 'release-rehearsal', trigger: { cron: '*/15 * * * *' }, file: 'graphs/release-rehearsal/release-rehearsal.yaml' });
});

test('CLI apply accepts injected clock and checkout, emits one JSON result and claims once', async () => {
  const root = newRoot(), h = harness(at(420));
  setElanousConfigDir(root);
  const cli = new Command();
  registerReleaseCommands(cli, { ledgerRoot: root }, {}, {}, {}, h.deps);
  const output: string[] = [];
  const original = process.stdout.write;
  const oldError = console.error;
  const exit = process.exitCode;
  try {
    process.exitCode = 0;
    process.stdout.write = ((chunk: string) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write;
    console.error = () => {};
    await cli.parseAsync(['release', 'rehearsal', 'tick', '--apply', '--checkout', '/fake/checkout', '--json'], { from: 'user' });
    await cli.parseAsync(['release', 'rehearsal', 'tick', '--apply', '--checkout', '/fake/checkout', '--json'], { from: 'user' });
    expect(process.exitCode).toBe(0);
  } finally { process.exitCode = exit; process.stdout.write = original; console.error = oldError; }
  expect(output).toHaveLength(2);
  expect(JSON.parse(output[0]!)).toMatchObject({ ok: true, status: 'due', stamps: [{ outcome: 'ok' }] });
  expect(JSON.parse(output[1]!)).toMatchObject({ ok: true, status: 'not-yet' });
  expect(h.calls).toEqual([schedule.version]);
  expect(stamp(root, 'rc-7h').sha).toBe('1234567890abcdef');
});

test('CLI apply reports unmeasured and no-checkout as failures without suppressing the stamped outcome', async () => {
  for (const missing of [false, true]) {
    const root = newRoot(), h = harness(at(420), rc({ introduced: null, ok: false }));
    setElanousConfigDir(root);
    const cli = new Command();
    registerReleaseCommands(cli, { ledgerRoot: root }, {}, {}, {}, h.deps);
    const output: string[] = [];
    const original = process.stdout.write, oldError = console.error, exit = process.exitCode;
    const env = process.env.ELANOUS_REHEARSAL_GIT_CWD;
    try {
      delete process.env.ELANOUS_REHEARSAL_GIT_CWD;
      process.exitCode = 0;
      process.stdout.write = ((chunk: string) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write;
      console.error = () => {};
      await cli.parseAsync(['release', 'rehearsal', 'tick', '--apply', ...(missing ? [] : ['--checkout', '/fake/checkout']), '--json'], { from: 'user' });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = exit;
      process.stdout.write = original;
      console.error = oldError;
      if (env === undefined) delete process.env.ELANOUS_REHEARSAL_GIT_CWD; else process.env.ELANOUS_REHEARSAL_GIT_CWD = env;
    }
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ ok: false, stamps: [{ outcome: missing ? 'no-checkout' : 'unmeasured' }] });
    expect(h.calls).toHaveLength(missing ? 0 : 1);
    expect(h.notifications).toHaveLength(1);
  }
});

test('CLI exposes failed notification in JSON and retries delivery without rerunning RC', async () => {
  const root = newRoot(), h = harness(at(420));
  h.deps.notify = () => false;
  setElanousConfigDir(root);
  const cli = new Command();
  registerReleaseCommands(cli, { ledgerRoot: root }, {}, {}, {}, h.deps);
  const output: string[] = [];
  const original = process.stdout.write, oldError = console.error, exit = process.exitCode;
  try {
    process.stdout.write = ((chunk: string) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write;
    console.error = () => {};
    process.exitCode = 0;
    await cli.parseAsync(['release', 'rehearsal', 'tick', '--apply', '--checkout', '/fake/checkout', '--json'], { from: 'user' });
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ ok: false, notificationFailures: 1, stamps: [{ outcome: 'ok' }] });
    h.deps.notify = (text) => { h.notifications.push(text); return true; };
    process.exitCode = 0;
    await cli.parseAsync(['release', 'rehearsal', 'tick', '--apply', '--checkout', '/fake/checkout', '--json'], { from: 'user' });
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(output[1]!)).toMatchObject({ ok: true, notificationFailures: 0 });
  } finally { process.exitCode = exit; process.stdout.write = original; console.error = oldError; }
  expect(h.calls).toEqual([schedule.version]);
  expect(h.notifications).toHaveLength(1);
});

test('CLI apply marks a failed RC gate as failed JSON, not a successful rehearsal', async () => {
  const root = newRoot(), h = harness(at(420), rc({ introduced: 0, unclassified: 0, gateExitCode: 1, ok: false }));
  setElanousConfigDir(root);
  const cli = new Command();
  registerReleaseCommands(cli, { ledgerRoot: root }, {}, {}, {}, h.deps);
  const output: string[] = [];
  const original = process.stdout.write, oldError = console.error, exit = process.exitCode;
  try {
    process.exitCode = 0;
    process.stdout.write = ((chunk: string) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write;
    console.error = () => {};
    await cli.parseAsync(['release', 'rehearsal', 'tick', '--apply', '--checkout', '/fake/checkout', '--json'], { from: 'user' });
    expect(process.exitCode).toBe(1);
  } finally { process.exitCode = exit; process.stdout.write = original; console.error = oldError; }
  expect(output).toHaveLength(1);
  expect(JSON.parse(output[0]!)).toMatchObject({ ok: false, stamps: [{ outcome: 'error', result: { ok: false, gateExitCode: 1 } }] });
  expect(h.notifications).toHaveLength(1);
  expect(h.notifications[0]).toStartWith('⛔ 리허설');
});

test('graph tick routes a successful JSON recipe outcome to done and errors to failed', async () => {
  const root = newRoot();
  const graph = join(import.meta.dir, '..', '..', 'graphs', 'release-rehearsal', 'release-rehearsal.yaml');
  const recipe = parseYaml(readFileSync(join(import.meta.dir, '..', '..', 'graphs', 'release-rehearsal', 'recipes.yaml'), 'utf8')) as { tick: { command: string; timeout_ms: number } };
  expect(recipe.tick.timeout_ms).toBe(5_400_000);
  expect(recipe.tick.command).toContain('ELANOUS_REHEARSAL_GIT_CWD');
  expect(recipe.tick.command).toContain('"--apply", "--json"');
  for (const [exitCode, expected] of [[0, 'done'], [1, 'failed']] as const) {
    const result = await runGraph(graph, { deps: { root, runBash: async (command) => {
      expect(command).toBe(recipe.tick.command);
      return { stdout: exitCode ? '' : '{"outcome":"ok"}', stderr: exitCode ? 'simulated error' : '', exitCode };
    } } });
    expect(result.status).toBe(expected);
  }
});

test('recipe actually launches in configured checkout and passes the CLI JSON into the graph', () => {
  const root = newRoot(), bin = join(root, 'bin'), checkout = join(root, 'checkout');
  mkdirSync(bin);
  mkdirSync(checkout);
  const seen = join(root, 'invoked');
  writeFileSync(join(bin, 'bun'), `#!/bin/sh\nif [ "$1" = "-e" ]; then exec "${Bun.which('bun')}" "$@"; fi\npwd > "${seen}"\nprintf '{"ok":true,"status":"no-schedule"}\\n'\n`);
  chmodSync(join(bin, 'bun'), 0o755);
  const recipe = parseYaml(readFileSync(join(import.meta.dir, '..', '..', 'graphs', 'release-rehearsal', 'recipes.yaml'), 'utf8')) as { tick: { command: string } };
  const result = spawnSync('/bin/bash', ['-c', recipe.tick.command], { cwd: import.meta.dir,
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ELANOUS_GRAPH_DIR: join(import.meta.dir, '..', '..', 'graphs', 'release-rehearsal'), ELANOUS_REHEARSAL_GIT_CWD: checkout } });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'ok', tick: { ok: true, status: 'no-schedule' } });
  expect(realpathSync(readFileSync(seen, 'utf8').trim())).toBe(realpathSync(checkout));
});
