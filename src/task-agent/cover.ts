import { debug } from '../debug/log.js';
import type { NextActionKind } from './actions.js';

type CoverVerb = 'land' | 'review' | 'retry' | 'green';
export interface CoverRow {
  verb: CoverVerb;
  /** null means the TASK-AGENT action source could not be fully read. */
  byTaskAgent: number | null;
  /** Total work by all seats; null when no independent denominator is available. */
  total: number | null;
  /** TASK-AGENT action events observed for this verb; null if unreadable. */
  observedActions: number | null;
  ratio: number | null;
  state: 'measured' | 'no-denominator' | 'unreadable';
  /** Non-shadow action events, including failures; null if the action source is incomplete. */
  liveActions: number | null;
  /** Shadow action events; null if the action source is incomplete. */
  shadowActions: number | null;
  /** A transition is observable only with an independent denominator and a completed TA action. */
  stewardTransition: 'observed' | 'not-observed' | 'unmeasured';
}

/** null means the source could not be read; [] means it was read and had no matching events. */
export interface TaskAgentCoverInput {
  taskAgentActions: readonly { kind: NextActionKind; result: string; reason?: string; taskId?: string }[] | null;
  /** Actual land executor outcomes; omitted or null means the source was not read. */
  liveLandMoves?: readonly { card: string; executed: boolean; ok: boolean }[] | null;
  allLands: readonly { step: string; ok: boolean }[] | null;
  /** Card-ledger denominator for review·retry·green. undefined = not requested; null = ledger unreadable; [] = no cards. */
  taskCards?: readonly { id: string }[] | null;
  /** Daily launch and PR counts come from their independent event sources; null means unreadable. */
  launched?: number | null;
  cardPrs?: number | null;
  /** null means the pending-landing age source could not be read; [] means no pending landings. */
  pendingLandingAgeSeconds?: readonly number[] | null;
  /** A source reached the query safety limit; its aggregate is not known to be complete. */
  truncated?: { taskAgentActions: boolean; allLands: boolean; liveLandMoves?: boolean; goalAsks?: boolean; goalRuns?: boolean; implementCardRuns?: boolean; implementRunMerges?: boolean };
  /** Completed authoring provenance and terminal goal records. undefined = not wired; null = unreadable. */
  goalAsks?: readonly { authorRunId: string; goalId: string }[] | null;
  goalRuns?: readonly { goalId: string; outcome: string; stage?: string }[] | null;
  /** 구현 출처 — TA 카드의 런 결합. undefined = 이 동사의 출처 배선이 없다(no-source); null = 카드 원장을 못 읽었다; [] = 읽고 카드 없음. */
  implementCardRuns?: readonly ImplementCardRunBinding[] | null;
  /** 구현 출처 — 런 원장의 merged 사건. undefined = 배선 없음; null = 런 원장을 못 읽음. */
  implementRunMerges?: ReadonlyMap<string, ImplementRunMergeEvent> | null;
}

/** 구현 동사의 카드 결합 — runId·runChildId 는 그 카드가 발사한 런이다. */
export interface ImplementCardRunBinding {
  cardId: string;
  runId?: string | null;
  runChildId?: string | null;
}

/** 구현 동사의 원장 merged 사건 — merged=true 만 완료 구현으로 센다. */
export interface ImplementRunMergeEvent {
  merged: boolean;
}

export type LandingFailureReason = 'load' | 'oom' | 'time-limit' | 'conflict' | 'review' | 'other';
export interface LandingThroughput {
  launched: number | null;
  cardPrs: number | null;
  taskAgentLandings: number | null;
  launchToPrRatio: number | null;
  prToLandingRatio: number | null;
  failureReasons: Record<LandingFailureReason, number> | null;
  pendingLandings: number | null;
  oldestPendingAgeSeconds: number | null;
}

const FAILURE_REASONS: readonly LandingFailureReason[] = ['load', 'oom', 'time-limit', 'conflict', 'review', 'other'];

