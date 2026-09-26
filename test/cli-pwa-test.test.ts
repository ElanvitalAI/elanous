// `elanous nexus pwa test` orchestrator — unit tests.
//
// The orchestrator composes existing primitives (runPwaStart,
// runPwaStop, mountTailscaleServe). These tests inject those as
// seam fns so we don't actually spawn daemons or shell out.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

import { requestCoordinatorPort, runPwaTest, type PwaTestOpts } from '../src/cli/pwa-test';
import type { PwaStartOpts } from '../src/cli/pwa-start';

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

let repoRoot: string;
let pwaOutDir: string;

beforeEach(() => {
  repoRoot = mkdtempSync(joinPath(tmpdir(), 'elanous-pwa-test-'));
  // Synthesize the repo layout the orchestrator expects (bin/elanous.mjs
  // + apps/pwa). The orchestrator's resolveRepoRoot sanity-checks
  // these so we have to materialize them.
  mkdirSync(joinPath(repoRoot, 'bin'), { recursive: true });
  writeFileSync(joinPath(repoRoot, 'bin', 'elanous.mjs'), '#!/usr/bin/env bun\n');
  pwaOutDir = joinPath(repoRoot, 'apps', 'pwa', 'out');
  mkdirSync(pwaOutDir, { recursive: true });
  writeFileSync(joinPath(pwaOutDir, 'index.html'), '<html></html>');
  mkdirSync(joinPath(repoRoot, '.elanous-test'), { recursive: true });
  writeFileSync(joinPath(repoRoot, '.elanous-test', 'config.json'), '{}');
  baseSeams.leaseDir = mkdtempSync(joinPath(tmpdir(), 'elanous-pwa-test-lease-'));
});

afterEach(() => {
  try { rmSync(repoRoot, { recursive: true, force: true }); } catch { /* swallow */ }
  if (baseSeams.leaseDir) try { rmSync(baseSeams.leaseDir, { recursive: true, force: true }); } catch { /* swallow */ }
  // Restore env we may have polluted.
  delete process.env.ELANOUS_NEXUS_DIR;
});

// 🔐 임대 파일은 시험마다 새 폴더에 — 실제 OS 임시 폴더(진짜 격리 데몬의 임대)와 섞이지 않고, 시험끼리 대역을 나눠 먹지 않게.
const baseSeams: Partial<PwaTestOpts> = {
  leasePortFn: async () => null,
  productionLockAliveFn: () => false,
  portInUseFn: () => false,
  pwaStartFn: async () => ({ exitCode: 0 }),
  pwaStopFn: async () => ({
    exitCode: 0, devKilled: false, nexusStopped: true, shareReset: false,
    shareUnmount: { status: 'skipped', reason: 'pwa-port-unknown' },
  }),
  tailscaleMountFn: async () => ({
    ok: true, url: 'https://mbp.tailnet.ts.net:31415/app/showroom/',
  }),
  tailscaleUnmountFn: async () => ({
    ok: true,
    unmounted: { mode: { kind: 'tls-tcp', port: 31415 }, upstreamPort: 31415 },
  }),
  rebuildFn: async () => ({ exitCode: 0 }),
};

describe('runPwaTest — repo layout resolution', () => {
  test('errors when argv[1] does not point at a monad-agent checkout', async () => {
    const out = makeOut();
    const r = await runPwaTest({
      argvBin: '/nowhere/elanous',
      out,
      ...baseSeams,
    });
    expect(r.exitCode).toBe(1);
    expect(out.errors.some((e) => e.includes('could not resolve repo root'))).toBe(true);
  });

  test('resolves repo root from argvBin via bin/elanous.mjs sibling check', async () => {
    const out = makeOut();
    const r = await runPwaTest({
      argvBin: joinPath(repoRoot, 'bin', 'elanous.mjs'),
      out,
      ...baseSeams,
    });
    expect(r.exitCode).toBe(0);
    expect(r.picked?.nexusPort).toBeGreaterThanOrEqual(31450);
    expect(r.picked?.nexusPort).toBeLessThanOrEqual(31499);
  });
});

