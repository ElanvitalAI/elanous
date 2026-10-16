import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isGateSpawnLaneFile } from '../self-dev/spawn-lane-files.js';
import { isTestPath } from './importer-test-index.js';
import type { TrainReachDecision, TrainReachInput } from './train-reach-grouping.js';

export interface TrainRiskEvidence {
  /** Only evidence-backed paths; an empty list asserts no known hot paths for this queue. */
  verifiedHotFiles: Array<{ path: string; evidence: string }>;
  /** Both endpoints are test paths; evidence must describe a reproduced interaction. */
  verifiedInterferencePairs: Array<{ a: string; b: string; evidence: string }>;
  /** Unreproduced pairs remain visible and prohibit parallel apply when either endpoint is reached. */
  suspectedPairs: Array<{ a: string; b: string; reason: string }>;
}

export interface TrainScenarioGroup {
  prs: string[];
  reachTests: string[];
  interactionTests: string[];
  riskTests: string[];
  riskReasons: Array<{ test: string; reason: string; evidence: string }>;
  groupRiskReasons: Array<{ reason: string; evidence: string }>;
  canaryTests: string[];
  scenarioTests: string[];
  populationSize: number;
  eligiblePopulationSize: number;
  canaryTarget: number;
  /** Reproducible SHA-256 input prefix: baseSha, queueSig, and sorted PRs separated by NUL. */
  canarySelectionKey: string;
  canaryHashMethod: string;
  unmeasured: string[];
}

export interface TrainScenarioDecision {
  version: 1;
  baseSha: string;
  queueSig: string;
  parallelSafe: boolean;
  groups: TrainScenarioGroup[];
  unmeasured: string[];
}

const sorted = (paths: readonly string[]) => [...new Set(paths)].sort();
const validPath = (path: unknown): path is string => typeof path === 'string' && !!path && !path.startsWith('/') && !path.includes('\\')
  && !/[\x00-\x1f\x7f]/.test(path) && !path.split('/').some((part) => part === '.' || part === '..');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Read the tracked test population from the pinned base commit, including paths containing spaces. */
