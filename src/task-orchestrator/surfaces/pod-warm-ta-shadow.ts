/**
 * warm Pod 재사용 — 'ta' 소비자의 «그림자 비교» 순수 모듈 (PLAN-warm-reuse-tonight-2026-10-15 §5 · pod-warm-switch.ts 의 'ta' 몫).
 *
 * 관측: 이 모듈은 아무것도 관측하지 않는다 — 완료된 si-task Job outcome 과 lease-fenced warm candidate 를
 *       «받은 값만으로» 비교한다(자체 I/O · 부수효과 없음).
 * 판단: 후보 키는 원문이 준 두 성분 — same source SHA / child model. lease 펜스(pod-lease.ts 세대 펜스,
 *       WarmReuseEvidence.leaseValid 와 같은 칸)가 유효하지 않으면 키가 같아도 기각한다(fail-closed).
 * 수복: match=false 면 호출자는 기존 fresh Job 경로를 그대로 탄다 — reason 이 «무엇이 모자랐나»를 넘긴다.
 *
 * ⛔ 이 모듈은 비교만 한다. 소비자 결선(self-implement-pod 연결)은 형제 샤드 몫이다(정의-결선 분리 경계).
 * ⛔ 못 잰 값(undefined · 빈 값)은 «일치»가 아니라 «기각» 이다 — pod-warm-switch.ts 의
 *    'unmeasured = off' 규율과 원값 그대로의 정확 비교(앞뒤 공백 등 형식 어긋남은 고쳐 읽지 않는다)를 그대로 잇는다.
 */

/**
 * UNRESOLVED — 원문 요청 문면이 `(keyed by same source SHA / child model /` 에서 끊겼다.
 * child model 뒤에 추가 키 성분이 더 있는지, 그리고 그 뒤에 이어지던 비교 요구가 무엇이었는지 이 문서에서 확정할 수 없다.
 * 이 모듈은 확정된 두 키(same source SHA / child model)만 비교한다 — 나머지는 의도적으로 미정(unspecified)이며 지어내지 않는다.
 * 추가 성분은 원문 회수 시 그 표현 그대로만 붙인다.
 */
export const TA_SHADOW_UNRESOLVED_NOTE: string =
  "UNRESOLVED: original ask truncated after '(keyed by same source SHA / child model /' — " +
  'confirmed keys are source SHA and child model; any further key components or comparison ' +
  'requirements are intentionally unspecified, not invented.';

/** 완료된 si-task Job outcome — 비교에 쓰는 키 성분만 담는다(원문 확정: same source SHA / child model). */
export interface SiTaskJobOutcome {
  /** 이 outcome 을 낸 원본 소스의 SHA — 후보 키 성분 ①. */
  sourceSha: string;
  /** 이 outcome 을 낸 자식 모델(self-implement-pod.ts `childModel` 과 같은 문자열 칸) — 후보 키 성분 ②. */
  childModel: string;
}

/**
 * lease-fenced warm candidate — pod-lease.ts 세대 펜스가 붙은 warm 재사용 후보.
 * `leaseValid` 는 pod-warm-switch.ts `WarmReuseEvidence.leaseValid` 와 같은 칸:
 * `true` = 현재 generation 유효 · `false` = 펜스 기각 · `undefined` = 못 잰(off).
 */
export interface LeaseFencedWarmCandidate {
  sourceSha: string;
  childModel: string;
  leaseValid?: boolean;
}

/** 비교 결과 — 첫 번째로 걸린 이유를 그대로 넘긴다(«lease-fence rejection passthrough» 포함). */
export interface TaShadowComparison {
  match: boolean;
  reason:
    | 'match'
    | 'lease-unmeasured'
    | 'lease-invalid'
    | 'source-sha-unmeasured'
    | 'source-sha-malformed'
    | 'source-sha-mismatch'
    | 'child-model-unmeasured'
    | 'child-model-malformed'
    | 'child-model-mismatch';
}

/** 원값 그대로의 정확 비교 — 못 잼(unmeasured) · 형식 어긋남(malformed) · 불일치(mismatch) 를 갈라 뱉는다. */
function exactString(
  field: 'source-sha' | 'child-model',
  outcome: string,
  candidate: string,
): TaShadowComparison['reason'] | null {
  if (typeof outcome !== 'string' || !outcome || typeof candidate !== 'string' || !candidate) return `${field}-unmeasured`;
  if (outcome !== outcome.trim() || candidate !== candidate.trim()) return `${field}-malformed`;
  if (outcome !== candidate) return `${field}-mismatch`;
  return null;
}

/**
 * 완료된 si-task Job outcome 과 lease-fenced warm candidate 가 «같은 키» 인지 — 순수 비교.
 * 순서: lease 펜스 먼저(펜스가 기각이면 키가 같아도 기각이 우선한다) → source SHA → child model.
 */
export function compareWarmTaShadow(outcome: SiTaskJobOutcome, candidate: LeaseFencedWarmCandidate): TaShadowComparison {
  if (candidate.leaseValid !== true) {
    return { match: false, reason: candidate.leaseValid === false ? 'lease-invalid' : 'lease-unmeasured' };
  }
  const sha = exactString('source-sha', outcome.sourceSha, candidate.sourceSha);
  if (sha !== null) return { match: false, reason: sha };
  const model = exactString('child-model', outcome.childModel, candidate.childModel);
  if (model !== null) return { match: false, reason: model };
  return { match: true, reason: 'match' };
}
