/**
 * GOAL-REVISE-AFTER-FIRST-IMPL (0.3.38 · 대표 11-27 12:2x «1차 구현 후 요구사항(판정값) 다시 조정»).
 *
 * S: 구현 라운드가 끝나면 오케스트레이터는 골의 TDD 계획을 그대로 판정했다 — RED 기록이 없으면 수리 라운드 → 그래도 없으면 abandoned.
 * C: 11-27 TA 스프린트 abandoned 8건 중 5건이 `tdd-evidence-missing`. 그중 여럿은 같은 명령의 GREEN(집중 시험 통과)이 있었는데
 *    RED «기록 양식» 하나로 버려졌다(t1 #40361 은 수확해 light PASS). 증거 시험만 더하는 E4 칸은 RED 가 원리상 없다.
 * Q: 정책(초록 = 같은 변경 영수 ⊕ 집중 시험 exit 0)이 요구하지 않는 판정값 때문에 버리는가?
 * A: 1차 구현 직후 판정값을 정책 안에서 다시 맞춘다 — GREEN 이 관측됐고 결손이 RED 뿐이면(또는 evidence 칸이면) RED 를 «기록 권장»으로
 *    내리고 그 차이를 골 문서·관측에 남긴다. GREEN 이 없으면 아무것도 완화하지 않는다. 보안 4종은 이 모듈이 다루지 않는다(완화 0).
 *
 * 세 얼굴: 관측 = 골 문서 «## 판정값 재조정» 절 ⊕ debug 'self-implement.goal-revise' · 판단 근거 = 아래 규칙(정책 팩 초록 정의) ·
 *          수복과 인계 = 완화는 RED 기록 하나뿐 · 같은 명령 GREEN 과 착지 줄 영수(focused exit 0)는 그대로 남는다.
 */
import { tddPlanFromGoal, type TddEvidenceJudgment } from './off-diff-evidence.js';
import { isEdgeFinding, isSecurityScopeWidening, loadGoalRubric, securityOverSpecLines, type GoalRubric } from '../self-dev/goal-rubric.js';

export interface GoalRevision {
  /** 판정값을 바꿨나. */
  readonly revised: boolean;
  /** 사람이 읽는 차이 한 줄씩(골 문서·관측에 그대로). */
  readonly changes: readonly string[];
  /** 재조정 뒤 판정 — revised 가 아니면 입력 그대로. */
  readonly judgment: TddEvidenceJudgment;
}

const EVIDENCE_CELL = /^\s*-\s*CellKind\s*:\s*evidence\s*$/imu;
const E4_CELL = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-E4\b|E4 sim\/test-universe evidence/u;

/** Pure. Only the RED record can be relaxed, and only when a GREEN record for the planned command exists. */
export function reviseJudgmentAfterImpl(input: {
  readonly goal: string; readonly judgment: TddEvidenceJudgment; readonly implementationOk: boolean;
  /** TDD-PROVEN-CARRY — the planned command an earlier round of THIS run already proved RED→GREEN (same command). */
  readonly provenCommand?: string;
}): GoalRevision {
  const { goal, judgment } = input;
  const unchanged: GoalRevision = { revised: false, changes: [], judgment };
  if (!input.implementationOk || !judgment.planned || !judgment.needsRepair) return unchanged;
  // A review/rework round edits code whose feature test this run already proved: its base is the earlier head, so a new RED
  // cannot exist (11-27 canary ZOMBIE-CLAIM-REAP: round 0 RED 0/1 → GREEN 6/0, rework round base 6/0 «did not prove red» →
  // abandoned). The proven pair carries; the landing line's same-head focused exit 0 re-checks GREEN on the final head.
  // Carry only the planned command itself (Terra review must-fix): a rework that changed the planned command must prove it anew.
  const planned = tddPlanFromGoal(goal).greenCommand;
  if (input.provenCommand && (planned === undefined || planned === input.provenCommand)) {
    return {
      revised: true,
      changes: [
        `TDD 재작업 라운드: 이 런 앞 라운드가 «${input.provenCommand}» RED→GREEN 을 증명 — RED·GREEN 기록 재요구 → 이월`,
        '유지: 착지 줄의 같은 head 영수 ⊕ focused exit 0 이 최종 head 의 GREEN 을 다시 본다',
      ],
      judgment: { ...judgment, missing: [], needsRepair: false },
    };
  }
  if (!judgment.green.observed) return unchanged;
  if (judgment.missing.some((tag) => tag !== 'tdd-red')) return unchanged;
  const evidenceCell = EVIDENCE_CELL.test(goal) || E4_CELL.test(goal);
  const why = evidenceCell
    ? 'evidence 칸(증거 시험만 더함) — RED 가 원리상 없다'
    : '정책 초록 정의 = 같은 변경 영수 ⊕ 집중 시험 exit 0 · RED 기록은 정책 요구가 아니다';
  return {
    revised: true,
    changes: [
      `TDD RED 기록: 필수 → 권장 (${why})`,
      `유지: 같은 명령 GREEN 기록 «${judgment.green.verify ?? '(명령 미상)'}» · 착지 줄의 같은 head 영수 ⊕ focused exit 0`,
    ],
    judgment: { ...judgment, missing: [], needsRepair: false },
  };
}

/** Append the revision record (one section per revision, at the end — the goal's header and sections keep their place). */
export function recordGoalRevision(document: string, revision: GoalRevision, round: number): string {
  if (!revision.revised) return document;
  const block = [
    `## 판정값 재조정(GOAL-REVISE-AFTER-FIRST-IMPL · 라운드 ${round})`,
    ...revision.changes.map((change) => `- ${change}`),
    '- 보안 4종 기준: 변경 없음',
  ].join('\n');
  return `${document.replace(/\s*$/u, '')}\n\n${block}\n`;
}

