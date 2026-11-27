import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { gitAt, type GitRun } from '../git-fs/smart-run.js';
import { pwaReachableSrcFiles } from './pwa-import-graph.js';

export type DependencyChangeGateResult = {
  ran: boolean;
  passed: boolean;
  failures: Array<{ step: 'root-tsc' | 'pwa-build'; lines: string[] }>;
  skipped?: string;
  trigger?: 'dependency' | 'pwa-reachable';
  pwaReachableChanged?: string[];
  measured?: boolean;
  /** PWA-GATE-OWN-DELTA-CACHE — present only when a cache dir was given and the PWA build step was due. */
  pwaBuildCache?: 'hit' | 'miss' | 'unavailable';
  pwaBuildCacheKey?: string;
};

type CommandResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
  signal?: NodeJS.Signals | null;
  error?: Error;
};

type Run = (command: string, args: readonly string[], options: { cwd: string; timeout: number }) => CommandResult;

const TIMEOUT_MS = 300_000;
const defaultRun: Run = (command, args, options) => spawnSync(command, [...args], {
  ...options, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
});

/** A file of the PWA app itself (its manifest is a dependency trigger of its own). */
export function isPwaAppSource(file: string): boolean {
  return file.startsWith('apps/pwa/') && file !== 'apps/pwa/package.json' && !/^apps\/pwa\/(?:node_modules|\.next|out)\//.test(file);
}

/** Bump when the key's meaning changes, so old entries can never be read as a hit. */
const PWA_BUILD_CACHE_VERSION = 'pwa-build-cache/v1';
/** Inputs of the static export besides apps/pwa itself and the PWA-reachable src files. */
const PWA_BUILD_EXTRA_INPUTS = ['package.json', 'bun.lock', 'tsconfig.json', 'src/cli/pwa-build.ts'] as const;

/**
 * PWA-GATE-OWN-DELTA-CACHE ② — content address of one PWA static export: the working-tree blob of every input
 * (apps/pwa tracked ⊕ untracked-not-ignored · PWA-reachable src · root package.json · bun.lock · tsconfig.json · the
 * builder). Uncommitted edits count (the gate runs before the round commits). A reachable path that does not exist is
 * part of the key as «missing», so deleting an imported file changes the key. null = could not hash (not a git work
 * tree, git failed) — the caller builds without the cache.
 */
export function pwaBuildCacheKey(cwd: string, reachable: ReadonlySet<string>, git: GitRun = gitAt(cwd, { timeoutMs: 60_000 })): string | null {
  const listed = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'apps/pwa']);
  if (listed.status !== 0) return null;
  const paths = [...new Set([
    ...listed.stdout.split('\0').filter(Boolean),
    ...reachable,
    ...PWA_BUILD_EXTRA_INPUTS,
  ])].sort();
  const present = paths.filter((path) => existsSync(join(cwd, path)));
  const hashed = present.length
    ? git(['hash-object', '--no-filters', '--stdin-paths'], { input: `${present.join('\n')}\n` })
    : { status: 0, stdout: '', stderr: '' };
  if (hashed.status !== 0) return null;
  const blobs = hashed.stdout.split('\n').filter(Boolean);
  if (blobs.length !== present.length) return null;
  const blobOf = new Map(present.map((path, index) => [path, blobs[index]!]));
  const hash = createHash('sha256').update(`${PWA_BUILD_CACHE_VERSION}\n`);
  for (const path of paths) hash.update(`${path}\t${blobOf.get(path) ?? 'missing'}\n`);
  return hash.digest('hex');
}

type PwaBuildCacheEntry = { version: string; key: string; exit: 0; at: string; log: string };

function readPwaBuildCache(cacheDir: string, key: string): boolean {
  try {
    const entry = JSON.parse(readFileSync(join(cacheDir, `${key}.json`), 'utf8')) as Partial<PwaBuildCacheEntry>;
    return entry.version === PWA_BUILD_CACHE_VERSION && entry.key === key && entry.exit === 0;
  } catch {
    return false;
  }
}

