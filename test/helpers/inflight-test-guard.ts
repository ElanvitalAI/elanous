// 시간초과 뒤 남은 시험 본문 격리 장치 (0.2.30 게이트 간섭 수리 · OP #9367)
//
// 무엇이 깨졌나: bun 은 5s 한도를 넘긴 시험의 약속을 «취소하지 않는다». 한도가 지나면 afterEach 가
// 곧바로 돌아 임시 폴더를 지우는데, 본문은 계속 돌다가 그 지워진 폴더로 `process.chdir` 해
// ENOENT 를 «시험 사이 처리 안 된 오류»로 던졌다(probe-context-cwd-* · 게이트 cut/pod-66).
// chdir 이 성공했다면 더 나빴다 — 프로세스 cwd 가 지워진 폴더에 남아 다음 파일들이 그 위에서 돈다.
//
// 같은 꼴의 앞 수리 = test/helpers/nexus-boot-guard.ts(#28514) — 무거운 import 는 beforeAll 로,
// 정리는 시험이 시작한 비동기를 «기다린 뒤». 이 파일은 그 둘째 장치를 «시험 본문» 단위로 일반화한다.
//
// 쓰는 법:
//   const guard = createInflightGuard();
//   afterEach(async () => { await guard.drain(); /* 그 다음에 임시 폴더 정리 */ }, INFLIGHT_DRAIN_TIMEOUT_MS);
//   test('…', guard.track(async () => { … }));

/** 남은 본문을 기다리는 afterEach 한도(hook 한도 · 시험 한도와 별개). */
export const INFLIGHT_DRAIN_TIMEOUT_MS = 60_000;

export interface InflightGuard {
  /** 시험 본문을 감싸 그 약속을 쥔다 — 시간초과로 시험이 끝나도 drain 이 본문 끝을 본다. */
  track<T>(body: () => Promise<T>): () => Promise<T>;
  /** afterEach(정리 «전»)에서 부른다. 실패는 삼킨다(그 시험이 이미 실패로 보고했다). */
  drain(): Promise<void>;
}

export function createInflightGuard(): InflightGuard {
  const pending = new Set<Promise<unknown>>();
  return {
    track<T>(body: () => Promise<T>) {
      return () => {
        const run = body();
        pending.add(run);
        void run.then(() => pending.delete(run), () => pending.delete(run));
        return run;
      };
    },
    async drain() {
      const runs = [...pending];
      await Promise.all(runs.map(run => run.catch(() => undefined)));
    },
  };
}
