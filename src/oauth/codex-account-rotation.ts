// ⛔⭐⭐⭐ **리밋에 걸리면 다른 계정으로 넘긴다** (`S4` · 대표 결정 2026-08-05).
//
// 왜 이것이 있나: 계정을 이름으로 가르고(`#7135`) 신호를 계정별로 만든(`#7143`) 다음 칸이다.
//   주간 창이 찬 계정으로 계속 쏘면 런이 「구현 결손」으로 죽는다(그 어휘는 `#7123` 이 냈다).
//
// ⛔⭐⭐ **결정 다섯** (대표):
//   ① 계정 «전환»만 자동이다 — 리셋 크레딧의 실제 소비는 이 판정 밖의 기존 경로가 맡는다.
//   ② 기본 ON. config `llm.codexAccountRotation: false` 로 끈다.
//   ③ 사람이 «명시»한 계정은 전환하지 않는다 — 의도가 이긴다.
//   ④ 현재 사용률을 모르면 안전한 기본 계정에 고정하지 않는다 — 쓸 후보가 있으면 넘긴다.
//   ⑤ 쓸 수 있는 다른 계정이 먼저다. 현재 계정의 사용 가능한 리셋 크레딧은 후보가 없을 때만 머무는 사유이며, 조회 불가는 «없음»이 아니라 별도 사유로 남기고 기존처럼 전환한다.
//
// ⭐ 이 파일의 판정은 «순수»다. 스토어·신호·설정을 «인자»로 받아서, 테스트가 실물 없이 전수로 문다.
//   (전역을 읽는 순간 「무엇을 보고 정했나」가 안 보이게 된다 — 이 트랙이 오늘 네 번 밟은 형태다.)

import { debug } from '../debug/log.js';
import type { CodexAccountResolution } from './codex-account.js';

/** 회전이 고를 수 있는 후보 하나. ⛔ 홈을 모르는 계정은 «후보가 아니다». */
export interface RotationCandidate {
  readonly name: string;
  readonly storeKey: string;
  readonly home: string;
  /** 그 계정의 쿼터 신호. `true`=찼다 · `undefined`=모른다. ⛔ `false` 는 없다. */
  readonly reached: boolean | undefined;
  /** 브랜드 총량 사용률. 신호가 없거나 옛 형식이면 undefined다. */
  readonly usedPercent?: number;
}

/** ⛔ 비공개 — 밖에서 이름으로 부를 소비처가 없다(리뷰 must-fix: dead export 금지). */
type RotationReason =
  /** 사람이 계정을 명시했다 — 의도가 이긴다. */
  | 'explicit'
  /** config 로 꺼져 있다. */
  | 'disabled'
  /** 지금 계정이 「찼다」가 아니다(안 찼거나 «모른다»). */
  | 'not-reached'
  /** 찬 현재 계정에 쓸 수 있는 리셋 크레딧이 있다 — 실제 소비는 이 판정 밖이다. */
  | 'reset-credit-available'
  /** 찬 현재 계정의 리셋 크레딧 관측을 읽지 못했다 — 없음으로 접지 않고 기존처럼 회전한다. */
  | 'reset-credit-unknown'
  /** 찼는데 갈 곳이 없다 — 홈을 아는 다른 계정이 없거나 그들도 찼다. */
  | 'no-candidate'
  /** 넘겼다. */
  | 'rotated';

/** ⛔ 비공개 — 위와 같다. 반환 형태는 구조로 쓰인다. */
interface RotationDecision {
  readonly reason: RotationReason;
  /** `disabled`일 때만 설정 판독이 남긴 근거다. */
  readonly disabledProvenance?: CodexAccountRotationConfigState;
  /** 판정 시점에 받은 원본 후보 수. 후보를 만들기 전 조기 관측이면 없다. */
  readonly candidateCount?: number;
  /** 실제 판정에 적용한 계정별 임계와 그 출처. */
  readonly accountThresholds?: readonly {
    readonly name: string;
    readonly thresholdPercent: number;
    readonly source: 'account-override' | 'account-default' | 'global';
    readonly status: 'reached' | 'threshold-reached' | 'below-threshold' | 'unknown';
    readonly usedPercent: number | undefined;
  }[];
  /** 넘겼을 때만 있다. */
  readonly to?: RotationCandidate;
}

/** ⛔ 비공개 — 호출자는 객체 리터럴로 준다(구조적 타이핑). */
type ResetCreditAvailability = 'available' | 'unavailable' | 'unknown';

