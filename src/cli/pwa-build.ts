// P.2 — `elanous nexus pwa build` subcommand action.
//
// Wraps `bun run build` in the repo's `apps/pwa` package so users don't
// need to remember the cd / build command pair. The Next.js static export
// lands at `apps/pwa/out/`, which the runNexus boot path auto-detects (P.1)
// and serves at `http://<host>:31415/app/`.
//
// Banner hint (in printBootBanner) refers users here when the output dir
// is missing. The first-boot wizard (P.3) reuses runPwaBuild to chain a
// build into the Tailscale share decision.

import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join as joinPath, dirname, resolve as resolvePath } from 'node:path';
import { debug } from '../debug/log.js';

export interface PwaBuildOpts {
  /** Override the apps/pwa cwd (tests + first-boot wizard). Defaults to
   *  the repo `apps/pwa` resolved from `argvBin` (process.argv[1]). */
  cwd?: string;
  /** argv[1] for default cwd resolution. Defaults to `process.argv[1]`. */
  argvBin?: string;
  /** Test seam — injectable spawn returning exit code. Production uses
   *  `child_process.spawn('bun', ['run', 'build'], { cwd, stdio: 'inherit' })`. */
  spawnFn?: (cmd: string, args: string[], cwd: string) => Promise<number>;
  /** Output sink (default = console). */
  out?: { log: (s: string) => void; error: (s: string) => void };
}

export interface PwaBuildResult {
  /** Child exit code (0 = success). The CLI propagates this to
   *  `process.exit` so script automation gets the right signal. */
  exitCode: number;
  /** Resolved `apps/pwa` cwd, or empty string when resolution failed. */
  cwd: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

function defaultSpawn(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    child.on('error', (err) => reject(err));
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

/** Resolve the repo `apps/pwa` directory from a CLI entry path. Returns
 *  undefined when no `apps/pwa/package.json` is found at the expected
 *  sibling location (e.g., installed npm package without the source
 *  tree). */
export function resolvePwaCwd(argvBin: string): string | undefined {
  if (!argvBin) return undefined;
  const candidate = joinPath(dirname(argvBin), '..', 'apps/pwa');
  return existsSync(joinPath(candidate, 'package.json')) ? candidate : undefined;
}

/**
 * FU5 (2026-05-12) — sanity-check apps/pwa's node_modules before
 * spawning the Next.js build. Dia CDP dogfood found that a stale
 * sibling repo had `package.json` declaring `@dagrejs/dagre` but no
 * `node_modules/@dagrejs/dagre/` — webpack failed mid-build with a
 * cryptic `Module not found` trace. Detecting the missing dep up
 * front lets the wrapper hand the user a one-line fix ("run
 * `bun install` in apps/pwa") instead of forcing them to read the
 * webpack output.
 *
 * Returns either a "looks installed" verdict or a diagnostic with
 * the missing dep names (capped at 3 so the message stays short).
 *
 * 2026-07-11 — the required set is now derived from `apps/pwa/package.json`
 * `dependencies` (every runtime dep webpack must resolve) UNION `@types/*`
 * devDependencies and a small core safety list. The old hardcoded 3-item list only caught a missing dep if it
 * happened to be one of those three: a stale tree missing `remark-wiki-link`
 * (but not dagre) sailed past the precheck straight into a cryptic webpack
 * "Module not found". Deriving from package.json makes the precheck
 * self-maintaining — any declared-but-uninstalled dep is flagged up front.
 */
const PWA_BUILD_REQUIRED_DEPS = [
  '@dagrejs/dagre',
  'next',
  'react',
] as const;

interface PwaBuildPrecheck {
  ok: boolean;
  /** Empty when ok. */
  missing: string[];
}

/** Runtime deps webpack must resolve plus @types devDependencies needed by tsc,
 *  unioned with the core safety list. Fail-soft: an unreadable package.json
 *  degrades to just the core list. */
function pwaRequiredDeps(
  cwd: string,
  readFn: (p: string) => string,
): string[] {
  let declared: string[] = [];
  try {
    const pkg = JSON.parse(readFn(joinPath(cwd, 'package.json'))) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    declared = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {}).filter((dep) => dep.startsWith('@types/'))];
  } catch { /* unreadable/absent package.json → core list only */ }
  return [...new Set([...declared, ...PWA_BUILD_REQUIRED_DEPS])];
}

