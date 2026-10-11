import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, type execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMergeBaseDiagnostics, type TscRun } from './ci-typecheck-changed.js';
import {
  BASELINE_CACHE_MAX_ENTRIES,
  ROOT_PLACEHOLDER,
  computeBaselineCacheKey,
  lookupBaselineCache,
  storeBaselineCache,
  toPlaceholderPaths,
} from './tsc-baseline-cache.js';

const COMMAND = 'bunx tsc --noEmit -p tsconfig.gate.json';

let repo: string;
let cacheDir: string;

function git(args: string[], cwd = repo): string {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function jsonFiles(): string[] {
  return existsSync(cacheDir) ? readdirSync(cacheDir).filter((name) => name.endsWith('.json')) : [];
}

/** 기준 워크트리 안에서 실행돼 그 «절대 경로»가 실린 진단을 낸다(rebase 대상). */
function makeRun(counter: { runs: number }, ran = true): (command: string, exec?: typeof execSync) => TscRun {
  return (_command, exec) => {
    counter.runs += 1;
    const root = String(exec!('pwd', { encoding: 'utf8' })).trim();
    if (!ran) return { out: '', ran: false, why: 'tsc 실행 실패' };
    return {
      out: [
        `src/a.ts(1,1): error TS2322: Type 'x' is not assignable to type 'y'.`,
        `src/b.ts(2,3): error TS6059: File '${root}/src/b.ts' is not under rootDir '${root}'.`,
      ].join('\n'),
      ran: true,
    };
  };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'tsc-baseline-cache-repo-'));
  cacheDir = mkdtempSync(join(tmpdir(), 'tsc-baseline-cache-dir-'));
  git(['init', '-q']);
  writeFileSync(join(repo, 'tsconfig.json'), '{}\n');
  writeFileSync(join(repo, 'bun.lock'), 'lock-1\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'base']);
  mkdirSync(join(repo, 'node_modules'));
});

afterEach(() => {
  for (const path of [repo, cacheDir]) rmSync(path, { recursive: true, force: true });
});

