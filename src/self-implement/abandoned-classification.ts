import { runGitCommand } from '../git-fs/runner.js';

import type { GitResidueGate } from '../git-fs/worktree.js';
import type { GoalType } from './goal-author.js';
import type { ReworkBudgetVerdict, RunOutcome } from './run-outcome.js';
import type { SelfImplementStage } from './run-status-mapping.js';

export interface QuotaAccountAvailabilityEvidence {
  readonly reason: string;
  readonly candidateCount: number | undefined;
  /** ⭐ 회전이 «어디로» 가려 했나. `undefined` = 갈 곳을 못 정했다(`no-candidate` 등). */
  readonly to?: string;
  /** ⛔⭐⭐⭐ **그 대상의 상태를 «알고» 갔나.** 이것이 이 확장의 핵심이다 —
   *  회전 후보 필터는 `c.reached !== true && !reachedThreshold(c.usedPercent)` 라서
   *  ***상태가 「모른다」인 후보가 「쓸 수 있다」로 통과한다***. 그 자체는 «설계»일 수 있다
   *  (신호는 60분에 만료되므로, 신선을 요구하면 회전이 사실상 영영 안 선다).
   *  ⛔ 그러나 종전엔 그 결정이 ***관측에 한 글자도 안 남았다*** — 런이 429 로 죽어도
   *  `{"reason":"rotated","candidateCount":2}` 만 남아 「알고 갔나」를 «원리상» 못 갈랐다. */
  readonly toSignalFresh?: boolean;
  /** 지금 계정의 사용률·신선도 — 「찼다」 판정의 근거를 같이 남긴다. */
  readonly currentUsedPercent?: number;
  readonly currentSignalFresh?: boolean;
  /** ⭐ 후보 중 «상태를 모르는» 것이 몇인가. `candidateCount` 만으로는 못 읽는 수다. */
  readonly unknownStateCandidateCount?: number;
  /** 판정기가 실제로 쓴 임계(raw config 아님). */
  readonly thresholdPercent?: number;
  /**
   * ⛔⭐⭐⭐ **이 증거를 «언제» 읽었나.** 이 칸이 없으면 위 값들이 «오독된다».
   *
   * 🚨 회전 «결정»은 자식을 띄울 때 서고, 그 직전에 신호 갱신이 돈다 ⇒ 그 순간엔 대개 신선하다.
   *   그런데 이 증거는 ***런이 끝난 «뒤»*** 다시 읽은 것이다(`attachAbandonedClassification`).
   *   신호는 60분에 만료되므로 ***긴 런은 「끝날 무렵」에 낡아 있다***.
   * ⇒ 🔑 그래서 `toSignalFresh: false` 는 ***「회전이 모르고 갔다」가 «아니라»***
   *   ***「런이 끝날 무렵엔 신호가 낡아 있었다」***는 뜻이다. 둘은 다른 문장이다.
   * ⛔ 이 칸을 지우지 마라 — 지우면 한 값이 두 뜻을 덮는다(`PATTERNS.md` `F44`).
   * ⚠️ 결정 «시점»의 신선도를 알고 싶으면 그것은 «별개 축»이다(자식 계측이 선결).
   */
  readonly readPoint?: 'postmortem';
}

import type { SelfImplementCompletionDisposition } from './seams.js';

export type AbandonedClassification = 'report-deficit' | 'implementation-deficit' | 'artifact-deficit' | 'contract-conflict' | 'goal-unconvergeable-candidate' | 'pr-declined' | 'merge-approved-abandoned' | 'run-deadline-exceeded' | 'quota-exhausted' | 'credential-failure' | 'provider-error' | 'already-satisfied';

const ABANDONED_CLASSIFICATION_VALUES = {
  'report-deficit': true,
  'implementation-deficit': true,
  'artifact-deficit': true,
  'contract-conflict': true,
  'goal-unconvergeable-candidate': true,
  'pr-declined': true,
  'merge-approved-abandoned': true,
  'run-deadline-exceeded': true,
  'quota-exhausted': true,
  'credential-failure': true,
  'provider-error': true,
  'already-satisfied': true,
} as const satisfies Record<AbandonedClassification, true>;

