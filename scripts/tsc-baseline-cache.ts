/**
 * 승격 착지의 base 쪽 tsc 진단을 «main 커밋별로 한 번만» 재고 재사용하는 캐시.
 * 키 = base sha ⊕ tsc 명령 ⊕ 설정 파일(base 커밋에서 git show 로 읽은 내용) 해시 ⊕ 작업 트리 설치 키(bun.lock 실물) ⊕ tsc 판.
 * 값 = rebase 전 정규화 진단(워크트리 절대 경로는 «<ROOT>» 자리표로 저장).
 * ⛔ 캐시 실패는 호출자에게 던지지 않는다 — 읽기·쓰기 모두 miss 로 떨어진다.
 */
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { elanousStateRoot } from '../src/autopilot/state-paths.js';
import type { TypecheckError } from '../src/typecheck-ratchet.js';

export const ROOT_PLACEHOLDER = '<ROOT>';
export const BASELINE_CACHE_MAX_ENTRIES = 50;
const CACHE_FORMAT = 2;

/** 키에 들어가는 «기준 커밋의 설정 파일» — 이 중 하나라도 달라지면 같은 sha 라도 다른 진단이다. */
export const BASELINE_CACHE_CONFIG_FILES = ['tsconfig.gate.json', 'apps/pwa/tsconfig.json', 'tsconfig.pwa-env.json', 'tsconfig.json', 'bun.lock'] as const;

export interface BaselineCacheOptions {
  /** 캐시 디렉터리. 생략하면 `<상태 디렉터리>/cache/tsc-baseline`. */
  dir?: string;
  env?: NodeJS.ProcessEnv;
  /** git 실행 심 — 출력 바이트를 돌려주고 실패하면 던진다. */
  git?: (args: string[], cwd: string) => Buffer;
  /** 작업 트리 설치 파일 읽기 심 — 파일 바이트를 돌려주고 읽을 수 없으면 던진다. */
  readInstallFile?: (path: string) => Buffer;
  /** tsc 판 조회 심. */
  tscVersion?: (cwd: string) => string;
  maxEntries?: number;
}

export type BaselineCacheLookup =
  | { result: 'hit'; diagnostics: TypecheckError[] }
  | { result: 'miss' }
  | { result: 'corrupt' };

export function baselineCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TSC_BASELINE_CACHE?.trim() !== '0';
}

export function defaultBaselineCacheDir(): string {
  return join(elanousStateRoot(), 'cache', 'tsc-baseline');
}

