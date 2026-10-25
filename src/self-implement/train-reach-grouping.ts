import { spawnSync } from 'node:child_process';
import { SPAWN_SYNC_MAX_BUFFER } from '../util/spawn-sync-output.js';
import { isAbsolute } from 'node:path';
import { selectGateTestFiles } from './gate-cli.js';
import { defineTrainGrouping } from '../../scripts/release-loop/gate-closure.js';

export interface TrainReachCandidate {
  pr: string;
  headSha: string;
  tree: string;
  changedFiles: string[];
}

export interface TrainReachInput {
  version: 1;
  baseSha: string;
  queueSig: string;
  prs: TrainReachCandidate[];
}

export interface TrainReachObservation {
  changedFiles: readonly string[];
  testFiles: readonly string[];
  unverified: readonly string[];
  unrunImporterTotal: number | null;
  lookupFailed?: string;
  routeLookupFailures: readonly { source: string; reason: string }[];
  callerTestsOverflow: readonly { file: string }[];
  alwaysIncludeMissing: readonly string[];
}

export interface TrainReachGroup {
  prs: string[];
  reachTests: string[];
  interactionTests: string[];
  overlapEdges: Array<{ a: string; b: string; tests: string[]; paths: string[] }>;
  status: 'measured' | 'unmeasured';
  capacityBlocked: boolean;
  reasons: string[];
}

export interface TrainReachDecision {
  version: 1;
  baseSha: string;
  queueSig: string;
  parallelSafe: boolean;
  groups: TrainReachGroup[];
  deferred: Array<{ pr: string; reason: string }>;
}

type InspectCandidate = (candidate: TrainReachCandidate, baseSha: string) => TrainReachObservation;

const SHA40 = /^[a-f0-9]{40}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const safePath = (path: string) => path.length > 0 && !path.startsWith('/')
  && !path.includes('\\') && !/[\x00-\x1f\x7f]/.test(path)
  && !path.split('/').some((part) => part === '..' || part === '.');
const sortedUnique = (values: readonly string[]) => [...new Set(values)].sort();

function git(tree: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: tree, encoding: 'utf8', timeout: 15_000, maxBuffer: SPAWN_SYNC_MAX_BUFFER });
  if (result.status !== 0 || result.error) {
    throw new Error(`git ${args[0]} unmeasured: ${result.error?.message ?? result.stderr?.trim() ?? `rc=${result.status}`}`);
  }
  return result.stdout.trim();
}

/** The selector's own base...HEAD comparison is independently checked against the queue snapshot. */
function inspectTrainReachCandidate(candidate: TrainReachCandidate, baseSha: string): TrainReachObservation {
  if (git(candidate.tree, 'rev-parse', 'HEAD').toLowerCase() !== candidate.headSha.toLowerCase()) {
    throw new Error('tree HEAD differs from queued headSha');
  }
  if (git(candidate.tree, 'status', '--porcelain=v1')) throw new Error('tree is dirty');
  git(candidate.tree, 'cat-file', '-e', `${baseSha}^{commit}`);
  const observation = selectGateTestFiles(candidate.tree, { base: baseSha, includeImporterTests: true });
  if (git(candidate.tree, 'rev-parse', 'HEAD').toLowerCase() !== candidate.headSha.toLowerCase()) {
    throw new Error('tree HEAD changed during reach selection');
  }
  if (git(candidate.tree, 'status', '--porcelain=v1')) throw new Error('tree changed during reach selection');
  return observation;
}

function validateInput(input: TrainReachInput): void {
  if (input?.version !== 1 || !SHA40.test(input.baseSha) || !SHA256.test(input.queueSig) || !Array.isArray(input.prs)) {
    throw new Error('train reach input identity unmeasured');
  }
  const seen = new Set<string>();
  for (const candidate of input.prs) {
    if (!/^[1-9]\d*$/.test(candidate?.pr) || seen.has(candidate.pr) || !SHA40.test(candidate.headSha)
      || !isAbsolute(candidate.tree) || !Array.isArray(candidate.changedFiles) || candidate.changedFiles.length === 0
      || !candidate.changedFiles.every((path) => typeof path === 'string' && safePath(path))) {
      throw new Error(`train reach candidate invalid: ${candidate?.pr ?? 'unknown'}`);
    }
    seen.add(candidate.pr);
  }
}

