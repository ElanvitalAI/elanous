import { debug } from '../debug/log.js';
import { adversarialPlanCritique } from '../harness/adversarial-plan.js';
import { classifyHeft, adversarialThreshold } from '../harness/harness-seams.js';
import { llmDecomposeSteps } from '../harness/llm-decompose.js';
import { GOAL_AUTHOR_SIZE_SAFETY_MAX_SLICES } from '../task-orchestrator/generator-prompt.js';
import { getDefaultLogStore } from '../mss/logging/log-store.js';
import { emitDecision } from '../live/detail-switch.js';
import { selectPlanningLlm } from '../prompt-enhance/enhance.js';
import type { GoalAuthorDeps } from './goal-author.js';

const GOAL_STEPS_DECOMPOSED_EVENT = 'goal-steps-decomposed';

type GoalSliceTier = 'low' | 'medium' | 'high';
type GoalSliceSize = { files: number; actions: number; newFiles: number; tier: GoalSliceTier; unavoidableReason: string | null };

export type SliceTier = '하' | '중' | '상';
export interface SizedSlice {
  goal: string;
  files: number;
  behaviours: number;
  newFiles: number;
  tier: SliceTier;
  unavoidable?: string;
}
export type TierSizedDecomposeResult =
  | { ok: true; slices: SizedSlice[]; redecomposed: number }
  | { ok: false; reason: string };

function publicSizedSlices(steps: readonly string[], sizes: readonly GoalSliceSize[]): SizedSlice[] {
  return steps.map((goal, index) => {
    const size = sizes[index]!;
    return { goal, files: size.files, behaviours: size.actions, newFiles: size.newFiles,
      tier: ({ low: '하', medium: '중', high: '상' } as const)[size.tier],
      ...(size.unavoidableReason ? { unavoidable: size.unavoidableReason } : {}) };
  });
}

/** Keep a slice's file names grounded in the parent's explicit target/new paths. */
function restoreSlicePaths(slices: readonly SizedSlice[], parentGoal: string): SizedSlice[] {
  const parentPaths = new Map<string, Set<string>>();
  for (const line of parentGoal.split('\n')) {
    if (!/^\s*(?:[-*]\s*)?(?:대상 경로|신설)\s*:/.test(line)) continue;
    for (const match of line.matchAll(/(?:^|[\s,·`])([\w./-]+\.[A-Za-z][\w-]*)(?=$|[\s,·`])/g)) {
      const path = match[1]!;
      const name = path.slice(path.lastIndexOf('/') + 1);
      const candidates = parentPaths.get(name) ?? new Set<string>();
      candidates.add(path);
      parentPaths.set(name, candidates);
    }
  }
  return slices.flatMap((slice, sliceIndex) => {
    let unresolved = false;
    const goal = slice.goal.replace(/(^|[\n·])(\s*(?:[-*]\s*)?(?:대상 경로|신규 경로|신설)\s*:\s*)([^\n]+?)(?=\s*·\s*(?:동작|행동|작업|대상 경로|신규 경로|신설)\s*:|$)/gm,
      (_whole, prefix: string, label: string, value: string) => {
        const restored = value.replace(/(?<![\w./-])[\w./-]+\.[A-Za-z][\w-]*/g, (path) => {
          if (path.includes('/')) return path;
          const candidates = [...(parentPaths.get(path) ?? [])];
          if (candidates.length === 1) return candidates[0]!;
          unresolved = true;
          try { debug.log('self-implement.decompose', 'slice-path-unresolved', { sliceIndex, path, candidates }); } catch { /* observation is fail-soft */ }
          return path;
        });
        return `${prefix}${label}${restored}`;
      });
    return unresolved ? [] : [{ ...slice, goal }];
  });
}

function expectedSliceTier(files: number, actions: number, newFiles: number): GoalSliceTier {
  if (files <= 2 && actions <= 1 && newFiles <= 1) return 'low';
  if (files <= 4 && actions <= 2 && newFiles <= 2) return 'medium';
  return 'high';
}

