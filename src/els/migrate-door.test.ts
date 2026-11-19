// 마이그레이션 문 리터럴 시험 — stop+migrate 계약, mode 누락 거부, local 액션 거부, 발송 우회 0.
import { describe, expect, test } from 'bun:test';
import { TAB_MENU_ACTIONS, type TabMenuActionSpec } from './tab-badge.js';
import { runTabMenuDoorAction, tabMenuDoorRequest, type DoorRequest } from './migrate-door.js';

const spec = (action: string): TabMenuActionSpec => {
  const found = TAB_MENU_ACTIONS.find(a => a.action === action);
  if (!found) throw new Error(`tab menu spec 없음: ${action}`);
  return found;
};

describe('tabMenuDoorRequest', () => {
  test('migrate 스펙 → stop + mode=migrate 문 요청', () => {
    expect(tabMenuDoorRequest(spec('migrate'), 'els-mcp-w1')).toEqual({
      ok: true,
      request: { action: 'stop', mode: 'migrate', target: { workspace: 'els-mcp-w1', pane: 'seat:els-mcp-w1' } },
    });
  });
  test('stop 스펙 → stop + mode=quit 문 요청', () => {
    expect(tabMenuDoorRequest(spec('stop'), 'els-mcp-w1')).toEqual({
      ok: true,
      request: { action: 'stop', mode: 'quit', target: { workspace: 'els-mcp-w1', pane: 'seat:els-mcp-w1' } },
    });
  });
  test('doorOp stop 에 mode 누락 → 거부(문 default-deny 미러)', () => {
    const r = tabMenuDoorRequest({ action: 'stop', via: 'door', doorOp: 'stop' }, 'w');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refuse).toContain('mode');
  });
  test('local(attach) 스펙 → 문 요청 거부 — 문 경유가 아닌 액션은 문 요청을 만들지 않는다', () => {
    expect(tabMenuDoorRequest(spec('attach'), 'w').ok).toBe(false);
  });
});

describe('runTabMenuDoorAction', () => {
  test('deps.send 로 문 요청 그대로 발송 · 응답 반환', async () => {
    const sent: DoorRequest[] = [];
    const result = await runTabMenuDoorAction(spec('migrate'), 'w9', {
      send: async (req) => { sent.push(req); return 'els stop: ok (mode=migrate)'; },
    });
    expect(sent).toEqual([{ action: 'stop', mode: 'migrate', target: { workspace: 'w9', pane: 'seat:w9' } }]);
    expect(result).toBe('els stop: ok (mode=migrate)');
  });
  test('거부 시 발송 0 · 예외로 사유', async () => {
    let sent = 0;
    try {
      await runTabMenuDoorAction({ action: 'stop', via: 'door', doorOp: 'stop' }, 'w', {
        send: async () => { sent += 1; return 'x'; },
      });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain('mode');
    }
    expect(sent).toBe(0);
  });
});
