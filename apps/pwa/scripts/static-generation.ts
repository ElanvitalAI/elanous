import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { publishStaticGeneration } from './publish-static-generation';

export function validateStaticExport(candidate: string): void {
  const index = join(candidate, 'index.html');
  if (!existsSync(index) || !lstatSync(index).isFile()) throw new Error(`invalid static export: missing regular index.html in ${candidate}`);
  const assets = join(candidate, '_next');
  if (!existsSync(assets) || !lstatSync(assets).isDirectory() || readdirSync(assets).length === 0) {
    throw new Error(`invalid static export: missing Next.js assets in _next for ${candidate}`);
  }
}

export function resolveNextBuildBin(appDir: string): string {
  return createRequire(join(resolve(appDir), 'package.json')).resolve('next/dist/bin/next');
}

function resolveRepositoryNodeModules(repoRoot: string): string[] {
  const sources: string[] = [];
  // Node checks node_modules beside each parent directory, skipping a
  // directory already named node_modules. This also reaches a sibling such as
  // /project/node_modules from /project/foo/node_modules/a/node_modules/elanous.
  for (let parent = repoRoot; ; parent = dirname(parent)) {
    if (basename(parent) !== 'node_modules') {
      const candidate = join(parent, 'node_modules');
      if (existsSync(candidate) && !sources.includes(candidate)) sources.push(candidate);
    }
    if (parent === dirname(parent)) break;
  }
  if (sources.length === 0) throw new Error(`cannot find node_modules for installed package at ${repoRoot}`);
  return sources;
}

function linkRepositoryNodeModules(repoRoot: string, stagedRepo: string, appNodeModules?: string): void {
  const sources = resolveRepositoryNodeModules(repoRoot);
  if (appNodeModules && existsSync(appNodeModules) && !sources.includes(appNodeModules)) sources.push(appNodeModules);
  if (sources.length === 1) {
    symlinkSync(sources[0]!, join(stagedRepo, 'node_modules'), 'dir');
    return;
  }

  const stagedModules = join(stagedRepo, 'node_modules');
  mkdirSync(stagedModules, { recursive: true });
  // Local package dependencies shadow hoisted dependencies in Node resolution.
  for (const source of sources) {
    for (const name of readdirSync(source)) {
      const sourceEntry = join(source, name);
      const stagedEntry = join(stagedModules, name);
      if (name.startsWith('@') && existsSync(sourceEntry) && lstatSync(sourceEntry).isDirectory()) {
        mkdirSync(stagedEntry, { recursive: true });
        for (const scopedName of readdirSync(sourceEntry)) {
          const scopedSource = join(sourceEntry, scopedName);
          const scopedStaged = join(stagedEntry, scopedName);
          if (!existsSync(scopedStaged)) symlinkSync(scopedSource, scopedStaged, 'dir');
        }
      } else if (!existsSync(stagedEntry)) {
        symlinkSync(sourceEntry, stagedEntry, lstatSync(sourceEntry).isDirectory() ? 'dir' : 'file');
      }
    }
  }
}

/** Stage a repository-owned directory that Next imports across the app/repo boundary. */
export function linkStagedRepoDirectory(repoRoot: string, stagedRepo: string, name: string): string {
  const source = join(repoRoot, name);
  const destination = join(stagedRepo, name);
  mkdirSync(dirname(destination), { recursive: true });
  symlinkSync(source, destination, 'dir');
  return destination;
}

export function migrateStoppedOut(outDir: string, afterLegacyMoved?: () => void): string {
  const out = resolve(outDir);
  if (!existsSync(out)) {
    const recovered = recoverStoppedMigration(out);
    if (recovered) return recovered;
  }
  if (!existsSync(out) || lstatSync(out).isSymbolicLink()) throw new Error(`migration requires a real out directory: ${out}`);
  const parent = dirname(out);
  const generations = join(parent, '.pwa-generations');
  mkdirSync(generations, { recursive: true });
  const staging = mkdtempSync(join(generations, '.migration-'));
  const generation = join(generations, `generation-${Date.now()}-${process.pid}`);
  const backup = join(parent, `.out-legacy-${process.pid}-${Date.now()}`);
  const link = join(parent, `.out-link-${process.pid}-${Date.now()}`);
  try {
    cpSync(out, staging, { recursive: true, dereference: true });
    validateStaticExport(staging);
    renameSync(staging, generation);
    symlinkSync(relative(parent, generation), link, 'dir');
    renameSync(out, backup);
    afterLegacyMoved?.();
    try {
      renameSync(link, out);
    } catch (error) {
      renameSync(backup, out);
      throw error;
    }
    return generation;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(link, { force: true });
  }
}

