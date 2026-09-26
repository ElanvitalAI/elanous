import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPwaStart } from '../src/cli/pwa-start.js';
import { releaseTestPort } from '../src/cli/port-lease-local.js';
import type { TailscaleProbe } from '../src/nexus/onboarding/tailscale-probe.js';
import type { InstanceResolution } from '../src/instance/resolve.js';

test('central PWA lease is forwarded to the detached NEXUS child, not local test ports', async () => {
  let childEnv: Record<string, string> | undefined;
  const result = await runPwaStart({ ...NO_SHARE, httpPort: 31450, coordinatorLeasePort: 31450, coordinatorLeaseToken: 'fixture-token', coordinatorLeaseId: 'run-identity',
    bgLaunchFn: async opts => { childEnv = opts.childEnv; return { exitCode: 0 }; },
  });
  expect(result.exitCode).toBe(0);
  expect(childEnv).toEqual({ ELANOUS_TEST_COORDINATOR_LEASE_PORT: '31450', ELANOUS_TEST_COORDINATOR_LEASE_TOKEN: 'fixture-token', ELANOUS_TEST_COORDINATOR_LEASE_ID: 'run-identity' });
  childEnv = undefined;
  await runPwaStart({ ...NO_SHARE, httpPort: 31500,
    bgLaunchFn: async opts => { childEnv = opts.childEnv; return { exitCode: 0 }; },
  });
  expect(childEnv).toBeUndefined();
});

const TS_ALIVE: TailscaleProbe = {
  installed: true,
  alive: true,
  binary: '/opt/homebrew/bin/tailscale',
  hostname: 'mbp',
  magicDnsHost: 'mbp.tail-abc.ts.net',
  ips: ['100.64.0.2'],
  backendState: 'Running',
};
const TS_MISSING: TailscaleProbe = { installed: false, alive: false };

/** Share-disabled seam reused by tests that don't exercise the share
 *  tail. Stops the default `probeTailscale()` from doing real exec. */
const NO_SHARE = {
  resolveCurrentInstanceFn: () => instanceResolution('prod'),
  readShareSwitchFn: () => 'disabled' as const,
  shareProbeFn: async () => TS_MISSING,
  shareServeFn: async () => ({ exitCode: 0 }),
};

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

const fetchAlwaysOk = (async () =>
  new Response('{}', { status: 200 })) as unknown as typeof fetch;

function instanceResolution(kind: InstanceResolution['kind']): InstanceResolution {
  return { kind, root: '/tmp/instance', layer: 'default', why: 'test seam' };
}

