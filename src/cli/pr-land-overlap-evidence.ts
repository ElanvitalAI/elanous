/**
 * TA-LAND-OVERLAP — 머리 고정 착지(`pr land --pr --expected-head`)가 «1일 겹침» 관문에서 비대화형으로 영영 멎던 것을
 * «증거가 붙은 경우에만» 통과시킨다.
 *
 * - 왜: 겹침 승인은 터미널 확인뿐이라 비대화형(TA)에서는 늘 `unavailable` → 머리 고정 착지는 «항상» 거부됐다.
 *   (10-10 #25845 · 10-11 #25974 가 같은 관문에 걸려 머리 고정을 풀고 착지했다.)
 * - 무엇을: `--overlap-evidence <file>` 의 JSON 을 «믿지 않고» 잰다.
 *   ① 재기반 — 원격 base 의 «지금» 끝(`git ls-remote`)이 고정 머리의 조상인가(`git merge-base --is-ancestor`).
 *   ② 재게이트 — 증거의 게이트 기록이 «그 머리»를 «그 base 끝» 위에서 통과했다고 말하는가(머리·base 끝이 ① 과 맞물린다).
 *   ③ 리뷰 — 증거가 가리키는 `review-results/<card>-<pr>-<head12>.json`(TA 가 받는 `self review --json` stdout)이
 *      같은 PR·같은 머리에 대해 `reviewed:true` · `verdict:pass` · must-fix 0 인가.
 *   ⓐ 이미 조상(TC #26019 실측) — 겹친 최근 착지 커밋이 «전부» 고정 머리의 조상이면 그 겹침은 이미 그 머리의 게이트·리뷰에
 *      반영됐다 ⇒ ①② 없이 ③ 만으로 통과(관측 reason `already-ancestor`). 하나라도 조상이 아니면 ①②③ 전부.
 *   하나라도 못 재거나 어긋나면 거부 — 호출부는 종전 거부를 그대로 낸다(fail-closed).
 * - 관측: `pr.land` · `overlap-evidence` (decision · reason · 잰 값).
 */
import { basename, dirname } from 'node:path';
import { debug } from '../debug/log.js';
import type { CmdRunner } from '../autopilot/pr-manager.js';
import { parseReviewResultOutput } from '../task-agent/review-result-capture.js';

const SHA40 = /^[0-9a-f]{40}$/i;

interface OverlapEvidenceFile {
  pr: number;
  head: string;
  /** ①② 경로에서만 필수 — 겹친 착지가 전부 조상(already-ancestor)이면 생략해도 된다. */
  gate?: { head: string; baseCommit: string; passed: boolean };
  /** `self review --json` stdout 을 받은 파일(TA: `<state>/review-results/<card>-<pr>-<head12>.json`). */
  reviewResult: string;
}

export type OverlapEvidenceVerdict =
  | { ok: true; mode: 'already-ancestor'; reviewResult: string }
  | { ok: true; mode: 'rebased'; baseTip: string; reviewResult: string }
  | { ok: false; reason: string };

export interface VerifyOverlapEvidenceInput {
  evidencePath: string;
  pr: number;
  expectedHead: string;
  remote: string;
  branch: string;
  cwd: string;
  run: CmdRunner;
  readFile: (path: string) => string;
  /** 겹침 관문이 찾은 «겹친» 최근 착지 커밋들 — 전부 머리의 조상이면 already-ancestor. */
  overlappingLandings?: readonly string[];
}

type Checked = { ok: false; reason: string; baseTip?: string } | (OverlapEvidenceVerdict & { ok: true; baseTip?: string });

