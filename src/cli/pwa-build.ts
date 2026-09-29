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
import { existsSync, readFileSync } from 'node:fs';
import { join as joinPath, dirname } from 'node:path';

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

export async function runPwaBuild(opts: PwaBuildOpts = {}): Promise<PwaBuildResult> {
  const out = opts.out ?? console;
  const argvBin = opts.argvBin ?? process.argv[1] ?? '';
  const cwd = opts.cwd ?? resolvePwaCwd(argvBin);
  if (!cwd) {
    out.error(`elanous nexus build: could not locate apps/pwa (argv[1]=${argvBin || '(empty)'})`);
    out.error('Pass --cwd <path> or run from a checkout of the monad-agent repo.');
    return { exitCode: 1, cwd: '', durationMs: 0 };
  }

  // FU5 — precheck. Catches the "stale tree · `bun install` never ran"
  // case before webpack does and emits a one-line fix.
  const deps = checkPwaBuildDeps(cwd);
  if (!deps.ok) {
    out.error(`✗ elanous nexus build: missing or incomplete node_modules in ${cwd}: ${deps.missing.slice(0, 3).join(', ')}${deps.missing.length > 3 ? ` (+${deps.missing.length - 3} more)` : ''}`);
    out.error(`  fix:  cd "${cwd}" && bun install --force`);
    return { exitCode: 1, cwd, durationMs: 0 };
  }

  out.log(`elanous nexus build: ${cwd}`);
  out.log('  bun run build  (Next.js static export · ~30s typical)');
  const t0 = Date.now();
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  const exitCode = await spawnFn('bun', ['run', 'build'], cwd);
  const durationMs = Date.now() - t0;
  const secs = (durationMs / 1000).toFixed(1);
  if (exitCode === 0) {
    out.log(`✓ build succeeded in ${secs}s — out/ ready at ${joinPath(cwd, 'out')}`);
  } else {
    out.error(`✗ build failed (exit ${exitCode}) after ${secs}s`);
  }
  return { exitCode, cwd, durationMs };
}
