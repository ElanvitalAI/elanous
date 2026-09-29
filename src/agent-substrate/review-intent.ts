// ── 리뷰 intent 조립 (순수) ────────────────────────────────────────────────────
//
// [[RFC-pr-as-review-conversation-medium-2026-07-27]] §2A ①조망·③주입.
//
// ⚠️ **생산자가 있는 블록만 만든다** — 빈 블록 헤더를 만들지 않는다.
//    ⭐ 그리고 `수용기준`·`의도적 스코프 경계` 의 생산자는 **실재한다: 골 텍스트 자체**다
//    (`extractIntentBlocks` · 아래). 사후 리뷰가 *"생산자가 없다며 빼는 것은 범위 축소"* 라고
//    옳게 지적했고, 파싱은 ①조망(있는 사실 조립)이지 ②합성(LLM)이 아니므로 **P1 범위 안**이다.
//    ⇒ 4블록이 전부 성립하며 LLM 은 쓰지 않는다. P3 는 골에 그 절이 **없을 때** 합성으로 채운다.

import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { parseGoalType, type GoalType } from '../self-implement/goal-author.js';
import type { DesignCheckOutcome } from '../design/design-check.js';
import type { DesignGateResult } from '../design/design-gate.js';
import type { PriorDraftFinding } from '../self-implement/prior-draft-findings.js';

export interface ReviewIntentInput {
  /** 무엇을 왜 — 골 원문. */
  readonly goal: string;
  /** 직전 라운드에서 이미 재주입된 must-fix(스테일 재지적 차단). */
  readonly appliedLastRound?: readonly string[];
  /** Same-goal, other-run draft reviewer must-fix findings to re-evaluate against this diff. */
  readonly priorRunFindings?: readonly PriorDraftFinding[];
  /** 현재 rework 라운드(0-base). */
  readonly round?: number;
  /** 리뷰 artifact·관측 로그를 잇는 실행 식별자. */
  readonly runId?: string;
  /** fork 이후 커밋 제목 원문. */
  readonly commits?: readonly string[];
  /** fork 이후 미커밋·커밋 변경 파일. */
  readonly changedFiles?: readonly string[];
  /** 이 런을 발사할 때 하니스가 쓴 골 문서의 저장소 상대 경로. */
  readonly goalFile?: string;
  /** diff에는 드러나지 않는 이행에 관한 자식의 주장과 선택적 명령 결과. verify가 없는 항목은 생산하지 않는다. */
  readonly diffOutsideClaims?: readonly { readonly claim: string; readonly verify: string; readonly result?: string }[];
  /** 같은 골에서 나뉜 형제 shard의 기존 런 체인 투영. */
  readonly shardSiblings?: {
    readonly items: readonly { readonly runId: string; readonly shardId?: string; readonly pieceIndex?: number }[];
    readonly shownItems: number;
    readonly totalItems: number;
    readonly omittedItems: number;
    readonly truncated: boolean;
  };
  /** 게이트가 남긴 실행 증거 메모. */
  readonly gateEvidenceNote?: string;
  /** ★ 골의 `## REQUIRED EVIDENCE` 태그에 대한 **하니스의 기계 판정**(문자열 동등 매칭 · 해석 아님).
   *  ⛔ 판정을 대신하지 않는다 — **무엇을 요구했고 무엇이 매칭됐는지**만 알린다. */
  readonly evidenceCoverage?: {
    readonly required: number;
    readonly covered: number;
    readonly missing: readonly string[];
    readonly coveredByLimitation?: readonly string[];
    readonly uncovered?: readonly string[];
    readonly coveredByLimitationCount?: number;
    readonly uncoveredCount?: number;
    /** 골에 명시된 limitation 수. 요구 0과 declaration 부재를 구분한다. */
    readonly limitationCount?: number;
  };
  /** 수용기준 — 미지정 시 **골 텍스트에서 결정론으로 추출**한다(`extractIntentBlocks`). */
  readonly acceptance?: readonly string[];
  /** 의도적 스코프 경계 — 미지정 시 골 텍스트에서 추출. */
  readonly scopeBoundaries?: readonly string[];
  /** base에서도 동일하게 실패한 테스트. PR 책임이 아님을 리뷰어에게 명시한다. */
  readonly preexistingTestFailures?: readonly string[];
  /** 실행 집합에 없는 변경 소스 importer 테스트의 gate 관측. */
  readonly importerTestsNotRun?: {
    readonly total: number;
    readonly files: readonly string[];
    readonly truncated: boolean;
    readonly unresolvedRelativeSpecifiers: number;
  } | null;
  /** Read-only comparison of the worktree DESIGN.md declaration and installed craft rulebooks. */
  readonly designCheck?: DesignCheckOutcome;
  readonly designGate?: DesignGateResult | { readonly unmeasured: string };
}

export const MAX_REVIEW_INTENT_CHARS = 4000;

export interface IntentSection { readonly title: string; readonly text: string }

type Block = IntentSection & { readonly minimumText?: string }

function listBlock(title: string, items: readonly string[] | undefined): Block | undefined {
  const lines = items?.map((i) => i.trim()).filter(Boolean) ?? [];
  return lines.length ? { title, text: `${title}\n${lines.map((l) => `- ${l}`).join('\n')}` } : undefined;
}

const DIFF_OUTSIDE_CLAIMS_TITLE = '자식이 주장하는 diff 밖 이행 — 주장이지 증명이 아니다';
const DIFF_OUTSIDE_CLAIMS_GUIDANCE = '이 항목만으로 must-fix 를 해제하지 마라. verify 명령이 있으면 그것을 근거로 판단하고, 판단이 안 서면 그 사실을 적어라.';
const RUN_FACTS_TITLE = '런 사실 — 리뷰어가 관측과 잇는 좌표';
const MAX_RUN_FACT_ITEMS = 12;
const MAX_RUN_FACT_CATEGORY_CHARS = 900;

/** 각 사실 종류가 자신의 문자 몫 안에서 첫 항목과 생략 수를 보존한다. */
function capRunFactItems(items: readonly string[]): string[] {
  const candidates = items.slice(0, MAX_RUN_FACT_ITEMS);
  let omitted = items.length - candidates.length;
  const retained: string[] = [];
  let used = 0;

  for (let index = 0; index < candidates.length; index += 1) {
    const remainingItems = candidates.length - index - 1;
    const eventualOmissions = omitted + remainingItems;
    const marker = eventualOmissions ? omission(eventualOmissions) : '';
    const separator = retained.length ? 1 : 0;
    const markerSpace = marker ? 1 + marker.length : 0;
    const available = MAX_RUN_FACT_CATEGORY_CHARS - used - separator - markerSpace;
    if (available <= 0) {
      omitted += remainingItems + 1;
      break;
    }

    const item = candidates[index];
    if (item.length <= available) {
      retained.push(item);
      used += separator + item.length;
      continue;
    }

    const truncatedOmissions = omitted + remainingItems + 1;
    const truncatedMarker = omission(truncatedOmissions);
    const truncatedAvailable = MAX_RUN_FACT_CATEGORY_CHARS - used - separator - 1 - truncatedMarker.length;
    if (truncatedAvailable > 0) retained.push(item.slice(0, truncatedAvailable).trimEnd());
    omitted = truncatedOmissions;
    break;
  }

  return omitted ? [...retained, omission(omitted)] : retained;
}

