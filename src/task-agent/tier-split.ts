/**
 * TIER-SPLIT-BEFORE-LAUNCH (0.2.35 P0) — `tasks hand --tier 상|특 --live` 를 한 덩어리로 쏘지 않고, 저작 분해
 * (TC TIER-SIZED-DECOMPOSE `decomposeToTierSizedSlices`)가 만든 «중 이하 조각»으로 나눠 조각마다 hand 발사한다.
 * 대표: «최우선으로 중·하 난이도로 쪼개기를 정착 · 구독 sol 은 웬만해선 소진 안 함».
 *
 * - 분해 규칙은 TC 몫 — 여기는 그 함수를 «주입 seam» 으로 받는다. 기본 seam 은 이 파일 한 곳(`DEFAULT_TIER_SIZED_DECOMPOSE`)에서만 정한다.
 * - 분해기 «미배선»(seam 에 undefined 명시) = `decomposer-unavailable` → 종전처럼 한 덩어리 발사 ⊕ 기록. 기본 seam 은 TC 함수다.
 * - 분해 «실패»(ok:false · throw · 불가피 이유 없는 상 조각 · 빈/잘못된 조각) → 발사 0 · 카드 failed(history `tier-split-failed`).
 * - 관측: `debug.log('task-agent.hand', 'tier-split', {cid, fromTier, outcome, reason?, slices, unavoidable,
 *   countScope:'accepted-slices', totalSlices, highSlices, unavoidableCount, unavoidableReasons})`.
 */
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { handTask, nextMoveFor, parseChildLlm, taskAgentStatePath, updateTaskCard, writeTaskCards, TASK_CARD_PREFIX, type HandTaskOptions, type HandTaskResult, type TaskCard } from './task-hand.js';

// 분해 규칙·타입 정본 = TC `src/self-implement/goal-author-decompose.ts`(TIER-SIZED-DECOMPOSE · #29987).
import { decomposeToTierSizedSlices, type SizedSlice, type TierSizedDecomposeResult } from '../self-implement/goal-author-decompose.js';
import { DEVICE_FIRST_STEP } from '../self-implement/device-first.js';
export type { SizedSlice, TierSizedDecomposeResult };
export type TierSizedDecompose = (goal: string, opts?: { signal?: AbortSignal; repositoryRoot?: string }) => Promise<TierSizedDecomposeResult>;

/** 기본 분해기 — TC `decomposeToTierSizedSlices`. seam 에 undefined 를 명시하면 «미배선»(decomposer-unavailable). */
export const DEFAULT_TIER_SIZED_DECOMPOSE: TierSizedDecompose | undefined = decomposeToTierSizedSlices;

export const TIER_SPLIT_UNAVAILABLE = 'decomposer-unavailable';

/** 분해 시간 상한 — LLM 이 매달려도 디스패처의 손 넘김 한 번을 끝없이 붙잡지 않는다. 넘으면 막힘(decompose-timeout). */
export const TIER_SPLIT_DECOMPOSE_TIMEOUT_MS = 300_000;

/** 조각이 부모 칸에서 물려받는 줄 머리 — hand 의 골 검사(완료 경계 셋)와 계약·경계 문맥. */
const INHERITED_PARENT_LABELS = /^\s*(?:[-*]\s*)?(현재 계약|완료 경계 코드|완료 경계 실물|완료 경계 증거 명령|경계|증거 보충)\s*:/;
const PARENT_ACCEPTANCE_LABEL = /^\s*(?:[-*]\s*)?(수용선|판정|완료 조건|완료 경계 코드|완료 경계 실물|완료 경계 증거 명령)\s*:/;
const VERIFICATION_PLAN_HEADING = '### 검증 계획(TDD)';

