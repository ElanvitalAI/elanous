import { afterEach, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { runNexus } from '../nexus/index.js';
import { setTestStateRoot } from '../nexus/paths.js';
import { listHarnessParents, measureDiskIoPressure, measureHarnessParents, measureLoad, parseHarnessParentPs, readMemberToken, startMemberHeartbeat } from './member.js';
import { resolvePrimary, writePrimaryJoin } from './primary.js';
import { ResourceLedger } from './ledger.js';

const roots: string[] = [];
afterEach(() => {
  setTestStateRoot(null);
  resetElanousConfigDir();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('heartbeat timed out');
    await Bun.sleep(5);
  }
}

const options = {
  coordinatorUrl: 'http://127.0.0.1:31413',
  token: 'secret-not-for-logs',
  machine: { id: 'machine:local', name: 'local' },
  instance: { id: 'instance:local:test', name: 'nexus', endpoint: 'http://127.0.0.1:43210', attrs: { port: 43210 } },
  intervalMs: 20,
};

test('registers machine and actual-port instance once, then sends two load heartbeats and stops', async () => {
  const calls: Array<{ path: string; body: any; auth: string | null }> = [];
  let sample = 0;
  const measure = async (now: () => number, baseline: { value: number }) => {
    sample++;
    return measureLoad(now, baseline, {
      listParents: async () => ({ status: 'ok', records: [
        { pid: 10, elapsedSeconds: 100 + sample, command: 'bun /same/elanous.mjs harness say x', version: 'old-at-start' },
        { pid: 11, elapsedSeconds: 30, command: 'bun /same/elanous.mjs harness ask x', version: 'new-at-start' },
      ] }),
      currentVersion: 'new-at-start',
      diskIo: at => measureDiskIoPressure(at, { platform: 'linux', readPressure: () =>
        `some avg10=${sample}.25 avg60=0 total=0\nfull avg10=0.50 avg60=0 total=0\n` }),
    });
  };
  const stop = startMemberHeartbeat({ ...options, now: () => 1234, measure, fetch: async (input, init) => {
    calls.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get('authorization') });
    return Response.json({ ok: true });
  } });
  try {
    await until(() => calls.length >= 4);
    expect(calls.map(c => c.path)).toEqual([
      '/v1/resources/register', '/v1/resources/register',
      '/v1/resources/machine%3Alocal/heartbeat', '/v1/resources/machine%3Alocal/heartbeat',
    ]);
    expect(calls[0]?.body).toMatchObject({ id: 'machine:local', kind: 'machine', machine: 'local' });
    for (const [index, call] of [calls[0], ...calls.slice(2)].entries()) {
      const load = call?.body.attrs.load;
      expect(load.harnessParents).toEqual({
        count: { source: 'ps:harness-processes', observedAt: 1234, status: 'ok', value: 2 },
        oldestAgeSeconds: { source: 'ps:harness-processes', observedAt: 1234, status: 'ok', value: 101 + index },
        versionMismatchCount: { source: 'ps:harness-processes', observedAt: 1234, status: 'ok', value: 1 },
      });
      expect(load.diskIo).toEqual({
        pageouts: { source: 'vm_stat:pageouts', observedAt: 1234, status: 'unmeasured', value: null, reason: 'platform' },
        io: { source: '/proc/pressure/io', observedAt: 1234, status: 'ok', value: { someAvg10: index + 1.25, fullAvg10: 0.5 } },
      });
    }
    expect(calls[1]?.body).toMatchObject({ kind: 'instance', endpoint: options.instance.endpoint, attrs: { port: 43210 } });
    expect(calls.slice(0, 2).map(call => call.auth)).toEqual(Array(2).fill(`Bearer ${options.token}`));
    for (const call of calls.slice(2)) {
      expect(call.body.attrs.load).toMatchObject({ loadAvg: expect.any(Array), cpuCount: expect.any(Number), observedAt: 1234 });
      expect(call.auth).toBe(`Bearer ${options.token}`);
    }
    const count = calls.length;
    stop();
    await Bun.sleep(50);
    expect(calls).toHaveLength(count);
  } finally { stop(); }
});