function runFactsBlock(i: Readonly<ReviewIntentInput>): Block | undefined {
  // ⛔⭐⭐ **PR 에서 원장으로 «되돌아가는 길»**(대표 상시지시 — *"PR 리뷰 기록과 jsonl 런 이력은
  //   «한 기록의 두 면»"*). 종전엔 `runId` «좌표»만 실려서, 그 런의 관측 원장을 열려면
  //   ***읽는 사람이 명령을 «알고 있어야» 했다.*** 좌표만 주고 길을 안 준 것이다.
  //   ⇒ `runId` 바로 뒤에 그 원장을 여는 «명령 그대로»를 싣는다. 이 절은 `prBody` 가 품으므로
  //     **PR 본문과 리뷰어 프롬프트 «둘 다»**에 닿는다.
  //   ⛔ `runId` 범주 «안»에 둔다 — 새 범주를 만들면 예산 배분(범주별 최소 몫 예약)이 바뀐다.
  const trimmedRunId = i.runId?.trim();
  const runId = trimmedRunId ? [`runId: ${trimmedRunId}`, `원장: elanous self run-ledger ${trimmedRunId}`] : [];
  const commits = i.commits?.map((commit) => commit.trim()).filter(Boolean).map((commit) => `커밋: ${commit}`) ?? [];
  const changedFiles = [...new Set(i.changedFiles?.map((file) => file.trim()).filter(Boolean) ?? [])].map((file) => `변경 파일: ${file}`);
  const categories = [runId, commits, changedFiles]
    .filter((items) => items.length)
    .map((items) => capRunFactItems(items));
  const items = categories.flat();
  const block = listBlock(RUN_FACTS_TITLE, items);
  if (!block) return undefined;

  // 전역 예산에서도 각 범주가 동일한 절단·생략 결과로 최소 몫을 예약한다.
  // 원본 첫 항목을 쓰면 범주별 상한을 우회해 뒤 범주와 보호 블록을 밀어낸다.
  const minimumItems = categories.map(([item]) => item!);
  return { ...block, minimumText: `${RUN_FACTS_TITLE}\n${minimumItems.map((item) => `- ${item}`).join('\n')}` };
}

function priorRunFindingsBlock(findings: ReviewIntentInput['priorRunFindings']): Block | undefined {
  if (!findings?.some((finding) => finding.items.length)) return undefined;
  const title = '앞 런이 남긴 지적(같은 골 · 다른 런)';
  const items = findings.flatMap((finding) => finding.items.map((item) => `- #${finding.pr} · 라운드 ${finding.round} · ${item}`));
  return {
    title,
    text: `${title}\n${items.join('\n')}\n각 항목이 이 diff 에서 닫혔는지 판정하라 — 닫히지 않았고 이 PR 범위에 해당하면 must-fix 로 올린다 · 해당 없으면 이유 한 줄`,
  };
}

function preexistingFailuresBlock(items: ReviewIntentInput['preexistingTestFailures']): Block | undefined {
  const failures = items?.map((item) => item.trim()).filter(Boolean) ?? [];
  return failures.length
    ? {
      title: 'base에서도 실패하는 테스트 — 이 PR의 책임이 아님',
      text: `base에서도 실패하는 테스트 — 이 PR의 책임이 아님\n이 실패들은 base에서도 실패한다 — 이 PR의 책임이 아니다. 레포의 빨간 상태는 별도 소유 트랙에서 수리해야 한다.\n${failures.map((failure) => `- ${failure}`).join('\n')}`,
    }
    : undefined;
}

function importerTestsNotRunBlock(observation: ReviewIntentInput['importerTestsNotRun']): Block | undefined {
  if (observation === undefined || observation === null) return undefined;
  const files = observation.files.map((file) => file.trim()).filter(Boolean);
  return {
    title: '실행하지 않은 importer 테스트 — 게이트 관측',
    text: `실행하지 않은 importer 테스트 — 게이트 관측\n- 총수: ${observation.total}\n- 파일: ${files.length ? files.join(', ') : '없음'}\n- 파일 목록 절단: ${observation.truncated ? '예' : '아니오'}\n- 못 푼 상대 경로 지정자: ${observation.unresolvedRelativeSpecifiers}`,
  };
}

/** ⛔⭐⭐ **판정자가 파서를 안 읽는다**(원장 `JDG-S4`·`JDG-S5` · 오늘 두 번 재현). 하니스는
 *  `coveredEvidence`/`missingEvidence` 를 **이미 계산해 로그에 남기는데** 그 값이 리뷰어에게 안 갔고,
 *  리뷰는 *"필수 파괴 검증 증거가 없다"* 를 냈다 — 같은 라운드 로그가 `missingEvidence:[]` 인데도.
 *  ⇒ **기계 판정을 알린다.** ⛔ *"그러므로 충족됐다"* 라고 쓰지 않는다 — 품질 판정은 리뷰어의 것이다. */
function gateEvidenceBlock(note: ReviewIntentInput['gateEvidenceNote']): Block | undefined {
  const text = note?.trim();
  return text ? { title: '게이트 실행 증거 메모', text: `게이트 실행 증거 메모\n${text}` } : undefined;
}

function designCheckBlock(outcome: ReviewIntentInput['designCheck']): Block | undefined {
  if (!outcome) return undefined;
  const title = '디자인 규칙집 선언 판정 — 정보성';
  return !outcome.ok
    ? { title, text: `${title}\n- 측정 불가: ${outcome.blockedOn}\n- 경로: ${outcome.path}` }
    : {
      title,
      text: [
        title,
        `- DESIGN.md: ${outcome.documentPath}`,
        `- craft 규칙집: ${outcome.craftDirectory}`,
        `- 선언: ${outcome.declaredRulebooks.join(', ') || '(없음)'}`,
        `- 미설치 선언: ${outcome.unavailableRulebooks.join(', ') || '(없음)'}`,
      ].join('\n'),
    };
}

function designGateBlock(outcome: ReviewIntentInput['designGate']): Block | undefined {
  if (!outcome) return undefined;
  if ('unmeasured' in outcome) {
    const title = '디자인 게이트 — 측정 불가';
    return { title, text: `${title}\n측정 불가: ${outcome.unmeasured}` };
  }
  if (outcome.verdict === 'not-applicable') return undefined;
  if (outcome.verdict === 'pass') {
    const title = `디자인 게이트 통과(방향 ${outcome.direction})`;
    return { title, text: title };
  }
  const title = `디자인 게이트 — must-fix 후보(P0 ${outcome.p0Total})`;
  const findings = outcome.files.flatMap((file) => file.findings
    .filter((finding) => finding.severity === 'p0')
    .map((finding) => `${file.path}:${finding.line ?? '?'} ${finding.rule}`));
  const shown = findings.slice(0, 20);
  const omitted = findings.length - shown.length;
  return {
    title,
    text: [title, ...shown.map((finding) => `- ${finding}`), ...(omitted ? [`- …${omitted}개 생략`] : [])].join('\n'),
  };
}

function shardSiblingsBlock(siblings: ReviewIntentInput['shardSiblings']): Block | undefined {
  if (!siblings?.items.length) return undefined;
  const items = siblings.items.map((sibling) => `${sibling.runId}${sibling.shardId ? ` (${sibling.shardId}${sibling.pieceIndex !== undefined ? ` #${sibling.pieceIndex}` : ''})` : ''}`);
  const omission = siblings.omittedItems > 0 ? `\n- …[형제 shard ${siblings.omittedItems}개 생략됨]` : '';
  return {
    title: '같은 골의 형제 shard',
    text: `같은 골의 형제 shard\n- 표시 ${siblings.shownItems}/${siblings.totalItems}개\n${items.map((item) => `- ${item}`).join('\n')}${omission}`,
  };
}