/** Read a real Markdown section, ignoring headings inside fenced verbatim asks. */
function parentVerificationPlan(text: string): string[] {
  const lines = text.split(/\r?\n/u);
  let fence: { char: string; length: number } | null = null;
  let start = -1;
  const section: string[] = [];
  for (const [index, line] of lines.entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = { char: marker[0]!, length: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.length) fence = null;
      if (start >= 0 && fence) break;
      continue;
    }
    if (fence) continue;
    if (start < 0) {
      if (line.trim() === VERIFICATION_PLAN_HEADING) {
        start = index;
        section.push(line);
      }
      continue;
    }
    if (/^ {0,3}#{1,6}\s/u.test(line)) break;
    section.push(line);
  }
  return section;
}

/**
 * 조각 hand 문면 = 조각 골(대상 경로·동작 — 첫 줄 유지) ⊕ 조각 표지 ⊕ 부모 칸의 계약·완료 경계·경계 줄·TDD 계획.
 * 분해기의 조각 골은 짧은 제목뿐이라 그대로 넘기면 hand 의 골 검사(완료 경계 누락)가 막는다(10-21 DEVICE-FIRST-AUTHORING 발사 0).
 * 부모에 그 줄이 없으면 아무것도 더하지 않는다 — 검사가 지금처럼 거부한다(보수 쪽).
 */
export function composeSliceHandText(sliceGoal: string, parentText: string, marker: { index: number; total: number; fromTier: '상' | '특'; cid: string | null }): string {
  const sliceLines = sliceGoal.trim().split('\n');
  const sliceHas = new Set(sliceLines.map((line) => INHERITED_PARENT_LABELS.exec(line)?.[1]).filter(Boolean));
  const inherited = parentText.split('\n').filter((line) => {
    const label = INHERITED_PARENT_LABELS.exec(line)?.[1];
    return label !== undefined && !sliceHas.has(label);
  });
  const sliceHasVerificationPlan = sliceLines.some((line) => line.trim() === VERIFICATION_PLAN_HEADING);
  const verificationPlan = sliceHasVerificationPlan ? [] : parentVerificationPlan(parentText);
  inherited.push(...verificationPlan);
  // 표지는 리뷰 범위를 나르므로 장치 우선 조각(총 2 이상)은 상속 줄이 없어도 남는다 —
  // 다만 «물려받았다» 는 물려받은 줄에 대한 주장이므로 그 줄이 있을 때만 붙인다.
  const isAcceptanceIntegration = sliceGoal.includes('부모 수용선 몫(자동 통합 조각):');
  if (inherited.length === 0 && (marker.total < 2 || (!isAcceptanceIntegration && !sliceGoal.includes(`동작: ${DEVICE_FIRST_STEP}`)))) return sliceGoal;
  const inheritedTopics = `계약·완료 경계${verificationPlan.length > 0 ? '·검증 계획' : ''}`;
  const inheritanceClaim = inherited.length > 0 ? ` 아래 ${inheritedTopics}는 부모 칸에서 물려받았다 — 이 조각 범위만 채운다.` : '';
  const tag = `조각 ${marker.index}/${marker.total} — 부모 ${marker.cid ?? '(칸 없음)'}(${marker.fromTier}) 를 중 이하로 나눈 몫.${inheritanceClaim}`;
  return [...sliceLines, tag, ...inherited].join('\n');
}

export type TierSplitPlan =
  | { kind: 'split'; slices: SizedSlice[] }
  | { kind: 'blocked'; reason: string };

function parentAcceptanceLines(parentText: string): string[] {
  return parentText.split(/\r?\n/u).map((line) => line.trim()).filter((line) => PARENT_ACCEPTANCE_LABEL.test(line));
}

function coveredAcceptanceLines(slices: readonly SizedSlice[], acceptance: readonly string[], parentText: string,
  fromTier: '상' | '특', cid: string | null): string[] {
  const effectiveGoals = slices.map((slice, index) => composeSliceHandText(slice.goal, parentText,
    { index: index + 1, total: slices.length, fromTier, cid }));
  return acceptance.filter((line) => effectiveGoals.some((goal) => goal.includes(line)));
}

