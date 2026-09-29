import { describe, expect, test } from 'bun:test';

import { runPwaDev } from '../src/cli/pwa-dev';
import type { NexusLockMeta } from '../src/nexus/supervisor/lock';

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

/** Tests that exercise the admin hot-swap inject the daemon address.
 *  Production resolves it; a missing daemon is not a guessed port. */
const RESOLVED_DAEMON = { baseUrl: 'http://127.0.0.1:31415' };

const aliveLock: NexusLockMeta = {
  pid: 12345,
  host: 'mbp.local',
  startedAt: new Date().toISOString(),
  nexusVersion: '0.17.0',
} as NexusLockMeta;

function fetchOk(): typeof fetch {
  return (async () => new Response(JSON.stringify({ upstream: 'http://localhost:3210' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
}

function fetchFail(): typeof fetch {
  return (async () => {
    throw new Error('connect ECONNREFUSED');
  }) as unknown as typeof fetch;
}

describe('runPwaDev — preflight', () => {
  test('errors out when argv[1] does not resolve to apps/pwa', async () => {
    const out = makeOut();
    const result = await runPwaDev({
      argvBin: '/nowhere/elanous',
      out,
      skipNodeModulesCheck: true,
      spawnFn: async () => 0,
      readNexusLockFn: () => null,
      isAliveNexusLockFn: () => false,
      fetchFn: fetchOk(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.cwd).toBe('');
    expect(out.errors.some((e) => e.includes('could not locate apps/pwa'))).toBe(true);
  });

  test('errors out when apps/pwa/node_modules is missing', async () => {
    const out = makeOut();
    const result = await runPwaDev({
      cwd: '/tmp/nonexistent-pwa-cwd-xyzzy',
      out,
      spawnFn: async () => 0,
      readNexusLockFn: () => null,
      isAliveNexusLockFn: () => false,
      fetchFn: fetchOk(),
    });
    expect(result.exitCode).toBe(1);
    expect(out.errors.some((e) => e.includes('node_modules is missing'))).toBe(true);
  });

  test('default port is 3210', async () => {
    const out = makeOut();
    const calls: Array<{ env: NodeJS.ProcessEnv }> = [];
    const result = await runPwaDev({
      cwd: '/fake/apps/pwa',
      out,
      skipNodeModulesCheck: true,
      autoConfig: false,
      spawnFn: async (_cmd, _args, _cwd, env) => {
        calls.push({ env });
        return 0;
      },
      readNexusLockFn: () => null,
      isAliveNexusLockFn: () => false,
      fetchFn: fetchOk(),
    });
    expect(result.port).toBe(3210);
    expect(calls[0].env.PORT).toBe('3210');
  });

  test('default bind interface for next-dev is 0.0.0.0 (Tailscale-friendly)', async () => {
    const out = makeOut();
    const calls: Array<{ env: NodeJS.ProcessEnv }> = [];
    await runPwaDev({
      cwd: '/fake/apps/pwa',
      out,
      skipNodeModulesCheck: true,
      autoConfig: false,
      spawnFn: async (_cmd, _args, _cwd, env) => {
        calls.push({ env });
        return 0;
      },
      readNexusLockFn: () => null,
      isAliveNexusLockFn: () => false,
      fetchFn: fetchOk(),
    });
    expect(calls[0].env.HOSTNAME).toBe('0.0.0.0');
  });

  test('--host opt-out swaps HOSTNAME env to 127.0.0.1', async () => {
    const out = makeOut();
    const calls: Array<{ env: NodeJS.ProcessEnv }> = [];
    await runPwaDev({
      cwd: '/fake/apps/pwa',
      host: '127.0.0.1',
      out,
      skipNodeModulesCheck: true,
      autoConfig: false,
      spawnFn: async (_cmd, _args, _cwd, env) => {
        calls.push({ env });
        return 0;
      },
      readNexusLockFn: () => null,
      isAliveNexusLockFn: () => false,
      fetchFn: fetchOk(),
    });
    expect(calls[0].env.HOSTNAME).toBe('127.0.0.1');
  });
});

describe('runPwaDev — admin endpoint hot-swap', () => {
  test('POSTs upstream on start and DELETEs on exit when nexus is alive', async () => {
    const out = makeOut();
    const adminCalls: Array<{ method: string; body?: string }> = [];
    const fetchFn = (async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      adminCalls.push({
        method,
        ...(init?.body ? { body: String(init.body) } : {}),
      });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const result = await runPwaDev({
      cwd: '/fake/apps/pwa',
      port: 4321,
      out,
      skipNodeModulesCheck: true,
      readNexusLockFn: () => aliveLock,
      isAliveNexusLockFn: () => true,
      resolveEndpoint: () => RESOLVED_DAEMON,
      fetchFn,
      spawnFn: async () => 0,
    });

    expect(result.exitCode).toBe(0);
    expect(result.hotSwappedOnStart).toBe(true);
    expect(result.clearedOnExit).toBe(true);
    expect(adminCalls).toHaveLength(2);
    expect(adminCalls[0].method).toBe('POST');
    expect(JSON.parse(adminCalls[0].body!)).toEqual({ upstream: 'http://localhost:4321' });
    expect(adminCalls[1].method).toBe('DELETE');
    expect(out.logs.some((l) => l.includes('dev-proxy ON'))).toBe(true);
    expect(out.logs.some((l) => l.includes('dev-proxy OFF'))).toBe(true);
  });

  test('skips POST when no live lock — dev still runs cross-origin', async () => {
    const out = makeOut();
    const adminCalls: string[] = [];
    const fetchFn = (async (input, init) => {
      adminCalls.push(`${init?.method ?? 'GET'} ${String(input)}`);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const result = await runPwaDev({
      cwd: '/fake/apps/pwa',
      out,
      skipNodeModulesCheck: true,
      readNexusLockFn: () => null,
      isAliveNexusLockFn: () => false,
      resolveEndpoint: () => RESOLVED_DAEMON,
      fetchFn,
      spawnFn: async () => 0,
    });
    expect(adminCalls).toHaveLength(0);
    expect(result.hotSwappedOnStart).toBe(false);
    expect(result.clearedOnExit).toBe(false);
    expect(out.logs.some((l) => l.includes('no live lock'))).toBe(true);
  });

  test('--no-auto-config skips both POST and DELETE', async () => {
    const out = makeOut();
    const adminCalls: string[] = [];
    const fetchFn = (async (input, init) => {
      adminCalls.push(`${init?.method ?? 'GET'} ${String(input)}`);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await runPwaDev({
      cwd: '/fake/apps/pwa',
      out,
      autoConfig: false,
      skipNodeModulesCheck: true,
      readNexusLockFn: () => aliveLock,
      isAliveNexusLockFn: () => true,
      fetchFn,
      spawnFn: async () => 0,
    });
    expect(adminCalls).toHaveLength(0);
    expect(out.logs.some((l) => l.includes('--no-auto-config'))).toBe(true);
  });

  test('POST failure surfaces as warning but does not block dev spawn', async () => {
    const out = makeOut();
    const result = await runPwaDev({
      cwd: '/fake/apps/pwa',
      out,
      skipNodeModulesCheck: true,
      readNexusLockFn: () => aliveLock,
      isAliveNexusLockFn: () => true,
      resolveEndpoint: () => RESOLVED_DAEMON,
      fetchFn: fetchFail(),
      spawnFn: async () => 0,
    });
    expect(result.exitCode).toBe(0);
    expect(result.hotSwappedOnStart).toBe(false);
    expect(out.errors.some((e) => e.includes('admin POST failed'))).toBe(true);
  });

  test('DELETE failure surfaces a manual-recovery hint', async () => {
    const out = makeOut();
    let postCalled = false;
    const fetchFn = (async (_input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST') {
        postCalled = true;
        return new Response('{}', { status: 200 });
      }
      throw new Error('delete crashed');
    }) as unknown as typeof fetch;

    const result = await runPwaDev({
      cwd: '/fake/apps/pwa',
      out,
      skipNodeModulesCheck: true,
      readNexusLockFn: () => aliveLock,
      isAliveNexusLockFn: () => true,
      resolveEndpoint: () => RESOLVED_DAEMON,
      fetchFn,
      spawnFn: async () => 0,
    });
    expect(postCalled).toBe(true);
    expect(result.clearedOnExit).toBe(false);
    expect(out.errors.some((e) => e.includes('admin DELETE failed'))).toBe(true);
    expect(out.errors.some((e) => e.includes('curl -X DELETE'))).toBe(true);
  });
});

describe('runPwaDev — nexusBaseUrl override', () => {
  test('uses the supplied base URL for admin POST/DELETE', async () => {
    const out = makeOut();
    const calls: string[] = [];
    const fetchFn = (async (input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await runPwaDev({
      cwd: '/fake/apps/pwa',
      out,
      skipNodeModulesCheck: true,
      nexusBaseUrl: 'http://127.0.0.1:9999',
      readNexusLockFn: () => aliveLock,
      isAliveNexusLockFn: () => true,
      fetchFn,
      spawnFn: async () => 0,
    });
    expect(calls[0]).toBe('POST http://127.0.0.1:9999/v1/nexus/admin/pwa-dev-proxy');
    expect(calls[1]).toBe('DELETE http://127.0.0.1:9999/v1/nexus/admin/pwa-dev-proxy');
  });
});

// BACKLOG #2 (2026-05-09 dogfood) — daemon-restart re-register watcher.
// Polls the lock during the spawn lifetime and re-POSTs whenever the
// pid OR startedAt changes. Without this, NEXUS restart drops the
// in-memory dev-proxy and `/app/...` falls back to static export
// silently, forcing a manual `pwa dev --stop && pwa dev` cycle.
describe('runPwaDev — re-register watcher (BACKLOG #2)', () => {
  function makeFetchTracker(): { fn: typeof fetch; calls: Array<{ method: string; url: string; body?: string }> } {
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    const fn = (async (input: unknown, init: { method?: string; body?: BodyInit | null } | undefined) => {
      calls.push({
        method: (init?.method ?? 'GET').toUpperCase(),
        url: String(input),
        ...(init?.body ? { body: String(init.body) } : {}),
      });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { fn, calls };
  }

  test('re-POSTs when daemon pid changes mid-spawn', async () => {
    const out = makeOut();
    const tracker = makeFetchTracker();
    const sequence: NexusLockMeta[] = [
      // Initial state — POST happens here.
      { ...aliveLock, pid: 1000, startedAt: '2026-05-09T06:00:00Z' },
      // Watcher poll #1 — still pid 1000, no-op.
      { ...aliveLock, pid: 1000, startedAt: '2026-05-09T06:00:00Z' },
      // Watcher poll #2 — pid changed → re-POST fires.
      { ...aliveLock, pid: 2000, startedAt: '2026-05-09T06:00:30Z' },
      // Watcher poll #3+ — same new pid · no-op.
      { ...aliveLock, pid: 2000, startedAt: '2026-05-09T06:00:30Z' },
      { ...aliveLock, pid: 2000, startedAt: '2026-05-09T06:00:30Z' },
    ];
    let i = 0;
    const readLockFn = () => sequence[Math.min(i++, sequence.length - 1)];

    const result = await runPwaDev({
      cwd: '/fake/apps/pwa',
      port: 4321,
      out,
      skipNodeModulesCheck: true,
      readNexusLockFn: readLockFn,
      isAliveNexusLockFn: () => true,
      resolveEndpoint: () => RESOLVED_DAEMON,
      fetchFn: tracker.fn,
      reregisterPollIntervalMs: 25,
      spawnFn: async () => {
        // Sleep long enough for ~3 watcher ticks at 25ms.
        await new Promise((r) => setTimeout(r, 150));
        return 0;
      },
    });

    expect(result.reregisterCount).toBeGreaterThanOrEqual(1);
    const posts = tracker.calls.filter((c) => c.method === 'POST');
    expect(posts.length).toBeGreaterThanOrEqual(2); // initial + at least 1 re-POST
    expect(out.logs.some((l) => l.includes('re-POST') || l.includes('re-registered'))).toBe(true);
  });

  test('re-POSTs when daemon startedAt changes (same pid, restarted fast)', async () => {
    // Edge case: process supervisor (launchd / systemd) can recycle a
    // stopped daemon's pid. Lock startedAt gives us a tiebreaker so we
    // still detect the restart.
    const out = makeOut();
    const tracker = makeFetchTracker();
    const sequence: NexusLockMeta[] = [
      { ...aliveLock, pid: 5000, startedAt: '2026-05-09T05:00:00Z' },
      { ...aliveLock, pid: 5000, startedAt: '2026-05-09T05:00:00Z' },
      { ...aliveLock, pid: 5000, startedAt: '2026-05-09T05:30:00Z' }, // restart!
    ];
    let i = 0;
    const readLockFn = () => sequence[Math.min(i++, sequence.length - 1)];

    const result = await runPwaDev({
      cwd: '/fake/apps/pwa',
      out,
      skipNodeModulesCheck: true,
      readNexusLockFn: readLockFn,
      isAliveNexusLockFn: () => true,
      resolveEndpoint: () => RESOLVED_DAEMON,
      fetchFn: tracker.fn,
      reregisterPollIntervalMs: 20,
      spawnFn: async () => {
        await new Promise((r) => setTimeout(r, 100));
        return 0;
      },
    });

    expect(result.reregisterCount).toBeGreaterThanOrEqual(1);
    const posts = tracker.calls.filter((c) => c.method === 'POST');
    expect(posts.length).toBeGreaterThanOrEqual(2);
  });

  test('does not re-POST when pid + startedAt are stable', async () => {
    const out = makeOut();
    const tracker = makeFetchTracker();
    const stableLock: NexusLockMeta = { ...aliveLock, pid: 1234, startedAt: '2026-05-09T07:00:00Z' };
    const result = await runPwaDev({
      cwd: '/fake/apps/pwa',
      out,
      skipNodeModulesCheck: true,
      readNexusLockFn: () => stableLock,
      isAliveNexusLockFn: () => true,
      resolveEndpoint: () => RESOLVED_DAEMON,
      fetchFn: tracker.fn,
      reregisterPollIntervalMs: 20,
      spawnFn: async () => {
        await new Promise((r) => setTimeout(r, 100));
        return 0;
      },
    });

    expect(result.reregisterCount).toBe(0);
    const posts = tracker.calls.filter((c) => c.method === 'POST');
    // Just the initial POST — no extras.
    expect(posts.length).toBe(1);
  });

  test('reregisterPollIntervalMs=0 disables the watcher', async () => {
    const out = makeOut();
    const tracker = makeFetchTracker();
    const sequence: NexusLockMeta[] = [
      { ...aliveLock, pid: 100, startedAt: 'a' },
      { ...aliveLock, pid: 999, startedAt: 'z' }, // would trigger if watcher were on
    ];
    let i = 0;
    const readLockFn = () => sequence[Math.min(i++, sequence.length - 1)];

    const result = await runPwaDev({
      cwd: '/fake/apps/pwa',
      out,
      skipNodeModulesCheck: true,
      readNexusLockFn: readLockFn,
      isAliveNexusLockFn: () => true,
      resolveEndpoint: () => RESOLVED_DAEMON,
      fetchFn: tracker.fn,
      reregisterPollIntervalMs: 0,
      spawnFn: async () => {
        await new Promise((r) => setTimeout(r, 60));
        return 0;
      },
    });

    expect(result.reregisterCount).toBe(0);
    expect(tracker.calls.filter((c) => c.method === 'POST').length).toBe(1);
  });

  test('no-live-lock during watcher tick is a silent no-op (waits for daemon to come back)', async () => {
    const out = makeOut();
    const tracker = makeFetchTracker();
    let aliveCalls = 0;
    const result = await runPwaDev({
      cwd: '/fake/apps/pwa',
      out,
      skipNodeModulesCheck: true,
      // Initial: no lock at all → skip POST. Watcher polls afterwards
      // see lock but isAliveFn returns false → no re-POST.
      readNexusLockFn: () => aliveLock,
      isAliveNexusLockFn: () => { aliveCalls += 1; return false; },
      resolveEndpoint: () => RESOLVED_DAEMON,
      fetchFn: tracker.fn,
      reregisterPollIntervalMs: 15,
      spawnFn: async () => {
        await new Promise((r) => setTimeout(r, 80));
        return 0;
      },
    });

    expect(result.hotSwappedOnStart).toBe(false);
    expect(result.reregisterCount).toBe(0);
    expect(tracker.calls.filter((c) => c.method === 'POST').length).toBe(0);
    expect(aliveCalls).toBeGreaterThan(1); // watcher ran multiple polls
  });
});