export function isAbandonedClassification(value: string): value is AbandonedClassification {
  return Object.prototype.hasOwnProperty.call(ABANDONED_CLASSIFICATION_VALUES, value);
}
type AbandonedClassificationBasis =
  | 'non-implement-goal-type-artifact-deficit'
  | 'supervisor-contract-conflict'
  | 'supervisor-unconvergeable-goal-candidate'
  | 'pr-declined-stage'
  | 'merge-approval-received'
  // 기한 사망은 호스트가 읽은 Job 종료 이유다. 사후 쿼터 상관보다 앞선다.
  | 'substrate-deadline-outranks-postmortem-quota'
  // 🩸 2026-09-20: 이 셋은 분류 «이름을 되풀이»했다 — 근거 칸이 동어반복이면 중재를 못 한다.
  //   📏 실물(block 아티팩트)에서 네 칸이 2:2 로 갈렸다:
  //        reason·stage = 게이트   ↔   중단원인·classification = 쿼타
  //     중재해야 할 셋째 칸이 `quota-exhausted` 라 «아무것도 더» 말하지 않았고,
  //     이 저장소를 매일 보는 사람이 그것을 «모순»으로 읽어 채널에 올렸다(#16815).
  //   ⭐ 다른 여덟 분기는 근거를 «말한다»(예: no-must-fix-clean-worktree-…). 이 셋만 그러지 않았다.
  //   ⇒ 사다리에서 «무엇을 눌렀는지»를 이름에 담는다. ⛔ 사다리 자체는 안 바꾼다(설계가 맞다).
  | 'environment-quota-outranks-run-stage-evidence'
  | 'environment-credential-outranks-run-stage-evidence'
  | 'environment-provider-error-outranks-run-stage-evidence'
  | 'provider-request-rejection-outranks-account-availability'
  | 'must-fix-reported'
  // ⛔ `citedEvidenceExists` 미측정(`undefined`)과 실측 부재(`false`)는 다른 사실이다.
  //   실측 부재는 빈 워크트리 / 바꿀 게 없다고 보고 / 둘 다를 한 칸에 접지 않는다.
  //   사다리·분류는 그대로, 근거 칸만 가른다. ⛔ 분류 이름(`report-deficit`)을 되풀이하지 않는다.
  | 'no-must-fix-clean-worktree'
  | 'no-must-fix-completed-without-changes'
  | 'no-must-fix-clean-worktree-and-completed-without-changes'
  | 'no-must-fix-clean-worktree-with-cited-evidence-unmeasured'
  | 'no-must-fix-without-clean-worktree-or-completed-without-changes'
  | 'cited-evidence-exists-without-changes'
  // ⛔ `reviewResultObserved` 미측정(`undefined`)과 실측 부재(`false`)는 다른 사실이다.
  //   리뷰를 봤는데 must-fix 0 인 경우만 위의 no-must-fix-* 이름을 쓴다.
  //   사다리·분류는 그대로, 근거 칸만 가른다. ⛔ 분류 이름(`report-deficit`)을 되풀이하지 않는다.
  | 'terminal-state-not-reviewed'
  | 'review-result-observation-unmeasured';