function annotateAcceptanceShares(slices: readonly SizedSlice[], acceptance: readonly string[], integratedAdded = false): SizedSlice[] {
  return slices.map((slice) => {
    const share = acceptance.filter((line) => slice.goal.includes(line));
    if (slice.goal.includes('부모 수용선 몫')) {
      if (!integratedAdded || share.length >= acceptance.length || slice.goal.includes('누락 수용선은 자동 통합 조각이 담당한다.')) return slice;
      return { ...slice, goal: `${slice.goal}\n- 누락 수용선은 자동 통합 조각이 담당한다.` };
    }
    if (share.length > 0) return { ...slice, goal: `${slice.goal}\n부모 수용선 몫:\n${share.map((line) => `- ${line}`).join('\n')}` };
    if (acceptance.length > 0 && integratedAdded) return { ...slice, goal: `${slice.goal}\n부모 수용선 몫: 없음 — 누락 수용선은 자동 통합 조각이 담당한다.` };
    return slice;
  });
}

function recordAcceptanceCoverage(data: Record<string, unknown>): void {
  try { debug.log('tier-split', 'slice-acceptance-coverage', data); } catch { /* fail-soft */ }
}

function integratedAcceptanceSlice(parentText: string, missing: readonly string[], slices: readonly SizedSlice[]): SizedSlice {
  const paths = [...new Set(slices.flatMap((slice) => slice.goal.match(/[\w./-]+\.[A-Za-z][\w-]*/gu) ?? []))];
  const goal = `${parentText}\n\n부모 수용선 몫(자동 통합 조각):\n${missing.map((line) => `- ${line}`).join('\n')}`;
  return { goal, files: Math.max(1, paths.length), behaviours: Math.max(1, slices.reduce((sum, slice) => sum + slice.behaviours, 0)),
    newFiles: slices.reduce((sum, slice) => sum + slice.newFiles, 0), tier: '상', unavoidable: 'acceptance-coverage-integration' };
}

/** 순수 판정 — 분해 결과에 남은 상 조각은 불가피 사유가 없어도 unavoidable=auto로 발사한다. */
export function planTierSplit(result: TierSizedDecomposeResult): TierSplitPlan {
  if (!result.ok) return { kind: 'blocked', reason: `decompose-failed: ${result.reason}` };
  if (result.slices.length === 0) return { kind: 'blocked', reason: 'no-slices' };
  for (const [index, slice] of result.slices.entries()) {
    if (!['하', '중', '상'].includes(slice.tier)) return { kind: 'blocked', reason: `invalid-slice-tier: #${index + 1} ${String(slice.tier)}` };
    if (!slice.goal?.trim()) return { kind: 'blocked', reason: `empty-slice-goal: #${index + 1}` };
  }
  const slices = result.slices.map((slice) => slice.tier === '상'
    ? { ...slice, unavoidable: slice.unavoidable?.trim() || 'auto' } : slice);
  const deviceSlices = slices.filter((slice) => slice.deviceFirst === 'device-test');
  if (deviceSlices.length === 0 && slices.some((slice) => slice.deviceFirst === 'feature'))
    return { kind: 'blocked', reason: 'device-first-stage-missing' };
  if (deviceSlices.length > 0 && (deviceSlices.length !== 1 || slices[0]?.deviceFirst !== 'device-test'
    || slices.slice(1).some((slice) => slice.deviceFirst !== 'feature')))
    return { kind: 'blocked', reason: 'device-first-order-invalid' };
  return { kind: 'split', slices };
}

export interface TierSplitSliceOutcome { slice: SizedSlice; result?: HandTaskResult; error?: string }
export type TierSplitHandResult =
  | { kind: 'whole'; result: HandTaskResult; reason?: string }
  | { kind: 'blocked'; result: HandTaskResult; reason: string }
  | { kind: 'split'; group: string; fromTier: '상' | '특'; slices: TierSplitSliceOutcome[] };

