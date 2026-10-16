// NEXUS · pwa-host kind tests (Phase N-2 PR η)
// Classification: removed — 25ef579f96ef87118fff6e002c6d383d7e0be935
// feat(nexus): delete kind-detail-view + trim 3 kind TabView funcs (U3 · PLAN-nexus-shell-followup) (#2853)
// removed createPwaHostTabView with the TUI detail surface; retain spec, restart,
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
  createPwaHostTabSpec,
  PWA_HOST_DEFAULT_TAB_ID,
  PWA_HOST_DEFAULT_HEALTHZ,
  PWA_HOST_DEFAULT_PORT,
  PWA_HOST_HALT_PATTERNS,
} from '../src/nexus/kinds/pwa-host.js';
import { TabRegistry } from '../src/nexus/state/tab-registry.js';
import { createNexusState } from '../src/nexus/state/state.js';
import { createSupervisor } from '../src/nexus/supervisor/index.js';
import { makeTestSpawnBackend } from '../src/nexus/supervisor/spawn.js';
import { maybeScheduleRestart } from '../src/nexus/supervisor/restart.js';

let tmpRoot: string;
let prevEnv: string | undefined;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-n2-pwa-'));
  prevEnv = process.env.ELANOUS_NEXUS_DIR;
  process.env.ELANOUS_NEXUS_DIR = tmpRoot;
});
// 0.2.30 게이트 간섭(OP #9292) — 무거운 nexus import 는 시험 5s 예산 밖에서 데운다.
beforeAll(warmNexusModule, NEXUS_WARM_TIMEOUT_MS);

afterEach(async () => {
  // env 를 되돌리기 «전»에 남은 runNexus 를 끝까지 기다린다 — 시간초과된 시험의 부팅이
  // 다음 시험 폴더의 잠금을 잡지 못하게(TelegramLockError 간섭).
  await drainNexusBoots();
  if (prevEnv === undefined) delete process.env.ELANOUS_NEXUS_DIR;
  else process.env.ELANOUS_NEXUS_DIR = prevEnv;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}, NEXUS_DRAIN_TIMEOUT_MS);

describe('createPwaHostTabSpec · default policy', () => {
  test('default id, command, healthz', () => {
    const spec = createPwaHostTabSpec();
    expect(spec.id).toBe(PWA_HOST_DEFAULT_TAB_ID);
    expect(spec.kind).toBe('pwa-host');
    expect(spec.spawn?.command).toEqual(['bun', 'run', 'dev']);
    expect((spec.health!.spec as { url: string }).url).toBe(PWA_HOST_DEFAULT_HEALTHZ);
    expect(PWA_HOST_DEFAULT_HEALTHZ).toContain(String(PWA_HOST_DEFAULT_PORT));
  });

  test('cwd defaults to apps/pwa under cwd', () => {
    const spec = createPwaHostTabSpec();
    expect(spec.spawn?.cwd?.endsWith(join('apps', 'pwa'))).toBe(true);
  });

  test('http health (5s · staleAfter 30s · timeout 3s)', () => {
    const spec = createPwaHostTabSpec();
    expect(spec.health).toMatchObject({
      kind: 'http',
      intervalMs: 5_000,
      timeoutMs: 3_000,
      staleAfterMs: 30_000,
    });
  });

  test('aggressive backoff [5s,10s,30s,60s,5m] · maxPerHour 10 · grace 8s', () => {
    const spec = createPwaHostTabSpec();
    expect(spec.restart).toMatchObject({
      policy: 'on-crash',
      backoffMs: [5_000, 10_000, 30_000, 60_000, 300_000],
      maxPerHour: 10,
      graceMs: 8_000,
    });
  });

  test('default halt patterns include EADDRINUSE + module-not-found', () => {
    const spec = createPwaHostTabSpec();
    expect(spec.restart?.haltPatterns).toEqual([...PWA_HOST_HALT_PATTERNS]);
  });

  test('custom halt patterns extend defaults', () => {
    const spec = createPwaHostTabSpec({ haltPatterns: ['ENOENT'] });
    expect(spec.restart?.haltPatterns).toEqual([...PWA_HOST_HALT_PATTERNS, 'ENOENT']);
  });

  test('replaceHaltPatterns=true overrides defaults entirely', () => {
    const spec = createPwaHostTabSpec({ haltPatterns: ['only-this'], replaceHaltPatterns: true });
    expect(spec.restart?.haltPatterns).toEqual(['only-this']);
  });

  test('opts override id/label/command/cwd/env/healthz', () => {
    const spec = createPwaHostTabSpec({
      id: 'pwa:dev',
      label: 'PWA Dev',
      command: ['npm', 'run', 'dev'],
      cwd: '/srv/web',
      env: { PORT: '4000' },
      healthzUrl: 'http://localhost:4000/healthz',
    });
    expect(spec.id).toBe('pwa:dev');
    expect(spec.label).toBe('PWA Dev');
    expect(spec.spawn?.command).toEqual(['npm', 'run', 'dev']);
    expect(spec.spawn?.cwd).toBe('/srv/web');
    expect(spec.spawn?.env).toEqual({ PORT: '4000' });
    expect((spec.health!.spec as { url: string }).url).toBe('http://localhost:4000/healthz');
  });
});

