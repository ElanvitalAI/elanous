// ELS-VOICE-CONTROL-POPUP literals (OP #101856): fake model answer → plan · a close without y runs nothing · an op outside
// the allow list is refused · running a plan calls the door once per step · no model → the rules read common phrasings.
import { expect, test } from 'bun:test';
import { planByRules, planVoice, runVoicePlan, type VoiceDoor, type VoiceStep } from './voice-control.js';

const context = { workspaces: ['OP', 'MK'], tabs: ['t1', 't2'], current: 'OP' };
const recordingDoor = () => {
  const calls: VoiceStep[] = [];
  const door: VoiceDoor = { run: async (step) => { calls.push(step); return { ok: true, message: 'ok' }; } };
  return { calls, door };
};

test('a fake model answer becomes a plan with a one-line preview; Enter runs it through the door once', async () => {
  const plan = await planVoice('OP 워크스페이스에 탭 research 추가해줘', {
    context, llm: async () => '```json\n{"steps":[{"op":"tab.new","args":{"workspace":"OP","title":"research"}}]}\n```',
  });
  expect(plan).toEqual({ ok: true, steps: [{ op: 'tab.new', args: { workspace: 'OP', title: 'research' } }], preview: '→ 워크스페이스 OP 에 탭 research 추가', confirm: false });
  const { calls, door } = recordingDoor();
  expect(await runVoicePlan(plan, door, false)).toEqual({ ran: 1, message: '완료: 워크스페이스 OP 에 탭 research 추가' });
  expect(calls).toEqual([{ op: 'tab.new', args: { workspace: 'OP', title: 'research' } }]);
});

test('a close needs ⚠ and an explicit y: Enter alone runs nothing; y runs it', async () => {
  const plan = await planVoice('t2 탭 삭제해줘', { context, llm: async () => '{"steps":[{"op":"tab.close","args":{"tab":"t2"}}]}' });
  expect(plan).toMatchObject({ ok: true, preview: '⚠ → 탭 t2 닫기 · y 로 확인', confirm: true });
  const { calls, door } = recordingDoor();
  expect(await runVoicePlan(plan, door, false)).toEqual({ ran: 0, message: '닫기는 y 로 확인해야 실행 — 아무것도 안 함' });
  expect(calls).toEqual([]);
  expect((await runVoicePlan(plan, door, true)).ran).toBe(1);
  expect(calls).toEqual([{ op: 'tab.close', args: { tab: 't2' } }]);
});

test('an op outside the allow list refuses the whole plan (nothing partial), even next to an allowed one', async () => {
  const plan = await planVoice('다 지우고 셸 명령 돌려', { context, llm: async () => '{"steps":[{"op":"tab.new","args":{"title":"x"}},{"op":"pane.exec","args":{"text":"rm -rf /"}}]}' });
  expect(plan).toEqual({ ok: false, reason: '알아듣지 못함: 허용 밖 동작 pane.exec' });
  const { calls, door } = recordingDoor();
  expect(await runVoicePlan(plan, door, true)).toEqual({ ran: 0, message: '알아듣지 못함: 허용 밖 동작 pane.exec' });
  expect(calls).toEqual([]);
});

test('no model (or an answer that is not a plan) → the rules read the common phrasings; anything else is not understood', async () => {
  expect(await planVoice('OP 워크스페이스에 탭 research 추가해줘', { context })).toMatchObject({ ok: true, preview: '→ 워크스페이스 OP 에 탭 research 추가' });
  expect(await planVoice('t2 탭 삭제해줘', { context, llm: async () => 'sure! I will do that' })).toMatchObject({ ok: true, preview: '⚠ → 탭 t2 닫기 · y 로 확인' });
  expect(planByRules('MK 공간으로 옮겨줘')).toMatchObject({ ok: true, preview: '→ 지금 탭 을 MK 공간으로 옮기기' });
  expect(planByRules('새 셸 열어줘')).toMatchObject({ ok: true, preview: '→ 새 셸 열기' });
  expect(planByRules('오늘 날씨 어때')).toEqual({ ok: false, reason: '알아듣지 못함: 오늘 날씨 어때' });
});

test('a new tab the model gave no title reads «새 탭», not «탭 ?» (11-19 layer 3)', async () => {
  const plan = await planVoice('새 셸 열어줘', { context, llm: async () => '{"steps":[{"op":"tab.new","args":{"workspace":"els-u4"}}]}' });
  expect(plan).toMatchObject({ ok: true, preview: '→ 워크스페이스 els-u4 에 새 탭 추가' });
});
