// ELS-VOICE-CONTROL-POPUP popup literals: type → Enter → preview line → Enter runs (door once) · a close waits for y ·
// Esc cancels with nothing run · a refused plan closes with its reason.
import { expect, test } from 'bun:test';
import { planByRules, type VoiceDoor, type VoiceStep } from './voice-control.js';
import { createVoicePopup } from './voice-popup.js';

function rig() {
  const calls: VoiceStep[] = [];
  const door: VoiceDoor = { run: async (step) => { calls.push(step); return { ok: true, message: 'ok' }; } };
  let paints = 0;
  const popup = createVoicePopup({ plan: async (text) => planByRules(text), door, changed: () => { paints++; } });
  return { popup, calls, paints: () => paints };
}

test('type → Enter → the preview line → Enter runs it through the door once, then the popup closes with the outcome', async () => {
  const r = rig();
  r.popup.open();
  await r.popup.feed('새 셸 열어줘');
  expect(r.popup.line()).toBe(' : 새 셸 열어줘▏ · Enter 계획 · Esc 취소 ');
  await r.popup.feed('\r');
  expect(r.popup.line()).toBe(' → 새 셸 열기 · Enter 실행 · Esc 취소 ');
  await r.popup.feed('\r');
  expect(r.calls).toEqual([{ op: 'pane.new', args: {} }]);
  expect([r.popup.isOpen(), r.popup.lastMessage()]).toEqual([false, '완료: 새 셸 열기']);
});

test('a close waits for y: Enter does nothing to the pane, y runs it; any other key cancels', async () => {
  const r = rig();
  r.popup.open();
  await r.popup.feed('t2 탭 삭제해줘\r');
  expect(r.popup.line()).toBe(' ⚠ → 탭 t2 닫기 · y 로 확인 · 다른 키 취소 ');
  await r.popup.feed('\r');
  expect([r.calls, r.popup.isOpen(), r.popup.lastMessage()]).toEqual([[], false, '취소 (y 가 아님)']);
  r.popup.open();
  await r.popup.feed('t2 탭 삭제해줘\r');
  await r.popup.feed('y');
  expect(r.calls).toEqual([{ op: 'tab.close', args: { tab: 't2' } }]);
});

test('Esc while typing cancels with nothing run; a request that is not understood closes with the reason; backspace edits', async () => {
  const r = rig();
  r.popup.open();
  await r.popup.feed('새 셸x\u007f');
  expect(r.popup.line()).toBe(' : 새 셸▏ · Enter 계획 · Esc 취소 ');
  await r.popup.feed('\u001b');
  expect([r.calls, r.popup.isOpen(), r.popup.lastMessage()]).toEqual([[], false, '취소']);
  r.popup.open();
  await r.popup.feed('오늘 날씨 어때\r');
  expect([r.calls, r.popup.isOpen(), r.popup.lastMessage()]).toEqual([[], false, '알아듣지 못함: 오늘 날씨 어때']);
});
