import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { runPwaBuild } from '../src/cli/pwa-build';
import { checkSetupStatus } from '../src/nexus/setup-status';
import { buildUserConfig } from '../src/user-config';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

import { runPwaDev } from '../src/cli/pwa-dev';
import { runPwaGlobalStatus } from '../src/cli/pwa-global';
import { pwaShareEnable } from '../src/cli/pwa-share';
import { runPwaShow } from '../src/cli/pwa-show';
import { runPwaTest } from '../src/cli/pwa-test';

const DEPRECATED_PWA_GUIDANCE = [
  'elanous nexus pwa start',
  'elanous nexus pwa build',
] as const;
const GUIDANCE_SOURCE_FILES = [
  'src/cli/pwa-build.ts',
  'src/nexus/setup-status.ts',
] as const;
const PWA_TEST_GUIDANCE = 'elanous nexus run --test';
const PWA_BUILD_GUIDANCE = 'elanous nexus build';

function makeOut() {
  const logs: string[] = [];
  return {
    logs,
    log: (line: string) => logs.push(line),
    error: (line: string) => logs.push(line),
  };
}

function expectCurrentGuidance(logs: string[], command: string): void {
  const output = logs.join('\n');
  expect(output).toContain(command);
  for (const deprecatedCommand of DEPRECATED_PWA_GUIDANCE) {
    expect(output).not.toContain(deprecatedCommand);
  }
}

