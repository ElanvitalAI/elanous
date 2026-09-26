// P4 (2026-05-10) — pwa-registry unit coverage.

import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  clearPwaRegistry,
  inspectPwaInstances,
  listPwaInstances,
  registerPwaInstance,
  resolvePwaLauncherProvenance,
  unregisterPwaInstance,
  type PwaRegistryEntry,
  type PwaRegistryObservationArgs,
} from '../src/cli/pwa-registry.js';

function tmpRegistry(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pwa-registry-test-'));
  const path = join(dir, 'pwa-registry.json');
  return {
    path,
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ } },
  };
}

function confirmedDeadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  expect(child.status).toBe(0);
  expect(child.pid).toBeDefined();
  const pid = child.pid!;
  expect(() => process.kill(pid, 0)).toThrow();
  return pid;
}

function fixtureEntry(overrides: Partial<PwaRegistryEntry> = {}): PwaRegistryEntry {
  return {
    pid: 99999, // overridden by confirmedDeadPid() in stale-entry tests
    ports: [31415],
    mode: 'static',
    kind: 'production',
    cwd: '/tmp/fake-cwd',
    daemonDir: '/tmp/fake-daemon-dir',
    shareMounted: false,
    https: false,
    startedAt: '2026-05-10T12:00:00.000Z',
    ...overrides,
  };
}

describe('pwa-registry launcher provenance', () => {
  test('classifies injected launch signals with autonomous identity precedence', () => {
    expect(resolvePwaLauncherProvenance({ env: { ELANOUS_RUN_ID: 'run-42' }, isTTY: true }))
      .toEqual({ kind: 'autonomous-run', runId: 'run-42' });
    expect(resolvePwaLauncherProvenance({ env: {
      ELANOUS_RUN_ID: 'run-42', LAUNCH_JOB_NAME: 'com.elanous.nexus', ELANOUS_NEXUS_BG_PARENT: '1',
    }, isTTY: true })).toEqual({ kind: 'autonomous-run', runId: 'run-42' });
  });

  test('recognizes only elanous XPC services and preserves autonomous-run precedence', () => {
    expect(resolvePwaLauncherProvenance({ env: { XPC_SERVICE_NAME: 'com.elanous.nexus' }, isTTY: false }))
      .toEqual({ kind: 'service-manager', serviceName: 'com.elanous.nexus' });
    expect(resolvePwaLauncherProvenance({ env: { XPC_SERVICE_NAME: 'com.apple.Terminal' }, isTTY: false }))
      .toEqual({ kind: 'unknown' });
    expect(resolvePwaLauncherProvenance({ env: { XPC_SERVICE_NAME: 'com.apple.Terminal' }, isTTY: true }))
      .toEqual({ kind: 'human-terminal' });
    expect(resolvePwaLauncherProvenance({ env: {
      ELANOUS_RUN_ID: 'run-42', XPC_SERVICE_NAME: 'com.elanous.nexus', INVOCATION_ID: 'id', SYSTEMD_EXEC_PID: '42',
    }, isTTY: false })).toEqual({ kind: 'autonomous-run', runId: 'run-42' });
  });

  test('requires INVOCATION_ID plus a systemd execution signal', () => {
    for (const signal of ['SYSTEMD_EXEC_PID', 'JOURNAL_STREAM'] as const) {
      expect(resolvePwaLauncherProvenance({ env: { INVOCATION_ID: 'id', [signal]: 'value' }, isTTY: false }))
        .toEqual({ kind: 'service-manager', serviceName: 'systemd' });
      expect(resolvePwaLauncherProvenance({ env: { [signal]: 'value' }, isTTY: false }))
        .toEqual({ kind: 'unknown' });
    }
    expect(resolvePwaLauncherProvenance({ env: { INVOCATION_ID: 'id' }, isTTY: false }))
      .toEqual({ kind: 'unknown' });
  });

  test('distinguishes service manager, background child, terminal, and unknown signals', () => {
    expect(resolvePwaLauncherProvenance({ env: { LAUNCH_JOB_NAME: 'com.elanous.nexus' }, isTTY: true }))
      .toEqual({ kind: 'service-manager', serviceName: 'com.elanous.nexus' });
    expect(resolvePwaLauncherProvenance({ env: {
      LAUNCH_JOB_NAME: 'com.elanous.nexus', ELANOUS_NEXUS_BG_PARENT: '1',
    }, isTTY: true })).toEqual({ kind: 'service-manager', serviceName: 'com.elanous.nexus' });
    expect(resolvePwaLauncherProvenance({ env: { ELANOUS_NEXUS_BG_PARENT: '1' }, isTTY: true }))
      .toEqual({ kind: 'background-child' });
    expect(resolvePwaLauncherProvenance({ env: {}, isTTY: true })).toEqual({ kind: 'human-terminal' });
    expect(resolvePwaLauncherProvenance({ env: {}, isTTY: false })).toEqual({ kind: 'unknown' });
  });
});

