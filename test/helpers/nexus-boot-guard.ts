// nexus 부팅 시험 격리 장치 (0.2.30 게이트 간섭 수리 · OP #9292)
//
// 무엇이 깨졌나: `runNexus({ detachForTesting: true })` 를 처음 부르는 시험이 nexus 모듈을
// 동적 import 하면서 차가운 게이트 Pod 에서 5s 시험 한도를 넘었다. bun 은 시간초과된 시험의
// 약속을 «취소하지 않는다» — 그 runNexus 는 계속 돌다가, 그 사이 afterEach/beforeEach 가 바꿔
// 놓은 `ELANOUS_NEXUS_DIR`(= 다음 시험의 임시 폴더)에서 잠금을 잡으려 해 다음 시험이 쥔 잠금과
// 부딪쳤다(`TelegramLockError … lockPath=/tmp/elanous-nexus-n2-*/.lock` · pid = 시험 프로세스 자신).
//
// 장치 둘:
//   ① `warmNexusModule()` — 무거운 import 를 beforeAll(한도 넉넉히)로 빼 시험 5s 예산 밖에서 데운다.
//   ② `bootNexus()` + `drainNexusBoots()` — 부팅 약속을 쥐고, afterEach 가 env 를 되돌리기 «전»에
//      끝까지 기다려 잠금을 놓는다. 시간초과로 끝난 시험이 남긴 부팅도 «자기 폴더 안에서» 끝난다.

import type { RunNexusOptions } from '../../src/nexus/index.js';

type RunNexus = typeof import('../../src/nexus/index.js').runNexus;
type Handle = NonNullable<Awaited<ReturnType<RunNexus>>>;

/** 차가운 Pod 에서 nexus 모듈 그래프 import 가 걸리는 시간의 상한(시험 한도와 별개 · hook 한도). */
export const NEXUS_WARM_TIMEOUT_MS = 120_000;
/** 남은 부팅을 기다리는 afterEach 한도 — 부팅 하나는 데워진 뒤 수 ms 다. */
export const NEXUS_DRAIN_TIMEOUT_MS = 60_000;

let runNexusFn: RunNexus | undefined;
const pending = new Set<Promise<Handle | undefined>>();

export async function warmNexusModule(): Promise<void> {
  if (runNexusFn) return;
  ({ runNexus: runNexusFn } = await import('../../src/nexus/index.js'));
}

/** `runNexus` 를 부르되 약속을 쥐어 둔다. 돌려받은 핸들의 `release` 는 한 번만 돈다. */
export function bootNexus(opts: RunNexusOptions): Promise<Handle | undefined> {
  // 약속은 «동기로» 쥔다 — 첫 await 앞에서 시험이 끊겨도 drain 이 이 부팅을 본다.
  const boot = warmNexusModule().then(() => runNexusFn!(opts)).then((handle) => {
    if (!handle) return handle;
    let released = false;
    const release = handle.release;
    handle.release = () => {
      if (released) return;
      released = true;
      release();
    };
    return handle;
  });
  pending.add(boot);
  return boot;
}

/** afterEach(env 복원 «전»)에서 부른다 — 남은 부팅을 끝까지 기다려 잠금을 놓는다. 실패는 삼킨다
 *  (그 시험이 이미 실패로 보고했다). */
export async function drainNexusBoots(): Promise<void> {
  const boots = [...pending];
  pending.clear();
  await Promise.all(boots.map(async (boot) => {
    try { (await boot)?.release(); } catch { /* 시험 쪽에서 이미 드러났다 */ }
  }));
}
