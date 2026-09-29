import { describe, expect, test } from 'bun:test';
import { resolveDaemonEndpoint } from './daemon-endpoint.js';
import type { PwaShowResult } from '../cli/pwa-show.js';
import type { PwaInstanceListing } from '../cli/pwa-registry.js';
import { debug } from '../debug/log.js';
import type { NexusLifecycleState } from './supervisor/lock.js';

const root = '/isolated/nexus';

function lifecycle(httpPort: number | undefined, tailnetUrl?: string): NexusLifecycleState {
  return {
    root,
    lock: { pid: 4321 } as NexusLifecycleState['lock'],
    runtime: {
      pid: 4321,
      startedAt: '2026-08-19T00:00:00.000Z',
      nexusVersion: '1.0',
      phase: 'running',
      httpHost: '127.0.0.1',
      httpPort,
      tailnetUrl,
    },
  };
}

const isolated = { cwd: '/isolated/project', nexusRootFn: () => root };

describe('resolveDaemonEndpoint', () => {
  test('delegates a real registry lookup to resolveNexusPwa', () => {
    expect(resolveDaemonEndpoint({
      ...isolated,
      listFn: () => [{ cwd: isolated.cwd, ports: [43123] } as PwaInstanceListing],
      lifecycleFn: () => null,
    })).toEqual({
      baseUrl: 'http://127.0.0.1:43123',
      healthUrl: 'http://127.0.0.1:43123/v1/health',
      pwaUrl: 'http://127.0.0.1:43123/app/',
      source: 'registry',
    });
  });

  test('uses the registry loopback origin for the API, preserving the chosen tailnet PWA URL', () => {
    const result = resolveDaemonEndpoint({
      ...isolated,
      pwaResult: {
        instance: { pid: 4321 } as PwaShowResult['instance'],
        urls: { loopback: 'http://127.0.0.1:43123/app/', tailnet: 'https://device.ts.net:43123/app/' },
      },
      lifecycleFn: () => null,
    });
    expect(result).toEqual({
      baseUrl: 'http://127.0.0.1:43123',
      healthUrl: 'http://127.0.0.1:43123/v1/health',
      pwaUrl: 'https://device.ts.net:43123/app/',
      source: 'registry',
    });
  });

  test('takes an unregistered daemon from its matching lifecycle sidecar, including its tailnet link', () => {
    expect(resolveDaemonEndpoint({
      ...isolated,
      listFn: () => [],
      lifecycleFn: () => lifecycle(43210, 'https://device.ts.net:43210/app/'),
    })).toEqual({
      baseUrl: 'http://127.0.0.1:43210',
      healthUrl: 'http://127.0.0.1:43210/v1/health',
      pwaUrl: 'https://device.ts.net:43210/app/',
      source: 'lifecycle',
    });
  });

  test('does not invent URLs if the daemon is absent or its lifecycle HTTP port is unknown', () => {
    expect(resolveDaemonEndpoint({ ...isolated, listFn: () => [], lifecycleFn: () => null })).toBeNull();
    expect(resolveDaemonEndpoint({ ...isolated, listFn: () => [], lifecycleFn: () => lifecycle(undefined) })).toBeNull();
  });

  test('does not invent URLs when registry lookup fails', () => {
    expect(resolveDaemonEndpoint({ ...isolated, listFn: () => { throw new Error('registry unavailable'); }, lifecycleFn: () => null })).toBeNull();
  });

  test('uses the normalized URL origin when the resolved HTTP port is the default', () => {
    expect(resolveDaemonEndpoint({ ...isolated, listFn: () => [], lifecycleFn: () => lifecycle(80) })).toEqual({
      baseUrl: 'http://127.0.0.1',
      healthUrl: 'http://127.0.0.1/v1/health',
      pwaUrl: 'http://127.0.0.1/app/',
      source: 'lifecycle',
    });
  });

  test('watch falls back to the production universe only when the current universe is daemon-absent', () => {
    const productionRoot = '/production/elanous';
    const logs: unknown[][] = [];
    const original = debug.log;
    debug.log = ((...args: unknown[]) => { logs.push(args); }) as typeof debug.log;
    const absentHere = {
      ...isolated,
      listForCwdFn: (cwd: string) => cwd === productionRoot
        ? [{ cwd: productionRoot, ports: [4455] } as PwaInstanceListing]
        : [],
      lifecycleFn: () => null,
      productionRootFn: () => productionRoot,
    };
    try {
      expect(resolveDaemonEndpoint(absentHere)).toBeNull();
      expect(resolveDaemonEndpoint({ ...absentHere, purpose: 'watch' })).toEqual({
        baseUrl: 'http://127.0.0.1:4455',
        healthUrl: 'http://127.0.0.1:4455/v1/health',
        pwaUrl: 'http://127.0.0.1:4455/app/',
        source: 'registry',
        universe: 'production',
      });
    } finally {
      debug.log = original;
    }
    expect(logs).toContainEqual(['nexus.endpoint', 'watch-fallback', { reason: 'daemon-absent', universe: 'production' }]);
    expect(resolveDaemonEndpoint({
      ...isolated,
      listFn: () => [{ cwd: isolated.cwd, ports: [43123] } as PwaInstanceListing],
      lifecycleFn: () => null,
      purpose: 'watch',
      productionRootFn: () => productionRoot,
    })).toEqual({
      baseUrl: 'http://127.0.0.1:43123',
      healthUrl: 'http://127.0.0.1:43123/v1/health',
      pwaUrl: 'http://127.0.0.1:43123/app/',
      source: 'registry',
    });
  });
});

describe('watch fallback on real production lock files', () => {
  test('reads the production daemon from its own lock and runtime files, not the current universe', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir, hostname } = await import('node:os');
    const { join } = await import('node:path');
    const prod = mkdtempSync(join(tmpdir(), 'daemon-endpoint-prod-'));
    const current = mkdtempSync(join(tmpdir(), 'daemon-endpoint-current-'));
    try {
      mkdirSync(join(prod, 'nexus'), { recursive: true });
      const startedAt = new Date().toISOString();
      writeFileSync(join(prod, 'nexus', '.lock'), JSON.stringify({ pid: process.pid, host: hostname(), startedAt }));
      writeFileSync(join(prod, 'nexus', 'runtime.json'), JSON.stringify({
        pid: process.pid, startedAt, nexusVersion: '1.0', phase: 'running', httpHost: '127.0.0.1', httpPort: 45678,
      }));
      const opts = {
        cwd: join(current, 'project'),
        nexusRootFn: () => join(current, 'nexus'),
        listFn: () => [],
        lifecycleFn: () => null,
        productionRootFn: () => prod,
      };
      expect(resolveDaemonEndpoint(opts)).toBeNull();
      expect(resolveDaemonEndpoint({ ...opts, purpose: 'watch' })).toMatchObject({
        baseUrl: 'http://127.0.0.1:45678',
        universe: 'production',
      });
    } finally {
      rmSync(prod, { recursive: true, force: true });
      rmSync(current, { recursive: true, force: true });
    }
  });
});
