/**
 * TA-LAND-OVERLAP — 머리 고정 착지(`pr land --pr --expected-head`)가 «1일 겹침» 관문에서 비대화형으로 영영 멎던 것을
 * «증거가 붙은 경우에만» 통과시킨다.
 *
 * - 왜: 겹침 승인은 터미널 확인뿐이라 비대화형(TA)에서는 늘 `unavailable` → 머리 고정 착지는 «항상» 거부됐다.
 *   (10-10 #25845 · 10-11 #25974 가 같은 관문에 걸려 머리 고정을 풀고 착지했다.)
 * - 무엇을: `--overlap-evidence <file>` 의 JSON 을 «믿지 않고» 잰다.
 *   ① 재기반 — 원격 base 의 «지금» 끝(`git ls-remote`)이 고정 머리의 조상인가(`git merge-base --is-ancestor`).
 *   ② 재게이트 — 증거의 게이트 기록이 «그 머리»를 «그 base 끝» 위에서 통과했다고 말하는가(머리·base 끝이 ① 과 맞물린다).
 *   ②' 재게이트 뒤 base 가 앞섰다(OVERLAP-EVIDENCE-BASE-WINDOW) — `gate.baseCommit ≠ 지금 끝`이면 «창»을 잰다:
 *      ⓐ `gate.baseCommit` 이 고정 머리의 조상 ⊕ 지금 끝의 조상이고 ⓑ 창 `gate.baseCommit..지금 끝`의 커밋이 «하나도»
 *      PR 의 바뀐 파일(머리 vs merge-base)을 안 건드리면 통과(관측 reason `base-advanced-disjoint`).
 *      겹치면 `base-stale-overlap`(REJUDGE 가 재게이트를 청한다) · 못 재면 `base-window-unmeasured` · ⓐ 가 아니면 종전 사유.
 *   ③ 리뷰 — 증거가 가리키는 `review-results/<card>-<pr>-<head접두 10~40>.json`(TA 가 받는 `self review --json` stdout)이
 *      파일명에서 같은 PR·머리 접두이고 내용에서 전체 PR·머리가 정확히 같으며 `reviewed:true` · `verdict ∈ {pass, warn}` · must-fix 가 «잰 수» 0 인가
 *      (자동 병합 canAuto · TA-LAND-WARN-MUSTFIX0 과 같은 규칙 — must-fix 를 못 셌으면 거부).
 *   ③' 공급자(PRLAND-ACP-CLAUDE-ALLOW) — 백엔드가 `acp:claude`(또는 `acp:claude/…`, acp-fallback+`claude`)인 리뷰도
 *      ③ 을 만족하고 «같은 머리의 선택된 리뷰» 이면 착지 증거다. 같은 머리의 실패한 금지 리뷰는 후보에서
 *      superseded 로 제외되고(supersedes 장부), 유효한 같은-머리 리뷰가 없으면 종전처럼 거부한다(fail-closed).
 *   ⓐ 이미 조상(TC #26019 실측) — 겹친 최근 착지 커밋이 «전부» 고정 머리의 조상이면 그 겹침은 이미 그 머리의 게이트·리뷰에
 *      반영됐다 ⇒ ①② 없이 ③ 만으로 통과(관측 reason `already-ancestor`). 하나라도 조상이 아니면 ①②③ 전부.
 *   ⓐ' 증거 파일이 없을 때(`verifyAncestorAutoPass`) — 같은 ⓐ 를 표준 자리 `review-results/*-<pr>-<head접두 10~40>.json` 만으로 잰다
 *      (관측 reason `already-ancestor-auto`). 조상이 아닌 착지가 하나라도 있거나 리뷰 결과가 없으면 거부.
 *   하나라도 못 재거나 어긋나면 거부 — 호출부는 종전 거부를 그대로 낸다(fail-closed).
 * - 관측: `pr.land` · `overlap-evidence` (decision · reason · 잰 값).
 */
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import { debug } from '../debug/log.js';
import type { CmdRunner } from '../autopilot/pr-manager.js';
import { parseReviewResultOutput } from '../task-agent/review-result-capture.js';
import { verifyVirtualRebasePatch } from './pr-land-virtual-rebase.js';
import { parseMergeTreeConflictPaths } from './pr-land-conflict-merge.js';
import { proveReviewCarry } from './review-carry.js';
import { buildTypefixCarryCandidate, loadTypefixCarryContext as loadProductionTypefixCarryContext, proveTypefixCarry, writeTypefixCarryReceipt, type ProveTypefixCarryInput, type TypefixCarryContextOptions, type TypefixCarryDeps, type TypefixCarryReceipt } from './review-typefix-carry.js';

const SHA40 = /^[0-9a-f]{40}$/i;

interface OverlapEvidenceFile {
  pr: number | string;
  head: string;
  /** ①② 경로에서만 필수 — 겹친 착지가 전부 조상(already-ancestor)이면 생략해도 된다. */
  gate?: { head: string; baseCommit: string; passed: boolean };
  /** `self review --json` stdout 을 받은 파일(TA: `<state>/review-results/<card>-<pr>-<head접두 10~40>.json`); 내용의 전체 head도 확인한다. */
  reviewResult: string;
  /** Explicit old-head review for a mechanically merged main head. Always re-proved against Git. */
  reviewCarry?: { oldHead: string; oldBase: string; newBase: string; patchId: string; pathsModesHash: string; reviewSha256: string };
  /** Evidence-file override for explicitly replaced failed reviews. Each reason is the verifier's refusal reason. */
  supersedes?: { reviewResult: string; reason: string }[];
  /** OPEN follow-up PR that owns the findings intentionally split from this landing. */
  followupPr?: number;
}

export type OverlapEvidenceVerdict =
  | { ok: true; mode: 'already-ancestor'; reviewResult: string }
  | { ok: true; mode: 'rebased'; baseTip: string; reviewResult: string }
  | { ok: true; mode: 'base-advanced-disjoint'; baseTip: string; gateBase: string; windowCommits: number; reviewResult: string }
  | { ok: false; reason: string; baseTip?: string };

/** Resolve CLI-supplied evidence against the selected repository, not the caller's shell cwd. */
export function resolveOverlapEvidencePath(evidencePath: string, cwd: string): string {
  return resolve(cwd, evidencePath);
}

