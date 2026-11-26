// ELS-GROUP-FOLD-CONTROL · ELS-ACTIVE-ONLY-FILTER · ELS-SIDE-REMOTE-GROUP (대표 11-25 21:4x–21:5x): sim matrix on the real
// parser + real layout. Expectations are typed-out literals (OP rule 11).
import { expect, test } from 'bun:test';
import { parsePaneRows } from './attach-view.js';
import { layoutSpaceList, withCommands, type SpaceTabRow } from './space-tabs-view.js';

const plain = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trimEnd();
const pane = (ws: string, id: string, seat: string, state: string) =>
  ({ address: `${ws}/t-${id}/${id}`, workspace: ws, tab: `t-${id}`, pane: id, title: seat, state, activityState: state, seat, kind: 'eln', command: ['eln'], fgCommand: ['eln'] });
const rowsOf = (panes: object[]): SpaceTabRow[] => { const json = JSON.stringify({ panes }); return withCommands(parsePaneRows(json), json); };
const BIG = rowsOf([
  ...Array.from({ length: 6 }, (_, i) => pane('tc', `t${i}`, `TC-${i}`, i < 2 ? 'working' : 'idle')),
  ...Array.from({ length: 6 }, (_, i) => pane('ux', `u${i}`, `UX-${i}`, 'idle')),
]);
const heads = (lines: readonly string[]) => lines.map(plain).filter((line) => /^ [⌄›] /.test(line)).map((line) => line.trimEnd().replace(/ {2,}/g, ' '));

test('fold icons: ▾ open · ▸ folded; header carries «▾ all ▸ all»', () => {
  const out = layoutSpaceList(BIG, 't0', 30, 40, undefined, 0, [], undefined, 'grouped');
  expect(plain(out.lines[0]!)).toBe(' spaces           ▾ all ▸ all');
  expect(heads(out.lines)).toEqual([' ⌄ TC 6', ' ⌄ UX 6']);
  expect(out.foldAll).toEqual({ y: 1, expand: { y: 1, from: 18, to: 23 }, collapse: { y: 1, from: 24, to: 29 } });
});

test('the person folds a group and it stays folded even with room to spare', () => {
  const out = layoutSpaceList(BIG, 't0', 30, 40, undefined, 0, [], undefined, 'grouped', undefined, undefined, new Map([['ux', true]]));
  expect(heads(out.lines)).toEqual([' ⌄ TC 6', ' › UX 6']);
  expect(out.groupHeads?.map((head) => [head.ws, head.folded])).toEqual([['tc', false], ['ux', true]]);
});

test('auto-fold never folds a group the person opened — the list scrolls instead', () => {
  const auto = layoutSpaceList(BIG, 't0', 19, 16, undefined, 0, [], undefined, 'grouped');
  expect(heads(auto.lines)).toContain(' › UX 6');
  const kept = layoutSpaceList(BIG, 't0', 19, 16, undefined, 0, [], undefined, 'grouped', undefined, undefined, new Map([['ux', false]]));
  expect(kept.scroll).toBeDefined();
  expect(kept.lines.map(plain).some((line) => line.includes('› UX'))).toBe(false);
});

test('Active only: idle seats hide, counts read n/total, head reads «◉ Active · 2»', () => {
  const out = layoutSpaceList(BIG, 't0', 30, 40, undefined, 0, [], undefined, 'grouped', undefined, undefined, new Map(), true);
  const lines = out.lines.map(plain);
  expect(lines.some((line) => line.startsWith(' ◉ Active · 2'))).toBe(true);
  expect(heads(out.lines)).toEqual([' ⌄ TC 2/6']);
  expect(out.activeBox?.from).toBe(1);
  expect(out.activeBox?.to).toBe(13);
});

test('remote seat joins its space group with «@node-b»; no raw remote workspace heading', () => {
  const remote = { ...rowsOf([pane('⇄node-b w93c99119', 'r1', 'TC-H-REMOTE-1', 'working')])[0]!, remote: 'node-b' } as SpaceTabRow;
  const out = layoutSpaceList([...BIG, remote], 't0', 40, 40, undefined, 0, [], undefined, 'grouped');
  const lines = out.lines.map(plain);
  expect(heads(out.lines)).toEqual([' ⌄ TC 7', ' ⌄ UX 6']);
  expect(lines.some((line) => line.includes('TC-H-REMOTE-1@node-b'))).toBe(true);
  expect(lines.some((line) => line.includes('W93C99119') && /^ [⌄›]/.test(line))).toBe(false);
});

test('an exited twin of a live seat is hidden; a lone exited seat sits dim at the tail with ⏹, never ✅', () => {
  const rows = rowsOf([pane('tc', 'a', 'TC-1', 'idle'), pane('tc', 'b', 'TC-1', 'exited'), pane('tc', 'c', 'TC-2', 'exited'), pane('tc', 'd', 'TC-3', 'working')]);
  const lines = layoutSpaceList(rows, 'a', 30, 40, undefined, 0, [], undefined, 'grouped').lines.map(plain);
  const at = lines.findIndex((line) => line.startsWith(' ⌄ TC'));
  const group = lines.slice(at + 1).filter((line) => /^ (🟢|⚪|⏹)/.test(line));
  expect(group[group.length - 1]).toBe(' ⏹ TC-2 exited');
  expect(lines.filter((line) => line.includes('TC-1')).length).toBe(1);
  expect(lines.some((line) => line.includes('✅'))).toBe(false);
});