export interface TierSplitHandOptions extends HandTaskOptions {
  /** 분해기 seam — 키를 안 주면 기본(`DEFAULT_TIER_SIZED_DECOMPOSE`) · undefined 를 명시하면 «미배선». */
  decompose?: TierSizedDecompose;
  /** 분해 시간 상한(시험 주입) — 기본 `TIER_SPLIT_DECOMPOSE_TIMEOUT_MS`. */
  decomposeTimeoutMs?: number;
}

function record(data: Record<string, unknown>): void {
  try { debug.log('task-agent.hand', 'tier-split', data); } catch { /* fail-soft */ }
}

function acceptedSliceCounts(slices: readonly SizedSlice[]) {
  const unavoidableReasons = slices.filter((slice) => slice.tier === '상').map((slice) => slice.unavoidable!.trim());
  // planTierSplit rejects every high slice without a reason, so the accepted
  // high count and unavoidable count coincide. Keep both for the board axes.
  return { countScope: 'accepted-slices' as const, totalSlices: slices.length, highSlices: unavoidableReasons.length,
    unavoidableCount: unavoidableReasons.length, unavoidableReasons };
}

/**
 * `tasks hand` 의 발사 앞단. 분해는 `--live` ⊕ tier 상|특 일 때만 — 중·하·tier 없음·shadow 는 `handTask` 그대로(분해 호출 0).
 */