test('failed probes send unmeasured on registration and recurring heartbeat', async () => {
  const loads: any[] = [];
  const stop = startMemberHeartbeat({ ...options, now: () => 77,
    measure: (now, baseline) => measureLoad(now, baseline, {
      listParents: async () => { throw Error('ps unavailable'); },
      diskIo: () => Promise.reject(Error('io unavailable')),
    }),
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.attrs?.load) loads.push(body.attrs.load);
      return Response.json({});
    },
  });
  try {
    await until(() => loads.length >= 2);
    for (const load of loads.slice(0, 2)) {
      expect(load.harnessParents).toEqual({
        count: { source: 'ps:harness-processes', observedAt: 77, status: 'unmeasured', value: null, reason: 'ps-exec' },
        oldestAgeSeconds: { source: 'ps:harness-processes', observedAt: 77, status: 'unmeasured', value: null, reason: 'ps-exec' },
        versionMismatchCount: { source: 'ps:harness-processes', observedAt: 77, status: 'unmeasured', value: null, reason: 'ps-exec' },
      });
      expect(load.diskIo).toEqual({
        pageouts: { source: 'vm_stat:pageouts', observedAt: 77, status: 'unmeasured', value: null, reason: 'probe-failed' },
        io: { source: '/proc/pressure/io', observedAt: 77, status: 'unmeasured', value: null, reason: 'probe-failed' },
      });
    }
  } finally { stop(); }
});

test('machine heartbeat merges measured load without changing the ledger record format', async () => {
  const root = mkdtempSync(join(tmpdir(), 'control-member-ledger-'));
  roots.push(root);
  const ledger = new ResourceLedger(root);
  const sent: string[] = [];
  const stop = startMemberHeartbeat({ ...options, machine: { ...options.machine, attrs: { duties: ['observe'] } }, now: () => 42,
    measure: (now, baseline) => measureLoad(now, baseline, {
      listParents: async () => ({ status: 'ok', records: [{ pid: 1, command: 'bun /same/elanous.mjs harness say x', elapsedSeconds: 92 }] }),
      diskIo: at => measureDiskIoPressure(at, { platform: 'linux', readPressure: () =>
        'some avg10=2.50 avg60=0 total=0\nfull avg10=0.25 avg60=0 total=0\n' }),
    }),
    fetch: async (input, init) => {
      const body = JSON.parse(String(init?.body));
      const path = new URL(String(input)).pathname;
      sent.push(path);
      if (path.endsWith('/register')) ledger.register(body, 'member-a');
      else ledger.heartbeat('machine:local', 'member-a', body.attrs, 43);
      return Response.json({});
    },
  });
  try {
    await until(() => sent.length >= 3);
    const rows = JSON.parse(readFileSync(ledger.path, 'utf8'));
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[0]).sort()).toEqual(['attrs', 'id', 'kind', 'machine', 'name', 'observedAt', 'owner', 'ttlMs']);
    expect(rows[0].attrs.load.harnessParents).toMatchObject({ count: { status: 'ok', value: 1 },
      oldestAgeSeconds: { status: 'ok', value: 92 }, versionMismatchCount: { status: 'unmeasured', value: null } });
    expect(rows[0].attrs.load.diskIo.io).toMatchObject({ status: 'ok', value: { someAvg10: 2.5, fullAvg10: 0.25 } });
    expect(rows[0].attrs.duties).toEqual(['observe']);
    expect(rows[0].observedAt).toBe(43);
    expect(rows[1].attrs).toEqual({ port: 43210 });
  } finally { stop(); }
});

