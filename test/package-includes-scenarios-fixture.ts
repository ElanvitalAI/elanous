import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { SPAWN_SYNC_MAX_BUFFER } from '../src/util/spawn-sync-output.js';

export interface InstalledPackageFixture {
  readonly scratch: string;
  readonly installedRoot: string;
  readonly configRoot: string;
  readonly packedPaths: ReadonlySet<string>;
  readonly expectedScenarios: readonly string[];
  cleanup(): void;
}
export interface DirtySourceProof {
  readonly expectedCli: string;
  readonly snapshotCliPath: string;
  readonly expectedScenario: string;
  readonly expectedScenarios: readonly string[];
  readonly snapshotScenarioPath: string;
  cleanup(): void;
}
function success(result: SpawnSyncReturns<string>, label: string): string {
  if (result.status !== 0) throw new Error(`${label} failed (status=${result.status}): ${result.error?.message ?? result.stderr?.trim() ?? ''}`);
  return result.stdout ?? '';
}
function scenarioFiles(scenariosRoot: string): string[] {
  if (!existsSync(scenariosRoot)) return [];
  const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.isFile() || entry.isSymbolicLink() ? [`scenarios/${relative(scenariosRoot, path).split(sep).join('/')}`] : [];
  });
  return walk(scenariosRoot).sort();
}
function copyWorkingTreeChanges(source: string, snapshot: string): void {
  const patch = success(spawnSync('git', ['diff', '--binary', 'HEAD'], { cwd: source, encoding: 'utf8' }), 'git diff working tree');
  if (patch) success(spawnSync('git', ['apply', '--binary', '-'], { cwd: snapshot, input: patch, encoding: 'utf8' }), 'apply tracked working tree changes');
  const untracked = success(spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: source, encoding: 'utf8', maxBuffer: SPAWN_SYNC_MAX_BUFFER }), 'git list untracked files');
  for (const relativePath of untracked.split('\0').filter(Boolean)) {
    const target = join(snapshot, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(source, relativePath), target, { recursive: true, dereference: false });
  }
}
export function createDirtySourceProof(): DirtySourceProof {
  const scratch = mkdtempSync(join(tmpdir(), 'elanous-dirty-source-proof-'));
  try {
    const source = join(scratch, 'source'), snapshot = join(scratch, 'snapshot');
    mkdirSync(join(source, 'bin'), { recursive: true });
    mkdirSync(join(source, 'scenarios'), { recursive: true });
    success(spawnSync('git', ['init', source], { encoding: 'utf8' }), 'git init');
    success(spawnSync('git', ['-C', source, 'config', 'user.name', 'Package Smoke'], { encoding: 'utf8' }), 'git config name');
    success(spawnSync('git', ['-C', source, 'config', 'user.email', 'package-smoke@example.invalid'], { encoding: 'utf8' }), 'git config email');
    const cliPath = join(source, 'bin', 'elanous.mjs');
    const expectedCli = "export const source = 'dirty-working-tree';\n";
    writeFileSync(cliPath, "export const source = 'committed';\n");
    const committedScenarioPath = join(source, 'scenarios', 'committed-case.yaml');
    writeFileSync(committedScenarioPath, 'scenario: committed\n');
    success(spawnSync('git', ['-C', source, 'add', 'bin/elanous.mjs', 'scenarios/committed-case.yaml'], { encoding: 'utf8' }), 'git add');
    success(spawnSync('git', ['-C', source, 'commit', '-m', 'fixture baseline'], { encoding: 'utf8' }), 'git commit');
    writeFileSync(cliPath, expectedCli);
    rmSync(committedScenarioPath);
    const scenarioPath = join(source, 'scenarios', 'untracked-case.yaml');
    const expectedScenario = 'scenario: untracked-working-tree\n';
    mkdirSync(dirname(scenarioPath), { recursive: true });
    writeFileSync(scenarioPath, expectedScenario);
    const head = success(spawnSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }), 'fixture head').trim();
    success(spawnSync('git', ['clone', '--shared', '--no-checkout', source, snapshot], { encoding: 'utf8' }), 'fixture clone');
    success(spawnSync('git', ['checkout', '--detach', head], { cwd: snapshot, encoding: 'utf8' }), 'fixture checkout');
    copyWorkingTreeChanges(source, snapshot);
    return {
      expectedCli,
      snapshotCliPath: join(snapshot, 'bin', 'elanous.mjs'),
      expectedScenario,
      expectedScenarios: scenarioFiles(join(snapshot, 'scenarios')),
      snapshotScenarioPath: join(snapshot, 'scenarios', 'untracked-case.yaml'),
      cleanup: () => rmSync(scratch, { recursive: true, force: true }),
    };
  } catch (error) { rmSync(scratch, { recursive: true, force: true }); throw error; }
}
export function createInstalledPackageFixture(repoRoot: string, mutateSnapshot?: (snapshot: string) => void): InstalledPackageFixture {
  const scratch = mkdtempSync(join(tmpdir(), 'elanous-package-scenarios-'));
  try {
    const packDir = join(scratch, 'pack'), packSource = join(scratch, 'pack-source');
    const installRoot = join(scratch, 'install'), configRoot = join(scratch, 'config');
    mkdirSync(packDir); mkdirSync(installRoot); mkdirSync(configRoot);
    const head = success(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }), 'git rev-parse').trim();
    success(spawnSync('git', ['clone', '--shared', '--no-checkout', repoRoot, packSource], { encoding: 'utf8' }), 'isolated source clone');
    success(spawnSync('git', ['checkout', '--detach', head], { cwd: packSource, encoding: 'utf8' }), 'isolated source checkout');
    copyWorkingTreeChanges(repoRoot, packSource);
    mutateSnapshot?.(packSource);
    success(spawnSync('bun', ['pm', 'pack', '--destination', packDir], { cwd: packSource, encoding: 'utf8' }), 'bun pm pack');
    const tarballName = readdirSync(packDir).find((name) => name.endsWith('.tgz'));
    if (!tarballName) throw new Error('bun pm pack produced no tarball');
    const tarball = join(packDir, tarballName);
    const listing = success(spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' }), 'tar listing');
    const packedPaths = new Set(listing.split('\n').map((path) => path.replace(/^package\//, '')));
    const expectedScenarios = scenarioFiles(join(packSource, 'scenarios'));
    success(spawnSync('tar', ['-xzf', tarball, '-C', installRoot], { encoding: 'utf8' }), 'tar extraction');
    const installedRoot = join(installRoot, 'node_modules', 'elanous');
    mkdirSync(join(installRoot, 'node_modules'));
    renameSync(join(installRoot, 'package'), installedRoot);
    success(spawnSync(process.execPath, ['install', '--production'], { cwd: installedRoot, encoding: 'utf8' }), 'production package install');
    return { scratch, installedRoot, configRoot, packedPaths, expectedScenarios, cleanup: () => rmSync(scratch, { recursive: true, force: true }) };
  } catch (error) { rmSync(scratch, { recursive: true, force: true }); throw error; }
}
