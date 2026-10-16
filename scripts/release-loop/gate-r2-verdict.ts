#!/usr/bin/env bun
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { parseXml, type XmlElement } from '../../src/self-dev/shard-aggregate.js';

export type GateR2Verdict = 'introduced' | 'preexisting' | 'interference-candidate' | 'environment-failure' | 'unmeasured';
export type GateR2Identity = 'exact' | 'renamed-existing-candidate' | 'identity-unmeasured';

export interface GateR2Run {
  runId: string;
  head40: string;
  envKey: string;
  cohort: string[];
  rc: number;
  junitPath: string;
  resultPath: string;
}
export interface GateR2Input {
  stableTestId: string;
  head40: string;
  base40: string;
  envKey: string;
  shards: number;
  cohort: string[];
  batch: GateR2Run;
  solo: GateR2Run;
  baseline: GateR2Run;
  /** Evidence only: an equal source digest proposes a rename; it never auto-waives a failure. */
  renameCandidate?: { oldTestId: string; oldDigest: string; newDigest: string; unique: boolean };
  /** Two independent Pod status artifacts; an arbitrary matching log line is not infrastructure proof. */
  environmentProof?: { signature: string; batchStatusPath: string; baselineStatusPath: string };
}
export interface GateR2Result {
  verdict: GateR2Verdict;
  identityStatus: GateR2Identity;
  stableTestId: string;
  evidence: { head40: string; base40: string; envKey: string; shards: number; cohort: string[];
    batchResultPath: string; soloResultPath: string; baselineResultPath: string; reason: string };
}

