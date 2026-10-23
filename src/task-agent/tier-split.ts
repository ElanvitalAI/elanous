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

/**
 * 조각 hand 문면 = 조각 골(대상 경로·동작 — 첫 줄 유지) ⊕ 조각 표지 ⊕ 부모 칸의 계약·완료 경계·경계 줄.
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
  // The slice marker also carries review scope. Device slices now own their
  // completion boundary, so inherited can be empty while the marker is needed.
  if (inherited.length === 0 && (marker.total < 2 || !sliceGoal.includes(`동작: ${DEVICE_FIRST_STEP}`))) return sliceGoal;
  const tag = `조각 ${marker.index}/${marker.total} — 부모 ${marker.cid ?? '(칸 없음)'}(${marker.fromTier}) 를 중 이하로 나눈 몫. 아래 계약·완료 경계는 부모 칸에서 물려받았다 — 이 조각 범위만 채운다.`;
  return [...sliceLines, tag, ...inherited].join('\n');
}

export type TierSplitPlan =
  | { kind: 'split'; slices: SizedSlice[] }
  | { kind: 'blocked'; reason: string };

/** 순수 판정 — 분해 결과 → 발사 계획. 이유 없는 상 조각이 하나라도 있으면 결과 전체를 실패로 본다(이유 없는 상 0). */
export function planTierSplit(result: TierSizedDecomposeResult): TierSplitPlan {
  if (!result.ok) return { kind: 'blocked', reason: `decompose-failed: ${result.reason}` };
  if (result.slices.length === 0) return { kind: 'blocked', reason: 'no-slices' };
  for (const [index, slice] of result.slices.entries()) {
    if (!['하', '중', '상'].includes(slice.tier)) return { kind: 'blocked', reason: `invalid-slice-tier: #${index + 1} ${String(slice.tier)}` };
    if (!slice.goal?.trim()) return { kind: 'blocked', reason: `empty-slice-goal: #${index + 1}` };
    if (slice.tier === '상' && !slice.unavoidable?.trim()) return { kind: 'blocked', reason: `unjustified-상-slice: #${index + 1}` };
  }
  const deviceSlices = result.slices.filter((slice) => slice.deviceFirst === 'device-test');
  if (deviceSlices.length === 0 && result.slices.some((slice) => slice.deviceFirst === 'feature'))
    return { kind: 'blocked', reason: 'device-first-stage-missing' };
  if (deviceSlices.length > 0 && (deviceSlices.length !== 1 || result.slices[0]?.deviceFirst !== 'device-test'
    || result.slices.slice(1).some((slice) => slice.deviceFirst !== 'feature')))
    return { kind: 'blocked', reason: 'device-first-order-invalid' };
  return { kind: 'split', slices: result.slices };
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
  let plan: TierSplitPlan;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve('timeout'); }, decomposeTimeoutMs); });
  try {
    const raced = await Promise.race([decompose(hand.text.trim(), { signal: controller.signal,
      ...(hand.project ? { repositoryRoot: resolve(hand.project.target) } : {}) }), timedOut]);
    plan = raced === 'timeout' ? { kind: 'blocked', reason: `decompose-timeout: ${decomposeTimeoutMs}ms` } : planTierSplit(raced);
  } catch (error) {
    plan = { kind: 'blocked', reason: `decompose-threw: ${String((error as Error)?.message ?? error).slice(0, 200)}` };
  } finally { clearTimeout(timer); }
  if (plan.kind === 'blocked') {
    record({ cid, fromTier, outcome: 'blocked', reason: plan.reason, slices: [], unavoidable: [], ...acceptedSliceCounts([]) });
    return { kind: 'blocked', result: await handTask({ ...hand, tierSplitBlocked: plan.reason }), reason: plan.reason };
  }
  const group = `${TASK_CARD_PREFIX}split-${randomBytes(4).toString('hex')}`;
  const total = plan.slices.length;
  const counts = acceptedSliceCounts(plan.slices);
  const unavoidable = counts.unavoidableReasons;
  // 조각은 새 카드다 — 호출자 id·pr·goalId 를 조각마다 복제하면 «PR: #N» 조회·수확이 엇갈린다. 버린 것은 기록에 남긴다.
  const dropped = { ...(hand.id ? { id: hand.id } : {}), ...(hand.cardFields?.pr !== undefined ? { pr: hand.cardFields.pr } : {}), ...(hand.cardFields?.goalId !== undefined ? { goalId: hand.cardFields.goalId } : {}) };
  record({ cid, fromTier, outcome: 'split', group, ...(Object.keys(dropped).length ? { dropped } : {}), slices: plan.slices.map((s) => ({ tier: s.tier, files: s.files, behaviours: s.behaviours })), unavoidable: [...unavoidable],
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
    record({ cid, fromTier, outcome: 'device-first-deferred', group, first: ids[0], blockedUntilLanded: ids.slice(1) });
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
