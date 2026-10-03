import { describe, expect, spyOn, test } from 'bun:test';

import { debug } from '../src/debug/log';
import { runPwaStop } from '../src/cli/pwa-stop';
import type { TailscaleProbe } from '../src/nexus/onboarding/tailscale-probe.js';

const TS_INSTALLED: TailscaleProbe = {
  installed: true,
  alive: true,
  binary: '/opt/homebrew/bin/tailscale',
  hostname: 'mbp',
  magicDnsHost: 'mbp.tail-abc.ts.net',
  ips: ['100.64.0.2'],
  backendState: 'Running',
};
const TS_MISSING: TailscaleProbe = { installed: false, alive: false };

interface CapturedOut {
  log: (s: string) => void;
  error: (s: string) => void;
  logs: string[];
  errors: string[];
}

function makeOut(): CapturedOut {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    log: (s) => logs.push(s),
    error: (s) => errors.push(s),
    logs,
    errors,
  };
}

describe('isolated nexus stop', () => {
  const root = '/tmp/one-tree/.elanous-test';
  const stop = (overrides: Parameters<typeof runPwaStop>[0] = {}) => runPwaStop({
    isolatedRoot: root,
    out: makeOut(),
    resolveNexusPwaFn: () => ({ status: 'absent', reason: 'daemon-absent' }),
    devStopFn: async () => ({ exitCode: 0, killed: false }),
    ...(overrides.readLockFn && !overrides.processTableFn && !overrides.psOutputFn
      ? { processTableFn: () => [{ pid: 12345, startedAt: 'Oct 03 00:29', args: `bun bin/elanous.mjs --config-dir ${root} --test-state-dir ${root} nexus run` }] }
      : {}),
    ...overrides,
  });

  test('reused locked PID belongs to another tree: do not signal it', async () => {
    const out = makeOut();
    const signals: string[] = [];
    const r = await stop({ out, readLockFn: () => ({ pid: 12345 }), pidAliveFn: () => true,
      processTableFn: () => [{ pid: 12345, startedAt: 'Oct 03 00:29', args: 'bun bin/elanous.mjs --config-dir /tmp/other/.elanous-test nexus run' }],
      signalFn: (pid, signal) => { signals.push(`${pid}:${signal}`); },
    });
    expect(r.exitCode).toBe(1);
    expect(out.errors).toEqual(["  pid 12345 does not match this tree's isolated nexus daemon; no signal sent"]);
    expect(signals).toEqual([]);
  });

  test('reused PID with matching argv but a later start time cannot be signaled', async () => {
    const out = makeOut();
    const signals: string[] = [];
    const r = await stop({ out, readLockFn: () => ({ pid: 12345, startedAt: '2026-10-02T15:00:00Z' }), pidAliveFn: () => true,
      processTableFn: () => [{ pid: 12345, startedAt: 'Fri Oct  2 16:00:00 2026', args: `bun bin/elanous.mjs --config-dir ${root} nexus run` }],
      signalFn: (pid, signal) => { signals.push(`${pid}:${signal}`); },
    });
    expect(r.exitCode).toBe(1);
    expect(out.errors).toEqual(['  pid 12345 start time cannot match the nexus lock; no signal sent']);
    expect(signals).toEqual([]);
  });

  test('locked PID is not a nexus daemon: no signal is sent', async () => {
    const signals: string[] = [];
    const r = await stop({ readLockFn: () => ({ pid: 12345 }), pidAliveFn: () => true,
      processTableFn: () => [{ pid: 12345, startedAt: 'Oct 03 00:29', args: `bun bin/elanous.mjs --test-state-dir ${root} chat` }],
      signalFn: (pid, signal) => { signals.push(`${pid}:${signal}`); },
    });
    expect(r.exitCode).toBe(1);
    expect(signals).toEqual([]);
  });

  test('dead locked PID still checks for another same-tree orphan', async () => {
    const out = makeOut();
    const signals: string[] = [];
    const r = await stop({ out, readLockFn: () => ({ pid: 12345 }), pidAliveFn: () => false,
      processTableFn: () => [{ pid: 22222, startedAt: 'Oct 03 01:00', args: `bun bin/elanous.mjs --test-state-dir ${root} nexus run` }],
      signalFn: (pid, signal) => { signals.push(`${pid}:${signal}`); },
    });
    expect(r.exitCode).toBe(1);
    expect(out.errors).toEqual([`  orphan pid 22222 · started Oct 03 01:00 · root ${root}`, '  cleanup: kill 22222']);
    expect(signals).toEqual([]);
  });

  test('dead locked PID and only other-tree daemons: nothing to stop', async () => {
    const out = makeOut();
    const r = await stop({ out, readLockFn: () => ({ pid: 12345 }), pidAliveFn: () => false,
      processTableFn: () => [{ pid: 22222, startedAt: 'Oct 03 01:00', args: 'bun bin/elanous.mjs --test-state-dir /tmp/other/.elanous-test nexus run' }],
    });
    expect(r.exitCode).toBe(0);
    expect(out.logs).toContain('  nothing to stop (no lock)');
  });

  test('recycled PID during SIGINT wait does not receive SIGTERM', async () => {
    const signals: string[] = [];
    const out = makeOut();
    let recycled = false;
    const r = await stop({ out, readLockFn: () => ({ pid: 12345 }), pidAliveFn: () => true,
      processTableFn: () => [{ pid: 12345, startedAt: recycled ? 'Oct 04 01:00' : 'Oct 03 00:29', args: `bun bin/elanous.mjs --test-state-dir ${root} nexus run` }],
      signalFn: (pid, signal) => { signals.push(`${pid}:${signal}`); recycled = true; },
      stopTimeoutMs: 100, sleepFn: async () => {},
    });
    expect(r.exitCode).toBe(1);
    expect(signals).toEqual(['12345:SIGINT']);
    expect(out.errors).toEqual(['  pid 12345 no longer matches the locked daemon; SIGTERM not sent']);
  });

  test('SIGINT exits: success only after the locked pid disappears', async () => {
    const signals: string[] = [];
    let alive = true;
    const out = makeOut();
    const r = await stop({ out, readLockFn: () => ({ pid: 12345 }),
      signalFn: (pid, signal) => { signals.push(`${pid}:${signal}`); },
      pidAliveFn: () => alive,
      sleepFn: async () => { alive = false; }, stopTimeoutMs: 200,
    });
    expect(r.exitCode).toBe(0);
    expect(r.nexusStopped).toBe(true);
    expect(signals).toEqual(['12345:SIGINT']);
  });

  test('the lock is read once before dev teardown, even if teardown removes it', async () => {
    let reads = 0;
    let alive = true;
    const signals: string[] = [];
    const r = await stop({
      readLockFn: () => { reads++; return reads === 1 ? { pid: 12345 } : null; },
      devStopFn: async () => ({ exitCode: 0, killed: false }),
      signalFn: (pid, signal) => { signals.push(`${pid}:${signal}`); alive = false; },
      pidAliveFn: () => alive,
    });
    expect(r.exitCode).toBe(0);
    expect(reads).toBe(1);
    expect(signals).toEqual(['12345:SIGINT']);
  });

  test('SIGINT ignored: SIGTERM once then exit, reporting escalation', async () => {
    const signals: string[] = [];
    const events: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string) => { if (category === 'nexus.stop') events.push(event); }) as typeof debug.log);
    let alive = true;
    try {
      const r = await stop({ readLockFn: () => ({ pid: 12345 }),
        signalFn: (pid, signal) => { signals.push(`${pid}:${signal}`); if (signal === 'SIGTERM') alive = false; },
        pidAliveFn: () => alive, sleepFn: async () => {}, stopTimeoutMs: 200,
      });
      expect(r.exitCode).toBe(0);
      expect(signals).toEqual(['12345:SIGINT', '12345:SIGTERM']);
      expect(events).toContain('escalated');
      expect(events).toContain('wait');
    } finally { log.mockRestore(); }
  });

  test('two signals ignored: reports stuck and rc 1 without signaling other pids', async () => {
    const signals: string[] = [];
    const events: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string) => { if (category === 'nexus.stop') events.push(event); }) as typeof debug.log);
    const out = makeOut();
    try {
      const r = await stop({ out, readLockFn: () => ({ pid: 12345 }),
        signalFn: (pid, signal) => { signals.push(`${pid}:${signal}`); },
        pidAliveFn: () => true, sleepFn: async () => {}, stopTimeoutMs: 200,
      });
      expect(r.exitCode).toBe(1);
      expect(r.nexusStopped).toBe(false);
      expect(out.errors).toEqual(['  pid 12345 이 멈추지 않았다']);
      expect(signals).toEqual(['12345:SIGINT', '12345:SIGTERM']);
      expect(events).toContain('stuck');
    } finally { log.mockRestore(); }
  });

  test('each wait is bounded by the injected timeout before declaring stuck', async () => {
    const intervals: number[] = [];
    const signals: string[] = [];
    const r = await stop({ readLockFn: () => ({ pid: 12345 }),
      signalFn: (pid, signal) => { signals.push(`${pid}:${signal}`); },
      pidAliveFn: () => true,
      sleepFn: async ms => { intervals.push(ms); },
      stopTimeoutMs: 250,
    });
    expect(r.exitCode).toBe(1);
    expect(signals).toEqual(['12345:SIGINT', '12345:SIGTERM']);
    expect(intervals).toEqual([100, 100, 50, 100, 100, 50]);
  });

  test('remote-host lock cannot signal a local PID with the same number', async () => {
    const out = makeOut();
    const signals: string[] = [];
    const r = await stop({ out, readLockFn: () => ({ pid: 12345, host: 'another-host' }),
      signalFn: (pid, signal) => { signals.push(`${pid}:${signal}`); },
    });
    expect(r.exitCode).toBe(1);
    expect(signals).toEqual([]);
    expect(out.errors[0]).toContain('remote host another-host');
  });

  test('missing lock: lists only same-tree daemons, start time and manual cleanup, sends no signals', async () => {
    const out = makeOut();
    const signals: string[] = [];
    const events: Array<{ event: string; count?: number }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: { count?: number }) => {
      if (category === 'nexus.stop') events.push({ event, count: data?.count });
    }) as typeof debug.log);
    try {
      const r = await stop({ out, readLockFn: () => null,
        signalFn: (pid, signal) => { signals.push(`${pid}:${signal}`); },
        processTableFn: () => [
          { pid: 12345, startedAt: 'Oct 03 00:29', args: `bun bin/elanous.mjs --config-dir ${root} --test-state-dir ${root} nexus run --port 31450` },
          { pid: 22222, startedAt: 'Oct 02 12:00', args: 'bun bin/elanous.mjs --config-dir /tmp/other/.elanous-test nexus run' },
          { pid: 33333, startedAt: 'Oct 02 11:00', args: 'bun bin/elanous.mjs nexus run' },
          { pid: 44444, startedAt: 'Oct 02 11:01', args: `bash -c 'bun bin/elanous.mjs --config-dir ${root} nexus run'` },
        ],
      });
      expect(r.exitCode).toBe(1);
      expect(out.errors).toEqual([`  orphan pid 12345 · started Oct 03 00:29 · root ${root}`, '  cleanup: kill 12345']);
      expect(signals).toEqual([]);
      expect(events).toContainEqual({ event: 'orphans', count: 1 });
    } finally { log.mockRestore(); }
  });

  test('parses macOS ps lstart rows and excludes another tree and shell command text', async () => {
    const out = makeOut();
    const signals: string[] = [];
    const rows = [
      ` 12345 Fri Oct  2 15:57:52 2026 bun bin/elanous.mjs --config-dir ${root} --test-state-dir ${root} nexus run --port 31450`,
      ' 22222 Fri Oct  2 15:50:00 2026 bun bin/elanous.mjs --config-dir /tmp/other/.elanous-test nexus run',
      ` 33333 Fri Oct  2 15:50:01 2026 bash -c 'bun bin/elanous.mjs --config-dir ${root} nexus run'`,
    ].join('\n');
    const r = await stop({ out, readLockFn: () => null, psOutputFn: () => rows,
      signalFn: (pid, signal) => { signals.push(`${pid}:${signal}`); },
    });
    expect(r.exitCode).toBe(1);
    expect(out.errors).toEqual([`  orphan pid 12345 · started Fri Oct  2 15:57:52 2026 · root ${root}`, '  cleanup: kill 12345']);
    expect(signals).toEqual([]);
  });

  test('lockless lookup recognizes the state-dir flag alone and quoted exact root', async () => {
    const out = makeOut();
    const r = await stop({ out, readLockFn: () => null,
      processTableFn: () => [
        { pid: 22222, startedAt: 'Oct 02 12:00', args: `bun bin/elanous.mjs --test-state-dir '${root}' nexus run` },
        { pid: 33333, startedAt: 'Oct 02 12:01', args: `bun bin/elanous.mjs --test-state-dir ${root}-other nexus run` },
        { pid: 44444, startedAt: 'Oct 02 12:02', args: `bun bin/elanous.mjs --config-dir /tmp/other/.elanous-test --test-state-dir '${root}' nexus run` },
      ],
    });
    expect(r.exitCode).toBe(1);
    expect(out.errors).toEqual([`  orphan pid 22222 · started Oct 02 12:00 · root ${root}`, '  cleanup: kill 22222']);
  });

  test('missing lock with an unreadable process table reports failure, not nothing to stop', async () => {
    const out = makeOut();
    const r = await stop({ out, readLockFn: () => null,
      psOutputFn: () => { throw new Error('ps unavailable'); },
    });
    expect(r.exitCode).toBe(1);
    expect(out.errors).toEqual(['  cannot inspect nexus processes: ps unavailable']);
    expect(out.logs).not.toContain('  nothing to stop (no lock)');
  });

  test('missing lock: other-tree daemon only is not an orphan in this tree', async () => {
    const out = makeOut();
    const r = await stop({ out, readLockFn: () => null,
      processTableFn: () => [{ pid: 22222, startedAt: 'Oct 02 12:00', args: 'bun bin/elanous.mjs --test-state-dir /tmp/other/.elanous-test nexus run' }],
    });
    expect(r.exitCode).toBe(0);
    expect(out.logs).toContain('  nothing to stop (no lock)');
    expect(out.errors).toEqual([]);
  });
});

