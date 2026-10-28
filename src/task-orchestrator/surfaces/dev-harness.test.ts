import { test, expect, describe, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { debug } from '../../debug/log.js';
import { createTask, type Task } from '../types.js';
import {
  createDevHarnessAdapter,
  defaultDevHarnessSpawn,
  spaceIdForDevHarnessTask,
  type DevHarnessJobSpawn,
  type DevHarnessJobDone,
} from './dev-harness.js';

function makeTask(objective = '웹으로 리포트 게시', extra: Record<string, unknown> = {}): Task {
  return createTask({
    title: 'exec job',
    surface: { kind: 'dev-harness', objective, ...extra },
    isolation: 'worktree',
  });
}

async function assertDefaultSpawnBin(cwd: string, expectedBin: string, expectedBinSource: string): Promise<void> {
  const shimDir = mkdtempSync(join(tmpdir(), 'dev-harness-bun-shim-'));
  const capturePath = join(shimDir, 'spawn.txt');
  const bunShim = join(shimDir, 'bun');
  writeFileSync(bunShim, '#!/bin/sh\nprintf "%s\\n%s\\n" "$PWD" "$1" > "$ELANOUS_TEST_SPAWN_CAPTURE"\n');
  chmodSync(bunShim, 0o755);
  const launches: Array<{ bin: unknown; binSource: unknown }> = [];
  const logSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
    if (category === 'self-dev.spawn' && event === 'launch') launches.push({ bin: data?.bin, binSource: data?.binSource });
  }) as typeof debug.log);
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  const originalCapture = process.env.ELANOUS_TEST_SPAWN_CAPTURE;
  try {
    process.env.PATH = `${shimDir}:${originalPath ?? ''}`;
    process.env.ELANOUS_TEST_SPAWN_CAPTURE = capturePath;
    process.chdir(cwd);
    const { done } = defaultDevHarnessSpawn()({ objective: 'verify bin root', spaceId: 'test-space' });
    await done;
    const [spawnCwd, entry] = readFileSync(capturePath, 'utf8').trim().split('\n');
    const canonicalBin = realpathSync(expectedBin);
    expect([realpathSync(spawnCwd), realpathSync(entry)]).toEqual([realpathSync(cwd), canonicalBin]);
    expect(launches.map(({ bin, binSource }) => ({
      bin: typeof bin === 'string' ? realpathSync(bin) : bin,
      binSource,
    }))).toEqual([{ bin: canonicalBin, binSource: expectedBinSource }]);
  } finally {
    process.chdir(originalCwd);
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalCapture === undefined) delete process.env.ELANOUS_TEST_SPAWN_CAPTURE;
    else process.env.ELANOUS_TEST_SPAWN_CAPTURE = originalCapture;
    logSpy.mockRestore();
    rmSync(shimDir, { recursive: true, force: true });
  }
}

describe('dev-harness surface adapter (병렬 실행 라인)', () => {
  test('exit 0 → completed', async () => {
    const spawn: DevHarnessJobSpawn = () => ({
      address: 'dev-harness:x',
      done: Promise.resolve<DevHarnessJobDone>({ exitCode: 0, output: 'published' }),
    });
    const exec = await (await createDevHarnessAdapter({ spawn })(makeTask(), {})).promise;
    expect(exec.status).toBe('completed');
    expect(exec.surfaceAddress).toBe('dev-harness:x');
    expect(exec.output).toBe('published');
  });

  test('non-zero exit → failed(구조화 에러)', async () => {
    const spawn: DevHarnessJobSpawn = () => ({ address: 'dev-harness:x', done: Promise.resolve<DevHarnessJobDone>({ exitCode: 1, output: 'boom' }) });
    const exec = await (await createDevHarnessAdapter({ spawn })(makeTask(), {})).promise;
    expect(exec.status).toBe('failed');
    expect(exec.error?.code).toBe('DEV_HARNESS_FAILED');
  });

  test('spawn throw → failed(SPAWN_FAILED)', async () => {
    const spawn: DevHarnessJobSpawn = () => { throw new Error('no bun'); };
    const exec = await (await createDevHarnessAdapter({ spawn })(makeTask(), {})).promise;
    expect(exec.status).toBe('failed');
    expect(exec.error?.code).toBe('DEV_HARNESS_SPAWN_FAILED');
  });

  test('abort → cancelled(exit code 무시)', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const spawn: DevHarnessJobSpawn = () => ({ address: 'x', done: Promise.resolve<DevHarnessJobDone>({ exitCode: 0, output: '' }) });
    const exec = await (await createDevHarnessAdapter({ spawn })(makeTask(), { signal: ctrl.signal })).promise;
    expect(exec.status).toBe('cancelled');
  });

  test('surface 필드(objective/domain/target/autoDrive)를 spawn 에 전달', async () => {
    let seen: any = null;
    const spawn: DevHarnessJobSpawn = (input) => { seen = input; return { address: 'x', done: Promise.resolve<DevHarnessJobDone>({ exitCode: 0, output: '' }) }; };
    await (await createDevHarnessAdapter({ spawn })(makeTask('삼성 매력도', { domain: 'invest', target: '~/r', autoDrive: 'on' }), {})).promise;
    expect(seen.objective).toBe('삼성 매력도');
    expect(seen.domain).toBe('invest');
    expect(seen.target).toBe('~/r');
    expect(seen.autoDrive).toBe('on');
    expect(seen.spaceId).toBeTruthy();
  });

  test('production spawn falls back to this elanous bin outside a git repository', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dev-harness-bin-fallback-'));
    try {
      const expectedBin = resolve(import.meta.dir, '../../../bin/elanous.mjs');
      expect(existsSync(expectedBin)).toBe(true);
      await assertDefaultSpawnBin(cwd, expectedBin, 'source-tree-fallback');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('production spawn falls back from an external git repository with a directory entrypoint', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dev-harness-bin-git-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd });
      writeFileSync(join(cwd, 'README.md'), '# external product\n');
      mkdirSync(join(cwd, 'bin'));
      mkdirSync(join(cwd, 'bin', 'elanous.mjs'));
      const expectedBin = resolve(import.meta.dir, '../../../bin/elanous.mjs');
      await assertDefaultSpawnBin(cwd, expectedBin, 'source-tree-fallback');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('production spawn keeps this elanous repository bin', async () => {
    const elanousRoot = resolve(import.meta.dir, '../../..');
    const aliasParent = mkdtempSync(join(tmpdir(), 'dev-harness-repo-alias-'));
    const aliasRoot = join(aliasParent, 'repo');
    try {
      symlinkSync(elanousRoot, aliasRoot, 'dir');
      await assertDefaultSpawnBin(aliasRoot, join(aliasRoot, 'bin', 'elanous.mjs'), 'cwd-repository');
    } finally {
      rmSync(aliasParent, { recursive: true, force: true });
    }
  });

  test('잘못된 kind → throw', async () => {
    const spawn: DevHarnessJobSpawn = () => ({ address: 'x', done: Promise.resolve<DevHarnessJobDone>({ exitCode: 0, output: '' }) });
    const wrong = createTask({ title: 't', surface: { kind: 'self-implement', feature: 'x' }, isolation: 'worktree' });
    await expect(createDevHarnessAdapter({ spawn })(wrong, {})).rejects.toThrow(/wrong kind/);
  });

  test('spaceIdForDevHarnessTask — env-safe 조각', () => {
    const id = spaceIdForDevHarnessTask(makeTask());
    expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});
