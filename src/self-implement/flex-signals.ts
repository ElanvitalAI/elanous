/**
 * 재작업 라운드 관측 신호 넷 — 관측 전용 순수 계산(FLEX-RFC §A-①).
 *
 * ⛔ 판정·분기·오버레이 상태를 만들지 않는다. 호출자는 결과를 원장에 «남기기만» 한다.
 * ⛔ 모르는 값은 0 으로 지어내지 않고 키를 뺀다(key-absent) — 0 은 «측정했더니 없었다»의 값이다.
 */

export interface FlexSignalsInput {
  /** 오래된 라운드 → 최신 라운드 순의 게이트 실패 id 목록. `undefined`·빈 목록은 «실패 id 를 못 쟀다». */
  gateFailedIdsByRound: readonly (readonly string[] | undefined)[];
  /** 최신 게이트 실패들의 base 귀속(`preexisting`·`introduced`·`unknown` …). 못 쟀으면 `undefined`. */
  failureAttributions?: readonly string[] | undefined;
  /** 지금 orchestrator 가 알고 있는 review_repeat 값 그대로. */
  reviewRepeat?: number | undefined;
  /** 지금까지 쓴 라운드 수. */
  round: number;
  /** 계획된 라운드 상한(effectiveMax). 모르면 `undefined`. */
  plannedRounds?: number | undefined;
}

export interface FlexSignals {
  fail_signature_repeat?: number;
  base_reproduce?: number;
  review_repeat?: number;
  budget_burn?: number;
}

function failureKey(ids: readonly string[] | undefined): string | undefined {
  return ids?.length ? JSON.stringify([...new Set(ids)].sort()) : undefined;
}

/** 최신 라운드의 실패 id 집합이 그 이전 라운드들에서 «같은 집합»으로 나온 횟수. 최신 집합을 모르면 `undefined`. */
function failSignatureRepeat(rounds: FlexSignalsInput['gateFailedIdsByRound']): number | undefined {
  if (rounds.length === 0) return undefined;
  const latest = failureKey(rounds[rounds.length - 1]);
  if (latest === undefined) return undefined;
  return rounds.slice(0, -1).filter((ids) => failureKey(ids) === latest).length;
}

/** base 에서도 재현된(`preexisting`) 실패 수. 귀속이 비었거나 하나라도 `unknown` 이면 `undefined`. */
function baseReproduce(attributions: FlexSignalsInput['failureAttributions']): number | undefined {
  if (attributions === undefined || attributions.length === 0) return undefined;
  if (attributions.includes('unknown')) return undefined;
  return attributions.filter((attribution) => attribution === 'preexisting').length;
}

export function computeFlexSignals(input: FlexSignalsInput): FlexSignals {
  const repeat = failSignatureRepeat(input.gateFailedIdsByRound);
  const reproduce = baseReproduce(input.failureAttributions);
  const burn = input.plannedRounds !== undefined && input.plannedRounds > 0
    ? input.round / input.plannedRounds
    : undefined;
  return {
    ...(repeat === undefined ? {} : { fail_signature_repeat: repeat }),
    ...(reproduce === undefined ? {} : { base_reproduce: reproduce }),
    ...(input.reviewRepeat === undefined ? {} : { review_repeat: input.reviewRepeat }),
    ...(burn === undefined ? {} : { budget_burn: burn }),
  };
}
