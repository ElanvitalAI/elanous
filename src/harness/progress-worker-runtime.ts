import { isMainThread } from 'node:worker_threads';

/**
 * HARNESS-PROGRESS-HANG — `harness progress` 하위 조회는 «전용 워커 엔트리»(`./progress-worker-entry.ts`)
 * 를 직접 적재한다. 그 엔트리는 CLI 디스패치를 거치지 않으므로 번들·컴파일 산출물에서도 `parentPort`
 * 핸들러가 워커 스레드에 오른다. 이 판정은 배포 엔트리(`bin/elanous.mjs`)가 워커 문맥에서 재진입됐을 때
 * 대시보드·provider 선택·명령 디스패치를 다시 걸지 않게 가드한다.
 */
export function shouldRunCliEntry(): boolean {
  return isMainThread;
}