export async function handTaskWithTierSplit(opts: TierSplitHandOptions): Promise<TierSplitHandResult> {
  const { decompose: injected, decomposeTimeoutMs = TIER_SPLIT_DECOMPOSE_TIMEOUT_MS, ...hand } = opts;
  const fromTier = hand.tier;
  if (!hand.live || (fromTier !== '상' && fromTier !== '특')) return { kind: 'whole', result: await handTask(hand) };
  const decompose = 'decompose' in opts ? injected : DEFAULT_TIER_SIZED_DECOMPOSE;
  const cid = hand.checklistId ?? null;
  if (!decompose) {
    record({ cid, fromTier, outcome: 'whole', reason: TIER_SPLIT_UNAVAILABLE, slices: [], unavoidable: [], ...acceptedSliceCounts([]) });
    return { kind: 'whole', result: await handTask(hand), reason: TIER_SPLIT_UNAVAILABLE };
  }
  const runDecompose = async (goal: string): Promise<{ plan: TierSplitPlan; result?: TierSizedDecomposeResult }> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve('timeout'); }, decomposeTimeoutMs); });
    try {
      const raced = await Promise.race([decompose(goal, { signal: controller.signal,
        ...(hand.project ? { repositoryRoot: resolve(hand.project.target) } : {}) }), timedOut]);
      if (raced === 'timeout') return { plan: { kind: 'blocked', reason: `decompose-timeout: ${decomposeTimeoutMs}ms` } };
      return { plan: planTierSplit(raced), result: raced };
    } catch (error) {
      return { plan: { kind: 'blocked', reason: `decompose-threw: ${String((error as Error)?.message ?? error).slice(0, 200)}` } };
    } finally { clearTimeout(timer); }
  };
  const first = await runDecompose(hand.text.trim());
  let plan = first.plan;
  let decomposed = first.result;
  const acceptance = parentAcceptanceLines(hand.text);
  if (plan.kind === 'split') {
    let candidateSlices = plan.slices;
    let covered = coveredAcceptanceLines(candidateSlices, acceptance, hand.text, fromTier, cid);
    let missing = acceptance.filter((line) => !covered.includes(line));
    const inheritedByComposition = acceptance.filter((line) => INHERITED_PARENT_LABELS.test(line));
    recordAcceptanceCoverage({ cid, fromTier, attempt: 1, coverageMode: 'exact-parent-line', inheritedByComposition, covered, missing });
    if (missing.length > 0) {
      const retryPrompt = `${hand.text.trim()}\n\n### 분해 필수 수용선\n각 조각의 "부모 수용선 몫"에 담당하는 원문 수용선 전체를 그대로 싣고, 조각들의 합집합으로 아래 모든 줄을 덮으세요.\n${missing.map((line) => `- ${line}`).join('\n')}`;
      const retry = await runDecompose(retryPrompt);
      if (retry.plan.kind === 'split') {
        plan = retry.plan;
        decomposed = retry.result;
        candidateSlices = annotateAcceptanceShares(retry.plan.slices, acceptance);
      }
      covered = coveredAcceptanceLines(candidateSlices, acceptance, hand.text, fromTier, cid);
      missing = acceptance.filter((line) => !covered.includes(line));
      recordAcceptanceCoverage({ cid, fromTier, attempt: 2, coverageMode: 'exact-parent-line', inheritedByComposition, covered, missing,
        retryReason: retry.plan.kind === 'blocked' ? retry.plan.reason : undefined });
      let integratedAdded = false;
      if (missing.length > 0) {
        candidateSlices = [...candidateSlices, integratedAcceptanceSlice(hand.text, missing, candidateSlices)];
        integratedAdded = true;
        covered = coveredAcceptanceLines(candidateSlices, acceptance, hand.text, fromTier, cid);
        missing = acceptance.filter((line) => !covered.includes(line));
      }
      candidateSlices = annotateAcceptanceShares(candidateSlices, acceptance, integratedAdded);
      recordAcceptanceCoverage({ cid, fromTier, attempt: 'final', coverageMode: 'exact-parent-line', inheritedByComposition,
        covered, missing, integrated: integratedAdded });
      plan = { kind: 'split', slices: candidateSlices };
    } else {
      plan = { kind: 'split', slices: candidateSlices };
    }
  }
  if (plan.kind === 'blocked') {
    const rejectedOversized = decomposed?.ok
      ? decomposed.slices.flatMap((slice, index) => slice.tier === '상' ? [{ index: index + 1, files: slice.files, behaviours: slice.behaviours }] : [])
      : [];
    record({ cid, fromTier, outcome: 'blocked', reason: plan.reason, slices: [], unavoidable: [],
      ...(decomposed?.ok ? { redecomposed: decomposed.redecomposed } : {}),
      rejectedOversized, rejectedOversizedCount: rejectedOversized.length, ...acceptedSliceCounts([]) });
    return { kind: 'blocked', result: await handTask({ ...hand, tierSplitBlocked: plan.reason }), reason: plan.reason };
  }
  const group = `${TASK_CARD_PREFIX}split-${randomBytes(4).toString('hex')}`;
  const total = plan.slices.length;
  const counts = acceptedSliceCounts(plan.slices);
  const unavoidable = counts.unavoidableReasons;
  // 조각은 새 카드다 — 호출자 id·pr·goalId 를 조각마다 복제하면 «PR: #N» 조회·수확이 엇갈린다. 버린 것은 기록에 남긴다.
  const dropped = { ...(hand.id ? { id: hand.id } : {}), ...(hand.cardFields?.pr !== undefined ? { pr: hand.cardFields.pr } : {}), ...(hand.cardFields?.goalId !== undefined ? { goalId: hand.cardFields.goalId } : {}) };
  record({ cid, fromTier, outcome: 'split', group, ...(Object.keys(dropped).length ? { dropped } : {}),
    ...(decomposed?.ok ? { redecomposed: decomposed.redecomposed } : {}),
    slices: plan.slices.map((s) => ({ tier: s.tier, files: s.files, behaviours: s.behaviours })), unavoidable: [...unavoidable],
    ...counts });
  const { id: _wholeId, cardFields, ...rest } = hand;
  const base = { ...rest, ...(cardFields?.handed !== undefined ? { cardFields: { handed: cardFields.handed } } : {}) };
  const slices: TierSplitSliceOutcome[] = [];
  // Device-first plans use the existing mission advance engine: only the test/device card starts.
  // Feature cards carry an explicit `after` edge and `tasks advance` requires a merged PR before launch.
  if (plan.slices[0]?.deviceFirst === 'device-test') {
    const now = (hand.now ?? (() => new Date()))().toISOString();
    const ids = plan.slices.map((_slice, index) => `${group}-${index + 1}`);
    const mission: TaskCard = { id: group, text: hand.text, createdAt: now, status: 'handed', history: [],
      pieces: ids, splitSource: 'device-first-tier-split', ...(hand.checklistId ? { checklistId: hand.checklistId } : {}),
      ...(hand.seat ? { seat: hand.seat } : {}) };
    const drafts: TaskCard[] = plan.slices.map((slice, index) => ({
      id: ids[index]!, text: composeSliceHandText(slice.goal, hand.text, { index: index + 1, total, fromTier, cid }),
      createdAt: now, status: 'handed', history: [], mission: group,
      after: index === 0 ? [] : [ids[0]!], tier: slice.tier,
      tierSplit: { group, fromTier, index: index + 1, total, ...(slice.tier === '상' ? { unavoidable: slice.unavoidable!.trim() } : {}) },
      ...(hand.checklistId ? { checklistId: hand.checklistId } : {}),
      ...(hand.seat ? { seat: hand.seat } : {}),
      ...(hand.project ? { project: hand.project } : {}),
      ...(hand.completion ? { completion: hand.completion } : {}),
      ...(hand.taLand ? { taLand: true as const } : {}),
      ...(hand.childLlm ? { childLlm: parseChildLlm(hand.childLlm, hand.childLlmEffort) } : {}),
      ...(hand.parentRoleLlm?.length ? { parentRoleLlm: [...hand.parentRoleLlm] } : {}),
    }));
    writeTaskCards(hand.statePath ?? taskAgentStatePath(), [mission, ...drafts]);
    const markFirstLaunchFailure = (reason: string) => {
      updateTaskCard(hand.statePath ?? taskAgentStatePath(), group, (card) => card ? {
        ...card, status: 'failed', history: [...card.history, { at: new Date().toISOString(),
          event: 'device-first-launch-failed', detail: reason }],
      } : undefined);
    };
    for (const [index, slice] of plan.slices.entries()) {
      if (index > 0) {
        slices.push({ slice, result: { card: drafts[index]!, move: nextMoveFor(drafts[index]!), mode: hand.live ? 'live' : 'shadow', launched: false } });
        continue;
      }
      try {
        const result = await handTask({ ...base, id: ids[0], text: drafts[0]!.text, tier: slice.tier,
          mission: group, after: [], tierSplit: drafts[0]!.tierSplit });
        slices.push({ slice, result });
        if (hand.live && !result.launched) markFirstLaunchFailure(`first card not launched: ${result.card.status}`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        slices.push({ slice, error: reason });
        markFirstLaunchFailure(reason);
      }
    }
    record({ cid, fromTier, outcome: 'device-first-deferred', group, first: ids[0], blockedUntilLanded: ids.slice(1),
      unavoidable: [...unavoidable], ...counts });
    return { kind: 'split', group, fromTier, slices };
  }
  for (const [index, slice] of plan.slices.entries()) {
    try {
      const result = await handTask({ ...base, text: composeSliceHandText(slice.goal, hand.text, { index: index + 1, total, fromTier, cid }), tier: slice.tier,
        tierSplit: { group, fromTier, index: index + 1, total, ...(slice.tier === '상' ? { unavoidable: slice.unavoidable!.trim() } : {}) } });
      slices.push({ slice, result });
    } catch (error) {
      slices.push({ slice, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { kind: 'split', group, fromTier, slices };
}