interface RotationInput {
  /** 지금 해석된 계정(회전 «전»). */
  readonly current: CodexAccountResolution;
  /** 사람이 `ELANOUS_CODEX_ACCOUNT` 로 «명시»했나. */
  readonly explicit: boolean;
  /** config 가 회전을 허용하나. 기본 ON 이므로 «명시적 false 일 때만» 꺼진다. */
  readonly enabled: boolean;
  /** disabled 판정이면 설정 판독이 남긴 근거다. */
  readonly disabledProvenance?: CodexAccountRotationConfigState;
  /** 지금 계정의 쿼터 신호. */
  readonly currentReached: boolean | undefined;
  /** 지금 계정의 브랜드 총량 사용률. */
  readonly currentUsedPercent?: number;
  /** 현재 계정의 리셋 크레딧 관측. `unknown`은 조회 실패·불완전 값을 뜻하며 `unavailable`이 아니다. */
  readonly resetCreditAvailability: ResetCreditAvailability;
  /** 회전을 시작·후보를 제외하는 전역 임계. 유효하지 않으면 기본 95를 쓴다. */
  readonly thresholdPercent?: unknown;
  /** 계정별 임계 오버라이드. 유효하지 않은 값은 계정 기본값 또는 전역 임계로 되돌린다. */
  readonly thresholdPercentByAccount?: Readonly<Record<string, unknown>>;
  /** 지금 계정을 «뺀» 후보들. */
  readonly candidates: readonly RotationCandidate[];
  /** «먼저 쓸» 계정 순서(설정 `llm.codexAccountOrder`). 없으면 이름 코드포인트 순.
   *  ⛔ 여기 없는 계정은 버리지 않는다 — 뒤로 가서 이름순으로 붙는다. */
  readonly accountOrder?: readonly string[];
}

/**
 * ⭐ 회전 판정 — 순수 함수. 「무엇을 보고 정했나」가 인자에 다 있다.
 *
 * ⛔ 후보 선택은 «결정론»이다(이름 오름차순). 무작위면 같은 상황에서 다른 답이 나와
 *   「왜 이 계정인가」를 사후에 못 재구성한다.
 */
const DEFAULT_ROTATION_THRESHOLD_PERCENT = 95;

// 대표 "첫 번째 계정의 경우 멀티 계정이 있을 때 50% 이상은 소모하지 않도록 해 주세요. 외부에서 코딩 용도가 아니라 다른 용도로도 많이 사용하고 있습니다."
// 공유 default 계정에 여유를 남기기 위한 기본 임계 60%; 명시적 계정별 설정이 우선한다.
export const DEFAULT_ROTATION_THRESHOLD_PERCENT_BY_ACCOUNT = { default: 60 } as const;

/** ⛔⭐⭐ 표면이 «판정기가 실제로 쓴» 임계를 보여야 한다(리뷰 must-fix) — raw config 를 그대로
 *  찍으면 `0`·`101`·`NaN` 같은 값에서 ***판정은 95 를 쓰는데 화면은 다른 수를 말한다.***
 *  이 축이 고쳐 온 「판정층이 피판정층과 다른 자를 쓴다」의 또 한 판본이다. ⇒ 같은 함수를 쓴다. */
export function normalizedRotationThresholdPercent(value: unknown): number {
  return codexAccountRotationThresholdPercent(value);
}

function codexAccountRotationThresholdPercent(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 100
    ? value
    : DEFAULT_ROTATION_THRESHOLD_PERCENT;
}

/** ⭐ 계정별 임계 덮어쓰기. ⛔ 2026-09-23 에 «열었다» — 핀 탈출구가 같은 자를 써야 하기 때문이다
 *  (store 가 자기 임계 계산을 «다시 지으면» 판정과 핀이 서로 다른 자를 쓴다). */
export function codexAccountRotationThresholdOverridePercent(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 1 && value <= 100
    ? value
    : fallback;
}

/** 명시적 계정별 임계 → 계정 기본 임계 → 정규화된 전역 임계. 판정과 핀에서 같은 자를 쓴다. */
export function codexAccountThresholdPercent(
  accountName: string,
  { thresholdPercent, thresholdPercentByAccount }: {
    readonly thresholdPercent?: unknown;
    readonly thresholdPercentByAccount?: Readonly<Record<string, unknown>>;
  },
): number {
  const globalThreshold = normalizedRotationThresholdPercent(thresholdPercent);
  // 대표 «default 는 60% 까지만» = 상한이다 — 전역을 더 엄하게(예 42) 주면 그것을 따른다(min). 계정별 명시가 이긴다.
  const accountDefault = Object.prototype.hasOwnProperty.call(DEFAULT_ROTATION_THRESHOLD_PERCENT_BY_ACCOUNT, accountName)
    ? Math.min(DEFAULT_ROTATION_THRESHOLD_PERCENT_BY_ACCOUNT[accountName as keyof typeof DEFAULT_ROTATION_THRESHOLD_PERCENT_BY_ACCOUNT], globalThreshold)
    : globalThreshold;
  return codexAccountRotationThresholdOverridePercent(thresholdPercentByAccount?.[accountName], accountDefault);
}

