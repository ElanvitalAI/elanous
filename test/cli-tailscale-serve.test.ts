// Unified Tailscale Serve helper — direct unit tests.
//
// The legacy callers (`defaultServe` for https-443, `mountTailscaleTestServe`
// for tls-tcp) keep their wrappers + their own tests. This file targets
// the unified API with both modes in one place so future callers can
// see the shape without spelunking the wrappers.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

import {
  mountTailscaleServe,
  unmountTailscaleServe,
  readMountedState,
  cleanGhostTailscaleServe,
  type TailscaleServeMode,
} from '../src/cli/tailscale-serve';
import type { TailscaleProbe } from '../src/nexus/onboarding/tailscale-probe';

interface ServeCall {
  binary: string;
  args: string[];
}

function makeProbe(over: Partial<TailscaleProbe> = {}): () => Promise<TailscaleProbe> {
  const base: TailscaleProbe = {
    installed: true,
    alive: true,
    magicDnsHost: 'mbp.tailnet.ts.net',
    binary: 'tailscale',
    ...over,
  };
  return async () => base;
}

function makeServeCmd(
  responses: Array<{ exitCode: number; stdout?: string; stderr?: string }>,
  recorded: ServeCall[],
) {
  let i = 0;
  return async (binary: string, args: readonly string[]) => {
    recorded.push({ binary, args: [...args] });
    const r = responses[Math.min(i++, responses.length - 1)] ?? { exitCode: 0 };
    return {
      exitCode: r.exitCode,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
    };
  };
}

let tmp: string;
let statePath: string;

beforeEach(() => {
  tmp = mkdtempSync(joinPath(tmpdir(), 'elanous-tailscale-serve-'));
  statePath = joinPath(tmp, 'state.json');
});

afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* swallow */ }
});

describe('mountTailscaleServe — mode dispatch', () => {
  test('https-443 mounts with --https=443 + http://localhost:<upstream> URL', async () => {
    const calls: ServeCall[] = [];
    const res = await mountTailscaleServe({
      mode: { kind: 'https-443' },
      upstreamPort: 31415,
      probeFn: makeProbe(),
      serveCmdFn: makeServeCmd([{ exitCode: 0 }], calls),
    });
    expect(res.ok).toBe(true);
    expect(res.url).toBe('https://mbp.tailnet.ts.net/app/showroom/');
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([
      'serve', '--bg', '--https=443', 'http://localhost:31415',
    ]);
  });

  test('tls-tcp mounts with --tls-terminated-tcp <port> + tcp://localhost:<upstream>', async () => {
    const calls: ServeCall[] = [];
    const res = await mountTailscaleServe({
      mode: { kind: 'tls-tcp', port: 31420 },
      upstreamPort: 31420,
      probeFn: makeProbe(),
      serveCmdFn: makeServeCmd([{ exitCode: 0 }], calls),
    });
    expect(res.ok).toBe(true);
    expect(res.url).toBe('https://mbp.tailnet.ts.net:31420/app/showroom/');
    expect(calls[0].args).toEqual([
      'serve', '--bg', '--tls-terminated-tcp', '31420', 'tcp://localhost:31420',
    ]);
  });

  test('honors custom urlPath', async () => {
    const res = await mountTailscaleServe({
      mode: { kind: 'tls-tcp', port: 31415 },
      upstreamPort: 31415,
      urlPath: '/v1/health',
      probeFn: makeProbe(),
      serveCmdFn: makeServeCmd([{ exitCode: 0 }], []),
    });
    expect(res.url).toBe('https://mbp.tailnet.ts.net:31415/v1/health');
  });
});