test('default heartbeat interval is thirty seconds', async () => {
  const scheduled: number[] = [];
  const realTimeout = globalThis.setTimeout;
  const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms: number) => {
    if (ms < 30_000) return realTimeout(fn, ms);
    scheduled.push(ms);
    return { unref() {} } as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  const { intervalMs: _intervalMs, ...defaults } = options;
  const stop = startMemberHeartbeat({ ...defaults, fetch: async () => Response.json({}) });
  try {
    await until(() => scheduled.length === 1);
    expect(scheduled).toEqual([30_000]);
  } finally { stop(); timerSpy.mockRestore(); }
});

test('measurement omits unknown running-run and Pod-slot fields rather than inventing zero', async () => {
  const load = await measureLoad(() => 27);
  expect(load.loadAvg).toHaveLength(3);
  expect(load.cpuCount).toBeGreaterThan(0);
  expect(load.freeMem).toBeGreaterThanOrEqual(0);
  expect(load.totalMem).toBeGreaterThan(0);
  expect(load.observedAt).toBe(27);
  expect(load).not.toHaveProperty('runningRuns');
  expect(load).not.toHaveProperty('podSlots');
});

test('ps harness parents parse elapsed days and reject incomplete observations', () => {
  expect(parseHarnessParentPs('  10 01:20 bun /a/elanous.mjs harness ask x\n  11 2-03:04:05 bun /a/elanous.mjs harness say y\n'))
    .toMatchObject({ status: 'ok', records: [
      { pid: 10, elapsedSeconds: 80, command: 'bun /a/elanous.mjs harness ask x' },
      { pid: 11, elapsedSeconds: 183845, command: 'bun /a/elanous.mjs harness say y' },
    ] });
  expect(parseHarnessParentPs('10 bad bun /a/elanous.mjs harness say x\n').status).toBe('incomplete');
  expect(parseHarnessParentPs('10 01:20 bash -c "bun /a/elanous.mjs harness say x"\n'))
    .toMatchObject({ status: 'ok', records: [] });
  expect(parseHarnessParentPs('').status).toBe('incomplete');
});

test('ps probe is asynchronous, bounded and fails as unmeasured', async () => {
  let finish!: (result: { stdout: string; stderr: string }) => void;
  const pending = new Promise<{ stdout: string; stderr: string }>(resolve => { finish = resolve; });
  const calls: unknown[] = [];
  const seenPids: number[] = [];
  const reading = listHarnessParents(((file: string, args: string[], options: object) => {
    calls.push({ file, args, options });
    return pending;
  }) as Parameters<typeof listHarnessParents>[0], async pid => {
    seenPids.push(pid);
    return 'old-at-start';
  });
  expect(calls).toEqual([{ file: 'ps', args: ['-axo', 'pid=,etime=,command='],
    options: { encoding: 'utf8', timeout: 2_000, maxBuffer: 4 * 1024 * 1024 } }]);
  let eventLoopAdvanced = false;
  await new Promise<void>(resolve => setTimeout(() => { eventLoopAdvanced = true; resolve(); }, 0));
  expect(eventLoopAdvanced).toBe(true);
  finish({ stdout: '10 00:10 bun /same/elanous.mjs harness say x\n', stderr: '' });
  expect(await reading).toMatchObject({ status: 'ok', records: [{ pid: 10, elapsedSeconds: 10, version: 'old-at-start' }] });
  expect(seenPids).toEqual([10]);
  let release!: (value: string) => void;
  const unavailable = new Promise<string>(resolve => { release = resolve; });
  const waiting = listHarnessParents((async () => ({ stdout: '10 00:10 bun /same/elanous.mjs harness say x\n', stderr: '' })) as unknown as NonNullable<Parameters<typeof listHarnessParents>[0]>,
    () => unavailable);
  let progressed = false;
  await new Promise<void>(resolve => setTimeout(() => { progressed = true; resolve(); }, 0));
  expect(progressed).toBe(true);
  release('new-at-start');
  expect((await waiting).records?.[0]?.version).toBe('new-at-start');
  expect(measureHarnessParents(9, await listHarnessParents((async () => { throw Error('timeout'); }) as unknown as NonNullable<Parameters<typeof listHarnessParents>[0]>)).count)
    .toEqual({ source: 'ps:harness-processes', observedAt: 9, status: 'unmeasured', value: null, reason: 'ps-exec' });
});