function accountThreshold(
  name: string,
  input: Pick<RotationInput, 'thresholdPercent' | 'thresholdPercentByAccount'>,
): { thresholdPercent: number; source: 'account-override' | 'account-default' | 'global' } {
  const thresholdPercent = codexAccountThresholdPercent(name, input);
  const override = input.thresholdPercentByAccount?.[name];
  const hasDefault = Object.prototype.hasOwnProperty.call(DEFAULT_ROTATION_THRESHOLD_PERCENT_BY_ACCOUNT, name);
  return {
    thresholdPercent,
    source: thresholdPercent === override ? 'account-override' : hasDefault ? 'account-default' : 'global',
  };
}

export function decideCodexRotation(input: RotationInput): RotationDecision {
  const candidateCount = input.candidates.length;
  const otherCandidates = input.candidates.filter((candidate) => candidate.name !== input.current.name);
  const accounts = [
    { name: input.current.name, reached: input.currentReached, usedPercent: input.currentUsedPercent },
    ...otherCandidates,
  ];
  const accountThresholds = accounts.map((account) => {
    const threshold = accountThreshold(account.name, input);
    const usedPercent = account.usedPercent;
    const status = account.reached === true ? 'reached'
      : typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) ? 'unknown'
      : usedPercent >= threshold.thresholdPercent ? 'threshold-reached' : 'below-threshold';
    return { name: account.name, ...threshold, usedPercent, status } as const;
  });
  if (input.explicit) return { reason: 'explicit', candidateCount, accountThresholds };
  if (!input.enabled) return { reason: 'disabled', candidateCount, accountThresholds, ...(input.disabledProvenance ? { disabledProvenance: input.disabledProvenance } : {}) };
  const currentUsageUnknown = input.currentReached === undefined && input.currentUsedPercent == null;
  if (input.currentReached !== true && !currentUsageUnknown && accountThresholds[0]?.status !== 'threshold-reached') {
    return { reason: 'not-reached', candidateCount, accountThresholds };
  }
  const resetCreditUnknown = input.resetCreditAvailability === 'unknown';
  const candidateStatuses = otherCandidates
    .map((candidate, index) => ({ candidate, status: accountThresholds[index + 1]?.status }));

    // ⛔⭐ 순서는 ***설정이 이기고, 없으면 이름 코드포인트***다.
    //   🩸 2026-09-24(대표 지시): 「third 부터 소진하고 그다음 team」 — 이름순(default<new<third)으로는
    //     그 순서를 못 만든다. ⇒ `llm.codexAccountOrder` 로 «먼저 쓸 순서»를 값으로 준다.
    //   ⛔ 목록에 «없는» 계정은 버리지 않는다 — 뒤로 가서 이름순으로 붙는다.
    //   ⛔ 이 줄은 «고르는 기준»만 바꾼다 — 임계·도달 판정은 그대로다.
    const order = input.accountOrder ?? [];
    const rank = (name: string): number => {
      const i = order.indexOf(name);
      return i >= 0 ? i : order.length;
    };
  const usable = candidateStatuses
    .filter(({ candidate, status }) => candidate.home.length > 0
      && status !== 'reached' && status !== 'threshold-reached')
    .map(({ candidate }) => candidate)
    .sort((a, b) => {
      const ra = rank(a.name); const rb = rank(b.name);
      if (ra !== rb) return ra - rb;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;   // ⛔ 코드포인트 비교 — localeCompare 는 ICU/로케일에 따라 답이 갈린다
    });
  const to = usable[0];
  if (!to) {
    if (input.resetCreditAvailability === 'available') return { reason: 'reset-credit-available', candidateCount, accountThresholds };
    return { reason: 'no-candidate', candidateCount, accountThresholds };
  }
  if (resetCreditUnknown) return { reason: 'reset-credit-unknown', candidateCount, accountThresholds, to };
  return { reason: 'rotated', candidateCount, accountThresholds, to };
}

