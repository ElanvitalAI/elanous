#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** Fully bound evidence consumed by the HQ batch train. Missing evidence is always a rejection. */
export interface TrainVerdictInput {
  base: string;
  head: string;
  changedPaths: { source: 'git-diff'; complete: boolean; base: string; head: string; paths: string[]; diffOutput: string; artifactSha256: string };
  batch: {
    base: string;
    head: string;
    complete: boolean;
    exit: number;
    introduced: number;
    unknown: number;
    preconditionUnmet: number;
    unrunImporters: number;
    typecheck: 'pass' | 'fail';
    alwaysRatchets: 'pass' | 'fail';
    preexisting: number;
    preexistingEvidence?: { complete: boolean; base: string; head: string; sha: string; ids: string[] };
    preexistingBuildEvidence?: { base: string; head: string; sha: string; valid: boolean };
    timeouts: number;
    timeoutEvidence: { source: 'gate-artifact'; artifactSha256: string; artifactJson: string; complete: boolean; base: string; head: string; failures: Array<{ id: string; file: string }> };
  };
  remeasure?: {
    complete: boolean;
    host: string;
    primaryHost: string;
    base: string;
    head: string;
    exit: number;
    failuresComplete: boolean;
    artifactSha256: string;
    artifactJson: string;
    failures: Array<{ id: string; file: string }>;
  };
}

export interface TrainVerdict { verdict: 'pass' | 'fail'; reason: string }

const SHA = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const validCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const canonicalHost = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value !== value.trim() || value !== value.toLowerCase()) return undefined;
  return /^(?:aws[1-3]|gcp[1-3]|node-c|minim5|mshq|node-b)$/.test(value) ? value : undefined;
};

function artifactMatches(artifactJson: unknown, artifactSha256: unknown, expected: { base: string; head: string; failures: Array<{ id: string; file: string }> }): boolean {
  if (typeof artifactJson !== 'string' || typeof artifactSha256 !== 'string' || !SHA256.test(artifactSha256)
    || digest(artifactJson) !== artifactSha256.toLowerCase()) return false;
  try {
    const artifact: unknown = JSON.parse(artifactJson);
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return false;
    const row = artifact as Record<string, unknown>;
    return row.schema === 'train-timeout-attribution/v1' && row.base === expected.base && row.head === expected.head
      && JSON.stringify(row.failures) === JSON.stringify(expected.failures);
  } catch { return false; }
}
function safeRepoPath(path: unknown): string | undefined {
  if (typeof path !== 'string' || !path.trim() || path.includes('\\') || path.startsWith('/') || /^[a-z]:/i.test(path)) return undefined;
  const pieces = path.split('/');
  if (pieces.some((piece) => !piece || piece === '.' || piece === '..')) return undefined;
  return path;
}

function completePathEvidence(value: TrainVerdictInput['changedPaths'], base: string, head: string): string[] | undefined {
  if (!value || value.source !== 'git-diff' || value.complete !== true || value.base !== base || value.head !== head || !Array.isArray(value.paths)) return undefined;
  if (typeof value.diffOutput !== 'string' || !SHA256.test(value.artifactSha256) || digest(value.diffOutput) !== value.artifactSha256.toLowerCase()) return undefined;
  const paths = value.paths.map(safeRepoPath);
  if (paths.some((path) => path === undefined) || new Set(paths).size !== paths.length) return undefined;
  const fromDiff = value.diffOutput === '' ? [] : value.diffOutput.replace(/\0$/, '').split('\0').map(safeRepoPath);
  if (fromDiff.some((path) => path === undefined) || new Set(fromDiff).size !== fromDiff.length) return undefined;
  const sortedDeclared = [...paths as string[]].sort();
  const sortedObserved = [...fromDiff as string[]].sort();
  return JSON.stringify(sortedDeclared) === JSON.stringify(sortedObserved) ? sortedDeclared : undefined;
}

function reject(reason: string): TrainVerdict { return { verdict: 'fail', reason }; }