export function checkPwaBuildDeps(
  cwd: string,
  existsFn: (p: string) => boolean = existsSync,
  readFn: (p: string) => string = (p) => readFileSync(p, 'utf-8'),
): PwaBuildPrecheck {
  const nm = joinPath(cwd, 'node_modules');
  if (!existsFn(nm)) {
    return { ok: false, missing: ['<node_modules dir>'] };
  }
  const missing: string[] = [];
  for (const dep of pwaRequiredDeps(cwd, readFn)) {
    const pkgPath = joinPath(nm, dep, 'package.json');
    if (!existsFn(pkgPath)) { missing.push(dep); continue; }
    if (dep.startsWith('@types/')) {
      try {
        const pkg = JSON.parse(readFn(pkgPath)) as { types?: string; typings?: string };
        const declaration = pkg.types ?? pkg.typings ?? 'index.d.ts';
        if (!existsFn(joinPath(nm, dep, declaration))) missing.push(dep);
      } catch { missing.push(dep); }
    }
  }
  return { ok: missing.length === 0, missing };
}

/** Same name as apps/pwa/scripts/static-generation.ts PWA_BUILD_MARKER. */
export const PWA_BUILD_MARKER = 'elanous-pwa-build.json';

/** Commit recorded in `<out>/elanous-pwa-build.json`, or '' when absent/unreadable. */
export function readPwaBuildMarkerCommit(outDir: string): string {
  try {
    const marker = JSON.parse(readFileSync(joinPath(outDir, PWA_BUILD_MARKER), 'utf-8')) as { commit?: unknown };
    return typeof marker.commit === 'string' && /^[0-9a-f]{40}$/.test(marker.commit) ? marker.commit : '';
  } catch {
    return '';
  }
}

/** A served export: regular index.html that is not the prerender error shell, plus _next assets. */
export function staticExportProblem(outDir: string): string | undefined {
  try {
    const index = joinPath(outDir, 'index.html');
    if (!existsSync(index) || !lstatSync(index).isFile()) return 'out-missing';
    if (readFileSync(index, 'utf-8').includes('__next_error__')) return 'out-error-shell';
    const assets = joinPath(outDir, '_next');
    if (!existsSync(assets) || readdirSync(assets).length === 0) return 'out-no-assets';
    return undefined;
  } catch {
    return 'out-unreadable';
  }
}

export type PrebuiltPwaVerdict =
  | { kind: 'checkout' }
  | { kind: 'prebuilt'; commit: string }
  | { kind: 'fallback'; reason: string };

/**
 * PWA-RUNTIME-LEAN — in an installed package (packed revision, no .git) the
 * PWA ships prebuilt in apps/pwa/out. When its build marker names this
 * package's commit, `nexus build` has nothing to do and must not install the
 * ~750MB apps/pwa/node_modules. A checkout keeps the old build path.
 */
export function checkPrebuiltPwa(pwaCwd: string): PrebuiltPwaVerdict {
  const root = resolvePath(pwaCwd, '../..');
  const packedPath = joinPath(root, 'src/version/packed-revision.json');
  if (existsSync(joinPath(root, '.git')) || !existsSync(packedPath)) return { kind: 'checkout' };
  let packed = '';
  try {
    const raw = JSON.parse(readFileSync(packedPath, 'utf-8')) as { commit?: unknown };
    packed = typeof raw.commit === 'string' && /^[0-9a-f]{40}$/.test(raw.commit) ? raw.commit : '';
  } catch { /* unreadable → fallback below */ }
  if (!packed) return { kind: 'fallback', reason: 'packed-revision-unreadable' };
  const outDir = joinPath(pwaCwd, 'out');
  const problem = staticExportProblem(outDir);
  if (problem) return { kind: 'fallback', reason: problem };
  const marker = readPwaBuildMarkerCommit(outDir);
  if (!marker) return { kind: 'fallback', reason: 'marker-missing' };
  if (marker !== packed) return { kind: 'fallback', reason: `marker-mismatch out=${marker.slice(0, 12)} package=${packed.slice(0, 12)}` };
  return { kind: 'prebuilt', commit: packed };
}