export type PrPushConflictForecast = {
  schema: 'conflict-forecast.v1'; at: string; kind: 'pr-overlap' | 'pr-conflict'; detector: 'overlap-evidence';
  pr: number | null; head: string | null; base: string; otherPr: number | null; files: string[]; conflict: true | false | null; owner: string | null;
  unmeasuredReason?: string;
};
export type PrPushConflictPeer = { pr: number; head: string; files: readonly string[]; owner?: string | null };
function appendDefaultPrPushConflictForecast(row: PrPushConflictForecast): void {
  const home = process.env.HOME;
  if (!home) throw new Error('HOME is unavailable for conflict forecast');
  const path = join(home, 'elanous-hq/seat-state/OP/train-manager/conflict-forecast.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
}

/** Persist an explicit unknown row when the PR census or candidate HEAD could not be measured. */
export function recordUnmeasuredPrPushConflict(input: {
  pr: number | null; head: string | null; base: string; owner?: string | null; reason: string;
  now?: () => Date; append?: (row: PrPushConflictForecast) => void;
}): PrPushConflictForecast {
  const row: PrPushConflictForecast = {
    schema: 'conflict-forecast.v1', at: (input.now?.() ?? new Date()).toISOString(), kind: 'pr-overlap',
    detector: 'overlap-evidence', pr: input.pr, head: input.head, base: input.base, otherPr: null,
    files: [], conflict: null, owner: input.owner ?? null, unmeasuredReason: input.reason,
  };
  (input.append ?? appendDefaultPrPushConflictForecast)(row);
  return row;
}

/** Read-only PR-push observer. Incomplete Git measurements are recorded as conflict:null. */
export function forecastPrPushConflicts(input: {
  cwd: string; pr: number | null; head: string; base: string; owner?: string | null; peers: readonly PrPushConflictPeer[];
  run: CmdRunner; now?: () => Date; append?: (row: PrPushConflictForecast) => void;
}): { measured: boolean; rows: PrPushConflictForecast[] } {
  const write = input.append ?? appendDefaultPrPushConflictForecast;
  const candidate = input.run('git', ['diff', '--name-only', '-z', `${input.base}...${input.head}`], { cwd: input.cwd });
  const candidateFiles = candidate.ok ? candidate.out.split('\0').filter(Boolean) : [];
  const rows: PrPushConflictForecast[] = [];
  let measured = candidate.ok;
  for (const peer of input.peers) {
    const files = candidate.ok ? candidateFiles.filter(path => peer.files.includes(path)).sort() : [];
    if (candidate.ok && files.length === 0) continue;
    let peerHead = input.run('git', ['rev-parse', '--verify', '--quiet', peer.head], { cwd: input.cwd }).ok ? peer.head : '';
    if (!peerHead) {
      const fetched = input.run('git', ['fetch', '--no-tags', 'origin', `refs/pull/${peer.pr}/head`], { cwd: input.cwd });
      const resolved = fetched.ok ? input.run('git', ['rev-parse', '--verify', '--quiet', 'FETCH_HEAD'], { cwd: input.cwd }) : null;
      if (resolved?.ok && resolved.out.trim().toLowerCase() === peer.head.toLowerCase()) peerHead = peer.head;
    }
    const merge = peerHead
      ? input.run('git', ['merge-tree', '--write-tree', '-z', input.head, peerHead], { cwd: input.cwd })
      : { ok: false, out: '' };
    const conflictPaths = parseMergeTreeConflictPaths(merge.out, merge.ok ? 0 : 1);
    const cleanTree = merge.ok && /^[a-f0-9]{40,64}$/i.test(merge.out.trim());
    const conflict = cleanTree ? false : conflictPaths.measured ? conflictPaths.paths.length > 0 : null;
    if (conflict === null) measured = false;
    const row: PrPushConflictForecast = {
      schema: 'conflict-forecast.v1', at: (input.now?.() ?? new Date()).toISOString(),
      kind: conflict === true ? 'pr-conflict' : 'pr-overlap', detector: 'overlap-evidence', pr: input.pr,
      head: input.head, base: input.base, otherPr: peer.pr, files: conflictPaths.measured ? [...new Set([...files, ...conflictPaths.paths])].sort() : files,
      conflict, owner: input.owner ?? null,
    };
    write(row); rows.push(row);
  }
  return { measured, rows };
}

export interface VerifyOverlapEvidenceInput {
  evidencePath: string;
  pr: number;
  expectedHead: string;
  remote: string;
  branch: string;
  cwd: string;
  run: CmdRunner;
  readFile: (path: string) => string;
  /** Canonical state directory; evidence cannot choose the review search root. */
  reviewResultsDir?: string;
  /** Standard review-results directory listing. Failure to measure always rejects. */
  listDir?: (dir: string) => readonly string[];
  /** Review file modification time in milliseconds, used to prove the selected result followed failed attempts. */
  reviewMtime?: (path: string) => number;
  /** Resolve the physical review path so a symlink cannot select a file outside the state directory. */
  reviewRealPath?: (path: string) => string;
  /** Resolve evidence sources for a typefix-carry receipt; absent or incomplete context is fail-closed. */
  loadTypefixCarryContext?: (receipt: TypefixCarryReceipt, receiptPath: string) => {
    input: ProveTypefixCarryInput;
    deps: TypefixCarryDeps;
  } | null;
  /** Persist the freshly re-proved canonical receipt only on a real landing attempt, never a dry-run. */
  persistTypefixCarryReceipt?: boolean;
  /** Test seam for persisted provenance stores; Git measurements and transpilation remain production code. */
  typefixCarryEvidenceSources?: Pick<TypefixCarryContextOptions, 'readEvents' | 'readGateReceipts'>;
  /** 겹침 관문이 찾은 «겹친» 최근 착지 커밋들 — 전부 머리의 조상이면 already-ancestor. */
  overlappingLandings?: readonly string[];
}

function checkSelectedReviewAttempts(input: VerifyOverlapEvidenceInput, e: Partial<OverlapEvidenceFile>, head: string): { ok: true } | { ok: false; reason: string } {
  const selected = e.reviewResult!;
  if (!input.reviewResultsDir || !input.listDir || !input.reviewMtime || !input.reviewRealPath) return { ok: false, reason: 'review-attempts-unmeasured' };
  const dir = input.reviewResultsDir;
  if (resolve(dirname(selected)) !== resolve(dir)) return { ok: false, reason: 'review-selected-outside-standard-dir' };
  let names: readonly string[];
  try { names = input.listDir(dir); } catch { return { ok: false, reason: 'review-attempts-unmeasured' }; }
  const filename = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]*-${input.pr}-([a-f0-9]{10,40})\\.json$`, 'i');
  const selectedHead = e.reviewCarry?.oldHead?.toLowerCase() ?? head;
  // A fresh review of the merged head supersedes carry. Never hide a failed current-head attempt.
  if (e.reviewCarry && names.some((name) => {
    const match = filename.exec(name);
    return Boolean(match && head.startsWith(match[1]!.toLowerCase()));
  })) return { ok: false, reason: 'carry-new-head-review-exists' };
  if (!e.reviewCarry && basename(selected).startsWith('typefix-carry-')) {
    let selectedRecord: Record<string, unknown> | null | undefined;
    try { selectedRecord = lastReviewRecord(input.readFile(selected)); } catch { return { ok: false, reason: 'review-attempts-unmeasured' }; }
    if (selectedRecord?.reviewer === 'typefix-carry') {
      for (const name of names) {
        const match = filename.exec(name);
        if (!match || !head.startsWith(match[1]!.toLowerCase())) continue;
        const candidate = join(dir, name);
        if (candidate === selected) continue;
        let candidateRecord: Record<string, unknown> | null | undefined;
        try { candidateRecord = lastReviewRecord(input.readFile(candidate)); }
        catch { return { ok: false, reason: 'review-attempts-unmeasured' }; }
        if (candidateRecord?.reviewer === 'typefix-carry') continue;
        if (checkReview(input, { reviewResult: candidate }, head).ok) return { ok: false, reason: 'carry-new-head-review-exists' };
      }
    }
  }
  const candidates = [...names].filter((name) => {
    const match = filename.exec(name);
    return Boolean(match && selectedHead.startsWith(match[1]!.toLowerCase()));
  }).map((name) => join(dir, name));
  if (!candidates.includes(selected)) return { ok: false, reason: 'review-selected-missing' };
  let physicalDir: string;
  let physicalParent: string;
  try {
    physicalDir = input.reviewRealPath(dir);
    physicalParent = input.reviewRealPath(dirname(dir));
  } catch { return { ok: false, reason: 'review-attempts-unmeasured' }; }
  if (resolve(physicalDir) !== resolve(join(physicalParent, basename(dir)))) {
    return { ok: false, reason: 'review-standard-dir-symlink' };
  }
  for (const path of candidates) {
    let physicalPath: string;
    try { physicalPath = input.reviewRealPath(path); } catch { return { ok: false, reason: 'review-attempts-unmeasured' }; }
    if (resolve(dirname(physicalPath)) !== resolve(physicalDir)) return { ok: false, reason: 'review-file-outside-standard-dir' };
  }
  const entries = e.supersedes;
  if (entries !== undefined && (!Array.isArray(entries) || entries.length === 0)) return { ok: false, reason: 'review-supersedes-invalid' };
  const superseded = new Map<string, string>();
  const resolvedPriorAccepted: string[] = [];
  const ignoredErrors: string[] = [];
  const errorCandidates = new Set<string>();
  for (const path of candidates) {
    if (path === selected) continue;
    const candidateReview = checkReview(input, { reviewResult: path }, selectedHead);
    if (candidateReview.ok === false && (candidateReview as { ok: false; reason: string }).reason === 'review-error') {
      errorCandidates.add(path);
      ignoredErrors.push(basename(path));
    }
  }
  let selectedTime: number | undefined;
  let selectedRecord: Record<string, unknown> | undefined;
  try { selectedRecord = lastReviewRecord(input.readFile(selected)); } catch { return { ok: false, reason: 'review-unreadable' }; }
  const hasResolvedPrior = hasResolvedPriorDeclaration(selectedRecord);
  if (selectedRecord?.reviewer === 'OP-waiver') {
    const waiver = validOpWaiver(selectedRecord, input.pr, selectedHead);
    if (!waiver.ok) return { ok: false, reason: waiver.reason };
    if (waiver.plainZeroFinding) {
      // A plain waiver has nothing to adjudicate. A real FAIL from an earlier head
      // still needs its established per-finding disposition, even if it is outside
      // the current-head candidate set below.
      for (const name of names) {
        if (!filename.test(name) || name === basename(selected)) continue;
        let prior: Record<string, unknown> | undefined;
        try { prior = lastReviewRecord(input.readFile(join(dir, name))); }
        catch { return { ok: false, reason: 'review-attempts-unmeasured' }; }
        if (String(prior?.pr) === String(input.pr) && prior?.reviewed === true && prior.verdict === 'fail') {
          return { ok: false, reason: 'review-op-waiver-dispositions-missing' };
        }
      }
    }
    const linkedSameHeadFailure = candidates.some((path) => {
      if (path === selected || !adjudicatesReviewFile(waiver.adjudicates, path)) return false;
      const failed = checkReview(input, { reviewResult: path }, selectedHead);
      return !failed.ok && /^review-(?:verdict-fail|must-fix-[1-9][0-9]*)$/.test(failed.reason)
        && reviewAttemptHasExactSameHeadFail(input, path, selectedHead);
    });
    const linkedPriorHeadFailure = names.some((name) => {
      const path = join(dir, name);
      if (!adjudicatesReviewFile(waiver.adjudicates, path)) return false;
      const prior = reviewAttemptHasTerraFailOnPriorHead(input, path, selectedHead);
      return prior !== undefined && waiverHasFixedAfterReviewDiffEvidence(selectedRecord!, path, prior, selectedHead, input.pr);
    });
    if (!waiver.plainZeroFinding && !linkedSameHeadFailure && !linkedPriorHeadFailure) {
      return { ok: false, reason: 'review-op-waiver-same-head-failure-missing' };
    }
  }
  const actionableSupersedes = (entries ?? []).some((entry) => typeof entry?.reviewResult === 'string' && !errorCandidates.has(entry.reviewResult));
  if (actionableSupersedes || hasResolvedPrior) {
    try { selectedTime = input.reviewMtime(selected); } catch { return { ok: false, reason: 'review-attempt-time-unmeasured' }; }
    if (!Number.isFinite(selectedTime)) return { ok: false, reason: 'review-attempt-time-unmeasured' };
  }
  for (const entry of entries ?? []) {
    if (entry && typeof entry.reviewResult === 'string' && errorCandidates.has(entry.reviewResult)) continue;
    if (!entry || typeof entry.reviewResult !== 'string' || typeof entry.reason !== 'string' || !entry.reason.trim()
      || !candidates.includes(entry.reviewResult) || entry.reviewResult === selected || superseded.has(entry.reviewResult)) {
      return { ok: false, reason: 'review-supersedes-invalid' };
    }
    superseded.set(entry.reviewResult, entry.reason);
    let failedTime: number;
    try { failedTime = input.reviewMtime(entry.reviewResult); } catch { return { ok: false, reason: 'review-attempt-time-unmeasured' }; }
    if (!Number.isFinite(failedTime) || selectedTime === undefined || failedTime >= selectedTime) {
      return { ok: false, reason: 'review-selected-not-later-than-failure' };
    }
  }
  for (const path of candidates) {
    if (path === selected) continue;
    const review = checkReview(input, { reviewResult: path }, selectedHead);
    if (review.ok) {
      if (superseded.has(path)) return { ok: false, reason: 'review-supersedes-passing' };
      continue;
    }
    const reviewReason = (review as { ok: false; reason: string }).reason;
    if (reviewReason === 'review-error') continue;
    if (superseded.has(path)) {
      if (superseded.get(path) !== reviewReason) return { ok: false, reason: `review-attempt-not-superseded: ${basename(path)} (${reviewReason})` };
      if (!/^review-(verdict-fail|must-fix-[1-9][0-9]*)$/.test(reviewReason)) {
        return { ok: false, reason: `review-supersedes-not-failed: ${basename(path)} (${reviewReason})` };
      }
      if (selectedRecord?.reviewer === 'OP-waiver') {
        if (!reviewAttemptExplicitlyResolved(input, selectedRecord, path, head)) {
          return { ok: false, reason: `review-attempt-not-superseded: ${basename(path)} (${reviewReason})` };
        }
        resolvedPriorAccepted.push(path);
      }
      continue;
    }
    if (!/^review-(verdict-fail|must-fix-[1-9][0-9]*)$/.test(reviewReason)
      || !selectedRecord || !reviewAttemptExplicitlyResolved(input, selectedRecord, path, head)) {
      return { ok: false, reason: `review-attempt-not-superseded: ${basename(path)} (${reviewReason})` };
    }
    resolvedPriorAccepted.push(path);
    let failedTime: number;
    try { failedTime = input.reviewMtime(path); } catch { return { ok: false, reason: 'review-attempt-time-unmeasured' }; }
    if (!Number.isFinite(failedTime) || selectedTime === undefined || failedTime >= selectedTime) {
      return { ok: false, reason: 'review-selected-not-later-than-failure' };
    }
  }
  // A fully validated OP waiver is itself the adjudication of the linked same-head
  // failures; requiring a second OPEN PR for those already-disposed findings deadlocks
  // the queue. reviewAttemptExplicitlyResolved has checked each finding and evidence.
  const adjudicatedByOpWaiver = selectedRecord?.reviewer === 'OP-waiver' && resolvedPriorAccepted.length > 0;
  if (actionableSupersedes && !adjudicatedByOpWaiver) {
    if (!Number.isSafeInteger(e.followupPr) || (e.followupPr as number) <= 0 || e.followupPr === input.pr) {
      return { ok: false, reason: 'review-followup-pr-invalid' };
    }
    const response = input.run('gh', ['pr', 'view', String(e.followupPr), '--json', 'state'], { cwd: input.cwd });
    if (!response.ok) return { ok: false, reason: 'review-followup-pr-unmeasured' };
    let state: unknown;
    try { state = JSON.parse(response.out); } catch { return { ok: false, reason: 'review-followup-pr-unmeasured' }; }
    if ((state as { state?: unknown })?.state !== 'OPEN') return { ok: false, reason: 'review-followup-pr-not-open' };
  } else if (!adjudicatedByOpWaiver && e.followupPr !== undefined && !entries?.every((entry) => typeof entry?.reviewResult === 'string' && errorCandidates.has(entry.reviewResult))) {
    return { ok: false, reason: 'review-followup-pr-without-supersedes' };
  }
  debug.log('pr.land', 'review-attempt-selection', {
    pr: input.pr,
    head,
    selected,
    superseded: [...superseded.entries()].map(([reviewResult, reason]) => ({ reviewResult, reason })),
    resolvedPriorAccepted,
    notes: ignoredErrors.map((candidate) => `ignored same-head error review candidate: ${candidate}`),
    followupPr: e.followupPr ?? null,
  });
  return { ok: true };
}

function lastReviewRecord(text: string): Record<string, unknown> | undefined {
  const lines = text.split('\n').reverse();
  for (const line of lines) {
    if (!line.trim().startsWith('{')) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const result = value as Record<string, unknown>;
    if (result.pr !== undefined && (('verdict' in result && Array.isArray(result.mustFix)) || typeof result.error === 'string')) return result;
  }
  return undefined;
}

const OP_WAIVER_DISPOSITIONS = new Set(['already-fixed', 'out-of-scope-followup', 'reviewer-error', 'fixed-after-review']);

function canonicalWaiverDisposition(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (OP_WAIVER_DISPOSITIONS.has(value)) return value;
  // These labels occur in OP's saved, approved adjudications; accept only their
  // narrow semantic aliases while new decisions use the canonical vocabulary.
  if (value === 'fixed-in-this-head') return 'already-fixed';
  if (value === 'evidence-provided' || value === 'reviewer-misread-contract') return 'reviewer-error';
  return undefined;
}

function opWaiverTestResult(value: unknown, head: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const run = value as Record<string, unknown>;
  if (typeof run.sha !== 'string' || run.sha.toLowerCase() !== head || (run.exit !== undefined && run.exit !== 0)) return false;
  const hasRunDescription = ['command', 'scope', 'rawOutput'].some((key) => typeof run[key] === 'string' && (run[key] as string).trim());
  if (!hasRunDescription) return false;
  let pass = typeof run.pass === 'number' && Number.isSafeInteger(run.pass) ? run.pass : undefined;
  let fail = typeof run.fail === 'number' && Number.isSafeInteger(run.fail) ? run.fail : undefined;
  if ((pass === undefined || fail === undefined) && run.tests && typeof run.tests === 'object' && !Array.isArray(run.tests)) {
    const rows = Object.values(run.tests as Record<string, unknown>);
    const parsed = rows.map((row) => typeof row === 'string' ? /^(\d+)\/(\d+)$/.exec(row) : null);
    if (rows.length > 0 && parsed.every(Boolean)) {
      pass = parsed.reduce((sum, row) => sum + Number(row![1]), 0);
      fail = parsed.reduce((sum, row) => sum + Number(row![2]), 0);
    }
  }
  return pass !== undefined && pass > 0 && fail === 0;
}

function validOpWaiver(record: Record<string, unknown> | undefined, pr: number, head: string):
  | { ok: true; adjudicates: string; findingCount: number; plainZeroFinding: boolean }
  | { ok: false; reason: string } {
  if (!record || record.reviewer !== 'OP-waiver') return { ok: false, reason: 'review-op-waiver-reviewer' };
  const waiver = record.waiver;
  if (!waiver || typeof waiver !== 'object' || Array.isArray(waiver)) return { ok: false, reason: 'review-op-waiver-missing' };
  const value = waiver as Record<string, unknown>;
  if (value.by !== 'OP' || typeof value.approvedBy !== 'string' || !value.approvedBy.trim()) {
    return { ok: false, reason: 'review-op-waiver-approval-missing' };
  }
  if (!opWaiverTestResult(value.headTestRun, head)) return { ok: false, reason: 'review-op-waiver-head-test-missing' };
  const dispositions = value.dispositions === undefined ? [] : value.dispositions;
  if (!Array.isArray(dispositions)) return { ok: false, reason: 'review-op-waiver-dispositions-missing' };
  const plainZeroFinding = dispositions.length === 0;
  if (plainZeroFinding) {
    if (value.adjudicates !== undefined && (typeof value.adjudicates !== 'string' || !/^\s*(?:none)?\s*$/i.test(value.adjudicates))) {
      return { ok: false, reason: 'review-op-waiver-dispositions-missing' };
    }
    if (record.reviewed !== true || record.verdict !== 'pass' || !Array.isArray(record.mustFix) || record.mustFix.length !== 0) {
      return { ok: false, reason: 'review-op-waiver-zero-finding-invalid' };
    }
  } else if (typeof value.adjudicates !== 'string' || !value.adjudicates.trim()) {
    return { ok: false, reason: 'review-op-waiver-adjudication-missing' };
  }
  const findings = new Set<number>();
  for (const raw of dispositions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'review-op-waiver-disposition-invalid' };
    const item = raw as Record<string, unknown>;
    if (!Number.isSafeInteger(item.finding) || (item.finding as number) < 1 || findings.has(item.finding as number)
      || !canonicalWaiverDisposition(item.disposition)
      || typeof item.evidence !== 'string' || !item.evidence.trim()) return { ok: false, reason: 'review-op-waiver-disposition-invalid' };
    if (canonicalWaiverDisposition(item.disposition) === 'out-of-scope-followup'
      && !/(?:#[1-9]\d*|\b[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+\b)/.test(item.evidence)) {
      return { ok: false, reason: 'review-op-waiver-followup-missing' };
    }
    findings.add(item.finding as number);
  }
  const ordered = [...findings].sort((a, b) => a - b);
  if (ordered.some((finding, index) => finding !== index + 1)) return { ok: false, reason: 'review-op-waiver-findings-incomplete' };
  const recordPr = typeof record.pr === 'number' ? record.pr : Number(record.pr);
  if (!Number.isSafeInteger(recordPr) || recordPr !== pr) return { ok: false, reason: 'review-op-waiver-pr-mismatch' };
  return { ok: true, adjudicates: typeof value.adjudicates === 'string' ? value.adjudicates : '', findingCount: findings.size, plainZeroFinding };
}

function adjudicatesReviewFile(adjudicates: string, path: string): boolean {
  return adjudicates.split(/[\s,;()]+/).includes(basename(path));
}

function hasResolvedPriorDeclaration(review: Record<string, unknown> | undefined): boolean {
  if (!review) return false;
  if (review.reviewer === 'OP-waiver' && review.waiver && typeof review.waiver === 'object' && !Array.isArray(review.waiver)) return true;
  const value = review.resolvedPrior;
  if (value === true) return true;
  if (Array.isArray(value) && value.length > 0) return true;
  if (value && typeof value === 'object' && Object.keys(value).length > 0) return true;
  return [review.intent, review.intentBlock, review.reviewIntent, review.reviewIntentBlock]
    .some((intent) => typeof intent === 'string' && /resolved prior|prior review findings resolved/i.test(intent));
}

function normalizedFinding(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

// `status open` / `status pending` in prose counts the same as `status: pending` in a field.
const UNRESOLVED_STATUS = /^(?:open|unresolved|pending|in[- ]progress)$/i;

function containsUnresolvedClaim(value: string): boolean {
  return /\b(?:unresolved|not(?:\s+yet)?[\s-]+resolved|not(?:\s+yet)?[\s-]+fixed|not(?:\s+yet)?[\s-]+addressed|still[\s-]+open|remains?[\s-]+open|still[\s-]+present|status\s*(?:[:=]\s*|\s+)(?:open|unresolved|pending|in[- ]progress))\b/i.test(value);
}

/** A record cannot claim resolution while carrying its own OPEN/PENDING status — refuse both fields. */
function unresolvedStatusDeclared(record: Record<string, unknown>): boolean {
  if (record.resolved === false) return true;
  return ['status', 'resolutionStatus', 'resolution']
    .some((key) => {
      const value = record[key];
      return typeof value === 'string' && UNRESOLVED_STATUS.test(value.trim());
    });
}

function containsUnresolvedDeclaration(value: unknown): boolean {
  if (typeof value === 'string') return containsUnresolvedClaim(value);
  if (Array.isArray(value)) return value.some(containsUnresolvedDeclaration);
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (unresolvedStatusDeclared(record)) return true;
  return Object.values(record).some(containsUnresolvedDeclaration);
}

function referencesReview(value: unknown, path: string): boolean {
  return typeof value === 'string' && (value === path || value === basename(path));
}

function findingList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return values.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

/** A later same-head pass/mf0 review may resolve prior attempts only when it names every finding explicitly. */
function reviewAttemptExplicitlyResolved(input: VerifyOverlapEvidenceInput, selected: Record<string, unknown>, failedPath: string, head: string): boolean {
  let failed: Record<string, unknown> | undefined;
  try { failed = lastReviewRecord(input.readFile(failedPath)); } catch { return false; }
  if (!failed || failed.pr === undefined || String(failed.pr) !== String(input.pr)
    || typeof failed.headCommit !== 'string' || failed.headCommit.toLowerCase() !== head
    || (typeof failed.currentHeadCommit === 'string' && failed.currentHeadCommit.toLowerCase() !== head)) return false;
  const rawFindings = findingList(failed.mustFix).map((finding) => finding.trim());
  const findings = rawFindings.map(normalizedFinding);
  if (findings.length === 0) return false;

  const waiver = validOpWaiver(selected, input.pr, head);
  if (waiver.ok) {
    if (failed.reviewed !== true || failed.verdict !== 'fail' || rawFindings.length === 0) return false;
    return adjudicatesReviewFile(waiver.adjudicates, failedPath) && waiver.findingCount === rawFindings.length;
  }

  const declared = selected.resolvedPrior;
  if (declared !== undefined && declared !== false && containsUnresolvedDeclaration(declared)) return false;
  const intentBlocks = [selected.intent, selected.intentBlock, selected.reviewIntent, selected.reviewIntentBlock]
    .filter((value): value is string => typeof value === 'string');
  // A resolution in one field cannot override an OPEN/PENDING declaration in another.
  if (intentBlocks.some(containsUnresolvedClaim)) return false;
  // Contradiction axis 1 (structured): the record declares the prior attempt resolved while a
  // separate lifecycle field still says open/pending — neither claim can be trusted, so refuse.
  const declaresResolution = (declared !== undefined && declared !== false)
    || intentBlocks.some((intent) => /^resolved prior review findings:\s*$/im.test(intent));
  if (declaresResolution && unresolvedStatusDeclared(selected)) return false;

  let resolved: string[] = [];
  if (Array.isArray(declared)) {
    for (const entry of declared) {
      if (typeof entry === 'string') {
        if (containsUnresolvedClaim(entry)) continue;
        // A string can be an exact finding axis or an explicit "filename: finding" row.
        const line = entry.trim();
        if (rawFindings.includes(line)) resolved.push(line);
        const prefix = `${basename(failedPath)}: `;
        if (line.startsWith(prefix)) {
          const declaredFinding = line.slice(prefix.length).trim();
          const index = rawFindings.indexOf(declaredFinding);
          if (index >= 0) resolved.push(findings[index]!);
        }
        continue;
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const item = entry as Record<string, unknown>;
      const ref = item.reviewResult ?? item.review ?? item.path;
      if (ref !== undefined && !referencesReview(ref, failedPath)) continue;
      if (item.head !== undefined && (typeof item.head !== 'string' || item.head.toLowerCase() !== head)) continue;
      if (item.headCommit !== undefined && (typeof item.headCommit !== 'string' || item.headCommit.toLowerCase() !== head)) continue;
      if (unresolvedStatusDeclared(item)
        || Object.values(item).some((value) => typeof value === 'string' && containsUnresolvedClaim(value))) continue;
      const listed = findingList(item.mustFix ?? item.resolvedMustFix ?? item.findings ?? item.axes ?? item.finding ?? item.axis);
      if (listed.some(containsUnresolvedClaim)) continue;
      if (ref === undefined && listed.every((finding) => rawFindings.includes(finding.trim()))) {
        resolved.push(...listed.filter((finding) => rawFindings.includes(finding.trim())));
      } else if (ref !== undefined) {
        resolved.push(...listed.filter((finding) => rawFindings.includes(finding.trim())));
      }
    }
  } else if (declared && typeof declared === 'object') {
    const record = declared as Record<string, unknown>;
    const value = record[failedPath] ?? record[basename(failedPath)];
    resolved.push(...findingList(value).filter((finding) => !containsUnresolvedClaim(finding) && rawFindings.includes(finding.trim())));
  }

  for (const intent of intentBlocks) {
    const lines = intent.split(/\r?\n/);
    const header = lines.findIndex((line) => /^resolved prior review findings:\s*$/i.test(line.trim()));
    if (header < 0) continue;
    // Only explicit rows under the resolution header count. A finding quoted in
    // background prose is evidence of context, not a declaration of repair.
    const prefix = `- ${basename(failedPath)}:`;
    for (const raw of lines.slice(header + 1)) {
      const line = raw.trim();
      if (!line) continue;
      if (!line.startsWith('- ')) break;
      if (!line.startsWith(prefix)) continue;
      const declaredFinding = line.slice(prefix.length).trim();
      const index = rawFindings.indexOf(declaredFinding);
      if (index >= 0) resolved.push(findings[index]!);
    }
  }
  const resolvedSet = new Set(resolved.map(normalizedFinding));
  return findings.every((finding) => resolvedSet.has(finding));
}

function reviewAttemptHasExactSameHeadFail(input: VerifyOverlapEvidenceInput, failedPath: string, head: string): boolean {
  let failed: Record<string, unknown> | undefined;
  try { failed = lastReviewRecord(input.readFile(failedPath)); } catch { return false; }
  return Boolean(failed && failed.pr !== undefined && String(failed.pr) === String(input.pr)
    && failed.reviewed === true && failed.verdict === 'fail'
    && typeof failed.headCommit === 'string' && failed.headCommit.toLowerCase() === head
    && findingList(failed.mustFix).length > 0);
}

function reviewAttemptHasTerraFailOnPriorHead(input: VerifyOverlapEvidenceInput, failedPath: string, currentHead: string):
  { head: string; findings: string[]; changedPaths: ReadonlySet<string> } | undefined {
  const name = new RegExp(`^pr-${input.pr}-([a-f0-9]{12})\\.json$`, 'i').exec(basename(failedPath));
  if (!name || !input.reviewResultsDir || !input.reviewRealPath) return undefined;
  let physicalDir: string;
  let physicalPath: string;
  try {
    physicalDir = input.reviewRealPath(input.reviewResultsDir);
    physicalPath = input.reviewRealPath(failedPath);
  } catch { return undefined; }
  if (resolve(dirname(physicalPath)) !== resolve(physicalDir)) return undefined;

  let failed: Record<string, unknown> | undefined;
  try { failed = lastReviewRecord(input.readFile(failedPath)); } catch { return undefined; }
  const priorHead = typeof failed?.headCommit === 'string' ? failed.headCommit.toLowerCase() : '';
  const modelFields = [failed?.model, failed?.requestedModel, failed?.respondedModel]
    .filter((value): value is string => typeof value === 'string').map((value) => value.toLowerCase());
  const findings = findingList(failed?.mustFix);
  if (!failed || failed.pr === undefined || String(failed.pr) !== String(input.pr)
    || failed.reviewed !== true || failed.verdict !== 'fail'
    || !SHA40.test(priorHead) || priorHead === currentHead
    || !priorHead.startsWith(name[1]!.toLowerCase())
    || !modelFields.includes('gpt-6.1-terra') || findings.length === 0) return undefined;
  const ancestor = input.run('git', ['merge-base', '--is-ancestor', priorHead, currentHead], { cwd: input.cwd });
  if (!ancestor.ok) return undefined;
  const changed = input.run('git', ['diff', '--name-only', '--no-renames', `${priorHead}..${currentHead}`], { cwd: input.cwd });
  if (!changed.ok) return undefined;
  const changedPaths = new Set(changed.out.split(/\r?\n/).map((path) => path.trim()).filter(Boolean));
  if (changedPaths.size === 0) return undefined;
  return { head: priorHead, findings, changedPaths };
}

function waiverHasFixedAfterReviewDiffEvidence(
  record: Record<string, unknown>, failedPath: string,
  prior: { head: string; findings: string[]; changedPaths: ReadonlySet<string> }, currentHead: string, pr: number,
): boolean {
  const waiver = record.waiver;
  if (!waiver || typeof waiver !== 'object' || Array.isArray(waiver)) return false;
  const value = waiver as Record<string, unknown>;
  if (!adjudicatesReviewFile(String(value.adjudicates ?? ''), failedPath)
    || !opWaiverTestResult(value.headTestRun, currentHead)
    || !Array.isArray(value.dispositions) || value.dispositions.length !== prior.findings.length) return false;
  const rows = new Map<number, Record<string, unknown>>();
  for (const raw of value.dispositions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const row = raw as Record<string, unknown>;
    if (!Number.isSafeInteger(row.finding) || rows.has(row.finding as number)) return false;
    rows.set(row.finding as number, row);
  }
  if (rows.size !== prior.findings.length) return false;
  for (let finding = 1; finding <= prior.findings.length; finding++) {
    const row = rows.get(finding);
    if (!row || row.disposition !== 'fixed-after-review' || typeof row.evidence !== 'string' || !row.evidence.trim()) return false;
    const evidenceTokens = new Set(row.evidence.split(/\s+/).map((token) => token
      .replace(/^[`"'([{]+|[`"',;:)}\]]+$/g, '').replace(/:\d+(?:-\d+)?$/, '')));
    if (![...prior.changedPaths].some((path) => evidenceTokens.has(path))) return false;
  }
  return Number(record.pr) === pr && prior.head !== currentHead;
}