test('harness parent summary counts parents and only compares startup-stamped versions', () => {
  const list = { status: 'ok' as const, records: [
    { pid: 10, elapsedSeconds: 3600, command: 'bun /install/current/elanous.mjs harness say x', version: 'old-startup' },
    { pid: 11, elapsedSeconds: 120, command: 'bun /install/current/elanous.mjs harness ask x', version: 'current-startup' },
    { pid: 12, elapsedSeconds: 9999, command: 'other process' },
  ] };
  const result = measureHarnessParents(27, list, 'current-startup');
  expect(result).toEqual({
    count: { value: 2, status: 'ok', observedAt: 27, source: 'ps:harness-processes' },
    oldestAgeSeconds: { value: 3600, status: 'ok', observedAt: 27, source: 'ps:harness-processes' },
    versionMismatchCount: { value: 1, status: 'ok', observedAt: 27, source: 'ps:harness-processes' },
  });
  const empty = measureHarnessParents(27, { status: 'ok', records: [] });
  expect(empty.versionMismatchCount.value).toBe(0);
  expect(empty.oldestAgeSeconds).toMatchObject({ value: null, status: 'unmeasured', reason: 'no-parents' });
  const failed = measureHarnessParents(27, { status: 'failed', stage: 'ps-exec' });
  expect(Object.values(failed).map(metric => metric.value)).toEqual([null, null, null]);
  expect(Object.values(failed).map(metric => metric.status)).toEqual(['unmeasured', 'unmeasured', 'unmeasured']);
  const unknown = measureHarnessParents(27, { status: 'ok', records: [
    { pid: 10, elapsedSeconds: 10, command: 'bun /install/current/elanous.mjs harness say x' },
  ] }, 'current-startup');
  expect(unknown.count.value).toBe(1);
  expect(unknown.versionMismatchCount).toMatchObject({ status: 'unmeasured', value: null, reason: 'version-unavailable' });
  expect(measureHarnessParents(27, list).versionMismatchCount.status).toBe('unmeasured');
  expect(measureHarnessParents(27, { status: 'incomplete', stage: 'ps-parse', records: [] }).count.value).toBeNull();
});

