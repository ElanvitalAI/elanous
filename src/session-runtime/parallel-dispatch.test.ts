// JUD #39447 HOLD(#122147) — Bash 병렬 탈착의 격리 계약 시험.
// CAPSULE-A2-BASH-DETACH r2: 도구급 supportsParallel=true 는 «옵트인»일 뿐 —
// 쓰기/의존 Bash 명령은 직렬로 남아야 하고, 섞인 묶음은 원본 순서를 보존해야 한다.
// 읽기 전용 명령만 병렬로 돈다(읽기 3 → 병렬).
import { describe, expect, test } from 'bun:test';
import { dispatchWithParallelSafety } from './parallel-dispatch.js';

describe('JUD #39447 HOLD(#122147) — Bash 배치 병렬 격리', () => {
  test('같은 파일 쓰기 두 Bash — 순서 보존(직렬, 병렬 아님)', async () => {
    const order: number[] = [];
    const calls = [
      { name: 'Bash', args: { command: 'printf first > /tmp/pd-order-same-file' } },
      { name: 'Bash', args: { command: 'printf second > /tmp/pd-order-same-file' } },
    ];
    const res = await dispatchWithParallelSafety(calls, async (_call, index) => {
      order.push(index);
    });
    // 섞인(안전하지 않은 호출이 있는) 묶음은 전부 직렬 — 병렬 판정은 거짓.
    expect(res.parallelActivated).toBe(false);
    // 원본 호출 순서 그대로 실행(나중 호출이 먼저 뛰어 파일을 덮어쓰는 일이 없다).
    expect(order).toEqual([0, 1]);
  });

  test('읽기 + 쓰기 섞인 묶음 — 읽기가 쓰기를 앞지치지 않는다', async () => {
    const order: number[] = [];
    const calls = [
      { name: 'Bash', args: { command: 'cat /tmp/pd-mix-read' } },
      { name: 'Bash', args: { command: 'rm -rf /tmp/pd-mix-write' } },
    ];
    const res = await dispatchWithParallelSafety(calls, async (_call, index) => {
      order.push(index);
    });
    expect(res.parallelActivated).toBe(false);
    expect(order).toEqual([0, 1]);
  });

  test('읽기 3 — 순수 안전 묶음은 병렬', async () => {
    let active = 0;
    let maxActive = 0; // 출처: #39447 읽기 3 병렬 묶음 계약(per-call isCallSafeForParallel) — 측정 최댓값 3은 안전 호출 3개가 한 묶음으로 도는 크기, 제품 상한 아님
    const calls = [1, 2, 3].map((i) => ({ name: 'Bash', args: { command: `cat /tmp/pd-read-${i}` } }));
    const res = await dispatchWithParallelSafety(calls, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
    });
    expect(res.parallelActivated).toBe(true);
    expect(maxActive).toBe(3);
  });
});