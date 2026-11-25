// ELS-SIDEBAR-STATUS-VISIBLE (OP #134199 · 정정 #134203/#134208/#134220/#134227 · 15:00 P0) — 리터럴 회귀:
// 상태 마크 = 색 이모지 세트(🟢🟡⚪🔴⏸ · done ✅), 조율자 ⭐(🎼 아님), agoText 영어,
// 스페이스 줄에는 동작 상태 없음, 아래 칸 «agents grouped» 2단 행·상태순 정렬.
import { expect, test } from 'bun:test';
import { agoText, childSummary, STATUS } from './status-vocab.js';
import { layoutSpaceList, type SpaceTabRow } from './space-tabs-view.js';
import { wordOfState } from './attach-view.js';

const plain = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

test('status marks are the OP icon set: working green, blocked yellow, idle sleep, failed red, stalled pause, done check', () => {
  expect(STATUS.working.mark).toBe('🟢');
  expect(STATUS.blocked.mark).toBe('🟡');
  expect(STATUS.idle.mark).toBe('⚪');
  expect(STATUS.failed.mark).toBe('🔴');
  expect(STATUS.stalled.mark).toBe('⏸');
  expect(STATUS.done.mark).toBe('✅');
  expect(wordOfState('stalled')).toBe('stalled');
});

test('agoText reads in English (OP #134199 ③) and childSummary uses the icon marks', () => {
  expect(agoText(5_000)).toBe('5s ago');
  expect(agoText(120_000)).toBe('2m ago');
  expect(agoText(7_200_000)).toBe('2h ago');
  expect(agoText(0)).toBe('0s ago');
  expect(childSummary(['working', 'working', 'failed'])).toBe('⎇3 🟢2 🔴1');
});

const row = (ws: string, pane: string, title: string, state: string, extra: Partial<SpaceTabRow> = {}): SpaceTabRow =>
  ({ workspace: `name-${ws}`, wsId: ws, pane, title, state, ...extra });

test('sidebar: space lines carry no status mark, the coordinator is ⭐, and the agents panel below sorts working before blocked', () => {
  const rows = [row('w1', 'p1', 'build', 'working'), row('w1', 'p2', 'old', 'idle'), row('w2', 'p3', 'review', 'blocked', { role: 'coordinator' })];
  const lines = layoutSpaceList(rows, 'p1', 28, 20).lines.map(plain);
  const spaceLine = lines.find((line) => line.includes('NAME-W1'));
  expect(spaceLine).toBeDefined();
  expect(spaceLine!.trim()).not.toContain('●');
  expect(spaceLine!.trim()).not.toContain('🟢');          // 스페이스 줄에는 동작 상태가 없다(OP #134203)
  expect(lines.find((line) => line.includes('NAME-W2'))!.trim()).toContain('⭐');   // 조율자 표식 = ⭐(OP #134199 ①)
  const agentsHead = lines.findIndex((line) => /^(○ All|◉ Active)/.test(line.trim()));
  expect(agentsHead).toBeGreaterThan(0);
  expect(lines[agentsHead]!).toContain('grouped');        // 머리 «○ All · n … grouped»(OP #134223 · ELS-ACTIVE-ONLY-FILTER)
  const workingAt = lines.findIndex((line, at) => at > agentsHead && line.includes('🟢'));
  const idleAt = lines.findIndex((line, at) => at > agentsHead && line.includes('⚪'));
  expect(workingAt).toBeGreaterThan(-1);
  expect(idleAt).toBeGreaterThan(workingAt);               // 같은 스페이스 안: 일하는 것 → 쉬는 것(OP #134199 ②)
  expect(lines.findIndex((line, at) => at > agentsHead && line.includes('🟡'))).toBeGreaterThan(-1);
  expect(lines[workingAt - 1]!.trim()).toBe('▾ NAME-W1 · 2'); // ELS-PANE-LABEL-MODEL-FIRST: a «▾ SPACE · n» head per space
});

test('focused space expands to «N agents · branch» and no space shows more than two lines', () => {
  const rows = [row('w1', 'p1', 'build', 'working'), row('w1', 'p2', 'old', 'idle')];
  const lines = layoutSpaceList(rows, 'p1', 28, 20).lines.map(plain);
  expect(lines.find((line) => line.includes('2 agents'))).toBeDefined();   // 포커스된 스페이스만 2줄(OP #134227)
  const unfocused = layoutSpaceList(rows, 'p2', 28, 20).lines.map(plain);  // p2를 골라도 같은 스페이스가 펼쳐진다
  expect(unfocused.find((line) => line.includes('2 agents'))).toBeDefined();
});