test('disk I/O reports platform-specific measurements and explicitly marks unsupported or invalid readings', async () => {
  expect(await measureDiskIoPressure(27, { platform: 'darwin', vmStat: () => 'Pages paged out: 1,234.\n' })).toEqual({
    pageouts: { status: 'ok', value: 1234, source: 'vm_stat:pageouts', observedAt: 27 },
    io: { status: 'unmeasured', value: null, source: '/proc/pressure/io', observedAt: 27, reason: 'platform' },
  });
  // Real macOS (Darwin 27) vm_stat line shape.
  expect((await measureDiskIoPressure(27, { platform: 'darwin', vmStat: () => 'Pageins:                                      9.\nPageouts:                                      55871.\n' })).pageouts)
    .toEqual({ status: 'ok', value: 55871, source: 'vm_stat:pageouts', observedAt: 27 });
  expect(await measureDiskIoPressure(27, { platform: 'linux', readPressure: () =>
    'some avg10=0.25 avg60=0.50 avg300=0.75 total=8\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n' })).toEqual({
    pageouts: { status: 'unmeasured', value: null, source: 'vm_stat:pageouts', observedAt: 27, reason: 'platform' },
    io: { status: 'ok', value: { someAvg10: 0.25, fullAvg10: 0 }, source: '/proc/pressure/io', observedAt: 27 },
  });
  const baseline = { value: Number.NaN };
  const vmStat = () => 'Pages paged out: 1,234.\n';
  expect((await measureDiskIoPressure(27, { platform: 'darwin', vmStat }, baseline)).pageouts)
    .toMatchObject({ status: 'unmeasured', value: null, reason: 'baseline-unavailable' });
  expect((await measureDiskIoPressure(28, { platform: 'darwin', vmStat: () => 'Pages paged out: 1,240.\n' }, baseline)).pageouts)
    .toMatchObject({ status: 'ok', value: 6 });
  expect((await measureDiskIoPressure(27, { platform: 'darwin', vmStat: () => 'no pageouts' })).pageouts)
    .toMatchObject({ status: 'unmeasured', value: null, reason: 'invalid-output' });
  expect((await measureDiskIoPressure(27, { platform: 'linux', readPressure: () => { throw Error(); } })).io)
    .toMatchObject({ status: 'unmeasured', value: null, reason: 'pressure-read-failed' });
  let finish!: (text: string) => void;
  const delayed = new Promise<string>(resolve => { finish = resolve; });
  const reading = measureDiskIoPressure(27, { platform: 'darwin', vmStat: () => delayed });
  let advanced = false;
  await new Promise<void>(resolve => setTimeout(() => { advanced = true; resolve(); }, 0));
  expect(advanced).toBe(true);
  finish('Pages paged out: 20.\n');
  expect((await reading).pageouts).toMatchObject({ status: 'ok', value: 20 });
});

test('retry suppresses identical failure reasons, logs a changed reason, and does not leak the token', async () => {
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  let attempts = 0;
  const stop = startMemberHeartbeat({ ...options, intervalMs: 10, fetch: async () => {
    attempts++;
    return new Response('', { status: attempts < 3 ? 503 : 401 });
  } });
  try {
    await until(() => attempts >= 4);
    const failures = log.mock.calls.filter(([category, event]) => category === 'control.member' && event === 'heartbeat-failed');
    expect(failures.map(([, , data]) => data)).toEqual([{ reason: 'http-503' }, { reason: 'http-401' }]);
    expect(JSON.stringify(failures)).not.toContain(options.token);
  } finally { stop(); log.mockRestore(); }
});

test('same failure reason after a successful tick is logged only once', async () => {
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  let attempts = 0;
  const stop = startMemberHeartbeat({ ...options, intervalMs: 20, fetch: async () => {
    attempts++;
    return new Response('', { status: attempts === 1 || attempts === 4 ? 503 : 200 });
  } });
  try {
    await until(() => attempts >= 4);
    await Bun.sleep(5);
    const failures = log.mock.calls.filter(([category, event]) => category === 'control.member' && event === 'heartbeat-failed');
    expect(failures.map(([, , data]) => data)).toEqual([{ reason: 'http-503' }]);
  } finally { stop(); log.mockRestore(); }
});

test('failed registration retries with exponential delays capped at five minutes; stop cancels the timer', async () => {
  const delays: number[] = [];
  let next: (() => void) | undefined;
  let cleared = false;
  const realTimeout = globalThis.setTimeout;
  const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms: number) => {
    if (ms < 3_000) return realTimeout(fn, ms);
    delays.push(ms);
    next = fn;
    return { unref() {} } as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  const clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation((() => { cleared = true; }) as typeof clearTimeout);
  const stop = startMemberHeartbeat({ ...options, intervalMs: 30_000, fetch: async () => new Response('', { status: 503 }) });
  try {
    await until(() => delays.length === 1);
    for (let i = 1; i < 7; i++) {
      next?.();
      await until(() => delays.length === i + 1);
    }
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
    stop();
    expect(cleared).toBe(true);
  } finally { stop(); timerSpy.mockRestore(); clearSpy.mockRestore(); }
});