describe('mountTailscaleServe — singleton swap (statePath)', () => {
  test('swaps from prior tls-tcp port to a new tls-tcp port', async () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        mode: { kind: 'tls-tcp', port: 31415 },
        upstreamPort: 31415,
        hostname: 'mbp.tailnet.ts.net',
        mountedAt: new Date().toISOString(),
      }),
    );
    const calls: ServeCall[] = [];
    const res = await mountTailscaleServe({
      mode: { kind: 'tls-tcp', port: 31420 },
      upstreamPort: 31420,
      statePath,
      probeFn: makeProbe(),
      serveCmdFn: makeServeCmd([{ exitCode: 0 }, { exitCode: 0 }], calls),
    });
    expect(res.ok).toBe(true);
    expect(res.swappedFrom).toEqual({
      mode: { kind: 'tls-tcp', port: 31415 },
      upstreamPort: 31415,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual(['serve', '--tls-terminated-tcp', '31415', 'off']);
    expect(calls[1].args).toEqual(['serve', '--bg', '--tls-terminated-tcp', '31420', 'tcp://localhost:31420']);
  });

  test('swaps across modes (tls-tcp → https-443)', async () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        mode: { kind: 'tls-tcp', port: 31420 },
        upstreamPort: 31420,
        hostname: 'mbp.tailnet.ts.net',
        mountedAt: new Date().toISOString(),
      }),
    );
    const calls: ServeCall[] = [];
    const res = await mountTailscaleServe({
      mode: { kind: 'https-443' },
      upstreamPort: 31415,
      statePath,
      probeFn: makeProbe(),
      serveCmdFn: makeServeCmd([{ exitCode: 0 }, { exitCode: 0 }], calls),
    });
    expect(res.ok).toBe(true);
    expect(res.swappedFrom?.mode.kind).toBe('tls-tcp');
    expect(calls[0].args).toEqual(['serve', '--tls-terminated-tcp', '31420', 'off']);
    expect(calls[1].args).toEqual(['serve', '--bg', '--https=443', 'http://localhost:31415']);
  });

  test('idempotent re-mount on same mode + same upstream — no swap', async () => {
    const stateBody: TailscaleServeMode = { kind: 'tls-tcp', port: 31415 };
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        mode: stateBody,
        upstreamPort: 31415,
        hostname: 'mbp.tailnet.ts.net',
        mountedAt: new Date().toISOString(),
      }),
    );
    const calls: ServeCall[] = [];
    const res = await mountTailscaleServe({
      mode: stateBody,
      upstreamPort: 31415,
      statePath,
      probeFn: makeProbe(),
      serveCmdFn: makeServeCmd([{ exitCode: 0 }], calls),
    });
    expect(res.ok).toBe(true);
    expect(res.swappedFrom).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain('--tls-terminated-tcp');
  });
});