export function decideTrainVerdict(input: TrainVerdictInput): TrainVerdict {
  if (!input || !SHA.test(input.base) || !SHA.test(input.head) || input.base === input.head)
    return reject('base/head must be distinct, exact 40-character commits');
  const changedPaths = completePathEvidence(input.changedPaths, input.base, input.head);
  if (!changedPaths) return reject('changedPaths must be a complete safe path list bound to exact base/head');
  const batch = input.batch;
  if (!batch || batch.complete !== true || batch.base !== input.base || batch.head !== input.head
    || (batch.exit !== 0 && batch.exit !== 1))
    return reject('batch result is incomplete or not bound to exact base/head');
  for (const key of ['introduced', 'unknown', 'preconditionUnmet', 'unrunImporters', 'preexisting', 'timeouts'] as const)
    if (!validCount(batch[key])) return reject(`batch ${key} count is missing or invalid`);
  const timeoutEvidence = batch.timeoutEvidence;
  if (!timeoutEvidence || timeoutEvidence.source !== 'gate-artifact' || timeoutEvidence.complete !== true
    || timeoutEvidence.base !== input.base || timeoutEvidence.head !== input.head || !SHA256.test(timeoutEvidence.artifactSha256)
    || !Array.isArray(timeoutEvidence.failures) || timeoutEvidence.failures.some((failure) => !failure || typeof failure.id !== 'string' || !failure.id.trim() || !safeRepoPath(failure.file)))
    return reject('timeout ID-to-file attribution is incomplete');
  if (!artifactMatches(timeoutEvidence.artifactJson, timeoutEvidence.artifactSha256, timeoutEvidence))
    return reject('timeout attribution artifact hash or content does not match its evidence');
  if (new Set(timeoutEvidence.failures.map((failure) => failure.id)).size !== timeoutEvidence.failures.length)
    return reject('timeout attribution contains duplicate IDs');
  if (batch.typecheck !== 'pass' || batch.alwaysRatchets !== 'pass') return reject('typecheck or always-ratchet gate failed');
  if (batch.introduced !== 0 || batch.unknown !== 0 || batch.preconditionUnmet !== 0 || batch.unrunImporters !== 0)
    return reject('introduced, unknown, unmet-precondition, or unrun-importer failures remain');
  if (batch.timeouts !== timeoutEvidence.failures.length) return reject('timeout count does not match complete ID-to-file attribution');
  if (batch.preexisting > 0) {
    const existing = batch.preexistingEvidence;
    if (!existing || existing.complete !== true || existing.base !== input.base || existing.head !== input.head || existing.sha !== input.head
      || !Array.isArray(existing.ids) || existing.ids.length !== batch.preexisting || existing.ids.some((id) => typeof id !== 'string' || !id.trim())
      || new Set(existing.ids).size !== existing.ids.length)
      return reject('preexisting failures require complete exact base/head-bound ID evidence');
    const evidence = batch.preexistingBuildEvidence;
    if (batch.exit !== 0 && (!evidence || evidence.valid !== true || evidence.base !== input.base || evidence.head !== input.head || evidence.sha !== input.head))
      return reject('nonzero preexisting batch requires exact base/head-bound build evidence');
    if (evidence && (evidence.valid !== true || evidence.base !== input.base || evidence.head !== input.head || evidence.sha !== input.head))
      return reject('preexisting build evidence is not bound to exact base/head');
  }
  if (batch.timeouts > 0) {
    const retry = input.remeasure;
    const remeasureHost = canonicalHost(retry?.host);
    const primaryHost = canonicalHost(retry?.primaryHost);
    if (!retry || retry.complete !== true || retry.failuresComplete !== true || !remeasureHost || !primaryHost || remeasureHost === primaryHost)
      return reject('timeout remeasure must be complete on a different host with complete failure attribution');
    if (retry.base !== input.base || retry.head !== input.head) return reject('timeout remeasure base/head does not match the batch');
    if (!SHA256.test(retry.artifactSha256) || !Array.isArray(retry.failures) || retry.failures.some((failure) => !failure || typeof failure.id !== 'string' || !failure.id.trim() || !safeRepoPath(failure.file)))
      return reject('remeasure failure ID-to-file attribution is incomplete');
    if (!artifactMatches(retry.artifactJson, retry.artifactSha256, retry)) return reject('remeasure artifact hash or content does not match its evidence');
    if (new Set(retry.failures.map((failure) => failure.id)).size !== retry.failures.length)
      return reject('remeasure contains duplicate failure IDs');
    if (retry.exit === 0 && retry.failures.length === 0) return { verdict: 'pass', reason: 'timeouts passed on a different host; required gates and attribution are clean' };
    if (retry.exit !== 1 || retry.failures.length === 0)
      return reject('timeout remeasure failure summary is incomplete');
    const timeoutFiles = new Map(timeoutEvidence.failures.map((failure) => [failure.id, failure.file]));
    const changed = new Set(changedPaths);
    const seen = new Set<string>();
    for (const failure of retry.failures) {
      if (!timeoutFiles.has(failure.id) || seen.has(failure.id) || timeoutFiles.get(failure.id) !== failure.file)
        return reject('remeasure reported a failure outside the complete timeout ID set');
      seen.add(failure.id);
      if (changed.has(failure.file)) return reject(`remeasure failure intersects changed path: ${failure.file}`);
    }
    return { verdict: 'pass', reason: 'measured timeout failures are limited to unchanged paths on a different host' };
  }
  if (batch.exit !== 0 && batch.preexisting === 0) return reject('nonzero batch exit has no proven preexisting failure');
  return { verdict: 'pass', reason: batch.preexisting > 0 ? 'only proven preexisting failures remain' : 'all required gates passed with no introduced failures' };
}

if (import.meta.main) {
  try {
    const file = process.argv[2];
    if (!file) throw new Error('usage: bun scripts/release-loop/train-verdict.ts <evidence.json>');
    const input = JSON.parse(readFileSync(file, 'utf8')) as TrainVerdictInput;
    const result = decideTrainVerdict(input);
    console.log(JSON.stringify(result));
    process.exitCode = result.verdict === 'pass' ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({ verdict: 'fail', reason: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 2;
  }
}