// ── GOAL-REVISE-AFTER-FIRST-IMPL · broadened (대표 11-27 «구현 1회 후 요구사항 점검 및 정정») — the SAME rubric
//    (src/self-dev/goal-rubric.ts · graphs/policies/goal-precheck-rubric.yaml) corrects the goal after a round:
//    (a) over-spec — a demand to widen the security-4 path list is relaxed (never loops); other hardening outside
//        security-4 is a recorded candidate the reflection step decides with the policy pack
//    (b) under-spec — a finding repeated across rounds (reviewer and implementer disagree) is written into the done-when
//    (c) edges — a finding that calls itself out of scope is recorded as a FU candidate (kept until reflection rejects it)
//    (d) blocked by an unlanded dependency — held at the launch door by the rubric's dependencies axis (hand) ·
//    (e) wrong cell / obsolete — FU cell GOAL-REVISE-PARK-WIRE (in-run park/close needs orchestrator wiring).
//    Security-4 is never relaxed. Every change is a `## 판정값 재조정` line.
export type RoundCorrectionKind = 'over-spec' | 'over-spec-candidate' | 'under-spec' | 'edge-to-fu';
export interface RoundCorrection { readonly kind: RoundCorrectionKind; readonly line: string }

export interface ReviewCorrection {
  /** The must-fix list the rework round should carry (over-spec and edge findings removed). */
  readonly mustFix: readonly string[];
  readonly corrections: readonly RoundCorrection[];
  /** Edge findings to register as FU cells. */
  readonly fu: readonly string[];
  /** Done-when lines to add (repeated disagreements made explicit). */
  readonly tighten: readonly string[];
}

const norm = (s: string): string => s.replace(/^(앞 지적\(직전 head must #\d+\):\s*)+/u, '').replace(/\s+/gu, ' ').trim().slice(0, 160);

/** Pure. (a)(b)(c) on a review's must-fix list, with the same rubric the precheck used.
 *  A keyword can never prove a finding is not a defect (Terra r1–r5), so the deterministic step removes only ONE class:
 *  a demand to WIDEN the security-4 path list (that list is the policy itself — graphs/policies/security4-paths.yaml).
 *  Every other security-hardening or out-of-scope finding stays in the rework list and is recorded as a candidate in
 *  `## 판정값 재조정`; the reflection step (the LLM node that already adjudicates must-fix with reasons) reads the
 *  policy pack's «보안 기본 = 완화» line and decides. */
export function correctAfterReview(input: {
  readonly mustFix: readonly string[]; readonly previousMustFix: readonly string[]; readonly targetPaths: readonly string[];
}, rubric: GoalRubric = loadGoalRubric()): ReviewCorrection {
  const corrections: RoundCorrection[] = []; const fu: string[] = []; const tighten: string[] = []; const keep: string[] = [];
  const previous = new Set(input.previousMustFix.map(norm));
  for (const finding of input.mustFix) {
    if (isSecurityScopeWidening(finding, input.targetPaths, rubric)) {
      corrections.push({ kind: 'over-spec', line: `보안 경로 확대 요구 완화 — «${norm(finding)}» · 보안 4종 경로 목록이 정책(graphs/policies/security4-paths.yaml) · 재작업에서 뺀다` });
      continue;
    }
    if (securityOverSpecLines(finding, input.targetPaths, rubric).length > 0) {
      corrections.push({ kind: 'over-spec-candidate', line: `보안 과잉 후보(유지 · 반사 판정) — «${norm(finding)}» · 정책: 보안 기본 완화 · 보안 4종 경로 밖` });
    } else if (isEdgeFinding(finding, rubric)) {
      fu.push(norm(finding));
      corrections.push({ kind: 'edge-to-fu', line: `범위 밖 후보 → FU 기록(유지 · 반사 판정) — «${norm(finding)}»` });
    }
    if (previous.has(norm(finding))) {
      tighten.push(norm(finding));
      corrections.push({ kind: 'under-spec', line: `완료선 명시(리뷰·구현 불일치 2회) — «${norm(finding)}»` });
    }
    keep.push(finding);
  }
  return { mustFix: keep, corrections, fu, tighten };
}

/** Append correction lines under one `## 판정값 재조정` section per round; tightened lines also go into the done-when. */
export function recordRoundCorrections(document: string, corrections: readonly RoundCorrection[], tighten: readonly string[], round: number): string {
  if (corrections.length === 0) return document;
  let doc = document;
  if (tighten.length) {
    const add = tighten.map((t) => `- 정정(라운드 ${round}): ${t}`);
    const lines = doc.split('\n');
    const at = lines.findIndex((l) => /^\s*완료선\s*:\s*$/u.test(l));
    doc = at < 0 ? `${doc.replace(/\s*$/u, '')}\n\n완료선:\n${add.join('\n')}\n` : [...lines.slice(0, at + 1), ...add, ...lines.slice(at + 1)].join('\n');
  }
  const block = [`## 판정값 재조정(GOAL-REVISE-AFTER-FIRST-IMPL · 라운드 ${round})`, ...corrections.map((c) => `- [${c.kind}] ${c.line}`), '- 보안 4종 기준: 변경 없음'].join('\n');
  return `${doc.replace(/\s*$/u, '')}\n\n${block}\n`;
}