test('ten-minute intervals and longer cannot outlive the registration TTL before the first heartbeat', async () => {
  let fetches = 0;
  for (const intervalMs of [600_000, 600_001]) {
    expect(() => startMemberHeartbeat({ ...options, intervalMs, fetch: async () => {
      fetches++;
      return Response.json({});
    } })).toThrow('invalid member heartbeat interval');
  }
  await Promise.resolve();
  expect(fetches).toBe(0);

  const scheduled: number[] = [];
  const calls: Array<{ body: any; path: string }> = [];
  let advance: (() => void) | undefined;
  const realTimeout = globalThis.setTimeout;
  const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms: number) => {
    if (ms < 300_000) return realTimeout(fn, ms);
    scheduled.push(ms);
    advance = fn;
    return { unref() {} } as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  const stop = startMemberHeartbeat({ ...options, intervalMs: 300_000, fetch: async (input, init) => {
    calls.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
    return Response.json({});
  } });
  try {
    await until(() => calls.length === 2 && scheduled.length === 1);
    expect(calls.map(call => call.body.ttlMs)).toEqual([600_000, 600_000]);
    expect(scheduled).toEqual([300_000]);
    advance?.();
    await until(() => calls.length === 4 && scheduled.length === 2);
    expect(calls.slice(2).map(call => call.path)).toEqual([
      '/v1/resources/machine%3Alocal/heartbeat',
      '/v1/resources/instance%3Alocal%3Atest/heartbeat',
    ]);
    expect(calls[2]?.body.attrs.load).toHaveProperty('cpuCount');
  } finally { stop(); timerSpy.mockRestore(); }
});

test('maximum interval timeout retries before the TTL boundary; 404 re-registers immediately', async () => {
  let elapsed = 0;
  const timers: Array<{ ms: number; run: () => void }> = [];
  const paths: string[] = [];
  const realTimeout = globalThis.setTimeout;
  const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms: number) => {
    if (ms < 5 && ms !== 0) return realTimeout(fn, ms);
    timers.push({ ms, run: fn });
    return { unref() {} } as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  const advance = async (ms: number): Promise<void> => {
    const index = timers.findIndex(timer => timer.ms === ms);
    expect(index).toBeGreaterThanOrEqual(0);
    const [timer] = timers.splice(index, 1);
    elapsed += ms;
    timer!.run();
    await until(() => timers.length > 0);
  };
  const stop = startMemberHeartbeat({ ...options, intervalMs: 300_000, now: () => elapsed,
    measure: (now, baseline) => measureLoad(now, baseline, {
      listParents: async () => ({ status: 'ok', records: [] }),
      diskIo: at => measureDiskIoPressure(at, { platform: 'other' as NodeJS.Platform }),
    }),
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (paths.length === 3) return new Promise<Response>((_, reject) => {
        setTimeout(() => reject(new Error('timeout')), 5_000);
      });
      if (paths.length === 6) return new Response('', { status: 404 });
      return Response.json({});
    },
  });
  try {
    await until(() => timers.some(timer => timer.ms === 300_000));
    await advance(300_000);
    await advance(5_000);
    expect(timers.some(timer => timer.ms === 30_000)).toBe(true);
    await advance(30_000);
    // measureLoad is async now: the tick posts after an awaited measure, so wait for the posts, not just a timer.
    await until(() => paths.length >= 5);
    expect(elapsed).toBe(335_000);
    expect(paths.slice(0, 5)).toEqual([
      '/v1/resources/register', '/v1/resources/register',
      '/v1/resources/machine%3Alocal/heartbeat',
      '/v1/resources/machine%3Alocal/heartbeat',
      '/v1/resources/instance%3Alocal%3Atest/heartbeat',
    ]);
    await advance(300_000);
    await until(() => timers.some(timer => timer.ms === 0));
    expect(timers.some(timer => timer.ms === 0)).toBe(true);
    await advance(0);
    await until(() => paths.length >= 8);
    expect(paths.slice(5, 8)).toEqual([
      '/v1/resources/machine%3Alocal/heartbeat',
      '/v1/resources/register', '/v1/resources/register',
    ]);
  } finally { stop(); timerSpy.mockRestore(); }
});

