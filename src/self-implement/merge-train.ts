import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { getDefaultLogStore } from '../mss/logging/log-store.js';
import { planCulpritDriftRepair, type RepairPlan } from '../cli/pr-land-drift-repair.js';
import { addedLines, checkTheirsLinesKept, collectConflictAnalysis, parseMergeTreeConflictPaths, planConflictRepair, type ConflictRepairPlan } from '../cli/pr-land-conflict-merge.js';
import { SPAWN_SYNC_MAX_BUFFER } from '../util/spawn-sync-output.js';

export type TrainCandidate = { number: number; head: string; title?: string; body?: string; files?: string[]; filesUnmeasured?: boolean };
export type TrainDeferred = { number: number; reason: 'overlap' | 'files-unknown'; with?: number[] };
export type TrainConflict = { number: number; reason: 'conflict'; files: string[]; repairPlan?: ConflictRepairPlan };
export type TrainIntegration = { commitSha?: string; conflicts: TrainConflict[]; conflictPlans?: TrainConflict[]; unmeasured?: boolean };
export type TrainVerdict = { number: number; verdict: 'pass' | 'fail' | 'conflict' | 'unmeasured' };
export type TrainConflictPlanSummary = { number: number; files: string[]; decision: ConflictRepairPlan['decision'] | 'unmeasured'; reason: string; goal?: string };
export type TrainObservation = {
  batch: number[];
  deferred: TrainDeferred[] | null;
  gatesRun: number;
  passed: number[];
  culprits: number[];
  unmeasured: number[];
  gatesPerLanding: number;
  conflictPlans?: TrainConflictPlanSummary[];
};
/** Run-local progress emitted by the production train library through an injected observer. */
export type TrainProgressEvent =
  | { readonly eventId: string; readonly type: 'merge-train.batch'; readonly batch: readonly { readonly number: number; readonly head: string }[] }
  | { readonly eventId: string; readonly type: 'merge-train.verdict'; readonly observation: TrainObservation; readonly verdicts: readonly TrainVerdict[] };
export type TrainGit = (args: readonly string[], repo: string, env?: NodeJS.ProcessEnv) => { status: number | null; stdout: string; stderr: string };
export type TangledPair = { first: number; then: number; failures: number };

/**
 * Same PR-number axis as TrainDeferred.with and planTrain overlap deferrals: normalize each sibling
 * pair ({5,7}={7,5}), count its conflict-resolution/regate failures, and return only pairs at or
 * above threshold (default 2) — first = smaller number = lands first, then = re-synced later.
 */
export function tangledPairs(
  failures: readonly { pr: number; with: number }[],
  { threshold = 2 }: { threshold?: number } = {},
): TangledPair[] {
  const counts = new Map<string, TangledPair>();
  for (const failure of failures) {
    const first = Math.min(failure.pr, failure.with);
    const then = Math.max(failure.pr, failure.with);
    const key = `${first}:${then}`;
    const pair = counts.get(key);
    if (pair) pair.failures++;
    else counts.set(key, { first, then, failures: 1 });
  }
  return [...counts.values()]
    .filter((pair) => pair.failures >= threshold)
    .sort((left, right) => left.first - right.first || left.then - right.then);
}

export function planTrain(candidates: readonly TrainCandidate[], { maxBatch }: { maxBatch: number }): { batch: TrainCandidate[]; deferred: TrainDeferred[] } {
  if (!Number.isSafeInteger(maxBatch) || maxBatch < 1) throw new Error('maxBatch must be a positive integer');
  const batch: TrainCandidate[] = [];
  const deferred: TrainDeferred[] = [];
  for (const candidate of candidates) {
    const unknown = candidate.filesUnmeasured || !candidate.files;
    if (batch.length === 0) {
      batch.push(candidate);
    } else if (unknown || batch.some((item) => item.filesUnmeasured || !item.files)) {
      deferred.push({ number: candidate.number, reason: 'files-unknown' });
    } else {
      const overlapping = batch.filter((item) => item.files!.some((file) => candidate.files!.includes(file))).map((item) => item.number);
      if (overlapping.length) deferred.push({ number: candidate.number, reason: 'overlap', with: overlapping });
      else if (batch.length < maxBatch) batch.push(candidate);
      // A full batch leaves later candidates untouched for the next selection.
    }
    if (batch.length === maxBatch) break;
  }
  return { batch, deferred };
}

