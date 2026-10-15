/**
 * K3S-SECRET-DB-LOCK-RETRY — kubectl 호출이 «일시 오류»로 거부되면 지수 백오프로 다시 친다.
 *
 * 근거: node-b k3d(k3s · sqlite 저장소)가 Pod Secret 생성 때
 *   `Error from server: error when creating "STDIN": rpc error: code = Unknown desc = database is locked`
 * 로 거부했다(10-15 02:11 KST 전후 4건 · TC #4186). sqlite 쓰기 잠금 경합이라 잠시 뒤 같은 apply 는 선다.
 *
 * ⛔ 판정 문구는 «실측 근거가 있는 것»만 둔다 — 짐작으로 늘리면 진짜 거부(권한·스키마)를 백오프 동안 삼킨다.
 * 재시도 소진 시에만 호출부의 기존 실패 경로로 마지막 결과를 그대로 돌려준다.
 */
import { debug } from '../../debug/log.js';

export type KubectlCallResult = { status: number | null; stdout: string; stderr: string };

/** 실측된 일시 오류 문구(stderr 만 · 부분 일치 · 대소문자 무시 — stdout 은 apply 결과라 판정에 안 쓴다). */
export const KUBECTL_TRANSIENT_PATTERNS: readonly RegExp[] = [/database is locked/i];

/** 재시도 사이 대기(ms) — 길이가 곧 재시도 상한(4회 · 합 7.5s). */
export const KUBECTL_TRANSIENT_BACKOFF_MS: readonly number[] = [500, 1_000, 2_000, 4_000];

export function kubectlTransientReason(result: KubectlCallResult): string | null {
  if (result.status === 0) return null;
  const hit = KUBECTL_TRANSIENT_PATTERNS.find((pattern) => pattern.test(result.stderr));
  return hit ? hit.source : null;
}

/**
 * 첫 결과 `first` 가 일시 오류일 때만 부른다(성공 경로에 await 를 더하지 않으려고 — 호출부의 마이크로태스크 순서를 지킨다).
 * 다시 친 결과가 성공이거나 일시 오류가 아니면 즉시 돌려주고, 백오프를 다 써도 일시 오류면 마지막 결과를 돌려준다.
 */
export async function retryKubectlTransient(
  run: () => KubectlCallResult,
  first: KubectlCallResult,
  opts: { sleep: (ms: number) => Promise<void>; category: string; data?: Record<string, unknown>; backoffMs?: readonly number[] },
): Promise<KubectlCallResult> {
  const backoff = opts.backoffMs ?? KUBECTL_TRANSIENT_BACKOFF_MS;
  let last = first;
  let reason = kubectlTransientReason(last);
  for (let i = 0; i < backoff.length && reason; i++) {
    debug.log(opts.category, 'retry', { ...opts.data, attempt: i + 1, maxAttempts: backoff.length, delayMs: backoff[i], reason });
    await opts.sleep(backoff[i]!);
    last = run();
    reason = kubectlTransientReason(last);
    if (last.status === 0) {
      debug.log(opts.category, 'retry-recovered', { ...opts.data, attempt: i + 1 });
      return last;
    }
  }
  if (reason) debug.log(opts.category, 'retry-exhausted', { ...opts.data, attempts: backoff.length, reason, stderr: last.stderr.trim().slice(0, 300) }, { level: 'warn' });
  return last;
}