test('404 heartbeat re-registers both records before resuming', async () => {
  const calls: string[] = [];
  const stop = startMemberHeartbeat({ ...options, fetch: async (input) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    return new Response('', { status: calls.length === 3 ? 404 : 200 });
  } });
  try {
    await until(() => calls.length >= 5);
    expect(calls.slice(0, 5)).toEqual([
      '/v1/resources/register', '/v1/resources/register',
      '/v1/resources/machine%3Alocal/heartbeat',
      '/v1/resources/register', '/v1/resources/register',
    ]);
  } finally { stop(); }
});

test('member credential prefers the joined member scope, with a read-only local fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'control-member-choice-'));
  roots.push(root);
  const local = 'a'.repeat(64);
  const joined = 'b'.repeat(64);
  mkdirSync(join(root, 'control'));
  writeFileSync(join(root, 'control', 'tokens.json'), JSON.stringify({ member: local }));
  expect(readMemberToken(root)).toBe(local);
  writePrimaryJoin({ url: 'https://primary.example', tokens: { member: joined } }, root);
  expect(readMemberToken(root)).toBe(joined);
  writePrimaryJoin({ url: 'https://primary.example', tokens: { query: 'c'.repeat(64) } }, root);
  expect(readMemberToken(root)).toBe(local);
  expect(resolvePrimary({ root, role: 'member' }).token).toBeUndefined();
  chmodSync(join(root, 'control', 'join.json'), 0o644);
  expect(readMemberToken(root)).toBe(local);
  writeFileSync(join(root, 'control', 'tokens.json'), JSON.stringify({ member: 'invalid' }));
  expect(readMemberToken(root)).toBeUndefined();
  writePrimaryJoin({ url: 'https://primary.example', tokens: { member: joined } }, root);
  expect(readMemberToken(root)).toBe(joined);
  expect(existsSync(join(root, 'control', 'member-tokens.json'))).toBe(false);
});

test('missing member token keeps Nexus registration off despite an HTTP listener', async () => {
  const root = mkdtempSync(join(tmpdir(), 'control-member-missing-'));
  roots.push(root);
  setTestStateRoot(root);
  setElanousConfigDir(root);
  expect(readMemberToken(root)).toBeUndefined();
  const fetchSpy = spyOn(globalThis, 'fetch');
  const logSpy = spyOn(debug, 'log');
  let nexus: Awaited<ReturnType<typeof runNexus>>;
  try {
    nexus = await runNexus({ detachForTesting: true, skipHttpServer: false, skipSupervisor: true,
      skipRuntimeApi: true, registerDaemonTab: false, registerSettingsTab: false, mcpEnabled: false });
    expect(nexus?.httpServer?.port).toBeGreaterThan(0);
    await Bun.sleep(30);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(logSpy.mock.calls.filter(([category, event]) =>
      category === 'control.member' && event === 'start-skipped')).toHaveLength(1);
  } finally { nexus?.release(); fetchSpy.mockRestore(); logSpy.mockRestore(); }
});

