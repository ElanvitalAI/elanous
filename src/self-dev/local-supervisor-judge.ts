/**
 * 로컬 슈퍼바이저 판정부(local supervisor judge) — 외부 호출 0.
 *
 * 외부 LLM/검색/크롤 없이, 슈퍼바이저가 이미 관측한 신호만으로 멈춤 사유를 고른다:
 *   - 후보(candidates): 호출자가 살아있다고 본 SupervisorStopReason 목록 — 배열 순서가 호출자의 우선순위다.
 *   - 화면 관측: PTY screen-buffer 의 screenTail · screenOutcome · screenSpace (run-types.ts SelfDevJobResult 와 같은 이름).
 *   - 진동 신호: ReviewRework 의 trend/signature 와 goal-loop 노드 재방문(walk).
 *
 * 순수 함수다 — I/O · 시계 · 난수 · 외부 호출 없다. 같은 입력은 항상 같은 판정을 낸다.
 * 배선은 별도 샤드가 한다(decideNextRun/superviseRun 봉합); 이 모듈은 run-supervisor.ts 를 고치지 않는다.
 *
 * 판정 순위(슈퍼바이저 본 로직과 같은 순서다 — 수확/병합 판정이 진동 판정보다 앞선다):
 *   ① 명시적 화면 완료(outcome=complete) → 수렴 계열 후보 중 강한 순
 *   ② 측정된 리뷰 진동(trend=oscillating) → 진동 계열 후보 중 강한 순
 *   ③ 화면 미완료(outcome=incomplete) → 수렴 계열 후보 기각, 남은 후보가 없으면 판단 불가
 *   ④ 신호가 판단을 가르지 못하면 → 호출자 후보 순위의 첫 후보
 */
import { SUPERVISOR_STOP_REASONS, type SupervisorStopReason } from './run-types.js';
import type { SupervisorDecision } from './run-supervisor.js';

/** PTY 화면 관측 — run-types.ts SelfDevJobResult 의 screenTail · screenOutcome · screenSpace 와 같은 모양. */
export interface LocalJudgeScreenObservation {
  screenTail?: string;
  screenOutcome?: 'complete' | 'incomplete' | null;
  screenSpace?: string;
}

/** goal-loop 노드 방문 기록(walk) — 같은 노드를 서로 다른 회차에 다시 방문하면 진동 신호다. */
export interface LocalJudgeWalkEntry {
  node?: string;
  round?: number;
}

/** 리뷰 재작업 신호 — run-types.ts ReviewRework 의 관측 필드(구조 호환 — ReviewRework 를 그대로 줘도 된다). */
export interface LocalJudgeReworkSignal {
  runs?: number;
  trend?: 'oscillating' | 'improving' | 'worsening';
  signature?: string;
  lastReason?: string;
}

export interface LocalSupervisorJudgeInput {
  /** 판정 후보 — 1개 이상 · SUPERVISOR_STOP_REASONS 원소만. 반드시 이 안에서 고른다. */
  candidates: readonly SupervisorStopReason[];
  screen?: LocalJudgeScreenObservation;
  walk?: readonly LocalJudgeWalkEntry[];
  rework?: LocalJudgeReworkSignal;
}

export interface LocalSupervisorJudgeVerdict {
  /** False means the available candidates contradict the screen observation; caller must continue judging. */
  determined: boolean;
  stopReason?: SupervisorStopReason;
  why: string;
  /** 0..1 — 관측 신호가 이 판정을 받쳤는가(결정적 상수 · 임의성 없다). */
  confidence: number;
  /** 판정 근거 신호 목록(사람이 읽는다). */
  signals: readonly string[];
  /** 진동 신호를 봤는가 — 후보에 진동 사유가 없으면 신호만 남고 다른 사유를 고른다. */
  oscillating: boolean;
  /** SupervisorDecision 호환 stop 조각 — 호출자의 회차 base 와 합쳐 쓴다. */
  decisionFragment: Pick<SupervisorDecision, 'action' | 'stopReason' | 'why'>;
}

/** 화면이 완료를 보일 때 먼저 고를 수렴 계열 사유(강한 순). */
export const LOCAL_JUDGE_CONVERGENCE_ORDER = [
  'deliverable-merged',
  'harvestable-awaiting-human',
  'handed-off-to-salvage',
  'converged',
] as const satisfies readonly SupervisorStopReason[];

/** 진동 신호가 보일 때 고를 진동 사유 — SupervisorStopReason 의 진동 계열은 review-oscillating 하나다. */
export const LOCAL_JUDGE_OSCILLATION_ORDER = [
  'review-oscillating',
] as const satisfies readonly SupervisorStopReason[];

const COMPLETION_CONFIDENCE = 0.9;
const OSCILLATION_TREND_CONFIDENCE = 0.8;
const VETO_CONFIDENCE = 0.7;
const FALLBACK_CONFIDENCE = 0.5;

const isConvergence = (reason: SupervisorStopReason): boolean =>
  (LOCAL_JUDGE_CONVERGENCE_ORDER as readonly string[]).includes(reason);

const firstPresent = (
  order: readonly SupervisorStopReason[],
  candidates: readonly SupervisorStopReason[],
): SupervisorStopReason | undefined => order.find((reason) => candidates.includes(reason));