function expectSourceGuidanceCurrent(): void {
  for (const sourceFile of GUIDANCE_SOURCE_FILES) {
    const userFacingSource = readFileSync(joinPath(import.meta.dir, '..', sourceFile), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    for (const deprecatedCommand of DEPRECATED_PWA_GUIDANCE) {
      expect(userFacingSource).not.toContain(deprecatedCommand);
    }
  }
}

function makeRepoWithoutStaticBuild(): string {
  const repoRoot = mkdtempSync(joinPath(tmpdir(), 'elanous-pwa-guidance-'));
  mkdirSync(joinPath(repoRoot, 'bin'), { recursive: true });
  writeFileSync(joinPath(repoRoot, 'bin', 'elanous.mjs'), '#!/usr/bin/env bun\n');
  mkdirSync(joinPath(repoRoot, 'apps', 'pwa'), { recursive: true });
  return repoRoot;
}

describe('PWA daemon guidance uses the live nexus run command', () => {
  test('pwa show recommends HMR nexus run when this project has no daemon', async () => {
    const out = makeOut();

    await runPwaShow({ cwd: '/project-without-pwa', listFn: () => [], out });

    expectCurrentGuidance(out.logs, 'elanous nexus run --hmr');
  });

  test('pwa global status recommends HMR nexus run when its registry is empty', async () => {
    const out = makeOut();

    await runPwaGlobalStatus({
      listFn: () => ({
        instances: [],
        diagnostics: {
          readState: 'missing',
          livenessProbe: 'pid-signal-0',
          serviceObservation: 'unknown',
          serviceMismatch: false,
          registeredCount: 0,
          pruned: [],
        },
      }),
      out,
    });

    expectCurrentGuidance(out.logs, 'elanous nexus run --hmr');
  });

  test('pwa dev reports an unknown daemon address without guessing a nexus port', async () => {
    const out = makeOut();

    await runPwaDev({
      cwd: '/fake/apps/pwa',
      skipNodeModulesCheck: true,
      resolveEndpoint: () => null,
      readNexusLockFn: () => null,
      isAliveNexusLockFn: () => false,
      spawnFn: async () => 0,
      out,
    });

    expect(out.logs.join('\n')).toContain('daemon address unknown — a port is not guessed. Pass --nexus-url or start the daemon.');
    expect(out.logs.join('\n')).toContain('→ cross-origin (always):           http://localhost:3210/app/');
    for (const deprecatedCommand of DEPRECATED_PWA_GUIDANCE) {
      expect(out.logs.join('\n')).not.toContain(deprecatedCommand);
    }
  });

  test('pwa share preserves its requested port while recommending nexus run', async () => {
    const out = makeOut();

    await pwaShareEnable({
      port: 4310,
      readSwitch: () => 'disabled',
      saveSwitch: () => {},
      probeFn: async () => ({ installed: true, alive: true, binary: 'tailscale' }),
      serveFn: async () => ({ exitCode: 0 }),
      nexusAliveFn: async () => false,
      out,
    });

    expectCurrentGuidance(out.logs, 'nexus is not currently running on :4310 — `elanous nexus run`');
  });

  test('pwa test recommends nexus run --test when its static build is missing', async () => {
    const out = makeOut();
    const repoRoot = makeRepoWithoutStaticBuild();

    try {
      await runPwaTest({
        repoRoot,
        pwaStartFn: async () => ({ exitCode: 0 }),
        rebuildFn: async () => ({ exitCode: 1 }),
        out,
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }

    expectCurrentGuidance(out.logs, PWA_TEST_GUIDANCE);
  });

  test('pwa test recommends nexus run --test when no isolated instance is active', async () => {
    const out = makeOut();

    await runPwaTest({ repoRoot: '/project-without-instance', status: true, out });

    expectCurrentGuidance(out.logs, PWA_TEST_GUIDANCE);
  });

  test('pwa test recommends nexus run --test when it cannot resolve its repository root', async () => {
    const out = makeOut();

    await runPwaTest({ argvBin: '/not-a-elanous-checkout/bin/elanous.mjs', out });

    expectCurrentGuidance(out.logs, PWA_TEST_GUIDANCE);
  });

  test('PWA build and setup-status guidance use the canonical build command', async () => {
    const unresolvedOut = makeOut();
    const unresolved = await runPwaBuild({
      argvBin: '/not-a-elanous-checkout/bin/elanous.mjs',
      out: unresolvedOut,
    });
    expect(unresolved.exitCode).toBe(1);
    expectCurrentGuidance(unresolvedOut.logs, PWA_BUILD_GUIDANCE);

    const pwaDir = mkdtempSync(joinPath(tmpdir(), 'elanous-pwa-build-guidance-'));
    const missingDepsOut = makeOut();
    try {
      const missingDeps = await runPwaBuild({ cwd: pwaDir, out: missingDepsOut });
      expect(missingDeps.exitCode).toBe(1);
      expect(missingDepsOut.logs.join('\n')).toContain('bun install');
      expectCurrentGuidance(missingDepsOut.logs, PWA_BUILD_GUIDANCE);
    } finally {
      rmSync(pwaDir, { recursive: true, force: true });
    }

    const builtDir = mkdtempSync(joinPath(tmpdir(), 'elanous-pwa-built-'));
    const buildOut = makeOut();
    try {
      writeFileSync(joinPath(builtDir, 'package.json'), '{"dependencies":{}}');
      for (const dependency of ['@dagrejs/dagre', 'next', 'react']) {
        const dependencyDir = joinPath(builtDir, 'node_modules', dependency);
        mkdirSync(dependencyDir, { recursive: true });
        writeFileSync(joinPath(dependencyDir, 'package.json'), '{}');
      }
      const build = await runPwaBuild({
        cwd: builtDir,
        out: buildOut,
        spawnFn: async () => 0,
      });
      expect(build.exitCode).toBe(0);
      expectCurrentGuidance(buildOut.logs, PWA_BUILD_GUIDANCE);
    } finally {
      rmSync(builtDir, { recursive: true, force: true });
    }

    const configRoot = mkdtempSync(joinPath(tmpdir(), 'elanous-setup-guidance-'));
    try {
      const setup = checkSetupStatus({
        cfg: buildUserConfig(joinPath(configRoot, 'missing.json')),
        nexusCfg: { version: 1, global: {}, tabs: {} },
        pwaBuilt: false,
      });
      expect(setup.required.find((item) => item.id === 'pwa-build')?.hint).toContain(PWA_BUILD_GUIDANCE);
    } finally {
      rmSync(configRoot, { recursive: true, force: true });
    }

    expectSourceGuidanceCurrent();
  });
});