function evidenceCoverageBlock(coverage: ReviewIntentInput['evidenceCoverage']): Block | undefined {
  if (!coverage || (coverage.required <= 0 && !coverage.limitationCount)) return undefined;
  const title = '골이 요구한 증거 태그 — 하니스의 기계 판정(문자열 동등 · 해석 아님)';
  const missing = coverage.missing.length ? `누락: ${coverage.missing.join(', ')}` : '누락: 없음';
  const coveredByLimitation = coverage.coveredByLimitation?.length
    ? `선언으로 덮임: ${coverage.coveredByLimitation.join(', ')}`
    : '선언으로 덮임: 없음';
  const uncovered = coverage.uncovered?.length
    ? `선언·자식 보고 어느 쪽으로도 덮이지 않음: ${coverage.uncovered.join(', ')}`
    : '선언·자식 보고 어느 쪽으로도 덮이지 않음: 없음';
  const limitationCount = coverage.limitationCount ?? 0;
  return {
    title,
    text: [
      title,
      '⛔ 이 줄은 **무엇이 매칭됐는지**만 말한다 — 증거의 **질**은 아래 자식 주장과 diff 로 판단하라.',
      `- 골이 요구한 태그 ${coverage.required}개 · 자식 보고에서 매칭 ${coverage.covered}개 · ${missing}`,
      `- Author limitation 선언 ${limitationCount}개 · ${coveredByLimitation} · ${uncovered}`,
    ].join('\n'),
  };
}

function diffOutsideClaimsBlock(items: ReviewIntentInput['diffOutsideClaims']): Block | undefined {
  const claims = items?.flatMap(({ claim, verify, result }) => {
    const normalizedClaim = claim.trim();
    const normalizedVerify = verify.trim();
    const normalizedResult = result?.trim();
    return normalizedClaim && normalizedVerify ? [{ claim: normalizedClaim, verify: normalizedVerify, ...(normalizedResult ? { result: normalizedResult } : {}) }] : [];
  }) ?? [];
  return claims.length
    ? { title: DIFF_OUTSIDE_CLAIMS_TITLE, text: `${DIFF_OUTSIDE_CLAIMS_TITLE}\n${DIFF_OUTSIDE_CLAIMS_GUIDANCE}\n${claims.map(({ claim, verify, result }) => `- 주장: ${claim}\n  verify: ${verify}${result ? `\n  result: ${result}` : ''}`).join('\n')}` }
    : undefined;
}

function marker(title: string): string {
  return `\n\n[리뷰 intent 길이 상한으로 '${title}' 블록부터 잘렸습니다]`;
}

/** 어느 절부터 잘렸는지 — 4블록 제목(조립기 산출)이든 마크다운 헤더(사람이 쓴 본문)든 찾는다. */
function sectionAt(text: string, cut: number): string {
  const head = text.slice(0, cut);
  // 마지막으로 시작된 절 제목을 역방향으로 찾는다. 없으면 '뒤쪽'.
  const lines = head.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const l = lines[i]!;
    const md = /^\s*#{1,6}\s+(.{1,60}?)\s*$/.exec(l);
    if (md) return md[1]!;
    if (/^(목표|수용기준|직전 라운드 반영분|런 사실 — 리뷰어가 관측과 잇는 좌표|자식이 주장하는 diff 밖 이행 — 주장이지 증명이 아니다|의도적 스코프 경계)\s*$/.test(l.trim())) return l.trim();
  }
  return '뒤쪽';
}

/**
 * ⭐ **절단 표기 공용화**(리뷰 must-fix — 수용기준 7 은 조립기 경로에만 적용돼 있었다).
 *
 * 수동 경로(`--intent` · PR 본문)는 `buildReviewIntent` 를 거치지 않으므로 종전엔 **무표식**
 * `slice(0, 4000)` 이었다 ⇒ 4블록을 잘 쓴 본문이 중간에서 잘려도 리뷰어는 **완전한 intent 로 착각**한다.
 * 어느 절부터 잘렸는지 같은 형식으로 알린다.
 */
interface CappedIntent {
  readonly text: string;
  readonly truncated: boolean;
  readonly totalChars?: number;
  readonly section?: string;
}

function cappedIntent(text: string, max: number): CappedIntent {
  if (text.length <= max) return { text, truncated: false };
  // 마커 자리를 먼저 예약하고(조립기와 같은 규율) 그 지점의 절을 지목한다.
  const probe = marker(sectionAt(text, max));
  const budget = Math.max(0, max - probe.length);
  const section = sectionAt(text, budget);
  return {
    text: `${text.slice(0, budget)}${marker(section)}`,
    truncated: true,
    totalChars: text.length,
    section,
  };
}

/** 기존 문자열 소비자 계약을 유지하는 intent 상한 적용. */
export function capIntent(text: string, max = MAX_REVIEW_INTENT_CHARS): string {
  return cappedIntent(text, max).text;
}

/** 절단된 intent만 관측에 올릴 메타데이터. 미절단은 빈 객체로 구 호출자 payload를 보존한다. */
export function reviewIntentTruncationObservation(
  text: string,
  max = MAX_REVIEW_INTENT_CHARS,
): { intentTruncated?: boolean; intentTotalChars?: number; intentSection?: string } {
  const capped = cappedIntent(text, max);
  return capped.truncated
    ? { intentTruncated: true, intentTotalChars: capped.totalChars!, intentSection: capped.section! }
    : {};
}

/** 리뷰 프롬프트와 게이트 증빙이 **공유하는** 절단 표기(2026-08-01 · [S] must-fix · [T] 저작).
 *  ⛔ 두 곳이 다른 문면을 쓰면 같은 입력에 **언어·위치·수 셋이 갈린다** — 실제로 그랬다. */
export function omission(count: number): string {
  return `…[${count}개 생략됨]`;
}

function blockLines(block: Block): string[] {
  return block.text.slice(block.title.length).replace(/^\n/, '').split('\n').filter(Boolean);
}

/** 제목은 항상 남기고, 넘치는 본문은 블록 안에서 절단 표기와 함께 보존한다. */
function fitBlock(block: Block, budget: number, preserveBody = false): string {
  if (block.text.length <= budget) return block.text;
  const lines = blockLines(block);
  const prefix = `${block.title}\n`;
  const wholeBlockOmission = `${prefix}${omission(lines.length)}`;
  if (!preserveBody) {
    for (let kept = lines.length; kept >= 0; kept -= 1) {
      const text = `${prefix}${[...lines.slice(0, kept), omission(lines.length - kept)].join('\n')}`;
      if (text.length <= budget) return text;
    }
    return wholeBlockOmission;
  }
  if (wholeBlockOmission.length > budget) return block.title.slice(0, budget);

  for (let omitted = 1; omitted <= lines.length; omitted += 1) {
    const marker = omission(omitted);
    const contentBudget = budget - prefix.length - marker.length - 1;
    const completeLines = lines.slice(0, lines.length - omitted);
    const complete = completeLines.join('\n');
    if (contentBudget < complete.length) continue;

    // A partially retained line is itself an omitted item, alongside every later removed line.
    const partialBudget = Math.max(0, contentBudget - complete.length - (complete ? 1 : 0));
    const partial = lines[lines.length - omitted]?.slice(0, partialBudget).trimEnd();
    const kept = [complete, partial].filter(Boolean).join('\n');
    return kept ? `${prefix}${kept}\n${marker}` : wholeBlockOmission;
  }
  return wholeBlockOmission;
}

function minimumBlock(block: Block): string {
  if (block.minimumText) return block.minimumText;
  const lines = blockLines(block);
  return lines.length ? `${block.title}\n${omission(lines.length)}` : block.title;
}

/** 이미 조립된 절 블록을 같은 상한 안에서 공정하게 맞춘다. */
/**
 * 절별 산출을 **블록 신원으로** 돌려준다 — 조립 문자열을 «되파싱»하지 않게.
 *
 * ⛔⭐⭐ 초판 관측기는 완성된 문자열에서 `indexOf(title)` ⊕ `split('\n\n')` 으로 절 구간을 되찾았고,
 *    무인 리뷰가 must-fix 둘을 냈다(둘 다 실재):
 *    ① **같은 제목이 두 번** 나오면(예: `blockedDraftPrBody` 가 `prBody` 를 다시 실어 `## Gate` 가 둘)
 *       전부 첫 occurrence 로 접혀 **과대계상**한다.
 *    ② 헤더 뒤 **빈 줄**(정상 마크다운 `## 수용기준\n\n- 항목`)이면 `split('\n\n')[0]` 이 빈 문자열이라
 *       살아남았는데 **「제목만」으로 오판**한다.
 *  ⇒ 되파싱을 없앤다. 조립기가 «만들 때» 알던 것을 그대로 넘긴다.
 */