const defaultGit: TrainGit = (args, repo, env) => {
  const result = spawnSync('git', [...args], { cwd: repo, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: (result.stderr ?? '') + (result.error?.message ?? '') };
};
const SHA = /^[0-9a-f]{40,64}$/i;
function regularTextMode(revision: string, path: string, run: (args: string[]) => ReturnType<TrainGit>): string | undefined {
  const result = run(['ls-tree', '-z', revision, '--', path]);
  if (result.status !== 0) return undefined;
  const record = result.stdout.split('\0').filter(Boolean);
  if (record.length !== 1) return undefined;
  const match = /^([0-7]{6}) blob [0-9a-f]{40,64}\t(.+)$/i.exec(record[0]!);
  if (!match || match[2] !== path || (match[1] !== '100644' && match[1] !== '100755')) return undefined;
  return match[1];
}
const UX_SIM_FRAGMENTS = 'catalog/ux-sim/mock-scenario-catalog-fragments';
const SIM_WORLD_DEVICE_FRAGMENTS = 'catalog/sim-world-device-catalog-fragments';
const UX_SIM_GENERATOR = 'scripts/generate-ux-sim-device-manual.ts';
const SIM_WORLD_CATALOG_GENERATOR = 'scripts/generate-sim-world-device-catalogs.ts';
const SIM_WORLD_CATALOG_HISTORY = 'src/sim-world-device-catalog-history.json';
const UX_SIM_MODULE = 'src/ux-sim/mock-scenario-catalog.ts';
const UX_SIM_MANUAL = 'docs/manual/MANUAL-ux-simulation-devices-2026-08-23.md';
const CLI_ANATOMY_GENERATOR = 'scripts/docs/generate-cli-anatomy.ts';
const CLI_ANATOMY_OUTPUT = 'docs/generated/cli-anatomy.md';
const UX_TRUSTED_GENERATOR_CODE = [UX_SIM_GENERATOR, SIM_WORLD_CATALOG_GENERATOR, UX_SIM_MODULE] as const;
const CLI_TRUSTED_GENERATOR_CODE = [
  CLI_ANATOMY_GENERATOR,
  'scripts/docs/generate-graph-anatomy.ts',
  'src/graph-kinds/registry.ts',
  'src/self-implement/graph-yaml.ts',
  'src/self-implement/graph-run-contract.ts',
  'src/self-implement/graph-overlay-condition.ts',
  'src/self-implement/graph-unit-resolver.ts',
  'src/self-implement/graph-unit-flatten.ts',
  'src/elanous-config-dir.ts',
  'src/debug/log.ts',
] as const;
const UX_SIM_GENERATOR_OUTPUTS = [UX_SIM_MANUAL] as const;
const SIM_WORLD_GENERATOR_OUTPUTS = [SIM_WORLD_CATALOG_HISTORY] as const;
const CLI_ANATOMY_GENERATOR_OUTPUTS = [CLI_ANATOMY_OUTPUT] as const;
const GENERATED_OUTPUTS = [...UX_SIM_GENERATOR_OUTPUTS, ...SIM_WORLD_GENERATOR_OUTPUTS, ...CLI_ANATOMY_GENERATOR_OUTPUTS] as const;

const CONDUCTOR_CELLS = 'docs/conductor/cells';
const CONDUCTOR_GENERATOR = 'scripts/generate-conductor-cell-map.ts';
const CONDUCTOR_DOCUMENT = 'docs/conductor/CONDUCTOR.md';

function conductorCellFragmentPaths(paths: ReadonlySet<string>): string[] {
  const prefix = `${CONDUCTOR_CELLS}/`;
  return [...paths].filter((path) => path.startsWith(prefix) && path.endsWith('.md'));
}

function simWorldDeviceFragmentPaths(paths: ReadonlySet<string>): string[] {
  const prefix = `${SIM_WORLD_DEVICE_FRAGMENTS}/`;
  return [...paths].filter((path) => path.startsWith(prefix) && path.endsWith('.json'));
}

function withoutGeneratedManualBlock(text: string): string {
  const begin = '<!-- BEGIN GENERATED MOCK DEVICE CATALOG -->';
  const end = '<!-- END GENERATED MOCK DEVICE CATALOG -->';
  const start = text.indexOf(begin);
  const finish = text.indexOf(end, start + begin.length);
  if (start < 0 || finish < 0 || text.indexOf(begin, start + begin.length) >= 0
      || text.indexOf(end, finish + end.length) >= 0) {
    throw new Error('UX simulation manual has an invalid generated-block boundary');
  }
  return `${text.slice(0, start)}<GENERATED>${text.slice(finish + end.length)}`;
}

function readGeneratedOutput(worktree: string, path: string): string | undefined {
  const root = realpathSync(worktree);
  let current = root;
  const segments = path.split('/');
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`generated output path contains a symbolic link: ${path}`);
    const isFile = index === segments.length - 1;
    if (isFile ? !stat.isFile() : !stat.isDirectory()) {
      throw new Error(`generated output path has an unexpected filesystem entry: ${path}`);
    }
  }
  return readFileSync(current, 'utf8');
}