export async function runPwaBuild(opts: PwaBuildOpts = {}): Promise<PwaBuildResult> {
  const out = opts.out ?? console;
  const argvBin = opts.argvBin ?? process.argv[1] ?? '';
  const cwd = opts.cwd ?? resolvePwaCwd(argvBin);
  if (!cwd) {
    out.error(`elanous nexus build: could not locate apps/pwa (argv[1]=${argvBin || '(empty)'})`);
    out.error('Pass --cwd <path> or run from a checkout of the monad-agent repo.');
    return { exitCode: 1, cwd: '', durationMs: 0 };
  }

  const t0 = Date.now();
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  const prebuilt = checkPrebuiltPwa(cwd);
  if (prebuilt.kind === 'prebuilt') {
    out.log(`pwa.lean skip=prebuilt commit=${prebuilt.commit.slice(0, 12)} — installed package already carries this version's PWA (${joinPath(cwd, 'out')})`);
    try { debug.log('pwa', 'lean-prebuilt', { commit: prebuilt.commit, cwd }); } catch { /* 관측 실패가 빌드를 막지 않는다 */ }
    return { exitCode: 0, cwd, durationMs: Date.now() - t0 };
  }
  if (prebuilt.kind === 'fallback') {
    // Never ship a blank PWA: the old in-place build path still runs. A
    // real-directory out is swapped only after Next succeeds
    // (static-generation.ts replaceInstalledRealDirOut).
    out.log(`pwa.lean fallback=in-place-build reason=${prebuilt.reason}`);
    try { debug.log('pwa', 'lean-fallback', { fallback: 'in-place-build', reason: prebuilt.reason, cwd }); } catch { /* 관측 실패가 빌드를 막지 않는다 */ }
  }
  return runPwaBuildInPlace(cwd, t0, spawnFn, out);
}

async function runPwaBuildInPlace(
  cwd: string,
  t0: number,
  spawnFn: NonNullable<PwaBuildOpts['spawnFn']>,
  out: NonNullable<PwaBuildOpts['out']>,
): Promise<PwaBuildResult> {
  // Prepare a cold install from the checked-in lockfile and verify that the
  // dependencies appeared before allowing the build to run.
  let deps = checkPwaBuildDeps(cwd);
  if (!deps.ok) {
    if (!existsSync(joinPath(cwd, 'package.json')) || !existsSync(joinPath(cwd, 'bun.lock'))) {
      out.error(`✗ elanous nexus build: package.json or bun.lock missing in ${cwd}; bun install cannot prepare a frozen PWA tree`);
      return { exitCode: 1, cwd, durationMs: Date.now() - t0 };
    }
    out.log(`elanous nexus build: preparing missing PWA dependencies in ${cwd}`);
    let installExit: number;
    try { installExit = await spawnFn('bun', ['install', '--frozen-lockfile'], cwd); }
    catch { installExit = 1; }
    if (installExit !== 0) {
      out.error(`✗ elanous nexus build: PWA dependency install failed (exit ${installExit})`);
      return { exitCode: installExit, cwd, durationMs: Date.now() - t0 };
    }
    deps = checkPwaBuildDeps(cwd);
    if (!deps.ok) {
      out.error(`✗ elanous nexus build: PWA dependencies still missing after bun install: ${deps.missing.slice(0, 3).join(', ')}`);
      return { exitCode: 1, cwd, durationMs: Date.now() - t0 };
    }
  }

  out.log(`elanous nexus build: ${cwd}`);
  out.log('  bun run build  (Next.js static export · ~30s typical)');
  let exitCode: number;
  try { exitCode = await spawnFn('bun', ['run', 'build'], cwd); }
  catch { exitCode = 1; }
  const durationMs = Date.now() - t0;
  const secs = (durationMs / 1000).toFixed(1);
  if (exitCode === 0) {
    out.log(`✓ build succeeded in ${secs}s — out/ ready at ${joinPath(cwd, 'out')}`);
  } else {
    out.error(`✗ build failed (exit ${exitCode}) after ${secs}s`);
  }
  return { exitCode, cwd, durationMs };
}