describe('mountTailscaleServe — error paths', () => {
  test('tailscale-missing when probe.installed=false', async () => {
    const res = await mountTailscaleServe({
      mode: { kind: 'tls-tcp', port: 31415 },
      upstreamPort: 31415,
      probeFn: makeProbe({ installed: false }),
      serveCmdFn: makeServeCmd([], []),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('tailscale-missing');
  });

  test('tailscale-down when alive=false', async () => {
    const res = await mountTailscaleServe({
      mode: { kind: 'tls-tcp', port: 31415 },
      upstreamPort: 31415,
      probeFn: makeProbe({ alive: false }),
      serveCmdFn: makeServeCmd([], []),
    });
    expect(res.reason).toBe('tailscale-down');
  });

  test('magic-dns-unknown when probe lacks hostname', async () => {
    const res = await mountTailscaleServe({
      mode: { kind: 'https-443' },
      upstreamPort: 31415,
      probeFn: async () => ({ installed: true, alive: true, binary: 'tailscale' }),
      serveCmdFn: makeServeCmd([], []),
    });
    expect(res.reason).toBe('magic-dns-unknown');
  });

  test('sudo-required from sudo -n stderr signature', async () => {
    const res = await mountTailscaleServe({
      mode: { kind: 'tls-tcp', port: 31415 },
      upstreamPort: 31415,
      probeFn: makeProbe(),
      serveCmdFn: makeServeCmd(
        [{ exitCode: 1, stderr: 'sudo: a password is required' }],
        [],
      ),
    });
    expect(res.reason).toBe('sudo-required');
    expect(res.detail).toContain('--tls-terminated-tcp');
  });

  test('serve-cmd-failed for non-sudo non-zero exit', async () => {
    const res = await mountTailscaleServe({
      mode: { kind: 'tls-tcp', port: 31415 },
      upstreamPort: 31415,
      probeFn: makeProbe(),
      serveCmdFn: makeServeCmd(
        [{ exitCode: 2, stderr: 'serve already running' }],
        [],
      ),
    });
    expect(res.reason).toBe('serve-cmd-failed');
    expect(res.detail).toContain('serve already running');
  });
});

describe('mountTailscaleServe — useSudo opt-out (legacy https-443 path)', () => {
  test('useSudo:false skips sudo wrapper · matches pre-lift defaultServe behavior', async () => {
    const calls: ServeCall[] = [];
    await mountTailscaleServe({
      mode: { kind: 'https-443' },
      upstreamPort: 31415,
      useSudo: false,
      probeFn: makeProbe(),
      serveCmdFn: makeServeCmd([{ exitCode: 0 }], calls),
    });
    expect(calls).toEqual([{
      binary: 'tailscale', args: ['serve', '--bg', '--https=443', 'http://localhost:31415'],
    }]);
  });
});

describe('mutation privilege fallback', () => {
  const mountOpts = { mode: { kind: 'tls-tcp' as const, port: 31420 }, upstreamPort: 31420, probeFn: makeProbe() };
  const offArgs = ['serve', '--tls-terminated-tcp', '31420', 'off'];
  const onArgs = ['serve', '--bg', '--tls-terminated-tcp', '31420', 'tcp://localhost:31420'];

  test('mount succeeds directly without invoking sudo', async () => {
    const calls: ServeCall[] = [];
    const result = await mountTailscaleServe({ ...mountOpts, serveCmdFn: makeServeCmd([{ exitCode: 0 }], calls) });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ binary: 'tailscale', args: onArgs }]);
  });

  test('mount retries once with sudo -n only after a permission error', async () => {
    const calls: ServeCall[] = [];
    const result = await mountTailscaleServe({
      ...mountOpts,
      serveCmdFn: makeServeCmd([{ exitCode: 1, stderr: 'permission denied' }, { exitCode: 0 }], calls),
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      { binary: 'tailscale', args: onArgs },
      { binary: 'sudo', args: ['-n', 'tailscale', ...onArgs] },
    ]);
  });

  test('mount preserves failure reasons and never escalates unrelated errors', async () => {
    for (const [responses, reason, count] of [
      [[{ exitCode: 2, stderr: 'serve already running' }], 'serve-cmd-failed', 1],
      [[{ exitCode: 1, stderr: 'operation not permitted' }, { exitCode: 1, stderr: 'sudo: a password is required' }], 'sudo-required', 2],
    ] as const) {
      const calls: ServeCall[] = [];
      const result = await mountTailscaleServe({ ...mountOpts, serveCmdFn: makeServeCmd([...responses], calls) });
      expect(result.reason).toBe(reason);
      expect(calls).toHaveLength(count);
    }
  });

  test('swap retries only the permission-denied prior-port off before mounting', async () => {
    writeFileSync(statePath, JSON.stringify({ version: 1, mode: { kind: 'tls-tcp', port: 31420 }, upstreamPort: 31420 }));
    const calls: ServeCall[] = [];
    const result = await mountTailscaleServe({
      mode: { kind: 'tls-tcp', port: 31421 }, upstreamPort: 31421, statePath, probeFn: makeProbe(),
      serveCmdFn: makeServeCmd([{ exitCode: 1, stderr: 'access denied' }, { exitCode: 0 }, { exitCode: 0 }], calls),
    });
    expect(result.swappedFrom?.mode).toEqual({ kind: 'tls-tcp', port: 31420 });
    expect(calls).toEqual([
      { binary: 'tailscale', args: offArgs },
      { binary: 'sudo', args: ['-n', 'tailscale', ...offArgs] },
      { binary: 'tailscale', args: ['serve', '--bg', '--tls-terminated-tcp', '31421', 'tcp://localhost:31421'] },
    ]);
  });

  test('explicit useSudo true invokes sudo immediately; false never retries', async () => {
    const sudoCalls: ServeCall[] = [];
    const sudoResult = await mountTailscaleServe({
      ...mountOpts, useSudo: true, serveCmdFn: makeServeCmd([{ exitCode: 0 }], sudoCalls),
    });
    expect(sudoResult.ok).toBe(true);
    expect(sudoCalls).toEqual([{ binary: 'sudo', args: ['-n', 'tailscale', ...onArgs] }]);

    const directCalls: ServeCall[] = [];
    const directResult = await mountTailscaleServe({
      ...mountOpts, useSudo: false,
      serveCmdFn: makeServeCmd([{ exitCode: 1, stderr: 'permission denied' }], directCalls),
    });
    expect(directResult.reason).toBe('serve-cmd-failed');
    expect(directCalls).toEqual([{ binary: 'tailscale', args: onArgs }]);
  });

  test('port-specific unmount tries direct then sudo once; preserves sudo-required and state', async () => {
    writeFileSync(statePath, JSON.stringify({ version: 1, mode: mountOpts.mode, upstreamPort: 31420 }));
    const calls: ServeCall[] = [];
    const opts = { mode: mountOpts.mode, upstreamPort: 31420, statePath, probeFn: makeProbe() };
    const failed = await unmountTailscaleServe({
      ...opts,
      serveCmdFn: makeServeCmd([{ exitCode: 1, stderr: 'EPERM' }, { exitCode: 1, stderr: 'sudo: a password is required' }], calls),
    });
    expect(failed.reason).toBe('sudo-required');
    expect(existsSync(statePath)).toBe(true);
    expect(calls).toEqual([
      { binary: 'tailscale', args: offArgs },
      { binary: 'sudo', args: ['-n', 'tailscale', ...offArgs] },
    ]);
    const successCalls: ServeCall[] = [];
    const success = await unmountTailscaleServe({
      ...opts, serveCmdFn: makeServeCmd([{ exitCode: 0 }], successCalls),
    });
    expect(success.ok).toBe(true);
    expect(successCalls).toEqual([{ binary: 'tailscale', args: offArgs }]);
    expect(existsSync(statePath)).toBe(false);
  });

  test('ghost port removal retries only its off command, not read-only status', async () => {
    const calls: ServeCall[] = [];
    const result = await cleanGhostTailscaleServe({
      port: 31420, probeFn: makeProbe(),
      socketTableFn: async () => '',
      serveCmdFn: makeServeCmd([
        { exitCode: 0, stdout: JSON.stringify({ TCP: { '31420': {} } }) },
        { exitCode: 1, stderr: 'permission denied' },
        { exitCode: 0 },
      ], calls),
    });
    expect(result.reason).toBe('cleaned');
    expect(calls).toEqual([
      { binary: 'tailscale', args: ['serve', 'status', '--json'] },
      { binary: 'tailscale', args: offArgs },
      { binary: 'sudo', args: ['-n', 'tailscale', ...offArgs] },
    ]);
  });

  test('port-specific unmount does not retry unrelated failure or explicit false', async () => {
    for (const [useSudo, stderr] of [[undefined, 'mapping not found'], [false, 'permission denied']] as const) {
      const calls: ServeCall[] = [];
      const result = await unmountTailscaleServe({
        mode: mountOpts.mode, upstreamPort: 31420, probeFn: makeProbe(), useSudo,
        serveCmdFn: makeServeCmd([{ exitCode: 2, stderr }], calls),
      });
      expect(result.reason).toBe('serve-cmd-failed');
      expect(calls).toEqual([{ binary: 'tailscale', args: offArgs }]);
    }
  });
});

