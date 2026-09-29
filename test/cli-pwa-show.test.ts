// P5 (2026-05-10) — `pwa show` (current project view) unit coverage.

import { afterEach, describe, expect, test } from 'bun:test';
import { setResolveDaemonEndpointForTest } from '../src/nexus/daemon-endpoint.js';

afterEach(() => setResolveDaemonEndpointForTest(null));

import { runPwaShow } from '../src/cli/pwa-show.js';
import type { PwaInstanceListing } from '../src/cli/pwa-registry.js';
import type { TailscaleProbe } from '../src/nexus/onboarding/tailscale-probe.js';

const TS_ALIVE: TailscaleProbe = {
  installed: true,
  alive: true,
  binary: '/opt/homebrew/bin/tailscale',
  hostname: 'mbp',
  magicDnsHost: 'mbp.tail-abc.ts.net',
};
const TS_OFF: TailscaleProbe = { installed: false, alive: false };

function fixture(overrides: Partial<PwaInstanceListing> = {}): PwaInstanceListing {
  const { alive = true, pidLiveness: _pidLiveness, ...entryOverrides } = overrides;
  return {
    pid: 11111,
    ports: [31415],
    mode: 'static',
    kind: 'production',
    cwd: '/tmp/A',
    daemonDir: '/tmp/.elanous/nexus',
    shareMounted: false,
    https: false,
    startedAt: '2026-05-10T12:00:00.000Z',
    ...entryOverrides,
    alive,
    pidLiveness: alive ? 'alive' : 'dead',
  };
}

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