type EvidenceReviewCheck =
  | { ok: false; reason: string; baseTip?: string }
  | { ok: true; reviewResult: string; evidence: Partial<OverlapEvidenceFile>; virtualCarry?: boolean; virtualReceipt?: TypefixCarryReceipt;
      carryEvents?: { event: 'typefix-carry-accepted' | 'typefix-carry-refused'; fields: Record<string, unknown> }[] };

function persistSelectedCarry(input: VerifyOverlapEvidenceInput, selected: EvidenceReviewCheck): { ok: true } | { ok: false; reason: string } {
  if (!selected.ok) return { ok: false, reason: 'carry-unmeasured' };
  if (selected.virtualReceipt && input.persistTypefixCarryReceipt) {
    if (!input.reviewResultsDir) return { ok: false, reason: 'carry-unmeasured' };
    try {
      const written = writeTypefixCarryReceipt(input.reviewResultsDir, selected.virtualReceipt);
      if (written !== selected.reviewResult || input.readFile(written) !== `${JSON.stringify(selected.virtualReceipt, null, 2)}\n`) {
        return { ok: false, reason: 'carry-unmeasured' };
      }
    } catch { return { ok: false, reason: 'carry-unmeasured' }; }
  }
  for (const item of selected.carryEvents ?? []) debug.log('pr.land', item.event, item.fields);
  return { ok: true };
}

