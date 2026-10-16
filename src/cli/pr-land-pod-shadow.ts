/**
 * PRLAND-HEAVY-ON-POD-1 — `pr land` 무거운 판정을 Pod 에서 그림자 리허설한다.
 *
 * `pr-cli.ts`의 `--heavy-remote --heavy-on-pod-shadow` 선택 경로가 호출한다.
 * 비교기는 주입형 함수이며 Pod Job 바인딩은 `pr-land-pod-shadow-job.ts`에 둔다.
 * 켜지면 가짜/실 Pod 러너를 한 번 부르고 `pr.land`/`heavy-on-pod-shadow` 관측 한 줄을 남긴 뒤
 * 로컬 판정을 그대로 반환한다. 끄면 러너 0회. 러너가 던지면 미측정 관측과 경고를 남기고 로컬을 지킨다.
 */

export interface HeavyOnPodShadowInput<T> {
  enabled: boolean;
  pr: number;
  head: string;
  local: T;
  runPod: () => T | Promise<T>;
  log: (category: string, event: string, data: Record<string, unknown>) => void;
  warn: (message: string) => void;
}

function agree(local: unknown, pod: unknown): boolean {
  if (local && pod && typeof local === 'object' && typeof pod === 'object'
    && 'measured' in local && 'measured' in pod) {
    const a = local as { measured: unknown; ok?: unknown; rootPlan?: unknown };
    const b = pod as { measured: unknown; ok?: unknown; rootPlan?: unknown };
    return a.measured === true && b.measured === true && a.ok === b.ok
      && JSON.stringify(a.rootPlan ?? null) === JSON.stringify(b.rootPlan ?? null);
  }
  if (Object.is(local, pod)) return true;
  try {
    return JSON.stringify(local) === JSON.stringify(pod);
  } catch {
    return false;
  }
}

function elapsedMs(started: number): number {
  return Math.max(0, performance.now() - started);
}

export async function runHeavyOnPodShadow<T>(input: HeavyOnPodShadowInput<T>): Promise<T> {
  const { enabled, pr, head, local, runPod, log, warn } = input;
  if (!enabled) return local;

  const localMs = 0;
  const started = performance.now();
  try {
    const pod = await runPod();
    log('pr.land', 'heavy-on-pod-shadow', {
      pr,
      head,
      local,
      pod,
      agree: agree(local, pod),
      podMs: elapsedMs(started),
      localMs,
    });
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
    log('pr.land', 'heavy-on-pod-shadow', {
      pr, head, local,
      pod: { measured: false, ok: false, reason: `pod-exception:${error instanceof Error ? error.name : 'unknown'}` },
      agree: false,
      podMs: elapsedMs(started), localMs,
    });
  }
  return local;
}
