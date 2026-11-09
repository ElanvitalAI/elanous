import { spawnSync } from 'node:child_process';
import { gateFileReceiptKey, type GateFileReceiptIdentity } from './gate-file-receipts.js';
import { readGateFileReceiptHistory } from './gate-shard-receipts.js';

/** File CAS key evidence consumed by regression triage. A missing input is never inferred unchanged. */
export interface FileCasKey {
  file: string;
  imageDigest: string;
  closure: Readonly<Record<string, string>>;
  opaqueReason?: string;
}

export interface KeyDiffCommit {
  commit: string;
  changedFiles: readonly string[];
  prNumber?: number;
}

export interface MainKeyReceipt {
  key: FileCasKey;
  status: 'pass' | 'fail';
  /** The CAS ledger loader must set this only after verifying its immutable record. */
  verified: boolean;
}

export interface KeyDiffInput {
  failureId: string;
  base: FileCasKey;
  cut: FileCasKey;
  commits: readonly KeyDiffCommit[];
  mainReceipts: readonly MainKeyReceipt[];
}

/** CAS history is checksum-validated by its reader. Only a train measurement on main can establish same-key status. */
export function lookupMainSameKeyReceipts(root: string, cut: FileCasKey, mainTip: string, repo: string): MainKeyReceipt[] {
  if (!validKey(cut) || !SHA.test(mainTip)) return [];
  const identity: GateFileReceiptIdentity = { file: cut.file, imageDigest: cut.imageDigest,
    closureFiles: Object.keys(cut.closure).sort(), contentHashes: cut.closure };
  const key = gateFileReceiptKey(identity);
  if (!key) return [];
  return readGateFileReceiptHistory(root, key).flatMap((receipt) => {
    if (receipt.lane !== 'train' || !SHA.test(receipt.sourceHead40)) return [];
    const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', receipt.sourceHead40, mainTip],
      { cwd: repo, encoding: 'utf8', timeout: 15_000 });
    return ancestor.status === 0 && !ancestor.error ? [{ key: cut, status: receipt.outcome === 'pass' ? 'pass' as const
      : 'fail' as const, verified: true }] : [];
  });
}

export type KeyDiffVerdict =
  | { status: 'opaque'; failureId: string; reason: string; fallback: 'bisect' }
  | { status: 'unmeasured'; failureId: string; reason: string; changedInputs: string[] }
  | { status: 'attributed'; failureId: string; changedInputs: string[];
      candidates: Array<{ commit: string; prNumber?: number; changedInputs: string[] }>;
      mainSameKey: 'pass' | 'fail' | 'absent' };

const SHA = /^[a-f0-9]{40}$/i;
const HASH = /^[a-f0-9]{64}$/i;
const IMAGE = /^sha256:[a-f0-9]{64}$/i;

/** Read the actual cut first-parent append sequence. A missing commit or diff makes attribution unmeasured. */
export function loadCutKeyDiffCommits(repo: string, baseCommit: string, cutCommit: string): KeyDiffCommit[] | null {
  if (!SHA.test(baseCommit) || !SHA.test(cutCommit)) return null;
  const git = (args: string[]): string | null => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
    return result.status === 0 && !result.error ? result.stdout : null;
  };
  if (git(['merge-base', '--is-ancestor', baseCommit, cutCommit]) === null) return null;
  const history = git(['rev-list', '--first-parent', '--reverse', `${baseCommit}..${cutCommit}`]);
  if (history === null) return null;
  const commits = history.trim().split(/\r?\n/).filter(Boolean);
  if (commits.length === 0 || commits.at(-1) !== cutCommit || commits.some((sha) => !SHA.test(sha))) return null;
  const rows: KeyDiffCommit[] = [];
  let parent = baseCommit;
  for (const commit of commits) {
    const parents = git(['rev-list', '--parents', '-n', '1', commit]);
    if (parents === null || parents.trim().split(' ')[1] !== parent) return null;
    const changed = git(['diff', '--name-only', '-z', parent, commit]);
    const subject = git(['show', '-s', '--format=%s', commit]);
    if (changed === null || subject === null) return null;
    const changedFiles = changed.split('\0').filter(Boolean);
    if (changedFiles.some((path) => path.startsWith('/') || path.split('/').includes('..'))) return null;
    const pr = /\(#([1-9]\d*)\)/.exec(subject);
    rows.push({ commit, changedFiles, ...(pr ? { prNumber: Number(pr[1]) } : {}) });
    parent = commit;
  }
  return rows;
}

