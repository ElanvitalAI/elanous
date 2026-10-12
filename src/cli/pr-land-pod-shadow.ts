/**
 * PRLAND-HEAVY-ON-POD-1 — `pr land` 무거운 판정을 Pod 에서 그림자 리허설한다.
 *
 * 착지 경로에 아직 잇지 않는다. `--heavy-on-pod-shadow` 플래그·실제 Pod 러너 바인딩은
 * 다음 조각(pr-cli.ts · pod-command-job.ts 무접촉). 이번 단위는 주입형 순수 함수만:
 * 켜지면 가짜/실 Pod 러너를 한 번 부르고 `pr.land`/`heavy-on-pod-shadow` 관측 한 줄을 남긴 뒤
 * 로컬 판정을 그대로 반환한다. 끄면 러너 0회. 러너가 던져도 경고 한 줄만 내고 로컬을 지킨다.
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
  }
  return local;
}