/** Pure grouping after one independently measured selector observation per queued PR. */
export function buildTrainReachDecision(input: TrainReachInput, inspect: InspectCandidate = inspectTrainReachCandidate): TrainReachDecision {
  validateInput(input);
  const measured: Array<{ candidate: TrainReachCandidate; tests: string[]; files: string[] }> = [];
  const deferred: TrainReachDecision['deferred'] = [];
  for (const candidate of input.prs) {
    try {
      const observed = inspect(candidate, input.baseSha);
      const actual = sortedUnique(observed.changedFiles);
      const expected = sortedUnique(candidate.changedFiles);
      if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
        throw new Error('changedFiles differ from selector observation');
      }
      if (observed.lookupFailed || observed.routeLookupFailures.length || observed.unrunImporterTotal !== 0
        || observed.callerTestsOverflow.length || observed.alwaysIncludeMissing.length || observed.unverified.length) {
        throw new Error('test selection has unmeasured reach');
      }
      if (!observed.testFiles.every(safePath)) throw new Error('selected test path invalid');
      measured.push({ candidate, tests: sortedUnique(observed.testFiles), files: sortedUnique(observed.changedFiles) });
    } catch (error) {
      deferred.push({ pr: candidate.pr, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  const parent = measured.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) index = parent[index] = parent[parent[index]];
    return index;
  };
  const edges: Array<{ left: number; right: number; tests: string[]; paths: string[] }> = [];
  for (let left = 0; left < measured.length; left++) {
    for (let right = left + 1; right < measured.length; right++) {
      // 도달 시험 집합의 교집합이 «같은 열차»를 정한다 — TRAIN-REACH-GROUPING 원장(gate-closure.ts).
      const grouping = defineTrainGrouping(
        { pr: measured[left].candidate.pr, tests: measured[left].tests },
        { pr: measured[right].candidate.pr, tests: measured[right].tests },
      );
      const tests = [...grouping.intersection];
      const paths = measured[left].files.filter((path) => measured[right].files.includes(path));
      if (!grouping.sameTrain && !paths.length) continue;
      edges.push({ left, right, tests, paths });
      parent[find(right)] = find(left);
    }
  }
  const components = new Map<number, number[]>();
  for (let index = 0; index < measured.length; index++) {
    const root = find(index);
    components.set(root, [...(components.get(root) ?? []), index]);
  }
  const groups = [...components.values()].map((indices): TrainReachGroup => {
    const prs = indices.map((index) => measured[index].candidate.pr);
    const counts = new Map<string, number>();
    for (const index of indices) for (const test of measured[index].tests) counts.set(test, (counts.get(test) ?? 0) + 1);
    const reachTests = sortedUnique([...counts.keys()]);
    const interactionTests = reachTests.filter((test) => (counts.get(test) ?? 0) > 1);
    const overlapEdges = edges.filter(({ left, right }) => indices.includes(left) && indices.includes(right))
      .map(({ left, right, tests, paths }) => ({ a: measured[left].candidate.pr, b: measured[right].candidate.pr, tests, paths }));
    const capacityBlocked = indices.length > 5;
    const reasons = capacityBlocked ? ['connected reach group exceeds five PR train limit'] : [];
    return { prs, reachTests, interactionTests, overlapEdges,
      status: 'measured', capacityBlocked, reasons };
  });
  return { version: 1, baseSha: input.baseSha, queueSig: input.queueSig,
    parallelSafe: deferred.length === 0 && groups.every(({ status, capacityBlocked }) => status === 'measured' && !capacityBlocked),
    groups, deferred };
}