function checkVirtualCarryAttempts(input: VerifyOverlapEvidenceInput, evidence: Partial<OverlapEvidenceFile>, head: string): { ok: true } | { ok: false; reason: string } {
  if (!input.reviewResultsDir || !input.listDir || !input.reviewRealPath || !evidence.reviewResult
    || resolve(dirname(evidence.reviewResult)) !== resolve(input.reviewResultsDir)) return { ok: false, reason: 'review-attempts-unmeasured' };
  try {
    const dir = input.reviewRealPath(input.reviewResultsDir);
    const parent = input.reviewRealPath(dirname(input.reviewResultsDir));
    if (resolve(dir) !== resolve(join(parent, basename(input.reviewResultsDir)))) return { ok: false, reason: 'review-standard-dir-symlink' };
  } catch { return { ok: false, reason: 'review-attempts-unmeasured' }; }
  let names: readonly string[];
  try { names = input.listDir(input.reviewResultsDir); } catch { return { ok: false, reason: 'review-attempts-unmeasured' }; }
  const sameHead = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]*-${input.pr}-([a-f0-9]{10,40})\\.json$`, 'i');
  for (const name of names) {
    const match = sameHead.exec(name);
    if (!match || !head.startsWith(match[1]!.toLowerCase()) || name.startsWith(`typefix-carry-${input.pr}-`)) continue;
    return { ok: false, reason: 'carry-new-head-review-exists' };
  }
  return { ok: true };
}

/** An error artifact is not a verdict; when the evidence points at one, find a valid same-head review. */
function selectEvidenceReview(input: VerifyOverlapEvidenceInput, evidence: Partial<OverlapEvidenceFile>, head: string, baseTip?: string): EvidenceReviewCheck {
  const primary = checkReview(input, evidence, head, baseTip);
  if (primary.ok) return { ...primary, evidence };
  const refusal = primary as { ok: false; reason: string; baseTip?: string };
  if (refusal.reason !== 'review-error' || !input.reviewResultsDir || !input.listDir) return refusal;
  let names: readonly string[];
  try { names = input.listDir(input.reviewResultsDir); } catch { return primary; }
  const filename = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]*-${input.pr}-([a-f0-9]{10,40})\\.json$`, 'i');
  for (const name of [...names].sort()) {
    const match = filename.exec(name);
    if (!match || !head.startsWith(match[1]!.toLowerCase())) continue;
    const candidate = join(input.reviewResultsDir, name);
    if (candidate === evidence.reviewResult) continue;
    const result = checkReview(input, { reviewResult: candidate }, head, baseTip);
    if (result.ok) return { ...result, evidence: { ...evidence, reviewResult: candidate } };
  }
  return primary;
}

