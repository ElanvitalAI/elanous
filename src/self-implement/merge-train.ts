import { spawnSync } from 'node:child_process';
import { getDefaultLogStore } from '../mss/logging/log-store.js';

export type TrainCandidate = { number: number; head: string; files?: string[]; filesUnmeasured?: boolean };
export type TrainDeferred = { number: number; reason: 'overlap' | 'files-unknown'; with?: number[] };
export type TrainConflict = { number: number; reason: 'conflict'; files: string[] };
export type TrainIntegration = { commitSha?: string; conflicts: TrainConflict[]; unmeasured?: boolean };
export type TrainVerdict = { number: number; verdict: 'pass' | 'fail' | 'conflict' | 'unmeasured' };
export type TrainObservation = {
  batch: number[];
  deferred: TrainDeferred[] | null;
  gatesRun: number;
  passed: number[];
  culprits: number[];
  unmeasured: number[];
  gatesPerLanding: number;
};
export type TrainGit = (args: readonly string[], repo: string) => { status: number | null; stdout: string; stderr: string };

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

const defaultGit: TrainGit = (args, repo) => {
  const result = spawnSync('git', [...args], { cwd: repo, encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: (result.stderr ?? '') + (result.error?.message ?? '') };
};
const SHA = /^[0-9a-f]{40,64}$/i;

/** Create unreachable synthetic merge commits only; never update refs or check out a tree. */
export function integrateTrain(repo: string, baseSha: string, batch: readonly TrainCandidate[], git: TrainGit = defaultGit): TrainIntegration {
  if (!SHA.test(baseSha) || batch.some((item) => !SHA.test(item.head))) throw new Error('invalid pinned commit SHA');
  let current = baseSha;
  const conflicts: TrainConflict[] = [];
  const run = (args: string[]) => git(args, repo);
  for (const item of batch) {
    const merge = run(['merge-tree', '--write-tree', '--name-only', '-z', current, item.head]);
    if (merge.status !== 0) {
      if (/unknown option|unrecognized option|unrecognized argument|invalid option|unknown switch|usage: git merge-tree/i.test(merge.stderr)) {
        return { conflicts, unmeasured: true };
      }
      if (merge.status !== 1) throw new Error(`git merge-tree: ${merge.stderr || merge.stdout}`);
      // -z --name-only: tree OID, conflicted paths, empty separator, informational messages.
      const parts = merge.stdout.split('\0');
      if (!SHA.test(parts[0] ?? '') || !parts.includes('')) throw new Error(`git merge-tree conflict output unavailable: ${merge.stderr}`);
      const files = parts.slice(1, parts.indexOf('')).filter(Boolean);
      if (!files.length) throw new Error(`git merge-tree failed without conflict paths: ${merge.stderr}`);
      conflicts.push({ number: item.number, reason: 'conflict', files });
      continue;
    }
    const tree = merge.stdout.split('\0', 1)[0]?.trim();
    if (!tree || !SHA.test(tree)) throw new Error('git merge-tree did not return a tree');
    const commit = run(['-c', 'user.name=elanous shadow', '-c', 'user.email=shadow@localhost', 'commit-tree', tree, '-p', current, '-p', item.head, '-m', 'Integrate PR for merge train shadow evaluation']);
    if (commit.status !== 0 || !SHA.test(commit.stdout.trim())) throw new Error(`git commit-tree: ${commit.stderr || commit.stdout}`);
    current = commit.stdout.trim();
  }
  return { commitSha: current, conflicts };
}

export async function runTrain(batch: readonly TrainCandidate[], deps: {
  integrate: (batch: readonly TrainCandidate[]) => TrainIntegration | Promise<TrainIntegration>;
  gate: (commitSha: string, prNumbers: number[]) => 'pass' | 'fail' | 'unmeasured' | Promise<'pass' | 'fail' | 'unmeasured'>;
  deferred?: TrainDeferred[];
  observe?: (data: TrainObservation) => void | Promise<void>;
}): Promise<{ verdicts: TrainVerdict[]; gatesRun: number; integrations: number }> {
  const verdicts = new Map<number, TrainVerdict['verdict']>();
  let gatesRun = 0;
  let integrations = 0;
  let stopped = false;
  async function evaluate(group: readonly TrainCandidate[]): Promise<void> {
    if (!group.length || stopped) return;
    integrations++;
    const integration = await deps.integrate(group);
    if (integration.unmeasured || !integration.commitSha) {
      stopped = true;
      return;
    }
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
  };
  await (deps.observe ?? ((entry: TrainObservation) => {
    const store = getDefaultLogStore();
    if (!store) throw new Error('merge-queue observation store unavailable');
    store.insertBatch([{ rec: { ts: new Date().toISOString(), category: 'merge-queue', event: 'train-verdict', data: entry }, surface: 'merge-queue' }]);
  }))(data);
  return { verdicts: ordered, gatesRun, integrations };
}
