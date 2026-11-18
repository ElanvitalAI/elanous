import { expect, test } from 'bun:test';
import { buildSpaceList, buildTabRow, paneEmoji, withCommands, type SpaceTabRow } from './space-tabs-view.js';
import { parsePaneRows } from './attach-view.js';

// Expectations are literals (OP rule 11): typed out, never built from the product's tables.
const LS = JSON.stringify({ panes: [
  { address: 'ux/t1/p1', workspace: 'ux', pane: 'p1', title: 'eln', state: 'idle', command: ['/usr/local/bin/eln'] },
  { address: 'ux/t1/p2', workspace: 'ux', pane: 'p2', title: 'codex', state: 'working', command: ['codex', '--yolo'] },
  { address: 'ux/t2/p3', workspace: 'ux', pane: 'p3', title: 'zsh', state: 'blocked', command: ['zsh'] },
  { address: 'op/t3/p4', workspace: 'op', pane: 'p4', title: 'build', state: 'idle', command: [] },
  { address: 'mshq/t4/p5', workspace: 'mshq', pane: 'p5', title: 'old', state: 'exited', command: ['bash'] },
] });
const ROWS: SpaceTabRow[] = withCommands(parsePaneRows(LS), LS);
const trim = (lines: readonly string[]) => lines.map((line) => line.trimEnd());

test('left = spaces only: selected ▸, most urgent mark, name, pane count, «+ new · ≡ menu», full height', () => {
  const lines = buildSpaceList(ROWS, 'p2', 24, 6);
  expect(trim(lines)).toEqual(['▸◐ ux · 3', ' ○ op · 1', ' ✓ mshq · 1', ' + new · ≡ menu', '', '']);
  expect(lines.every((line) => Bun.stringWidth(line) === 24)).toBe(true);
  // No pane titles and no category headings on the left.
  expect(lines.join('\n')).not.toMatch(/codex|zsh|Sessions|Harness/);
});

test('the selected pane decides the selected space; none selected = the first space', () => {
  expect(trim(buildSpaceList(ROWS, 'p4', 24, 4)).slice(0, 2)).toEqual([' ◐ ux · 3', '▸○ op · 1']);
  expect(trim(buildSpaceList(ROWS, undefined, 24, 4))[0]).toBe('▸◐ ux · 3');
});

test('a short list scrolls to keep the selected space in view; the end line comes with the last space', () => {
  expect(trim(buildSpaceList(ROWS, 'p5', 24, 2))).toEqual([' ○ op · 1', '▸✓ mshq · 1']);
  expect(trim(buildSpaceList(ROWS, 'p5', 24, 3))).toEqual([' ○ op · 1', '▸✓ mshq · 1', ' + new · ≡ menu']);
});

test('tab row = the selected space\'s panes as «emoji title mark», the selected one ▸, with click ranges', () => {
  const row = buildTabRow(ROWS, 'p2', 60);
  expect(row.line!.trimEnd()).toBe(' 💬 eln ○ │▸🤖 codex ● │ ⌨️ zsh ◐ │');
  expect(row.tabs).toEqual([{ from: 0, to: 10, pane: 'p1' }, { from: 11, to: 23, pane: 'p2' }, { from: 24, to: 34, pane: 'p3' }]);
  expect(Bun.stringWidth(row.line!)).toBe(60);
});

test('emoji are 2 cells: tabs of the same title length line up whatever the emoji', () => {
  const a = buildTabRow(ROWS, 'p1', 60).tabs;
  expect(a.map((tab) => tab.to - tab.from)).toEqual([10, 12, 10]);
});

test('overflow keeps the selected tab and shows ‹ ›; no panes = no row', () => {
  const narrow = buildTabRow(ROWS, 'p3', 16);
  expect(narrow.line).toBe('‹▸⌨️ zsh ◐ │    ');
  expect(narrow.tabs).toEqual([{ from: 1, to: 11, pane: 'p3' }]);
  const first = buildTabRow(ROWS, 'p1', 16);
  expect(first.line).toBe('▸💬 eln ○ │›    ');
  expect(buildTabRow([], undefined, 40)).toEqual({ tabs: [] });
});

test('emoji by what the pane runs (curated set): chat, agent, shell, harness child, pod, remote', () => {
  const base = { pane: 'x', wsId: 'w', workspace: 'w', title: 't', state: 'idle' };
  expect(paneEmoji({ ...base, command: ['bun', '/repo/bin/elanous.mjs'] })).toBe('💬');
  expect(paneEmoji({ ...base, command: ['claude'] })).toBe('🤖');
  expect(paneEmoji({ ...base, command: ['/bin/zsh', '-l'] })).toBe('⌨️');
  expect(paneEmoji({ ...base, command: [] })).toBe('🛠');
  expect(paneEmoji({ ...base })).toBe('🛠');
  expect(paneEmoji({ ...base, command: ['kubectl', 'exec'] })).toBe('📦');
  expect(paneEmoji({ ...base, command: ['ssh', 'mshq'] })).toBe('🌐');
});