type Checked = { ok: false; reason: string; baseTip?: string; gateBase?: string; windowCommits?: number }
  | (OverlapEvidenceVerdict & { ok: true; baseTip?: string });

/** 리뷰가 받는 판정 — 자동 병합(canAuto)·TA 착지(TA-LAND-WARN-MUSTFIX0)와 같은 집합. */
const ACCEPTED_REVIEW_VERDICTS: ReadonlySet<string> = new Set(['pass', 'warn']);
const COMMIT_MARK = '\u0001';

function checkReview(input: Pick<VerifyOverlapEvidenceInput, 'pr' | 'readFile'> & Partial<Pick<VerifyOverlapEvidenceInput, 'cwd' | 'remote' | 'branch' | 'reviewResultsDir' | 'loadTypefixCarryContext' | 'persistTypefixCarryReceipt' | 'typefixCarryEvidenceSources'>>,
  e: Partial<OverlapEvidenceFile>, head: string, baseTip?: string): { ok: false; reason: string; baseTip?: string } | { ok: true; reviewResult: string; virtualCarry?: boolean; virtualReceipt?: TypefixCarryReceipt;
    carryEvents?: { event: 'typefix-carry-accepted' | 'typefix-carry-refused'; fields: Record<string, unknown> }[] } {
  if (typeof e.reviewResult !== 'string' || !e.reviewResult) return { ok: false, reason: 'review-missing', baseTip };
  const carry = e.reviewCarry;
  const reviewHead = carry?.oldHead?.toLowerCase() ?? head;
  if (carry && (!SHA40.test(reviewHead) || reviewHead === head)) return { ok: false, reason: 'carry-invalid-old-head', baseTip };
  // TA 가 받는 자리(`<state>/review-results/<card>-<pr>-<head접두 10~40>.json` · reviewResultPath)만; 내용의 전체 head도 확인한다.
  const resultName = basename(e.reviewResult);
  const resultMatch = /^([A-Za-z0-9][A-Za-z0-9._-]*)-(\d+)-([a-f0-9]{10,40})\.json$/i.exec(resultName);
  if (basename(dirname(e.reviewResult)) !== 'review-results'
    || !resultMatch
    || Number(resultMatch[2]) !== input.pr
    || resultMatch[3]!.length < 10
    || !reviewHead.startsWith(resultMatch[3]!.toLowerCase())) {
    return { ok: false, reason: 'review-path-not-for-this-pr-head', baseTip };
  }
  let text: string;
  try { text = input.readFile(e.reviewResult); } catch {
    const candidateName = `typefix-carry-${input.pr}-${head.slice(0, 12)}.json`;
    if (basename(e.reviewResult) !== candidateName || !input.reviewResultsDir
      || !input.cwd || !input.remote || !input.branch) return { ok: false, reason: 'review-unreadable', baseTip };
    const contextOptions: TypefixCarryContextOptions = {
      cwd: input.cwd, remote: input.remote, branch: input.branch, reviewResultsDir: input.reviewResultsDir,
      ...input.typefixCarryEvidenceSources,
    };
    const candidate = buildTypefixCarryCandidate(input.pr, head, e.reviewResult, contextOptions);
    if (!candidate) return { ok: false, reason: 'carry-unmeasured', baseTip };
    const loader = input.loadTypefixCarryContext ?? ((record: TypefixCarryReceipt, path: string) =>
      loadProductionTypefixCarryContext(record, path, contextOptions));
    let context: ReturnType<typeof loader>;
    try { context = loader(candidate, e.reviewResult); } catch { return { ok: false, reason: 'carry-unmeasured', baseTip }; }
    if (!context) return { ok: false, reason: 'carry-unmeasured', baseTip };
    const candidateEvents: { event: 'typefix-carry-accepted' | 'typefix-carry-refused'; fields: Record<string, unknown> }[] = [];
    const proof = proveTypefixCarry(context.input, { ...context.deps, log: (event, fields) => candidateEvents.push({ event, fields }) });
    if (!proof.ok) return { ok: false, reason: proof.reason, baseTip };
    return { ok: true, reviewResult: e.reviewResult, virtualCarry: true, virtualReceipt: proof.receipt, carryEvents: candidateEvents };
  }
  let carryRecord = lastReviewRecord(text);
  if (!carryRecord && basename(e.reviewResult).startsWith(`typefix-carry-${input.pr}-`)) {
    try {
      const value: unknown = JSON.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value)
        && (value as Record<string, unknown>).reviewer === 'typefix-carry') {
        carryRecord = value as Record<string, unknown>;
      }
    } catch { /* the ordinary line-oriented review parser reports malformed evidence */ }
  }
  const review = parseReviewResultOutput(carryRecord?.reviewer === 'typefix-carry' ? JSON.stringify(carryRecord) : text);
  if (!review) return { ok: false, reason: 'review-no-result', baseTip };
  if (review.pr !== input.pr) return { ok: false, reason: 'review-pr-mismatch', baseTip };
  if (!review.head || review.head.toLowerCase() !== reviewHead) return { ok: false, reason: 'review-head-mismatch', baseTip };
  // The capture parser projects away model provenance; inspect the same last result-shaped line here.
  const raw = lastReviewRecord(text);
  let acpClaudeEvidence: { actualBackend: string; model: string; reviewRoute: string } | undefined;
  if (raw) {
    if (raw.reviewer === 'OP-waiver') {
      const waiver = validOpWaiver(raw, input.pr, head);
      if (!waiver.ok) return { ok: false, reason: waiver.reason, baseTip };
    }
    const actualBackend = typeof raw.actualBackend === 'string' ? raw.actualBackend.trim().toLowerCase() : '';
    const model = typeof raw.model === 'string' ? raw.model.trim().toLowerCase() : '';
    const route = typeof raw.reviewRoute === 'string' ? raw.reviewRoute.trim().toLowerCase() : '';
    const respondedProvider = typeof raw.respondedProvider === 'string' ? raw.respondedProvider.trim().toLowerCase() : '';
    const respondedModel = typeof raw.respondedModel === 'string' ? raw.respondedModel.trim().toLowerCase() : '';
    // PRLAND-ACP-CLAUDE-ALLOW — `acp:claude` is no longer refused outright. A review that satisfies
    // the landing contract below (same PR/head, reviewed, pass|warn, counted must-fix 0) is evidence
    // whatever backend produced it; a failed acp:claude attempt is excluded by the same-head
    // supersedes ledger instead of blocking every landing. This note records the provenance only —
    // the contract below still decides, so an invalid or other-head acp:claude review stays rejected.
    if (actualBackend === 'acp:claude' || actualBackend.startsWith('acp:claude/')
      || model === 'acp:claude' || model.startsWith('acp:claude/')
      || ((route === 'acp' || route === 'acp-fallback') && typeof raw.fallbackBackend === 'string' && raw.fallbackBackend.trim().toLowerCase() === 'claude')) {
      acpClaudeEvidence = { actualBackend, model, reviewRoute: route };
    }
    const requested = typeof raw.requestedModel === 'string' ? raw.requestedModel.trim().toLowerCase() : '';
    if (requested) {
      const requestedAcpBackend = requested.startsWith('acp:') ? requested.split('/')[0] : '';
      // Only explicit provider-qualified forms identify a provider here. Bare model IDs
      // (for example claude-sonnet-4 or gpt-6-sol) cannot be compared to a provider name.
      const apiProvider = requested.startsWith('openrouter/') ? 'openrouter'
        : requested.startsWith('local:') ? 'local' : '';
      const expectedResponseModel = requested.startsWith('openrouter/') ? requested.slice('openrouter/'.length) : requested;
      const mismatch = (model !== '' && model !== requested)
        || (actualBackend !== '' && (requestedAcpBackend ? actualBackend !== requestedAcpBackend : actualBackend !== 'api'
          && (apiProvider === '' || actualBackend !== apiProvider)))
        || (route !== '' && route !== (requestedAcpBackend ? 'acp' : 'api'))
        || (!requestedAcpBackend && apiProvider !== '' && respondedProvider !== '' && respondedProvider !== apiProvider)
        || (!requestedAcpBackend && respondedModel !== '' && respondedModel !== expectedResponseModel
          && respondedModel !== requested);
      if (mismatch) console.warn(`⚠ overlap-evidence: review provider mismatch — requestedModel=${requested} actualBackend=${actualBackend || 'unmeasured'} model=${model || 'unmeasured'} reviewRoute=${route || 'unmeasured'} respondedProvider=${respondedProvider || 'unmeasured'} respondedModel=${respondedModel || 'unmeasured'} (${e.reviewResult})`);
    }
  }
  if (review.error) return { ok: false, reason: 'review-error', baseTip };
  if (review.reviewed !== true) return { ok: false, reason: 'review-not-reviewed', baseTip };
  if (review.verdict === null || !ACCEPTED_REVIEW_VERDICTS.has(review.verdict)) return { ok: false, reason: `review-verdict-${review.verdict ?? 'null'}`, baseTip };
  if (review.mustFix !== 0) return { ok: false, reason: review.mustFix === null ? 'review-must-fix-unknown' : `review-must-fix-${review.mustFix}`, baseTip };
  const typefixCarryFilename = basename(e.reviewResult).startsWith(`typefix-carry-${input.pr}-`);
  if (typefixCarryFilename || carryRecord?.reviewer === 'typefix-carry') {
    const rejectCarry = (reason: string) => {
      debug.log('pr.land', 'typefix-carry-refused', {
        pr: input.pr, fromHead: carryRecord?.carry && typeof carryRecord.carry === 'object'
          ? (carryRecord.carry as Record<string, unknown>).fromHead ?? null : null,
        newHead: head, reason,
      });
      return { ok: false as const, reason, baseTip };
    };
    if (basename(e.reviewResult) !== `typefix-carry-${input.pr}-${head.slice(0, 12)}.json`) {
      return rejectCarry('carry-unmeasured');
    }
    const contextLoader = input.loadTypefixCarryContext ?? (input.cwd && input.remote && input.branch && input.reviewResultsDir
      ? (record: TypefixCarryReceipt, path: string) => loadProductionTypefixCarryContext(record, path, {
        cwd: input.cwd!, remote: input.remote!, branch: input.branch!, reviewResultsDir: input.reviewResultsDir!,
        ...input.typefixCarryEvidenceSources,
      }) : undefined);
    if (!contextLoader || carryRecord?.reviewer !== 'typefix-carry' || carryRecord.pr !== input.pr || carryRecord.headCommit !== head
      || carryRecord.reviewed !== true || !ACCEPTED_REVIEW_VERDICTS.has(String(carryRecord.verdict))
      || !Array.isArray(carryRecord.mustFix) || carryRecord.mustFix.length !== 0) {
      return rejectCarry('carry-unmeasured');
    }
    let context: ReturnType<NonNullable<typeof input.loadTypefixCarryContext>>;
    try { context = contextLoader(carryRecord as unknown as TypefixCarryReceipt, e.reviewResult); }
    catch { return rejectCarry('carry-unmeasured'); }
    if (!context || !context.input || !context.deps) return rejectCarry('carry-unmeasured');
    const carryEvents: { event: 'typefix-carry-accepted' | 'typefix-carry-refused'; fields: Record<string, unknown> }[] = [];
    const proof = proveTypefixCarry(context.input, {
      ...context.deps,
      log: (event, fields) => carryEvents.push({ event, fields }),
    });
    if (!proof.ok) {
      if (carryEvents.length === 0) return rejectCarry(proof.reason);
      for (const item of carryEvents) {
        if (context.deps.log) context.deps.log(item.event, item.fields);
        else debug.log('pr.land', item.event, item.fields);
      }
      return { ok: false, reason: proof.reason, baseTip };
    }
    const canonical = JSON.stringify(proof.receipt);
    let refreshReceipt: TypefixCarryReceipt | undefined;
    if (JSON.stringify(carryRecord) !== canonical) {
      if (input.persistTypefixCarryReceipt && !input.reviewResultsDir) return rejectCarry('carry-unmeasured');
      refreshReceipt = proof.receipt;
    }
    return { ok: true, reviewResult: e.reviewResult, carryEvents,
      ...(refreshReceipt ? { virtualCarry: true, virtualReceipt: refreshReceipt } : {}) };
  }
  if (acpClaudeEvidence) {
    debug.log('pr.land', 'review-acp-claude-accepted', { pr: input.pr, head, reviewResult: e.reviewResult, ...acpClaudeEvidence });
  }
  if (carry) {
    if (!input.cwd || !input.remote || !input.branch) return { ok: false, reason: 'carry-repo-unmeasured', baseTip };
    const digest = createHash('sha256').update(text).digest('hex');
    if (carry.reviewSha256 !== digest) return { ok: false, reason: 'carry-review-hash-mismatch', baseTip };
    const proof = proveReviewCarry(input.cwd, reviewHead, head, input.remote, input.branch);
    if (!proof.ok) return { ok: false, reason: proof.reason, baseTip };
    const gate = e.gate;
    if (!gate || gate.passed !== true || gate.head?.toLowerCase() !== head
      || gate.baseCommit?.toLowerCase() !== proof.newBase) {
      return { ok: false, reason: 'carry-new-head-gate-missing-or-mismatch', baseTip };
    }
    if (carry.oldBase?.toLowerCase() !== proof.oldBase || carry.newBase?.toLowerCase() !== proof.newBase
      || carry.patchId?.toLowerCase() !== proof.patchId || carry.pathsModesHash?.toLowerCase() !== proof.pathsModesHash) {
      return { ok: false, reason: 'carry-proof-mismatch', baseTip };
    }
    debug.log('pr.land', 'review-carry', { pr: input.pr, remote: input.remote, branch: input.branch,
      oldHead: reviewHead, newHead: head, oldBase: proof.oldBase,
      newBase: proof.newBase, patchId: proof.patchId, reviewSha256: digest, decision: 'accepted' });
  }
  return { ok: true, reviewResult: e.reviewResult };
}