function successfulLandCount(input: TaskAgentCoverInput): number | null {
  if (input.taskAgentActions === null || input.truncated?.taskAgentActions
    || input.liveLandMoves == null || input.truncated?.liveLandMoves) return null;
  const cards = new Set<string>();
  for (const action of input.taskAgentActions) {
    if (action.kind !== 'land' || action.result !== 'done') continue;
    // Without a card identity an action may duplicate a live-move; its count is unknown.
    if (!action.taskId) return null;
    cards.add(action.taskId);
  }
  for (const move of input.liveLandMoves) {
    if (!move.executed || !move.ok) continue;
    if (!move.card) return null;
    cards.add(move.card);
  }
  return cards.size;
}

function landingFailureReason(action: { kind: NextActionKind; reason?: string }): LandingFailureReason {
  const reason = action.reason ?? '';
  if (/\boom\b|out[- ]of[- ]memory|oomkilled|메모리.{0,12}(초과|부족|킬)/i.test(reason)) return 'oom';
  if (/timeout|timed out|time[- ]limit|deadline|시간.{0,12}(초과|한도)/i.test(reason)) return 'time-limit';
  if (/conflict|merge conflict|충돌/i.test(reason)) return 'conflict';
  if (action.kind === 'review' || /review|리뷰/i.test(reason)) return 'review';
  if (/load|resource.{0,12}(pressure|exhaust|limit)|cpu.{0,8}load|부하|포화/i.test(reason)) return 'load';
  return 'other';
}

/** Daily funnel, failure-reason distribution, and oldest pending-landing age. */
export function measureLandingThroughput(input: TaskAgentCoverInput): LandingThroughput {
  const actionsReadable = input.taskAgentActions !== null && input.truncated?.taskAgentActions !== true;
  const taskAgentLandings = actionsReadable ? successfulLandCount(input) : null;
  const failureReasons = actionsReadable
    ? Object.fromEntries(FAILURE_REASONS.map((reason) => [reason, 0])) as Record<LandingFailureReason, number>
    : null;
  if (failureReasons && input.taskAgentActions) {
    for (const action of input.taskAgentActions) {
      if (action.result !== 'failed') continue;
      const reason = landingFailureReason(action);
      failureReasons[reason]++;
    }
  }
  const launched = input.launched ?? null;
  const cardPrs = input.cardPrs ?? null;
  const pendingAges = input.pendingLandingAgeSeconds ?? null;
  const launchToPrRatio = launched !== null && launched > 0 && cardPrs !== null ? cardPrs / launched : null;
  const prToLandingRatio = cardPrs !== null && cardPrs > 0 && taskAgentLandings !== null ? taskAgentLandings / cardPrs : null;
  return {
    launched, cardPrs, taskAgentLandings, launchToPrRatio, prToLandingRatio, failureReasons,
    pendingLandings: pendingAges === null ? null : pendingAges.length,
    oldestPendingAgeSeconds: pendingAges === null || pendingAges.length === 0 ? null : Math.max(...pendingAges),
  };
}

/** Unknown values stay unknown; empty pending queues are reported distinctly from unreadable ages. */
export function formatLandingThroughput(row: LandingThroughput, period = '1d'): string {
  const count = (value: number | null): string => value === null ? '-' : String(value);
  const ratio = (value: number | null): string => value === null ? '-' : `${(value * 100).toFixed(1)}%`;
  const failures = row.failureReasons === null ? '못 잼' :
    `부하 ${row.failureReasons.load} · OOM ${row.failureReasons.oom} · 시간 한도 ${row.failureReasons['time-limit']} · 충돌 ${row.failureReasons.conflict} · 리뷰 ${row.failureReasons.review} · 기타 ${row.failureReasons.other}`;
  const pendingAge = row.pendingLandings === null ? '못 잼'
    : row.pendingLandings === 0 ? '없음'
      : row.oldestPendingAgeSeconds === null ? '못 잼'
        : row.oldestPendingAgeSeconds < 3600
          ? `${Math.floor(row.oldestPendingAgeSeconds / 60)}분`
          : `${(row.oldestPendingAgeSeconds / 3600).toFixed(1)}h`;
  return `처리량(${period}) 발사 ${count(row.launched)} → 카드 PR ${count(row.cardPrs)} → TA 착지 ${count(row.taskAgentLandings)} (발사→PR ${ratio(row.launchToPrRatio)} · PR→착지 ${ratio(row.prToLandingRatio)}) · 착지 실패 ${failures} · 착지 대기 ${count(row.pendingLandings)}건, 최장 ${pendingAge}`;
}