describe('runPwaTest — tool cwd forwarding', () => {
  test('forwards an explicit tool cwd to pwa start', async () => {
    const out = makeOut();
    let received: PwaStartOpts | undefined;
    const r = await runPwaTest({
      repoRoot,
      out,
      ...baseSeams,
      toolCwd: '/tmp/isolated-tool-cwd',
      pwaStartFn: async (opts) => {
        received = opts;
        return { exitCode: 0 };
      },
    });

    expect(r.exitCode).toBe(0);
    expect(received!.toolCwd).toBe('/tmp/isolated-tool-cwd');
    expect(received!.httpHost).toBe('0.0.0.0');
    expect(received!.httpPort).toBeGreaterThanOrEqual(31450);
    expect(received!.httpPort).toBeLessThanOrEqual(31499);
  });
});

const inTestBand = (port: number | undefined): boolean => port !== undefined && port >= 31450 && port <= 31499;
const PRODUCTION_PORTS = [31413, 31415, 31420, 31421, 31422, 31423, 31424];

describe('coordinator lease response', () => {
  test('409 no-port falls through to the local test-band lease', async () => {
    const exhausted = async () => Response.json({ error: 'no-port' }, { status: 409 });
    const r = await runPwaTest({ repoRoot, out: makeOut(), ...baseSeams,
      leasePortFn: excluded => requestCoordinatorPort(excluded, exhausted),
    });
    expect(r.exitCode).toBe(0);
    expect(r.picked?.nexusPort).toBe(31450);
  });

  test('503 from the coordinator falls through to the local test-band lease instead of dying', async () => {
    const unavailable = async () => new Response('down', { status: 503 });
    const out = makeOut();
    const r = await runPwaTest({ repoRoot, out, ...baseSeams,
      leasePortFn: excluded => requestCoordinatorPort(excluded, unavailable),
    });
    expect(r.exitCode).toBe(0);
    expect(r.picked?.nexusPort).toBe(31450);
    expect(out.errors.some(line => line.includes('coordinator port lease failed'))).toBe(false);
  });

  test('a malformed coordinator body falls through to the local lease', async () => {
    const garbage = async () => new Response('not json', { status: 200 });
    const r = await runPwaTest({ repoRoot, out: makeOut(), ...baseSeams,
      leasePortFn: excluded => requestCoordinatorPort(excluded, garbage),
    });
    expect(r.exitCode).toBe(0);
    expect(r.picked?.nexusPort).toBe(31450);
  });

  test('requestCoordinatorPort itself still reports non-no-port errors (the picker is what falls back)', async () => {
    await expect(requestCoordinatorPort([], async () => Response.json({ error: 'not-owner' }, { status: 409 })))
      .rejects.toThrow('coordinator port lease HTTP 409');
    await expect(requestCoordinatorPort([], async () => Response.json({ error: 'unauthorized' }, { status: 401 })))
      .rejects.toThrow('coordinator port lease HTTP 401');
    await expect(requestCoordinatorPort([], async () => new Response('down', { status: 503 })))
      .rejects.toThrow('coordinator port lease HTTP 503');
  });
});