function fitReviewIntentPieces(
  blocks: readonly Block[],
  order: readonly Block[] = blocks,
  fairShareBlocks: readonly Block[] = blocks,
  preserveBlockBodies = false,
): { text: string; perBlock: Map<Block, string> } {
  /** 블록→산출 조각으로 결과를 만든다. 빈 조각은 「안 실렸다」 = 조립 문자열에서도 빠진다. */
  const assemble = (pieceOf: (block: Block) => string, tail?: string) => {
    const perBlock = new Map<Block, string>(blocks.map((block) => [block, pieceOf(block)]));
    const parts = blocks.map((block) => perBlock.get(block)!).filter(Boolean);
    return { text: [...parts, ...(tail ? [tail] : [])].join('\n\n'), perBlock };
  };
  const intent = blocks.map((block) => block.text).join('\n\n');
  if (intent.length <= MAX_REVIEW_INTENT_CHARS) return assemble((block) => block.text);

  const minimums = new Map(blocks.map((block) => [block, minimumBlock(block)]));
  // ⛔⭐⭐⭐ **선택은 «우선순위» 순이다**(3R 리뷰 must-fix · 2026-08-07).
  //   종전엔 «문서 순서»로 담아 상한에 걸리면 **뒤쪽을 잘랐다**. 그런데 이 저장소의 하니스 본문은
  //   `## 리뷰 intent` 가 **22k 위치(맨 뒤)** 다 — ***내가 고치려던 그 결함이 이 분기에 그대로 살아 있었다.***
  //   ⇒ `order`(호출자가 준 우선순위)로 담는다. 산출 «순서»는 `assemble` 이 원문 순서로 되돌린다.
  //   ⚠️ 기본값 `order = blocks` 라 우선순위를 안 준 호출자(`buildManualReviewIntent`)는 **종전 그대로**다.
  // ⛔⭐⭐ **저순위 절이 상한을 다 먹지 못하게 «몫을 먼저 뗀다»**(3R must-fix ① 2차 수리).
  //   우선순위 순으로 담기만 하면 판정 절은 «들어가되» 제목뿐이 된다(실측: 본문이 2자만 남았다).
  //   ⇒ 우선순위 절의 최소치를 먼저 깔고, 그 «본문 몫»을 예약한 뒤, 남는 자리에 나머지를 담는다.
  const priority = new Set(fairShareBlocks);
  const compacted: Block[] = [];
  let used = 0;
  const add = (block: Block): boolean => {
    const separator = compacted.length ? 2 : 0;
    if (used + separator + minimums.get(block)!.length > MAX_REVIEW_INTENT_CHARS) return false;
    compacted.push(block); used += separator + minimums.get(block)!.length; return true;
  };
  for (const block of order) if (priority.has(block)) add(block);
  // 예약 — 남은 자리의 절반까지는 «판정 절 본문»을 위해 비워 둔다. ⚠️ 우선순위를 안 준 호출자는
  //   `fairShareBlocks === blocks` 라 아래 루프가 담을 것이 없고, 예약분은 그대로 본문 성장에 쓰인다.
  const reserve = priority.size < blocks.length ? Math.floor(Math.max(0, MAX_REVIEW_INTENT_CHARS - used) / 2) : 0;
  const ceiling = MAX_REVIEW_INTENT_CHARS - reserve;
  for (const block of order) {
    if (priority.has(block)) continue;
    const separator = compacted.length ? 2 : 0;
    if (used + separator + minimums.get(block)!.length > ceiling) continue;
    compacted.push(block); used += separator + minimums.get(block)!.length;
  }
  if (compacted.length !== blocks.length) {
    // ⛔ 자리를 못 만들면 «우선순위가 낮은 것부터» 뺀다 — `compacted` 가 우선순위 순이라 뒤가 낮다.
    while (compacted.length && used + 2 + omission(blocks.length - compacted.length).length > MAX_REVIEW_INTENT_CHARS) {
      const removed = compacted.pop()!;
      used -= minimums.get(removed)!.length + (compacted.length ? 2 : 0);
    }
    const kept = new Set(compacted);
    // ⭐⭐ **남는 예산으로 판정 절의 «본문»을 살린다**(must-fix ①: 종전엔 살아남은 것도 전부 제목뿐이라
    //   *"판정 절이 본문까지 살아남는다"* 는 수용기준을 이 분기에서 «위반»했다).
    const tail = omission(blocks.length - compacted.length);
    let spare = MAX_REVIEW_INTENT_CHARS - used - (compacted.length ? 2 : 0) - tail.length;
    const pieces = new Map<Block, string>(compacted.map((block) => [block, minimums.get(block)!]));
    for (const block of compacted) {                       // 우선순위 순 — 앞에서부터 본문을 채운다
      if (spare <= 0) break;
      const min = minimums.get(block)!;
      const grown = fitBlock(block, min.length + spare, preserveBlockBodies);
      if (grown.length > min.length) { pieces.set(block, grown); spare -= grown.length - min.length; }
    }
    // 통째로 빠진 블록은 **빈 조각**으로 남긴다 — 관측이 「안 실렸다」를 값으로 알 수 있게.
    return assemble((block) => (kept.has(block) ? pieces.get(block)! : ''), tail);
  }

  const separators = Math.max(0, blocks.length - 1) * 2;
  const budgets = new Map(blocks.map((block) => [block, minimums.get(block)!.length]));
  let remaining = MAX_REVIEW_INTENT_CHARS - separators - blocks.reduce((sum, block) => sum + minimums.get(block)!.length, 0);
  const fairShare = fairShareBlocks.length ? Math.floor(remaining / fairShareBlocks.length) : 0;
  for (const block of fairShareBlocks) {
    const current = budgets.get(block)!;
    const extra = Math.max(0, Math.min(remaining, block.text.length - current, fairShare));
    budgets.set(block, current + extra);
    remaining -= extra;
  }
  for (const block of order) {
    const current = budgets.get(block)!;
    const extra = Math.max(0, Math.min(remaining, block.text.length - current));
    budgets.set(block, current + extra);
    remaining -= extra;
  }
  return assemble((block) => fitBlock(block, budgets.get(block)!, preserveBlockBodies));
}

/** 기존 문자열 계약 — 조립 결과만 돌려준다(호출자 무변경). */
function fitReviewIntentBlocks(
  blocks: readonly Block[],
  order: readonly Block[] = blocks,
  fairShareBlocks: readonly Block[] = blocks,
  preserveBlockBodies = false,
): string {
  return fitReviewIntentPieces(blocks, order, fairShareBlocks, preserveBlockBodies).text;
}

/** 수동 `--intent`와 PR 본문을 절 블록으로 나눈 뒤 기존 리뷰 intent 예산기를 적용한다. */
export function buildManualReviewIntent(explicitIntent: string, prBody: string): string {
  const source = `## 명시 intent\n${explicitIntent}\n\n## PR 본문\n${prBody}`;
  if (source.length <= MAX_REVIEW_INTENT_CHARS) return source;
  return fitReviewIntentBlocks(extractIntentBlocks(source, true).sections ?? [], undefined, undefined, true);
}

