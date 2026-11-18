// TA-PREFLIGHT 조건② — Pod 가 «실제 소비한» 이미지 digest 를 요청 pin 과 대조한다.
// pin = 명시 옵션(imageDigestPin) 또는 이미지 ref 의 `@sha256:<64hex>`. 관측은 readJobPodImage(imageID→digest).
const DIGEST = /^sha256:[0-9a-f]{64}$/;
/** 이미지 digest pin 전체 일치 — 길이 71(`sha256:` 7 + 64) 검사를 정규식과 같이 둔다: 줄바꿈·공백·탭이 끝이나 앞에 붙은 입력은 어떤 정규식 해석(`$` 가 끝 줄바꿈 앞에서 맞는 엔진 포함)에서도 통과하지 못한다. 세 입구(hand·say·orchestrate)가 이 함수 하나를 쓴다. */
export function isImageDigestPin(value: unknown): value is string {
  return typeof value === 'string' && value.length === 71 && DIGEST.test(value);
}

export type PodImageDigestVerdict =
  | { verdict: 'no-pin'; pinned: null; observed: string | null }
  | { verdict: 'match'; pinned: string; observed: string }
  | { verdict: 'mismatch'; pinned: string; observed: string }
  | { verdict: 'unobserved'; pinned: string; observed: null; reason: string };

/** 요청 pin 추출 — 명시 값이 형식 불량이면 pin 없음으로 넘기지 않고 던진다(조용한 통과 금지). */
export function requestedImageDigest(imageRef: string, explicit?: string | null): string | null {
  if (explicit !== undefined && explicit !== null) {
    // 명시 pin 은 가공하지 않는다 — 앞뒤 공백·줄바꿈·대문자는 형식 불량(trim·소문자화로 조용히 통과시키지 않음).
    if (!isImageDigestPin(explicit)) throw new Error(`image digest pin 형식 불량: ${JSON.stringify(explicit)} (sha256:<소문자 64hex> 전체 일치)`);
    return explicit;
  }
  return /@(sha256:[0-9a-f]{64})$/iu.exec(imageRef.trim())?.[1]?.toLowerCase() ?? null;
}

export function verifyPodImageDigest(pinned: string | null, observed: { digest: string | null; digestUnavailable: string | null }): PodImageDigestVerdict {
  if (!pinned) return { verdict: 'no-pin', pinned: null, observed: observed.digest };
  if (!observed.digest) return { verdict: 'unobserved', pinned, observed: null, reason: observed.digestUnavailable ?? 'digest-missing' };
  return observed.digest === pinned ? { verdict: 'match', pinned, observed: observed.digest } : { verdict: 'mismatch', pinned, observed: observed.digest };
}

/** 정상 종료(complete)·비중단일 때만 실패 사유를 낸다(abort·재시도·OOM 은 기존 처리 우선 — 소스 대조와 같은 규칙). */
export function podImageDigestGate(v: PodImageDigestVerdict, run: { state: 'complete' | 'failed' | 'aborted'; aborted: boolean }): string | null {
  if (run.state !== 'complete' || run.aborted) return null;
  if (v.verdict === 'mismatch') return `이미지 digest 불일치 — 요청 ${v.pinned.slice(0, 19)} ≠ Pod 소비 ${v.observed.slice(0, 19)}`;
  if (v.verdict === 'unobserved') return `이미지 digest 미관측 — 요청 ${v.pinned.slice(0, 19)} · 사유 ${v.reason}`;
  return null;
}
