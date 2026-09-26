import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyTestFlagFromArgv, getAppliedGlobalTestRoot } from '../../cli/test-flag.js';
import { setGitCommandRunnerForTesting } from '../../git-fs/runner.js';
import { resolveCurrentInstance } from '../../instance/current.js';
import { prodInstanceRoot, setTreeDerivedTestForTesting } from '../../instance/resolve.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { nexusRootDir, setTestStateRoot } from '../paths.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';

import {
  handleHealth,
  resetDaemonShaForTesting,
  setHealthIdentityResolversForTesting,
} from './health.js';

function healthBody(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

const LEGACY_KEYS = ['ok', 'nexusVersion', 'phase', 'startedAt', 'daemonSha', 'uptimeMs', 'tabs'] as const;

function expectLegacyPayload(
  body: Record<string, unknown>,
  state: ReturnType<typeof createNexusState>,
): void {
  expect(body.ok).toBe(true);
  expect(body.nexusVersion).toBe('test');
  expect(body.phase).toBe('health');
  expect(body.startedAt).toBe(state.startedAt);
  expect(typeof body.uptimeMs).toBe('number');
  expect(body.tabs).toEqual({ total: 0, byStatus: {} });
  for (const key of LEGACY_KEYS) {
    expect(body).toHaveProperty(key);
  }
}

afterEach(() => {
  setGitCommandRunnerForTesting(undefined);
  setHealthIdentityResolversForTesting(undefined);
  setTestStateRoot(null);
  resetElanousConfigDir();
  setTreeDerivedTestForTesting(undefined);
});

function withStateDir<T>(stateDir: string | undefined, fn: () => T): T {
  const previous = process.env.ELANOUS_STATE_DIR;
  if (stateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = stateDir;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
  }
}

function withoutAppliedGlobalTestRoot<T>(fn: () => T): T {
  const previous = getAppliedGlobalTestRoot();
  if (previous === undefined) return fn();
  const previousArgv = process.argv.slice();
  process.argv = previousArgv.filter((tok) => tok !== '--test' && !tok.startsWith('--test='));
  applyTestFlagFromArgv();
  try {
    return fn();
  } finally {
    process.argv = [
      ...previousArgv.filter((tok) => tok !== '--test' && !tok.startsWith('--test=')),
      `--test=${previous}`,
    ];
    applyTestFlagFromArgv();
    process.argv = previousArgv;
  }
}

describe('/v1/health daemon SHA', () => {
  // 🆕 2026-09-24 — 설치본 데몬은 WorkingDirectory(pilot)가 코드 위치와 다르다. cwd 의 HEAD 를 말하면 안 된다.
  test('asks git at the daemon code root, never at the process cwd', async () => {
    const asked: string[] = [];
    setGitCommandRunnerForTesting((cwd) => {
      asked.push(cwd);
      return { status: 0, stdout: `${'e'.repeat(40)}\n`, stderr: '' };
    });
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join, resolve } = await import('node:path');
    const elsewhere = mkdtempSync(join(tmpdir(), 'daemon-cwd-'));
    const original = process.cwd();
    process.chdir(elsewhere);
    try {
      resetDaemonShaForTesting();
    } finally {
      process.chdir(original);
      rmSync(elsewhere, { recursive: true, force: true });
    }
    const body = await healthBody(handleHealth(createNexusState({ nexusVersion: 'test', phase: 'health' }), new TabRegistry(createNexusState({ nexusVersion: 'test', phase: 'health' }))));
    expect(body.daemonSha).toBe('e'.repeat(9));
    expect(asked).toEqual([resolve(import.meta.dir, '..', '..', '..')]);
  });

  test('captures the startup SHA once before requests and preserves it after HEAD changes', async () => {
    let calls = 0;
    let head = '31df044b6';
    setGitCommandRunnerForTesting(() => {
      calls += 1;
      return { status: 0, stdout: `${head}\n`, stderr: '' };
    });

    resetDaemonShaForTesting();
    const state = createNexusState({ nexusVersion: 'test', phase: 'health' });
    const registry = new TabRegistry(state);
    head = '2074c8fda';

    const first = await healthBody(handleHealth(state, registry));
    const later = await healthBody(handleHealth(state, registry));

    expect(first.daemonSha).toBe('31df044b6');
    expect(later.daemonSha).toBe('31df044b6');
    expect(calls).toBe(1);
    expectLegacyPayload(first, state);
    expect(first).toEqual({
      ok: true,
      nexusVersion: 'test',
      phase: 'health',
      startedAt: state.startedAt,
      daemonSha: '31df044b6',
      uptimeMs: expect.any(Number),
      tabs: { total: 0, byStatus: {} },
      universeRoot: expect.any(String),
      testUniverse: expect.anything(),
      bindHost: 'unknown',
    });
    expect(first.testUniverse === true || first.testUniverse === false || first.testUniverse === 'unknown').toBe(true);
  });

  test.each([
    ['git command failure', () => ({ status: 1, stdout: '', stderr: 'fatal' })],
    ['empty git output', () => ({ status: 0, stdout: ' \n', stderr: '' })],
  ])('returns unknown when %s', async (_caseName, result) => {
    setGitCommandRunnerForTesting(() => result());

    resetDaemonShaForTesting();
    const state = createNexusState({ nexusVersion: 'test', phase: 'health' });
    const body = await healthBody(handleHealth(state, new TabRegistry(state)));

    expect(body.daemonSha).toBe('unknown');
    expect(body).toMatchObject({
      ok: true,
      nexusVersion: 'test',
      phase: 'health',
      startedAt: state.startedAt,
      tabs: { total: 0, byStatus: {} },
    });
    expectLegacyPayload(body, state);
  });

  test('returns unknown when the startup git command throws', async () => {
    setGitCommandRunnerForTesting(() => {
      throw new Error('git unavailable');
    });

    resetDaemonShaForTesting();
    const state = createNexusState({ nexusVersion: 'test', phase: 'health' });
    const body = await healthBody(handleHealth(state, new TabRegistry(state)));

    expect(body.daemonSha).toBe('unknown');
    expect(body.ok).toBe(true);
  });
});