describe('unmountTailscaleServe', () => {
  test('no-op when no state + no explicit mode', async () => {
    const res = await unmountTailscaleServe({
      upstreamPort: 0,
      probeFn: makeProbe(),
      serveCmdFn: makeServeCmd([], []),
    });
    expect(res.ok).toBe(true);
    expect(res.reason).toBe('no-state');
  });

  test('reads state to discover mode + issues off', async () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        mode: { kind: 'tls-tcp', port: 31420 },
        upstreamPort: 31420,
        hostname: 'mbp.tailnet.ts.net',
        mountedAt: new Date().toISOString(),
      }),
    );
    const calls: ServeCall[] = [];
    const res = await unmountTailscaleServe({
      statePath, upstreamPort: 0,
      probeFn: makeProbe(),
      serveCmdFn: makeServeCmd([{ exitCode: 0 }], calls),
    });
    expect(res.ok).toBe(true);
    expect(res.unmounted?.mode.kind).toBe('tls-tcp');
    expect(calls[0].args).toEqual(['serve', '--tls-terminated-tcp', '31420', 'off']);
    expect(calls[0].args).not.toContain('reset');
    expect(existsSync(statePath)).toBe(false);
  });

  test('explicit mode unmount works without state file', async () => {
    const calls: ServeCall[] = [];
    const res = await unmountTailscaleServe({
      mode: { kind: 'https-443' },
      upstreamPort: 31415,
      probeFn: makeProbe(),
      serveCmdFn: makeServeCmd([{ exitCode: 0 }], calls),
    });
    expect(res.ok).toBe(true);
    expect(calls[0].args).toEqual(['serve', '--https=443', 'off']);
    expect(calls[0].args).not.toContain('reset');
  });

  test('explicit tls-tcp unmount removes only its requested port', async () => {
    const calls: ServeCall[] = [];
    const res = await unmountTailscaleServe({
      mode: { kind: 'tls-tcp', port: 31416 },
      upstreamPort: 31416,
      probeFn: makeProbe(),
      serveCmdFn: makeServeCmd([{ exitCode: 0 }], calls),
    });
    expect(res.ok).toBe(true);
    expect(calls[0].args).toEqual(['serve', '--tls-terminated-tcp', '31416', 'off']);
    expect(calls[0].args).not.toContain('31417');
    expect(calls[0].args).not.toContain('reset');
  });
});