/** Only a successful build is stored — a failure or an unmeasured run is never reusable. Write failure = no cache. */
function writePwaBuildCache(cacheDir: string, key: string, log: string): void {
  try {
    mkdirSync(cacheDir, { recursive: true });
    const entry: PwaBuildCacheEntry = { version: PWA_BUILD_CACHE_VERSION, key, exit: 0, at: new Date().toISOString(), log: log.slice(-4000) };
    const tmp = join(cacheDir, `.${key}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(entry));
    renameSync(tmp, join(cacheDir, `${key}.json`));
  } catch (error) {
    debug.log('self-implement', 'gate.pwa-build', { cache: 'write-failed', key: key.slice(0, 16), error: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
  }
}

/** A dependency change can invalidate consumers outside the changed-file typecheck scope.
 *  `changedFiles` must be the PR's own delta (PWA-GATE-OWN-DELTA-CACHE ①) — the caller decides that, not this gate.
 *  `cacheDir` turns on the content-addressed PWA build cache (②): a key that already built green is reused. */
export function runDependencyChangeGate({ cwd, changedFiles, run = defaultRun, cacheDir, git }: {
  cwd: string;
  changedFiles: readonly string[];
  run?: Run;
  cacheDir?: string;
  git?: GitRun;
}): DependencyChangeGateResult {
  const normalized = changedFiles.map((file) => file.replace(/^\.\//, ''));
  const dependency = normalized.some((file) => ['package.json', 'bun.lock', 'apps/pwa/package.json'].includes(file));
  const reachable = normalized.some((file) => file.startsWith('src/'))
    ? pwaReachableSrcFiles(cwd) : new Set<string>();
  // The PWA's own sources are inputs of the same static export (PWA-GATE-OWN-DELTA-CACHE ③ — the PWA builds against eln).
  const changed = [
    ...normalized.filter((file) => isPwaAppSource(file)),
    ...normalized.filter((file) => reachable.has(file)),
  ];
  if (!dependency && changed.length === 0) return { ran: false, passed: true, failures: [] };
  const trigger = dependency ? 'dependency' as const : 'pwa-reachable' as const;
  const pwaReachableChanged = changed.slice(0, 10);
  const details = { trigger, pwaReachableChanged };
  const hasRootConfig = existsSync(join(cwd, 'tsconfig.json'));
  if (dependency && !hasRootConfig && changed.length === 0) {
    return { ran: false, passed: true, failures: [], skipped: 'no-tsconfig', ...details };
  }
  const pwaPresent = existsSync(join(cwd, 'apps/pwa'));
  // The build needs `next` resolvable from apps/pwa — its own node_modules or a workspace-hoisted root one.
  // An empty apps/pwa/node_modules is not «installed», and hoisted deps are not «missing».
  const missingDeps = !['apps/pwa/node_modules/next/package.json', 'node_modules/next/package.json']
    .some((path) => existsSync(join(cwd, path)));
  // ② The same inputs already built green ⇒ that build is the measurement. A miss (or no key) builds for real.
  let cacheKey: string | null = null;
  let cacheHit = false;
  if (cacheDir && pwaPresent) {
    const reachableForKey = reachable.size > 0 ? reachable : pwaReachableSrcFiles(cwd);
    cacheKey = pwaBuildCacheKey(cwd, reachableForKey, git);
    cacheHit = cacheKey !== null && readPwaBuildCache(cacheDir, cacheKey);
    debug.log('self-implement', 'gate.pwa-build', {
      cache: cacheKey === null ? 'unavailable' : cacheHit ? 'hit' : 'miss', key: cacheKey?.slice(0, 16) ?? null, trigger,
    });
  }
  const cacheDetails = cacheDir && pwaPresent
    ? { pwaBuildCache: cacheKey === null ? 'unavailable' as const : cacheHit ? 'hit' as const : 'miss' as const, ...(cacheKey ? { pwaBuildCacheKey: cacheKey } : {}) }
    : {};
  const buildUnmeasured = missingDeps && !cacheHit;
  if (buildUnmeasured && (pwaPresent || !dependency)) {
    debug.log('self-implement', 'gate.pwa-reachable', { trigger, changed: pwaReachableChanged, skipped: 'pwa-deps-missing' });
  }
  if (!dependency && buildUnmeasured) {
    return { ran: false, passed: true, measured: false, failures: [], skipped: 'pwa-deps-missing', ...details, ...cacheDetails };
  }

  const failures: DependencyChangeGateResult['failures'] = [];
  let ran = false;
  for (const [step, command, args] of [
    ...(dependency && hasRootConfig ? [['root-tsc', 'bunx', ['tsc', '--noEmit', '-p', 'tsconfig.json']]] : []),
    ...(pwaPresent && !missingDeps && !cacheHit ? [['pwa-build', 'bun', ['bin/elanous.mjs', '--test', 'nexus', 'build']]] : []),
  ] as Array<['root-tsc' | 'pwa-build', string, string[]]>) {
    let result: CommandResult;
    ran = true;
    try {
      result = run(command, args, { cwd, timeout: TIMEOUT_MS });
    } catch (error) {
      result = { status: null, error: error instanceof Error ? error : new Error(String(error)) };
    }
    if (result.status === 0 && !result.error && !result.signal) {
      if (step === 'pwa-build' && cacheDir && cacheKey) writePwaBuildCache(cacheDir, cacheKey, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
      continue;
    }
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const diagnosticLines = output.split(/\r?\n/).filter((line) => step === 'root-tsc' ? line.includes('error TS') : Boolean(line.trim()));
    const unmeasured = result.error || result.signal || result.status === null || diagnosticLines.length === 0;
    const lines = diagnosticLines.slice(0, unmeasured ? 19 : 20);
    if (unmeasured) {
      lines.push(`[${step}] ${result.error?.message?.replace(/\s+/g, ' ') ?? (result.signal ? `signal=${result.signal}` : `exit=${result.status}`)} — 검사 실패 또는 측정 불가 (timeout=${TIMEOUT_MS}ms)`);
    }
    failures.push({ step, lines });
  }
  if (!dependency) debug.log('self-implement', 'gate.pwa-reachable', { trigger, changed: pwaReachableChanged, skipped: undefined });
  return { ran, passed: failures.length === 0, failures, ...details, ...cacheDetails,
    ...(pwaPresent && buildUnmeasured ? { skipped: 'pwa-deps-missing', measured: false } : !dependency ? { measured: true } : {}),
  };
}