/** Estimates are observations from the planner, checked against the declared tier before they guide retry. */
function parseGoalSliceSizes(raw: string, count: number): GoalSliceSize[] | null {
  try {
    const parsed = JSON.parse(raw) as { slices?: unknown };
    if (!Array.isArray(parsed?.slices) || parsed.slices.length !== count) return null;
    const result: GoalSliceSize[] = [];
    for (const value of parsed.slices) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const row = value as Record<string, unknown>;
      const { files, newFiles, tier } = row;
      const actions = row.actions ?? row.behaviours;
      if (!Number.isSafeInteger(files) || !Number.isSafeInteger(actions) || !Number.isSafeInteger(newFiles)
        || (files as number) < 1 || (actions as number) < 1 || (newFiles as number) < 0
        || (newFiles as number) > (files as number)
        || tier !== expectedSliceTier(files as number, actions as number, newFiles as number)) return null;
      const unavoidableReason = typeof row.unavoidableReason === 'string' && row.unavoidableReason.trim()
        ? row.unavoidableReason.trim() : null;
      result.push({ files: files as number, actions: actions as number, newFiles: newFiles as number,
        tier: tier as GoalSliceTier, unavoidableReason });
    }
    return result;
  } catch { return null; }
}

/** Only explicit path and action lines can replace missing planner metadata. */
function deriveGoalSliceSizes(steps: readonly string[]): GoalSliceSize[] | null {
  const result: GoalSliceSize[] = [];
  for (const step of steps) {
    const pathLines = [...step.matchAll(/(?:^|[\n·])\s*(대상 경로|신규 경로)\s*:\s*([^\n]+?)(?=\s*·\s*(?:동작|행동|대상 경로|신규 경로)\s*:|$)/g)];
    const paths = new Set<string>();
    const newPaths = new Set<string>();
    for (const [, label, value] of pathLines) {
      for (const match of value!.matchAll(/(?:^|[\s,·`])([\w./-]+\.[A-Za-z][\w-]*)(?=$|[\s,·`])/g)) {
        paths.add(match[1]!);
        if (label === '신규 경로') newPaths.add(match[1]!);
      }
    }
    const actions = [...step.matchAll(/(?:^|[\n·])\s*(?:[-*]\s*)?(?:동작|행동)\s*:\s*([^\n·]+)/g)]
      .filter((match) => !!match[1]?.trim()).length;
    if (!paths.size || !actions) return null;
    const files = paths.size;
    const newFiles = newPaths.size;
    result.push({ files, actions, newFiles, tier: expectedSliceTier(files, actions, newFiles), unavoidableReason: null });
  }
  return result;
}

function goalSliceSizePrompt(objective: string, steps: readonly string[]): string {
  return [
    'GOAL_AUTHOR_SLICE_SIZE — estimate the size of each FINAL implementation slice.',
    'Reply with STRICT JSON only: {"slices":[{"files":1,"behaviours":1,"newFiles":0,"tier":"low","unavoidableReason":null}]}. Every slice MUST contain files, behaviours, newFiles, tier and unavoidableReason; do not omit a field.',
    'Example for two slices: {"slices":[{"files":2,"behaviours":1,"newFiles":0,"tier":"low","unavoidableReason":null},{"files":3,"behaviours":2,"newFiles":1,"tier":"medium","unavoidableReason":null}]}.',
    'One array item per slice in the same order. Count all target files including tests and runtime wiring; count distinct changed behaviors and newly created files.',
    'Use low for files<=2, behaviours<=1, newFiles<=1; medium for files<=4, behaviours<=2, newFiles<=2; otherwise high.',
    'For high, give a concrete one-line unavoidableReason only if splitting breaks an inseparable operation. Otherwise leave it null so the planner must split again.',
    `OBJECTIVE: ${objective}`,
    `STEPS_JSON: ${JSON.stringify(steps)}`,
  ].join('\n');
}