describe('halt-pattern integration via supervisor + restart', () => {
  test('EADDRINUSE on stderr triggers halt outcome (no restart scheduled)', () => {
    const state = createNexusState({ nexusVersion: '0.7.0', phase: 'test' });
    const registry = new TabRegistry(state);
    registry.register(createPwaHostTabSpec());
    const result = maybeScheduleRestart({
      state, registry, tabId: PWA_HOST_DEFAULT_TAB_ID,
      lastError: 'Error: listen EADDRINUSE: address already in use :::3210',
      callbacks: {
        async stop() { /* noop */ },
        async start() { /* noop */ },
      },
    });
    expect(result.outcome).toBe('halted-pattern');
    expect(result.matchedPattern).toBe('EADDRINUSE');
    expect(registry.get(PWA_HOST_DEFAULT_TAB_ID)!.status).toBe('crashed');
  });

  test('Module not found on stderr triggers halt', () => {
    const state = createNexusState({ nexusVersion: '0.7.0', phase: 'test' });
    const registry = new TabRegistry(state);
    registry.register(createPwaHostTabSpec());
    const result = maybeScheduleRestart({
      state, registry, tabId: PWA_HOST_DEFAULT_TAB_ID,
      lastError: 'halt:Module not found:./does-not-exist',
      callbacks: { async stop() {}, async start() {} },
    });
    expect(result.outcome).toBe('halted-pattern');
    expect(result.matchedPattern).toBe('Module not found');
  });

  test('non-halt stderr (random crash) goes through aggressive backoff', () => {
    const state = createNexusState({ nexusVersion: '0.7.0', phase: 'test' });
    const registry = new TabRegistry(state);
    registry.register(createPwaHostTabSpec());
    const result = maybeScheduleRestart({
      state, registry, tabId: PWA_HOST_DEFAULT_TAB_ID,
      lastError: 'unrelated stack trace',
      callbacks: { async stop() {}, async start() {} },
      random: () => 0,
    });
    expect(result.outcome).toBe('scheduled');
    expect(result.delayMs).toBe(5_000); // first backoff bucket
    result.cancel?.();
  });

  test('full pipeline: supervisor.startTab → stderr halt → tab.halt event', async () => {
    const state = createNexusState({ nexusVersion: '0.7.0', phase: 'test' });
    const registry = new TabRegistry(state);
    registry.register(createPwaHostTabSpec({ command: ['bun', 'run', 'dev'] }));
    const backend = makeTestSpawnBackend();
    const sup = createSupervisor({ state, registry, spawnBackend: backend });
    await sup.startTab(PWA_HOST_DEFAULT_TAB_ID);
    expect(backend.spawned).toHaveLength(1);
    const child = backend.spawned[0];
    child.emitStderr('Error: listen EADDRINUSE :::3210');
    child.emitExit({ exitCode: 1 });
    // Allow microtasks to flush
    await new Promise((r) => setTimeout(r, 5));
    const tab = registry.get(PWA_HOST_DEFAULT_TAB_ID)!;
    expect(tab.status).toBe('crashed');
    expect(tab.lastError).toContain('halt:EADDRINUSE');
    expect(state.events.some((e) => e.kind === 'tab.halt')).toBe(true);
    await sup.shutdown({ graceMs: 0 });
  });
});

describe('runNexus integration · pwa-host opt-in', () => {
  test('default (no opt-in) → pwa-host not registered', async () => {
    const handle = await bootNexus({ detachForTesting: true });
    expect(handle!.registry.has(PWA_HOST_DEFAULT_TAB_ID)).toBe(false);
    handle!.release();
  });

  test('enablePwaHostTab=true → registers but does not auto-spawn under detachForTesting', async () => {
    const handle = await bootNexus({
      detachForTesting: true,
      enablePwaHostTab: true,
      autoStartPwaHostTab: false,
    });
    expect(handle!.registry.has(PWA_HOST_DEFAULT_TAB_ID)).toBe(true);
    expect(handle!.registry.get(PWA_HOST_DEFAULT_TAB_ID)!.status).toBe('idle');
    handle!.release();
  });
});
