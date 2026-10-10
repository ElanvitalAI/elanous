/** pid 생존 판정 — ⛔ 「EPERM = 죽음」이 아니다.
 *
 *  🩸 2026-09-20 전수: 이 저장소에 생존 판정이 «열다섯» 곳 있었고 그중 «열» 곳이
 *     `try { process.kill(pid, 0); return true } catch { return false }` 였다.
 *     그 `catch` 가 ***EPERM 을 「죽었다」로 접는다.***
 *
 *  ⭐ 그런데 옳은 판이 이미 있었다 — `src/cli/pwa-registry.ts` 의 주석이 그것을 말한다:
 *     *"EPERM = process exists but we lack permission to signal it … Treat EPERM as alive"*
 *     ⇒ 이 파일은 «새 규율»이 아니라 ***그 규율을 한 벌로 모은 것***이다.
 *
 *  ⛔ 왜 중요한가 — 「죽었다」로 접으면 그 위에서 «되돌릴 수 없는» 일이 난다:
 *     reaper 가 살아 있는 것을 수확하고, 락이 «산 주인»에게서 넘어간다.
 *
 *  ⚠️ 이 판정은 «같은 호스트»에서만 뜻이 있다 — pid 는 호스트 지역 값이다.
 *     락처럼 호스트가 섞이는 소비자는 호스트를 «먼저» 가른 뒤 이걸 부른다.
 */

/** ⛔ 두 값이 아니라 «셋»이다 — 「살아 있는데 내가 못 건드린다」는 별도의 사실이다.
 *  그것을 `alive` 나 `dead` 어느 쪽으로도 접지 않는 것이 이 타입의 존재 이유다. */
export type PidLiveness = 'alive' | 'dead' | 'alive-not-mine';

/** 관측 주입 — ⛔ 기본은 «껍데기»다. 소유자 조회 같은 비싼 일을 여기서 하지 않는다. */
export interface PidLivenessObserver {
  (event: { pid: number; liveness: PidLiveness; myUid: number | null; errno?: string }): void;
}

let observer: PidLivenessObserver | null = null;

/** 테스트·소비자가 관측을 갈아 끼운다. ⛔ null 로 되돌릴 수 있어야 한다(누수 방지). */
export function setPidLivenessObserver(fn: PidLivenessObserver | null): void {
  observer = fn;
}

function myUid(): number | null {
  // ⛔ win32 에는 getuid 가 «없다» — 있다고 가정하면 그 플랫폼에서 통째로 던진다.
  const g = (process as NodeJS.Process & { getuid?: () => number }).getuid;
  return typeof g === 'function' ? g.call(process) : null;
}

/** pid 의 생존을 «세 값»으로 판정한다. 신호를 보내지 않는다(0 은 탐침이다). */
export function pidLiveness(pid: number): PidLiveness {
  // ⛔ 음수·0·비정수는 «판정 대상이 아니다» — process.kill 에서 음수는 «프로세스 그룹»을 뜻해
  //   여기로 흘리면 탐침이 조용히 다른 일을 한다.
  if (!Number.isInteger(pid) || pid <= 0) return 'dead';
  let verdict: PidLiveness;
  let errno: string | undefined;
  try {
    process.kill(pid, 0);
    verdict = 'alive';
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : undefined;
    errno = code;
    // ESRCH = 그런 프로세스가 없다(죽었다).
    // EPERM = 프로세스는 «있고» 내가 신호를 못 보낸다 — 다른 uid 이거나 pid 1 이다.
    verdict = code === 'EPERM' ? 'alive-not-mine' : 'dead';
  }
  if (verdict === 'alive-not-mine') {
    // ⛔ 「살아 있는데 남의 것」은 조용히 지나가면 안 된다 — 🅢 요청(2026-09-20):
    //   원장에 «대상 pid 와 소유자 축»이 남아야 A 구간(남의 트리에서 도는 자식)과 닿는다.
    const { debug } = require('../debug/log.js') as { debug: { log: (category: string, event: string, data: Record<string, unknown>) => void } };
    debug.log('process.liveness', 'kill-refused', { pid, myUid: myUid(), errno });
    observer?.({ pid, liveness: verdict, myUid: myUid(), errno });
  }
  return verdict;
}

/** 「살아 있나」 — ⭐ `alive-not-mine` 은 «살아 있다».
 *  ⛔ 이 한 줄이 이 파일의 전부다. 종전 열 곳은 여기서 `false` 를 냈다. */
export function isPidAlive(pid: number): boolean {
  return pidLiveness(pid) !== 'dead';
}