function recoverStoppedMigration(out: string): string | undefined {
  const parent = dirname(out);
  if (!existsSync(parent)) return undefined;
  const entries = readdirSync(parent);
  const pendingLinks = entries.filter((entry) => entry.startsWith('.out-link-'));
  for (const name of pendingLinks) {
    const link = join(parent, name);
    try {
      if (!lstatSync(link).isSymbolicLink()) continue;
      const generation = realpathSync(link);
      validateStaticExport(generation);
      renameSync(link, out);
      return generation;
    } catch {
      continue;
    }
  }
  const backups = entries.filter((entry) => entry.startsWith('.out-legacy-')).sort().reverse();
  const backup = backups[0];
  if (backup) renameSync(join(parent, backup), out);
  return undefined;
}

export interface StaticBuildTestHooks {
  /** Test seam invoked after staging; production always runs Next.js directly. */
  readonly runBuild?: (appDir: string, stagedRepo: string, stagedApp: string) => number;
}

export async function runStaticBuild(appDir = resolve(import.meta.dir, '..'), hooks: StaticBuildTestHooks = {}): Promise<void> {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'elanous-pwa-build-'));
  const stagedRepo = join(temporaryRoot, 'repo');
  const stagedApp = join(stagedRepo, 'apps', 'pwa');
  const repoRoot = resolve(appDir, '../..');
  try {
    mkdirSync(dirname(stagedApp), { recursive: true });
    cpSync(appDir, stagedApp, {
      recursive: true,
      filter: (source) => {
        // The installed package itself can live below node_modules. Filter only
        // generated paths inside apps/pwa, not matching ancestor directories.
        const segments = relative(appDir, source).split(sep);
        return !segments.includes('node_modules') && !segments.includes('.next') &&
          segments.at(-1) !== 'out' && !segments.includes('.pwa-generations');
      },
    });
    cpSync(join(repoRoot, 'src'), join(stagedRepo, 'src'), { recursive: true });
    cpSync(join(repoRoot, 'scripts'), join(stagedRepo, 'scripts'), { recursive: true });
    cpSync(join(repoRoot, 'skills', 'omni-crawl'), join(stagedRepo, 'skills', 'omni-crawl'), { recursive: true });
    // Source modules imported by Next can resolve scenario fixtures during type checking.
    linkStagedRepoDirectory(repoRoot, stagedRepo, 'scenarios');
    // First-run provider selection imports its curated model list from catalog/.
    linkStagedRepoDirectory(repoRoot, stagedRepo, 'catalog');
    // The OpenRouter model picker also imports its Solar profile from docs/.
    linkStagedRepoDirectory(repoRoot, stagedRepo, 'docs/profiles');
    // Source type-checking follows imports into bundled plugin TypeScript too.
    // Stage the shipped plugin tree, not only the graph UI plugin.
    linkStagedRepoDirectory(repoRoot, stagedRepo, 'plugins');
    const appNodeModules = join(appDir, 'node_modules');
    linkRepositoryNodeModules(repoRoot, stagedRepo, appNodeModules);
    if (existsSync(appNodeModules)) symlinkSync(appNodeModules, join(stagedApp, 'node_modules'), 'dir');
    const buildSha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: appDir, encoding: 'utf8' }).stdout.trim();
    const status = hooks.runBuild
      ? hooks.runBuild(appDir, stagedRepo, stagedApp)
      : spawnSync(process.execPath, [resolveNextBuildBin(appDir), 'build'], {
        cwd: stagedApp,
        stdio: 'inherit',
        env: { ...process.env, ...(buildSha ? { ELANOUS_PWA_BUILD_SHA: buildSha } : {}) },
      }).status ?? 1;
    if (status !== 0) throw new Error(`next build failed (${status})`);
    await publishStaticGeneration(join(stagedApp, 'out'), appDir);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode === 'build') await runStaticBuild();
  else if (mode === 'migrate-stopped') {
    const appDir = resolve(import.meta.dir, '..');
    migrateStoppedOut(join(appDir, 'out'));
  } else throw new Error('usage: static-generation.ts build|migrate-stopped');
}
