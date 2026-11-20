// [PWA-INTAKE-N1-N5A-N6A] self-review r3 mustFix 3 — DaemonHealthController 계약 시험.
//
// r3 리뷰 원문(~/.elanous/review-results/pr-38952-669f5cc1d880.json)의 세 mustFix:
//   1) URL 변경 시 이전 true 가 새 health 검사 동안 유지 + 토큰만 변경하면 재검사 없음
//   2) daemonAvailable 초기화를 useEffect 까지 미뤄 설정 변경 «첫 렌더»에 이전 true 잔존
//   3) 15초 주기 탐침 겹침 — 먼저 시작한 탐침의 늦은 성공이 나중 탐침의 실패를 덮음
//
// 순수 모듈이라 React 렌더 없이 bun test 로 돌린다(RED→GREEN 원문은
// seat-state/MOB-1/evidence/pwa-intake-r3-1120/).

import { describe, expect, test } from 'bun:test';

import { DaemonHealthController } from './daemon-health';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** /v1/health 호출을 잡아 두는 가짜 클라이언트 — 응답 시점을 시험이 정한다. */
function fakeHealth() {
  const calls: Array<Deferred<{ ok: boolean }>> = [];
  return {
    calls,
    client: {
      health: () => {
        const d = deferred<{ ok: boolean }>();
        calls.push(d);
        return d.promise;
      },
    },
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('DaemonHealthController — r3 mustFix 3', () => {
  test('mustFix1+2: 설정 변경 순간 동기 false — 진행 중 탐침의 늦은 성공도 폐기한다', async () => {
    const seen: boolean[] = [];
    const { client, calls } = fakeHealth();
    const c = new DaemonHealthController(client, (a) => seen.push(a));

    c.probe(); // 이전 설정 기준 탐침 — 미결로 둔다
    expect(calls.length).toBe(1);

    c.invalidateSync(); // 설정 변경 핸들러에서 호출되는 «그 순간»
    expect(seen).toEqual([false]); // 동기 — 아무 await 없이 즉시 false (mustFix 2)

    calls[0].resolve({ ok: true }); // 예전 설정 탐침이 늦게 성공해도…
    await tick();
    expect(seen).toEqual([false]); // …이전 true 로 되돌리지 않는다 (mustFix 1)

    c.probe(); // 새 설정으로 재탐침(토큰만 바뀐 경우도 같은 길)
    calls[1].resolve({ ok: true });
    await tick();
    expect(seen).toEqual([false, true]); // 회복은 «새 탐침 결과»로만
  });

  test('mustFix3: 겹친 탐침 — 먼저 시작한 탐침의 늦은 성공이 나중 탐침의 실패를 덮지 않는다', async () => {
    const seen: boolean[] = [];
    const { client, calls } = fakeHealth();
    const c = new DaemonHealthController(client, (a) => seen.push(a));

    c.probe(); // 탐침 A (세대 1) — 미결
    c.probe(); // 탐침 B (세대 2) — 15s 주기가 겹친 상황
    calls[1].reject(new Error('daemon down')); // 나중 탐침 B 실패 → false
    await tick();
    expect(seen).toEqual([false]);

    calls[0].resolve({ ok: true }); // 먼저 시작한 A가 «늦게» 성공 → 폐기
    await tick();
    expect(seen).toEqual([false]); // 부재 판정이 유지 — 제출 버튼이 다시 켜지지 않는다
  });

  test('정상 경로: 탐침 성공·실패는 그대로 보고한다', async () => {
    const seen: boolean[] = [];
    const { client, calls } = fakeHealth();
    const c = new DaemonHealthController(client, (a) => seen.push(a));

    c.probe();
    calls[0].resolve({ ok: true });
    await tick();
    c.probe();
    calls[1].reject(new Error('offline'));
    await tick();
    expect(seen).toEqual([true, false]);
  });
});
