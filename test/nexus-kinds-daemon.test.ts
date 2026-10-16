// NEXUS · daemon kind tests (Phase N-2 PR ζ)
// Classification: removed — 25ef579f96ef87118fff6e002c6d383d7e0be935
// feat(nexus): delete kind-detail-view + trim 3 kind TabView funcs (U3 · PLAN-nexus-shell-followup) (#2853)
// removed createDaemonTabView with the TUI detail surface; retain spec, external-detection,
// and runNexus contracts because Bun executes this file directly.

import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootNexus,
  drainNexusBoots,
  warmNexusModule,
  NEXUS_DRAIN_TIMEOUT_MS,
  NEXUS_WARM_TIMEOUT_MS,
} from './helpers/nexus-boot-guard.js';
import {
  createDaemonTabSpec,
  detectExternalDaemon,
  DAEMON_KIND,
  DAEMON_DEFAULT_TAB_ID,
} from '../src/nexus/kinds/daemon.js';
import { TabRegistry } from '../src/nexus/state/tab-registry.js';
import { createNexusState } from '../src/nexus/state/state.js';
import {
  elanousDaemonLockPath,
  elanousDaemonSocketPath,
  type ElanousDaemonLockMeta,
} from '../src/nexus/../elanous-daemon.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../src/elanous-config-dir.js';

let tmpRoot: string;
let prevNexus: string | undefined;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-n2-daemon-'));
  prevNexus = process.env.ELANOUS_NEXUS_DIR;
  process.env.ELANOUS_NEXUS_DIR = tmpRoot;
  setElanousConfigDir(tmpRoot);
});
// 0.2.30 게이트 간섭(OP #9292) — 무거운 nexus import 는 시험 5s 예산 밖에서 데운다.
beforeAll(warmNexusModule, NEXUS_WARM_TIMEOUT_MS);

afterEach(async () => {
  // env 를 되돌리기 «전»에 남은 runNexus 를 끝까지 기다린다 — 시간초과된 시험의 부팅이
  // 다음 시험 폴더의 잠금을 잡지 못하게(TelegramLockError 간섭).
  await drainNexusBoots();
  if (prevNexus === undefined) delete process.env.ELANOUS_NEXUS_DIR;
  else process.env.ELANOUS_NEXUS_DIR = prevNexus;
  resetElanousConfigDir();
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}, NEXUS_DRAIN_TIMEOUT_MS);

describe('createDaemonTabSpec · default policy', () => {
  test('default id and command', () => {
    const spec = createDaemonTabSpec();
    expect(spec.id).toBe(DAEMON_DEFAULT_TAB_ID);
    expect(spec.kind).toBe(DAEMON_KIND);
    expect(spec.label).toBe(DAEMON_DEFAULT_TAB_ID);
    expect(spec.spawn?.command[1]).toBe('serve');
    expect(spec.spawn?.cwd).toBe(process.cwd());
  });

  test('socket health (10s · staleAfter 30s · timeout 1.5s)', () => {
    const spec = createDaemonTabSpec();
    expect(spec.health).toMatchObject({
      kind: 'socket',
      intervalMs: 10_000,
      timeoutMs: 1_500,
      staleAfterMs: 30_000,
    });
    expect((spec.health!.spec as { path: string }).path).toBe(elanousDaemonSocketPath());
  });

  test('stable backoff [5s, 15s, 60s] · maxPerHour 5 · grace 2s', () => {
    const spec = createDaemonTabSpec();
    expect(spec.restart).toEqual({
      policy: 'on-crash',
      backoffMs: [5_000, 15_000, 60_000],
      maxPerHour: 5,
      graceMs: 2_000,
    });
  });

  test('meta carries socket + lock paths', () => {
    const spec = createDaemonTabSpec();
    expect(spec.meta).toEqual({
      socketPath: elanousDaemonSocketPath(),
      lockPath: elanousDaemonLockPath(),
    });
  });

  test('opts override id/label/command/cwd/env/socket', () => {
    const spec = createDaemonTabSpec({
      id: 'd:custom',
      label: 'My Daemon',
      command: ['/usr/local/bin/elanous', 'serve'],
      cwd: '/srv/elanous',
      env: { ELANOUS_HISTORY_DIR: '/data' },
      socketPath: '/tmp/custom.sock',
    });
    expect(spec.id).toBe('d:custom');
    expect(spec.label).toBe('My Daemon');
    expect(spec.spawn?.command).toEqual(['/usr/local/bin/elanous', 'serve']);
    expect(spec.spawn?.cwd).toBe('/srv/elanous');
    expect(spec.spawn?.env).toEqual({ ELANOUS_HISTORY_DIR: '/data' });
    expect((spec.health!.spec as { path: string }).path).toBe('/tmp/custom.sock');
  });
});

