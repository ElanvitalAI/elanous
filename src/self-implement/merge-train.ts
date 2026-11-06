import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getDefaultLogStore } from '../mss/logging/log-store.js';
import { planCulpritDriftRepair, type RepairPlan } from '../cli/pr-land-drift-repair.js';
import { addedLines, checkTheirsLinesKept, collectConflictAnalysis, parseMergeTreeConflictPaths, planConflictRepair, type ConflictRepairPlan } from '../cli/pr-land-conflict-merge.js';

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
const UX_SIM_CATALOG = 'src/ux-sim/mock-scenario-catalog.json';
const UX_SIM_GENERATOR = 'scripts/generate-ux-sim-device-manual.ts';
const UX_SIM_MODULE = 'src/ux-sim/mock-scenario-catalog.ts';
const UX_SIM_MANUAL = 'docs/manual/MANUAL-ux-simulation-devices-2026-08-23.md';

/** Run the base-pinned real generator against merged data without checking out or changing a ref. */
function regenerateUxSimManual(repo: string, baseSha: string, tree: string, run: (args: string[], env?: NodeJS.ProcessEnv) => ReturnType<TrainGit>): string {
  const workspace = mkdtempSync(join(tmpdir(), 'elanous-ux-sim-train-'));
  const indexPath = join(workspace, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  const readTreeFile = (path: string, revision = tree) => {
    const result = run(['show', `${revision}:${path}`]);
    if (result.status !== 0) throw new Error(`merged tree is missing ${path}: ${result.stderr || result.stdout}`);
    return result.stdout;
  };
  try {
    for (const file of [UX_SIM_GENERATOR, UX_SIM_MODULE, UX_SIM_CATALOG, UX_SIM_MANUAL]) {
      const destination = join(workspace, file);
      mkdirSync(join(destination, '..'), { recursive: true });
      // Execute only the generator and renderer module from the pinned base. PR-controlled
      // catalog JSON and manual text are data inputs, never executable code.
      writeFileSync(destination, readTreeFile(file, file === UX_SIM_GENERATOR || file === UX_SIM_MODULE ? baseSha : tree));
    }
    // A PR may change generator code. The train deliberately runs the trusted base version;
    // generator changes are exercised by that PR's tests and become the trusted version after landing.
    const generatorOptions: SpawnSyncOptionsWithStringEncoding = {
      cwd: workspace,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: workspace, TMPDIR: workspace, NODE_ENV: 'production' },
      encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    };
    const generator = spawnSync('bun', [UX_SIM_GENERATOR], generatorOptions);
    if (generator.status !== 0) throw new Error(`UX simulation manual generator failed: ${generator.stderr || generator.stdout || generator.error?.message}`);

    const generatedManual = join(workspace, UX_SIM_MANUAL);
    const blob = run(['hash-object', '-w', '--', generatedManual]);
    if (blob.status !== 0 || !SHA.test(blob.stdout.trim())) throw new Error(`git hash-object: ${blob.stderr || blob.stdout}`);
    const readIndex = run(['read-tree', tree], env);
    if (readIndex.status !== 0) throw new Error(`git read-tree: ${readIndex.stderr || readIndex.stdout}`);
    const update = run(['update-index', '--add', '--cacheinfo', `100644,${blob.stdout.trim()},${UX_SIM_MANUAL}`], env);
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
    '-c', `merge.uxsim-catalog.driver=node \"${driver}\" catalog \"%O\" \"%A\" \"%B\"`,
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
        if (basePaths.has(UX_SIM_CATALOG)) {
          for (const path of [UX_SIM_GENERATOR, UX_SIM_MODULE, UX_SIM_CATALOG, UX_SIM_MANUAL]) {
            if (!basePaths.has(path) || !mergedPaths.has(path)) return { conflicts: [...conflicts, { number: item.number, reason: 'conflict', files: parsed.paths }], conflictPlans: conflictPlans.map((entry) => entry.number === item.number ? { ...entry, repairPlan: { decision: 'escalate', reason: `generated-input-missing:${path}` } } : entry), unmeasured: true };
          }
          integratedTree = regenerateUxSimManual(repo, baseSha, integratedTree, (args, generatorEnv) => git(args, repo, generatorEnv));
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
    const baseHasCatalog = basePaths.has(UX_SIM_CATALOG);
    const mergedHasCatalog = mergedPaths.has(UX_SIM_CATALOG);
    if (baseHasCatalog && !mergedHasCatalog) throw new Error('merged UX simulation catalog was removed');
    if (!baseHasCatalog && mergedHasCatalog) throw new Error('UX simulation catalog requires a trusted generator in the train base');
    if (baseHasCatalog) {
      for (const path of [UX_SIM_GENERATOR, UX_SIM_MODULE, UX_SIM_MANUAL]) {
        if (!basePaths.has(path) || !mergedPaths.has(path)) throw new Error(`UX simulation generation input missing from train tree: ${path}`);
      }
      tree = regenerateUxSimManual(repo, baseSha, tree, (args, env) => git(args, repo, env));
    }
    const commit = run(['-c', 'user.name=elanous shadow', '-c', 'user.email=shadow@localhost', 'commit-tree', tree, '-p', current, '-p', item.head, '-m', 'Integrate PR for merge train shadow evaluation']);
    if (commit.status !== 0 || !SHA.test(commit.stdout.trim())) throw new Error(`git commit-tree: ${commit.stderr || commit.stdout}`);
    current = commit.stdout.trim();
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
}): Promise<{ verdicts: TrainVerdict[]; gatesRun: number; integrations: number }> {
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
  return { verdicts: ordered, gatesRun, integrations };
}
