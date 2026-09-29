import type { BrainSuggestionAction } from './auto-intervene.js';
import type { ControlStance } from '../pty-shell/pty-control-stance.js';
import type { applyReworkBudgetDecision } from './rework-policy.js';

type ReworkBudgetDecision = NonNullable<Parameters<typeof applyReworkBudgetDecision>[1]>;
type ReworkBudgetVerdict = ReworkBudgetDecision['verdict'];

/** Pure supervision terms. This is vocabulary only: no execution path consumes it yet. */
export type SupervisionVerdict =
  | { readonly verdict: 'continue' }
  | { readonly verdict: 'assist'; readonly kind: string }
  | { readonly verdict: 'escalate' }
  | { readonly verdict: 'abandon' }
  | { readonly verdict: 'complete' }
  /** `defer` has no execution path until deferred-resume wiring exists. */
  | { readonly verdict: 'defer'; readonly until: string };

export type SupervisionReworkSource = 'gate' | 'review' | 'supervisor';

/** Every rework source has an explicit stable prompt section and terminal disposition. */
export const SUPERVISION_REWORK_SOURCES = ['gate', 'review', 'supervisor'] as const;
export type SupervisionCadence = 'once' | 'always' | 'on-signal' | 'scheduled';

export type SupervisionCadenceValidation =
  | { readonly valid: true; readonly cadence: 'once' | 'always' }
  | { readonly valid: false; readonly reason: string };

const CONTINUE: SupervisionVerdict = { verdict: 'continue' };
const COMPLETE: SupervisionVerdict = { verdict: 'complete' };
const ABANDON: SupervisionVerdict = { verdict: 'abandon' };

export function assist(kind: string): SupervisionVerdict {
  return { verdict: 'assist', kind };
}

/**
 * Renames an existing brain action without altering execution. `stallConfirmed` must be
 * `decideAutoStop(input).stop`, the exact current condition that ends parent waiting.
 */
export function mapBrainAction(
  action: BrainSuggestionAction,
  stallConfirmed: boolean,
): SupervisionVerdict {
  switch (action) {
    case 'wait':
    case 'handoff':
      return CONTINUE;
    case 'ask-human':
      return { verdict: 'escalate' };
    case 'input':
    case 'key':
    case 'mouse':
    case 'resize':
      // 두뇌가 PTY 에 직접 행동(키·마우스·크기)을 낸 것도 «입력을 넣어 돕는다» 와 같은 판정이다.
      return assist('context');
    case 'done':
      return stallConfirmed ? ABANDON : COMPLETE;
    case 'no-progress':
      return { verdict: 'escalate' };
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

/** Renames an existing rework budget verdict without altering its disposition. */
export function mapReworkVerdict(
  verdict: ReworkBudgetVerdict,
  source: SupervisionReworkSource,
): SupervisionVerdict {
  switch (verdict) {
    case 'EXTEND':
      return CONTINUE;
    case 'SUFFICIENT':
      return source === 'review' ? COMPLETE : CONTINUE;
    case 'UNCONVERGEABLE':
      return ABANDON;
    case 'CONTRACT-CONFLICT':
      return assist('contract-conflict');
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

/** Names the existing disposition for a PTY ownership stance without changing it. */
export function mapControlStance(
  stance: ControlStance,
  policy: 'halt' | 'skip',
): SupervisionVerdict {
  if (stance === 'owned' || policy === 'skip') return CONTINUE;
  return ABANDON;
}

/** Rejects cadences whose required execution substrate is not wired. */
export function validateSupervisionCadence(cadence: SupervisionCadence): SupervisionCadenceValidation {
  switch (cadence) {
    case 'once':
    case 'always':
      return { valid: true, cadence };
    case 'on-signal':
      return { valid: false, reason: 'on-signal requires the signal substrate' };
    case 'scheduled':
      return { valid: false, reason: 'scheduled requires deferred-resume wiring' };
  }
}

/** 관측에 실을 감독 판단 필드(순수). ⭐ 어휘 목록을 **호출부가 복제하지 않게** 하는 단일 지점.
 *
 * ⚠️ 타입이 보장한다고 믿지 않는다 — `mapBrainAction` 의 입력은 **LLM 응답에서 온 경계값**이라
 * `BrainSuggestionAction` 밖의 문자열이 런타임에 흘러올 수 있고, 그때 exhaustive 분기가 그 값을
 * 그대로 되돌린다. 그래서 여기서 한 번 검증한다. 호출부가 `as unknown as {…}` 로 union 을 뭉개고
 * 어휘 목록을 각자 하드코딩하면 **어휘가 늘 때마다 여러 곳을 고쳐야 한다** — 그 복제를 여기서 끝낸다. */
const SUPERVISION_VERDICTS: readonly string[] = ['continue', 'assist', 'escalate', 'abandon', 'complete', 'defer'];

export function supervisionObservationFields(v: SupervisionVerdict): Record<string, string> {
  const verdict = (v as { verdict?: unknown } | undefined)?.verdict;
  if (typeof verdict !== 'string' || !SUPERVISION_VERDICTS.includes(verdict)) {
    return { supervisionMappingError: 'unexpected-supervision-verdict' };
  }
  const kind = (v as { kind?: unknown }).kind;
  return verdict === 'assist' && typeof kind === 'string'
    ? { supervisionVerdict: verdict, supervisionAssistKind: kind }
    : { supervisionVerdict: verdict };
}