/**
 * ⛔⭐⭐⭐⭐⭐ **회전한 계정을 «자식 env»로 내려보낼 덧칠** (2026-08-07 · 크레딧 유출 차단).
 *
 * 왜 이것이 있나 — 경로가 «둘»인데 회전이 «하나»에만 닿고 있었다(RFC §8 ⑴ 이 그 둘을 갈라 놨다):
 * ```
 * 경로 A · API provider   loadTokens('openai-codex…') → Bearer   ⇒ 회전이 «닿는다»
 * 경로 B · codex 바이너리  $CODEX_HOME/auth.json 을 읽는다        ⇒ 회전이 «안 닿았다»
 * ```
 * ⇒ 🚨 리밋에 걸린 계정으로 ACP 자식이 «계속» 쐈고, 그 계정에 크레딧이 남아 있으면
 *   플랜이 아니라 ***유료 크레딧이 소모된다***(2026-08-07 실측: default 주간 100% ⊕ 잔액 4974).
 *
 * ⭐ 실제 회전이면 선택한 `to`, 회전하지 않으면 유지한 `from`의 홈을 낸다. 어느 경우든
 *   계정 해석이 이미 확정됐는데 빈 객체를 내면 ACP가 부모의 기본 계정으로 되돌아간다.
 * ⛔ 홈을 «모르면» 아무것도 안 낸다 — 모르는 곳으로 자식을 보내지 않는다(회전 후보 규칙과 같다).
 * ⭐ 이 함수는 «순수»다. 디스크를 타는 조립은 `codex-account-store.ts` 가 한다.
 */
export function rotatedChildEnv(
  _source: CodexAccountResolution['source'],
  home: string | undefined,
): Record<string, string> {
  const trimmed = home?.trim();
  return trimmed ? { CODEX_HOME: trimmed } : {};
}

/** 판정을 «값으로» 남긴다. ⛔ 토큰·홈 전체 경로는 안 남긴다(이름과 사유만). */
export function observeRotation(decision: RotationDecision, from: string): void {
  debug.log('oauth.codex-account', 'rotation', {
    from,
    to: decision.to?.name,
    reason: decision.reason,
    candidateCount: decision.candidateCount ?? 'unknown',
    ...(decision.reason === 'disabled' && decision.disabledProvenance
      ? { disabledProvenance: decision.disabledProvenance }
      : {}),
  }, { level: decision.reason === 'rotated' || decision.reason === 'reset-credit-unknown' ? 'warn' : 'debug' });
  for (const account of decision.accountThresholds ?? []) {
    debug.log('oauth.codex-account', 'rotation-account-threshold', account);
  }
}

/** 회전 결과를 계정 해석으로 접는다. ⛔ 안 넘겼으면 «그대로» 돌려준다. */
export function applyRotation(
  current: CodexAccountResolution,
  decision: RotationDecision,
): CodexAccountResolution {
  if ((decision.reason !== 'rotated' && decision.reason !== 'reset-credit-unknown') || !decision.to) return current;
  return {
    name: decision.to.name,
    storeKey: decision.to.storeKey,
    home: decision.to.home,
    // ⭐ 출처는 「env」가 아니다 — 사람이 고른 게 아니라 «시스템이 넘긴» 것이다.
    //   그 구분이 없으면 `account list` 가 「사람이 골랐다」고 거짓을 말한다.
    source: 'rotated' as CodexAccountResolution['source'],
  };
}

// ⛔ `DEFAULT_CODEX_ACCOUNT` 재수출은 «소비처가 없었다» — dead export 는 만들지 않는다(리뷰 must-fix).
//   필요한 곳은 `./codex-account.js` 에서 직접 가져온다.

/**
 * ⭐ config → 「회전을 켜나」. **기본 ON** 이고 «명시적 `false` 일 때만» 꺼진다(대표 결정 ②).
 * ⛔ 설정 읽기가 «실패해도» 조회를 막지 않는다 — 못 읽으면 기본값(ON)이다.
 *   ⚠️ 그 fail-soft 가 없으면 설정 파일 하나가 깨졌을 때 LLM 경로 전체가 멈춘다.
 * ⭐ 읽는 자를 «인자»로 받는다 — 그래야 이 계약을 실물 설정 없이 문다(리뷰 should-fix).
 */
export type CodexAccountRotationConfigState = 'explicit-false' | 'enabled' | 'missing' | 'access-failed';

export interface CodexAccountRotationConfig {
  readonly enabled: boolean;
  readonly state: CodexAccountRotationConfigState;
}

/** Reads the setting without collapsing its provenance; callers retain the fail-soft ON policy. */
export function readCodexAccountRotationConfig(
  readConfig: () => { llm?: { codexAccountRotation?: boolean } },
): CodexAccountRotationConfig {
  try {
    const value = readConfig().llm?.codexAccountRotation;
    if (value === false) return { enabled: false, state: 'explicit-false' };
    return { enabled: true, state: value === undefined ? 'missing' : 'enabled' };
  } catch {
    return { enabled: true, state: 'access-failed' };
  }
}

export function codexAccountRotationEnabled(
  readConfig: () => { llm?: { codexAccountRotation?: boolean } },
): boolean {
  return readCodexAccountRotationConfig(readConfig).enabled;
}
