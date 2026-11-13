import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPwaRegistration } from './pwa-registration.js';
import { runNexus } from './index.js';
import type { PwaRegistryEntry } from '../cli/pwa-registry.js';

const base = {
  pid: 4321,
  port: 43123,
  mode: 'static' as const,
  kind: 'production' as const,
  cwd: '/repo',
  daemonDir: '/state/nexus',
  shareMounted: true,
  https: false,
  startedAt: '2026-08-19T00:00:00.000Z',
};

describe('pwa registration lifecycle', () => {
  test('registers the resolved port and complete daemon metadata', () => {
    const entries: PwaRegistryEntry[] = [];
    const lifecycle = createPwaRegistration({
      register: (entry) => entries.push(entry),
      resolveLauncher: () => ({ kind: 'service-manager', serviceName: 'launchd' }),
    });

    const result = lifecycle.register(base);

    expect(result.status).toBe('registered');
    expect(entries).toEqual([{
      pid: base.pid,
      ports: [43123],
      mode: base.mode,
      kind: base.kind,
      cwd: base.cwd,
      daemonDir: base.daemonDir,
      shareMounted: base.shareMounted,
      https: base.https,
      startedAt: base.startedAt,
      launcherProvenance: { kind: 'service-manager', serviceName: 'launchd' },
    }]);
  });

  test('runNexus registers its resolved listener port before writing the HTTP runtime sidecar', async () => {
    const events: string[] = [];
    const entries: PwaRegistryEntry[] = [];
    const nexusDir = mkdtempSync(join(tmpdir(), 'nexus-pwa-registration-'));
    const previousNexusDir = process.env.ELANOUS_NEXUS_DIR;
    process.env.ELANOUS_NEXUS_DIR = nexusDir;
    const handle = await runNexus({
      detachForTesting: true,
      skipHttpServer: false,
      skipRuntimeApi: true,
      skipSupervisor: true,
      skipPushcutChannel: true,
      skipPwaChannel: true,
      skipTelegramChannel: true,
      skipDiscordChannel: true,
      skipTerminalChannel: true,
      skipIntentPrediction: true,
      skipEnvMigration: true,
      cleanGhostTailscaleServeFn: async () => undefined,
      pwaRegistrationDeps: {
        register: (entry) => { events.push('register'); entries.push(entry); },
        unregister: () => { events.push('unregister'); },
        resolveLauncher: () => ({ kind: 'unknown' }),
      },
      onRuntimeSidecarWrite: (runtime) => {
        if (runtime.httpPort !== undefined) events.push('runtime-http');
      },
    });
    try {
      expect(handle?.httpServer).toBeDefined();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        pid: process.pid,
        ports: [handle!.httpServer!.port],
        cwd: process.cwd(),
        shareMounted: false,
      });
      expect(events).toEqual(['register', 'runtime-http']);
    } finally {
      await handle?.release();
      if (previousNexusDir === undefined) delete process.env.ELANOUS_NEXUS_DIR;
      else process.env.ELANOUS_NEXUS_DIR = previousNexusDir;
      rmSync(nexusDir, { recursive: true, force: true });
    }
    expect(events).toEqual(['register', 'runtime-http', 'unregister']);
  });

  test('does not register when the listener port is unknown', () => {
    const register = () => { throw new Error('must not register'); };
    const lifecycle = createPwaRegistration({ register });

    expect(lifecycle.register({ ...base, port: undefined })).toEqual({ status: 'port-unknown' });
  });

  test('uses registry PID idempotency when registered twice', () => {
    const entries = new Map<number, PwaRegistryEntry>();
    const lifecycle = createPwaRegistration({ register: (entry) => entries.set(entry.pid, entry) });

    lifecycle.register(base);
    lifecycle.register({ ...base, port: 43124 });

    expect([...entries.values()]).toHaveLength(1);
    expect(entries.get(base.pid)?.ports).toEqual([43124]);
  });

  test('observes registration failures without throwing', () => {
    const events: string[] = [];
    const lifecycle = createPwaRegistration({
      register: () => { throw new Error('disk unavailable'); },
      observe: (event) => events.push(event),
    });

    const result = lifecycle.register(base);

    expect(result.status).toBe('register-failed');
    expect(events).toEqual(['register-failed']);
  });

  test('converts launcher and observation failures into a registration result', () => {
    const lifecycle = createPwaRegistration({
      register: () => { throw new Error('must not write'); },
      resolveLauncher: () => { throw new Error('launcher unavailable'); },
      observe: () => { throw new Error('logging unavailable'); },
    });

    expect(lifecycle.register(base).status).toBe('register-failed');
  });

  test('unregisters the successful registration exactly once', () => {
    const removed: number[] = [];
    const lifecycle = createPwaRegistration({
      register: () => {},
      unregister: (pid) => removed.push(pid),
    });

    lifecycle.register(base);
    expect(lifecycle.unregister()).toEqual({ status: 'unregistered' });
    expect(lifecycle.unregister()).toEqual({ status: 'not-registered' });
    expect(removed).toEqual([base.pid]);
  });

  test('does not register after shutdown began before asynchronous boot completed', () => {
    const entries: PwaRegistryEntry[] = [];
    const events: string[] = [];
    const lifecycle = createPwaRegistration({
      register: (entry) => entries.push(entry),
      observe: (event) => events.push(event),
    });

    expect(lifecycle.unregister()).toEqual({ status: 'not-registered' });
    expect(lifecycle.register(base)).toEqual({ status: 'closed' });
    expect(entries).toEqual([]);
    expect(events).toEqual(['unregistered', 'register-skipped-closed']);
  });

  test('does not unregister when registration never completed', () => {
    const removed: number[] = [];
    const lifecycle = createPwaRegistration({
      register: () => {},
      unregister: (pid) => removed.push(pid),
    });

    expect(lifecycle.unregister()).toEqual({ status: 'not-registered' });
    expect(removed).toEqual([]);
  });

  test('observes an unregistration failure once without throwing', () => {
    const events: string[] = [];
    let attempts = 0;
    const lifecycle = createPwaRegistration({
      register: () => {},
      unregister: () => {
        attempts += 1;
        throw new Error('registry unavailable');
      },
      observe: (event) => events.push(event),
    });

    lifecycle.register(base);
    expect(lifecycle.unregister().status).toBe('unregister-failed');
    expect(lifecycle.unregister()).toEqual({ status: 'not-registered' });
    expect(attempts).toBe(1);
    expect(events).toEqual(['registered', 'unregister-failed', 'unregistered']);
  });

  test('never throws during unregistration when observation fails', () => {
    const lifecycle = createPwaRegistration({
      register: () => {},
      unregister: () => { throw new Error('registry unavailable'); },
      observe: () => { throw new Error('logging unavailable'); },
    });

    lifecycle.register(base);
    expect(lifecycle.unregister().status).toBe('unregister-failed');
    expect(lifecycle.unregister()).toEqual({ status: 'not-registered' });
  });
});