/** Reuse the evidence-selected review when a pinned head needs a read-only virtual rebase. */
export function verifyOverlapEvidenceVirtualRebase(input: VerifyOverlapEvidenceInput, baseTip: string):
  { ok: true; reviewResult: string; patchId: string } | { ok: false; reason: string; baseTip?: string } {
  const head = input.expectedHead.toLowerCase();
  if (!SHA40.test(head) || !SHA40.test(baseTip)) return { ok: false, reason: 'virtual-rebase-invalid-sha' };
  let raw: unknown;
  try { raw = JSON.parse(input.readFile(input.evidencePath)); }
  catch { return { ok: false, reason: 'evidence-unreadable' }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'evidence-not-object' };
  const evidence = raw as Partial<OverlapEvidenceFile>;
  const evidencePr = typeof evidence.pr === 'number' ? evidence.pr
    : typeof evidence.pr === 'string' && /^[0-9]+$/.test(evidence.pr) ? Number(evidence.pr) : NaN;
  if (!Number.isSafeInteger(evidencePr) || evidencePr !== input.pr) return { ok: false, reason: 'evidence-pr-mismatch' };
  if (typeof evidence.head !== 'string' || evidence.head.toLowerCase() !== head) return { ok: false, reason: 'evidence-head-mismatch' };
  const gate = evidence.gate;
  if (!gate || typeof gate !== 'object') return { ok: false, reason: 'gate-missing' };
  if (gate.passed !== true) return { ok: false, reason: 'gate-not-passed' };
  if (typeof gate.head !== 'string' || gate.head.toLowerCase() !== head) return { ok: false, reason: 'gate-head-mismatch' };
  if (typeof gate.baseCommit !== 'string' || !SHA40.test(gate.baseCommit)) return { ok: false, reason: 'gate-base-unmeasured' };
  const selectedReview = selectEvidenceReview(input, evidence, head, baseTip);
  if (!selectedReview.ok) return selectedReview;
  const review = selectedReview;
  const attempts = selectedReview.virtualCarry
    ? checkVirtualCarryAttempts(input, selectedReview.evidence, head)
    : checkSelectedReviewAttempts(input, selectedReview.evidence, head);
  if (!attempts.ok) return attempts;
  const remote = input.run('git', ['ls-remote', input.remote, `refs/heads/${input.branch}`], { cwd: input.cwd });
  if (!remote.ok || remote.out.trim().split(/\s+/)[0]?.toLowerCase() !== baseTip.toLowerCase()) {
    return { ok: false, reason: 'virtual-rebase-base-advanced' };
  }
  const local = input.run('git', ['rev-parse', '--verify', `refs/remotes/${input.remote}/${input.branch}`], { cwd: input.cwd });
  if (!local.ok || local.out.trim().toLowerCase() !== baseTip.toLowerCase()) {
    return { ok: false, reason: 'virtual-rebase-base-stale-or-unmeasured' };
  }
  const patch = verifyVirtualRebasePatch({ cwd: input.cwd, baseTip, head });
  if (!patch.ok) return patch;
  const oldBase = patch.oldBase.toLowerCase();
  const gateBase = gate.baseCommit.toLowerCase();
  if (!input.run('git', ['merge-base', '--is-ancestor', gateBase, oldBase], { cwd: input.cwd }).ok) {
    return { ok: false, reason: 'gate-base-not-ancestor-of-old-base' };
  }
  const persistedCarry = persistSelectedCarry(input, selectedReview);
  if (!persistedCarry.ok) return persistedCarry;
  return { ok: true, reviewResult: review.reviewResult, patchId: patch.patchId };
}

