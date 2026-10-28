/**
 * IMPL-FINDINGS-FEEDBACK — 병합 PR 본문의 «구현이 밝힌 요구사항»·«새 범위»·«남은 것» 절을
 * idempotent 원장(`appendRunLedgerEntryChecked`)에 1회 기록하고, 관련 기록만 다음 저작
 * (goal-author) 입력에 주입하며, 남은 것에서 후속 초안을 만든다(자동 발사 없음 — shadow 기본).
 *
 * 절 파싱은 `markdownSection`(goal-author)과 `remainingPiecesFromPrBody`(follow-up-goals)을
 * 재사용하고, 관련 교훈 선택은 `selectRelevantAuthoringLessons`(knowhow-pack)을 재사용한다.
 * 모든 관측은 `self-implement.impl-findings-feedback` 범주로 `debug.log` 에 남는다.
 */
import { debug } from '../debug/log.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { markdownSection } from './goal-author.js';
import { selectRelevantAuthoringLessons, type SelectedAuthoringLessons } from './knowhow-pack.js';
import { appendRunLedgerEntryChecked, type RunLedgerCheckedAppendDecision, type RunLedgerEntry } from './run-ledger.js';
import { recordFollowUpOnMerge, remainingPiecesFromPrBody, type FollowUpDraftRecord, type FollowUpMergeInput, type FollowUpSeams } from './follow-up-goals.js';

/** 원장 이벤트 이름 — 같은 PR 의 되먹임 기록은 이 이벤트로 정확히 한 번만 남는다. */
export const IMPL_FINDINGS_LEDGER_EVENT = 'impl-findings-feedback';
export const IMPL_FINDINGS_REQUIREMENTS_SECTION = '구현이 밝힌 요구사항';
export const IMPL_FINDINGS_NEW_SCOPE_SECTION = '새 범위';
export const IMPL_FINDINGS_REMAINING_SECTION = '남은 것';

/** 병합 PR 본문에서 파싱한 세 절. */
export interface ImplFindings {
  /** «구현이 밝힌 요구사항» 절 본문(verbatim trim). */
  requirements: string;
  /** «새 범위» 절 본문(verbatim trim). */
  newScope: string;
  /** «남은 것» 절(⊕ follow-up-goals 의 «남은 조각» 절)의 항목 — 순서 보존·중복 제거. */
  remaining: string[];
}

function sectionBullets(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*[-*]\s+(.+?)\s*$/)?.[1] ?? '')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 병합 PR 본문의 세 절을 exact-trimmed `## ` 제목으로 파싱한다 — 펜스 안 본문은 건너뛴다. */
export function parseImplFindings(prBody: string): ImplFindings {
  const requirements = (markdownSection(prBody, IMPL_FINDINGS_REQUIREMENTS_SECTION) ?? '').trim();
  const newScope = (markdownSection(prBody, IMPL_FINDINGS_NEW_SCOPE_SECTION) ?? '').trim();
  const remainingSection = (markdownSection(prBody, IMPL_FINDINGS_REMAINING_SECTION) ?? '');
  const remaining = [...sectionBullets(remainingSection), ...remainingPiecesFromPrBody(prBody)]
    .map((item) => item.trim())
    .filter(Boolean);
  return { requirements, newScope, remaining: [...new Set(remaining)] };
}

export interface ImplFindingsFeedbackInput {
  runId: string;
  prNumber: number;
  /** 병합 PR 본문 원문 — 세 절을 여기서 파싱한다. */
  prBody: string;
  /** 다음 저작 입력의 원문 ask — 관련 교훈 선택의 경로 힌트로 쓴다. */
  ask: string;
  goalId?: string;
}

export type ImplFindingsLog = (category: string, event: string, data?: unknown) => void;

export interface ImplFindingsFeedbackSeams {
  /** 원장 디렉터리 — 생략하면 정본 run ledger dir. */
  dir?: string;
  log?: ImplFindingsLog;
  /** 관련 교훈 선택 심 — 생략하면 정본 `selectRelevantAuthoringLessons`. */
  selectLessons?: (root: string, ask: string) => SelectedAuthoringLessons;
  /** 후속 초안 기록 심 — 생략하면 정본 `recordFollowUpOnMerge`(shadow 기본, 자동 발사 없음). */
  followUp?: (input: FollowUpMergeInput, seams?: FollowUpSeams) => Promise<FollowUpDraftRecord | null>;
}

export interface ImplFindingsFeedbackResult {
  findings: ImplFindings;
  /** 이 호출로 원장에 새 기록을 남겼는가 — 같은 PR 재주입이면 false(중복 억제). */
  appended: boolean;
  refusal: 'ledger-write-refused' | null;
  /** 다음 저작(goal-author `authoringLessons`) 입력에 싣는 프롬프트 — 관련 기록만 담는다. */
  authoringInjection: string;
  lessonIds: readonly string[];
  /** 주입한 절 이름(비어 있지 않은 것만). */
  injectedSections: readonly string[];
  /** 생략한 절 이름(비어 있어 주입하지 않은 것). */
  skippedSections: readonly string[];
  /** 후속 초안 기록 — 자동 발사는 하지 않는다(`queued:false`). */
  followUp: FollowUpDraftRecord | null;
}