/** Injectable reader: failures remain distinguishable from a successful empty read. */
export type RecentStepCountReader = () => readonly number[];

type LogStoreLike = { query: (q?: { events?: string[] }) => readonly { data: string | null }[] };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Parse valid `stepCount` values; malformed rows are ignored and `[]` is a successful read. */
export function parseRecentStepCountsFromLogRows(rows: readonly { data: string | null }[]): number[] {
  const counts: number[] = [];
  for (const row of rows) {
    if (!row.data) continue;
    try {
      const data = JSON.parse(row.data) as unknown;
      if (!data || typeof data !== 'object') continue;
      const stepCount = (data as { stepCount?: unknown }).stepCount;
      if (isFiniteNumber(stepCount)) counts.push(stepCount);
    } catch {
      // Skip malformed log payloads while retaining the successful read result.
    }
  }
  return counts;
}

/** Reads the recent decomposition counts and throws on store/query failure. */
export function readRecentStepCountsFromLogStore(
  getStore: () => LogStoreLike | null = getDefaultLogStore,
): readonly number[] {
  const store = getStore();
  if (!store) throw new Error('recent step counts: log store unavailable');
  return parseRecentStepCountsFromLogRows(store.query({ events: [GOAL_STEPS_DECOMPOSED_EVENT] }));
}

/** Converts a reader failure to omission, without collapsing a successful empty array. */
export function readRecentStepCountsFailOpen(reader: RecentStepCountReader = readRecentStepCountsFromLogStore): readonly number[] | undefined {
  try {
    return reader();
  } catch {
    return undefined;
  }
}

/**
 * ⭐ AUTHOR-SHADOW-FIRST-SPLIT ① (0.2.29 · 근거 사례 #26644 · 대표 10-12 «착지해야만 낼 수 있는 증거는
 * 처음 저작부터 쪼갰어야»). 골 문면에 «명시 표지» 한 줄이 있으면 처음부터 두 조각
 * (① 그림자 → ② live 스위치, 선행 간선 1)으로 낸다.
 *
 * ⭐ 자연어 발동(0.2.35 must-fix ①) — 표지 줄이 없어도 «한 줄» 안에 그림자 우선 어휘(그림자 먼저·shadow first)와
 *   요청형 분할 어휘(분할해·분할해서·분할하라·나눠·나누어·쪼개)가 «같이» 실린 자연어 요청은 발동한다.
 *   오탐은 live 조각이 원 목표와 반대로 «켜라»를 지시하게 만드므로(리뷰 r4~r6) 닫힌 어휘쌍으로 보수적으로 본다:
 *   ⑴ 표지 콜론 형태(분할: …)와 그 변형·인용은 동사형이 아니어도 발동 제외(근접 오탐 방어 유지)
 *   ⑵ 같은 줄에 부정 어휘(말라·말고·마라·아니·않·금지·하면 안·안 되)가 있으면 발동 제외.
 *   표지가 없고 자연어 어휘쌍도 없는 문면은 종전 LLM 분해 그대로다.
 * 생산 소비자는 이 seam «하나»다 — `runGoalAuthorCli` 와 OP 디스패처(`dispatchSelfImplement`)가 기본 seam 으로 부른다.
 * ⛔ 런 슈퍼바이저쪽에 «같은 쪼개기»는 아직 없다(REVIEW-MUSTFIX-CLASSIFY ②는 범위 축 in-scope/split/ask-owner 만 판정하고
 *   이 표지를 다시 읽지 않는다 — `rg -l 'classifyShadowFirstSplit|SHADOW_FIRST_SPLIT|shadow-first-split' src/`의 결과는
 *   이 파일 ⊕ 그 시험뿐). 저작 때 놓친 표지를 런 중간에 되받는 경로는 후속이다.
 */