/** Proof for the narrow path where the pinned gate/review passed, but the base advanced
 * with an overlapping append-only conflict that the normal virtual-rebase path cannot apply. */
export function verifyAppendOnlyConflictEvidence(input: VerifyOverlapEvidenceInput, baseTip: string):
  | { ok: false; reason: string }
  | { ok: true; gateBase: string; reviewResult: string } {
  const head = input.expectedHead.toLowerCase();
  if (!SHA40.test(head) || !SHA40.test(baseTip)) return { ok: false, reason: 'conflict-evidence-invalid-sha' };
  let raw: unknown;
  try { raw = JSON.parse(input.readFile(input.evidencePath)); }
  catch { return { ok: false, reason: 'evidence-unreadable' }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'evidence-not-object' };
  const evidence = raw as Partial<OverlapEvidenceFile>;
  const evidencePr = typeof evidence.pr === 'number' ? evidence.pr
    : typeof evidence.pr === 'string' && /^[0-9]+$/.test(evidence.pr) ? Number(evidence.pr) : NaN;
  if (!Number.isSafeInteger(evidencePr) || evidencePr !== input.pr) return { ok: false, reason: 'evidence-pr-mismatch' };
  if (typeof evidence.head !== 'string' || evidence.head.toLowerCase() !== head) return { ok: false, reason: 'evidence-head-mismatch' };
  const gate = evidence.gate;
  if (!gate || typeof gate !== 'object' || gate.passed !== true) return { ok: false, reason: 'gate-not-passed' };
  if (typeof gate.head !== 'string' || gate.head.toLowerCase() !== head) return { ok: false, reason: 'gate-head-mismatch' };
  if (typeof gate.baseCommit !== 'string' || !SHA40.test(gate.baseCommit)) return { ok: false, reason: 'gate-base-unmeasured' };
  const gateBase = gate.baseCommit.toLowerCase();
  if (!input.run('git', ['cat-file', '-e', `${gateBase}^{commit}`], { cwd: input.cwd }).ok
    || !input.run('git', ['merge-base', '--is-ancestor', gateBase, head], { cwd: input.cwd }).ok
    || !input.run('git', ['merge-base', '--is-ancestor', gateBase, baseTip], { cwd: input.cwd }).ok) {
    return { ok: false, reason: 'gate-base-not-common-ancestor' };
  }
  const remote = input.run('git', ['ls-remote', input.remote, `refs/heads/${input.branch}`], { cwd: input.cwd });
  if (!remote.ok || remote.out.trim().split(/\s+/)[0]?.toLowerCase() !== baseTip.toLowerCase()) {
    return { ok: false, reason: 'conflict-evidence-base-advanced' };
  }
  const selectedReview = selectEvidenceReview(input, evidence, head, baseTip);
  if (!selectedReview.ok) return { ok: false, reason: selectedReview.reason };
  const attempts = checkSelectedReviewAttempts(input, selectedReview.evidence, head);
  if (!attempts.ok) return { ok: false, reason: attempts.reason };
  return { ok: true, gateBase, reviewResult: selectedReview.reviewResult };
}

type WindowResult = { ok: true; windowCommits: number } | { ok: false; reason: string; windowCommits?: number };

/**
 * ②' — 재게이트 뒤 앞선 base 의 창 `gateBase..baseTip` 이 PR 의 바뀐 파일과 «서로소»인가. 읽기 전용 git 만 쓴다
 * (끝 커밋이 로컬에 없을 때만 ref 를 안 쓰는 fetch). `staleReason` 은 ⓐ(조상 아님)일 때 그대로 내는 종전 사유다.
 */
function checkBaseWindow(input: VerifyOverlapEvidenceInput, head: string, baseTip: string, gateBase: string, staleReason: string): WindowResult {
  const git = (args: string[]) => input.run('git', args, { cwd: input.cwd });
  const short = (sha: string) => sha.slice(0, 12);
  if (!git(['merge-base', '--is-ancestor', gateBase, head]).ok) {
    return { ok: false, reason: `${staleReason} (gate base is not an ancestor of head)` };
  }
  if (!git(['cat-file', '-e', `${baseTip}^{commit}`]).ok) {
    // ref 를 안 바꾸는 fetch — FETCH_HEAD 도 원격 추적 ref 도 안 쓴다.
    git(['fetch', '--quiet', '--no-write-fetch-head', '--refmap=', input.remote, `refs/heads/${input.branch}`]);
    if (!git(['cat-file', '-e', `${baseTip}^{commit}`]).ok) {
      return { ok: false, reason: `base-window-unmeasured: ${input.remote}/${input.branch} ${short(baseTip)} not available locally · ${staleReason}` };
    }
  }
  if (!git(['merge-base', '--is-ancestor', gateBase, baseTip]).ok) {
    return { ok: false, reason: `${staleReason} (gate base is not an ancestor of ${input.remote}/${input.branch})` };
  }
  const mergeBase = git(['merge-base', baseTip, head]);
  const forkPoint = mergeBase.ok ? mergeBase.out.trim() : '';
  if (!SHA40.test(forkPoint)) return { ok: false, reason: `base-window-unmeasured: merge-base ${short(baseTip)} ${short(head)} failed · ${staleReason}` };
  const diff = git(['diff', '--name-only', '--no-renames', forkPoint, head]);
  if (!diff.ok) return { ok: false, reason: `base-window-unmeasured: diff --name-only ${short(forkPoint)} ${short(head)} failed · ${staleReason}` };
  const prFiles = new Set(diff.out.split('\n').map((line) => line.trim()).filter(Boolean));
  if (prFiles.size === 0) return { ok: false, reason: `base-window-unmeasured: PR changed files are empty · ${staleReason}` };
  // 병합 커밋은 첫 부모 대비 diff(-m --first-parent) — base 에 «들어온» 변경만, 빠짐없이.
  const log = git(['log', '--first-parent', '-m', '--no-renames', '--name-only', `--format=${COMMIT_MARK}%H`, `${gateBase}..${baseTip}`]);
  if (!log.ok) return { ok: false, reason: `base-window-unmeasured: log ${short(gateBase)}..${short(baseTip)} failed · ${staleReason}` };
  const touched = new Map<string, string[]>();
  let current = '';
  for (const raw of log.out.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith(COMMIT_MARK)) { current = line.slice(COMMIT_MARK.length); if (!touched.has(current)) touched.set(current, []); continue; }
    if (current && prFiles.has(line)) touched.get(current)!.push(line);
  }
  const windowCommits = touched.size;
  if (windowCommits === 0 || [...touched.keys()].some((sha) => !SHA40.test(sha))) {
    return { ok: false, reason: `base-window-unmeasured: window ${short(gateBase)}..${short(baseTip)} listed no commits · ${staleReason}` };
  }
  const overlapping = [...touched.entries()].filter(([, files]) => files.length > 0);
  if (overlapping.length > 0) {
    const files = [...new Set(overlapping.flatMap(([, f]) => f))];
    return {
      ok: false,
      windowCommits,
      reason: `base-stale-overlap: gate ${short(gateBase)} ≠ ${input.remote}/${input.branch} ${short(baseTip)} · ${overlapping.length}/${windowCommits} window commits touch PR files (${overlapping.map(([sha]) => short(sha)).slice(0, 5).join(', ')}): ${files.slice(0, 10).join(', ')}`,
    };
  }
  return { ok: true, windowCommits };
}