function setup() {
  const state = createNexusState({ nexusVersion: '0.6.0', phase: 'test' });
  const registry = new TabRegistry(state);
  registry.register(createDaemonTabSpec());
  return { state, registry };
}

describe('detectExternalDaemon · no lock', () => {
  test('returns available when no lock present', () => {
    const { state, registry } = setup();
    const result = detectExternalDaemon({
      state, registry,
      readLock: () => null,
    });
    expect(result.outcome).toBe('available');
    expect(registry.get(DAEMON_DEFAULT_TAB_ID)!.status).toBe('idle');
  });

  test('returns no-tab when daemon tab not registered', () => {
    const state = createNexusState({ nexusVersion: '0.6.0', phase: 'test' });
    const registry = new TabRegistry(state);
    const result = detectExternalDaemon({
      state, registry,
      readLock: () => null,
    });
    expect(result.outcome).toBe('no-tab');
  });
});

describe('detectExternalDaemon · external alive', () => {
  test('alive external pid → status=external + tab.down event', () => {
    const { state, registry } = setup();
    const meta: ElanousDaemonLockMeta = {
      pid: 88888,
      host: 'remote-host',
      startedAt: new Date().toISOString(),
      label: 'elanous',
    };
    const result = detectExternalDaemon({
      state, registry,
      readLock: () => meta,
      isAlive: () => true,
    });
    expect(result.outcome).toBe('external');
    expect(result.externalPid).toBe(88888);
    expect(registry.get(DAEMON_DEFAULT_TAB_ID)!.status).toBe('external');
    expect(registry.get(DAEMON_DEFAULT_TAB_ID)!.pid).toBe(88888);
    const ev = state.events.find((e) => e.kind === 'tab.down' && e.tabId === DAEMON_DEFAULT_TAB_ID);
    expect(ev?.detail).toMatchObject({ reason: 'external-detected', externalPid: 88888, host: 'remote-host' });
  });

  test('lock pid matches own child pid → outcome=available', () => {
    const { state, registry } = setup();
    registry.patch(DAEMON_DEFAULT_TAB_ID, { pid: 12345 });
    const meta: ElanousDaemonLockMeta = {
      pid: 12345,
      host: 'host',
      startedAt: new Date().toISOString(),
      label: 'elanous',
    };
    const result = detectExternalDaemon({
      state, registry,
      readLock: () => meta,
      isAlive: () => true,
    });
    expect(result.outcome).toBe('available');
    expect(registry.get(DAEMON_DEFAULT_TAB_ID)!.status).toBe('idle');
  });
});

describe('detectExternalDaemon · stale lock', () => {
  test('dead external pid → outcome=available', () => {
    const { state, registry } = setup();
    const meta: ElanousDaemonLockMeta = {
      pid: 77777,
      host: 'host',
      startedAt: new Date().toISOString(),
      label: 'elanous',
    };
    const result = detectExternalDaemon({
      state, registry,
      readLock: () => meta,
      isAlive: () => false,
    });
    expect(result.outcome).toBe('available');
    expect(registry.get(DAEMON_DEFAULT_TAB_ID)!.status).toBe('idle');
  });

  test('previously-external tab cleared when external dies', () => {
    const { state, registry } = setup();
    registry.patch(DAEMON_DEFAULT_TAB_ID, { status: 'external', pid: 77777 });
    const result = detectExternalDaemon({
      state, registry,
      readLock: () => null,
    });
    expect(result.outcome).toBe('reclaimed');
    expect(registry.get(DAEMON_DEFAULT_TAB_ID)!.status).toBe('idle');
    expect(registry.get(DAEMON_DEFAULT_TAB_ID)!.pid).toBeUndefined();
    const ev = state.events.find((e) => e.kind === 'tab.down' && e.detail?.reason === 'external-cleared');
    expect(ev).toBeDefined();
  });
});

describe('runNexus integration · daemon registration', () => {
  test('detachForTesting=true skips daemon by default (regression preserve)', async () => {
    const handle = await bootNexus({ detachForTesting: true });
    expect(handle!.registry.has(DAEMON_DEFAULT_TAB_ID)).toBe(false);
    // chat only — webterm gated default-OFF (PWA mirror prep cleanup).
    expect(handle!.registry.list()).toHaveLength(1);
    handle!.release();
  });

  test('registerDaemonTab=true opts in to daemon entry', async () => {
    const handle = await bootNexus({
      detachForTesting: true,
      registerDaemonTab: true,
      autoStartDaemonTab: false, // don't actually spawn
    });
    expect(handle!.registry.has(DAEMON_DEFAULT_TAB_ID)).toBe(true);
    // chat + daemon (webterm default-OFF).
    expect(handle!.registry.list()).toHaveLength(2);
    expect(handle!.registry.get(DAEMON_DEFAULT_TAB_ID)!.status).toBe('idle');
    handle!.release();
  });
});