/** Land uses the merge-step denominator; review·retry·green use the card ledger only when `taskCards` is given. */
export function measureTaskAgentCover(input: TaskAgentCoverInput): CoverRow[] {
  const verbs: CoverVerb[] = ['land', 'review', 'retry', 'green'];
  const cardIds = input.taskCards ? new Set(input.taskCards.map((card) => card.id)) : null;
  const rows = verbs.map((verb): CoverRow => {
    const actions = input.taskAgentActions?.filter((action) => action.kind === verb);
    const actionsUnreadable = actions === undefined || input.truncated?.taskAgentActions === true;
    const byTaskAgent = verb === 'land' ? successfulLandCount(input)
      : actionsUnreadable ? null : actions.filter((action) => action.result === 'done').length;
    const observedActions = actionsUnreadable ? null : actions.length;
    const liveActions = actionsUnreadable ? null : actions.filter((action) => action.result !== 'shadow').length;
    const shadowActions = actionsUnreadable ? null : actions.filter((action) => action.result === 'shadow').length;
    const counts = { liveActions, shadowActions };
    if (verb !== 'land' && input.taskCards !== undefined) {
      if (actionsUnreadable || cardIds === null) return {
        verb, byTaskAgent: null, total: null, observedActions, ratio: null, state: 'unreadable' as const,
        ...counts, stewardTransition: 'unmeasured' as const,
      };
      const doneCards = new Set(actions.filter((action) => action.result === 'done' && action.taskId !== undefined && cardIds.has(action.taskId)).map((action) => action.taskId));
      const total = cardIds.size;
      const ratio = total === 0 ? null : doneCards.size / total;
      return {
        verb, byTaskAgent: doneCards.size, total, observedActions, ratio, state: total === 0 ? 'no-denominator' as const : 'measured' as const,
        ...counts, stewardTransition: ratio === null ? 'unmeasured' as const : doneCards.size > 0 ? 'observed' as const : 'not-observed' as const,
      };
    }
    if (verb !== 'land') return {
      verb, byTaskAgent, total: null, observedActions, ratio: null,
      state: actionsUnreadable ? 'unreadable' : 'no-denominator',
      ...counts, stewardTransition: 'unmeasured' as const,
    };
    const total = input.allLands === null || input.truncated?.allLands
      ? null : input.allLands.filter((land) => land.step === 'merge' && land.ok === true).length;
    const state = byTaskAgent === null || total === null ? 'unreadable'
      : total === 0 ? 'no-denominator' : 'measured';
    const ratio = state === 'measured' && byTaskAgent !== null && total !== null ? byTaskAgent / total : null;
    return { verb, byTaskAgent, total, observedActions, ratio, state, ...counts,
      stewardTransition: ratio === null ? 'unmeasured' : byTaskAgent !== null && byTaskAgent > 0 ? 'observed' : 'not-observed',
    };
  });
  if (input.taskCards !== undefined) {
    try {
      debug.log('task-agent.cover', 'by-card', {
        cards: input.taskCards === null ? null : cardIds?.size,
        verbs: rows.filter((row) => row.verb !== 'land').map(({ verb, byTaskAgent, total, state }) => ({ verb, byTaskAgent, total, state })),
      });
    } catch { /* fail-soft */ }
  }
  return rows;
}