const GOAL_TYPE_SUCCESS_CONDITIONS: Readonly<Record<GoalType, string>> = {
  implement: '게이트 통과와 PR 머지다.',
  research: '산출 문서가 존재하고 그 안에 반증 명령이 있고 인용이 열리는 것이다. 코드 변경이 없다는 것 자체는 결손이 아니다.',
  document: '산출 경로에 파일이 생겼고 링크 린트가 통과하는 것이다. 코드 변경이 없다는 것 자체는 결손이 아니다.',
  operate: '명세 파일이 생겼고 그것을 읽어 등록하는 dry-run 이 통과하는 것이다. 스케줄을 실제로 등록하지 않는 것이 옳다.',
};

function goalTypeBlock(goal: string): Block | undefined {
  const goalType = parseGoalType(goal);
  return goalType ? {
    title: '골 종류와 성공 조건',
    text: `골 종류와 성공 조건\n종류: ${goalType}\n성공: ${GOAL_TYPE_SUCCESS_CONDITIONS[goalType]}`,
  } : undefined;
}

function goalFileBlock(goalFile: string | undefined): Block | undefined {
  const path = goalFile?.trim();
  return path
    ? {
      title: '이 런의 골 문서',
      text: `이 런의 골 문서: ${path} — 하니스가 발사 때 쓴 산출물이다. diff 에 있는 것이 정상이며 시험 부작용이 아니다.`,
    }
    : undefined;
}

export function buildReviewIntent(i: Readonly<ReviewIntentInput>): string {
  // ① 조망 — 명시값이 없으면 **골 텍스트에서 추출**한다(생산자는 골 자체다·LLM 없음).
  const mined = extractIntentBlocks(i.goal);
  const acceptance = i.acceptance ?? mined.acceptance;
  const boundaries = i.scopeBoundaries ?? mined.scopeBoundaries;
  const unverifiedBoundaryCandidates = mined.unverifiedBoundaryCandidates;
  const goalType = goalTypeBlock(i.goal);
  // ⚠️ 목표 블록에는 **추출된 절을 뺀 나머지**를 넣는다(리뷰 should-fix) — 골 원문을 통째로 넣고
  //   그 안의 수용기준을 다시 목록으로 붙이면 **같은 내용이 두 번** 들어가 4000자 예산을 먹고,
  //   후순위 블록(스코프 경계)이 불필요하게 잘린다.
  const goalBody = stripExtractedSections(i.goal).trim();
  const goal = goalBody ? { title: '목표', text: `목표\n${goalBody}` } : undefined;
  // ⭐ **자식이 낸 증거**(diff 밖 이행 · base 적색 · 직전 반영분)를 한 묶음으로 잡아 둔다 — 아래 예산
  //   배분에서 **목표 본문보다 먼저** 채우기 위해서다. 제목 문자열이 아니라 **동일성**으로 가른다.
  const applied = listBlock('직전 라운드 반영분', i.appliedLastRound);
  const priorFindings = priorRunFindingsBlock(i.priorRunFindings);
  const preexisting = preexistingFailuresBlock(i.preexistingTestFailures);
  const importerTestsNotRun = importerTestsNotRunBlock(i.importerTestsNotRun);
  const claims = diffOutsideClaimsBlock(i.diffOutsideClaims);
  const gateEvidence = gateEvidenceBlock(i.gateEvidenceNote);
  const designCheck = designCheckBlock(i.designCheck);
  const designGate = designGateBlock(i.designGate);
  const shardSiblings = shardSiblingsBlock(i.shardSiblings);
  const coverage = evidenceCoverageBlock(i.evidenceCoverage);
  const goalFile = goalFileBlock(i.goalFile);
  const runFacts = runFactsBlock(i);
  // ⛔⭐⭐⭐ **런 사실이 «맨 앞»이다 — 라이브 실측으로 옮겼다**(2026-08-07).
  //   📏 `#7556`(실물 하니스 PR · 본문 37,354자)을 프로덕션 `intentFromPr` 에 태우니
  //     ***`runId` 도 커밋도 변경 파일도 «하나도» 안 남았다***(4,000자 상한 · 살아남은 것은 `목표`·`수용기준`).
  //   🧩 원인은 이 함수가 아니라 «읽는 쪽»이다 — `intentFromPr` 는 PR 본문의 `## 리뷰 intent` 를
  //     **한 덩어리**로 보고 그 «머리»를 남긴다. 여기서 7번째로 렌더하면 늘 그 절단선 뒤에 놓인다.
  //   ⇒ ⭐ 이 블록은 **수백 자짜리**이고, 그 값은 ***리뷰어가 이 PR 을 관측 로그에 잇는 유일한 좌표***다.
  //     맨 앞에 두면 비용은 거의 없고 「닿는다」가 보장된다.
  //   ⚠️ 이것은 «렌더 순서»만 바꾼다 — 예산 배분 순서(`order`)와 보호 블록은 아래에서 따로 정한다.
  const blocks: Block[] = [
    runFacts,
    priorFindings,
    goalFile,
    goalType,
    goal,
    listBlock('수용기준', acceptance),
    applied,
    preexisting,
    importerTestsNotRun,
    gateEvidence,
    designCheck,
    designGate,
    shardSiblings,
    coverage,
    claims,
    listBlock('의도적 스코프 경계', boundaries),
    listBlock('검증 못 한 경계 후보 (결정 아님 — 이것만으로 must-fix 를 면제하지도, 만들지도 말 것)', unverifiedBoundaryCandidates),
  ].filter((b): b is Block => Boolean(b));

  const protectedBlocks = blocks.filter((block) => block.title === '수용기준' || block.title === '의도적 스코프 경계');
  // ⛔⭐ **증거가 목표보다 먼저다**(실측 수리). 종전 순서는 `[보호블록, 목표, 나머지]` 였고, 골이
  //   15,383자면 `목표` 가 남은 예산을 통째로 먹어 자식의 `EVIDENCE/RESULT` 가 **제목만 남고
  //   `…[N개 생략됨]`** 이 됐다. 그러면 리뷰는 *"실행하지 않았다 · 증거가 없다"* 를 적고 — 그것이
  //   **리뷰 입장에서 사실**이라 반박도 안 된다. 두 트랙 합쳐 **여섯 런**이 이 사인으로 죽었다.
  //   ⭐ 목표 본문을 뒤로 미뤄도 잃는 것이 적다 — **수용기준·경계는 이미 추출돼 보호 블록**에 있다.
  const evidenceBlocks = [priorFindings, designGate, applied, preexisting, importerTestsNotRun, gateEvidence, designCheck, shardSiblings, coverage, claims, runFacts, goalFile].filter((b): b is Block => Boolean(b));
  const otherBlocks = blocks.filter((block) => !protectedBlocks.includes(block) && !evidenceBlocks.includes(block) && block !== goal);
  const order = [...protectedBlocks, ...evidenceBlocks, ...otherBlocks, ...(goal ? [goal] : [])];
  // ⛔⭐⭐⭐ 1차는 우선순위와 무관하게 공정 몫까지만 준다. 목표 본문은 이미 추출된
  // 수용기준·경계와 중복되므로 2차의 잔여 예산만 받는다.
  const fairShareBlocks = order.filter((block) => block !== goal);
  return fitReviewIntentBlocks(blocks, order, fairShareBlocks);
}

/** PR 에서 intent 를 뽑는다 — **본문 우선·제목 폴백**. 둘 다 비면 빈 문자열(호출측이 폴백). */
function intentSourceFromPr(o: { title: string; body?: string }): string {
  return o.body?.trim() || o.title.trim();
}