test('Nexus registers to the joined Primary with its member credential', async () => {
  const root = mkdtempSync(join(tmpdir(), 'control-member-joined-'));
  roots.push(root);
  setTestStateRoot(root);
  setElanousConfigDir(root);
  const joined = 'b'.repeat(64);
  mkdirSync(join(root, 'control'));
  writeFileSync(join(root, 'control', 'tokens.json'), JSON.stringify({ member: 'a'.repeat(64) }));
  writePrimaryJoin({ url: 'https://primary.example:31413', tokens: { member: joined } }, root);
  const calls: Array<{ url: string; auth: string | null; body: any }> = [];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) });
      return Response.json({});
    }, { preconnect: globalThis.fetch.preconnect },
  ));
  let nexus: Awaited<ReturnType<typeof runNexus>>;
  try {
    nexus = await runNexus({ detachForTesting: true, skipHttpServer: false, skipSupervisor: true,
      skipRuntimeApi: true, registerDaemonTab: false, registerSettingsTab: false, mcpEnabled: false });
    await until(() => calls.length === 2);
    expect(calls.map(call => call.url)).toEqual(Array(2).fill('https://primary.example:31413/v1/resources/register'));
    expect(calls.map(call => call.auth)).toEqual(Array(2).fill(`Bearer ${joined}`));
    expect(calls[0]?.body.kind).toBe('machine');
    expect(calls[1]?.body).toMatchObject({ kind: 'instance', endpoint: nexus?.httpServer?.url });
    expect(readMemberToken(root)).toBe(joined);
  } finally { nexus?.release(); fetchSpy.mockRestore(); }
});

test('Nexus does not send a local member credential to a joined Primary without member scope', async () => {
  const root = mkdtempSync(join(tmpdir(), 'control-member-scoped-'));
  roots.push(root);
  setTestStateRoot(root);
  setElanousConfigDir(root);
  mkdirSync(join(root, 'control'));
  writeFileSync(join(root, 'control', 'tokens.json'), JSON.stringify({ member: 'a'.repeat(64) }));
  writePrimaryJoin({ url: 'https://primary.example:31413', tokens: { query: 'c'.repeat(64) } }, root);
  const fetchSpy = spyOn(globalThis, 'fetch');
  let nexus: Awaited<ReturnType<typeof runNexus>>;
  try {
    nexus = await runNexus({ detachForTesting: true, skipHttpServer: false, skipSupervisor: true,
      skipRuntimeApi: true, registerDaemonTab: false, registerSettingsTab: false, mcpEnabled: false });
    await Bun.sleep(30);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally { nexus?.release(); fetchSpy.mockRestore(); }
});

test('Nexus registers after binding the actual port without waiting for an unresponsive coordinator, and stops on release', async () => {
  const root = mkdtempSync(join(tmpdir(), 'control-member-bound-'));
  roots.push(root);
  setTestStateRoot(root);
  setElanousConfigDir(root);
  const member = 'f'.repeat(64);
  mkdirSync(join(root, 'control'));
  writeFileSync(join(root, 'control', 'tokens.json'), JSON.stringify({ member }));
  const calls: Array<{ path: string; body: any }> = [];
  let releaseFetch!: (value: Response) => void;
  const pending = new Promise<Response>(resolve => { releaseFetch = resolve; });
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
      return pending;
    }, { preconnect: globalThis.fetch.preconnect },
  ));
  let nexus: Awaited<ReturnType<typeof runNexus>>;
  try {
    nexus = await runNexus({ detachForTesting: true, skipHttpServer: false, skipSupervisor: true,
      skipRuntimeApi: true, registerDaemonTab: false, registerSettingsTab: false, mcpEnabled: false });
    expect(nexus?.httpServer?.port).toBeGreaterThan(0);
    await until(() => calls.length > 0);
    expect(calls[0]?.body.kind).toBe('machine');
    expect(nexus?.runtime.httpPort).toBe(nexus?.httpServer?.port);
    releaseFetch(Response.json({}));
    await until(() => calls.length > 1);
    expect(calls[1]?.body).toMatchObject({ kind: 'instance', endpoint: nexus?.httpServer?.url, attrs: { port: nexus?.httpServer?.port } });
    nexus?.release();
    const count = calls.length;
    await Bun.sleep(50);
    expect(calls).toHaveLength(count);
  } finally { releaseFetch(Response.json({})); nexus?.release(); fetchSpy.mockRestore(); }
});