export function readTrainTestPopulation(tree: string, baseSha: string): string[] {
  if (!/^[a-f0-9]{40}$/i.test(baseSha)) throw new Error('invalid baseSha for test population');
  const result = spawnSync('git', ['ls-tree', '-r', '-z', '--name-only', baseSha],
    { cwd: tree, encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`test population unmeasured: ${result.error?.message ?? result.stderr?.trim() ?? result.status}`);
  return sorted(result.stdout.split('\0').filter(isTestPath));
}

/** Pure scenario composition. No unverified hot path or interference guess is promoted to a verified risk. */
export function buildTrainScenarioDecision(
  input: TrainReachInput, reach: TrainReachDecision, population: readonly string[], evidence: TrainRiskEvidence,
): TrainScenarioDecision {
  if (reach.version !== 1 || reach.baseSha !== input.baseSha || reach.queueSig !== input.queueSig
    || !Array.isArray(population) || !population.every((path) => typeof path === 'string' && validPath(path) && isTestPath(path))
    || !evidence || !Array.isArray(evidence.verifiedHotFiles) || !Array.isArray(evidence.verifiedInterferencePairs)
    || !Array.isArray(evidence.suspectedPairs)) throw new Error('scenario identity or population unmeasured');
  const tests = sorted(population);
  const commonTests = new Set(tests);
  const known = new Set([...tests, ...reach.groups.flatMap((group) => group.reachTests)]);
  const validEvidence = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  for (const item of evidence.verifiedHotFiles) {
    if (!validPath(item?.path) || !validEvidence(item?.evidence)) throw new Error('hot-file evidence unmeasured');
  }
  for (const item of [...evidence.verifiedInterferencePairs, ...evidence.suspectedPairs]) {
    if (!validPath(item?.a) || !validPath(item?.b) || !known.has(item.a) || !known.has(item.b)
      || item.a === item.b || !validEvidence(item && 'evidence' in item ? item.evidence : item?.reason)) {
      throw new Error('interference-pair evidence unmeasured');
    }
  }
  const changedByPr = new Map(input.prs.map(({ pr, changedFiles }) => [pr, changedFiles]));
  const groups = reach.groups.map((group): TrainScenarioGroup => {
    const reached = new Set(group.reachTests);
    if ([...reached].some((path) => !validPath(path) || !isTestPath(path))) throw new Error('reached test path invalid');
    const riskReasons: TrainScenarioGroup['riskReasons'] = [];
    const groupRiskReasons: TrainScenarioGroup['groupRiskReasons'] = [];
    const unavailable: string[] = [];
    const risk = new Set<string>();
    const addRisk = (test: string, reason: string, source: string): void => {
      risk.add(test);
      riskReasons.push({ test, reason, evidence: source });
    };
    for (const test of reached) if (isGateSpawnLaneFile(test)) addRisk(test, 'spawn-lane', 'src/self-dev/spawn-lane-files.ts');
    const changed = new Set(group.prs.flatMap((pr) => changedByPr.get(pr) ?? []));
    for (const hot of evidence.verifiedHotFiles) if (changed.has(hot.path)) {
      groupRiskReasons.push({ reason: `hot-file:${hot.path}`, evidence: hot.evidence });
    }
    for (const pair of evidence.verifiedInterferencePairs) {
      if (reached.has(pair.a) || reached.has(pair.b)) {
        const endpoints: Array<[string, string]> = [[pair.a, pair.b], [pair.b, pair.a]];
        for (const [test, other] of endpoints) {
          if (reached.has(test) || commonTests.has(test)) addRisk(test, `interference-with:${other}`, pair.evidence);
          else unavailable.push(`verified interference endpoint unavailable in every PR head: ${test}`);
        }
      }
    }
    const canaryPrefix = `${input.baseSha}\0${input.queueSig}\0${sorted(group.prs).join(',')}`;
    const used = new Set([...reached, ...risk]);
    const eligible = tests.filter((test) => !used.has(test));
    const canaryTarget = eligible.length ? Math.max(1, Math.round(eligible.length * 0.02)) : 0;
    const canaryTests = eligible
      .sort((a, b) => hash(`${canaryPrefix}\0${a}`).localeCompare(hash(`${canaryPrefix}\0${b}`)) || a.localeCompare(b))
      .slice(0, canaryTarget).sort();
    const scenarioTests = sorted([...reached, ...risk, ...canaryTests]);
    const scenarioSet = new Set(scenarioTests);
    const unmeasured = [...unavailable, ...evidence.suspectedPairs
      .filter((pair) => scenarioSet.has(pair.a) || scenarioSet.has(pair.b))
      .map((pair) => `suspected interference ${pair.a} ↔ ${pair.b}: ${pair.reason}`)];
    return { prs: group.prs, reachTests: group.reachTests, interactionTests: group.interactionTests,
      riskTests: sorted([...risk]), riskReasons, groupRiskReasons, canaryTests,
      scenarioTests, populationSize: tests.length, eligiblePopulationSize: eligible.length,
      canaryTarget, canarySelectionKey: canaryPrefix,
      canaryHashMethod: 'sha256(canarySelectionKey\\0path)', unmeasured };
  });
  const unmeasured = groups.flatMap((group) => group.unmeasured);
  // A verified interference pair executed by multiple scenarios bars parallel trains, including canary selection.
  for (const pair of evidence.verifiedInterferencePairs) {
    const aOwners = groups.flatMap((group, index) => group.scenarioTests.includes(pair.a) ? [index] : []);
    const bOwners = groups.flatMap((group, index) => group.scenarioTests.includes(pair.b) ? [index] : []);
    if (aOwners.some((a) => bOwners.some((b) => a !== b))) {
      unmeasured.push(`verified interference crosses groups ${pair.a} ↔ ${pair.b}: ${pair.evidence}`);
    }
  }
  return { version: 1, baseSha: input.baseSha, queueSig: input.queueSig,
    parallelSafe: reach.parallelSafe && unmeasured.length === 0, groups, unmeasured };
}