describe('cleanGhostTailscaleServe', () => {
  const mapped31420 = JSON.stringify({
    TCP: {
      '31420': { TCPForward: 'tcp://localhost:31420' },
      '31421': { TCPForward: 'tcp://localhost:31421' },
    },
  });

  test('preserves a mapped port with a loopback Linux ss backend listener', async () => {
    const calls: ServeCall[] = [];
    const result = await cleanGhostTailscaleServe({
      port: 31420,
      probeFn: makeProbe(),
      serveCmdFn: makeServeCmd([{ exitCode: 0, stdout: mapped31420 }], calls),
      socketTableFn: async () => [
        'State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
        'LISTEN 0      4096   127.0.0.1:31420  0.0.0.0:*',
        'LISTEN 0      4096   [::]:31421       [::]:*',
      ].join('\n'),
    });
    expect(result).toEqual({
      ok: true,
      cleaned: false,
      reason: 'listener-present',
      backendListeners: ['127.0.0.1'],
      ignoredTailnetListeners: [],
    });
    expect(calls).toHaveLength(1);
  });

  test('preserves a mapped port with a wildcard macOS netstat backend listener', async () => {
    const calls: ServeCall[] = [];
    const result = await cleanGhostTailscaleServe({
      port: 31420,
      probeFn: makeProbe(),
      serveCmdFn: makeServeCmd([{ exitCode: 0, stdout: mapped31420 }], calls),
      socketTableFn: async () => 'tcp4 0 0 *.31420 *.* LISTEN',
    });
    expect(result).toEqual({
      ok: true,
      cleaned: false,
      reason: 'listener-present',
      backendListeners: ['*'],
      ignoredTailnetListeners: [],
    });
    expect(calls).toHaveLength(1);
  });

  test('preserves a mapped port with a LAN-bound backend listener', async () => {
    const calls: ServeCall[] = [];
    const result = await cleanGhostTailscaleServe({
      port: 31420,
      probeFn: makeProbe(),
      serveCmdFn: makeServeCmd([{ exitCode: 0, stdout: mapped31420 }], calls),
      socketTableFn: async () => 'LISTEN 0 4096 192.168.1.20:31420 0.0.0.0:*',
    });
    expect(result).toEqual({
      ok: true,
      cleaned: false,
      reason: 'listener-present',
      backendListeners: ['192.168.1.20'],
      ignoredTailnetListeners: [],
    });
    expect(calls).toHaveLength(1);
  });

  test('removes a mapping when only Tailscale tailnet listeners occupy its port', async () => {
    const calls: ServeCall[] = [];
    const result = await cleanGhostTailscaleServe({
      port: 31420,
      probeFn: makeProbe(),
      serveCmdFn: makeServeCmd([{ exitCode: 0, stdout: mapped31420 }, { exitCode: 0 }], calls),
      socketTableFn: async () => [
        'tcp4 0 0 100.64.0.1.31420 *.* LISTEN',
        'tcp6 0 0 fd7a:115c:a1e0::1.31420 *.* LISTEN',
      ].join('\n'),
    });
    expect(result).toEqual({
      ok: true,
      cleaned: true,
      reason: 'cleaned',
      backendListeners: [],
      ignoredTailnetListeners: ['100.64.0.1', 'fd7a:115c:a1e0::1'],
    });
    expect(calls.map((call) => call.args)).toEqual([
      ['serve', 'status', '--json'],
      ['serve', '--tls-terminated-tcp', '31420', 'off'],
    ]);
  });

  test('removes only the ghost mapping and preserves other Serve mappings', async () => {
    const calls: ServeCall[] = [];
    const mappings: Record<string, unknown> = {
      '31420': { TCPForward: 'tcp://localhost:31420' },
      '31421': { TCPForward: 'tcp://localhost:31421' },
    };
    const serveCmdFn = async (binary: string, args: readonly string[]) => {
      calls.push({ binary, args: [...args] });
      if (args.join(' ') === 'serve status --json') {
        return { exitCode: 0, stdout: JSON.stringify({ TCP: mappings }), stderr: '' };
      }
      if (args.join(' ') === 'serve --tls-terminated-tcp 31420 off') {
        delete mappings['31420'];
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: `unexpected command: ${args.join(' ')}` };
    };
    const result = await cleanGhostTailscaleServe({
      port: 31420,
      probeFn: makeProbe(),
      serveCmdFn,
      socketTableFn: async () => 'tcp4 0 0 *.31421 *.* LISTEN',
    });
    expect(result).toEqual({
      ok: true,
      cleaned: true,
      reason: 'cleaned',
      backendListeners: [],
      ignoredTailnetListeners: [],
    });
    expect(calls.map((call) => call.args)).toEqual([
      ['serve', 'status', '--json'],
      ['serve', '--tls-terminated-tcp', '31420', 'off'],
    ]);
    const after = await serveCmdFn('tailscale', ['serve', 'status', '--json']);
    const remaining = JSON.parse(after.stdout).TCP;
    expect(remaining['31420']).toBeUndefined();
    expect(remaining['31421']).toEqual({ TCPForward: 'tcp://localhost:31421' });
    expect(calls.some((call) => call.args.join(' ') === 'serve reset')).toBe(false);
  });

  test('reports a port-specific removal failure without resetting other mappings', async () => {
    const calls: ServeCall[] = [];
    const result = await cleanGhostTailscaleServe({
      port: 31420,
      probeFn: makeProbe(),
      serveCmdFn: makeServeCmd([{ exitCode: 0, stdout: mapped31420 }, { exitCode: 1, stderr: 'off failed' }], calls),
      socketTableFn: async () => 'tcp4 0 0 *.31421 *.* LISTEN',
    });
    expect(result).toEqual({ ok: false, cleaned: false, reason: 'serve-off-failed', detail: 'off failed' });
    expect(calls.map((call) => call.args)).toEqual([
      ['serve', 'status', '--json'],
      ['serve', '--tls-terminated-tcp', '31420', 'off'],
    ]);
  });

  test('does not remove a mapping when the kernel socket table is unavailable', async () => {
    const calls: ServeCall[] = [];
    const result = await cleanGhostTailscaleServe({
      port: 31420,
      probeFn: makeProbe(),
      serveCmdFn: makeServeCmd([{ exitCode: 0, stdout: mapped31420 }], calls),
      socketTableFn: async () => null,
    });
    expect(result).toEqual({ ok: false, cleaned: false, reason: 'socket-table-unavailable' });
    expect(calls).toHaveLength(1);
  });

  test('does nothing when the requested port has no Serve mapping', async () => {
    const calls: ServeCall[] = [];
    const result = await cleanGhostTailscaleServe({
      port: 31420,
      probeFn: makeProbe(),
      serveCmdFn: makeServeCmd([{ exitCode: 0, stdout: JSON.stringify({ TCP: { '31421': {} } }) }], calls),
      socketTableFn: async () => '',
    });
    expect(result).toEqual({ ok: true, cleaned: false, reason: 'no-mapping' });
    expect(calls).toHaveLength(1);
  });
});

describe('readMountedState — legacy state file recovery', () => {
  test('reads legacy { version: 1, port: N } shape as tls-tcp', () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        port: 31420,
        hostname: 'mbp.tailnet.ts.net',
        mountedAt: '2026-05-09T00:00:00Z',
      }),
    );
    const s = readMountedState(statePath);
    expect(s?.mode.kind).toBe('tls-tcp');
    if (s?.mode.kind === 'tls-tcp') expect(s.mode.port).toBe(31420);
    expect(s?.upstreamPort).toBe(31420);
  });

  test('returns null on null path', () => {
    expect(readMountedState(undefined)).toBeNull();
  });
});