export const SHADOW_FIRST_SPLIT_MARKER = '분할: 그림자 먼저';
/**
 * 정확히 한 꼴 — 한 줄 «전체»가 `분할: 그림자 먼저` 와 같을 때만(콜론 뒤 공백 정확히 1개 · 앞·뒤 공백 불허).
 * 줄바꿈은 LF·CRLF 만 — 홀로 남은 CR 은 줄의 일부로 남아 불일치(미발동)다.
 */
function hasShadowFirstSplitMarkerLine(objective: string): boolean {
  return objective.split(/\r?\n/).some((line) => line === SHADOW_FIRST_SPLIT_MARKER);
}

export type ShadowFirstSplitPiece = { id: 'shadow' | 'live'; step: string; dependsOn: readonly ('shadow' | 'live')[] };

/** 발동 근거 — 명시 표지 줄 또는 자연어 요청(0.2.35 must-fix ①). */
export type ShadowFirstSplitTrigger = 'explicit-marker' | 'natural-language';

export type ShadowFirstSplitVerdict =
  | { kind: 'shadow-first-split'; pieces: readonly [ShadowFirstSplitPiece, ShadowFirstSplitPiece]; trigger: ShadowFirstSplitTrigger }
  | { kind: 'single-piece' };

// ⭐ AUTHOR-SHADOW-FIRST-SPLIT 자연어 발동(0.2.35 must-fix ①) — 닫힌 어휘쌍만 본다(오탐 방어 · 리뷰 r4~r6).
const SHADOW_FIRST_PHRASE_SOURCE = '그림자\\s+먼저|shadow[\\s-]+first';
const SHADOW_FIRST_NATURAL_LANGUAGE_LINE = new RegExp(
  `(?:${SHADOW_FIRST_PHRASE_SOURCE})[^\\n]{0,16}(?:분할(?:해|해서|하여|하라|해라|하고|하며)|나눠|나누어|쪼개)`
    + `|(?:분할(?:해|해서|하여|하라|해라|하고|하며)|나눠|나누어|쪼개)[^\\n]{0,16}(?:${SHADOW_FIRST_PHRASE_SOURCE})`,
  'i',
);
// ⛔ 부정·거절 어휘가 같은 줄에 있으면 발동하지 않는다 — live 조각의 «켜라» 오지시 방어(보수적 미발동).
//   «안 되»는 실현형(된다·됩니다·돼·됐…)까지 본다 — 본문은 «안 된다» 꼴이 지배한다.
const SHADOW_FIRST_NATURAL_NEGATION = /말라|말고|마라|아니|않|금지|하면\s*안|안\s*(?:돼|되|된|됐|될|됨|됩|됫|됬)/i;
// ⛔ 표지 콜론 형태(분할: …)와 그 변형·인용 줄은 자연어 발동에서 제외한다(문서 ⑴ · 근접 오탐 방어 유지).
const SHADOW_FIRST_MARKER_COLON_LIKE = /분할\s*[:：]/;

function hasShadowFirstSplitNaturalLanguageLine(objective: string): boolean {
  return objective.split(/\r?\n/).some((line) => SHADOW_FIRST_NATURAL_LANGUAGE_LINE.test(line)
    && !SHADOW_FIRST_NATURAL_NEGATION.test(line)
    && !SHADOW_FIRST_MARKER_COLON_LIKE.test(line));
}

const SHADOW_FIRST_SPLIT_PIECES: readonly [ShadowFirstSplitPiece, ShadowFirstSplitPiece] = [
  {
    id: 'shadow',
    step: '① 그림자 — 이 골의 배선이 자율 결정을 «기록만» 한다(자율 실행 0). 판정 = 시험 통과 ⊕ 그림자 관측 줄 모양(기록된 결정 1건 이상).',
    dependsOn: [],
  },
  {
    id: 'live',
    step: '② live 스위치 — 선행 = ① 그림자 착지. 같은 배선의 자율 실행을 켠다. 판정 = ① 착지 뒤 그림자 로그에 기대 결정 1건 이상 ⊕ 스위치 켬 ⊕ 이 골의 원 판정.',
    dependsOn: ['shadow'],
  },
];

