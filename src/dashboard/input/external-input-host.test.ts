import { describe, expect, test } from 'bun:test';
import { createDashboardExternalInputHost, stopTurnViaEscGate } from './external-input-host.js';
import { simEscGate } from '../../ux-sim/interaction.js';

describe('createDashboardExternalInputHost', () => {
  test('composer 가 안 떠 있으면(getBufferText 없음) 제출을 거부한다', () => {
    const calls: unknown[] = [];
    const host = createDashboardExternalInputHost({
      isTurnActive: () => false,
      promptCtl: { submit: (r) => { calls.push(r); } },
      pushNotice: () => {},
    });
    expect(host.composerText()).toBeUndefined();
    expect(host.submit('x', { kind: 'terminal', provider: 'pty' })).toBe(false);
    expect(calls).toEqual([]);
  });

  test('composer 가 떠 있으면 출처를 실어 제출 · 표지를 남긴다', () => {
    const calls: unknown[] = [];
    const notices: string[] = [];
    const host = createDashboardExternalInputHost({
      isTurnActive: () => true,
      promptCtl: { submit: (r) => { calls.push(r); }, getBufferText: () => '치던 중' },
      pushNotice: (l) => notices.push(l),
    });
    expect(host.isTurnActive()).toBe(true);
    expect(host.composerText()).toBe('치던 중');
    expect(host.submit('wake', { kind: 'terminal', provider: 'pty' })).toBe(true);
    expect(calls).toEqual([{ text: 'wake', source: { kind: 'terminal', provider: 'pty' } }]);
    // 합성 Enter 가 못 들어가면 실패로 알려 대기열이 항목을 지키게 한다.
    const refused = createDashboardExternalInputHost({
      isTurnActive: () => false,
      promptCtl: { submit: () => false, getBufferText: () => '' },
      pushNotice: () => {},
    });
    expect(refused.submit('wake', { kind: 'terminal', provider: 'pty' })).toBe(false);
    const keyed = createDashboardExternalInputHost({
      isTurnActive: () => false, promptCtl: { getBufferText: () => '' }, pushNotice: () => {}, pendingKeyCount: () => 1,
    });
    expect(keyed.hasPendingKeys()).toBe(true);
    expect(refused.hasPendingKeys()).toBe(false);
    host.onQueueChange?.([{ text: 'wake', at: 0 }], 'queued');
    host.onQueueChange?.([], 'delivered');
    expect(notices).toEqual([
      '⤵ 외부 입력 1건 대기 · "wake" · 턴이 끝나고 입력창이 비면 별도 메시지로 전송',
      '⤵ 외부 입력 1건 전송',
    ]);
  });
});

describe('외부 /stop → escGate (TUI-STOP-INPUT-BYPASS)', () => {
  test('requestStop 은 지금 턴의 중단을 한 번 부르고, 턴 밖(null)이면 false · 표지 문면', () => {
    let stops = 0;
    let current: (() => void) | null = () => { stops += 1; };
    const notices: string[] = [];
    const host = createDashboardExternalInputHost({
      isTurnActive: () => true, promptCtl: { getBufferText: () => '' }, pushNotice: (l) => notices.push(l),
      getTurnStop: () => current,
    });
    expect(host.requestStop?.()).toBe(true);
    expect(stops).toBe(1);
    current = null;
    expect(host.requestStop?.()).toBe(false);
    expect(stops).toBe(1);
    host.onExternalStop?.('stopped');
    host.onExternalStop?.('no-turn');
    expect(notices[0]).toContain('대기열을 건너뛰고');
    expect(notices[1]).toContain('도는 턴이 없어 무시');
  });

  test('자식 0 — 실제 escGate 한 번으로 턴이 멎는다(simEscGate)', () => {
    const sim = simEscGate();
    stopTurnViaEscGate(sim.gate);
    expect(sim.abortCtrl.signal.aborted).toBe(true);
    expect(sim.mounted.length).toBe(0);
  });

  test('자식이 돌면 확인 모달을 «의지의 반복»으로 확정해 멎는다', async () => {
    const sim = simEscGate({ runningChildren: 2 });
    stopTurnViaEscGate(sim.gate);
    await sim.settle();
    expect(sim.abortCtrl.signal.aborted).toBe(true);
    expect(sim.handoffCalls).toBe(1);
    expect(sim.isOpen()).toBe(false);
  });

  test('사용자 Esc 로 이미 모달이 떠 있으면 한 번이 확정이다', async () => {
    const sim = simEscGate({ runningChildren: 1 });
    sim.esc();
    expect(sim.isOpen()).toBe(true);
    stopTurnViaEscGate(sim.gate);
    await sim.settle();
    expect(sim.abortCtrl.signal.aborted).toBe(true);
    expect(sim.handoffCalls).toBe(1);
  });
});