function checkReview(input: VerifyOverlapEvidenceInput, e: Partial<OverlapEvidenceFile>, head: string, baseTip?: string): { ok: false; reason: string; baseTip?: string } | { ok: true; reviewResult: string } {
  if (typeof e.reviewResult !== 'string' || !e.reviewResult) return { ok: false, reason: 'review-missing', baseTip };
  // TA 가 받는 자리(`<state>/review-results/<card>-<pr>-<head12>.json` · reviewResultPath)만 — 아무 디렉터리의 같은 이름은 안 받는다.
  if (basename(dirname(e.reviewResult)) !== 'review-results'
    || !new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]*-${input.pr}-${head.slice(0, 12)}\\.json$`, 'i').test(basename(e.reviewResult))) {
    return { ok: false, reason: 'review-path-not-for-this-pr-head', baseTip };
  }
  let text: string;
  try { text = input.readFile(e.reviewResult); } catch { return { ok: false, reason: 'review-unreadable', baseTip }; }
  const review = parseReviewResultOutput(text);
  if (!review) return { ok: false, reason: 'review-no-result', baseTip };
  if (review.pr !== input.pr) return { ok: false, reason: 'review-pr-mismatch', baseTip };
  if (!review.head || review.head.toLowerCase() !== head) return { ok: false, reason: 'review-head-mismatch', baseTip };
  if (review.error) return { ok: false, reason: 'review-error', baseTip };
  if (review.reviewed !== true) return { ok: false, reason: 'review-not-reviewed', baseTip };
  if (review.verdict !== 'pass') return { ok: false, reason: `review-verdict-${review.verdict ?? 'null'}`, baseTip };
  if (review.mustFix !== 0) return { ok: false, reason: review.mustFix === null ? 'review-must-fix-unknown' : `review-must-fix-${review.mustFix}`, baseTip };
  return { ok: true, reviewResult: e.reviewResult };
}

function check(input: VerifyOverlapEvidenceInput): Checked {
  const head = input.expectedHead.toLowerCase();
  let raw: unknown;
  try { raw = JSON.parse(input.readFile(input.evidencePath)); } catch (error) {
    return { ok: false, reason: `evidence-unreadable: ${String((error as { message?: string })?.message ?? error).slice(0, 200)}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'evidence-not-object' };
  const e = raw as Partial<OverlapEvidenceFile>;
  if (e.pr !== input.pr) return { ok: false, reason: `evidence-pr-mismatch: ${String(e.pr)} ≠ ${input.pr}` };
  if (typeof e.head !== 'string' || e.head.toLowerCase() !== head) return { ok: false, reason: 'evidence-head-mismatch' };

  // ⓐ 이미 조상 — 겹친 착지가 전부 머리 안에 있으면 그 머리의 게이트·리뷰가 이미 그것을 보고 쟀다.
  const landings = input.overlappingLandings ?? [];
  if (landings.length > 0 && landings.every((sha) => /^[0-9a-f]{7,40}$/i.test(sha)
    && input.run('git', ['merge-base', '--is-ancestor', sha, head], { cwd: input.cwd }).ok)) {
    const review = checkReview(input, e, head);
    return review.ok ? { ok: true, mode: 'already-ancestor', reviewResult: review.reviewResult } : review;
  }

  // ① 재기반 — 원격의 «지금» 끝을 읽기 전용으로 받는다(로컬 ref 를 안 바꾼다).
  const remote = input.run('git', ['ls-remote', input.remote, `refs/heads/${input.branch}`], { cwd: input.cwd });
  const baseTip = remote.ok ? remote.out.trim().split(/\s+/)[0] ?? '' : '';
  if (!SHA40.test(baseTip)) return { ok: false, reason: `rebase-unmeasured: ls-remote ${input.remote} ${input.branch} failed` };
  const ancestor = input.run('git', ['merge-base', '--is-ancestor', baseTip, head], { cwd: input.cwd });
  if (!ancestor.ok) return { ok: false, reason: `not-rebased: ${input.remote}/${input.branch} ${baseTip.slice(0, 12)} is not an ancestor of ${head.slice(0, 12)}`, baseTip };

  // ② 재게이트 — 그 머리를, ① 의 그 base 끝 위에서.
  const gate = e.gate;
  if (!gate || typeof gate !== 'object') return { ok: false, reason: 'gate-missing', baseTip };
  if (gate.passed !== true) return { ok: false, reason: 'gate-not-passed', baseTip };
  if (typeof gate.head !== 'string' || gate.head.toLowerCase() !== head) return { ok: false, reason: 'gate-head-mismatch', baseTip };
  if (typeof gate.baseCommit !== 'string' || gate.baseCommit.toLowerCase() !== baseTip.toLowerCase()) {
    return { ok: false, reason: `gate-base-stale: gate ${String(gate.baseCommit).slice(0, 12)} ≠ ${input.remote}/${input.branch} ${baseTip.slice(0, 12)}`, baseTip };
  }

  // ③ 리뷰 — 그 PR · 그 머리의 pass ⊕ must-fix 0.
  const review = checkReview(input, e, head, baseTip);
  return review.ok ? { ok: true, mode: 'rebased', baseTip, reviewResult: review.reviewResult } : review;
}

/** 던지지 않는다 — 어떤 실패도 거부(fail-closed)이고 관측 한 줄을 남긴다. */
export function verifyOverlapEvidence(input: VerifyOverlapEvidenceInput): OverlapEvidenceVerdict {
  let verdict: Checked;
  try { verdict = check(input); } catch (error) { verdict = { ok: false, reason: `verify-threw: ${String(error).slice(0, 200)}` }; }
  debug.log('pr.land', 'overlap-evidence', {
    decision: verdict.ok ? 'accepted' : 'rejected',
    reason: verdict.ok ? (verdict.mode === 'already-ancestor' ? 'already-ancestor' : 'rebased+gated+reviewed') : verdict.reason,
    overlappingLandings: input.overlappingLandings ?? [],
    pr: input.pr,
    head: input.expectedHead,
    base: `${input.remote}/${input.branch}`,
    baseTip: verdict.baseTip ?? null,
    evidencePath: input.evidencePath,
  });
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  return verdict.mode === 'already-ancestor'
    ? { ok: true, mode: 'already-ancestor', reviewResult: verdict.reviewResult }
    : { ok: true, mode: 'rebased', baseTip: verdict.baseTip!, reviewResult: verdict.reviewResult };
}
