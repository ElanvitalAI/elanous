import { describe, expect, test } from 'bun:test';

import { runBgLaunch } from './bg-launch.js';
import type { SetupCheckResult } from '../nexus/setup-status.js';

function llmOnlySetup(): SetupCheckResult {
  return {
    ok: false,
    required: [
      { id: 'llm', label: 'LLM provider', passed: false, hint: 'run `elanous setup llm`' },
      { id: 'pwa-build', label: 'PWA build', passed: true, hint: 'run `elanous nexus build`' },
    ],
    recommended: [],
  };
}

function pwaMissingSetup(): SetupCheckResult {
  return {
    ok: false,
    required: [
      { id: 'llm', label: 'LLM provider', passed: true, hint: 'run `elanous setup llm`' },
      { id: 'pwa-build', label: 'PWA build', passed: false, hint: 'run `elanous nexus build`' },
    ],
    recommended: [],
  };
}

function sink(): { log: (s: string) => void; error: (s: string) => void; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    log: (s) => { logs.push(s); },
    error: (s) => { errors.push(s); },
    logs,
    errors,
  };
}

describe('runBgLaunch setup mode', () => {
  test('LLM 만 빠짐 → exitCode 가 1 이 아니고 env 에 SETUP_MODE 와 출력에 /setup', async () => {
    const out = sink();
    let env: Record<string, string | undefined> | undefined;
    const result = await runBgLaunch({
      setupStatus: llmOnlySetup(),
      out,
      logPathFn: () => '/tmp/elanous-bg-setup-mode.log',
      spawnFn: (_cmd, _args, opts) => {
        env = opts.env as Record<string, string | undefined>;
        return { pid: 77, unref() {} };
      },
      sleepFn: async () => {},
      probeChildFn: () => 'alive',
      readLockFn: () => null,
    });
    expect(result.exitCode).not.toBe(1);
    expect(env?.ELANOUS_NEXUS_SETUP_MODE).toBe('1');
    expect(env?.ELANOUS_TEST_COORDINATOR_LEASE_PORT).toBeUndefined();
    // The PWA is exported under basePath /app — a bare /setup is a 404 on a fresh machine (measured 2026-09-28 bare VM).
    expect(out.logs.join('\n')).toContain('/app/setup/ (빠진 것');
    expect(out.logs.join('\n')).not.toMatch(/\d\/setup /);
  });

  test('passes only an explicitly requested central lease to the detached child', async () => {
    let env: Record<string, string | undefined> | undefined;
    const result = await runBgLaunch({
      setupStatus: llmOnlySetup(),
      childEnv: { ELANOUS_TEST_COORDINATOR_LEASE_PORT: '31450', ELANOUS_TEST_COORDINATOR_LEASE_TOKEN: 'fixture-token', ELANOUS_TEST_COORDINATOR_LEASE_ID: 'run-identity' },
      logPathFn: () => '/tmp/elanous-bg-coordinator-lease.log',
      spawnFn: (_cmd, _args, opts) => {
        env = opts.env as Record<string, string | undefined>;
        return { pid: 77, unref() {} };
      },
      sleepFn: async () => {},
      probeChildFn: () => 'alive',
      readLockFn: () => null,
    });
    expect(result.exitCode).toBe(0);
    expect(env?.ELANOUS_TEST_COORDINATOR_LEASE_PORT).toBe('31450');
    expect(env?.ELANOUS_TEST_COORDINATOR_LEASE_TOKEN).toBe('fixture-token');
    expect(env?.ELANOUS_TEST_COORDINATOR_LEASE_ID).toBe('run-identity');
  });

  test('PWA 빌드가 빠지면 종전처럼 exitCode 1', async () => {
    const out = sink();
    let spawned = 0;
    const result = await runBgLaunch({
      setupStatus: pwaMissingSetup(),
      out,
      spawnFn: () => {
        spawned += 1;
        return { pid: 1, unref() {} };
      },
      readLockFn: () => null,
    });
    expect(result.exitCode).toBe(1);
    expect(spawned).toBe(0);
    expect(out.errors.join('\n')).toContain('setup incomplete');
  });
});
