import { expect, test } from 'bun:test';
import {
  FAULT_NEXTMOVE_DISPATCH_COMMAND,
  renderFaultNextmoveDispatch,
  simFaultNextmoveDispatch,
} from './fault-nextmove-dispatch.js';

// NEXTMOVE-HARDEN — 같은 PR 수리 한 바퀴(임시 git 원격 ⊕ 가짜 gh)를 생산 runRepairCycle·
// repairNextMove·applyRepairBundle 로 돌려 next-move→dispatch graph-edge-taken 1건과
// push 확인 지연 → unconfirmed 1건을 낸다. 실물 spawn·실물 git 이 있어 한도를 명시한다(K-OP-035).
test('fault-nextmove-dispatch produces exactly one next-move→dispatch edge and one unconfirmed transition', async () => {
  const observation = await simFaultNextmoveDispatch();
  // ① next-move→dispatch graph-edge-taken — 정확히 1건, 그래프가 고른 간선을 그대로 탔다.
  expect(observation.edge.count).toBe(1);
  expect(observation.edge.record).toMatchObject({
    graphId: 'self-implement', from: 'next-move', label: 'narrow-relaunch',
    to: 'dispatch', source: 'graph', taken: 'dispatch', honored: true,
  });
  expect(observation.edge.decision).toBe('repair-requested');
  // ② push 확인 지연 → unconfirmed — exact-head push 는 성공(원격 머리 = 수리 commit)하고
  //    PR 머리 확인은 가짜 gh 의 늙은 머리를 못 따라잡아 그대로 unconfirmed 로 멈춘다.
  expect(observation.unconfirmed.decision).toBe('repair-pending');
  expect(observation.unconfirmed.status).toBe('unconfirmed');
  expect(observation.unconfirmed.reason).toContain('push succeeded; PR head confirmation pending');
  // push 는 실제로 됐다 — 임시 원격의 PR 가지 머리가 수리 commit 이다(확인만 늦다).
  expect(observation.remoteHead).toBe(observation.repairCommit);
  // 확인 지연 루프는 생산 CONFIRM_DELAYS_MS 를 끝까지 돌고서야 unconfirmed 를 냈다(0 은 sleep 없이 지나간다).
  expect(observation.confirmSleeps).toEqual([150, 350, 700]);
  // 가짜 gh PATH 심이 생산 CAS 경로에서 실제로 불렸다.
  expect(observation.ghCalls).toBeGreaterThan(0);
  // 영수증 = 명령 ⊕ injectionId ⊕ 결과.
  expect(observation.receipt.command).toBe(FAULT_NEXTMOVE_DISPATCH_COMMAND);
  expect(observation.receipt.injectionId).toMatch(/^fnd-[0-9a-f]{12}$/);
  expect(observation.receipt.result).toBe('graph-edge-taken(next-move→dispatch)=1 · unconfirmed=1');
  // 완료 경계 실물 — 장치 시험 출력 원문(층 L2).
  console.log(renderFaultNextmoveDispatch(observation).join('\n'));
}, 120_000);