describe('runPwaShow', () => {
  test('no match for cwd → friendly hint, no instance returned', async () => {
    const out = makeOut();
    const r = await runPwaShow({
      out,
      cwd: '/tmp/Z',
      listFn: () => [fixture({ cwd: '/tmp/A' })],
      probeFn: async () => TS_ALIVE,
    });
    expect(r.exitCode).toBe(0);
    expect(r.instance).toBeUndefined();
    expect(out.logs.some((l) => l.includes('No PWA daemon registered'))).toBe(true);
    expect(out.logs.some((l) => l.includes('elanous nexus run --hmr'))).toBe(true);
    expect(out.logs.some((l) => l.includes('global status'))).toBe(true);
  });

  test('match alive + share off → loopback only, no tailnet probe needed', async () => {
    const out = makeOut();
    let probeCalls = 0;
    const r = await runPwaShow({
      out,
      cwd: '/tmp/A',
      listFn: () => [fixture({ pid: 12345, ports: [31415], shareMounted: false })],
      probeFn: async () => { probeCalls += 1; return TS_OFF; },
    });
    expect(r.exitCode).toBe(0);
    expect(r.instance?.pid).toBe(12345);
    expect(r.urls?.loopback).toBe('http://127.0.0.1:31415/app/');
    expect(r.urls?.tailnet).toBeUndefined();
    expect(probeCalls).toBe(0); // probe skipped when share off
    expect(out.logs.some((l) => l.includes('✓ alive'))).toBe(true);
    expect(out.logs.some((l) => l.includes('http://127.0.0.1:31415/app/'))).toBe(true);
    expect(out.logs.some((l) => l.includes('share     off'))).toBe(true);
  });

  test('match alive + share on → tailnet URL with port from registry', async () => {
    const out = makeOut();
    const r = await runPwaShow({
      out,
      cwd: '/tmp/A',
      listFn: () => [fixture({ pid: 12345, ports: [31415], shareMounted: true })],
      probeFn: async () => TS_ALIVE,
    });
    expect(r.urls?.tailnet).toBe('https://mbp.tail-abc.ts.net:31415/app/');
    expect(out.logs.some((l) => l.includes('https://mbp.tail-abc.ts.net:31415/app/'))).toBe(true);
    expect(out.logs.some((l) => l.includes('share     on (share enable)'))).toBe(true);
  });

  test('https=true tag — share marked as ad-hoc', async () => {
    const out = makeOut();
    await runPwaShow({
      out,
      cwd: '/tmp/A',
      listFn: () => [fixture({ shareMounted: true, https: true })],
      probeFn: async () => TS_ALIVE,
    });
    expect(out.logs.some((l) => l.includes('share     on (--https · ad-hoc'))).toBe(true);
  });

  test('share mounted but tailscale offline → tailnet undefined + friendly hint', async () => {
    const out = makeOut();
    const r = await runPwaShow({
      out,
      cwd: '/tmp/A',
      listFn: () => [fixture({ shareMounted: true })],
      probeFn: async () => TS_OFF,
    });
    expect(r.urls?.tailnet).toBeUndefined();
    expect(out.logs.some((l) => l.includes('Tailscale unreachable'))).toBe(true);
  });

  test('match stale (pid dead) → ✗ tag, urls still surface for diagnosis', async () => {
    const out = makeOut();
    const r = await runPwaShow({
      out,
      cwd: '/tmp/A',
      listFn: () => [fixture({ alive: false })],
      probeFn: async () => TS_OFF,
    });
    expect(r.exitCode).toBe(0);
    expect(r.instance?.alive).toBe(false);
    expect(out.logs.some((l) => l.includes('✗ stale (pid dead)'))).toBe(true);
  });

  test('--json format → machine-readable', async () => {
    const out = makeOut();
    await runPwaShow({
      out,
      cwd: '/tmp/A',
      format: 'json',
      listFn: () => [fixture({ pid: 12345, shareMounted: true })],
      probeFn: async () => TS_ALIVE,
    });
    expect(out.logs).toHaveLength(1);
    const parsed = JSON.parse(out.logs[0]!);
    expect(parsed.instance.pid).toBe(12345);
    expect(parsed.urls.loopback).toBe('http://127.0.0.1:31415/app/');
    expect(parsed.urls.tailnet).toBe('https://mbp.tail-abc.ts.net:31415/app/');
  });

  test('--json no-match → instance: null + cwd', async () => {
    const out = makeOut();
    await runPwaShow({
      out,
      cwd: '/tmp/Z',
      format: 'json',
      listFn: () => [],
      probeFn: async () => TS_OFF,
    });
    expect(out.logs).toHaveLength(1);
    const parsed = JSON.parse(out.logs[0]!);
    expect(parsed.instance).toBeNull();
    expect(parsed.cwd).toBe('/tmp/Z');
  });

  test('missing registry port uses watch endpoint port for both links', async () => {
    const out = makeOut();
    let purpose: string | undefined;
    setResolveDaemonEndpointForTest((opts) => {
      purpose = opts.purpose;
      return { baseUrl: 'http://127.0.0.1:31420', healthUrl: 'http://127.0.0.1:31420/v1/health', pwaUrl: 'http://127.0.0.1:31420/app/', source: 'lifecycle' };
    });
    const result = await runPwaShow({ out, cwd: '/tmp/A', listFn: () => [fixture({ ports: [], shareMounted: true })], probeFn: async () => TS_ALIVE });
    expect(purpose).toBe('watch');
    expect(result.urls).toEqual({ loopback: 'http://127.0.0.1:31420/app/', tailnet: 'https://mbp.tail-abc.ts.net:31420/app/' });
  });

  test('missing registry port and endpoint emits only unknown-address line, without links', async () => {
    setResolveDaemonEndpointForTest(() => null);
    const out = makeOut();
    const result = await runPwaShow({ out, cwd: '/tmp/A', listFn: () => [fixture({ ports: [], shareMounted: true })], probeFn: async () => TS_ALIVE });
    expect(result.urls).toBeUndefined();
    expect(out.logs).toEqual(['데몬 주소를 모른다 — `elanous nexus run` 먼저']);
  });

  test('HMR mode (2 ports) → loopback uses first port (nexus)', async () => {
    const out = makeOut();
    const r = await runPwaShow({
      out,
      cwd: '/tmp/A',
      listFn: () => [fixture({ ports: [31420, 3211], mode: 'hmr', shareMounted: true })],
      probeFn: async () => TS_ALIVE,
    });
    expect(r.urls?.loopback).toBe('http://127.0.0.1:31420/app/');
    expect(r.urls?.tailnet).toBe('https://mbp.tail-abc.ts.net:31420/app/');
  });
});