function validKey(key: FileCasKey): boolean {
  return typeof key?.file === 'string' && key.file.length > 0 && !key.file.startsWith('/')
    && !key.file.split('/').includes('..') && typeof key.imageDigest === 'string' && IMAGE.test(key.imageDigest)
    && key.closure && typeof key.closure === 'object' && !Array.isArray(key.closure)
    && Object.prototype.hasOwnProperty.call(key.closure, key.file)
    && Object.entries(key.closure).every(([path, hash]) => path.length > 0 && !path.startsWith('/')
      && !path.split('/').includes('..') && HASH.test(hash));
}

function sameKey(a: FileCasKey, b: FileCasKey): boolean {
  const paths = [...new Set([...Object.keys(a.closure), ...Object.keys(b.closure)])];
  return a.file === b.file && a.imageDigest === b.imageDigest
    && paths.every((path) => a.closure[path] === b.closure[path]);
}

/** Attribute a measured failure to the changed inputs of its own closure. Candidates are suspects, not proof of causality. */
export function triageFailureKeyDiff(input: KeyDiffInput): KeyDiffVerdict {
  const { base, cut, failureId } = input;
  if (base?.opaqueReason || cut?.opaqueReason)
    return { status: 'opaque', failureId, reason: cut?.opaqueReason || base?.opaqueReason || 'opaque closure', fallback: 'bisect' };
  if (!validKey(base) || !validKey(cut) || base.file !== cut.file
      || (failureId !== base.file && !failureId.startsWith(`${base.file} > `)))
    return { status: 'unmeasured', failureId, reason: 'file CAS keys are incomplete or inconsistent', changedInputs: [] };
  const changedInputs = [...new Set([...Object.keys(base.closure), ...Object.keys(cut.closure)])]
    .filter((path) => base.closure[path] !== cut.closure[path]).sort();
  if (base.imageDigest !== cut.imageDigest) changedInputs.push('@image');
  if (!changedInputs.length)
    return { status: 'unmeasured', failureId, reason: 'same key cannot explain an introduced failure', changedInputs };
  const relatedCommits = input.commits.filter((entry) => Array.isArray(entry.changedFiles)
    && entry.changedFiles.some((path) => changedInputs.includes(path)));
  const candidates = relatedCommits.flatMap((entry) => {
    if (!SHA.test(entry.commit) || !Array.isArray(entry.changedFiles)
      || !Number.isSafeInteger(entry.prNumber) || entry.prNumber! < 1) return [];
    const affected = changedInputs.filter((path) => path !== '@image' && entry.changedFiles.includes(path));
    return affected.length ? [{ commit: entry.commit, prNumber: entry.prNumber!, changedInputs: affected }] : [];
  });
  if (changedInputs.includes('@image') || !candidates.length
      || candidates.length !== relatedCommits.length
      || changedInputs.some((path) => path !== '@image' && !candidates.some((candidate) => candidate.prNumber
        && candidate.changedInputs.includes(path))))
    return { status: 'unmeasured', failureId, reason: 'changed key inputs lack complete commit attribution', changedInputs };
  const matching = input.mainReceipts.filter((receipt) => receipt.verified === true
    && receipt.status && validKey(receipt.key) && sameKey(receipt.key, cut));
  // Contradictory same-key records cannot prove a main fix.
  const mainSameKey = matching.length && matching.every((receipt) => receipt.status === 'pass') ? 'pass'
    : matching.length && matching.every((receipt) => receipt.status === 'fail') ? 'fail' : 'absent';
  return { status: 'attributed', failureId, changedInputs, candidates, mainSameKey };
}