describe('pwa-registry · register + list + prune', () => {
  test('register writes a versioned JSON file (v1, instances array)', () => {
    const { path, cleanup } = tmpRegistry();
    try {
      registerPwaInstance(fixtureEntry({ pid: 11111 }), { registryPath: path });
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      expect(raw.version).toBe(1);
      expect(raw.instances).toHaveLength(1);
      expect(raw.instances[0].pid).toBe(11111);
    } finally { cleanup(); }
  });

  test('provenance round-trips and persists through an atomic prune rewrite', () => {
    const { path, cleanup } = tmpRegistry();
    try {
      const deadPid = confirmedDeadPid();
      const launcherProvenance = { kind: 'autonomous-run' as const, runId: 'run-42' };
      registerPwaInstance(fixtureEntry({ pid: deadPid }), { registryPath: path });
      registerPwaInstance(fixtureEntry({ pid: process.pid, launcherProvenance }), { registryPath: path });

      const result = inspectPwaInstances({ registryPath: path });
      expect(result.diagnostics.pruned).toEqual([{ pid: deadPid, reason: 'pid-not-alive' }]);
      expect(result.instances).toEqual([expect.objectContaining({
        pid: process.pid,
        launcherProvenance,
      })]);
      expect(JSON.parse(readFileSync(path, 'utf8')).instances).toEqual([expect.objectContaining({
        pid: process.pid,
        launcherProvenance,
      })]);
    } finally { cleanup(); }
  });

  test('detected launchd provenance persists in the version-1 registry', () => {
    const { path, cleanup } = tmpRegistry();
    try {
      const launcherProvenance = resolvePwaLauncherProvenance({ env: { XPC_SERVICE_NAME: 'com.elanous.nexus' }, isTTY: false });
      registerPwaInstance(fixtureEntry({ pid: process.pid, launcherProvenance }), { registryPath: path });
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      expect(Object.keys(raw).sort()).toEqual(['instances', 'version']);
      expect(raw.version).toBe(1);
      expect(raw.instances[0].launcherProvenance).toEqual(launcherProvenance);
      expect(listPwaInstances({ registryPath: path, prune: false })[0]?.launcherProvenance).toEqual(launcherProvenance);
    } finally { cleanup(); }
  });

  test('legacy or malformed provenance remains readable as unknown', () => {
    const { path, cleanup } = tmpRegistry();
    try {
      const rawEntries = [
        fixtureEntry({ pid: process.pid }),
        { ...fixtureEntry({ pid: process.pid + 1 }), launcherProvenance: { kind: 'autonomous-run' } },
        { ...fixtureEntry({ pid: process.pid + 2 }), launcherProvenance: 'not-a-provenance' },
        { ...fixtureEntry({ pid: process.pid + 3 }), launcherProvenance: { kind: 'service-manager', serviceName: 42 } },
        { ...fixtureEntry({ pid: process.pid + 4 }), launcherProvenance: { kind: 'unrecognized' } },
      ];
      writeFileSync(path, JSON.stringify({ version: 1, instances: rawEntries }));
      const list = listPwaInstances({ registryPath: path, prune: false });
      expect(list).toHaveLength(5);
      expect(list.map((entry) => entry.launcherProvenance)).toEqual([
        { kind: 'unknown' },
        { kind: 'unknown' },
        { kind: 'unknown' },
        { kind: 'unknown' },
        { kind: 'unknown' },
      ]);
    } finally { cleanup(); }
  });

  test('missing required fields remain filtered while missing provenance does not', () => {
    const { path, cleanup } = tmpRegistry();
    try {
      const { cwd: _cwd, ...missingCwd } = fixtureEntry({ pid: process.pid });
      writeFileSync(path, JSON.stringify({
        version: 1,
        instances: [fixtureEntry({ pid: process.pid }), missingCwd],
      }));
      const result = inspectPwaInstances({ registryPath: path, prune: false });
      expect(result.diagnostics.readState).toBe('malformed');
      expect(result.instances).toEqual([expect.objectContaining({
        pid: process.pid,
        launcherProvenance: { kind: 'unknown' },
      })]);
    } finally { cleanup(); }
  });

  test('register with same pid replaces (idempotent — last write wins)', () => {
    const { path, cleanup } = tmpRegistry();
    try {
      registerPwaInstance(fixtureEntry({ pid: 11111, mode: 'static' }), { registryPath: path });
      registerPwaInstance(fixtureEntry({ pid: 11111, mode: 'hmr', ports: [31415, 3210] }), { registryPath: path });
      const list = listPwaInstances({ registryPath: path, prune: false });
      expect(list).toHaveLength(1);
      expect(list[0]!.mode).toBe('hmr');
      expect(list[0]!.ports).toEqual([31415, 3210]);
    } finally { cleanup(); }
  });

  test('register with different pid keeps both', () => {
    const { path, cleanup } = tmpRegistry();
    try {
      registerPwaInstance(fixtureEntry({ pid: 11111 }), { registryPath: path });
      registerPwaInstance(fixtureEntry({ pid: 22222, ports: [31420] }), { registryPath: path });
      const list = listPwaInstances({ registryPath: path, prune: false });
      expect(list).toHaveLength(2);
      const pids = list.map((e) => e.pid).sort();
      expect(pids).toEqual([11111, 22222]);
    } finally { cleanup(); }
  });

  test('unregister removes by pid (no-op if absent)', () => {
    const { path, cleanup } = tmpRegistry();
    try {
      registerPwaInstance(fixtureEntry({ pid: 11111 }), { registryPath: path });
      registerPwaInstance(fixtureEntry({ pid: 22222 }), { registryPath: path });
      unregisterPwaInstance(11111, { registryPath: path });
      const list = listPwaInstances({ registryPath: path, prune: false });
      expect(list).toHaveLength(1);
      expect(list[0]!.pid).toBe(22222);
      // unknown pid → no-op (no throw, no list change)
      unregisterPwaInstance(99999, { registryPath: path });
      expect(listPwaInstances({ registryPath: path, prune: false })).toHaveLength(1);
    } finally { cleanup(); }
  });

  test('list with prune=true returns and persists only live entries when a dead same-cwd entry comes first', () => {
    const { path, cleanup } = tmpRegistry();
    try {
      const cwd = '/tmp/shared-cwd';
      registerPwaInstance(fixtureEntry({ pid: confirmedDeadPid(), cwd }), { registryPath: path });
      registerPwaInstance(fixtureEntry({ pid: process.pid, cwd }), { registryPath: path });

      const first = listPwaInstances({ registryPath: path });
      const second = listPwaInstances({ registryPath: path });

      expect(first).toEqual([expect.objectContaining({ pid: process.pid, cwd, alive: true })]);
      expect(second).toEqual(first);
      expect(JSON.parse(readFileSync(path, 'utf8')).instances).toEqual([expect.objectContaining({ pid: process.pid, cwd })]);
    } finally { cleanup(); }
  });

  test('list with prune=false keeps stale entries visible without changing the registry', () => {
    const { path, cleanup } = tmpRegistry();
    try {
      const deadPid = confirmedDeadPid();
      registerPwaInstance(fixtureEntry({ pid: deadPid }), { registryPath: path });
      const list = listPwaInstances({ registryPath: path, prune: false });
      expect(list).toEqual([expect.objectContaining({ pid: deadPid, alive: false, pidLiveness: 'dead' })]);
      expect(JSON.parse(readFileSync(path, 'utf8')).instances).toEqual([expect.objectContaining({ pid: deadPid })]);
    } finally { cleanup(); }
  });

  test('listPwaInstances on empty file returns []', () => {
    const { path, cleanup } = tmpRegistry();
    try {
      expect(listPwaInstances({ registryPath: path })).toEqual([]);
    } finally { cleanup(); }
  });

  test('inspection distinguishes a missing registry from a present empty registry', () => {
    const { path, cleanup } = tmpRegistry();
    try {
      expect(inspectPwaInstances({ registryPath: path }).diagnostics).toMatchObject({
        readState: 'missing', registeredCount: 0, livenessProbe: 'pid-signal-0', serviceObservation: 'unknown', serviceMismatch: false,
      });
      writeFileSync(path, JSON.stringify({ version: 1, instances: [] }));
      expect(inspectPwaInstances({ registryPath: path }).diagnostics).toMatchObject({
        readState: 'present-empty', registeredCount: 0, pruned: [],
      });
    } finally { cleanup(); }
  });

  test('inspection reports malformed registry without claiming service absence', () => {
    const { path, cleanup } = tmpRegistry();
    try {
      writeFileSync(path, 'not json');
      expect(inspectPwaInstances({ registryPath: path }).diagnostics).toMatchObject({
        readState: 'malformed', registeredCount: 0, serviceObservation: 'unknown', serviceMismatch: false,
      });
    } finally { cleanup(); }
  });

  test('empty registration with a responding expected endpoint reports a mismatch without claiming service absence', () => {
    const { path, cleanup } = tmpRegistry();
    try {
      writeFileSync(path, JSON.stringify({ version: 1, instances: [] }));
      const result = inspectPwaInstances({
        registryPath: path,
        expectedPorts: [31415],
        serviceProbe: (ports) => ports[0] === 31415 ? 'responding' : 'not-responding',
      });
      expect(result.diagnostics).toMatchObject({
        readState: 'present-empty', serviceObservation: 'responding', serviceMismatch: true, pruned: [],
      });
    } finally { cleanup(); }
  });

  test('PID-dead entries are pruned from the returned view and recorded even when service observation is unknown', () => {
    const { path, cleanup } = tmpRegistry();
    try {
      const deadPid = confirmedDeadPid();
      registerPwaInstance(fixtureEntry({ pid: deadPid }), { registryPath: path });
      const result = inspectPwaInstances({ registryPath: path, serviceProbe: () => 'unknown' });
      expect(result.instances).toEqual([]);
      expect(result.diagnostics).toMatchObject({
        livenessProbe: 'pid-signal-0', serviceObservation: 'unknown', serviceMismatch: false,
        pruned: [{ pid: deadPid, reason: 'pid-not-alive' }],
      });
      expect(JSON.parse(readFileSync(path, 'utf8')).instances).toEqual([]);
    } finally { cleanup(); }
  });

  test('responding service with only dead registrations reports a mismatch', () => {
    const { path, cleanup } = tmpRegistry();
    try {
      const deadPid = confirmedDeadPid();
      registerPwaInstance(fixtureEntry({ pid: deadPid }), { registryPath: path });
      const result = inspectPwaInstances({ registryPath: path, serviceProbe: () => 'responding' });
      expect(result.diagnostics).toMatchObject({
        registeredCount: 1, serviceObservation: 'responding', serviceMismatch: true,
        pruned: [{ pid: deadPid, reason: 'pid-not-alive' }],
      });
    } finally { cleanup(); }
  });

  test('responding service with a live registration does not report a mismatch', () => {
    const { path, cleanup } = tmpRegistry();
    try {
      registerPwaInstance(fixtureEntry({ pid: process.pid }), { registryPath: path });
      const result = inspectPwaInstances({ registryPath: path, serviceProbe: () => 'responding' });
      expect(result.diagnostics).toMatchObject({
        registeredCount: 1, serviceObservation: 'responding', serviceMismatch: false, pruned: [],
      });
    } finally { cleanup(); }
  });

  test('a PID-live entry remains registered and reports its PID criterion', () => {
    const { path, cleanup } = tmpRegistry();
    try {
      registerPwaInstance(fixtureEntry({ pid: process.pid }), { registryPath: path });
      const result = inspectPwaInstances({ registryPath: path, serviceProbe: () => 'not-responding' });
      expect(result.instances).toEqual([expect.objectContaining({ pid: process.pid, alive: true, pidLiveness: 'alive' })]);
      expect(result.diagnostics).toMatchObject({ serviceObservation: 'not-responding', pruned: [] });
      expect(JSON.parse(readFileSync(path, 'utf8')).instances).toHaveLength(1);
    } finally { cleanup(); }
  });

  test('registry mutations emit their target, remaining count, and registry path', () => {
    const { path, cleanup } = tmpRegistry();
    const events: PwaRegistryObservationArgs[] = [];
    const observe = (...args: PwaRegistryObservationArgs): void => { events.push(args); };
    try {
      registerPwaInstance(fixtureEntry({ pid: 11111 }), { registryPath: path, observe });
      registerPwaInstance(fixtureEntry({ pid: 22222 }), { registryPath: path, observe });
      unregisterPwaInstance(11111, { registryPath: path, observe });
      clearPwaRegistry({ registryPath: path, observe });

      expect(events).toEqual([
        ['registered', { pid: 11111, remainingCount: 1, registryPath: path }],
        ['registered', { pid: 22222, remainingCount: 2, registryPath: path }],
        ['unregistered', { pid: 11111, remainingCount: 1, registryPath: path }],
        ['cleared', { pids: [22222], remainingCount: 0, deletedCount: 1, success: true, registryPath: path }],
      ]);
    } finally { cleanup(); }
  });

  test('clearPwaRegistry observes both deleted entries and removes the file', () => {
    const { path, cleanup } = tmpRegistry();
    const events: PwaRegistryObservationArgs[] = [];
    const observe = (...args: PwaRegistryObservationArgs): void => { events.push(args); };
    try {
      registerPwaInstance(fixtureEntry({ pid: 11111 }), { registryPath: path });
      registerPwaInstance(fixtureEntry({ pid: 22222 }), { registryPath: path });
      clearPwaRegistry({ registryPath: path, observe });
      expect(listPwaInstances({ registryPath: path })).toEqual([]);
      expect(events).toEqual([
        ['cleared', { pids: [11111, 22222], remainingCount: 0, deletedCount: 2, success: true, registryPath: path }],
      ]);
      // calling again on absent file — no throw
      clearPwaRegistry({ registryPath: path });
    } finally { cleanup(); }
  });

  test('clear records failed deletion without claiming the registry was removed', () => {
    const { path, cleanup } = tmpRegistry();
    const events: PwaRegistryObservationArgs[] = [];
    try {
      registerPwaInstance(fixtureEntry({ pid: 11111 }), { registryPath: path });
      registerPwaInstance(fixtureEntry({ pid: 22222 }), { registryPath: path });
      expect(() => clearPwaRegistry({
        registryPath: path,
        observe: (...args) => { events.push(args); },
        removeFile: () => { throw new Error('permission denied'); },
      })).not.toThrow();
      expect(listPwaInstances({ registryPath: path, prune: false })).toHaveLength(2);
      expect(events).toEqual([
        ['cleared', { pids: [11111, 22222], remainingCount: 2, deletedCount: 0, success: false, registryPath: path }],
      ]);
    } finally { cleanup(); }
  });

  test('observer failures preserve every mutation result', () => {
    const { path, cleanup } = tmpRegistry();
    const observe = (): never => { throw new Error('observer unavailable'); };
    try {
      expect(() => registerPwaInstance(fixtureEntry({ pid: 11111 }), { registryPath: path, observe })).not.toThrow();
      expect(listPwaInstances({ registryPath: path, prune: false })).toEqual([expect.objectContaining({ pid: 11111 })]);
      expect(() => unregisterPwaInstance(11111, { registryPath: path, observe })).not.toThrow();
      expect(listPwaInstances({ registryPath: path, prune: false })).toEqual([]);
      registerPwaInstance(fixtureEntry({ pid: 22222 }), { registryPath: path });
      expect(() => clearPwaRegistry({ registryPath: path, observe })).not.toThrow();
      expect(listPwaInstances({ registryPath: path, prune: false })).toEqual([]);
    } finally { cleanup(); }
  });

  test('malformed registry file → treated as empty (defensive)', () => {
    const { path, cleanup } = tmpRegistry();
    try {
      // Write garbage directly
      const fs = require('node:fs') as typeof import('node:fs');
      fs.mkdirSync(require('node:path').dirname(path), { recursive: true });
      fs.writeFileSync(path, 'not json');
      expect(listPwaInstances({ registryPath: path })).toEqual([]);
      // Subsequent register should overwrite with valid JSON
      registerPwaInstance(fixtureEntry(), { registryPath: path });
      expect(listPwaInstances({ registryPath: path, prune: false })).toHaveLength(1);
    } finally { cleanup(); }
  });

  test('atomic write — no stale tmp file lingers after register', () => {
    const { path, cleanup } = tmpRegistry();
    try {
      registerPwaInstance(fixtureEntry(), { registryPath: path });
      const fs = require('node:fs') as typeof import('node:fs');
      const dir = require('node:path').dirname(path);
      const files = fs.readdirSync(dir).filter((n: string) => n.startsWith('pwa-registry.json.tmp'));
      expect(files).toEqual([]);
    } finally { cleanup(); }
  });
});