describe('/v1/health identity', () => {
  test('distinct production and test universes emit different identity values', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'health-universe-test-'));
    const state = createNexusState({ nexusVersion: 'test', phase: 'health' });
    const registry = new TabRegistry(state);

    setHealthIdentityResolversForTesting({
      currentInstance: () => ({ kind: 'test' }),
    });
    setTestStateRoot(testRoot);
    const testBody = await healthBody(handleHealth(state, registry, { bindHost: '127.0.0.1' }));
    const testUniverseRoot = nexusRootDir();

    setHealthIdentityResolversForTesting({
      currentInstance: () => ({ kind: 'prod' }),
    });
    setTestStateRoot(null);
    setElanousConfigDir(prodInstanceRoot());
    const prodBody = await healthBody(handleHealth(state, registry, { bindHost: '0.0.0.0' }));
    const prodUniverseRoot = nexusRootDir();

    expect(testBody.universeRoot).toBe(testUniverseRoot);
    expect(testBody.universeRoot).toBe(join(testRoot, 'nexus'));
    expect(prodBody.universeRoot).toBe(prodUniverseRoot);
    expect(prodBody.universeRoot).toBe(join(prodInstanceRoot(), 'nexus'));
    expect(testBody.universeRoot).not.toBe(prodBody.universeRoot);
    expect(testBody.testUniverse).toBe(true);
    expect(prodBody.testUniverse).toBe(false);
    expect(testBody.bindHost).toBe('127.0.0.1');
    expect(prodBody.bindHost).toBe('0.0.0.0');
    expectLegacyPayload(testBody, state);
    expectLegacyPayload(prodBody, state);

    rmSync(testRoot, { recursive: true, force: true });
  });

  test('resolveCurrentInstance classifies isolated production and test settings for health', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'health-universe-resolved-'));
    const prodRoot = prodInstanceRoot();
    const state = createNexusState({ nexusVersion: 'test', phase: 'health' });
    const registry = new TabRegistry(state);

    try {
      let testUniverseRoot = '';
      const testResponse = withoutAppliedGlobalTestRoot(() => {
        setTreeDerivedTestForTesting(false);
        setTestStateRoot(testRoot);
        setElanousConfigDir(testRoot);
        return withStateDir(testRoot, () => {
          expect(resolveCurrentInstance().kind).toBe('test');
          testUniverseRoot = nexusRootDir();
          return handleHealth(state, registry, { bindHost: '127.0.0.1' });
        });
      });
      const testBody = await healthBody(testResponse);

      let prodUniverseRoot = '';
      const prodResponse = withoutAppliedGlobalTestRoot(() => {
        setTreeDerivedTestForTesting(false);
        setTestStateRoot(null);
        setElanousConfigDir(prodRoot);
        return withStateDir(prodRoot, () => {
          expect(resolveCurrentInstance().kind).toBe('prod');
          prodUniverseRoot = nexusRootDir();
          return handleHealth(state, registry, { bindHost: '0.0.0.0' });
        });
      });
      const prodBody = await healthBody(prodResponse);

      expect(testUniverseRoot).toBe(join(testRoot, 'nexus'));
      expect(prodUniverseRoot).toBe(join(prodRoot, 'nexus'));
      expect(testBody.universeRoot).toBe(testUniverseRoot);
      expect(prodBody.universeRoot).toBe(prodUniverseRoot);
      expect(testBody.universeRoot).not.toBe(prodBody.universeRoot);
      expect(testBody.testUniverse).toBe(true);
      expect(prodBody.testUniverse).toBe(false);
      expectLegacyPayload(testBody, state);
      expectLegacyPayload(prodBody, state);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('reports the supplied bind host, including loopback and wildcard values', async () => {
    const state = createNexusState({ nexusVersion: 'test', phase: 'health' });
    const registry = new TabRegistry(state);

    const loopback = await healthBody(handleHealth(state, registry, { bindHost: '127.0.0.1' }));
    const wildcard = await healthBody(handleHealth(state, registry, { bindHost: '0.0.0.0' }));
    const missing = await healthBody(handleHealth(state, registry));

    expect(loopback.bindHost).toBe('127.0.0.1');
    expect(wildcard.bindHost).toBe('0.0.0.0');
    expect(missing.bindHost).toBe('unknown');
    expect(loopback.bindHost).not.toBe(wildcard.bindHost);
  });

  test('returns HTTP 200 and ok:true when universe resolution throws', async () => {
    setHealthIdentityResolversForTesting({
      universeRoot: () => {
        throw new Error('universe root unavailable');
      },
      currentInstance: () => {
        throw new Error('instance unavailable');
      },
      testStateRoot: () => {
        throw new Error('test-state unavailable');
      },
    });

    const state = createNexusState({ nexusVersion: 'test', phase: 'health' });
    const response = handleHealth(state, new TabRegistry(state), { bindHost: '127.0.0.1' });
    const body = await healthBody(response);

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.universeRoot).toBe('unknown');
    expect(body.testUniverse).toBe('unknown');
    expect(body.bindHost).toBe('127.0.0.1');
    expectLegacyPayload(body, state);
  });
});

describe('/v1/health setup mode', () => {
  test('mode true 만 setupMode 와 setupMissing 을 싣고, false·없음은 두 칸이 없다', async () => {
    const state = createNexusState({ nexusVersion: 'test', phase: 'health' });
    const registry = new TabRegistry(state);

    const on = await healthBody(handleHealth(state, registry, {
      setup: { mode: true, missing: ['LLM provider'] },
    }));
    const off = await healthBody(handleHealth(state, registry, {
      setup: { mode: false, missing: [] },
    }));
    const absent = await healthBody(handleHealth(state, registry));

    expect(on.setupMode).toBe(true);
    expect(on.setupMissing).toEqual(['LLM provider']);
    expect(off.setupMode).toBeUndefined();
    expect(off.setupMissing).toBeUndefined();
    expect(absent.setupMode).toBeUndefined();
    expect(absent.setupMissing).toBeUndefined();
    expectLegacyPayload(on, state);
    expectLegacyPayload(off, state);
    expectLegacyPayload(absent, state);
  });
});
