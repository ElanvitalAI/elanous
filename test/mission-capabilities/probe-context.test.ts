import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInflightGuard, INFLIGHT_DRAIN_TIMEOUT_MS } from '../helpers/inflight-test-guard.js';

const requestId = 'req:v1:abcdef0123456789';
const roots: string[] = [];
const ghCwds: string[] = [];
let ghSuccessRoot = '';
const realExecFileSync = childProcess.execFileSync;

function root(name: string): string {
  const path = mkdtempSync(join(tmpdir(), `probe-context-${name}-`));
  roots.push(path);
  return path;
}

function git(rootPath: string, ...args: string[]): void {
  realExecFileSync('git', args, { cwd: rootPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function repository(rootPath: string, committed: boolean): void {
  git(rootPath, 'init', '-q');
  if (!committed) return;
  git(rootPath, 'config', 'user.email', 'test@example.com');
  git(rootPath, 'config', 'user.name', 'test');
  writeFileSync(join(rootPath, 'commit.txt'), 'commit\n');
  git(rootPath, 'add', 'commit.txt');
  git(rootPath, 'commit', '-q', '-m', 'ready');
}

function writeBlueprint(authorityRoot: string): void {
  const directory = join(authorityRoot, 'src', 'mission-blueprints');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'req-v1-abcdef0123456789.ts'), `export default {
  id: '${requestId}',
  requires: [{ id: 'report.landingcount' }, { id: 'report.openprcount' }],
  produces: { kind: 'report', deliver: [] },
  async run() { return { ok: true, body: 'ready', measured: {} }; },
};`);
}

function observeGh(): ReturnType<typeof spyOn> {
  return spyOn(childProcess, 'execFileSync').mockImplementation(((command: string, args: readonly string[] | undefined, options: { cwd?: string } | undefined) => {
    if (command === 'gh') {
      const cwd = options?.cwd ?? '';
      ghCwds.push(cwd);
      return cwd === ghSuccessRoot ? '[{"number":1,"state":"OPEN"}]' : 'not-a-snapshot';
    }
    return realExecFileSync(command, args, options as Parameters<typeof realExecFileSync>[2]);
  }) as never);
}

// ⭐ 0.2.30 게이트 cut/pod-66: 첫 시험이 차가운 Pod 에서 registry/loader import 로 5s 를 넘겼고,
//   afterEach 가 임시 폴더를 지운 «뒤에» 본문이 그 폴더로 chdir 해 ENOENT 로 터졌다.
//   ① 무거운 import·첫 탐색을 beforeAll(넉넉한 hook 한도)로 ② afterEach 는 남은 본문을 기다린 뒤 정리.
const WARM_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 30_000;
const startCwd = process.cwd();
const guard = createInflightGuard();

beforeAll(async () => {
  const { discoverCapabilityProviders } = await import('../../src/mission-capabilities/registry.js');
  await import('../../src/mission-blueprints/loader.js');
  await discoverCapabilityProviders();
}, WARM_TIMEOUT_MS);

afterEach(async () => {
  await guard.drain();
  if (process.cwd() !== startCwd) process.chdir(startCwd);
  ghCwds.splice(0);
  ghSuccessRoot = '';
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
}, INFLIGHT_DRAIN_TIMEOUT_MS);

describe('capability probe authority context', () => {
  test('the loader sends authorityRoot to discovered tree-measuring providers', guard.track(async () => {
    const cwdRoot = root('cwd');
    const authorityRoot = root('authority');
    repository(cwdRoot, false);
    repository(authorityRoot, true);
    writeBlueprint(authorityRoot);
    ghSuccessRoot = authorityRoot;
    const ghSpy = observeGh();

    try {
      const { discoverCapabilityProviders } = await import('../../src/mission-capabilities/registry.js');
      const { loadMissionBlueprint } = await import('../../src/mission-blueprints/loader.js');
      const catalog = await discoverCapabilityProviders();
      const treeProviders = catalog.filter(provider => provider.id === 'report.landingcount' || provider.id === 'report.openprcount');
      expect(treeProviders.map(provider => provider.id).sort()).toEqual(['report.landingcount', 'report.openprcount']);

      const priorCwd = process.cwd();
      process.chdir(cwdRoot);
      try {
        const result = await loadMissionBlueprint({
          authorityRoot,
          requestId,
          requestRequires: treeProviders.map(provider => ({ id: provider.id })),
          catalog: treeProviders,
        });
        expect(result).toMatchObject({ status: 'ready' });
        expect(ghCwds).toEqual([authorityRoot]);
      } finally {
        process.chdir(priorCwd);
      }
    } finally {
      ghSpy.mockRestore();
    }
  }), TEST_TIMEOUT_MS);

  test('missing authority roots fail with the requested root rather than silently using cwd', guard.track(async () => {
    const missingRoot = join(root('missing-parent'), 'does-not-exist');
    const ghSpy = observeGh();
    try {
      const { discoverCapabilityProviders } = await import('../../src/mission-capabilities/registry.js');
      const providers = (await discoverCapabilityProviders()).filter(provider => provider.id === 'report.landingcount' || provider.id === 'report.openprcount');
      for (const provider of providers) {
        const result = await provider.probe({ authorityRoot: missingRoot });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error(`${provider.id} silently accepted a missing authority root.`);
        expect(result.reason).toContain(missingRoot);
      }
      expect(ghCwds).toEqual([missingRoot]);
    } finally {
      ghSpy.mockRestore();
    }
  }), TEST_TIMEOUT_MS);

  test('direct no-argument probes retain cwd behavior and the open-pr failure string', guard.track(async () => {
    const cwdRoot = root('cwd');
    const authorityRoot = root('authority');
    repository(cwdRoot, false);
    repository(authorityRoot, true);
    ghSuccessRoot = authorityRoot;
    const ghSpy = observeGh();
    try {
      const { discoverCapabilityProviders } = await import('../../src/mission-capabilities/registry.js');
      const providers = (await discoverCapabilityProviders()).filter(provider => provider.id === 'report.landingcount' || provider.id === 'report.openprcount');
      const priorCwd = process.cwd();
      process.chdir(cwdRoot);
      try {
        for (const provider of providers) {
          const result = await provider.probe();
          expect(result.ok).toBe(false);
          if (result.ok) throw new Error(`${provider.id} did not read the cwd tree.`);
          if (provider.id === 'report.landingcount') expect(result.reason).toContain(cwdRoot);
          if (provider.id === 'report.openprcount') expect(result.reason).toBe('Open pull-request snapshot is missing, malformed, or truncated.');
        }
        expect(ghCwds).toEqual([realpathSync(cwdRoot)]);
      } finally {
        process.chdir(priorCwd);
      }
    } finally {
      ghSpy.mockRestore();
    }
  }), TEST_TIMEOUT_MS);
});
