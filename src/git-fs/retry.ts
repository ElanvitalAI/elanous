
const MAX_GIT_RETRY_ATTEMPTS = 6;

export type GitRunResult = {
  status: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

export type GitRunner = (args: string[]) => GitRunResult;

/** Lock contention and other Git failures that can clear without changing the command.
 *  ⚠️⛔ **문면이 넓다**(리뷰 지적) — `\block\b`·`index file`·`being used` 는 영구 오류에도 걸릴 수 있고,
 *  그러면 그 오류가 6회 재실행된다. ⭐ **그래도 좁히지 않는다**: 이 정규식은 `git-fs/worktree.ts` 의
 *  `git worktree add` 재시도가 2026-07-21부터 실전에서 쓰는 것과 **글자 그대로 같다**. 여기서만 좁히면
 *  같은 저장소의 두 재시도가 **다른 것을 일시적이라 부른다**. ⇒ 좁히려면 두 자리를 함께, 별도 골로.
 *  ⊕ 현재 경계는 아래 회귀가 고정한다(`lock` 이 든 영구 오류도 재시도된다는 사실 자체를 못 박는다).
 *  `worktree.ts`도 이 판정을 소비하므로 두 Git 재시도 경로가 같은 실패를 일시적으로 부른다. */
export function isTransientGitError(stderr: string): boolean {
  return /\block\b|\.lock|could not lock|cannot lock|unable to (create|write)|another git|resource temporarily|index file|being (created|used)/i.test(stderr);
}

/** Synchronous sleep for Git retry backoff.
 *  ⛔⭐ 외부 `sleep` 실행 파일에 의존하지 않는다(리뷰 should-fix) — 그 바이너리가 없거나 다르면
 *  **지연이 조용히 사라져** 재시도가 락을 그대로 다시 만난다. 런타임 안에서 기다린다. */
function sleepSyncMs(ms: number): void {
  if (ms <= 0) return;
  // ⭐ 비스핀 대기(리뷰 should-fix) — 스핀은 지속 실패 시 총 1.2초를 CPU 로 태운다.
  //   `Atomics.wait` 은 런타임 내부 primitive 라 외부 `sleep` 바이너리에도 의존하지 않는다.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function runGitWithRetry(
  args: string[],
  run: GitRunner,
  onRetrySuccess?: (attempt: number) => void,
): GitRunResult {
  let result!: GitRunResult;
  for (let attempt = 1; attempt <= MAX_GIT_RETRY_ATTEMPTS; attempt++) {
    result = run(args);
    if (result.status === 0) {
      if (attempt > 1) onRetrySuccess?.(attempt);
      return result;
    }
    const error = result.stderr || result.stdout || '';
    if (!isTransientGitError(error) || attempt === MAX_GIT_RETRY_ATTEMPTS) return result;
    sleepSyncMs(80 * attempt);
  }
  return result;
}