/** 순수 판정 — 골 문면의 명시 표지 줄 ⊕ 자연어 요청 줄만 본다(LLM·원장 0 · 던지지 않는다). grounding context 는 읽지 않는다. */
export function classifyShadowFirstSplit(objective: string): ShadowFirstSplitVerdict {
  if (hasShadowFirstSplitMarkerLine(objective)) {
    return { kind: 'shadow-first-split', pieces: SHADOW_FIRST_SPLIT_PIECES, trigger: 'explicit-marker' };
  }
  if (hasShadowFirstSplitNaturalLanguageLine(objective)) {
    return { kind: 'shadow-first-split', pieces: SHADOW_FIRST_SPLIT_PIECES, trigger: 'natural-language' };
  }
  return { kind: 'single-piece' };
}

/** Shared LLM-backed decomposition seam for every goal-author entrypoint. */
export function createGoalAuthorDecomposeSteps(
  signal?: AbortSignal,
  config: {
    adversarialReview?: boolean;
    adversarialReviewSource?: 'cli' | 'default' | 'unknown';
    recentStepCounts?: readonly number[];
    onSizedSlices?: (slices: SizedSlice[], redecomposed: number) => void;
  } = {},
): NonNullable<GoalAuthorDeps['decomposeSteps']> {
  return async (objective, options) => {
    const finalize = (finalSteps: string[], rationale?: string): string[] => {
      if (finalSteps.length > 0 && rationale?.trim()) {
        try {
          emitDecision({
            kind: 'PLAN',
            what: finalSteps.length === 1 ? '분해 안 함(한 조각)' : `골을 조각 ${finalSteps.length}개로 분해`,
            reason: rationale.trim().split(/\r?\n|(?<=[.!?。])\s+/)[0]!,
            purpose: '조각마다 독립 런으로 · 실패를 작게 가둔다',
            target: finalSteps.slice(0, 8).join(' · '),
            paths: finalSteps.length,
            ...(options?.runId === undefined ? {} : { runId: options.runId }),
          });
        } catch { /* Live detail cannot change the decomposition result. */ }
      }
      return finalSteps;
    };
    // ⭐ AUTHOR-SHADOW-FIRST-SPLIT ① — LLM 분해·적대 비평 «전에» 규칙 판정. 감지된 골은 처음부터 두 조각.
    //   single-piece 는 관측 0 · 동작 0 변화(종전 그대로).
    const shadowSplit = classifyShadowFirstSplit(objective);
    if (shadowSplit.kind === 'shadow-first-split') {
      try {
        debug.log('goal-author', 'shadow-first-split', {
          surface: 'goal-author',
          verdict: shadowSplit.kind,
          trigger: shadowSplit.trigger,
          pieces: shadowSplit.pieces.map((piece) => piece.id),
          edges: shadowSplit.pieces.reduce((n, piece) => n + piece.dependsOn.length, 0),
          ...(options?.runId === undefined ? {} : { runId: options.runId }),
        });
      } catch { /* observation is fail-soft */ }
      return finalize(
        shadowSplit.pieces.map((piece) => piece.step),
        shadowSplit.trigger === 'explicit-marker'
          ? `명시 표지 «${SHADOW_FIRST_SPLIT_MARKER}» — 그림자 우선 두 조각(선행 간선 1).`
          : '자연어 요청(그림자 우선 어휘 ⊕ 분할 지시) — 그림자 우선 두 조각(선행 간선 1).',
      );
    }
    const { streamLLM } = await import('../llm.js');
    // ⭐ AUTHOR-DECOMPOSE-KNOB(0.2.24 · G7 #25848) — 쪼개기·적대 비평의 두 streamLLM 호출이 인핸서와
    //   «같은 규칙»으로 planning 노브(roleLlm.planning ⊕ ELANOUS_PROMPT_ENHANCE_MODEL/EFFORT)를 따른다.
    //   미설정이면 종전 그대로 — model 은 아예 전달하지 않는다(streamLLM 기본 모델) ⊕ effort 는 high.
    const { model, effort } = selectPlanningLlm();
    const llmOpts: { model?: string; reasoningEffort: 'low' | 'medium' | 'high'; signal?: AbortSignal } = model === undefined
      ? { reasoningEffort: effort, ...(signal ? { signal } : {}) }
      : { model, reasoningEffort: effort, ...(signal ? { signal } : {}) };
    let decompositionRationale: string | undefined;
    const decompose = (ask: string) => {
      decompositionRationale = undefined;
      return llmDecomposeSteps(
        ask,
        (input) => streamLLM([{ role: 'user', content: input.prompt }], () => {}, llmOpts).then((text) => ({ text })),
        { ...(options?.context ? { context: options.context } : {}), maxTasks: GOAL_AUTHOR_SIZE_SAFETY_MAX_SLICES,
          promptProfile: 'goal-author-coarse', ...(signal ? { signal } : {}),
          onRationale: (rationale) => { decompositionRationale = rationale; } },
      );
    };
    const steps = await decompose(objective);
    const finish = async (candidate: string[], rationale?: string): Promise<string[]> => {
      if (!candidate.length) return finalize(candidate, rationale);
      const measure = async (slices: string[]) => {
        const parsed = parseGoalSliceSizes(await streamLLM(
          [{ role: 'user', content: goalSliceSizePrompt(objective, slices) }], () => {}, llmOpts), slices.length);
        return parsed ? { sizes: parsed, sizeSource: 'planner-estimate' as const }
          : { sizes: deriveGoalSliceSizes(slices), sizeSource: 'derived' as const };
      };
      const observe = (event: 'slice-sized' | 'slice-oversize', sizeSource: 'planner-estimate' | 'derived', data: Record<string, unknown>) => {
        try { debug.log('goal-author.decompose', event, { surface: 'goal-author', sizeSource, ...data,
          ...(options?.runId === undefined ? {} : { runId: options.runId }) }); } catch { /* observation is fail-soft */ }
      };
      let redecomposed = 0;
      let measured = await measure(candidate);
      let sizes = measured.sizes;
      if (sizes) observe('slice-sized', measured.sizeSource, { retry: 0, slices: sizes });
      const oversized = sizes?.flatMap((size, index) => size.tier === 'high' ? [index] : []) ?? [];
      if (oversized.length || !sizes) {
        observe('slice-oversize', measured.sizeSource, { retry: 0, indexes: oversized,
          reasons: sizes ? oversized.map((index) => sizes![index]!.unavoidableReason) : [],
          ...(sizes ? {} : { error: 'size metadata missing or inconsistent' }) });
        const retryAsk = [objective, '', 'The previous goal-author proposal had missing size metadata or oversized slices.',
          `PREVIOUS_STEPS_JSON: ${JSON.stringify(candidate)}`,
          `OVERSIZED_INDEXES_JSON: ${JSON.stringify(oversized)}`,
          'Regenerate the full plan once. Preserve fitting slices and split each oversized slice into dependent low/medium slices where possible.',
          'If an oversized slice truly cannot split, leave it high and state a concrete unavoidable reason.'].join('\n');
        const regenerated = await decompose(retryAsk);
        if (!regenerated.length) throw new Error('goal-author slice sizing: regeneration produced no slices');
        redecomposed = 1;
        candidate = regenerated;
        rationale = decompositionRationale;
        measured = await measure(candidate);
        sizes = measured.sizes;
        if (!sizes) throw new Error('goal-author slice sizing: size metadata missing after one retry');
        observe('slice-sized', measured.sizeSource, { retry: 1, slices: sizes });
        const remaining = sizes.flatMap((size, index) => size.tier === 'high' ? [index] : []);
        if (remaining.length) observe('slice-oversize', measured.sizeSource, { retry: 1, indexes: remaining,
          reasons: remaining.map((index) => sizes![index]!.unavoidableReason) });
        if (remaining.some((index) => !sizes![index]!.unavoidableReason))
          throw new Error('goal-author slice sizing: high slice lacks unavoidable reason after one retry');
      }
      config.onSizedSlices?.(restoreSlicePaths(publicSizedSlices(candidate, sizes), objective), redecomposed);
      return finalize(candidate, rationale);
    };
    const heft = classifyHeft(objective);
    const adversarialReviewSource = config.adversarialReviewSource
      ?? (config.adversarialReview === undefined ? 'default' : 'unknown');
    const reviewEnabled = config.adversarialReview !== false;
    const reviewForced = config.adversarialReview === true;
    const reviewEligible = steps.length >= adversarialThreshold(heft);
    const reviewExecuted = reviewEnabled && (reviewForced || reviewEligible);
    const reviewSkipReason = !reviewExecuted ? !reviewEnabled ? 'disabled' : 'below-threshold' : null;
    const recentStepCount = config.recentStepCounts;
    if (recentStepCount?.length) {
      const recentMaximum = Math.max(...recentStepCount);
      const threshold = adversarialThreshold(heft);
      if (recentMaximum < threshold) {
        debug.log('goal-author', 'adversarial-threshold-unreachable', {
          surface: 'goal-author',
          heft,
          threshold,
          recentMaximum,
          sampleSize: recentStepCount.length,
        });
      }
    }
    debug.log('goal-author', 'adversarial-review', {
      surface: 'goal-author',
      heft,
      adversarialReview: config.adversarialReview ?? null,
      adversarialReviewSource,
      reviewEnabled,
      reviewForced,
      reviewEligible,
      reviewExecuted,
      reviewSkipReason,
    });
    if (!reviewExecuted) return finish(steps, decompositionRationale);
    const critic = (prompt: string) => streamLLM([{ role: 'user', content: prompt }], () => {}, llmOpts);

    let revisedSteps: string[] | undefined;
    try {
      const critique = await adversarialPlanCritique(objective, steps, critic, options?.context);
      const sample = critique?.issues.slice(0, 3).map((issue) => issue.slice(0, 60)) ?? [];
      const byAxis = critique?.byAxis ?? { scope: [] };
      if (critique?.revisedSteps.length) {
        debug.log('goal-author', 'adversarial-revised', {
          surface: 'goal-author',
          heft,
          steps: critique.revisedSteps.length,
          issues: critique.issues.length,
          sample,
          byAxis,
          reviewEnabled,
        });
        revisedSteps = critique.revisedSteps;
      } else {
        debug.log('goal-author', 'adversarial-sound', {
          surface: 'goal-author',
          heft,
          issues: critique?.issues.length ?? 0,
          sample,
          byAxis,
          reviewEnabled,
        });
      }
    } catch {
      // The red-team is advisory; authoring must retain the LLM decomposition on failure.
    }
    if (revisedSteps) return finish(revisedSteps);
    return finish(steps, decompositionRationale);
  };
}

/** Public goal-author sizing seam for a hand caller that needs per-slice tier metadata. */
export async function decomposeToTierSizedSlices(
  goal: string,
  opts?: { signal?: AbortSignal },
): Promise<TierSizedDecomposeResult> {
  let result: { slices: SizedSlice[]; redecomposed: number } | undefined;
  try {
    const steps = await createGoalAuthorDecomposeSteps(opts?.signal, {
      adversarialReview: false,
      onSizedSlices: (slices, redecomposed) => { result = { slices, redecomposed }; },
    })(goal);
    if (!steps.length || !result) return { ok: false, reason: 'goal-author slice sizing: no sized slices' };
    if (result.slices.length === 0) return { ok: false, reason: 'slice-path-unresolved' };
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