type GeneratorSpawnResult = { status: number | null; stdout: string; stderr: string; error?: NodeJS.ErrnoException };
type GeneratorSpawn = (command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => GeneratorSpawnResult;

export function runGeneratorWithTimeout(
  script: string,
  options: SpawnSyncOptionsWithStringEncoding,
  spawn: GeneratorSpawn = (command, args, spawnOptions) => spawnSync(command, args, {
    ...spawnOptions,
    maxBuffer: spawnOptions.maxBuffer ?? SPAWN_SYNC_MAX_BUFFER,
  }),
): GeneratorSpawnResult {
  return spawn(process.execPath, [script], options);
}

/** Run the fixed generator allowlist against the exact full integrated tree in a disposable git worktree. */
function regenerateUxSimArtifacts(repo: string, inputBaseSha: string, parentSha: string, tree: string, run: (args: string[], env?: NodeJS.ProcessEnv) => ReturnType<TrainGit>): string {
  const workspace = mkdtempSync(join(tmpdir(), 'elanous-ux-sim-train-'));
  const indexPath = join(workspace, 'index');
  const worktree = join(workspace, 'integrated');
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  const readTreeFile = (path: string, revision = tree) => {
    const result = run(['show', `${revision}:${path}`]);
    if (result.status !== 0) throw new Error(`merged tree is missing ${path}: ${result.stderr || result.stdout}`);
    return result.stdout;
  };
  let addedWorktree = false;
  try {
    const temporaryCommit = run(['-c', 'user.name=elanous shadow', '-c', 'user.email=shadow@localhost',
      'commit-tree', tree, '-p', parentSha, '-m', 'Temporary integrated tree for generated outputs']);
    if (temporaryCommit.status !== 0 || !SHA.test(temporaryCommit.stdout.trim())) {
      throw new Error(`could not materialize integrated generator tree: ${temporaryCommit.stderr || temporaryCommit.stdout}`);
    }
    const changed = run(['diff', '--name-only', `${inputBaseSha}..${temporaryCommit.stdout.trim()}`]);
    if (changed.status !== 0) throw new Error(`could not inspect generator changes: ${changed.stderr || changed.stdout}`);
    const changedInputs = new Set(changed.stdout.split('\n').filter(Boolean));
    const uxCodeChanged = UX_TRUSTED_GENERATOR_CODE.some((path) => changedInputs.has(path));
    const cliCodeChanged = CLI_TRUSTED_GENERATOR_CODE.some((path) => changedInputs.has(path))
      || [...changedInputs].some((path) => path.startsWith('src/') && !path.startsWith('src/cli/'));
    const worktreeAdd = run(['worktree', 'add', '--detach', worktree, temporaryCommit.stdout.trim()]);
    if (worktreeAdd.status !== 0) throw new Error(`could not create integrated generator worktree: ${worktreeAdd.stderr || worktreeAdd.stdout}`);
    addedWorktree = true;
    // Execute only generator code from the trusted base. Candidate fragments and CLI source remain data inputs.
    const trustedCode = [...new Set([
      ...(!uxCodeChanged ? UX_TRUSTED_GENERATOR_CODE : []),
      ...(!cliCodeChanged ? CLI_TRUSTED_GENERATOR_CODE : []),
    ])].filter((path) => regularTextMode(inputBaseSha, path, (args) => run(args)) !== undefined);
    if (trustedCode.length) {
      const restore = run(['-C', worktree, 'restore', '--source', inputBaseSha, '--worktree', '--', ...trustedCode]);
      if (restore.status !== 0) throw new Error(`could not restore trusted generator code: ${restore.stderr || restore.stdout}`);
    }
    const dependencies = join(repo, 'node_modules');
    if (existsSync(dependencies)) symlinkSync(realpathSync(dependencies), join(worktree, 'node_modules'), 'dir');
    mkdirSync(join(workspace, '.bun'), { recursive: true });

    const generatorOptions: SpawnSyncOptionsWithStringEncoding = {
      cwd: worktree,
      env: { PATH: '/usr/bin:/bin', HOME: workspace, TMPDIR: workspace, BUN_INSTALL_CACHE_DIR: join(workspace, '.bun'), NODE_ENV: 'production' },
      encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    };
    const generatedPaths = new Set<string>();
    const snapshotOutputs = () => new Map((GENERATED_OUTPUTS as readonly string[]).map((path) => [
      path, readGeneratedOutput(worktree, path),
    ]));
    const changedTreePaths = () => {
      const changed = run(['-C', worktree, 'ls-files', '--modified', '--others', '--exclude-standard']);
      if (changed.status !== 0) throw new Error(`could not inspect generated tree changes: ${changed.stderr || changed.stdout}`);
      return new Set(changed.stdout.split('\n').map((line) => line.trim()).filter(Boolean));
    };
    const runJob = (script: string, label: string, allowedOutputs: readonly string[]) => {
      const before = snapshotOutputs();
      const pathsBefore = changedTreePaths();
      const generator = runGeneratorWithTimeout(script, generatorOptions);
      if (generator.status !== 0) throw new Error(`${label} failed: ${generator.stderr || generator.stdout || generator.error?.message}`);
      const after = snapshotOutputs();
      const modifiedOutputs = [...after.keys()].filter((path) => before.get(path) !== after.get(path));
      const forbiddenOutputs = modifiedOutputs.filter((path) => !allowedOutputs.includes(path));
      if (forbiddenOutputs.length) throw new Error(`${label} changed outputs outside its generator allowlist: ${forbiddenOutputs.join(', ')}`);
      const unexpected = [...changedTreePaths()].filter((path) => !pathsBefore.has(path) && !(GENERATED_OUTPUTS as readonly string[]).includes(path));
      if (unexpected.length) throw new Error(`${label} changed paths outside output allowlist: ${unexpected.join(', ')}`);
      for (const path of modifiedOutputs) generatedPaths.add(path);
    };
    if (!uxCodeChanged) {
      runJob(UX_SIM_GENERATOR, 'UX simulation manual generator', UX_SIM_GENERATOR_OUTPUTS);
      const afterManual = readFileSync(join(worktree, UX_SIM_MANUAL), 'utf8');
      if (withoutGeneratedManualBlock(readTreeFile(UX_SIM_MANUAL)) !== withoutGeneratedManualBlock(afterManual)) {
        throw new Error('UX simulation manual generator changed human-authored content outside generated block');
      }
      runJob(SIM_WORLD_CATALOG_GENERATOR, 'simulation world device catalog generator', SIM_WORLD_GENERATOR_OUTPUTS);
    }
    const shouldGenerateCli = [...changedInputs].some((path) => path.startsWith('src/cli/'));
    if (shouldGenerateCli && !cliCodeChanged) {
      runJob(CLI_ANATOMY_GENERATOR, 'CLI anatomy generator', CLI_ANATOMY_GENERATOR_OUTPUTS);
    }
    const changedPaths = [...generatedPaths].sort();
    if (changedPaths.length === 0) return tree;

    const generatedFiles = changedPaths.map((path) => ({
      path,
      file: join(worktree, path),
    }));
    const blobs = generatedFiles.map(({ path, file }) => {
      const result = run(['hash-object', '-w', '--', file]);
      if (result.status !== 0 || !SHA.test(result.stdout.trim())) throw new Error(`git hash-object ${path}: ${result.stderr || result.stdout}`);
      return { path, oid: result.stdout.trim() };
    });
    const readIndex = run(['read-tree', tree], env);
    if (readIndex.status !== 0) throw new Error(`git read-tree: ${readIndex.stderr || readIndex.stdout}`);
    for (const { path, oid } of blobs) {
      const update = run(['update-index', '--add', '--cacheinfo', `100644,${oid},${path}`], env);
      if (update.status !== 0) throw new Error(`git update-index ${path}: ${update.stderr || update.stdout}`);
    }
    const regeneratedTree = run(['write-tree'], env);
    if (regeneratedTree.status !== 0 || !SHA.test(regeneratedTree.stdout.trim())) throw new Error(`git write-tree: ${regeneratedTree.stderr || regeneratedTree.stdout}`);
    return regeneratedTree.stdout.trim();
  } finally {
    if (addedWorktree) run(['worktree', 'remove', '--force', worktree]);
    rmSync(workspace, { recursive: true, force: true });
  }
}

/** Regenerate the shared conductor index from trusted code and merged per-document fragments. */
function regenerateConductorCellMap(repo: string, baseSha: string, tree: string, run: (args: string[], env?: NodeJS.ProcessEnv) => ReturnType<TrainGit>): string {
  const workspace = mkdtempSync(join(tmpdir(), 'elanous-conductor-cells-train-'));
  const indexPath = join(workspace, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  const readTreeFile = (path: string, revision = tree) => {
    const result = run(['show', `${revision}:${path}`]);
    if (result.status !== 0) throw new Error(`merged tree is missing ${path}: ${result.stderr || result.stdout}`);
    return result.stdout;
  };
  try {
    for (const file of [CONDUCTOR_GENERATOR, CONDUCTOR_DOCUMENT]) {
      const destination = join(workspace, file);
      mkdirSync(join(destination, '..'), { recursive: true });
      writeFileSync(destination, readTreeFile(file, file === CONDUCTOR_GENERATOR ? baseSha : tree));
    }
    const cellPaths = run(['ls-tree', '-r', '--name-only', tree, '--', CONDUCTOR_CELLS]);
    if (cellPaths.status !== 0) throw new Error(`merged conductor cell fragments are unreadable: ${cellPaths.stderr || cellPaths.stdout}`);
    const files = cellPaths.stdout.split('\n').filter((path) => path.endsWith('.md'));
    if (!files.length) throw new Error('merged conductor cell fragments are empty');
    for (const file of files) {
      const destination = join(workspace, file);
      mkdirSync(join(destination, '..'), { recursive: true });
      writeFileSync(destination, readTreeFile(file));
    }
    const generatorOptions: SpawnSyncOptionsWithStringEncoding = {
      cwd: workspace,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: workspace, TMPDIR: workspace, NODE_ENV: 'production' },
      encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    };
    const generator = spawnSync('bun', [CONDUCTOR_GENERATOR], generatorOptions);
    if (generator.status !== 0) throw new Error(`conductor cell-map generator failed: ${generator.stderr || generator.stdout || generator.error?.message}`);

    const generatedDocument = join(workspace, CONDUCTOR_DOCUMENT);
    const blob = run(['hash-object', '-w', '--', generatedDocument]);
    if (blob.status !== 0 || !SHA.test(blob.stdout.trim())) throw new Error(`git hash-object: ${blob.stderr || blob.stdout}`);
    const readIndex = run(['read-tree', tree], env);
    if (readIndex.status !== 0) throw new Error(`git read-tree: ${readIndex.stderr || readIndex.stdout}`);
    const update = run(['update-index', '--add', '--cacheinfo', `100644,${blob.stdout.trim()},${CONDUCTOR_DOCUMENT}`], env);
    if (update.status !== 0) throw new Error(`git update-index: ${update.stderr || update.stdout}`);
    const regeneratedTree = run(['write-tree'], env);
    if (regeneratedTree.status !== 0 || !SHA.test(regeneratedTree.stdout.trim())) throw new Error(`git write-tree: ${regeneratedTree.stderr || regeneratedTree.stdout}`);
    return regeneratedTree.stdout.trim();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

/** Pass driver config only to this merge-tree process. Worktree .git/config can be shared,
 * so persistent --local settings race across simultaneous train worktrees. */
function uxSimMergeDriverArgs(repo: string): string[] {
  const driver = resolve(repo, 'scripts/ux-sim-merge-driver.mjs');
  return [
    '-c', `merge.uxsim-manual.driver=node \"${driver}\" manual \"%O\" \"%A\" \"%B\"`,
  ];
}

/** Create unreachable synthetic merge commits only; never update refs or check out a tree. */
export function integrateTrain(repo: string, baseSha: string, batch: readonly TrainCandidate[], git: TrainGit = defaultGit): TrainIntegration {
  if (!SHA.test(baseSha) || batch.some((item) => !SHA.test(item.head))) throw new Error('invalid pinned commit SHA');
  let current = baseSha;
  const conflicts: TrainConflict[] = [];
  const conflictPlans: TrainConflict[] = [];
  const run = (args: string[]) => git(args, repo);
  for (const item of batch) {
    const merge = run([...uxSimMergeDriverArgs(repo), 'merge-tree', '--write-tree', '--name-only', '-z', current, item.head]);
    if (merge.status !== 0) {
      if (/unknown option|unrecognized option|unrecognized argument|invalid option|unknown switch|usage: git merge-tree/i.test(merge.stderr)) {
        return { conflicts, ...(conflictPlans.length ? { conflictPlans } : {}), unmeasured: true };
      }
      if (merge.status !== 1) throw new Error(`git merge-tree: ${merge.stderr || merge.stdout}`);
      const parsed = parseMergeTreeConflictPaths(merge.stdout, merge.status);
      const conflictedTree = merge.stdout.split('\0', 1)[0]?.trim();
      if (!parsed.measured || !conflictedTree || !SHA.test(conflictedTree)) return {
        conflicts, ...(conflictPlans.length ? { conflictPlans } : {}), unmeasured: true,
      };
      const mergeBase = run(['merge-base', current, item.head]);
      const base = mergeBase.status === 0 ? mergeBase.stdout.trim() : '';
      const fileModes = new Map<string, string>();
      let unsupportedMode = false;
      if (base && SHA.test(base)) for (const path of parsed.paths) {
        const modes = [regularTextMode(base, path, run), regularTextMode(item.head, path, run), regularTextMode(current, path, run)];
        if (modes.some((mode) => mode === undefined) || modes.some((mode) => mode !== modes[0])) unsupportedMode = true;
        else fileModes.set(path, modes[0]!);
      }
      const snapshots = base && SHA.test(base) ? parsed.paths.flatMap((path) => {
        const read = (revision: string) => {
          const result = run(['show', `${revision}:${path}`]);
          return result.status === 0 ? result.stdout : undefined;
        };
        const baseContent = read(base);
        // `current` is main/theirs in the design contract; the candidate PR head is ours.
        const ours = read(item.head);
        const theirs = read(current);
        return baseContent === undefined || ours === undefined || theirs === undefined
          ? [] : [{ path, base: baseContent, ours, theirs }];
      }) : [];
      const complete = collectConflictAnalysis(parsed.paths, snapshots);
      const prDiff = base && SHA.test(base) ? run(['diff', '--no-ext-diff', `${base}..${item.head}`, '--', ...parsed.paths]) : undefined;
      const mainDiff = base && SHA.test(base) ? run(['diff', '--no-ext-diff', `${base}..${current}`, '--', ...parsed.paths]) : undefined;
      const prSubject = item.title ?? run(['show', '-s', '--format=%s', item.head]).stdout.trim();
      const prBody = item.body ?? run(['show', '-s', '--format=%B', item.head]).stdout.trim();
      const mainSubject = run(['show', '-s', '--format=%s', current]).stdout.trim();
      const mainBody = run(['show', '-s', '--format=%B', current]).stdout.trim();
      let repairPlan: ConflictRepairPlan = unsupportedMode
        ? { decision: 'escalate', reason: 'conflict-file-mode-unsupported' }
        : complete.verdict === 'unmeasured' || !prDiff || prDiff.status !== 0 || !mainDiff || mainDiff.status !== 0
        ? { decision: 'escalate', reason: 'conflict-analysis-unmeasured' }
        : planConflictRepair({ files: parsed.paths, analyses: snapshots, oursTitle: prSubject, theirsTitle: mainSubject, oursBody: prBody, theirsBody: mainBody, oursDiff: prDiff.stdout, theirsDiff: mainDiff.stdout });
      if (repairPlan.decision === 'automerge' && repairPlan.mergedFiles) {
        const keepsTheirs = snapshots.every((snapshot) => {
          const lines = addedLines(snapshot.base, snapshot.theirs);
          const merged = repairPlan.mergedFiles?.[snapshot.path];
          return lines !== undefined && merged !== undefined && checkTheirsLinesKept(lines, merged);
        });
        if (!keepsTheirs) repairPlan = { decision: 'escalate', reason: 'theirs-line-dropped' };
      }
      const plannedConflict: TrainConflict = { number: item.number, reason: 'conflict', files: parsed.paths, repairPlan };
      conflictPlans.push(plannedConflict);
      if (repairPlan.decision !== 'automerge' || !repairPlan.mergedFiles) {
        conflicts.push({ number: item.number, reason: 'conflict', files: parsed.paths });
        continue;
      }
      const workspace = mkdtempSync(join(tmpdir(), 'elanous-conflict-shadow-'));
      try {
        const indexPath = join(workspace, 'index');
        const env = { ...process.env, GIT_INDEX_FILE: indexPath };
        const readTree = git(['read-tree', conflictedTree], repo, env);
        if (readTree.status !== 0) return { conflicts: [...conflicts, { number: item.number, reason: 'conflict', files: parsed.paths }], conflictPlans: conflictPlans.map((entry) => entry.number === item.number ? { ...entry, repairPlan: { decision: 'escalate', reason: 'conflict-tree-unreadable' } } : entry), unmeasured: true };
        let fileIndex = 0;
        for (const [path, content] of Object.entries(repairPlan.mergedFiles)) {
          const source = join(workspace, `merged-${fileIndex++}`);
          writeFileSync(source, content);
          const blob = run(['hash-object', '-w', '--', source]);
          const oid = blob.stdout.trim();
          if (blob.status !== 0 || !SHA.test(oid)) return { conflicts: [...conflicts, { number: item.number, reason: 'conflict', files: parsed.paths }], conflictPlans: conflictPlans.map((entry) => entry.number === item.number ? { ...entry, repairPlan: { decision: 'escalate', reason: 'merged-blob-write-failed' } } : entry), unmeasured: true };
          const update = git(['update-index', '--add', '--cacheinfo', `${fileModes.get(path)},${oid},${path}`], repo, env);
          if (update.status !== 0) return { conflicts: [...conflicts, { number: item.number, reason: 'conflict', files: parsed.paths }], conflictPlans: conflictPlans.map((entry) => entry.number === item.number ? { ...entry, repairPlan: { decision: 'escalate', reason: 'merged-index-update-failed' } } : entry), unmeasured: true };
        }
        const tree = git(['write-tree'], repo, env);
        if (tree.status !== 0 || !SHA.test(tree.stdout.trim())) return { conflicts: [...conflicts, { number: item.number, reason: 'conflict', files: parsed.paths }], conflictPlans: conflictPlans.map((entry) => entry.number === item.number ? { ...entry, repairPlan: { decision: 'escalate', reason: 'merged-tree-write-failed' } } : entry), unmeasured: true };
        let integratedTree = tree.stdout.trim();
        const basePathsResult = run(['ls-tree', '-r', '--name-only', baseSha]);
        const mergedPathsResult = run(['ls-tree', '-r', '--name-only', integratedTree]);
        if (basePathsResult.status !== 0 || mergedPathsResult.status !== 0) return { conflicts: [...conflicts, { number: item.number, reason: 'conflict', files: parsed.paths }], conflictPlans: conflictPlans.map((entry) => entry.number === item.number ? { ...entry, repairPlan: { decision: 'escalate', reason: 'generated-input-inventory-unmeasured' } } : entry), unmeasured: true };
        const basePaths = new Set(basePathsResult.stdout.split('\n'));
        const mergedPaths = new Set(mergedPathsResult.stdout.split('\n'));
        if (basePaths.has(`${UX_SIM_FRAGMENTS}/metadata.json`)) {
          const simWorldFragments = simWorldDeviceFragmentPaths(basePaths);
          for (const path of [`${UX_SIM_FRAGMENTS}/metadata.json`, UX_SIM_MANUAL, SIM_WORLD_CATALOG_HISTORY,
            ...simWorldFragments, `${SIM_WORLD_DEVICE_FRAGMENTS}/metadata.json`]) {
            if (!basePaths.has(path) || !mergedPaths.has(path)) return { conflicts: [...conflicts, { number: item.number, reason: 'conflict', files: parsed.paths }], conflictPlans: conflictPlans.map((entry) => entry.number === item.number ? { ...entry, repairPlan: { decision: 'escalate', reason: `generated-input-missing:${path}` } } : entry), unmeasured: true };
          }
        }
        const conductorPaths = conductorCellFragmentPaths(basePaths);
        if (conductorPaths.length > 0) {
          for (const path of [CONDUCTOR_GENERATOR, CONDUCTOR_DOCUMENT, ...conductorPaths]) {
            if (!basePaths.has(path) || !mergedPaths.has(path)) return { conflicts: [...conflicts, { number: item.number, reason: 'conflict', files: parsed.paths }], conflictPlans: conflictPlans.map((entry) => entry.number === item.number ? { ...entry, repairPlan: { decision: 'escalate', reason: `generated-input-missing:${path}` } } : entry), unmeasured: true };
          }
        }
        const commit = run(['-c', 'user.name=elanous shadow', '-c', 'user.email=shadow@localhost', 'commit-tree', integratedTree, '-p', current, '-p', item.head, '-m', 'Integrate append-only conflict in merge train shadow']);
        if (commit.status !== 0 || !SHA.test(commit.stdout.trim())) return { conflicts: [...conflicts, { number: item.number, reason: 'conflict', files: parsed.paths }], conflictPlans: conflictPlans.map((entry) => entry.number === item.number ? { ...entry, repairPlan: { decision: 'escalate', reason: 'merged-commit-write-failed' } } : entry), unmeasured: true };
        current = commit.stdout.trim();
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
      continue;
    }
    let tree = merge.stdout.split('\0', 1)[0]?.trim();
    if (!tree || !SHA.test(tree)) throw new Error('git merge-tree did not return a tree');
    const basePathsResult = run(['ls-tree', '-r', '--name-only', baseSha]);
    const mergedPathsResult = run(['ls-tree', '-r', '--name-only', tree]);
    if (basePathsResult.status !== 0 || mergedPathsResult.status !== 0) {
      throw new Error(`cannot inspect UX simulation integration trees: ${basePathsResult.stderr || mergedPathsResult.stderr}`);
    }
    const basePaths = new Set(basePathsResult.stdout.split('\n'));
    const mergedPaths = new Set(mergedPathsResult.stdout.split('\n'));
    const baseHasFragments = basePaths.has(`${UX_SIM_FRAGMENTS}/metadata.json`);
    const mergedHasFragments = mergedPaths.has(`${UX_SIM_FRAGMENTS}/metadata.json`);
    if (baseHasFragments && !mergedHasFragments) throw new Error('merged UX simulation fragments were removed');
    if (baseHasFragments) {
      const simWorldFragments = simWorldDeviceFragmentPaths(basePaths);
      for (const path of [`${UX_SIM_FRAGMENTS}/metadata.json`, UX_SIM_MANUAL, SIM_WORLD_CATALOG_HISTORY,
        `${SIM_WORLD_DEVICE_FRAGMENTS}/metadata.json`, ...simWorldFragments]) {
        if (!basePaths.has(path) || !mergedPaths.has(path)) throw new Error(`UX simulation generation input missing from train tree: ${path}`);
      }
    }
    const baseConductorPaths = conductorCellFragmentPaths(basePaths);
    const mergedConductorPaths = conductorCellFragmentPaths(mergedPaths);
    if (baseConductorPaths.length > 0 && mergedConductorPaths.length === 0) throw new Error('merged conductor cell fragments were removed');
    if (baseConductorPaths.length > 0) {
      for (const path of [CONDUCTOR_GENERATOR, CONDUCTOR_DOCUMENT, ...baseConductorPaths]) {
        if (!basePaths.has(path) || !mergedPaths.has(path)) throw new Error(`conductor cell-map generation input missing from train tree: ${path}`);
      }
    }
    const commit = run(['-c', 'user.name=elanous shadow', '-c', 'user.email=shadow@localhost', 'commit-tree', tree, '-p', current, '-p', item.head, '-m', 'Integrate PR for merge train shadow evaluation']);
    if (commit.status !== 0 || !SHA.test(commit.stdout.trim())) throw new Error(`git commit-tree: ${commit.stderr || commit.stdout}`);
    current = commit.stdout.trim();
  }
  const integratedTree = run(['rev-parse', `${current}^{tree}`]);
  if (integratedTree.status !== 0 || !SHA.test(integratedTree.stdout.trim())) {
    throw new Error(`cannot inspect final integrated train tree: ${integratedTree.stderr || integratedTree.stdout}`);
  }
  const initialPaths = run(['ls-tree', '-r', '--name-only', baseSha]);
  const finalPaths = run(['ls-tree', '-r', '--name-only', integratedTree.stdout.trim()]);
  if (initialPaths.status !== 0 || finalPaths.status !== 0) throw new Error('cannot inspect final generated-output inventory');
  const initialPathSet = new Set(initialPaths.stdout.split('\n'));
  const finalPathSet = new Set(finalPaths.stdout.split('\n'));
  let finalOutputTree = integratedTree.stdout.trim();
  if (initialPathSet.has(`${UX_SIM_FRAGMENTS}/metadata.json`)) {
    const simWorldFragments = simWorldDeviceFragmentPaths(initialPathSet);
    for (const path of [`${UX_SIM_FRAGMENTS}/metadata.json`, UX_SIM_MANUAL, SIM_WORLD_CATALOG_HISTORY,
      `${SIM_WORLD_DEVICE_FRAGMENTS}/metadata.json`, ...simWorldFragments]) {
      if (!initialPathSet.has(path) || !finalPathSet.has(path)) throw new Error(`UX simulation generation input missing from final train tree: ${path}`);
    }
    const regeneratedTree = regenerateUxSimArtifacts(repo, baseSha, current, finalOutputTree, (args, env) => git(args, repo, env));
    if (regeneratedTree !== finalOutputTree) {
      const commit = run(['-c', 'user.name=elanous shadow', '-c', 'user.email=shadow@localhost', 'commit-tree', regeneratedTree, '-p', current, '-m', 'Regenerate generated outputs after merge train integration']);
      if (commit.status !== 0 || !SHA.test(commit.stdout.trim())) throw new Error(`generated-output commit: ${commit.stderr || commit.stdout}`);
      current = commit.stdout.trim();
      finalOutputTree = regeneratedTree;
    }
  }
  const initialConductorPaths = conductorCellFragmentPaths(initialPathSet);
  if (initialConductorPaths.length > 0) {
    for (const path of [CONDUCTOR_GENERATOR, CONDUCTOR_DOCUMENT, ...initialConductorPaths]) {
      if (!initialPathSet.has(path) || !finalPathSet.has(path)) throw new Error(`conductor cell-map generation input missing from final train tree: ${path}`);
    }
    const regeneratedTree = regenerateConductorCellMap(repo, baseSha, finalOutputTree, (args, env) => git(args, repo, env));
    if (regeneratedTree !== finalOutputTree) {
      const commit = run(['-c', 'user.name=elanous shadow', '-c', 'user.email=shadow@localhost', 'commit-tree', regeneratedTree, '-p', current, '-m', 'Regenerate conductor cell map after merge train integration']);
      if (commit.status !== 0 || !SHA.test(commit.stdout.trim())) throw new Error(`conductor cell-map output commit: ${commit.stderr || commit.stdout}`);
      current = commit.stdout.trim();
    }
  }
  return { commitSha: current, conflicts, ...(conflictPlans.length ? { conflictPlans } : {}) };
}

export async function runTrain(batch: readonly TrainCandidate[], deps: {
  integrate: (batch: readonly TrainCandidate[]) => TrainIntegration | Promise<TrainIntegration>;
  gate: (commitSha: string, prNumbers: number[]) => 'pass' | 'fail' | 'unmeasured' | Promise<'pass' | 'fail' | 'unmeasured'>;
  deferred?: TrainDeferred[];
  observe?: (data: TrainObservation) => void | Promise<void>;
  tangledPairs?: readonly TangledPair[];
  classifyCulprit?: (pr: number) => RepairPlan;
  onCulpritPlans?: (plans: { pr: number; plan: RepairPlan | { action: 'reorder'; with: number } }[]) => void | Promise<void>;
  /** Optional adapter hook; progressId must be stable when progress events are enabled. */
  progressId?: string;
  emitProgress?: (event: TrainProgressEvent) => void | Promise<void>;
}): Promise<{ verdicts: TrainVerdict[]; gatesRun: number; integrations: number }> {
  if (deps.emitProgress && !deps.progressId?.trim()) throw new Error('runTrain progressId is required when emitProgress is configured');
  if (deps.emitProgress) await deps.emitProgress({ eventId: `${deps.progressId}:batch`, type: 'merge-train.batch',
    batch: batch.map(({ number, head }) => ({ number, head })) });
  const verdicts = new Map<number, TrainVerdict['verdict']>();
  let gatesRun = 0;
  let integrations = 0;
  let stopped = false;
  const conflictPlans: TrainConflictPlanSummary[] = [];
  const summarizeConflictPlans = (plans: readonly TrainConflict[]): TrainConflictPlanSummary[] => plans.map((plan) => ({
    number: plan.number,
    files: [...plan.files],
    decision: plan.repairPlan?.decision ?? 'unmeasured',
    reason: plan.repairPlan?.reason ?? 'conflict-analysis-unmeasured',
    ...(plan.repairPlan?.goal ? { goal: plan.repairPlan.goal } : {}),
  }));
  async function evaluate(group: readonly TrainCandidate[]): Promise<void> {
    if (!group.length || stopped) return;
    integrations++;
    const integration = await deps.integrate(group);
    if (integration.unmeasured || !integration.commitSha) {
      conflictPlans.push(...summarizeConflictPlans(integration.conflictPlans ?? []));
      stopped = true;
      return;
    }
    conflictPlans.push(...summarizeConflictPlans(integration.conflictPlans ?? []));
    for (const conflict of integration.conflicts) {
      if (group.some((item) => item.number === conflict.number)) verdicts.set(conflict.number, 'conflict');
    }
    const remaining = group.filter((item) => !verdicts.has(item.number));
    if (!remaining.length) return;
    gatesRun++;
    const result = await deps.gate(integration.commitSha, remaining.map((item) => item.number));
    if (result === 'unmeasured') {
      stopped = true;
    } else if (result === 'pass' || remaining.length === 1) {
      for (const item of remaining) verdicts.set(item.number, result);
    } else {
      const middle = Math.floor(remaining.length / 2);
      await evaluate(remaining.slice(0, middle));
      await evaluate(remaining.slice(middle));
      // Neither half reproduces the failed combination: the combined train remains unresolved.
      if (!stopped && remaining.every((item) => verdicts.get(item.number) === 'pass')) {
        for (const item of remaining) verdicts.set(item.number, 'unmeasured');
      }
    }
  }
  await evaluate(batch);
  const ordered = batch.map((item): TrainVerdict => ({ number: item.number, verdict: verdicts.get(item.number) ?? 'unmeasured' }));
  const passed = ordered.filter((item) => item.verdict === 'pass').map((item) => item.number);
  const data: TrainObservation = {
    batch: batch.map((item) => item.number), deferred: deps.deferred ?? null, gatesRun,
    passed, culprits: ordered.filter((item) => item.verdict === 'fail' || item.verdict === 'conflict').map((item) => item.number),
    unmeasured: ordered.filter((item) => item.verdict === 'unmeasured').map((item) => item.number),
    gatesPerLanding: gatesRun / Math.max(passed.length, 1),
    ...(conflictPlans.length ? { conflictPlans } : {}),
  };
  await (deps.observe ?? ((entry: TrainObservation) => {
    const store = getDefaultLogStore();
    if (!store) throw new Error('merge-queue observation store unavailable');
    store.insertBatch([{ rec: { ts: new Date().toISOString(), category: 'merge-queue', event: 'train-verdict', data: entry }, surface: 'merge-queue' }]);
  }))(data);
  const culpritPlans = planCulpritDriftRepair(data, deps.tangledPairs ?? [], deps.classifyCulprit ?? (() => ({ action: 'skip', reason: 'drift repair classifier unavailable' })));
  await deps.onCulpritPlans?.(culpritPlans);
  await deps.emitProgress?.({ eventId: `${deps.progressId}:verdict`, type: 'merge-train.verdict', observation: data, verdicts: ordered });
  return { verdicts: ordered, gatesRun, integrations };
}
