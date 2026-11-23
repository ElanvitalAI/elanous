// ELS-AGENTS-HIDE-SHELL (OP 11-23 screenshot): the OP space's agents panel showed «OP · eln · OP» and «OP ✅ · shell · OP» —
// the second an old tab whose eln exited and left a plain prompt. The agents panel lists agent panes only; a seat whose
// only pane is a bare shell gets one «⏹ SEAT exited» row. 시험 우주: `els ls` 답 리터럴 → 실제 파서 → 실제 레이아웃.
// Expectations are typed out (OP rule 11), never built from the product's tables.
import { expect, test } from 'bun:test';
import { parsePaneRows } from './attach-view.js';
import { layoutSpaceList, withCommands } from './space-tabs-view.js';

const plain = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
const agentsSection = (lines: readonly string[]): string[] => {
  const all = lines.map((line) => plain(line).trimEnd());
  const head = all.findIndex((line) => line.startsWith(' agents'));
  return head < 0 ? [] : all.slice(head + 1).filter((line) => line !== '' && line !== ' new · menu');
};
const draw = (ls: object): string[] => {
  const json = JSON.stringify(ls);
  return agentsSection(layoutSpaceList(withCommands(parsePaneRows(json), json), undefined, 32, 24).lines);
};
const pane = (id: string, extra: Record<string, unknown>) => ({ address: `w1/t-${id}/${id}`, workspace: 'op', tab: `t-${id}`, pane: id, title: 'OP', state: 'idle', activityState: 'idle', ...extra });

test('seat OP with a live eln pane and a dead-eln shell pane: exactly one row, the eln one', () => {
  expect(draw({ panes: [
    pane('p1', { seat: 'OP', kind: 'eln', command: ['eln'], fgCommand: ['eln'] }),
    pane('p2', { seat: 'OP', kind: 'shell', command: ['eln'] }),
  ] })).toEqual([
    ' ⚪ OP',
    '       eln · op',
  ]);
});

test('seat whose only pane is an exited shell: one «⏹ OP exited» row, even with two dead tabs', () => {
  expect(draw({ panes: [
    pane('p2', { seat: 'OP', kind: 'shell', command: ['eln'] }),
    pane('p3', { seat: 'OP', state: 'exited', activityState: 'exited', command: ['eln'] }),
  ] })).toEqual([
    ' ⏹ OP exited',
    '       shell · op',
  ]);
});

test('a shell-only pane with no seat: no agents row at all (it stays in the tab bar)', () => {
  const json = JSON.stringify({ panes: [pane('p4', { title: 'zsh', command: ['/bin/zsh'] })] });
  const rows = withCommands(parsePaneRows(json), json);
  expect(rows.map((row) => row.pane)).toEqual(['p4']);
  expect(agentsSection(layoutSpaceList(rows, undefined, 32, 24).lines)).toEqual([]);
});

test('a seat that lives in another space keeps only its live row; another seat\'s agent is untouched', () => {
  expect(draw({ panes: [
    pane('p1', { seat: 'OP', kind: 'shell', command: ['zsh'] }),
    { address: 'w2/t9/p9', workspace: 'tc', tab: 't9', pane: 'p9', title: 'OP', state: 'working', activityState: 'working', seat: 'OP', kind: 'codex', command: ['codex'], fgCommand: ['codex'] },
    pane('p5', { title: 'TC', seat: 'TC', kind: 'claude', command: ['claude'], fgCommand: ['claude'] }),
  ] })).toEqual([
    ' ⚪ TC',
    '       claude · op',
    ' 🟢 OP',
    '       codex · tc',
  ]);
});