function check(input: VerifyOverlapEvidenceInput): Checked {
  const head = input.expectedHead.toLowerCase();
  let raw: unknown;
  try { raw = JSON.parse(input.readFile(input.evidencePath)); } catch (error) {
    return { ok: false, reason: `evidence-unreadable: ${String((error as { message?: string })?.message ?? error).slice(0, 200)}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'evidence-not-object' };
  const e = raw as Partial<OverlapEvidenceFile>;
  const evidencePr = typeof e.pr === 'number' ? e.pr
    : typeof e.pr === 'string' && /^[0-9]+$/.test(e.pr) ? Number(e.pr) : NaN;
  const prMatches = Number.isSafeInteger(input.pr) && input.pr > 0
    && Number.isSafeInteger(evidencePr) && evidencePr === input.pr;
  if (!prMatches) return { ok: false, reason: `evidence-pr-mismatch: ${String(e.pr)} ≠ ${input.pr}` };
  if (typeof e.head !== 'string' || e.head.toLowerCase() !== head) return { ok: false, reason: 'evidence-head-mismatch' };

  // ⓐ 이미 조상 — 겹친 착지가 전부 머리 안에 있으면 그 머리의 게이트·리뷰가 이미 그것을 보고 쟀다.
  const landings = input.overlappingLandings ?? [];
  if (landings.length > 0 && landings.every((sha) => /^[0-9a-f]{7,40}$/i.test(sha)
    && input.run('git', ['merge-base', '--is-ancestor', sha, head], { cwd: input.cwd }).ok)) {
    const selectedReview = selectEvidenceReview(input, e, head);
    if (!selectedReview.ok) return selectedReview;
    const review = selectedReview;
    const attempts = selectedReview.virtualCarry
      ? checkVirtualCarryAttempts(input, selectedReview.evidence, head)
      : checkSelectedReviewAttempts(input, selectedReview.evidence, head);
    if (!attempts.ok) return attempts;
    const persistedCarry = persistSelectedCarry(input, selectedReview);
    return persistedCarry.ok ? { ok: true, mode: 'already-ancestor', reviewResult: review.reviewResult } : persistedCarry;
  }

  // ① 재기반 — 원격의 «지금» 끝을 읽기 전용으로 받는다(로컬 ref 를 안 바꾼다).
  const remote = input.run('git', ['ls-remote', input.remote, `refs/heads/${input.branch}`], { cwd: input.cwd });
  const baseTip = remote.ok ? remote.out.trim().split(/\s+/)[0] ?? '' : '';
  if (!SHA40.test(baseTip)) return { ok: false, reason: `rebase-unmeasured: ls-remote ${input.remote} ${input.branch} failed` };
  const ancestor = input.run('git', ['merge-base', '--is-ancestor', baseTip, head], { cwd: input.cwd });
  const gate = e.gate;
  // ②' 의 입구 — 게이트 기록이 «그 머리»를 통과했고 base 만 지금 끝과 다르다.
  const gateBase = gate && typeof gate === 'object' && gate.passed === true
    && typeof gate.head === 'string' && gate.head.toLowerCase() === head
    && typeof gate.baseCommit === 'string' && SHA40.test(gate.baseCommit) && gate.baseCommit.toLowerCase() !== baseTip.toLowerCase()
    ? gate.baseCommit.toLowerCase() : undefined;
  const advanced = (staleReason: string): Checked => {
    const window = checkBaseWindow(input, head, baseTip, gateBase!, staleReason);
    if (!window.ok) return { ok: false, reason: window.reason, baseTip, gateBase, windowCommits: window.windowCommits };
    const selectedReview = selectEvidenceReview(input, e, head, baseTip);
    if (!selectedReview.ok) return { ...selectedReview, gateBase, windowCommits: window.windowCommits };
    const review = selectedReview;
    const attempts = selectedReview.virtualCarry
      ? checkVirtualCarryAttempts(input, selectedReview.evidence, head)
      : checkSelectedReviewAttempts(input, selectedReview.evidence, head);
    if (!attempts.ok) return { ...attempts, gateBase, windowCommits: window.windowCommits };
    const persistedCarry = persistSelectedCarry(input, selectedReview);
    return persistedCarry.ok
      ? { ok: true, mode: 'base-advanced-disjoint', baseTip, gateBase: gateBase!, windowCommits: window.windowCommits, reviewResult: review.reviewResult }
      : { ...persistedCarry, gateBase, windowCommits: window.windowCommits };
  };
  if (!ancestor.ok) {
    const notRebased = `not-rebased: ${input.remote}/${input.branch} ${baseTip.slice(0, 12)} is not an ancestor of ${head.slice(0, 12)}`;
    return gateBase ? advanced(notRebased) : { ok: false, reason: notRebased, baseTip };
  }

  // ② 재게이트 — 그 머리를, ① 의 그 base 끝 위에서.
  if (!gate || typeof gate !== 'object') return { ok: false, reason: 'gate-missing', baseTip };
  if (gate.passed !== true) return { ok: false, reason: 'gate-not-passed', baseTip };
  if (typeof gate.head !== 'string' || gate.head.toLowerCase() !== head) return { ok: false, reason: 'gate-head-mismatch', baseTip };
  if (typeof gate.baseCommit !== 'string' || gate.baseCommit.toLowerCase() !== baseTip.toLowerCase()) {
    const stale = `gate-base-stale: gate ${String(gate.baseCommit).slice(0, 12)} ≠ ${input.remote}/${input.branch} ${baseTip.slice(0, 12)}`;
    return gateBase ? advanced(stale) : { ok: false, reason: stale, baseTip };
  }

  // ③ 리뷰 — 그 PR · 그 머리의 pass ⊕ must-fix 0.
  const selectedReview = selectEvidenceReview(input, e, head, baseTip);
  if (!selectedReview.ok) return selectedReview;
  const review = selectedReview;
  const attempts = selectedReview.virtualCarry
    ? checkVirtualCarryAttempts(input, selectedReview.evidence, head)
    : checkSelectedReviewAttempts(input, selectedReview.evidence, head);
  if (!attempts.ok) return attempts;
  const persistedCarry = persistSelectedCarry(input, selectedReview);
  return persistedCarry.ok ? { ok: true, mode: 'rebased', baseTip, reviewResult: review.reviewResult } : persistedCarry;
}

export type AncestorAutoVerdict =
  | { ok: true; mode: 'already-ancestor-auto'; reviewResult: string }
  | { ok: false; reason: string };

export interface VerifyAncestorAutoInput {
  pr: number;
  expectedHead: string;
  cwd: string;
  run: CmdRunner;
  readFile: (path: string) => string;
  /** 표준 자리 `<state>/review-results` — 이 안의 `*-<pr>-<head접두 10~40>.json`만 후보로 보고 내용의 전체 head를 확인한다. */
  reviewResultsDir: string;
  listDir: (dir: string) => readonly string[];
  /** 겹침 관문이 찾은 «겹친» 최근 착지 커밋들. */
  overlappingLandings: readonly string[];
}

/** Standard same-head reviews must all pass; a later passing review cannot hide a failed attempt. */
export function verifyAllSameHeadReviews(input: Pick<VerifyAncestorAutoInput, 'pr' | 'expectedHead' | 'readFile' | 'reviewResultsDir' | 'listDir'>):
  { ok: true; reviewResult: string } | { ok: false; reason: string } {
  const head = input.expectedHead.toLowerCase();
  let names: readonly string[];
  try { names = input.listDir(input.reviewResultsDir); } catch { return { ok: false, reason: 'review-missing' }; }
  const filename = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]*-${input.pr}-([a-f0-9]{10,40})\\.json$`, 'i');
  // 같은 PR·머리 접두의 리뷰가 여럿이면 «전부» 통과해야 한다 — 내용 headCommit 이 정확히 맞아야 승인한다.
  let accepted: string | undefined;
  const ignoredErrors: string[] = [];
  for (const name of [...names].filter((n) => {
    const match = filename.exec(n);
    return Boolean(match && match[1]!.length >= 10 && head.startsWith(match[1]!.toLowerCase()));
  }).sort()) {
    // The auto-ancestor landing path uses the same provider/forbidden-backend check as explicit evidence.
    const review = checkReview(input, { reviewResult: join(input.reviewResultsDir, name) }, head);
    if (review.ok === false) {
      const reason = (review as { ok: false; reason: string }).reason;
      if (reason === 'review-error') { ignoredErrors.push(name); continue; }
      return { ok: false, reason };
    }
    accepted = review.reviewResult;
  }
  const notes = ignoredErrors.map((name) => `ignored same-head error review candidate: ${name}`);
  if (notes.length) debug.log('pr.land', 'review-attempt-selection', { pr: input.pr, head, selected: accepted ?? null, notes });
  return accepted === undefined ? { ok: false, reason: ignoredErrors.length ? 'review-error' : 'review-missing' } : { ok: true, reviewResult: accepted };
}

function checkAncestorAuto(input: VerifyAncestorAutoInput): AncestorAutoVerdict {
  const head = input.expectedHead.toLowerCase();
  const landings = input.overlappingLandings;
  if (landings.length === 0) return { ok: false, reason: 'ancestor-auto-no-overlapping-landings' };
  const notAncestor = landings.find((sha) => !(/^[0-9a-f]{7,40}$/i.test(sha)
    && input.run('git', ['merge-base', '--is-ancestor', sha, head], { cwd: input.cwd }).ok));
  if (notAncestor !== undefined) return { ok: false, reason: `ancestor-auto-not-ancestor: ${notAncestor.slice(0, 12)} is not an ancestor of ${head.slice(0, 12)}` };
  const reviews = verifyAllSameHeadReviews(input);
  return reviews.ok ? { ok: true, mode: 'already-ancestor-auto', reviewResult: reviews.reviewResult } : reviews;
}

/**
 * 증거 파일이 없을 때의 already-ancestor 자동 판정 — 겹친 착지가 «전부» 고정 머리의 조상이고 표준 자리의 리뷰 결과가
 * pass|warn ⊕ must-fix 0 이면 통과. 던지지 않는다 — 어떤 실패도 거부(fail-closed)이고 관측 한 줄을 남긴다.
 */
export function verifyAncestorAutoPass(input: VerifyAncestorAutoInput): AncestorAutoVerdict {
  let verdict: AncestorAutoVerdict;
  try { verdict = checkAncestorAuto(input); } catch (error) { verdict = { ok: false, reason: `verify-threw: ${String(error).slice(0, 200)}` }; }
  debug.log('pr.land', 'overlap-evidence', {
    decision: verdict.ok ? 'accepted' : 'rejected',
    reason: verdict.ok ? 'already-ancestor-auto' : verdict.reason,
    overlappingLandings: input.overlappingLandings,
    pr: input.pr,
    head: input.expectedHead,
    evidencePath: null,
    reviewResultsDir: input.reviewResultsDir,
  });
  return verdict;
}

/** 던지지 않는다 — 어떤 실패도 거부(fail-closed)이고 관측 한 줄을 남긴다. */
export function verifyOverlapEvidence(input: VerifyOverlapEvidenceInput): OverlapEvidenceVerdict {
  let verdict: Checked;
  try { verdict = check(input); } catch (error) { verdict = { ok: false, reason: `verify-threw: ${String(error).slice(0, 200)}` }; }
  debug.log('pr.land', 'overlap-evidence', {
    decision: verdict.ok ? 'accepted' : 'rejected',
    reason: verdict.ok
      ? (verdict.mode === 'already-ancestor' ? 'already-ancestor' : verdict.mode === 'base-advanced-disjoint' ? 'base-advanced-disjoint' : 'rebased+gated+reviewed')
      : verdict.reason,
    overlappingLandings: input.overlappingLandings ?? [],
    pr: input.pr,
    head: input.expectedHead,
    base: `${input.remote}/${input.branch}`,
    baseTip: verdict.baseTip ?? null,
    evidencePath: input.evidencePath,
    gateBase: (verdict.ok ? (verdict.mode === 'base-advanced-disjoint' ? verdict.gateBase : undefined) : verdict.gateBase) ?? null,
    windowCommits: (verdict.ok ? (verdict.mode === 'base-advanced-disjoint' ? verdict.windowCommits : undefined) : verdict.windowCommits) ?? null,
  });
  if (!verdict.ok) return (verdict.reason.startsWith('not-rebased:') || verdict.reason.startsWith('base-stale-overlap:')) && verdict.baseTip
    ? { ok: false, reason: verdict.reason, baseTip: verdict.baseTip }
    : { ok: false, reason: verdict.reason };
  if (verdict.mode === 'already-ancestor') return { ok: true, mode: 'already-ancestor', reviewResult: verdict.reviewResult };
  if (verdict.mode === 'base-advanced-disjoint') {
    return { ok: true, mode: 'base-advanced-disjoint', baseTip: verdict.baseTip!, gateBase: verdict.gateBase, windowCommits: verdict.windowCommits, reviewResult: verdict.reviewResult };
  }
  return { ok: true, mode: 'rebased', baseTip: verdict.baseTip!, reviewResult: verdict.reviewResult };
}