type Cases = Map<string, 'pass' | 'fail' | 'error' | 'skipped'>;
const sha40 = /^[a-f0-9]{40}$/i;
const testFile = (id: string) => id.split(' > ')[0]?.replace(/^\.\//, '') ?? '';
/** Read complete Bun JUnit identities; malformed structure or duplicate IDs are unmeasured. */
export function gateR2JunitCases(xml: string): Cases | null {
  const root = parseXml(xml);
  if (root?.name !== 'testsuites' || !root.children.length) return null;
  const cases: Cases = new Map();
  let invalid = false;
  const countMatches = (declared: string | undefined, actual: number) => declared === undefined
    || (/^(0|[1-9]\d*)$/.test(declared) && Number(declared) === actual);
  const walkSuite = (suite: XmlElement, parentFile: string | undefined, names: string[]): number => {
    if (suite.name !== 'testsuite') { invalid = true; return 0; }
    const file = suite.attrs.file ?? parentFile ?? suite.attrs.name;
    const nextNames = parentFile ? [...names, suite.attrs.name ?? ''] : names;
    let count = 0;
    for (const child of suite.children) {
      if (child.name === 'testsuite') { count += walkSuite(child, file, nextNames); continue; }
      if (child.name !== 'testcase') { invalid = true; continue; }
      count++;
      const path = child.attrs.file ?? file;
      const name = [...nextNames, child.attrs.name ?? ''].filter(Boolean).join(' > ');
      if (!path || !child.attrs.name || !name || child.children.some((marker) => !['failure', 'error', 'skipped', 'system-out', 'system-err'].includes(marker.name))) {
        invalid = true; continue;
      }
      const id = `${path.replace(/^\.\//, '')} > ${name}`;
      if (cases.has(id)) { invalid = true; continue; }
      const markers = child.children.filter((marker) => ['failure', 'error', 'skipped'].includes(marker.name));
      if (markers.length > 1) { invalid = true; continue; }
      cases.set(id, markers[0]?.name === 'failure' ? 'fail' : markers[0]?.name === 'error' ? 'error'
        : markers[0]?.name === 'skipped' ? 'skipped' : 'pass');
    }
    if (!countMatches(suite.attrs.tests, count)) invalid = true;
    return count;
  };
  const count = root.children.reduce((total, child) => total + walkSuite(child, undefined, []), 0);
  if (!countMatches(root.attrs.tests, count)) invalid = true;
  return invalid || cases.size === 0 ? null : cases;
}

function readSmall(path: string): string {
  if (!path || statSync(path).size > 16 * 1024 * 1024) throw new Error('artifact missing or too large');
  return readFileSync(path, 'utf8');
}

export function classifyGateR2Verdict(input: GateR2Input, read: (path: string) => string = readSmall): GateR2Result {
  const source = (input && typeof input === 'object' ? input : {}) as Partial<GateR2Input>;
  const { batch, solo, baseline } = source;
  const evidence = { head40: source.head40 ?? '', base40: source.base40 ?? '', envKey: source.envKey ?? '', shards: source.shards ?? 0,
    cohort: Array.isArray(source.cohort) ? [...source.cohort] : [], batchResultPath: batch?.resultPath ?? '', soloResultPath: solo?.resultPath ?? '',
    baselineResultPath: baseline?.resultPath ?? '', reason: '' };
  const answer = (verdict: GateR2Verdict, reason: string, identityStatus: GateR2Identity = 'exact'): GateR2Result =>
    ({ verdict, identityStatus, stableTestId: source.stableTestId ?? '', evidence: { ...evidence, reason } });
  const unique = (paths: string[]) => paths.length === new Set(paths).size && paths.every((path) =>
    path.split('/').every((part) => part !== '.' && part !== '..' && /^[\w.-]+$/.test(part))
    && /\.(test|spec)\.[cm]?[tj]sx?$/.test(path));
  if (typeof input?.stableTestId !== 'string' || typeof input.head40 !== 'string' || typeof input.base40 !== 'string'
    || typeof input.envKey !== 'string' || !Array.isArray(input.cohort) || !Array.isArray(batch?.cohort)
    || !Array.isArray(solo?.cohort) || !Array.isArray(baseline?.cohort)
    || !sha40.test(input.head40) || !sha40.test(input.base40) || !input.envKey || !Number.isSafeInteger(input.shards) || input.shards < 1
    || !input.stableTestId.includes(' > ') || !unique(input.cohort) || input.cohort.length < 2
    || JSON.stringify(input.cohort) !== JSON.stringify([...input.cohort].sort())
    || !input.cohort.includes(testFile(input.stableTestId)) || !batch || !solo || !baseline)
    return answer('unmeasured', 'identity or cohort input invalid', 'identity-unmeasured');
  if (batch.head40 !== input.head40 || solo.head40 !== input.head40 || baseline.head40 !== input.base40
    || [batch, solo, baseline].some((run) => run.envKey !== input.envKey || !Number.isSafeInteger(run.rc) || run.rc < 0
      || typeof run.runId !== 'string' || run.runId.length < 8 || !run.resultPath || !run.junitPath)
    || new Set([batch.runId, solo.runId, baseline.runId]).size !== 3
    || new Set([batch.junitPath, batch.resultPath, solo.junitPath, solo.resultPath, baseline.junitPath, baseline.resultPath]).size !== 6
    || JSON.stringify(batch.cohort) !== JSON.stringify(input.cohort)
    || JSON.stringify(solo.cohort) !== JSON.stringify([testFile(input.stableTestId)])
    || JSON.stringify(baseline.cohort) !== JSON.stringify([testFile(input.stableTestId)]))
    return answer('unmeasured', 'head/env/cohort/artifact mismatch', 'identity-unmeasured');
  let batchCases: Cases, soloCases: Cases, baseCases: Cases;
  try {
    const artifactPaths = [batch.junitPath, batch.resultPath, solo.junitPath, solo.resultPath, baseline.junitPath, baseline.resultPath];
    if (new Set(artifactPaths.map((path) => realpathSync(path))).size !== artifactPaths.length
      || new Set(artifactPaths.map((path) => { const stat = statSync(path); return `${stat.dev}:${stat.ino}`; })).size !== artifactPaths.length)
      return answer('unmeasured', 'run artifacts resolve to the same file', 'identity-unmeasured');
    for (const run of [batch, solo, baseline]) {
      const result = JSON.parse(read(run.resultPath)) as Partial<GateR2Run>;
      if (result.head40 !== run.head40 || result.envKey !== run.envKey || result.rc !== run.rc || result.runId !== run.runId
        || result.resultPath !== run.resultPath
        || result.junitPath !== run.junitPath || JSON.stringify(result.cohort) !== JSON.stringify(run.cohort))
        return answer('unmeasured', 'result artifact disagrees with run identity', 'identity-unmeasured');
    }
    const parsed = [batch, solo, baseline].map((run) => gateR2JunitCases(read(run.junitPath)));
    if (parsed.some((cases) => cases === null)) return answer('unmeasured', 'JUnit incomplete or duplicate IDs', 'identity-unmeasured');
    if ([batch, solo, baseline].some((run, index) => [...parsed[index]!.keys()].some((id) => !run.cohort.includes(testFile(id)))))
      return answer('unmeasured', 'JUnit testcase outside declared cohort', 'identity-unmeasured');
    [batchCases, soloCases, baseCases] = parsed as Cases[];
    if ([batch, solo, baseline].some((run, index) => {
      const hasFailure = [...parsed[index]!.values()].some((status) => status === 'fail' || status === 'error');
      return (run.rc === 0) === hasFailure;
    })) return answer('unmeasured', 'JUnit failures contradict process exit code', 'identity-unmeasured');
  } catch { return answer('unmeasured', 'JUnit unreadable', 'identity-unmeasured'); }
  const issue = (value: string | undefined) => value === 'fail' || value === 'error';
  if (!issue(batchCases.get(input.stableTestId)) || batch.rc === 0)
    return answer('unmeasured', 'batch failure identity not proved', 'identity-unmeasured');
  const soloStatus = soloCases.get(input.stableTestId);
  const baseStatus = baseCases.get(input.stableTestId);
  const rename = input.renameCandidate;
  const renameStatus: GateR2Identity = rename?.unique && typeof rename.oldDigest === 'string'
    && typeof rename.newDigest === 'string' && rename.oldDigest.length >= 8 && rename.oldDigest === rename.newDigest
    && issue(baseCases.get(rename.oldTestId)) ? 'renamed-existing-candidate' : 'identity-unmeasured';
  if (!baseStatus) return answer('unmeasured', 'baseline testcase identity absent or ambiguous', renameStatus);
  if (baseStatus === 'skipped') return answer('unmeasured', 'baseline testcase skipped', 'identity-unmeasured');
  if (issue(baseStatus) && baseline.rc === 0)
    return answer('unmeasured', 'baseline JUnit failure contradicts exit code', 'identity-unmeasured');
  if (!soloStatus || soloStatus === 'skipped') return answer('unmeasured', 'solo testcase identity absent or skipped', 'identity-unmeasured');
  if (input.environmentProof !== undefined) {
    try {
      const { signature, batchStatusPath, baselineStatusPath } = input.environmentProof;
      if (typeof signature !== 'string' || signature.length < 8 || !batchStatusPath || !baselineStatusPath || baseline.rc === 0)
        return answer('unmeasured', 'Pod infrastructure proof incomplete', 'identity-unmeasured');
      const proofPaths = [batchStatusPath, baselineStatusPath];
      const artifactPaths = [batch.junitPath, batch.resultPath, solo.junitPath, solo.resultPath, baseline.junitPath, baseline.resultPath];
      const allPaths = [...artifactPaths, ...proofPaths];
      if (new Set(allPaths.map((path) => realpathSync(path))).size !== allPaths.length
        || new Set(allPaths.map((path) => { const stat = statSync(path); return `${stat.dev}:${stat.ino}`; })).size !== allPaths.length)
        return answer('unmeasured', 'Pod status artifacts are not independent', 'identity-unmeasured');
      const batchStatus = JSON.parse(read(batchStatusPath)) as Record<string, unknown>;
      const baseStatusProof = JSON.parse(read(baselineStatusPath)) as Record<string, unknown>;
      const valid = (proof: Record<string, unknown>, head: string, runId: string) => proof.kind === 'pod-infrastructure'
        && proof.head40 === head && proof.envKey === input.envKey && proof.signature === signature && proof.runId === runId;
      if (!valid(batchStatus, input.head40, batch.runId) || !valid(baseStatusProof, input.base40, baseline.runId))
        return answer('unmeasured', 'Pod infrastructure proof conflicts with result run IDs', 'identity-unmeasured');
      if (!issue(baseStatus)) return answer('unmeasured', 'Pod infrastructure proof does not explain baseline target', 'identity-unmeasured');
      return answer('environment-failure', 'independent Pod infrastructure status at base and head');
    } catch { return answer('unmeasured', 'Pod infrastructure proof unreadable', 'identity-unmeasured'); }
  }
  if (soloStatus === 'pass' && solo.rc === 0) return answer('interference-candidate', 'batch failed, same-head/env solo passed');
  if (!issue(soloStatus) || solo.rc === 0) return answer('unmeasured', 'solo result missing or inconsistent', 'identity-unmeasured');
  if (issue(baseStatus) && baseline.rc !== 0) return answer('preexisting', 'same stable ID failed at base and head');
  if (baseStatus === 'pass') return answer('introduced', 'same stable ID passed at base and failed in solo head');
  return answer('unmeasured', 'baseline testcase identity absent or ambiguous', renameStatus);
}

export async function gateR2Main(args: string[] = process.argv.slice(2), write: (value: string) => void = console.log): Promise<number> {
  const path = args[0] === '--input' ? args[1] : undefined;
  if (!path || (args.length !== 2 && !(args.length === 3 && args[2] === '--json'))) { write('usage: gate-r2-verdict --input <json-file> --json'); return 2; }
  try {
    const result = classifyGateR2Verdict(JSON.parse(readSmall(path)) as GateR2Input);
    write(JSON.stringify(result));
    return result.verdict === 'unmeasured' ? 3 : 0;
  } catch (error) { write(JSON.stringify({ verdict: 'unmeasured', identityStatus: 'identity-unmeasured', stableTestId: '',
    evidence: { head40: '', base40: '', envKey: '', shards: 0, cohort: [], batchResultPath: '', soloResultPath: '', baselineResultPath: '', reason: String(error) } })); return 3; }
}

if (import.meta.main) process.exitCode = await gateR2Main();