// ── PR 본문 intent — **블록 우선 예산** ────────────────────────────────────────
//
// ⛔⭐⭐⭐ **실측 결함(2026-08-07)**: 종전 `intentFromPr` 는 `capIntent` = **통짜 앞자르기**였다.
//    그런데 하니스 PR 본문은 `## 구현 요약`(transcript 꼬리)이 앞에 있어 `## 리뷰 intent` 절이
//    **22,486~31,666자** 위치에 놓인다(실측 8건 중 6건). 상한은 4,000 이다.
//    ⇒ ***RFC-pr-as-review-conversation-medium §2A ③ 「PR 본문에 보존 — 사후 리뷰가 다시 읽는다」가
//       «도달 불가»였다.*** 보존은 하는데 아무도 못 읽는다.
//    ⭐ 기계는 이미 있었다 — `buildManualReviewIntent` 가 쓰는 `extractIntentBlocks(…,true)` ⊕
//       `fitReviewIntentBlocks`. 이 함수만 그것을 안 썼다.
//
// ⛔ **무회귀 계약**: 절을 하나도 못 알아보면 **종전과 «완전 동일»한** `capIntent` 로 떨어진다.
//    새 경로는 「상한을 넘고 ⊕ 절이 인식될 때」만 돈다.

/** 예산을 «먼저» 받는 절 — 판정 기준. 없으면 리뷰어가 무엇으로 판정할지 모른다.
 *  📏 실물 하니스 본문(`#7443`)의 헤더 전수에서 골라냈다 — 골 문서가 통째로 실리고 판정 절은
 *     **영문 헤더**로 온다(`## ACCEPTANCE CRITERIA`·`## SCOPE BOUNDARY`·`## RULES`·`## 불변식`·`## 판정 신호`).
 *  ⛔ 여기에 «전부» 넣으면 우선순위가 없는 것과 같다 — 판정에 «쓰이는» 절만 둔다. */
const PRIORITY_HEAD_HINTS = [
  '리뷰 intent', '명시 intent', '사람 판단 필요', 'must-fix',
  '불변식', '판정 신호', 'rules',
];
/** 그 다음 — 자식이 낸 증거. ⛔ 굶기면 리뷰가 *"실행하지 않았다"* 를 적고 **반박도 안 된다**
 *  (여섯 런이 이 사인으로 죽었다 · `buildReviewIntent` 의 같은 규율). */
const EVIDENCE_HEAD_HINTS = ['증거', 'evidence'];