describe('runPwaTest — port collision auto-recovery', () => {
  // 🔐 2026-09-27(🅕 실측 · 격리 데몬이 31421 을 받음): `--port` 가 없으면 운영 대역이 아니라 시험 대역 임대.
  test('without --port and without a coordinator the test daemon leases from the test band — never the production band', async () => {
    const r = await runPwaTest({ repoRoot, out: makeOut(), ...baseSeams });
    expect(r.exitCode).toBe(0);
    expect(r.picked?.nexusPort).toBe(31450);
    for (const reserved of PRODUCTION_PORTS) expect(r.picked?.nexusPort).not.toBe(reserved);
  });

  test('local fallback skips occupied test-band ports without probing reserved ports', async () => {
    const seen: number[] = [];
    const r = await runPwaTest({ repoRoot, out: makeOut(), ...baseSeams,
      portInUseFn: port => { seen.push(port); return port === 31450; },
    });
    expect(r.picked?.nexusPort).toBe(31451);
    for (const reserved of PRODUCTION_PORTS) expect(seen).not.toContain(reserved);
  });

  test('coordinator lease uses the test band without probing reserved ports', async () => {
    const seen: number[] = [];
    const r = await runPwaTest({ repoRoot, out: makeOut(), ...baseSeams,
      leasePortFn: async () => ({ port: 31460, leaseId: 'lease-a' }),
      portInUseFn: port => { seen.push(port); return false; },
    });
    expect(r.picked?.nexusPort).toBe(31460);
    expect(seen).toEqual([31460]);
  });

  test('occupied central port is released, excluded and replaced by next test port', async () => {
    const exclusions: number[][] = [];
    const released: number[] = [];
    const r = await runPwaTest({ repoRoot, out: makeOut(), ...baseSeams,
      leasePortFn: async (excluded = []) => {
        exclusions.push([...excluded]);
        return excluded.includes(31450) ? { port: 31451, leaseId: 'lease-b' } : { port: 31450, leaseId: 'lease-a' };
      },
      releasePortFn: async port => { released.push(port); },
      portInUseFn: port => port === 31450,
    });
    expect(r.exitCode).toBe(0);
    expect(r.picked?.nexusPort).toBe(31451);
    expect(exclusions).toEqual([[], [31450]]);
    expect(released).toEqual([31450]);
  });

  test('a repeated occupied lease cannot loop — it falls back to the local lease, never to reserved ports', async () => {
    const released: number[] = [];
    let calls = 0;
    const r = await runPwaTest({ repoRoot, out: makeOut(), ...baseSeams,
      leasePortFn: async () => { calls++; return { port: 31450, leaseId: 'lease-a' }; },
      releasePortFn: async port => { released.push(port); },
      portInUseFn: port => port === 31450,
    });
    expect(calls).toBe(2);
    expect(released).toEqual([31450]);
    expect(r.exitCode).toBe(0);
    expect(r.picked?.nexusPort).toBe(31451);
  });

  test('passes the coordinator lease identity through to daemon startup', async () => {
    let started: PwaStartOpts | undefined;
    await runPwaTest({ repoRoot, out: makeOut(), ...baseSeams,
      leasePortFn: async () => ({ port: 31450, leaseId: 'distinct-run-id' }),
      pwaStartFn: async opts => { started = opts; return { exitCode: 0 }; },
    });
    expect(started?.coordinatorLeasePort).toBe(31450);
    expect(started?.coordinatorLeaseId).toBe('distinct-run-id');
  });

  test('hands the central claim to daemon startup but never hands local-lease ports over', async () => {
    let central: PwaStartOpts | undefined;
    let local: PwaStartOpts | undefined;
    await runPwaTest({ repoRoot, out: makeOut(), ...baseSeams,
      leasePortFn: async () => ({ port: 31450, leaseId: 'lease-a' }),
      pwaStartFn: async opts => { central = opts; return { exitCode: 0 }; },
    });
    await runPwaTest({ repoRoot, out: makeOut(), ...baseSeams,
      pwaStartFn: async opts => { local = opts; return { exitCode: 0 }; },
    });
    expect(central?.coordinatorLeasePort).toBe(31450);
    expect(central?.coordinatorLeaseToken).toBeUndefined();
    expect(inTestBand(local?.httpPort)).toBe(true);
    expect(local?.coordinatorLeasePort).toBeUndefined();
  });

  test('central lease is released when daemon startup fails', async () => {
    const released: number[] = [];
    const r = await runPwaTest({ repoRoot, out: makeOut(), ...baseSeams,
      leasePortFn: async () => ({ port: 31450, leaseId: 'lease-a' }),
      releasePortFn: async port => { released.push(port); },
      pwaStartFn: async () => ({ exitCode: 1 }),
    });
    expect(r.exitCode).toBe(1);
    expect(released).toEqual([31450]);
  });

  test('explicit --port 31415 wins without requesting a lease', async () => {
    let calls = 0;
    const r = await runPwaTest({ repoRoot, out: makeOut(), ...baseSeams, port: 31415,
      leasePortFn: async () => { calls++; return { port: 31450, leaseId: 'lease-a' }; },
    });
    expect(r.picked?.nexusPort).toBe(31415);
    expect(calls).toBe(0);
  });

  test('an out-of-band coordinator response is not trusted — local test-band lease instead', async () => {
    const r = await runPwaTest({ repoRoot, out: makeOut(), ...baseSeams,
      leasePortFn: async () => ({ port: 31415, leaseId: 'lease-a' }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.picked?.nexusPort).toBe(31450);
  });

  test('a lease without an id is not trusted — local test-band lease instead', async () => {
    const r = await runPwaTest({ repoRoot, out: makeOut(), ...baseSeams,
      leasePortFn: async () => ({ port: 31460, leaseId: '' }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.picked?.nexusPort).toBe(31450);
  });

  test('a thrown coordinator refusal falls back to the local test-band lease', async () => {
    const out = makeOut();
    const r = await runPwaTest({ repoRoot, out, ...baseSeams,
      leasePortFn: async () => { throw new Error('no-port'); },
    });
    expect(r.exitCode).toBe(0);
    expect(r.picked?.nexusPort).toBe(31450);
  });

  test('errors when the local test band is exhausted', async () => {
    const out = makeOut();
    const r = await runPwaTest({ repoRoot, out, ...baseSeams,
      portInUseFn: port => port >= 31450 && port <= 31499,
    });
    expect(r.exitCode).toBe(1);
    expect(r.picked).toBeUndefined();
    expect(out.errors.some(line => line.includes('31450..31499'))).toBe(true);
  });

  test('errors when --port collides with an external occupant', async () => {
    const out = makeOut();
    const r = await runPwaTest({
      repoRoot, out, port: 31420,
      ...baseSeams,
      portInUseFn: (p) => p === 31420,
    });
    expect(r.exitCode).toBe(1);
    expect(out.errors.some((e) => e.includes('31420'))).toBe(true);
  });

  test('honors explicit --port when free', async () => {
    const out = makeOut();
    const r = await runPwaTest({
      repoRoot, out, port: 31999,
      ...baseSeams,
    });
    expect(r.exitCode).toBe(0);
    expect(r.picked?.nexusPort).toBe(31999);
  });
});

describe('runPwaTest — HMR mode + dev port pick', () => {
  test('HMR allocates Next dev port (default 3210)', async () => {
    const out = makeOut();
    const r = await runPwaTest({
      repoRoot, out, hmr: true,
      ...baseSeams,
    });
    expect(r.exitCode).toBe(0);
    expect(r.picked?.devPort).toBe(3210);
  });

  test('HMR auto-picks next dev port on collision', async () => {
    const out = makeOut();
    const r = await runPwaTest({
      repoRoot, out, hmr: true,
      ...baseSeams,
      portInUseFn: (p) => p === 3210 || p === 3211,
    });
    expect(r.exitCode).toBe(0);
    expect(r.picked?.devPort).toBe(3212);
  });

  test('HMR errors when no dev port is free', async () => {
    const out = makeOut();
    const r = await runPwaTest({
      repoRoot, out, hmr: true,
      ...baseSeams,
      portInUseFn: (p) => p >= 3210 && p <= 3215,
    });
    expect(r.exitCode).toBe(1);
    expect(out.errors.some((e) => e.includes('Next dev port'))).toBe(true);
  });

  test('static mode does NOT allocate dev port', async () => {
    const out = makeOut();
    const r = await runPwaTest({
      repoRoot, out,
      ...baseSeams,
    });
    expect(r.picked?.devPort).toBeUndefined();
  });
});

describe('runPwaTest — Tailscale Serve --https opt-in', () => {
  test('default does not invoke Tailscale mount', async () => {
    let called = 0;
    const out = makeOut();
    const r = await runPwaTest({
      repoRoot, out,
      ...baseSeams,
      tailscaleMountFn: async () => { called += 1; return { ok: true, url: null }; },
    });
    expect(r.exitCode).toBe(0);
    expect(r.tailscaleMounted).toBeFalsy();
    expect(called).toBe(0);
    // HTTP URL guide should be present.
    expect(out.logs.some((l) => /http:\/\/localhost:314[5-9]\d\b/.test(l))).toBe(true);
  });

  test('--https mounts Tailscale Serve + surfaces HTTPS URL', async () => {
    const out = makeOut();
    const r = await runPwaTest({
      repoRoot, out, https: true,
      ...baseSeams,
    });
    expect(r.exitCode).toBe(0);
    expect(r.tailscaleMounted).toBe(true);
    expect(r.url).toBe('https://mbp.tailnet.ts.net:31415/app/showroom/');
    expect(out.logs.some((l) => l.includes('iPad / external (HTTPS'))).toBe(true);
  });

  test('--voice is an alias for --https', async () => {
    const out = makeOut();
    const r = await runPwaTest({
      repoRoot, out, voice: true,
      ...baseSeams,
    });
    expect(r.tailscaleMounted).toBe(true);
  });

  test('Tailscale mount failure surfaces error + falls back to HTTP guide', async () => {
    const out = makeOut();
    const r = await runPwaTest({
      repoRoot, out, https: true,
      ...baseSeams,
      tailscaleMountFn: async () => ({
        ok: false, url: null, reason: 'sudo-required',
        detail: 'sudo prompt missed',
      }),
    });
    expect(r.exitCode).toBe(1);
    expect(out.errors.some((e) => e.includes('Tailscale Serve mount failed'))).toBe(true);
    expect(out.errors.some((e) => e.includes('sudo-required'))).toBe(true);
    expect(out.errors.some((e) => /http:\/\/localhost:314[5-9]\d\b/.test(e))).toBe(true);
  });
});

describe('runPwaTest — static mode auto-build', () => {
  test('runs rebuild when --rebuild is set', async () => {
    let rebuildCalls = 0;
    const out = makeOut();
    const r = await runPwaTest({
      repoRoot, out, rebuild: true,
      ...baseSeams,
      rebuildFn: async () => { rebuildCalls += 1; return { exitCode: 0 }; },
    });
    expect(r.exitCode).toBe(0);
    expect(rebuildCalls).toBe(1);
  });

  test('runs rebuild when apps/pwa/out is missing', async () => {
    rmSync(pwaOutDir, { recursive: true, force: true });
    let rebuildCalls = 0;
    const out = makeOut();
    const r = await runPwaTest({
      repoRoot, out,
      ...baseSeams,
      rebuildFn: async () => {
        rebuildCalls += 1;
        // Recreate the dir so subsequent state writes succeed (the
        // orchestrator itself doesn't probe again, but parity with
        // production behavior keeps the test honest).
        mkdirSync(pwaOutDir, { recursive: true });
        return { exitCode: 0 };
      },
    });
    expect(r.exitCode).toBe(0);
    expect(rebuildCalls).toBe(1);
  });

  test('aborts when rebuild fails', async () => {
    rmSync(pwaOutDir, { recursive: true, force: true });
    const out = makeOut();
    const r = await runPwaTest({
      repoRoot, out,
      ...baseSeams,
      rebuildFn: async () => ({ exitCode: 1 }),
    });
    expect(r.exitCode).toBe(1);
    expect(out.errors.some((e) => e.includes('pwa build failed'))).toBe(true);
  });

  test('HMR mode skips out-dir build (next dev compiles on demand)', async () => {
    rmSync(pwaOutDir, { recursive: true, force: true });
    let rebuildCalls = 0;
    const out = makeOut();
    const r = await runPwaTest({
      repoRoot, out, hmr: true,
      ...baseSeams,
      rebuildFn: async () => { rebuildCalls += 1; return { exitCode: 0 }; },
    });
    expect(r.exitCode).toBe(0);
    expect(rebuildCalls).toBe(0);
  });
});

describe('runPwaTest — canonical test-mode banner guidance', () => {
  test('advertises only nexus run --test commands for status and stop', async () => {
    const out = makeOut();

    const r = await runPwaTest({
      repoRoot, out,
      ...baseSeams,
    });

    const banner = out.logs.join('\n');
    expect(r.exitCode).toBe(0);
    expect(banner).toContain('stop      elanous nexus run --test --stop');
    expect(banner).toContain('status    elanous nexus run --test --status');
    expect(banner).not.toContain('elanous nexus pwa test --stop');
    expect(banner).not.toContain('elanous nexus pwa test --status');
  });
});

describe('runPwaTest — project-local state', () => {
  test('writes test-state.json under <repo>/.elanous-test/', async () => {
    const out = makeOut();
    await runPwaTest({
      repoRoot, out,
      ...baseSeams,
    });
    const stateFile = joinPath(repoRoot, '.elanous-test', 'test-state.json');
    expect(existsSync(stateFile)).toBe(true);
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(parsed.mode).toBe('static');
    expect(parsed.nexusPort).toBeGreaterThanOrEqual(31450);
    expect(parsed.nexusPort).toBeLessThanOrEqual(31499);
    expect(parsed.https).toBe(false);
  });

  test('sets test state root programmatically (no env var) · 2026-05-13 config-dir-unify', async () => {
    const out = makeOut();
    await runPwaTest({
      repoRoot, out,
      ...baseSeams,
    });
    const { getTestStateRoot, setTestStateRoot } = await import('../src/nexus/paths');
    expect(getTestStateRoot()).toBe(joinPath(repoRoot, '.elanous-test'));
    // The env var that used to mirror this value is now untouched.
    expect(process.env.ELANOUS_NEXUS_DIR).toBeUndefined();
    setTestStateRoot(null);
  });
});

describe('runPwaTest --status', () => {
  test('reports no active instance when state file missing', async () => {
    const out = makeOut();
    const r = await runPwaTest({
      repoRoot, out, status: true,
      ...baseSeams,
    });
    expect(r.exitCode).toBe(0);
    expect(out.logs.some((l) => l.includes('no active test instance'))).toBe(true);
  });

  test('reads + prints active instance state', async () => {
    const stateDir = joinPath(repoRoot, '.elanous-test');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      joinPath(stateDir, 'test-state.json'),
      JSON.stringify({
        mode: 'hmr',
        nexusPort: 31420,
        devPort: 3211,
        https: true,
        url: 'https://mbp.tailnet.ts.net:31420/app/showroom/',
        startedAt: '2026-05-09T22:00:00Z',
      }),
    );
    const out = makeOut();
    const r = await runPwaTest({
      repoRoot, out, status: true,
      ...baseSeams,
    });
    expect(r.exitCode).toBe(0);
    expect(out.logs.some((l) => l.includes('hmr'))).toBe(true);
    expect(out.logs.some((l) => l.includes(':31420'))).toBe(true);
    expect(out.logs.some((l) => l.includes(':3211'))).toBe(true);
    expect(out.logs.some((l) => l.includes('mbp.tailnet.ts.net'))).toBe(true);
  });
});

describe('runPwaTest --stop', () => {
  test('cascades stop: Tailscale unmount + pwa stop', async () => {
    let stopCalls = 0;
    let unmountCalls = 0;
    const stateDir = joinPath(repoRoot, '.elanous-test');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(joinPath(stateDir, 'test-state.json'), '{}');
    const out = makeOut();
    const r = await runPwaTest({
      repoRoot, out, stop: true,
      ...baseSeams,
      pwaStopFn: async () => {
        stopCalls += 1;
        return {
          exitCode: 0, devKilled: false, nexusStopped: true, shareReset: false,
    shareUnmount: { status: 'skipped', reason: 'pwa-port-unknown' },
        };
      },
      tailscaleUnmountFn: async () => {
        unmountCalls += 1;
        return {
          ok: true,
          unmounted: { mode: { kind: 'tls-tcp', port: 31415 }, upstreamPort: 31415 },
        };
      },
    });
    expect(r.exitCode).toBe(0);
    expect(stopCalls).toBe(1);
    expect(unmountCalls).toBe(1);
    // Tailscale unmount before daemon stop (URL goes dark first).
    expect(out.logs.some((l) => l.includes('Tailscale Serve OFF'))).toBe(true);
  });

  test('stop succeeds when no Tailscale state is present (idempotent)', async () => {
    const out = makeOut();
    const r = await runPwaTest({
      repoRoot, out, stop: true,
      ...baseSeams,
      tailscaleUnmountFn: async () => ({ ok: true, reason: 'no-state' }),
    });
    expect(r.exitCode).toBe(0);
  });
});

describe('FU8 PR #5 · --fresh prune + isolation flip', () => {
  test('--fresh prunes stale workflows/tasks/backups and preserves daemon state', async () => {
    const out = makeOut();
    // Pre-populate the state dir as a prior test run would leave it.
    const stateDir = joinPath(repoRoot, '.elanous-test');
    mkdirSync(joinPath(stateDir, 'workflows'), { recursive: true });
    writeFileSync(joinPath(stateDir, 'workflows', 'greet-stale.yaml'), 'name: greet-stale\n');
    mkdirSync(joinPath(stateDir, 'tasks'), { recursive: true });
    writeFileSync(joinPath(stateDir, 'tasks', 'tasks.db'), 'stale db');
    mkdirSync(joinPath(stateDir, 'backups'), { recursive: true });
    writeFileSync(joinPath(stateDir, 'backups', 'tasks-old.db'), 'old');
    // Daemon-lifecycle files we must NOT prune.
    mkdirSync(joinPath(stateDir, 'logs'), { recursive: true });
    writeFileSync(joinPath(stateDir, 'logs', 'prior.log'), 'leave me alone');
    writeFileSync(joinPath(stateDir, 'runtime.json'), '{"prior":true}');

    const r = await runPwaTest({
      repoRoot, out, fresh: true,
      ...baseSeams,
    });
    expect(r.exitCode).toBe(0);
    // Transient dirs gone.
    expect(existsSync(joinPath(stateDir, 'workflows'))).toBe(false);
    expect(existsSync(joinPath(stateDir, 'tasks'))).toBe(false);
    expect(existsSync(joinPath(stateDir, 'backups'))).toBe(false);
    // Daemon state preserved (logs + runtime.json predate this prune).
    expect(existsSync(joinPath(stateDir, 'logs', 'prior.log'))).toBe(true);
    expect(readFileSync(joinPath(stateDir, 'logs', 'prior.log'), 'utf8')).toBe('leave me alone');
    // The orchestrator wrote its own test-state.json — that's fine.
    // Banner mentions the prune.
    expect(out.logs.some((l) => l.includes('--fresh: pruned'))).toBe(true);
  });

  test('--fresh on a clean state dir reports "nothing to prune"', async () => {
    const out = makeOut();
    const r = await runPwaTest({
      repoRoot, out, fresh: true,
      ...baseSeams,
    });
    expect(r.exitCode).toBe(0);
    expect(out.logs.some((l) => l.includes('--fresh: nothing to prune'))).toBe(true);
  });

  test('without --fresh, prior workflows survive (default behaviour preserved)', async () => {
    const out = makeOut();
    const stateDir = joinPath(repoRoot, '.elanous-test');
    mkdirSync(joinPath(stateDir, 'workflows'), { recursive: true });
    writeFileSync(joinPath(stateDir, 'workflows', 'greet-stale.yaml'), 'name: greet-stale\n');
    const r = await runPwaTest({
      repoRoot, out,
      ...baseSeams,
    });
    expect(r.exitCode).toBe(0);
    // Workflow file survives — pre-FU8 behaviour intact for users who
    // depend on cross-run workflow accretion.
    expect(existsSync(joinPath(stateDir, 'workflows', 'greet-stale.yaml'))).toBe(true);
  });

  test('--test DOES redirect the config dir to the test root (ISO-2 · 2026-07-13)', async () => {
    const out = makeOut();
    delete process.env.ELANOUS_DAEMON_DIR;
    const r = await runPwaTest({
      repoRoot, out,
      ...baseSeams,
    });
    expect(r.exitCode).toBe(0);
    // 2026-05-13 config-dir-unify 는 "--test 는 state 만 격리·config 공유+
    // overlay" 였으나, overlay 뷰 디스크 박제 오염 사건(#4029)과 미션 오발송
    // (2026-07-13) 후 대표 결정으로 **config 완전 격리**로 반전 — 테스트
    // 프로세스는 <repo>/.elanous-test/config.json(물질화 사본)만 본다.
    const { getElanousConfigDir, resetElanousConfigDir } = await import('../src/elanous-config-dir');
    expect(getElanousConfigDir()).toBe(joinPath(repoRoot, '.elanous-test'));
    expect(process.env.ELANOUS_DAEMON_DIR).toBeUndefined();
    const { setTestStateRoot } = await import('../src/nexus/paths');
    setTestStateRoot(null);
    resetElanousConfigDir();
  });
});
