import { backoffMs, classifyError } from '../session-runtime/retry-policy.js';
import { OverloadFailoverError } from '../session-runtime/retry-api.js';

/** 스트림 중 끊김 재시도 상한 — codex `DEFAULT_STREAM_MAX_RETRIES`(5) 와 같은 값. */
export const STREAM_DISCONNECT_MAX_RETRIES = 5;
export class StreamIdleTimeoutError extends Error {
  constructor(readonly idleMs: number) {
    super(`stream idle timeout after ${idleMs}ms`);
    this.name = 'StreamIdleTimeoutError';
    Object.assign(this, { code: 'ETIMEDOUT' });
  }
}
export const STREAM_IDLE_TIMEOUT_MAX_RETRIES = 1;
export let streamDisconnectRetryDelayMs: (attempt: number) => number = backoffMs;

/** @internal 시험 seam — 재시도 대기(기본 `backoffMs`)를 바꾼다. `undefined` 면 원복. */
export function _setStreamDisconnectRetryDelayForTest(fn: ((attempt: number) => number) | undefined): void {
  streamDisconnectRetryDelayMs = fn ?? backoffMs;
}

/** 흐르던 스트림의 끊김을 같은 공급자로 다시 걸어도 되나.
 *  ⛔ 이 스트림에서 tool_call 을 받았거나 image 를 이미 내보냈으면 아니다 — 그 조각을 다시 보내면
 *  부작용·화면이 두 번 생길 수 있다(실행 전이라도 «추측해서» 버리지 않는다). */
export function isStreamDisconnectRetryable(err: unknown, pendingCallCount: number, emittedImage: boolean): boolean {
  if (pendingCallCount > 0 || emittedImage) return false;
  if (err instanceof OverloadFailoverError) return false;
  return classifyError(err) === 'network-transient';
}

export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