/** 같은 노드를 서로 다른 회차에서 다시 방문했는가 — 회차 번호 없는 항목은 재방문 판정에 세지 않는다. */
const repeatedWalkNode = (walk: readonly LocalJudgeWalkEntry[]): { node: string; visits: number } | undefined => {
  const byNode = new Map<string, Set<number>>();
  for (const entry of walk) {
    if (typeof entry?.node !== 'string' || entry.node.length === 0 || typeof entry?.round !== 'number') continue;
    let rounds = byNode.get(entry.node);
    if (!rounds) {
      rounds = new Set<number>();
      byNode.set(entry.node, rounds);
    }
    rounds.add(entry.round);
  }
  for (const [node, rounds] of byNode) {
    if (rounds.size >= 2) return { node, visits: rounds.size };
  }
  return undefined;
};

export function localSupervisorJudge(input: LocalSupervisorJudgeInput): LocalSupervisorJudgeVerdict {
  const { candidates, screen, walk, rework } = input;
  if (candidates.length === 0) {
    throw new Error('local-supervisor-judge: 판정 후보(candidates)가 비었다 — 후보 없이는 판정할 수 없다');
  }
  for (const candidate of candidates) {
    if (!(SUPERVISOR_STOP_REASONS as readonly string[]).includes(candidate)) {
      throw new Error(`local-supervisor-judge: 후보 '${String(candidate)}' 은(는) SupervisorStopReason 이 아니다`);
    }
  }

  const signals: string[] = [];
  const outcome = screen?.screenOutcome ?? undefined;
  signals.push(outcome === 'complete' ? 'screen:complete'
    : outcome === 'incomplete' ? 'screen:incomplete'
    : 'screen:absent');
  if (screen?.screenSpace) signals.push(`screen-space:${screen.screenSpace}`);
  const tail = typeof screen?.screenTail === 'string' ? screen.screenTail : '';
  const tailSaysComplete = tail.includes('GOAL-COMPLETE');
  if (tailSaysComplete) signals.push('screen-tail:GOAL-COMPLETE');
  if (outcome === 'incomplete' && tailSaysComplete) signals.push('screen:conflict-incomplete-over-tail');
  if (rework?.trend) signals.push(`rework:trend=${rework.trend}`);
  if (rework?.signature) signals.push(`rework:signature=${rework.signature}`);
  if (typeof rework?.runs === 'number' && rework.runs >= 2) signals.push(`rework:runs=${rework.runs}`);
  if (rework?.lastReason) signals.push(`rework:last=${rework.lastReason}`);
  const walkRepeat = repeatedWalkNode(walk ?? []);
  if (walkRepeat) signals.push(`walk:repeat:${walkRepeat.node}x${walkRepeat.visits}`);

  // Explicit incomplete outcome is stronger than a marker in buffered text, which may be stale.
  // A marker in the PTY buffer has no round identity; only the explicit outcome authorizes completion.
  const screenSaysComplete = outcome === 'complete';
  // A repeated node and one current signature do not prove that the same finding recurred.
  // Only the measured review trend can authorize an oscillation stop.
  const oscillating = rework?.trend === 'oscillating';
  if (screenSaysComplete) signals.push('signal:completion');
  if (oscillating) signals.push('signal:oscillation');

  const verdict = (reason: SupervisorStopReason, confidence: number, label: string): LocalSupervisorJudgeVerdict => {
    const why = `로컬 판정(${label}) — ${reason} · 근거 ${signals.join(' · ')}`;
    return {
      stopReason: reason,
      determined: true,
      why,
      confidence,
      signals,
      oscillating,
      decisionFragment: { action: 'stop', stopReason: reason, why },
    };
  };

  // ① 화면 완료 — 수렴 계열 후보 중 강한 순.
  if (screenSaysComplete) {
    const picked = firstPresent(LOCAL_JUDGE_CONVERGENCE_ORDER, candidates);
    if (picked !== undefined) return verdict(picked, COMPLETION_CONFIDENCE, 'completion-family');
  }

  // ② 진동 — 측정된 재작업 추이(trend)만 종료 근거다. 노드 재방문은 진단 신호로 남긴다.
  if (oscillating) {
    const picked = firstPresent(LOCAL_JUDGE_OSCILLATION_ORDER, candidates);
    if (picked !== undefined) {
      return verdict(picked, OSCILLATION_TREND_CONFIDENCE, 'oscillation-family');
    }
  }

  // ③ 화면 미완료 — 아직 끝나지 않았으므로 수렴 계열 후보를 기각한다.
  if (outcome === 'incomplete') {
    const survivor = candidates.find((candidate) => !isConvergence(candidate));
    if (survivor !== undefined) return verdict(survivor, VETO_CONFIDENCE, 'incomplete-veto');
    signals.push('signal:undetermined');
    const why = `로컬 판정(undetermined) — incomplete 화면이 모든 수렴 후보를 기각 · 근거 ${signals.join(' · ')}`;
    return { determined: false, why, confidence: 0, signals, oscillating,
      decisionFragment: { action: 'relaunch', why } };
  }

  // ④ 신호가 판단을 가르지 못한다 — 호출자 후보 순위의 첫 후보.
  return verdict(candidates[0]!, FALLBACK_CONFIDENCE, 'fallback-order');
}