/**
 * 병합 PR 착지(postland) 때 구현이 밝힌 절을 되먹임한다:
 * ① 세 절을 idempotent 원장에 1회 기록(같은 PR 재주입은 중복 억제),
 * ② 비어 있지 않은 절(관련 기록)만 다음 저작 입력 프롬프트에 주입하고 선택·생략 수를 로그에 남긴다,
 * ③ 남은 것에서 후속 초안을 만든다 — 자동 발사는 하지 않는다(`recordFollowUpOnMerge` shadow 기본).
 */
export async function recordImplFindingsFeedback(
  input: ImplFindingsFeedbackInput,
  seams: ImplFindingsFeedbackSeams = {},
): Promise<ImplFindingsFeedbackResult> {
  const log = seams.log ?? ((category, event, data) => { debug.log(category, event, data); });
  const findings = parseImplFindings(input.prBody);

  // ① idempotent 원장 1회 기록 — 같은 PR 번호의 되먹임 기록이 이미 있으면 append 하지 않는다.
  const decide = (entries: RunLedgerEntry[] | null): RunLedgerCheckedAppendDecision<'duplicate'> => {
    const duplicate = (entries ?? []).some((entry) => entry.event === IMPL_FINDINGS_LEDGER_EVENT
      && entry.data.prNumber === input.prNumber);
    if (duplicate) return { append: false, result: 'duplicate' as const };
    return {
      append: true,
      entry: {
        timestamp: new Date().toISOString(),
        runId: input.runId,
        event: IMPL_FINDINGS_LEDGER_EVENT,
        data: {
          prNumber: input.prNumber,
          paths: [...new Set(input.ask.match(/(?<![\w./~-])([\w.-]+(?:\/[\w.-]+)+\.[\w-]+)/gu)?.map((match) => match.replace(/[.,;:!?]+$/u, '')) ?? [])],
          requirements: findings.requirements,
          newScope: findings.newScope,
          remaining: findings.remaining,
        },
        ...(input.goalId ? { goalId: input.goalId } : {}),
      },
    };
  };
  const outcome = appendRunLedgerEntryChecked(input.runId, decide, seams.dir);
  log('self-implement.impl-findings-feedback', outcome.refusal ? 'ledger-write-refused' : outcome.appended ? 'recorded' : 'duplicate-suppressed', {
    prNumber: input.prNumber,
    appended: outcome.appended,
    remainingCount: findings.remaining.length,
  });

  // ② 관련 기록만 다음 저작 입력에 주입 — 비어 있지 않은 절 ⊕ 관련 교훈 프롬프트.
  const injectedSections: string[] = [];
  const skippedSections: string[] = [];
  const sectionTexts: string[] = [];
  const sections: readonly (readonly [string, string])[] = [
    [IMPL_FINDINGS_REQUIREMENTS_SECTION, findings.requirements],
    [IMPL_FINDINGS_NEW_SCOPE_SECTION, findings.newScope],
  ];
  for (const [name, text] of sections) {
    if (!text) { skippedSections.push(name); continue; }
    injectedSections.push(name);
    sectionTexts.push(`### ${name}\n${text}`);
  }
  const lessons = (seams.selectLessons ?? selectRelevantAuthoringLessons)(process.cwd(), input.ask, elanousStateRoot());
  const authoringInjection = [
    `## 구현이 밝힌 요구사항·새 범위(착지 PR #${input.prNumber})`,
    ...sectionTexts,
    ...(lessons.prompt ? [lessons.prompt] : []),
  ].join('\n\n');
  log('self-implement.impl-findings-feedback', 'authoring-injection', {
    prNumber: input.prNumber,
    injectedSections,
    skippedSections,
    selected: lessons.ids.length,
    status: lessons.status,
    invalidRows: lessons.invalidRows,
    lessonIds: lessons.ids,
  });

  // ③ 남은 것에서 후속 초안 — 자동 발사 없음(shadow 기본, `queued:false`).
  const followUpInput = {
    prNumber: input.prNumber,
    prBody: input.prBody,
    feature: input.ask,
    followUpMustFix: findings.remaining,
    ...(input.goalId ? { cellId: input.goalId } : {}),
  };
  const followUp = await (seams.followUp
    ? seams.followUp(followUpInput)
    : recordFollowUpOnMerge(followUpInput, { mode: 'shadow' }));
  log('self-implement.impl-findings-feedback', followUp ? 'follow-up-drafted' : 'follow-up-none', {
    prNumber: input.prNumber,
    remainingCount: findings.remaining.length,
    queued: followUp?.queued ?? null,
  });

  return {
    findings,
    appended: outcome.appended,
    refusal: outcome.refusal,
    authoringInjection,
    lessonIds: lessons.ids,
    injectedSections,
    skippedSections,
    followUp,
  };
}