/** A single human-readable line per verb; unknown numbers are never rendered as zero. */
export function formatTaskAgentCover(row: CoverRow): string {
  const value = (count: number | null): string => count === null ? '-' : String(count);
  return `${row.verb}: TA ${value(row.byTaskAgent)}/${value(row.total)} (${row.ratio === null ? '-' : `${(row.ratio * 100).toFixed(1)}%`}) · live ${value(row.liveActions)} · shadow ${value(row.shadowActions)} · steward-transition ${row.stewardTransition}`;
}

/** 7동사의 이름 — 리뷰·착지·수리·검증·저작·구현·정리 (decision·deliver 는 7동사 밖이라 세지 않는다). */
export type SevenVerbName = '리뷰' | '착지' | '수리' | '검증' | '저작' | '구현' | '정리';

/** no-source 는 출처 배선이 없는 동사 · unreadable 은 해당 동사의 원천을 완전히 못 읽은 것이다. */
export type SevenVerbState = 'live' | 'shadow-only' | 'none' | 'no-source' | 'unreadable';

/** 7동사 출처 표의 한 칸 — source 는 그 동사를 관측하는 원천, null 이면 출처가 아직 없다. */
export interface SevenVerbSource {
  verb: SevenVerbName;
  source: Exclude<NextActionKind, 'decision' | 'deliver'> | 'goal-ask+goal-run' | 'card-run+merged' | null;
}

/** TA-THEME-VERBS-LIVE — 저작은 완료 골 조인; 구현은 카드 런 결합 ⊕ 원장 merged 조인; 정리는 아직 출처가 없다. */
export const SEVEN_VERB_SOURCES: readonly SevenVerbSource[] = [
  { verb: '리뷰', source: 'review' },
  { verb: '착지', source: 'land' },
  { verb: '수리', source: 'retry' },
  { verb: '검증', source: 'green' },
  { verb: '저작', source: 'goal-ask+goal-run' },
  { verb: '구현', source: 'card-run+merged' },
  { verb: '정리', source: null },
];

/** 동사 하나의 관측 — 원장을 못 읽었으면 liveDone·shadow 는 null(0 이 아니다). */
export interface SevenVerbLiveRow {
  verb: SevenVerbName;
  source: SevenVerbSource['source'];
  liveDone: number | null;
  shadow: number | null;
  state: SevenVerbState;
}

/** 합계 — liveVerbs 는 원장을 못 읽었으면 null(0 으로 쓰지 않는다) · measuredVerbs 는 출처 있는 동사 수. */
export interface SevenVerbLive {
  verbs: SevenVerbLiveRow[];
  liveVerbs: number | null;
  measuredVerbs: number;
}

