/**
 * ⛔ 시험 안의 «실물 발사» 거부 — 2026-10-16 사고(R7 · OP #8751) 의 구조 방어.
 *
 * 무엇이 있었나: 호스트 재게이트가 시험을 운영 HOME 그대로 돌렸고, seam 이 빠진 시험 둘이 `defaultTaskLauncher` 의
 * 원격 부모 경로(`tryRemoteParent`)로 진짜 ssh 를 쏴 원격 prod 런 25 · draft PR 11 을 만들었다.
 * 격리 env(재게이트 러너)와 시험 seam 은 «잊음»을 줄일 뿐 «다음 시험이 seam 을 빠뜨리는 것»은 못 막는다 — 그래서
 * 발사 지점이 bun test 안에서는 명시 허용 없이 실물 발사를 «거부»한다(fail-closed · 큰소리).
 *
 * - 시험 밖(제품 경로): 아무 영향 없다 — `isUnderTestRunner()` 가 거짓이면 즉시 돌아간다.
 * - 시험 안: 주입(가짜 ssh·spawn)을 쓰면 이 가드에 닿지 않는다. 실물이 정말 필요한 시험만
 *   `ELANOUS_TEST_ALLOW_REAL_LAUNCH=1` 로 명시 허용한다.
 */
import { debug } from '../debug/log.js';
import { isUnderTestRunner } from '../oauth/store.js';

export const ALLOW_REAL_LAUNCH_UNDER_TEST_ENV = 'ELANOUS_TEST_ALLOW_REAL_LAUNCH';

export type RealLaunchKind = 'remote-parent-ssh' | 'local-harness-spawn';

export class RealLaunchRefusedUnderTestError extends Error {
  constructor(readonly kind: RealLaunchKind, detail: string) {
    super(`⛔ 시험 안에서 실물 발사를 거부했다(${kind}${detail ? ` · ${detail}` : ''}) — `
      + (kind === 'remote-parent-ssh'
        ? 'deps.parentHost: null(원격 끔) 또는 deps.ssh 가짜를 주입하라'
        : 'deps.spawn 가짜(또는 handToTaskAgent:\'off\' · taskLauncher 가짜)를 주입하라')
      + ` · 실물이 정말 필요하면 ${ALLOW_REAL_LAUNCH_UNDER_TEST_ENV}=1 (2026-10-16 시험 누수 사고 R7)`);
    this.name = 'RealLaunchRefusedUnderTestError';
  }
}

/** bun test 안이고 명시 허용이 없으면 던진다. 시험 밖에서는 아무것도 하지 않는다. */
export function refuseRealLaunchUnderTest(kind: RealLaunchKind, detail = '', env: NodeJS.ProcessEnv = process.env): void {
  if (!isUnderTestRunner(env)) return;
  if (env[ALLOW_REAL_LAUNCH_UNDER_TEST_ENV]?.trim() === '1') return;
  try { debug.log('task-agent', 'real-launch-refused-under-test', { kind, detail }); } catch { /* fail-soft */ }
  throw new RealLaunchRefusedUnderTestError(kind, detail);
}