describe('runPwaStop', () => {
  test('cascade order: share reset → dev stop → nexus stop on the happy path', async () => {
    const out = makeOut();
    const order: string[] = [];
    const r = await runPwaStop({
      out,
      resolveNexusPwaFn: () => ({ status: 'registered', loopback: 'http://127.0.0.1:31416/app/', url: 'http://127.0.0.1:31416/app/', source: 'local' }),
      shareProbeFn: async () => { order.push('probe'); return TS_INSTALLED; },
      shareResetFn: async (_binary, port) => { order.push(`reset:${port}`); return { exitCode: 0 }; },
      devStopFn: async () => {
        order.push('dev');
        return { exitCode: 0, killed: true };
      },
      nexusStopFn: async () => {
        order.push('nexus');
        return { exitCode: 0 };
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.devKilled).toBe(true);
    expect(r.nexusStopped).toBe(true);
    expect(r.shareReset).toBe(true);
    expect(r.shareUnmount).toEqual({ status: 'success', port: 31416, source: 'nexus' });
    expect(order).toEqual(['probe', 'reset:31416', 'dev', 'nexus']);
  });

  test('uses an explicit port instead of daemon resolution', async () => {
    const resetPorts: number[] = [];
    const r = await runPwaStop({
      out: makeOut(),
      port: 31417,
      resolveNexusPwaFn: () => ({ status: 'registered', loopback: 'http://127.0.0.1:31416/app/', url: 'http://127.0.0.1:31416/app/', source: 'local' }),
      shareProbeFn: async () => TS_INSTALLED,
      shareResetFn: async (_binary, port) => { resetPorts.push(port); return { exitCode: 0 }; },
      devStopFn: async () => ({ exitCode: 0, killed: false }),
      nexusStopFn: async () => ({ exitCode: 0 }),
    });
    expect(resetPorts).toEqual([31417]);
    expect(r.shareUnmount).toEqual({ status: 'success', port: 31417, source: 'explicit' });
  });

  test('skips share reset silently when tailscale is not installed', async () => {
    const out = makeOut();
    let resetCalls = 0;
    const r = await runPwaStop({
      out,
      shareProbeFn: async () => TS_MISSING,
      shareResetFn: async (_binary, _port) => { resetCalls += 1; return { exitCode: 0 }; },
      devStopFn: async () => ({ exitCode: 0, killed: false }),
      nexusStopFn: async () => ({ exitCode: 0 }),
    });
    expect(resetCalls).toBe(0);
    expect(r.shareReset).toBe(false);
    expect(r.exitCode).toBe(0);
  });

  test('share reset non-zero exit is reported as an unmount failure', async () => {
    const out = makeOut();
    const r = await runPwaStop({
      out,
      port: 31415,
      shareProbeFn: async () => TS_INSTALLED,
      shareResetFn: async (_binary, _port) => ({ exitCode: 1 }),
      devStopFn: async () => ({ exitCode: 0, killed: false }),
      nexusStopFn: async () => ({ exitCode: 0 }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.shareReset).toBe(true);
    expect(r.shareUnmount).toEqual({ status: 'failed', port: 31415, source: 'explicit', exitCode: 1 });
    expect(out.logs.some((l) => l.includes('share unmount exit 1'))).toBe(true);
    expect(out.errors).toEqual([]);
  });

  test('share reset throw is reported as an unmount failure and preserves the cleanup cascade', async () => {
    const out = makeOut();
    const order: string[] = [];
    const r = await runPwaStop({
      out,
      port: 31417,
      shareProbeFn: async () => { order.push('probe'); return TS_INSTALLED; },
      shareResetFn: async (_binary, _port) => { order.push('reset'); throw new Error('tailscale reset failed'); },
      readLockFn: () => ({ pid: 33333 }),
      unregisterFn: (pid) => { order.push(`unregister:${pid}`); },
      devStopFn: async () => { order.push('dev'); return { exitCode: 0, killed: false }; },
      nexusStopFn: async () => { order.push('nexus'); return { exitCode: 0 }; },
    });
    expect(r.exitCode).toBe(0);
    expect(r.shareReset).toBe(true);
    expect(r.shareUnmount).toEqual({
      status: 'failed',
      port: 31417,
      source: 'explicit',
      error: 'tailscale reset failed',
    });
    expect(r.shareUnmount).not.toEqual({ status: 'skipped', reason: 'tailscale-unavailable' });
    expect(r.unregisteredPid).toBe(33333);
    expect(order).toEqual(['probe', 'reset', 'unregister:33333', 'dev', 'nexus']);
    expect(out.logs.some((line) => line.includes('share unmount failed'))).toBe(true);
  });

  test('missing daemon port skips unmount and continues registry, dev, and nexus cleanup', async () => {
    const order: string[] = [];
    let resetCalls = 0;
    const r = await runPwaStop({
      out: makeOut(),
      resolveNexusPwaFn: () => ({ status: 'absent', reason: 'daemon-absent' }),
      shareProbeFn: async () => { order.push('probe'); return TS_INSTALLED; },
      shareResetFn: async (_binary, _port) => { resetCalls += 1; return { exitCode: 0 }; },
      readLockFn: () => ({ pid: 33333 }),
      unregisterFn: (pid) => { order.push(`unregister:${pid}`); },
      devStopFn: async () => { order.push('dev'); return { exitCode: 0, killed: false }; },
      nexusStopFn: async () => { order.push('nexus'); return { exitCode: 0 }; },
    });
    expect(resetCalls).toBe(0);
    expect(r.shareUnmount).toEqual({ status: 'skipped', reason: 'pwa-port-unknown' });
    expect(order).not.toContain('probe');
    expect(r.unregisteredPid).toBe(33333);
    expect(order).toEqual(['unregister:33333', 'dev', 'nexus']);
  });

  test('resolver failure skips unmount without blocking the stop cascade', async () => {
    const order: string[] = [];
    let resetCalls = 0;
    const r = await runPwaStop({
      out: makeOut(),
      resolveNexusPwaFn: () => { throw new Error('resolver failure'); },
      shareProbeFn: async () => { order.push('probe'); return TS_INSTALLED; },
      shareResetFn: async (_binary, _port) => { resetCalls += 1; return { exitCode: 0 }; },
      devStopFn: async () => { order.push('dev'); return { exitCode: 0, killed: false }; },
      nexusStopFn: async () => { order.push('nexus'); return { exitCode: 0 }; },
    });
    expect(resetCalls).toBe(0);
    expect(r.shareUnmount).toEqual({ status: 'skipped', reason: 'pwa-query-failed' });
    expect(order).not.toContain('probe');
    expect(order).toEqual(['dev', 'nexus']);
  });

  test('P4 — unregister fires with the lock pid before SIGINT', async () => {
    const out = makeOut();
    const unregistered: number[] = [];
    const r = await runPwaStop({
      out,
      shareProbeFn: async () => TS_INSTALLED,
      shareResetFn: async (_binary, _port) => ({ exitCode: 0 }),
      devStopFn: async () => ({ exitCode: 0, killed: false }),
      nexusStopFn: async () => ({ exitCode: 0 }),
      readLockFn: () => ({ pid: 33333 }),
      unregisterFn: (pid) => { unregistered.push(pid); },
    });
    expect(r.exitCode).toBe(0);
    expect(r.unregisteredPid).toBe(33333);
    expect(unregistered).toEqual([33333]);
  });

  test('P4 — no lock file → no unregister, no throw', async () => {
    const out = makeOut();
    const unregistered: number[] = [];
    const r = await runPwaStop({
      out,
      shareProbeFn: async () => TS_INSTALLED,
      shareResetFn: async (_binary, _port) => ({ exitCode: 0 }),
      devStopFn: async () => ({ exitCode: 0, killed: false }),
      nexusStopFn: async () => ({ exitCode: 0 }),
      readLockFn: () => null,
      unregisterFn: (pid) => { unregistered.push(pid); },
    });
    expect(r.exitCode).toBe(0);
    expect(r.unregisteredPid).toBeUndefined();
    expect(unregistered).toEqual([]);
  });

  test('share probe throwing does not block the cascade', async () => {
    const out = makeOut();
    const r = await runPwaStop({
      out,
      shareProbeFn: async () => { throw new Error('tailscale probe blew up'); },
      shareResetFn: async (_binary, _port) => ({ exitCode: 0 }),
      devStopFn: async () => ({ exitCode: 0, killed: false }),
      nexusStopFn: async () => ({ exitCode: 0 }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.shareReset).toBe(false);
  });

  test('runs nexus stop even when dev stop fails', async () => {
    const out = makeOut();
    const order: string[] = [];
    const r = await runPwaStop({
      out,
      shareProbeFn: async () => TS_MISSING,
      devStopFn: async () => {
        order.push('dev');
        return { exitCode: 1, killed: false };
      },
      nexusStopFn: async () => {
        order.push('nexus');
        return { exitCode: 0 };
      },
    });
    expect(r.exitCode).toBe(1);
    expect(r.devKilled).toBe(false);
    expect(r.nexusStopped).toBe(true);
    expect(order).toEqual(['dev', 'nexus']);
  });

  test('reports nexusStopped=false when nexus stop fails', async () => {
    const out = makeOut();
    const r = await runPwaStop({
      out,
      shareProbeFn: async () => TS_MISSING,
      devStopFn: async () => ({ exitCode: 0, killed: false }),
      nexusStopFn: async () => ({ exitCode: 4 }),
    });
    expect(r.exitCode).toBe(1);
    expect(r.devKilled).toBe(false);
    expect(r.nexusStopped).toBe(false);
  });

  test('no-op cascade still returns exit 0 when both legs are clean', async () => {
    const out = makeOut();
    const r = await runPwaStop({
      out,
      shareProbeFn: async () => TS_MISSING,
      devStopFn: async () => ({ exitCode: 0, killed: false }),
      nexusStopFn: async () => ({ exitCode: 0 }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.devKilled).toBe(false);
    expect(r.nexusStopped).toBe(true);
  });
});