interface AbandonedClassificationInput {
  readonly worktreePorcelain: string | undefined;
  readonly gitResidue?: GitResidueGate;
  readonly completionDisposition?: SelfImplementCompletionDisposition;
  readonly stage?: SelfImplementStage;
  /** Optional parsed goal kind; omitted and implement preserve the legacy classification branches. */
  readonly goalType?: GoalType;
  /** Explicit supervisor value only; classification never infers this from reason text. */
  readonly supervisorVerdict?: ReworkBudgetVerdict;
  /**
   * A structured observation that a goal-side cause was recorded for this run. UNCONVERGEABLE alone is not enough:
   * it reports only failure to converge, while this signal preserves the separately observed candidate without
   * asserting that the goal is defective.
   */
  readonly goalCauseObserved?: true;
  /** Preserved when the merge decision authorized automatic merge before this run was abandoned. */
  readonly mergeApprovalReceived?: boolean;
  /** 호스트가 k8s Job 종료 reason `DeadlineExceeded` 를 읽었을 때만 참이다.
   *  ⛔ 사후 쿼터 상관(`quotaExhausted`)보다 앞선다 — 기한 사망을 할당량 소진으로 읽지 않는다. */
  readonly substrateDeadlineExceeded?: boolean;
  /** ⭐ provider 쿼터가 «찬 것으로 관측»되었을 때만 참이다.
   *  ⛔ 이 값은 «추론하지 않는다» — 호출자가 provider 응답(`rateLimitReachedType`)을 읽어 넘긴다.
   *  ⚠️ 그 읽기는 런이 죽은 «뒤»에 일어나므로 「죽은 원인」이 아니라 「죽을 무렵 쿼터가 찼다」는 상관이다.
   *     그래서 분류는 이 값을 «가장 마지막 비-결손 얼굴»로만 쓰고, 값 자체는 결과에 늘 싣는다. */
  readonly quotaExhausted?: boolean;
  /** Account-rotation authority evidence retained with the classification for later audit. */
  readonly quotaAccountAvailability?: QuotaAccountAvailabilityEvidence;
  /** Explicitly observed credential rejection; classification does not infer it from a missing report or worktree state. */
  readonly credentialFailure?: boolean;
  /** ⭐ provider 오류가 관측되었을 때만 참이다.
   *  ⛔ 이 값은 toolCalls, 종료 코드, 화면 내용이나 다른 런 결과에서 추론하지 않는다 — 호출자가 관측값을 넘긴다. */
  readonly providerError?: boolean;
  readonly providerErrorCategory?: 'quota' | 'credential' | 'request' | 'other';
  /**
   * 자식이 인용한 것이 «실재한다»는 관측. ⛔ 분류는 이 값을 추론하지 않는다 — 호출자가 넘긴다.
   * ⛔ `true` 가 아니면 「이미 만족」으로 접지 않는다. 변경 없음만으로는 포기와 구별되지 않는다.
   */
  readonly citedEvidenceExists?: boolean;
  /**
   * ⭐ 이 판정 시점에 리뷰 결과를 «봤나». ⛔ 분류는 이 값을 추론하지 않는다 — 호출자가 넘긴다.
   * ⛔ `undefined`(미상)와 `false`(못 봤다)는 다른 사실이다. 둘을 `mustFixReported: false` 로 접지 않는다.
   * 옛 호출자가 안 주면 미상이다.
   */
  readonly reviewResultObserved?: boolean;
  readonly mustFixReported: boolean;
}

/** Whether a terminal outcome must receive abandoned-run classification and its observation. */
export function isAbandonedClassificationOutcome(outcome: RunOutcome | undefined): boolean {
  return outcome === 'abandoned' || outcome === 'budget-exhausted';
}

export interface AbandonedClassificationResult {
  readonly classification: AbandonedClassification;
  /** The condition that selected `classification`, so consumers need not reconstruct the branch. */
  readonly classificationBasis: AbandonedClassificationBasis;
  readonly worktreeClean: boolean | undefined;
  readonly completionDisposition?: SelfImplementCompletionDisposition;
  readonly supervisorVerdict?: ReworkBudgetVerdict;
  /** Preserves the observed goal-side candidate separately from the selected classification. */
  readonly goalCauseObserved?: true;
  readonly mergeApprovalReceived?: true;
  /** ⭐ 분류가 무엇으로 나오든 «관측된 사실»은 잃지 않는다 — 머지 승인과 쿼일이 같이 참일 때
   *  분류는 하나만 고르지만, 운영자는 둘 다 알아야 재시도 여부를 정할 수 있다. */
  readonly quotaExhausted?: true;
  /** Account-rotation authority grounds for the quota decision, including unknown/not-exhausted decisions. */
  readonly quotaAccountAvailability?: QuotaAccountAvailabilityEvidence;
  /** Preserved independently of the selected classification. */
  readonly credentialFailure?: true;
  /** Preserved independently of the selected classification. */
  readonly providerError?: true;
  /** Category of the provider error admitted by the caller, when observed. */
  readonly providerErrorCategory?: 'quota' | 'credential' | 'request' | 'other';
  /** Preserved independently of the selected classification. Only `true` is recorded. */
  readonly citedEvidenceExists?: true;
  readonly mustFixReported: boolean;
  /** ⛔ **왜 깨끗함을 판정할 수 없었는지가 남아야 한다**(무인 리뷰 must-fix · 수용 기준
   *  *"멈춘 사실이 관측에 남고 무엇 때문인지 말한다"*). 초판은 게이트를 **판정에만 쓰고
   *  이유·관측을 버려**, 산출물에는 `worktreeClean: undefined` 만 남아 *"관측 실패"* 와
   *  *"잔여 때문에 보류"* 가 구분되지 않았다. 잔여로 막힌 경우에만 실린다. */
  readonly gitResidueBlock?: { readonly reason: string; readonly residues: readonly string[] | 'unreadable' };
}