// 출처: #38438 review must[2] — the executable (runtime wrappers skipped) classifies; arguments never do.
test('#38438 must[2]: ssh/kubectl keep remote/pod even when an argument is an agent or chat name', () => {
  const base = { pane: 'x', wsId: 'w', workspace: 'w', title: 't', state: 'idle' };
  expect(paneEmoji({ ...base, command: ['ssh', 'claude'] })).toBe('🌐');
  expect(paneEmoji({ ...base, command: ['ssh', 'prod', '--', 'codex'] })).toBe('🌐');
  expect(paneEmoji({ ...base, command: ['kubectl', 'exec', 'claude', '-it', '--', 'gemini'] })).toBe('📦');
  expect(paneEmoji({ ...base, command: ['bash', 'claude'] })).toBe('⌨️');
  expect(paneEmoji({ ...base, command: ['vim', 'claude', 'codex'] })).toBe('⌨️');
  expect(paneEmoji({ ...base, command: ['node', '/usr/local/bin/eln'] })).toBe('💬');
  expect(paneEmoji({ ...base, command: ['bun', 'codex'] })).toBe('🤖');
});

// 출처: #38438 review must[1] — a selected tab wider than the row is clipped, never dropped. Title length × row width.
const LONG_LS = JSON.stringify({ panes: [
  { address: 'w/t/p1', workspace: 'w', pane: 'p1', title: 'long title', state: 'idle', command: ['bash'] },
  { address: 'w/t/p2', workspace: 'w', pane: 'p2', title: 'long one', state: 'idle', command: ['bash'] },
] });
const EDGE_LS = JSON.stringify({ panes: [
  { address: 'w/t/p1', workspace: 'w', pane: 'p1', title: 'edge', state: 'idle', command: ['bash'] },
] });
const LONG_ROWS: SpaceTabRow[] = withCommands(parsePaneRows(LONG_LS), LONG_LS);
const EDGE_ROWS: SpaceTabRow[] = withCommands(parsePaneRows(EDGE_LS), EDGE_LS);
const NARROW_ROW_WIDTH = 12;  // 출처: #38438 review must[1]
const CLIP_ONE_LESS = 11;     // one cell less than the single «edge» tab's text (11 cells without its separator)
const WIDE_ROW_WIDTH = 40;    // the whole two-tab row (34 cells) fits

test('#38438 must[1]: a too-wide selected tab is clipped to the row and keeps a click range — narrow', () => {
  const row = buildTabRow(LONG_ROWS, 'p1', NARROW_ROW_WIDTH);
  expect(row.line).toBe('▸⌨️ long tit');
  expect(row.tabs).toEqual([{ from: 0, to: NARROW_ROW_WIDTH, pane: 'p1' }]);
  expect(Bun.stringWidth(row.line!)).toBe(NARROW_ROW_WIDTH);
});

test('#38438 must[1]: wide row = the whole row, click ranges unchanged', () => {
  const row = buildTabRow(LONG_ROWS, 'p1', WIDE_ROW_WIDTH);
  expect(row.line!.trimEnd()).toBe('▸⌨️ long title ○ │ ⌨️ long one ○ │');
  expect(row.tabs).toEqual([{ from: 0, to: 17, pane: 'p1' }, { from: 18, to: 33, pane: 'p2' }]);
});

test('#38438 must[1]: boundary — the single tab fits without its separator, clips one cell shorter', () => {
  const whole = buildTabRow(EDGE_ROWS, 'p1', CLIP_ONE_LESS);
  expect(whole.line).toBe('▸⌨️ edge ○ ');
  expect(whole.tabs).toEqual([{ from: 0, to: CLIP_ONE_LESS, pane: 'p1' }]);
  const clipped = buildTabRow(EDGE_ROWS, 'p1', CLIP_ONE_LESS - 1);
  expect(clipped.line).toBe('▸⌨️ edge ○');
  expect(clipped.tabs).toEqual([{ from: 0, to: CLIP_ONE_LESS - 1, pane: 'p1' }]);
});

test('#38438 must[1]: a too-wide selected tab after ‹ is clipped into what is left of the row', () => {
  const row = buildTabRow(LONG_ROWS, 'p2', NARROW_ROW_WIDTH);
  expect(row.line).toBe('‹▸⌨️ long on');
  expect(row.tabs).toEqual([{ from: 1, to: NARROW_ROW_WIDTH, pane: 'p2' }]);
});
