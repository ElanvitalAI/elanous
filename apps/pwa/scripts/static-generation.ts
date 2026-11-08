import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
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

export async function runStaticBuild(appDir = resolve(import.meta.dir, '..')): Promise<void> {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'elanous-pwa-build-'));
  const stagedRepo = join(temporaryRoot, 'repo');
  const stagedApp = join(stagedRepo, 'apps', 'pwa');
  const repoRoot = resolve(appDir, '../..');
  try {
    mkdirSync(dirname(stagedApp), { recursive: true });
    cpSync(appDir, stagedApp, { recursive: true, filter: (source) => !source.includes('/node_modules') && !source.includes('/.next') && !source.endsWith('/out') && !source.includes('/.pwa-generations') });
    cpSync(join(repoRoot, 'src'), join(stagedRepo, 'src'), { recursive: true });
    cpSync(join(repoRoot, 'scripts'), join(stagedRepo, 'scripts'), { recursive: true });
    symlinkSync(join(repoRoot, 'node_modules'), join(stagedRepo, 'node_modules'), 'dir');
    const appNodeModules = join(appDir, 'node_modules');
    if (existsSync(appNodeModules)) symlinkSync(appNodeModules, join(stagedApp, 'node_modules'), 'dir');
    const buildSha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: appDir, encoding: 'utf8' }).stdout.trim();
    const result = spawnSync(process.execPath, [resolveNextBuildBin(appDir), 'build'], {
      cwd: stagedApp,
      stdio: 'inherit',
      env: { ...process.env, ...(buildSha ? { ELANOUS_PWA_BUILD_SHA: buildSha } : {}) },
    });
    if (result.status !== 0) throw new Error(`next build failed (${result.status ?? result.signal})`);
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
