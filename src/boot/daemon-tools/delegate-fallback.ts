/**
 * ELN-PERSISTENCE-LADDER ④ — 위임 실패 직접 1회 우회(§⑫ OP orders ELN-UNIVERSAL-AGENT-1124 · OP #144681).
 * 캡슐·하청(delegate) 실패를 {error} 문면 하나로 넘기지 않고, 같은 일을 직접 실행으로 정확히 1회 우회한 뒤
 * 위임 원본 결과와 직접 결과를 함께 보고한다. 우회는 지문(fingerprint) 단위로 1회만 시행 —
 * 같은 지문이 다시 실패하면 직접 우회를 재실행하지 않고 소진 사유를 붙인다(중복 부작용 방지).
 */
import { debug } from '../../debug/log.js';

/** 실패 판별探 — 결과가 실투면 사유 문면을, 아니면 null. */
export type FailureProbe<T> = (result: T) => string | null;

/** 우회 1회 표시기 — 지문별로 이미 우회했는지 표시한다. */
export interface DirectFallbackMarker {
  alreadyBypassed(fingerprint: string): boolean;
  markBypassed(fingerprint: string): void;
}

export function createDirectFallbackMarker(): DirectFallbackMarker {
  const seen = new Map<string, boolean>();
  return {
    alreadyBypassed: (fp) => seen.get(fp) === true,
    markBypassed: (fp) => { seen.set(fp, true); },
  };
}

export interface DirectFallbackReport<T> {
  /** 최종 결과 — 우회했으면 직접 실행 결과, 아니면 위임 결과. */
  result: T;
  /** 직접 우회가 이 호출에서 시행됐는가. */
  bypassed: boolean;
  bypassReason?: string;
  /** 위임 원본 결과(우회 시에만). */
  delegateResult?: T;
}

export interface DirectFallbackOptions<A> {
  /** 같은 일 판별 지문 — 기본 'delegate'(전체 단일 지문). */
  fingerprint?: (args: A) => string;
  marker?: DirectFallbackMarker;
  logCategory?: string;
}

/** 위임 도구 결과가 {error} 문면이면 실패 사유로, 아니면 null. */
export function delegateErrorProbe<T>(result: T): string | null {
  if (typeof result !== 'object' || result === null) return null;
  const error = (result as { error?: unknown }).error;
  return typeof error === 'string' && error ? `위임 실패: ${error}` : null;
}

/** SelfImplement 결과 네 꼴 중 failed(retryable≠false)만 실패 사유로 — launched/pending/observed-only 는 아니다. */
export function selfImplementFailureProbe<T>(result: T): string | null {
  if (typeof result !== 'object' || result === null) return null;
  const r = result as { kind?: unknown; retryable?: unknown; reason?: unknown };
  if (r.kind !== 'failed' || r.retryable === false) return null;
  return `SelfImplement 실패: ${String(r.reason ?? '사유 미관측')}`;
}

/** 프로세스 수명 기본 표시기 — marker 옵션 없으면 이 표시기로 1회 우회를 지킨다. */
const DEFAULT_MARKER: DirectFallbackMarker = createDirectFallbackMarker();

/** 위임 → 실패探 → (지문 미표시면) 직접 1회 우회 → 양쪽 보고. */
export async function withDirectFallback<A, T>(
  args: A,
  delegate: (args: A) => Promise<T> | T,
  runDirect: (args: A) => Promise<T> | T,
  isFailure: FailureProbe<T>,
  opts: DirectFallbackOptions<A> = {},
): Promise<DirectFallbackReport<T>> {
  const category = opts.logCategory ?? 'substrate.delegate-fallback';
  const fingerprint = opts.fingerprint?.(args) ?? 'delegate';
  const marker = opts.marker ?? DEFAULT_MARKER;
  const delegateResult = await delegate(args);
  const reason = isFailure(delegateResult);
  if (!reason) return { result: delegateResult, bypassed: false };
  if (marker.alreadyBypassed(fingerprint)) {
    debug.log(category, 'bypass-exhausted', { fingerprint, reason }, { level: 'warn' });
    return {
      result: delegateResult,
      bypassed: false,
      bypassReason: `${reason} · 직접 우회 1회 소진(중복 부작용 방지 — 재실행 없음)`,
      delegateResult,
    };
  }
  marker.markBypassed(fingerprint);
  const directResult = await runDirect(args);
  debug.log(category, 'direct-bypass', { fingerprint, reason }, { level: 'warn' });
  return { result: directResult, bypassed: true, bypassReason: reason, delegateResult };
}