describe('tsc baseline cache', () => {
  test('second promotion on the same base sha is a cache hit with zero worktree/tsc runs', () => {
    const counter = { runs: 0 };
    const lines: string[] = [];
    const first = readMergeBaseDiagnostics('HEAD', COMMAND, repo, makeRun(counter), { dir: cacheDir, log: (message) => lines.push(message) });
    expect(counter.runs).toBe(1);
    expect(jsonFiles()).toHaveLength(1);

    // node_modules 가 없으면 miss 경로는 워크트리를 만든 뒤 unavailable 로 끝난다 — hit 이면 그 단계에 닿지 않는다.
    rmSync(join(repo, 'node_modules'), { recursive: true });
    const second = readMergeBaseDiagnostics('HEAD', COMMAND, repo, makeRun(counter), { dir: cacheDir, log: (message) => lines.push(message) });

    expect(counter.runs).toBe(1);
    expect(second).toEqual(first);
    expect('diagnostics' in second && second.diagnostics.some((entry) => entry.line.includes(`rootDir '${repo}'`))).toBe(true);
    expect(git(['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1);
    const key = jsonFiles()[0]!.replace(/\.json$/, '');
    expect(lines).toEqual([
      `[tsc-gate] typecheck baseline-cache miss ${key.slice(0, 12)}`,
      `[tsc-gate] typecheck baseline-cache hit ${key.slice(0, 12)}`,
    ]);
  });

  test('verdict inputs are identical with and without the cache', () => {
    const cached = readMergeBaseDiagnostics('HEAD', COMMAND, repo, makeRun({ runs: 0 }), { dir: cacheDir });
    const viaHit = readMergeBaseDiagnostics('HEAD', COMMAND, repo, makeRun({ runs: 0 }), { dir: cacheDir });
    const uncached = readMergeBaseDiagnostics('HEAD', COMMAND, repo, makeRun({ runs: 0 }), { dir: cacheDir, env: { TSC_BASELINE_CACHE: '0' } });
    expect(viaHit).toEqual(uncached);
    expect(cached).toEqual(uncached);
  });

  test('TSC_BASELINE_CACHE=0 neither reads nor writes', () => {
    const counter = { runs: 0 };
    const env = { TSC_BASELINE_CACHE: '0' };
    readMergeBaseDiagnostics('HEAD', COMMAND, repo, makeRun(counter), { dir: cacheDir, env });
    readMergeBaseDiagnostics('HEAD', COMMAND, repo, makeRun(counter), { dir: cacheDir, env });
    expect(counter.runs).toBe(2);
    expect(jsonFiles()).toHaveLength(0);
  });

  test('changed tsconfig or lock hash misses', () => {
    const contents: Record<string, string> = { 'tsconfig.gate.json': 'gate-a', 'tsconfig.json': 'root-a', 'bun.lock': 'lock-a' };
    const keyFor = (overrides: Record<string, string>, command = COMMAND, tscVersion = '5.0.0') =>
      computeBaselineCacheKey('HEAD', command, repo, {
        git: (args) => {
          if (args[0] === 'rev-parse') return Buffer.from('a'.repeat(40));
          const file = args[1]!.slice(args[1]!.indexOf(':') + 1);
          const content = { ...contents, ...overrides }[file];
          if (content === undefined) throw new Error('absent');
          return Buffer.from(content);
        },
        tscVersion: () => tscVersion,
      });
    const baseline = keyFor({});
    expect(baseline).toMatch(/^[0-9a-f]{64}$/);
    expect(keyFor({})).toBe(baseline);
    expect(keyFor({ 'tsconfig.json': 'root-b' })).not.toBe(baseline);
    expect(keyFor({ 'tsconfig.gate.json': 'gate-b' })).not.toBe(baseline);
    expect(keyFor({ 'bun.lock': 'lock-b' })).not.toBe(baseline);
    expect(keyFor({ 'apps/pwa/tsconfig.json': 'pwa' })).not.toBe(baseline);
    expect(keyFor({}, 'bunx tsc --noEmit -p apps/pwa/tsconfig.json')).not.toBe(baseline);
    expect(keyFor({}, COMMAND, '5.1.0')).not.toBe(baseline);
  });

  test('changed base commit content misses end to end', () => {
    const counter = { runs: 0 };
    readMergeBaseDiagnostics('HEAD', COMMAND, repo, makeRun(counter), { dir: cacheDir });
    writeFileSync(join(repo, 'bun.lock'), 'lock-2\n');
    git(['commit', '-q', '-am', 'lock']);
    readMergeBaseDiagnostics('HEAD', COMMAND, repo, makeRun(counter), { dir: cacheDir });
    expect(counter.runs).toBe(2);
    expect(jsonFiles()).toHaveLength(2);
  });

  test('unavailable baseline is not stored', () => {
    const counter = { runs: 0 };
    const failed = readMergeBaseDiagnostics('HEAD', COMMAND, repo, makeRun(counter, false), { dir: cacheDir });
    expect('unavailable' in failed).toBe(true);
    expect(jsonFiles()).toHaveLength(0);

    rmSync(join(repo, 'node_modules'), { recursive: true });
    const noModules = readMergeBaseDiagnostics('HEAD', COMMAND, repo, makeRun(counter), { dir: cacheDir });
    expect('unavailable' in noModules).toBe(true);
    expect(jsonFiles()).toHaveLength(0);
  });

  test('corrupt cache file re-measures', () => {
    const counter = { runs: 0 };
    readMergeBaseDiagnostics('HEAD', COMMAND, repo, makeRun(counter), { dir: cacheDir });
    const file = join(cacheDir, jsonFiles()[0]!);
    writeFileSync(file, '{not json');
    const lines: string[] = [];
    const again = readMergeBaseDiagnostics('HEAD', COMMAND, repo, makeRun(counter), { dir: cacheDir, log: (message) => lines.push(message) });
    expect(counter.runs).toBe(2);
    expect('diagnostics' in again && again.diagnostics).toHaveLength(2);
    expect(lines[0]).toMatch(/baseline-cache miss [0-9a-f]{12}$/);
    expect(JSON.parse(readFileSync(file, 'utf8')).diagnostics).toHaveLength(2);
  });

  test('cache store failure never blocks the result', () => {
    const blocker = join(cacheDir, 'blocker');
    writeFileSync(blocker, 'a file where a directory is expected');
    const counter = { runs: 0 };
    const result = readMergeBaseDiagnostics('HEAD', COMMAND, repo, makeRun(counter), { dir: join(blocker, 'nested') });
    expect('diagnostics' in result && result.diagnostics).toHaveLength(2);
  });

  test('stored diagnostics carry the placeholder and only the newest entries are kept', () => {
    const diagnostics = toPlaceholderPaths([{ file: '/wt/src/a.ts', line: `/wt/src/a.ts(1,1): error TS6059: rootDir '/wt'`, code: 'TS6059' }], '/wt');
    expect(diagnostics[0]!.line).toContain(`rootDir '${ROOT_PLACEHOLDER}'`);
    expect(diagnostics[0]!.file).toBe(`${ROOT_PLACEHOLDER}/src/a.ts`);

    for (let index = 0; index < 4; index += 1) {
      expect(storeBaselineCache(`key-${index}`, COMMAND, diagnostics, { dir: cacheDir })).toBe(true);
      const past = new Date(Date.now() - (10_000 - index * 1_000));
      utimesSync(join(cacheDir, `key-${index}.json`), past, past);
    }
    expect(storeBaselineCache('key-4', COMMAND, diagnostics, { dir: cacheDir, maxEntries: 3 })).toBe(true);
    expect(jsonFiles().length).toBeLessThanOrEqual(BASELINE_CACHE_MAX_ENTRIES);
    expect(jsonFiles().sort()).toEqual(['key-2.json', 'key-3.json', 'key-4.json']);
    expect(lookupBaselineCache('key-4', { dir: cacheDir })).toEqual({ result: 'hit', diagnostics });
    expect(lookupBaselineCache('key-0', { dir: cacheDir })).toEqual({ result: 'miss' });
  });
});