/** 행동 동사는 창 안의 done, 저작은 완료한 저작 원장과 착지 골의 조인, 구현은 카드 런 결합과 원장 merged 사건의 조인. 각 출처의 null·절단은 해당 동사만 unreadable. */
export function measureSevenVerbLive(input: TaskAgentCoverInput): SevenVerbLive {
  const unreadable = input.taskAgentActions === null || input.truncated?.taskAgentActions === true;
  const verbs = SEVEN_VERB_SOURCES.map(({ verb, source }): SevenVerbLiveRow => {
    if (source === 'card-run+merged') {
      // ⛔ 배선이 없으면 출처가 «있는» 동사로 거짓 측정을 하지 않는다 — no-source 로 그대로 둔다.
      if (input.implementCardRuns === undefined && input.implementRunMerges === undefined) {
        return { verb, source: null, liveDone: null, shadow: null, state: 'no-source' };
      }
      if (input.implementCardRuns == null || input.implementRunMerges == null
        || input.truncated?.implementCardRuns === true || input.truncated?.implementRunMerges === true) {
        return { verb, source, liveDone: null, shadow: null, state: 'unreadable' };
      }
      const merges = input.implementRunMerges;
      const cards = new Set<string>();
      for (const binding of input.implementCardRuns) {
        // 카드 신원 없이는 중복 없는 분자를 낼 수 없다 — 그 원장은 못 읽은 것으로 한다.
        if (!binding.cardId) return { verb, source, liveDone: null, shadow: null, state: 'unreadable' };
        const bound = [binding.runId, binding.runChildId];
        if (bound.some((runId) => typeof runId === 'string' && runId && merges.get(runId)?.merged === true)) {
          cards.add(binding.cardId);
        }
      }
      const liveDone = cards.size;
      return { verb, source, liveDone, shadow: 0, state: liveDone >= 1 ? 'live' : 'none' };
    }
    if (source === null) return { verb, source: null, liveDone: null, shadow: null, state: 'no-source' };
    if (source !== 'goal-ask+goal-run' && (unreadable || (source === 'land'
      && (input.liveLandMoves == null || input.truncated?.liveLandMoves)))) {
      return { verb, source, liveDone: null, shadow: null, state: 'unreadable' };
    }
    if (source === 'goal-ask+goal-run') {
      if (input.goalAsks == null || input.goalRuns == null || input.truncated?.goalAsks || input.truncated?.goalRuns) {
        return { verb, source, liveDone: null, shadow: null, state: 'unreadable' };
      }
      const landed = new Set(input.goalRuns.filter((run) =>
        run.stage === 'merged' && (run.outcome === 'completed' || run.outcome === 'merged')).map((run) => run.goalId));
      const liveDone = new Set(input.goalAsks.filter((ask) => ask.authorRunId && landed.has(ask.goalId)).map((ask) => ask.goalId)).size;
      return { verb, source, liveDone, shadow: 0, state: liveDone > 0 ? 'live' : 'none' };
    }
    const actions = input.taskAgentActions!.filter((action) => action.kind === source);
    const liveDone = source === 'land' ? successfulLandCount(input) : actions.filter((action) => action.result === 'done').length;
    if (liveDone === null) return { verb, source, liveDone: null, shadow: null, state: 'unreadable' };
    const shadow = actions.filter((action) => action.result === 'shadow').length;
    return { verb, source, liveDone, shadow, state: liveDone >= 1 ? 'live' : shadow >= 1 ? 'shadow-only' : 'none' };
  });
  return {
    verbs,
    liveVerbs: verbs.some((row) => row.state === 'unreadable' && row.source !== null) ? null : verbs.filter((row) => row.state === 'live').length,
    measuredVerbs: verbs.filter((row) => row.source !== null).length,
  };
}

/** 한 줄 요약 — 못 읽었으면 n 자리를 `-` 로 적는다(0 으로 읽히지 않게). */
export function formatSevenVerbLive(measurement: SevenVerbLive): string {
  const total = SEVEN_VERB_SOURCES.length;
  if (measurement.liveVerbs === null) {
    const actionUnreadable = measurement.verbs.some((row) => row.source === 'review' && row.state === 'unreadable');
    const landUnreadable = measurement.verbs.some((row) => row.source === 'land' && row.state === 'unreadable');
    const authorUnreadable = measurement.verbs.some((row) => row.source === 'goal-ask+goal-run' && row.state === 'unreadable');
    const implementUnreadable = measurement.verbs.some((row) => row.source === 'card-run+merged' && row.state === 'unreadable');
    const failures = [
      actionUnreadable ? '행동' : landUnreadable ? '착지' : null,
      authorUnreadable ? '저작·골' : null,
      implementUnreadable ? '구현 카드·런' : null,
    ].filter((part): part is string => part !== null);
    const reason = `${failures.join('·') || '저작·골'} 원장 null·절단`;
    const noSource = measurement.verbs.filter((row) => row.state === 'no-source').map((row) => row.verb).join('·');
    return `${total}동사 live -/${total} · 못 잼(${reason})${noSource ? ` · 출처 없음 ${noSource}` : ''}`;
  }
  const noSource = measurement.verbs.filter((row) => row.state === 'no-source').map((row) => row.verb).join('·');
  return `${total}동사 live ${measurement.liveVerbs}/${total}${noSource ? ` · 출처 없음 ${noSource}` : ''}`;
}