/**
 * An explicit supervisor contract conflict takes priority. A goal-side candidate requires both an UNCONVERGEABLE
 * verdict and a separately observed `goalCauseObserved` signal, so convergence failure alone keeps the legacy
 * classification. Existing procedural and environment observations take priority over that candidate; otherwise a
 * clean worktree or confirmed completed-without-changes result identifies a missing report/artifact.
 */
export function classifyAbandonedRun(input: AbandonedClassificationInput): AbandonedClassificationResult {
  // ⛔⭐ **정리 허용과 「깨끗함」 판정은 다른 축이다**(무인 리뷰 must-fix). 갓 생긴 `index.lock`
  //   은 정리를 **막지 않아도**(다른 세션이 쓰는 중일 뿐) 그 트리가 깨끗하다고 말할 수는 없다 —
  //   porcelain 이 쓰기 도중일 수 있다. 초판은 `allowed === true` 면 잔여 목록을 통째로 무시해
  //   잔여가 관측된 트리를 `worktreeClean: true` 로 단정했다.
  //   ⇒ **잔여가 하나라도 관측되면 판정을 보류**(`undefined`)한다. 부재·미지·거부를 같은 값으로
  //     적지 않되, *"모른다"* 는 *"깨끗하다"* 가 아니다.
  const residueSeen = input.gitResidue !== undefined
    && (input.gitResidue.allowed === false || input.gitResidue.observation.state !== 'observed'
        || input.gitResidue.observation.residues.length > 0);
  const worktreeClean = input.worktreePorcelain === undefined || residueSeen
    ? undefined
    : input.worktreePorcelain.trim() === '';
  const mustFixReported = input.mustFixReported;
  const nonImplementGoal = input.goalType === 'research' || input.goalType === 'document' || input.goalType === 'operate';
  const classification: AbandonedClassification = input.supervisorVerdict === 'CONTRACT-CONFLICT'
    ? 'contract-conflict'
    : input.stage === 'pr-declined'
      ? 'pr-declined'
      : input.mergeApprovalReceived === true
        ? 'merge-approved-abandoned'
        // ⭐ 쿼터 소진은 «환경»이 멈춘 것이지 «구현»이 모자란 것이 아니다. mustFix 보고보다 앞에 둔다.
        //   ⛔ 다만 머지 승인보다는 «뒤»다 — 승인은 「이 물건은 합격이었다」는 더 강한 완료 주장이고,
        //     쿼터 사실은 그 경우에도 결과 payload 에 그대로 실려 잃지 않는다.
        // 결정적 요청 거부는 계정 가용성보다 앞선다 — 회전 후보 부재는 요청 오류의 원인이 아니다.
        // 기한 사망은 호스트가 읽은 종료 이유다. 사후 쿼터·자격·provider 오류보다 앞이고,
        // 머지 승인·계약 충돌·pr-declined 보다는 뒤다. 쿼터 사실은 결과에 그대로 남긴다.
        : input.substrateDeadlineExceeded === true
        ? 'run-deadline-exceeded'
        : input.providerError === true && input.providerErrorCategory === 'request'
        ? 'provider-error'
        : input.quotaExhausted === true
        ? 'quota-exhausted'
        : input.credentialFailure === true
        ? 'credential-failure'
        : input.providerError === true
        ? 'provider-error'
        // A candidate is selected only from two structured observations. This deliberately does not prove a defect.
        : input.supervisorVerdict === 'UNCONVERGEABLE' && input.goalCauseObserved === true
        ? 'goal-unconvergeable-candidate'
        : nonImplementGoal
        ? 'artifact-deficit'
        : mustFixReported
        ? 'implementation-deficit'
        : worktreeClean === true || input.completionDisposition === 'completed-without-changes'
          ? input.citedEvidenceExists === true
            ? 'already-satisfied'
            : 'report-deficit'
          : 'implementation-deficit';
  const classificationBasis: AbandonedClassificationBasis = (() => {
    switch (classification) {
      case 'artifact-deficit': return 'non-implement-goal-type-artifact-deficit';
      case 'contract-conflict': return 'supervisor-contract-conflict';
      case 'goal-unconvergeable-candidate': return 'supervisor-unconvergeable-goal-candidate';
      case 'pr-declined': return 'pr-declined-stage';
      case 'merge-approved-abandoned': return 'merge-approval-received';
      case 'run-deadline-exceeded': return 'substrate-deadline-outranks-postmortem-quota';
      // ⛔ 분류 이름을 되풀이하지 않는다 — 근거는 «왜 그것이 이겼나»를 말해야 한다.
      case 'quota-exhausted': return 'environment-quota-outranks-run-stage-evidence';
      case 'credential-failure': return 'environment-credential-outranks-run-stage-evidence';
      case 'provider-error': return input.providerErrorCategory === 'request'
        ? 'provider-request-rejection-outranks-account-availability'
        : 'environment-provider-error-outranks-run-stage-evidence';
      case 'already-satisfied': return 'cited-evidence-exists-without-changes';
      case 'report-deficit': return input.reviewResultObserved === true
        ? input.citedEvidenceExists === false
          ? worktreeClean === true && input.completionDisposition === 'completed-without-changes'
            ? 'no-must-fix-clean-worktree-and-completed-without-changes'
            : worktreeClean === true
              ? 'no-must-fix-clean-worktree'
              : 'no-must-fix-completed-without-changes'
          : 'no-must-fix-clean-worktree-with-cited-evidence-unmeasured'
        : input.reviewResultObserved === false
          ? 'terminal-state-not-reviewed'
          : 'review-result-observation-unmeasured';
      case 'implementation-deficit': return mustFixReported
        ? 'must-fix-reported'
        : 'no-must-fix-without-clean-worktree-or-completed-without-changes';
    }
  })();

  const blocked = input.gitResidue?.allowed === false ? input.gitResidue : undefined;
  return {
    classification,
    classificationBasis,
    worktreeClean,
    ...(input.completionDisposition ? { completionDisposition: input.completionDisposition } : {}),
    ...(input.supervisorVerdict ? { supervisorVerdict: input.supervisorVerdict } : {}),
    ...(input.goalCauseObserved === true ? { goalCauseObserved: true } : {}),
    ...(input.mergeApprovalReceived === true ? { mergeApprovalReceived: true } : {}),
    ...(input.quotaExhausted === true ? { quotaExhausted: true } : {}),
    ...(input.quotaAccountAvailability ? { quotaAccountAvailability: input.quotaAccountAvailability } : {}),
    ...(input.credentialFailure === true ? { credentialFailure: true } : {}),
    ...(input.providerError === true ? { providerError: true } : {}),
    ...(input.providerError === true && input.providerErrorCategory ? { providerErrorCategory: input.providerErrorCategory } : {}),
    ...(input.citedEvidenceExists === true ? { citedEvidenceExists: true } : {}),
    mustFixReported,
    ...(blocked
      ? {
          gitResidueBlock: {
            reason: blocked.reason,
            residues: blocked.observation.state === 'observed' ? blocked.observation.residues : 'unreadable',
          },
        }
      : {}),
  };
}

/** Returns undefined when the worktree cannot be observed instead of inventing a clean state. */
export function readWorktreePorcelain(cwd: string): string | undefined {
  const result = runGitCommand(cwd, ['status', '--porcelain'], { encoding: 'utf8', timeout: 15_000 });
  return result.status === 0 ? result.stdout : undefined;
}