function defaultGit(args: string[], cwd: string): Buffer {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  return execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

function defaultTscVersion(cwd: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(cwd, 'node_modules', 'typescript', 'package.json'), 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 키에 들어가는 «작업 트리에 실제로 깔린 판» — base 쪽 bun.lock 이 같아도 설치가 다르면 진단이 다르다. */
const BASELINE_CACHE_INSTALL_FILES = ['bun.lock', 'apps/pwa/bun.lock'] as const;

/**
 * 지금 트리에 실제로 깔린 판의 키 — 작업 트리 루트 `bun.lock`(⊕ 있으면 `apps/pwa/bun.lock`) 파일 해시.
 * 루트 `bun.lock` 을 못 읽으면 undefined(호출자는 캐시 없이 잰다 — base 키 규율과 같다) · `apps/pwa/bun.lock` 은 못 읽으면 absent.
 */
export function workingTreeInstallKey(cwd: string, options: Pick<BaselineCacheOptions, 'readInstallFile'> = {}): string | undefined {
  const read = options.readInstallFile ?? ((path: string) => readFileSync(path));
  const files: Record<string, string> = {};
  for (const file of BASELINE_CACHE_INSTALL_FILES) {
    try {
      files[file] = createHash('sha256').update(read(join(cwd, file))).digest('hex');
    } catch {
      if (file === 'bun.lock') return undefined;
      files[file] = 'absent';
    }
  }
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

/** 키를 못 만들면(base 를 sha 로 풀 수 없음 등) undefined — 호출자는 캐시 없이 잰다. */
export function computeBaselineCacheKey(base: string, command: string, cwd: string, options: BaselineCacheOptions = {}): string | undefined {
  try {
    const git = options.git ?? defaultGit;
    const sha = git(['rev-parse', '--verify', `${base}^{commit}`], cwd).toString('utf8').trim();
    if (!/^[0-9a-f]{40,64}$/.test(sha)) return undefined;
    const files: Record<string, string> = {};
    for (const file of BASELINE_CACHE_CONFIG_FILES) {
      try {
        files[file] = createHash('sha256').update(git(['show', `${sha}:${file}`], cwd)).digest('hex');
      } catch {
        files[file] = 'absent';
      }
    }
    const install = workingTreeInstallKey(cwd, options);
    if (install === undefined) return undefined;
    const tsc = (options.tscVersion ?? defaultTscVersion)(cwd);
    return createHash('sha256').update(JSON.stringify({ format: CACHE_FORMAT, sha, command, files, install, tsc })).digest('hex');
  } catch {
    return undefined;
  }
}

function worktreeRoots(worktree: string): string[] {
  const real = (() => { try { return realpathSync(worktree); } catch { return worktree; } })();
  return [...new Set([worktree, real])].sort((left, right) => right.length - left.length);
}

/** rebase 전 진단의 워크트리 절대 경로를 «<ROOT>» 로 바꾼다(긴 경로 먼저). */
export function toPlaceholderPaths(diagnostics: readonly TypecheckError[], worktree: string): TypecheckError[] {
  const roots = worktreeRoots(worktree);
  const swap = (text: string): string => roots.reduce((acc, root) => acc.split(root).join(ROOT_PLACEHOLDER), text);
  return diagnostics.map((diagnostic) => ({ ...diagnostic, line: swap(diagnostic.line), file: swap(diagnostic.file) }));
}

function entryFile(dir: string, key: string): string {
  return join(dir, `${key}.json`);
}

function isStoredDiagnostic(value: unknown): value is TypecheckError {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.file === 'string' && typeof entry.line === 'string' && (entry.code === undefined || typeof entry.code === 'string');
}

export function lookupBaselineCache(key: string, options: BaselineCacheOptions = {}): BaselineCacheLookup {
  try {
    const file = entryFile(options.dir ?? defaultBaselineCacheDir(), key);
    if (!existsSync(file)) return { result: 'miss' };
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { format?: unknown; key?: unknown; diagnostics?: unknown };
    if (parsed.format !== CACHE_FORMAT || parsed.key !== key || !Array.isArray(parsed.diagnostics) || !parsed.diagnostics.every(isStoredDiagnostic)) {
      return { result: 'corrupt' };
    }
    try { const now = new Date(); utimesSync(file, now, now); } catch { /* 보존 순서 갱신 실패는 무해하다 */ }
    return { result: 'hit', diagnostics: parsed.diagnostics };
  } catch {
    return { result: 'corrupt' };
  }
}

function pruneBaselineCache(dir: string, keep: number): void {
  const entries = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));
  for (const stale of entries.slice(keep)) rmSync(join(dir, stale.name), { force: true });
}

/** `<ROOT>` 자리표가 든 진단을 원자 쓰기(임시→rename)로 저장한다. 성공 여부만 돌려주고 던지지 않는다. */
export function storeBaselineCache(key: string, command: string, diagnostics: readonly TypecheckError[], options: BaselineCacheOptions = {}): boolean {
  try {
    const dir = options.dir ?? defaultBaselineCacheDir();
    mkdirSync(dir, { recursive: true });
    const file = entryFile(dir, key);
    const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ format: CACHE_FORMAT, key, command, storedAt: new Date().toISOString(), diagnostics }));
      renameSync(temporary, file);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
    try { pruneBaselineCache(dir, options.maxEntries ?? BASELINE_CACHE_MAX_ENTRIES); } catch { /* 정리 실패는 저장 성공을 뒤집지 않는다 */ }
    return true;
  } catch {
    return false;
  }
}