/** 절 제목의 우선순위 — 낮을수록 먼저 예산을 받는다. */
function sectionPriority(title: string): 0 | 1 | 2 {
  // ⛔⭐ **머리말은 «사람이 쓴 글»이다** — 헤더가 없다는 이유로 맨 뒤로 밀면, PR 설명을 산문으로
  //   시작한 사람의 문장이 기계가 만든 절들에 밀려 **제목만 남는다**(리뷰 should-fix 가 겨눈 자리 ·
  //   실측으로 재현됨). 판정 기준(0)보다는 뒤, 기계 덤프(2)보다는 앞에 둔다.
  if (title === PREAMBLE_TITLE) return 1;
  const t = title.replace(/^#{1,6}\s*/, '').trim().toLowerCase();
  if (PRIORITY_HEAD_HINTS.some((h) => t.includes(h.toLowerCase()))) return 0;
  if (ACCEPTANCE_HEADS.some((h) => t.includes(h)) || BOUNDARY_HEADS.some((h) => t.includes(h))) return 0;
  if (EVIDENCE_HEAD_HINTS.some((h) => t.includes(h))) return 1;
  return 2;
}

/** 첫 헤더 «앞»의 산문. ⛔ 이것을 안 실으면 헤더 없이 시작하는 본문에서 **머리말이 통째로 사라진다**
 *  — `extractIntentBlocks` 의 절 수집은 첫 헤더부터 시작하기 때문이다. */
const PREAMBLE_TITLE = '(머리말)';

type MarkdownPosition = { readonly start: { readonly offset?: number }; readonly end: { readonly offset?: number } };
type MarkdownNode = { readonly type: string; readonly position?: MarkdownPosition; readonly children?: readonly MarkdownNode[] };
type MarkdownUnit = { readonly text: string; readonly start: number; readonly end: number };

/** 비교 가능한 CommonMark 단위와 그 원문 범위. 코드 펜스는 원문에 남기되 비교 후보에서는 제외한다. */
function topLevelMarkdownUnits(section: string): MarkdownUnit[] | undefined {
  try {
    const tree = unified().use(remarkParse).use(remarkGfm).parse(section) as MarkdownNode;
    const children = tree.children ?? [];
    const units: MarkdownUnit[] = [];
    for (const node of children) {
      if (node.type === 'code') continue;
      // 목록은 이어지는 들여쓰기 줄까지 포함한 listItem 하나가 제거 단위다.
      const candidates = node.type === 'list' ? node.children ?? [] : [node];
      for (const candidate of candidates) {
        const start = candidate.position?.start.offset;
        const end = candidate.position?.end.offset;
        if (start === undefined || end === undefined || start < 0 || end <= start) return undefined;
        const text = section.slice(start, end);
        if (!text) return undefined;
        units.push({ text, start, end });
      }
    }
    return units;
  } catch {
    return undefined;
  }
}

/** 중복 단위 범위만 지우고, 그 밖의 공백·코드 펜스·블록 간격은 원문 그대로 보존한다. */
function removeMarkdownRanges(section: string, ranges: readonly Pick<MarkdownUnit, 'start' | 'end'>[]): string {
  let cursor = 0;
  let output = '';
  for (const { start, end } of ranges) {
    if (start < cursor || end < start || end > section.length) return section;
    output += section.slice(cursor, start);
    cursor = end;
  }
  return output + section.slice(cursor);
}

/** 앞선 절의 완전한 Markdown 블록과 같은 intent 사본만 제거한다. 위치/파싱 불명은 원문을 유지한다. */
function removeEarlierSectionDuplicates(sections: readonly IntentSection[]): IntentSection[] {
  const intentIndex = sections.findIndex((section) => /^(#{1,6}\s+)?리뷰 intent\s*$/i.test(section.title.trim()));
  if (intentIndex <= 0) return [...sections];
  const earlier = new Set<string>();
  for (const section of sections.slice(0, intentIndex)) {
    const units = topLevelMarkdownUnits(section.text);
    if (!units) return [...sections];
    for (const unit of units) earlier.add(unit.text);
  }
  const intent = sections[intentIndex]!;
  const units = topLevelMarkdownUnits(intent.text);
  if (!units) return [...sections];
  const duplicates = units.filter((unit) => earlier.has(unit.text));
  if (!duplicates.length) return [...sections];
  const text = removeMarkdownRanges(intent.text, duplicates);
  // 제목과 공백만 남으면 빈 생산자 블록을 만들지 않는다.
  if (text.replace(intent.title, '').trim().length === 0) return sections.filter((_, index) => index !== intentIndex);
  return sections.map((section, index) => index === intentIndex ? { ...section, text } : section);
}

function prBodyBlocks(source: string): Block[] {
  const sections = extractIntentBlocks(source, true).sections ?? [];
  if (!sections.length) return [];
  const deduplicatedSections = removeEarlierSectionDuplicates(sections);
  const firstHeadAt = source.search(/^#{1,6}\s+\S/m);
  const preamble = firstHeadAt > 0 ? source.slice(0, firstHeadAt).trim() : '';
  return [
    ...(preamble ? [{ title: PREAMBLE_TITLE, text: `${PREAMBLE_TITLE}\n${preamble}` }] : []),
    ...deduplicatedSections,
  ];
}

/** 우선순위 예산을 적용한 절별 조각 — `intentFromPr` 와 관측기가 **같은 심**을 쓴다(조립 중복 금지). */
function fitPrBodyPieces(blocks: readonly Block[]): { text: string; perBlock: Map<Block, string> } {
  // ⭐ 출력은 **원문 순서**를 지킨다(`fitReviewIntentPieces` 는 `order` 를 예산 배분에만 쓴다).
  //    바뀌는 것은 「누가 먼저 예산을 받나」뿐이다.
  const order = [...blocks].sort((a, b) => sectionPriority(a.title) - sectionPriority(b.title));
  const fairShare = order.filter((b) => sectionPriority(b.title) <= 1);
  return fitReviewIntentPieces(blocks, order, fairShare.length ? fairShare : order, true);
}

/** PR 에서 intent 를 뽑는다 — **본문 우선·제목 폴백**. 둘 다 비면 빈 문자열(호출측이 폴백). */
export function intentFromPr(o: { title: string; body?: string }): string {
  const source = intentSourceFromPr(o);
  if (source.length <= MAX_REVIEW_INTENT_CHARS) return source;
  const blocks = prBodyBlocks(source);
  if (!blocks.length) return capIntent(source);   // ⛔ 무회귀 — 절이 없으면 종전 그대로
  return fitPrBodyPieces(blocks).text;
}

/**
 * 판정 기준 절이 «리뷰어에게 실제로 닿았나» — 관측용(순수). ⛔ 판정하지 않는다: 사실만 낸다.
 *
 * ⛔⭐ **초판 지표는 오도였다**(자기 정정): `rendered.includes(block.text)` 로 **원문 통째 생존**을
 *    셌더니, 큰 절은 항상 축약되므로 실물 4건에서 전부 `0` 이 나왔다 — 실제로는 판정 기준이
 *    **살아 있었는데** 조회에는 *"하나도 안 남았다"* 로 보인다. 「0」을 만드는 지표를 만든 셈이다.
 *  ⇒ 재는 것을 바꾼다: ***제목이 남았나*** 와 ***본문이 한 줄이라도 남았나***(= 제목만 남은 게 아닌가).
 */
export function prIntentSectionCoverage(o: { title: string; body?: string }): {
  intentSections?: number; intentPriorityTotal?: number;
  /** 판정 기준 절 중 **본문이 한 줄이라도** 살아남은 수. 제목만 남은 것은 세지 않는다. */
  intentPriorityWithBody?: number;
  /** 본문이 통째로 생략돼 **제목만** 남은 절 이름(상한 6). */
  intentTitleOnly?: string[];
} {
  const source = intentSourceFromPr(o);
  if (source.length <= MAX_REVIEW_INTENT_CHARS) return {};
  const blocks = prBodyBlocks(source);
  if (!blocks.length) return {};
  // ⭐ 조립기가 «만들 때» 알던 절별 조각을 그대로 받는다 — 완성 문자열을 되파싱하지 않는다.
  const { perBlock } = fitPrBodyPieces(blocks);
  const priority = blocks.filter((b) => sectionPriority(b.title) === 0);
  /** 그 절이 **제목 말고 본문**을 실었나. 생략 표기(`…[N개 생략됨]`)는 본문으로 세지 않는다. */
  const bodySurvived = (b: Block): boolean => {
    const piece = perBlock.get(b) ?? '';
    if (!piece) return false;
    return piece.slice(b.title.length).replace(/…\[[^\]]*\]/g, '').trim().length > 0;
  };
  const titleOnly = blocks.filter((b) => (perBlock.get(b) ?? '') && !bodySurvived(b));
  return {
    intentSections: blocks.length,
    intentPriorityTotal: priority.length,
    intentPriorityWithBody: priority.filter(bodySurvived).length,
    ...(titleOnly.length ? { intentTitleOnly: titleOnly.slice(0, 6).map((b) => b.title.replace(/^#{1,6}\s*/, '').slice(0, 40)) } : {}),
  };
}

/** PR 기반 intent 절단만 관측에 올린다. 선택 규칙은 `intentFromPr`와 같은 원문을 공유한다. */
export function reviewIntentTruncationFromPr(
  o: { title: string; body?: string },
): { intentTruncated?: boolean; intentTotalChars?: number; intentSection?: string } {
  return reviewIntentTruncationObservation(intentSourceFromPr(o));
}

// ── ① 조망 — 골 텍스트에서 수용기준·스코프 경계를 **결정론으로** 추출 ─────────────────
//
// ⭐ 사후 리뷰가 옳게 지적했다: `수용기준`·`스코프 경계` 를 "생산자가 없다" 며 빼는 것은
//    **범위 축소**였다. 생산자는 실재한다 — **골 텍스트 자체**다. 이 세션의 골 파일들은 이미
//    `## 수용기준` · `## 하지 말 것` · `## 안전 불변식` 절을 갖고 있고, 사람이 쓴 골도 대개 그렇다.
//    그걸 **파싱해서** 싣는 것은 ①조망(있는 사실 조립)이지 ②합성(LLM 판단)이 아니다.
//    ⇒ P1 범위 안에서 4블록이 성립한다. LLM 은 여전히 쓰지 않는다.

/** 절 제목 → 어느 블록으로 갈지. 없는 제목은 무시한다(과잉 수집 금지). */
const ACCEPTANCE_HEADS = ['수용기준', '수용 기준', '검증', 'acceptance'];
const BOUNDARY_HEADS = ['의도적 스코프 경계', '스코프 경계', '하지 말 것', '범위 밖', '안전 불변식', 'scope boundary'];

function headKind(line: string): 'acceptance' | 'boundary' | 'other' | null {
  // `## 수용기준 (…)` · `수용기준:` 둘 다 인정. 그 외 줄은 null(제목 아님).
  const m = /^\s*(?:#{1,6}\s*)?([^:\n]{1,40}?)\s*(?::|\s*\(|$)/.exec(line);
  if (!m) return null;
  const isHeading = /^\s*#{1,6}\s/.test(line) || /:\s*$/.test(line);
  if (!isHeading) return null;
  const t = (m[1] ?? '').replace(/^\d+[.)]\s*/, '').trim().toLowerCase();
  if (ACCEPTANCE_HEADS.some((h) => t.includes(h))) return 'acceptance';
  if (BOUNDARY_HEADS.some((h) => t.includes(h))) return 'boundary';
  return 'other';
}

/** 목록 줄에서 항목 본문만(`- ` · `1. ` · `* `) **또는 표 행의 첫 칸**. 둘 다 아니면 undefined.
 *
 * ⛔⭐⭐ **표를 읽는 이유**(2026-07-31 실측): 이 저장소의 골은 `## SCOPE BOUNDARY` 를 **표로** 쓴다.
 * 종전엔 불릿만 읽어서 **표로 쓴 경계는 항목 0** 이었고, 그러면 블록 자체가 안 만들어져
 * **예산·어휘를 고쳐도 경계가 리뷰에 도달하지 않는다.** 실측: 죽은 런의 골이 정확히 그 경우였다.
 * ⇒ 결손이 **세 겹**이었고(어휘 · 예산 · **형식**) 셋째가 지배적이었다. */
function bullet(line: string): string | undefined {
  const m = /^\s*(?:[-*·]|\d+[.)])\s+(.*\S)\s*$/.exec(line);
  if (m?.[1]) return m[1];
  // 표 행: `| 항목 | 이유 |` → 첫 칸을 항목으로 읽는다. ⛔ 구분선(`|---|---|`)과 헤더 행은 제외.
  const row = /^\s*\|(.+)\|\s*$/.exec(line);
  if (!row) return undefined;
  const cells = row[1]!.split('|').map((c) => c.trim());
  const first = cells[0] ?? '';
  if (!first || /^:?-{2,}:?$/.test(first)) return undefined;   // 구분선
  return first;
}

/** 표 헤더 행인가 — **다음 줄이 구분선**이면 헤더다. ⛔ 한 줄만 봐서는 못 가른다.
 *  안 거르면 `⛔ 하지 않는 것` 같은 **열 제목이 경계 항목으로 새어** 들어간다(실측). */
function isTableHeader(line: string, next: string | undefined): boolean {
  if (!/^\s*\|.+\|\s*$/.test(line)) return false;
  return /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(next ?? '');
}

/** 골에서 **추출된 것만** 걷어낸 나머지(목표 서술). 추출 내용이 목표 블록에 중복되지 않게 한다.
 *
 *  ⚠️ **산문은 남긴다**(리뷰 must-fix) — 초판은 인식된 절을 만나면 다음 헤더까지 **통째로** 버려,
 *     그 절 안의 **비목록 산문**(맥락·이유·주의)까지 intent 에서 사라졌다. 추출이 담는 것은
 *     **목록 항목뿐**이므로(`extractIntentBlocks` 계약) 버릴 것도 **목록 항목과 그 헤더**뿐이다.
 *     그러지 않으면 "산문은 목표 블록에 이미 있다" 는 계약 자체가 거짓이 된다. */
export function stripExtractedSections(goal: string): string {
  const mined = extractIntentBlocks(goal);
  const out: string[] = [];
  let extractedSection: 'acceptance' | 'boundary' | null = null;
  for (const line of goal.split('\n')) {
    const kind = headKind(line);
    if (kind === 'acceptance' || kind === 'boundary') { extractedSection = kind; continue; }   // 헤더만 제거
    if (kind === 'other') extractedSection = null;
    // 추출된 절 안에서는 **추출에 실제로 담긴 목록 항목만** 버린다 — 산문·빈 줄은 남긴다.
    // ⚠️ 상한을 넘어 **생략된 항목은 목표 블록에 남긴다**(리뷰 must-fix) — 양쪽에서 지우면 완전 유실.
    const b = bullet(line);
    if (extractedSection && b !== undefined) {
      // **원문 그대로 담긴** 항목만 목표에서 뺀다. 잘렸거나(200자) 생략된(13번째~) 항목은
      // 추출본이 원문이 아니므로 **목표 블록에 남겨** 완전 유실을 막는다.
      // 경계 전용 진단·저작 안내는 경계 절에서만 제거한다. 같은 문면이 수용기준에 있으면
      // 기존 보존 계약에 따라 추출본에 원문 그대로 담긴 경우에만 제거한다.
      const boundaryMetadata = extractedSection === 'boundary'
        && (isUnverifiedBoundaryCandidate(b) || isBoundaryAuthorGuidance(b));
      const verbatim = mined.acceptance.includes(b) || mined.scopeBoundaries.includes(b);
      if (boundaryMetadata || verbatim) continue;
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 항목 상한 — 한 절이 intent 예산을 통째로 먹지 않게. 초과분은 **생략 사실을 남긴다**. */
export const MAX_INTENT_ITEMS = 12;
/** 항목당 문자 상한 — 초과 시 **잘렸다고 표기**한다. */
export const MAX_INTENT_ITEM_CHARS = 200;

export interface ExtractedIntentBlocks {
  readonly acceptance: string[];
  readonly scopeBoundaries: string[];
  /** 형식이 맞지 않은 경계 후보 — 의도적 결정이 아니므로 별도 렌더링한다. */
  readonly unverifiedBoundaryCandidates: string[];
  /** 원문 순서의 Markdown 절 — 수동 리뷰 조립이 요청할 때만 포함한다. */
  readonly sections?: readonly IntentSection[];
}

/**
 * 골 텍스트에서 수용기준·스코프 경계 **목록 항목**을 뽑는다(순수·LLM 없음).
 *
 * 계약:
 *  · 인식하는 절 제목만 수집한다 — 모르는 절은 **버린다**(과잉 수집이 intent 를 오염시킨다).
 *  · 절 안의 **목록 항목만** 담는다(산문은 목표 블록에 이미 있다).
 *  · 절이 없으면 빈 배열 ⇒ 호출측이 그 블록을 생략한다(빈 헤더 금지 계약 유지).
 *  · 항목 수 상한 `MAX_INTENT_ITEMS` · 항목당 `MAX_INTENT_ITEM_CHARS` — ⚠️ 둘 다 **잘렸으면 표기**한다
 *    (무표식 절단은 기준을 조용히 없애고, 목표 블록에서도 그 항목은 제거되므로 **완전 유실**이 된다).
 */
function isPreservationCriterion(item: string): boolean {
  return /^(?:checkable\s+)?(?:preservation criterion|보존 기준)\s*:/i.test(item);
}

function truncateIntentItem(item: string): string {
  if (item.length <= MAX_INTENT_ITEM_CHARS) return item;
  const half = Math.floor(MAX_INTENT_ITEM_CHARS / 2);
  return `${item.slice(0, half)}…[항목이 ${MAX_INTENT_ITEM_CHARS}자에서 잘림]${item.slice(-half)}`;
}

function capIntentItems(
  items: readonly string[],
  overflowNotice = `…[항목 ${MAX_INTENT_ITEMS}개 상한 초과 — 이후 항목 생략(원문은 목표 블록 참조)]`,
): string[] {
  if (items.length <= MAX_INTENT_ITEMS) return items.map(truncateIntentItem);
  const prioritized = [
    ...items.filter(isPreservationCriterion),
    ...items.filter((item) => !isPreservationCriterion(item)),
  ];
  return [
    ...prioritized.slice(0, MAX_INTENT_ITEMS).map(truncateIntentItem),
    overflowNotice,
  ];
}

function isBoundaryAuthorGuidance(item: string): boolean {
  return /^Scope-boundary candidates selected by document relevance:$/i.test(item)
    || /^\d+\s+scope-boundary candidate\(s\) were selected by document relevance;/i.test(item)
    || /^If adopted, state each boundary as an intentional goal decision with its reason;/i.test(item);
}

function isUnverifiedBoundaryCandidate(item: string): boolean {
  return /^UNVERIFIABLE:/i.test(item);
}

export function extractIntentBlocks(goal: string, includeSections = false): ExtractedIntentBlocks {
  const acceptanceItems: string[] = [];
  const scopeBoundaryItems: string[] = [];
  const unverifiedBoundaryCandidateItems: string[] = [];
  let cur: 'acceptance' | 'boundary' | null = null;
  const lines = goal.split('\n');
  const sections: IntentSection[] = [];
  if (includeSections) {
    let title = '';
    let sectionLines: string[] = [];
    const push = () => {
      if (title) sections.push({ title, text: [title, ...sectionLines].join('\n') });
    };
    for (const line of lines) {
      if (/^#{1,6}\s+\S/.test(line)) {
        push();
        title = line;
        sectionLines = [];
      } else if (title) {
        sectionLines.push(line);
      }
    }
    push();
  }
  for (const [idx, line] of lines.entries()) {
    const kind = headKind(line);
    if (kind === 'acceptance') { cur = 'acceptance'; continue; }
    if (kind === 'boundary') { cur = 'boundary'; continue; }
    if (kind === 'other') { cur = null; continue; }
    if (!cur || isTableHeader(line, lines[idx + 1])) continue;
    const item = bullet(line);
    if (!item) continue;
    if (cur === 'acceptance') {
      acceptanceItems.push(item);
    } else if (isBoundaryAuthorGuidance(item)) {
      continue;
    } else if (isUnverifiedBoundaryCandidate(item)) {
      unverifiedBoundaryCandidateItems.push(item);
    } else {
      scopeBoundaryItems.push(item);
    }
  }
  const acceptance = capIntentItems(acceptanceItems);
  const scopeBoundaries = capIntentItems(scopeBoundaryItems);
  const unverifiedBoundaryCandidates = capIntentItems(
    unverifiedBoundaryCandidateItems,
    `…[후보 항목 ${MAX_INTENT_ITEMS}개 상한 초과 — 이후 후보 항목 생략]`,
  );
  return includeSections
    ? { acceptance, scopeBoundaries, unverifiedBoundaryCandidates, sections }
    : { acceptance, scopeBoundaries, unverifiedBoundaryCandidates };
}
