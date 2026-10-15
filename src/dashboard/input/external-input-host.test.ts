import { describe, expect, test } from 'bun:test';
import { createDashboardExternalInputHost } from './external-input-host.js';

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