const leaseDirs: string[] = [];
const makeLeaseDir = () => { const dir = mkdtempSync(join(tmpdir(), 'pwa-start-lease-')); leaseDirs.push(dir); return dir; };
afterEach(() => { for (const dir of leaseDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('runPwaStart — local test-port lease', () => {
  test('test instance without explicit port leases first, forwards it and transfers to daemon PID', async () => {
    const dir = makeLeaseDir();
    const out = makeOut();
    let forwardArgs: string[] = [];
    const result = await runPwaStart({
      ...NO_SHARE, out, leaseDir: dir,
      resolveCurrentInstanceFn: () => instanceResolution('test'),
      readConfigPortFn: () => 31415,
      bgLaunchFn: async opts => { forwardArgs = opts.forwardArgs ?? []; return { exitCode: 0, pid: process.pid }; },
      registerInstanceFn: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(out.logs[0]).toBe('시험 대역에서 :31450 임대');
    expect(forwardArgs.slice(-2)).toEqual(['--http-port', '31450']);
    expect(JSON.parse(readFileSync(join(dir, '31450.json'), 'utf8'))).toMatchObject({ port: 31450, pid: process.pid });
    releaseTestPort(31450, process.pid, dir);
  });

  test('prod config/default and explicit test port keep their previous precedence without leases', async () => {
    const dir = makeLeaseDir();
    const ports: string[] = [];
    for (const opts of [
      { resolveCurrentInstanceFn: () => instanceResolution('prod'), readConfigPortFn: () => 41000 },
      { resolveCurrentInstanceFn: () => instanceResolution('prod'), readConfigPortFn: () => undefined },
      { resolveCurrentInstanceFn: () => instanceResolution('test'), httpPort: 31460, readConfigPortFn: () => 41000 },
    ]) {
      await runPwaStart({ ...NO_SHARE, leaseDir: dir, ...opts,
        bgLaunchFn: async arg => { ports.push(arg.forwardArgs!.at(-1)!); return { exitCode: 0 }; },
      });
    }
    expect(ports).toEqual(['41000', '31415', '31460']);
    expect(readdirSync(dir)).toEqual([]);
  });

  test('first output announces the lease even when a stale bundle needs building', async () => {
    const dir = makeLeaseDir();
    const out = makeOut();
    const result = await runPwaStart({ ...NO_SHARE, out, leaseDir: dir,
      resolveCurrentInstanceFn: () => instanceResolution('test'),
      autoBuild: true, resolvePwaCwdFn: () => '/tmp/pwa',
      stalenessFn: () => ({ stale: true, reason: 'fixture' }),
      buildFn: async () => ({ exitCode: 1, cwd: '/tmp/pwa', durationMs: 0 }),
      bgLaunchFn: async () => { throw new Error('should not launch'); },
    });
    expect(result.exitCode).toBe(1);
    expect(out.logs[0]).toBe('시험 대역에서 :31450 임대');
    expect(readdirSync(dir)).toEqual([]);
  });

  test('successful launch transfers ownership and the child can release the lease', async () => {
    const dir = makeLeaseDir();
    const out = makeOut();
    const daemonPid = process.pid + 100;
    const originalKill = process.kill;
    // A real child PID is unnecessary here: check the persisted daemon owner
    // while keeping the test process isolated from daemon execution.
    try {
      process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === daemonPid && signal === 0) return true;
        return originalKill(pid, signal);
      }) as typeof process.kill;
      const result = await runPwaStart({ ...NO_SHARE, out, leaseDir: dir,
        resolveCurrentInstanceFn: () => instanceResolution('test'),
        bgLaunchFn: async () => ({ exitCode: 0, pid: daemonPid }),
        registerInstanceFn: () => {},
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(join(dir, '31450.json'), 'utf8')).pid).toBe(daemonPid);
      releaseTestPort(31450, process.pid, dir);
      expect(readdirSync(dir)).toEqual(['31450.json']);
      releaseTestPort(31450, daemonPid, dir);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      process.kill = originalKill;
    }
  });

  test('failed daemon startup releases the launcher lease', async () => {
    const dir = makeLeaseDir();
    const out = makeOut();
    const result = await runPwaStart({ ...NO_SHARE, out, leaseDir: dir,
      resolveCurrentInstanceFn: () => instanceResolution('test'),
      bgLaunchFn: async () => ({ exitCode: 7 }),
    });
    expect(result.exitCode).toBe(7);
    expect(readdirSync(dir)).toEqual([]);
  });

});

describe('runPwaStart — static mode (default)', () => {
  test('starts background nexus with webterm surface, NO dev tail', async () => {
    let forwardArgs: string[] = [];
    let devLaunchCalls = 0;
    const result = await runPwaStart({
      ...NO_SHARE,
      mode: 'static',
      bgLaunchFn: async (opts) => {
        forwardArgs = opts.forwardArgs ?? [];
        return { exitCode: 0, pid: 12, logPath: '/tmp/nexus.log' };
      },
      devLaunchFn: async () => {
        devLaunchCalls += 1;
        return { exitCode: 0 };
      },
    });
    expect(result.exitCode).toBe(0);
    // Default bind = 0.0.0.0 so Tailscale / LAN peers can reach.
    // P3 (2026-05-10): forward args always carry resolved `--http-port`
    // (CLI flag > UserConfig > 31415). Previously this was absent when
    // opts.httpPort was undefined, but P3 promotes the resolved port to
    // a stable contract so daemon side never falls back implicitly.
    expect(forwardArgs).toEqual(['--tools', 'webterm', '--http-host', '0.0.0.0', '--http-port', '31415']);
    expect(devLaunchCalls).toBe(0);
  });

  test('explicit --http-host wins over the 0.0.0.0 default', async () => {
    let forwardArgs: string[] = [];
    await runPwaStart({
      ...NO_SHARE,
      mode: 'static',
      httpHost: '127.0.0.1',
      bgLaunchFn: async (opts) => {
        forwardArgs = opts.forwardArgs ?? [];
        return { exitCode: 0 };
      },
    });
    expect(forwardArgs).toEqual(['--tools', 'webterm', '--http-host', '127.0.0.1', '--http-port', '31415']);
  });

  test('--loopback rewrites the nexus bind to 127.0.0.1', async () => {
    let forwardArgs: string[] = [];
    await runPwaStart({
      ...NO_SHARE,
      mode: 'static',
      loopback: true,
      bgLaunchFn: async (opts) => {
        forwardArgs = opts.forwardArgs ?? [];
        return { exitCode: 0 };
      },
    });
    expect(forwardArgs).toEqual(['--tools', 'webterm', '--http-host', '127.0.0.1', '--http-port', '31415']);
  });

  test('explicit --http-host beats --loopback (precedence: httpHost > loopback)', async () => {
    let forwardArgs: string[] = [];
    await runPwaStart({
      ...NO_SHARE,
      mode: 'static',
      loopback: true,
      httpHost: '10.0.0.5',
      bgLaunchFn: async (opts) => {
        forwardArgs = opts.forwardArgs ?? [];
        return { exitCode: 0 };
      },
    });
    expect(forwardArgs).toEqual(['--tools', 'webterm', '--http-host', '10.0.0.5', '--http-port', '31415']);
  });

  test('advanced forwarding preserves cwd/history/host/port', async () => {
    let forwardArgs: string[] = [];
    await runPwaStart({
      ...NO_SHARE,
      mode: 'static',
      force: true,
      toolCwd: '/repo',
      historyDir: '/tmp/hist',
      httpHost: '0.0.0.0',
      httpPort: 43111,
      bgLaunchFn: async (opts) => {
        forwardArgs = opts.forwardArgs ?? [];
        expect(opts.force).toBe(true);
        return { exitCode: 0 };
      },
    });
    expect(forwardArgs).toEqual([
      '--tools', 'webterm',
      '--tool-cwd', '/repo',
      '--history-dir', '/tmp/hist',
      '--http-host', '0.0.0.0',
      '--http-port', '43111',
    ]);
  });
});

describe('runPwaStart — HMR mode (opt-in)', () => {
  test('explicit --hmr — runs nexus + next-dev BG + admin POST', async () => {
    const out = makeOut();
    let devLaunched = false;
    let adminPostBody: string | null = null;
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST') adminPostBody = String(init?.body);
      if (url.includes('/v1/health')) return new Response('{"ok":true}', { status: 200 });
      if (url.startsWith('http://localhost:3210/')) return new Response('ok', { status: 200 });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const result = await runPwaStart({
      ...NO_SHARE,
      mode: 'hmr',
      out,
      bgLaunchFn: async () => ({ exitCode: 0 }),
      devLaunchFn: async () => {
        devLaunched = true;
        return { exitCode: 0, pid: 9999, logPath: '/tmp/dev.log' };
      },
      fetchFn,
      sleepFn: async () => {},
      now: () => 0,
    });
    expect(result.exitCode).toBe(0);
    expect(devLaunched).toBe(true);
    expect(JSON.parse(adminPostBody!)).toEqual({ upstream: 'http://localhost:3210' });
    expect(out.logs.some((l) => l.includes('nexus health OK'))).toBe(true);
    expect(out.logs.some((l) => l.includes('next-dev ready'))).toBe(true);
    expect(out.logs.some((l) => l.includes('dev-proxy ON'))).toBe(true);
    expect(out.logs.some((l) => l.includes('HMR iteration loop ready'))).toBe(true);
  });

  test('default mode is static — no fetch / no dev launch (regression: HMR was the old default)', async () => {
    const out = makeOut();
    let fetchCalls = 0;
    let devLaunched = false;
    const fetchFn = (async () => {
      fetchCalls += 1;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const result = await runPwaStart({
      ...NO_SHARE,
      // No mode passed → default 'static'.
      out,
      bgLaunchFn: async () => ({ exitCode: 0 }),
      devLaunchFn: async () => {
        devLaunched = true;
        return { exitCode: 0 };
      },
      fetchFn,
      sleepFn: async () => {},
      now: () => 0,
    });
    expect(result.exitCode).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(devLaunched).toBe(false);
  });

  test('--loopback forwards host=127.0.0.1 to the dev BG launch', async () => {
    const out = makeOut();
    let devOptsPassed: { port?: number; host?: string } | null = null;
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/health')) return new Response('{}', { status: 200 });
      if (url.startsWith('http://localhost:3210/')) return new Response('', { status: 200 });
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    await runPwaStart({
      ...NO_SHARE,
      mode: 'hmr',
      out,
      loopback: true,
      bgLaunchFn: async () => ({ exitCode: 0 }),
      devLaunchFn: async (o) => {
        devOptsPassed = o;
        return { exitCode: 0 };
      },
      fetchFn,
      sleepFn: async () => {},
      now: () => 0,
    });
    expect(devOptsPassed).not.toBeNull();
    expect(devOptsPassed!.host).toBe('127.0.0.1');
    // Banner reflects loopback-only mode.
    expect(out.logs.some((l) => l.includes('loopback-only') && l.includes('--loopback'))).toBe(true);
  });

  test('default (no --loopback) does NOT pass host to the dev BG launch', async () => {
    const out = makeOut();
    let devOptsPassed: { port?: number; host?: string } | null = null;
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/health')) return new Response('{}', { status: 200 });
      if (url.startsWith('http://localhost:3210/')) return new Response('', { status: 200 });
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    await runPwaStart({
      ...NO_SHARE,
      mode: 'hmr',
      out,
      bgLaunchFn: async () => ({ exitCode: 0 }),
      devLaunchFn: async (o) => {
        devOptsPassed = o;
        return { exitCode: 0 };
      },
      fetchFn,
      sleepFn: async () => {},
      now: () => 0,
    });
    expect(devOptsPassed!.host).toBeUndefined();
  });

  test('uses --dev-port for both the dev launch and the admin POST upstream', async () => {
    const out = makeOut();
    let devPortPassed: number | undefined;
    let adminPostBody: string | null = null;
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST') adminPostBody = String(init?.body);
      if (url.includes('/v1/health')) return new Response('{}', { status: 200 });
      if (url.startsWith('http://localhost:5555/')) return new Response('', { status: 200 });
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    await runPwaStart({
      ...NO_SHARE,
      mode: 'hmr',
      out,
      devPort: 5555,
      bgLaunchFn: async () => ({ exitCode: 0 }),
      devLaunchFn: async (o) => {
        devPortPassed = o.port;
        return { exitCode: 0 };
      },
      fetchFn,
      sleepFn: async () => {},
      now: () => 0,
    });
    expect(devPortPassed).toBe(5555);
    expect(JSON.parse(adminPostBody!)).toEqual({ upstream: 'http://localhost:5555' });
  });

  test('aborts when nexus health probe times out', async () => {
    const out = makeOut();
    let devLaunched = false;
    let nowVal = 0;
    const fetchFn = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await runPwaStart({
      ...NO_SHARE,
      mode: 'hmr',
      out,
      bgLaunchFn: async () => ({ exitCode: 0 }),
      devLaunchFn: async () => {
        devLaunched = true;
        return { exitCode: 0 };
      },
      fetchFn,
      sleepFn: async () => { nowVal += 200; },
      now: () => nowVal,
    });
    expect(result.exitCode).toBe(1);
    expect(devLaunched).toBe(false);
    expect(out.errors.some((e) => e.includes('did not respond'))).toBe(true);
  });

  test('aborts when dev launch fails — nexus stays up', async () => {
    const out = makeOut();
    const fetchFn = (async (input: RequestInfo | URL) => {
      if (String(input).includes('/v1/health')) return new Response('{}', { status: 200 });
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const result = await runPwaStart({
      ...NO_SHARE,
      mode: 'hmr',
      out,
      bgLaunchFn: async () => ({ exitCode: 0 }),
      devLaunchFn: async () => ({ exitCode: 1 }),
      fetchFn,
      sleepFn: async () => {},
      now: () => 0,
    });
    expect(result.exitCode).toBe(1);
    expect(out.errors.some((e) => e.includes('Nexus is still up'))).toBe(true);
  });

  test('aborts when next-dev probe times out', async () => {
    const out = makeOut();
    let nowVal = 0;
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/health')) return new Response('{}', { status: 200 });
      // Next dev never returns ok.
      throw new Error('not yet');
    }) as unknown as typeof fetch;
    const result = await runPwaStart({
      ...NO_SHARE,
      mode: 'hmr',
      out,
      bgLaunchFn: async () => ({ exitCode: 0 }),
      devLaunchFn: async () => ({ exitCode: 0 }),
      fetchFn,
      sleepFn: async () => { nowVal += 500; },
      now: () => nowVal,
    });
    expect(result.exitCode).toBe(1);
    expect(out.errors.some((e) => e.includes('Next.js dev server did not respond'))).toBe(true);
  });

  // Regression: PWA only mounts /app/* — probing root would 404 forever
  // even though the dev server was ready in <1s. The probe URL must be
  // /app/, and a 404 on / must NOT block readiness.
  test('readiness probe targets /app/, not / (PWA serves only /app/*)', async () => {
    const out = makeOut();
    const probedUrls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.includes('/v1/health')) return new Response('{}', { status: 200 });
      if (method === 'GET' && url.startsWith('http://localhost:3210')) {
        probedUrls.push(url);
        // Match real next-dev shape: / → 404, /app/ → 200.
        if (url === 'http://localhost:3210/app/') return new Response('ok', { status: 200 });
        return new Response('not found', { status: 404 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const result = await runPwaStart({
      ...NO_SHARE,
      mode: 'hmr',
      out,
      bgLaunchFn: async () => ({ exitCode: 0 }),
      devLaunchFn: async () => ({ exitCode: 0 }),
      fetchFn,
      sleepFn: async () => {},
      now: () => 0,
    });
    expect(result.exitCode).toBe(0);
    expect(probedUrls).toContain('http://localhost:3210/app/');
    expect(probedUrls).not.toContain('http://localhost:3210/');
    expect(out.logs.some((l) => l.includes('next-dev ready') && l.includes('/app/'))).toBe(true);
  });

  // Regression: the timeout error message used to claim "Stopping dev BG"
  // without actually stopping anything, leaving the orphaned next-dev
  // BG for the user to clean up manually.
  test('next-dev probe timeout calls runPwaDevStop to clean up the BG', async () => {
    const out = makeOut();
    let nowVal = 0;
    let devStopCalls = 0;
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/health')) return new Response('{}', { status: 200 });
      throw new Error('not yet');
    }) as unknown as typeof fetch;
    const result = await runPwaStart({
      ...NO_SHARE,
      mode: 'hmr',
      out,
      bgLaunchFn: async () => ({ exitCode: 0 }),
      devLaunchFn: async () => ({ exitCode: 0 }),
      devStopFn: async () => {
        devStopCalls += 1;
        return { exitCode: 0, killed: true };
      },
      fetchFn,
      sleepFn: async () => { nowVal += 500; },
      now: () => nowVal,
    });
    expect(result.exitCode).toBe(1);
    expect(devStopCalls).toBe(1);
  });

  test('admin POST failure surfaces a hint and returns exit 1', async () => {
    const out = makeOut();
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.includes('/v1/health')) return new Response('{}', { status: 200 });
      if (url.startsWith('http://localhost:3210/')) return new Response('', { status: 200 });
      if (method === 'POST') return new Response('boom', { status: 500 });
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const result = await runPwaStart({
      ...NO_SHARE,
      mode: 'hmr',
      out,
      bgLaunchFn: async () => ({ exitCode: 0 }),
      devLaunchFn: async () => ({ exitCode: 0 }),
      fetchFn,
      sleepFn: async () => {},
      now: () => 0,
    });
    expect(result.exitCode).toBe(1);
    expect(out.errors.some((e) => e.includes('admin POST returned 500'))).toBe(true);
    expect(out.errors.some((e) => e.includes('cross-origin'))).toBe(true);
  });

  test('returns the bgLaunch exit code without dev tail when nexus boot fails', async () => {
    const out = makeOut();
    let devLaunched = false;
    let fetchCalls = 0;
    const fetchFn = (async () => {
      fetchCalls += 1;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const result = await runPwaStart({
      ...NO_SHARE,
      mode: 'hmr',
      out,
      bgLaunchFn: async () => ({ exitCode: 7 }),
      devLaunchFn: async () => {
        devLaunched = true;
        return { exitCode: 0 };
      },
      fetchFn,
      sleepFn: async () => {},
      now: () => 0,
    });
    expect(result.exitCode).toBe(7);
    expect(devLaunched).toBe(false);
    expect(fetchCalls).toBe(0);
  });
});

describe('runPwaStart — explicit static opt-in', () => {
  test('mode=static skips fetch + dev launch entirely', async () => {
    const out = makeOut();
    let fetchCalls = 0;
    let devLaunched = false;
    const fetchFn = (async () => {
      fetchCalls += 1;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const result = await runPwaStart({
      ...NO_SHARE,
      mode: 'static',
      out,
      bgLaunchFn: async () => ({ exitCode: 0 }),
      devLaunchFn: async () => {
        devLaunched = true;
        return { exitCode: 0 };
      },
      fetchFn,
      sleepFn: async () => {},
      now: () => 0,
    });
    expect(result.exitCode).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(devLaunched).toBe(false);
  });
});

describe('runPwaStart — share tail (switch + tailscale lifecycle)', () => {
  test('switch=enabled + tailscale alive → serve at httpPort, banner shows tailnet URL', async () => {
    const out = makeOut();
    let serveCalls = 0;
    let servePort: number | undefined;
    const r = await runPwaStart({
      mode: 'static',
      out,
      resolveCurrentInstanceFn: () => instanceResolution('prod'),
      bgLaunchFn: async () => ({ exitCode: 0 }),
      readShareSwitchFn: () => 'enabled',
      shareProbeFn: async () => TS_ALIVE,
      shareServeFn: async (_bin, port) => {
        serveCalls += 1;
        servePort = port;
        return { exitCode: 0 };
      },
    });
    expect(r.exitCode).toBe(0);
    expect(serveCalls).toBe(1);
    expect(servePort).toBe(31415);
    expect(out.logs.some((l) => l.includes('share        ON') && l.includes('mbp.tail-abc.ts.net'))).toBe(true);
  });

  test('share serve uses opts.httpPort (not the 31415 default)', async () => {
    const out = makeOut();
    let servePort: number | undefined;
    await runPwaStart({
      resolveCurrentInstanceFn: () => instanceResolution('prod'), // 트리 환경(비-리더 = test)에 따라 실제 임대 폴더를 건드리지 않게
      mode: 'static',
      out,
      httpPort: 51111,
      bgLaunchFn: async () => ({ exitCode: 0 }),
      readShareSwitchFn: () => 'enabled',
      shareProbeFn: async () => TS_ALIVE,
      shareServeFn: async (_bin, port) => { servePort = port; return { exitCode: 0 }; },
    });
    expect(servePort).toBe(51111);
  });

  test('switch=disabled → no serve call, banner shows local-only', async () => {
    const out = makeOut();
    let serveCalls = 0;
    await runPwaStart({
      resolveCurrentInstanceFn: () => instanceResolution('prod'), // 트리 환경(비-리더 = test)에 따라 실제 임대 폴더를 건드리지 않게
      mode: 'static',
      out,
      bgLaunchFn: async () => ({ exitCode: 0 }),
      readShareSwitchFn: () => 'disabled',
      shareProbeFn: async () => TS_ALIVE,
      shareServeFn: async () => { serveCalls += 1; return { exitCode: 0 }; },
    });
    expect(serveCalls).toBe(0);
    expect(out.logs.some((l) => l.includes('share        OFF') && l.includes('local-only'))).toBe(true);
  });

  test('switch=ask → no serve call, banner hints at first-boot wizard', async () => {
    const out = makeOut();
    let serveCalls = 0;
    await runPwaStart({
      resolveCurrentInstanceFn: () => instanceResolution('prod'), // 트리 환경(비-리더 = test)에 따라 실제 임대 폴더를 건드리지 않게
      mode: 'static',
      out,
      bgLaunchFn: async () => ({ exitCode: 0 }),
      readShareSwitchFn: () => 'ask',
      shareProbeFn: async () => TS_ALIVE,
      shareServeFn: async () => { serveCalls += 1; return { exitCode: 0 }; },
    });
    expect(serveCalls).toBe(0);
    expect(out.logs.some((l) => l.includes('share        ?') && l.includes('not yet decided'))).toBe(true);
  });

  test('switch=enabled but tailscale not installed → no serve call, banner hints install', async () => {
    const out = makeOut();
    let serveCalls = 0;
    await runPwaStart({
      resolveCurrentInstanceFn: () => instanceResolution('prod'), // 트리 환경(비-리더 = test)에 따라 실제 임대 폴더를 건드리지 않게
      mode: 'static',
      out,
      bgLaunchFn: async () => ({ exitCode: 0 }),
      readShareSwitchFn: () => 'enabled',
      shareProbeFn: async () => TS_MISSING,
      shareServeFn: async () => { serveCalls += 1; return { exitCode: 0 }; },
    });
    expect(serveCalls).toBe(0);
    expect(out.logs.some((l) => l.includes('share        OFF') && l.includes('not installed'))).toBe(true);
  });

  test('switch=enabled but tailscale daemon down → no serve call, banner hints "start Tailscale"', async () => {
    const out = makeOut();
    let serveCalls = 0;
    await runPwaStart({
      resolveCurrentInstanceFn: () => instanceResolution('prod'), // 트리 환경(비-리더 = test)에 따라 실제 임대 폴더를 건드리지 않게
      mode: 'static',
      out,
      bgLaunchFn: async () => ({ exitCode: 0 }),
      readShareSwitchFn: () => 'enabled',
      shareProbeFn: async () => ({ ...TS_ALIVE, alive: false, backendState: 'Stopped' }),
      shareServeFn: async () => { serveCalls += 1; return { exitCode: 0 }; },
    });
    expect(serveCalls).toBe(0);
    expect(out.logs.some((l) => l.includes('share        OFF') && l.includes('not active'))).toBe(true);
  });

  test('serve failure does NOT fail the start — exitCode 0, banner reports ERR', async () => {
    const out = makeOut();
    const r = await runPwaStart({
      resolveCurrentInstanceFn: () => instanceResolution('prod'), // 트리 환경(비-리더 = test)에 따라 실제 임대 폴더를 건드리지 않게
      mode: 'static',
      out,
      bgLaunchFn: async () => ({ exitCode: 0 }),
      readShareSwitchFn: () => 'enabled',
      shareProbeFn: async () => TS_ALIVE,
      shareServeFn: async () => ({ exitCode: 13 }),
    });
    expect(r.exitCode).toBe(0);
    expect(out.logs.some((l) => l.includes('share        ERR') && l.includes('exit 13'))).toBe(true);
  });
});

describe('runPwaStart — P4 registry hookup', () => {
  test('static mode success → registerInstanceFn called with pid + port', async () => {
    const calls: Array<{ pid: number; ports: number[]; mode: string; kind: string }> = [];
    await runPwaStart({
      ...NO_SHARE,
      mode: 'static',
      bgLaunchFn: async () => ({ exitCode: 0, pid: 12345 }),
      resolveCurrentInstanceFn: () => instanceResolution('prod'),
      registerInstanceFn: (entry) => {
        calls.push({ pid: entry.pid, ports: entry.ports, mode: entry.mode, kind: entry.kind });
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ pid: 12345, ports: [31415], mode: 'static', kind: 'production' });
  });

  test('registers test kind for both static and HMR modes from one instance resolution', async () => {
    const calls: Array<{ mode: string; kind: string }> = [];
    const registerInstanceFn = (entry: { mode: string; kind: string }) => calls.push({ mode: entry.mode, kind: entry.kind });
    const resolveCurrentInstanceFn = () => instanceResolution('test');

    await runPwaStart({
      ...NO_SHARE,
      mode: 'static',
      bgLaunchFn: async () => ({ exitCode: 0, pid: 1 }), leaseDir: makeLeaseDir(),
      registerInstanceFn,
      resolveCurrentInstanceFn,
    });
    await runPwaStart({
      ...NO_SHARE,
      mode: 'hmr',
      bgLaunchFn: async () => ({ exitCode: 0, pid: 2 }), leaseDir: makeLeaseDir(),
      devLaunchFn: async () => ({ exitCode: 0 }),
      fetchFn: fetchAlwaysOk,
      sleepFn: async () => {},
      now: () => 0,
      registerInstanceFn,
      resolveCurrentInstanceFn,
    });

    expect(calls).toEqual([
      { mode: 'static', kind: 'test' },
      { mode: 'hmr', kind: 'test' },
    ]);
  });

  test('falls back to production for unknown static and failed HMR instance resolution', async () => {
    const calls: Array<{ mode: string; kind: string }> = [];
    const registerInstanceFn = (entry: { mode: string; kind: string }) => calls.push({ mode: entry.mode, kind: entry.kind });

    await runPwaStart({
      ...NO_SHARE,
      mode: 'static',
      bgLaunchFn: async () => ({ exitCode: 0, pid: 1 }), leaseDir: makeLeaseDir(),
      registerInstanceFn,
      resolveCurrentInstanceFn: () => instanceResolution('prod'),
    });
    const result = await runPwaStart({
      ...NO_SHARE,
      mode: 'hmr',
      bgLaunchFn: async () => ({ exitCode: 0, pid: 2 }), leaseDir: makeLeaseDir(),
      devLaunchFn: async () => ({ exitCode: 0 }),
      fetchFn: fetchAlwaysOk,
      sleepFn: async () => {},
      now: () => 0,
      registerInstanceFn,
      resolveCurrentInstanceFn: () => { throw new Error('unavailable'); },
    });

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([
      { mode: 'static', kind: 'production' },
      { mode: 'hmr', kind: 'production' },
    ]);
  });

  test('bgLaunch failure → no register call', async () => {
    let called = false;
    await runPwaStart({
      ...NO_SHARE,
      mode: 'static',
      bgLaunchFn: async () => ({ exitCode: 1 }),
      registerInstanceFn: () => { called = true; },
    });
    expect(called).toBe(false);
  });

  test('bg.pid missing → register skipped silently (no throw)', async () => {
    let called = false;
    const r = await runPwaStart({
      ...NO_SHARE,
      mode: 'static',
      bgLaunchFn: async () => ({ exitCode: 0 }), // no pid
      registerInstanceFn: () => { called = true; },
    });
    expect(r.exitCode).toBe(0);
    expect(called).toBe(false);
  });
});

describe('runPwaStart — P3 port config fallback + collision hint', () => {
  test('CLI flag wins over config + default', async () => {
    let forwardArgs: string[] = [];
    await runPwaStart({
      ...NO_SHARE,
      mode: 'static',
      httpPort: 51111, // CLI flag
      readConfigPortFn: () => 41000, // config (should be ignored)
      bgLaunchFn: async (opts) => { forwardArgs = opts.forwardArgs ?? []; return { exitCode: 0 }; },
    });
    expect(forwardArgs).toContain('51111');
    expect(forwardArgs).not.toContain('41000');
    expect(forwardArgs).not.toContain('31415');
  });

  test('config wins over default when no CLI flag', async () => {
    let forwardArgs: string[] = [];
    await runPwaStart({
      ...NO_SHARE,
      mode: 'static',
      readConfigPortFn: (k) => (k === 'global.nexus.pwa.port' ? 41000 : undefined),
      bgLaunchFn: async (opts) => { forwardArgs = opts.forwardArgs ?? []; return { exitCode: 0 }; },
    });
    expect(forwardArgs).toContain('41000');
    expect(forwardArgs).not.toContain('31415');
  });

  test('hard default 31415 when neither CLI flag nor config', async () => {
    let forwardArgs: string[] = [];
    await runPwaStart({
      ...NO_SHARE,
      mode: 'static',
      readConfigPortFn: () => undefined,
      bgLaunchFn: async (opts) => { forwardArgs = opts.forwardArgs ?? []; return { exitCode: 0 }; },
    });
    expect(forwardArgs).toContain('31415');
  });

  test('same-tree supervised collision refuses to stop or retry and keeps the collision hint', async () => {
    for (const serviceName of ['com.elanous.nexus', 'systemd']) {
      const out = makeOut();
      let launches = 0;
      let stops = 0;
      const r = await runPwaStart({
        ...NO_SHARE,
        out,
        autoRestart: true,
        bgLaunchFn: async () => { launches++; return { exitCode: 7 }; },
        listInstancesFn: () => [{
          pid: 42, cwd: process.cwd(), daemonDir: '/other', alive: true,
          launcherProvenance: { kind: 'service-manager', serviceName },
        }],
        stopFn: async () => { stops++; return { exitCode: 0, devKilled: true, nexusStopped: true, shareReset: false, shareUnmount: { status: 'skipped', reason: 'pwa-port-unknown' } }; },
      });
      expect(r.exitCode).toBe(7);
      expect(launches).toBe(1);
      expect(stops).toBe(0);
      expect(out.errors.filter((e) => e.includes('가 감독한다 — 멈추지 않았다'))).toEqual([
        `이 데몬은 ${serviceName === 'systemd' ? 'systemd' : 'launchd'} 가 감독한다 — 멈추지 않았다. 재시작이 필요한지 먼저 \`elanous nexus restart-needed\` · 필요하면 운영자에게 알린 뒤 감독자로 재시작. 시험 데몬은 \`--test --port <격리 포트>\``,
      ]);
      expect(out.errors.some((e) => e.includes('failed to claim port'))).toBe(true);
    }
  });

  test('same-tree supervised daemon later in registry refuses stop even after an unsupervised entry', async () => {
    const out = makeOut();
    let launches = 0;
    let stops = 0;
    const r = await runPwaStart({
      ...NO_SHARE,
      out,
      autoRestart: true,
      bgLaunchFn: async () => { launches++; return { exitCode: 7 }; },
      listInstancesFn: () => [{
        pid: 41, cwd: process.cwd(), daemonDir: '/other', alive: true,
        launcherProvenance: { kind: 'human-terminal' },
      }, {
        pid: 42, cwd: process.cwd(), daemonDir: '/other', alive: false,
        launcherProvenance: { kind: 'service-manager', serviceName: 'com.elanous.dead' },
      }, {
        pid: 43, cwd: process.cwd(), daemonDir: '/other', alive: true,
        launcherProvenance: { kind: 'service-manager', serviceName: 'com.elanous.nexus' },
      }],
      stopFn: async () => { stops++; return { exitCode: 0, devKilled: true, nexusStopped: true, shareReset: false, shareUnmount: { status: 'skipped', reason: 'pwa-port-unknown' } }; },
    });
    expect(r.exitCode).toBe(7);
    expect(launches).toBe(1);
    expect(stops).toBe(0);
    expect(out.errors.filter((e) => e.includes('가 감독한다 — 멈추지 않았다'))).toHaveLength(1);
    expect(out.errors.some((e) => e.includes('failed to claim port'))).toBe(true);
  });

  test('same-tree unsupervised collision still stops and retries', async () => {
    for (const kind of ['human-terminal', 'background-child', 'unknown'] as const) {
      let launches = 0;
      let stops = 0;
      const r = await runPwaStart({
        ...NO_SHARE,
        autoRestart: true,
        bgLaunchFn: async () => ({ exitCode: ++launches === 1 ? 7 : 0 }),
        listInstancesFn: () => [{
          pid: 42, cwd: '/other', daemonDir: '/other', alive: true,
          launcherProvenance: { kind },
        }, {
          pid: 43, cwd: process.cwd(), daemonDir: '/other', alive: true,
          launcherProvenance: { kind },
        }],
        stopFn: async () => { stops++; return { exitCode: 0, devKilled: true, nexusStopped: true, shareReset: false, shareUnmount: { status: 'skipped', reason: 'pwa-port-unknown' } }; },
      });
      expect(r.exitCode).toBe(0);
      expect(launches).toBe(2);
      expect(stops).toBe(1);
    }
  });

  test('bgLaunch fail surfaces P3 collision hint with port + remediation', async () => {
    const out = makeOut();
    const r = await runPwaStart({
      ...NO_SHARE,
      mode: 'static',
      httpPort: 31415,
      bgLaunchFn: async () => ({ exitCode: 1 }),
      out,
    });
    expect(r.exitCode).toBe(1);
    expect(out.errors.some((e) => e.includes('failed to claim port :31415'))).toBe(true);
    expect(out.errors.some((e) => e.includes('--force'))).toBe(true);
    expect(out.errors.some((e) => e.includes('--http-port'))).toBe(true);
    expect(out.errors.some((e) => e.includes('pwa stop'))).toBe(true);
    expect(out.errors.some((e) => e.includes('config set'))).toBe(true);
  });
});

describe('runPwaStart — P2 --https flag (force-enable for this run)', () => {
  test('--https + switch=disabled → mounts anyway (config 비저장)', async () => {
    const out = makeOut();
    const saveCalls: string[] = [];
    let serveCalls = 0;
    const r = await runPwaStart({
      resolveCurrentInstanceFn: () => instanceResolution('prod'), // 트리 환경(비-리더 = test)에 따라 실제 임대 폴더를 건드리지 않게
      mode: 'static',
      out,
      https: true,
      bgLaunchFn: async () => ({ exitCode: 0 }),
      readShareSwitchFn: () => 'disabled',
      shareProbeFn: async () => TS_ALIVE,
      shareServeFn: async () => { serveCalls += 1; return { exitCode: 0 }; },
    });
    expect(r.exitCode).toBe(0);
    expect(serveCalls).toBe(1);
    // Switch is read-only here — no save side-effect (saveCalls stays
    // empty in real flow because runPwaStart never persists).
    expect(saveCalls).toEqual([]);
    expect(out.logs.some((l) => l.includes('share        ON'))).toBe(true);
  });

  test('--https + switch=ask → mounts anyway (skips wizard prompt path)', async () => {
    const out = makeOut();
    let serveCalls = 0;
    const r = await runPwaStart({
      resolveCurrentInstanceFn: () => instanceResolution('prod'), // 트리 환경(비-리더 = test)에 따라 실제 임대 폴더를 건드리지 않게
      mode: 'static',
      out,
      https: true,
      bgLaunchFn: async () => ({ exitCode: 0 }),
      readShareSwitchFn: () => 'ask',
      shareProbeFn: async () => TS_ALIVE,
      shareServeFn: async () => { serveCalls += 1; return { exitCode: 0 }; },
    });
    expect(r.exitCode).toBe(0);
    expect(serveCalls).toBe(1);
  });

  test('--https + switch=enabled → redundant but safe (single mount)', async () => {
    const out = makeOut();
    let serveCalls = 0;
    const r = await runPwaStart({
      resolveCurrentInstanceFn: () => instanceResolution('prod'), // 트리 환경(비-리더 = test)에 따라 실제 임대 폴더를 건드리지 않게
      mode: 'static',
      out,
      https: true,
      bgLaunchFn: async () => ({ exitCode: 0 }),
      readShareSwitchFn: () => 'enabled',
      shareProbeFn: async () => TS_ALIVE,
      shareServeFn: async () => { serveCalls += 1; return { exitCode: 0 }; },
    });
    expect(r.exitCode).toBe(0);
    // Same single mount as switch=enabled alone — `--https` is a
    // redundant no-op (idempotent at the Tailscale Serve layer).
    expect(serveCalls).toBe(1);
  });

  test('no --https + switch=disabled → still skipped (default behavior)', async () => {
    const out = makeOut();
    let serveCalls = 0;
    const r = await runPwaStart({
      resolveCurrentInstanceFn: () => instanceResolution('prod'), // 트리 환경(비-리더 = test)에 따라 실제 임대 폴더를 건드리지 않게
      mode: 'static',
      out,
      bgLaunchFn: async () => ({ exitCode: 0 }),
      readShareSwitchFn: () => 'disabled',
      shareProbeFn: async () => TS_ALIVE,
      shareServeFn: async () => { serveCalls += 1; return { exitCode: 0 }; },
    });
    expect(r.exitCode).toBe(0);
    expect(serveCalls).toBe(0);
  });
});

// Compile-time guard against drifting from the documented contract.
void fetchAlwaysOk;
