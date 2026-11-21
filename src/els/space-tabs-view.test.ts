import { expect, test } from 'bun:test';
import { Terminal } from '@xterm/headless';
import { buildSpaceList, buildTabRow, layoutSpaceList, paneEmoji, withCommands, type SpaceTabRow } from './space-tabs-view.js';
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
const plain = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, '');
const trim = (lines: readonly string[]) => lines.map((line) => plain(line).trimEnd());

// ELS-SIDEBAR-HERDR-CLEAN: herdr's list — «spaces» head, «● NAME» per workspace (one dot), the selected one's path under it, «new · menu» last.
const WITH_CWD: SpaceTabRow[] = ROWS.map((row) => row.wsId === 'ux' ? { ...row, cwd: '/Users/me/work/ux' } : row);

test('left = herdr: «spaces» head, UPPERCASE name with ONE most-urgent dot, the selected space\'s path (~) on the line under it, «new · menu» pinned last, no pane count', () => {
  const layout = layoutSpaceList(WITH_CWD, 'p2', 24, 8, '/Users/me');
  expect(trim(layout.lines)).toEqual([' spaces', ' ◐ UX', '   ~/work/ux', ' ○ OP', ' ✓ MSHQ', '', '', ' new · menu']);
  expect(layout.lines.every((line) => Bun.stringWidth(line) === 24)).toBe(true);
  expect(layout.lines.join('\n')).not.toMatch(/codex|zsh|Sessions|Harness|· \d/);
  expect(ROWS[0]!.workspace).toBe('ux');                           // upper case is display only: the stored name is untouched
});

test('hit boxes: each space name row (not the head, the path or the blank), and the words «new» and «menu», sit exactly where the text is', () => {
  const layout = layoutSpaceList(WITH_CWD, 'p2', 24, 8, '/Users/me');
  expect(layout.spaces).toEqual([{ y: 2, ws: 'ux', pane: 'p1' }, { y: 4, ws: 'op', pane: 'p4' }, { y: 5, ws: 'mshq', pane: 'p5' }]);
  for (const hit of layout.spaces) expect(plain(layout.lines[hit.y - 1]!)).toContain(hit.ws.toUpperCase());
  expect(layout.newBox).toEqual({ y: 8, from: 1, to: 4 });
  expect(layout.menuBox).toEqual({ y: 8, from: 7, to: 11 });
  const last = plain(layout.lines[7]!);
  expect([last.slice(1, 4), last.slice(7, 11)]).toEqual(['new', 'menu']);
});

test('the path line belongs to the selected space only: selecting another moves it (none when that space has no folder); a long path keeps its tail, cut by cells', () => {
  expect(trim(buildSpaceList(WITH_CWD, 'p4', 24, 5, '/Users/me'))).toEqual([' spaces', ' ◐ UX', ' ○ OP', ' ✓ MSHQ', ' new · menu']);
  const long = WITH_CWD.map((row) => row.wsId === 'ux' ? { ...row, workspace: '아주긴작업공간이름입니다만더길게써서잘리는지', cwd: '/Users/me/프로젝트/아주아주긴폴더이름/그리고또긴하위폴더' } : row);
  const lines = buildSpaceList(long, 'p1', 24, 8, '/Users/me');
  expect(trim(lines).slice(1, 3)).toEqual([' ◐ 아주긴작업공간이름입…', '   …/그리고또긴하위폴더']);
  expect(lines.every((line) => Bun.stringWidth(line) === 24)).toBe(true);
});

test('the one dot is the most urgent state inside the space: failed, then blocked, working, idle; a space of stale panes reads ✕', () => {
  const rows = (...states: string[]): SpaceTabRow[] => states.map((state, at) => ({ pane: `q${at}`, wsId: 'w', workspace: 'w', title: 't', state }));
  expect(trim(buildSpaceList(rows('idle', 'failed', 'blocked'), 'q0', 12, 3))[1]).toBe(' ✕ W');
  expect(trim(buildSpaceList(rows('working', 'blocked'), 'q0', 12, 3))[1]).toBe(' ◐ W');
  expect(trim(buildSpaceList(rows('idle', 'working'), 'q0', 12, 3))[1]).toBe(' ● W');
  expect(trim(buildSpaceList(rows('idle', 'idle'), 'q0', 12, 3))[1]).toBe(' ○ W');
});

test('a short list scrolls to keep the selected space and its path line in view; the head and the last line stay', () => {
  expect(trim(buildSpaceList(ROWS, 'p5', 24, 4))).toEqual([' spaces', ' ○ OP', ' ✓ MSHQ', ' new · menu']);
  const deep = ROWS.map((row) => row.wsId === 'mshq' ? { ...row, cwd: '/srv/mshq' } : row);
  expect(trim(buildSpaceList(deep, 'p5', 24, 4))).toEqual([' spaces', ' ✓ MSHQ', '   /srv/mshq', ' new · menu']);
  expect(trim(buildSpaceList(ROWS, 'p5', 24, 2))).toEqual([' ✓ MSHQ', ' new · menu']);
});

// ELS-TAB-STYLE-HERDR: UPPERCASE names, padded blocks one space apart, «+» last; the focused tab blue (44;37), the others gray (100;37).
const A = '\u001b[44;37m';
const I = '\u001b[100;37m';
const O = '\u001b[49;39m';
test('tab row = the selected space\'s panes as padded UPPERCASE «emoji NAME» blocks: focused blue, others gray, «+» last (ELS-TAB-STYLE-HERDR)', () => {
  const row = buildTabRow(ROWS, 'p2', 60);
  expect(row.line!.trimEnd()).toBe(`${I} 💬 ELN ${O} ${A} 🤖 CODEX ${O} ${I} ⌨︎  ZSH ${O} +`);
  expect(row.tabs).toEqual([{ from: 0, to: 8, pane: 'p1' }, { from: 9, to: 19, pane: 'p2' }, { from: 20, to: 28, pane: 'p3' }]);
  expect(Bun.stringWidth(row.line!)).toBe(60);
  // Verify cell ranges with xterm below rather than slicing UTF-16 at cell offsets.
});

test('the stored title is never uppercased: only the drawn name is (Korean is unaffected)', () => {
  const ls = JSON.stringify({ panes: [{ address: 'w/t/p1', workspace: 'w', pane: 'p1', title: '한글 abc', state: 'idle', command: ['zsh'] }] });
  const rows = withCommands(parsePaneRows(ls), ls);
  expect(buildTabRow(rows, 'p1', 40).line).toContain(' ⌨︎  한글 ABC ');
  expect(rows[0]!.title).toBe(parsePaneRows(ls)[0]!.title);   // the stored title keeps its case
  expect(rows[0]!.title).toContain('abc');
});

test('emoji are 2 cells: tabs of the same title length line up whatever the emoji', () => {
  const a = buildTabRow(ROWS, 'p1', 60).tabs;
  expect(a.map((tab) => tab.to - tab.from)).toEqual([8, 10, 8]);
});

test('overflow keeps the selected tab and shows ‹ ›; no panes = no row', () => {
  const narrow = buildTabRow(ROWS, 'p3', 16);
  expect(narrow.line).toBe(`‹${A} ⌨︎  ZSH ${O} +     `);
  expect(narrow.tabs).toEqual([{ from: 1, to: 9, pane: 'p3' }]);
  const first = buildTabRow(ROWS, 'p1', 16);
  expect(first.line).toBe(`${A} 💬 ELN ${O} ›      `);
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
const CLIP_ONE_LESS = 9;      // 출처: #38438 must[1] — the single « ⌨︎  EDGE » tab exactly (padded; no badge, no mark)
const WIDE_ROW_WIDTH = 80;    // 출처: #38438 must[1] — the whole two-tab row fits

test('#38438 must[1]: a too-wide selected tab is clipped to the row and keeps a click range — narrow', () => {
  const row = buildTabRow(LONG_ROWS, 'p1', NARROW_ROW_WIDTH);
  expect(row.line).toBe(`${A} ⌨︎  LONG TIT${O}`);
  expect(row.tabs).toEqual([{ from: 0, to: NARROW_ROW_WIDTH, pane: 'p1' }]);
  expect(Bun.stringWidth(row.line!)).toBe(NARROW_ROW_WIDTH);
});

test('#38438 must[1]: wide row = the whole row, click ranges unchanged', () => {
  const row = buildTabRow(LONG_ROWS, 'p1', WIDE_ROW_WIDTH);
  expect(row.line!.trimEnd()).toBe(`${A} ⌨︎  LONG TITLE ${O} ${I} ⌨︎  LONG ONE ${O} +`);
  expect(row.tabs).toEqual([{ from: 0, to: 15, pane: 'p1' }, { from: 16, to: 29, pane: 'p2' }]);
});

test('#38438 must[1]: boundary — the single tab fits without its separator, clips one cell shorter', () => {
  const whole = buildTabRow(EDGE_ROWS, 'p1', CLIP_ONE_LESS);
  expect(whole.line).toBe(`${A} ⌨︎  EDGE ${O}`);
  expect(whole.tabs).toEqual([{ from: 0, to: CLIP_ONE_LESS, pane: 'p1' }]);
  const clipped = buildTabRow(EDGE_ROWS, 'p1', CLIP_ONE_LESS - 1);
  expect(clipped.line).toBe(`${A} ⌨︎  EDGE${O}`);
  expect(clipped.tabs).toEqual([{ from: 0, to: CLIP_ONE_LESS - 1, pane: 'p1' }]);
});

test('#38438 must[1]: a too-wide selected tab after ‹ is clipped into what is left of the row', () => {
  const row = buildTabRow(LONG_ROWS, 'p2', NARROW_ROW_WIDTH);
  expect(row.line).toBe(`‹${A} ⌨︎  LONG ON${O}`);
  expect(row.tabs).toEqual([{ from: 1, to: NARROW_ROW_WIDTH, pane: 'p2' }]);
});

test('ELS-REMOTE-MARKER: a space of stale (host down) panes reads «✕» in the list, and its tabs read «⇄host … ✕» too', () => {
  const live = { pane: 'node-b:wa/tb/p1', wsId: 'node-b:wa', workspace: '⇄node-b wa', title: 'gate', state: 'working', remote: 'node-b' };
  const stale = [{ ...live, stale: true }, { ...live, pane: 'node-b:wa/tb/p2', title: 'review', state: 'blocked', stale: true }];
  expect(trim(buildSpaceList(stale, 'node-b:wa/tb/p1', 28, 2))).toEqual([' ✕ ⇄MSB1 WA', ' new · menu']);
  expect(buildTabRow(stale, 'node-b:wa/tb/p1', 60).line?.trimEnd()).toBe(`${A} 🌐 ⇄node-b GATE ✕ ${O} ${I} 🌐 ⇄node-b REVIEW ✕ ${O} +`);
  expect(trim(buildSpaceList([live], 'node-b:wa/tb/p1', 28, 1))).toEqual([' ● ⇄MSB1 WA']);
});

test('ELS-FIRST-RUN-LIVE-PANE: an exited pane\'s tab is dimmed (SGR 2), the focused one is blue, the exited one gray+dim — both in one pass, click ranges unchanged', () => {
  const ls = JSON.stringify({ panes: [
    { address: 'w/t/p1', workspace: 'w', pane: 'p1', title: 'zsh', state: 'exited', command: ['zsh'] },
    { address: 'w/t/p2', workspace: 'w', pane: 'p2', title: 'eln', state: 'idle', command: ['/usr/local/bin/eln'] },
  ] });
  const row = buildTabRow(withCommands(parsePaneRows(ls), ls), 'p2', 20);
  expect(row.line).toBe(`\u001b[2m${I} ⌨︎  ZSH \u001b[22m${O} ${A} 💬 ELN ${O} + `);
  expect(row.tabs).toEqual([{ from: 0, to: 8, pane: 'p1' }, { from: 9, to: 17, pane: 'p2' }]);
});

test('ELS-NEW-TAB-NAME-WIDGET: the tab row tells where its «+» is (one cell, after the last tab); an overflowing row has none', () => {
  const row = buildTabRow(ROWS, 'p1', 60);
  const plain = (row.line ?? '').replace(/\u001b\[[0-9;]*m/g, '');
  expect(row.plus).toEqual({ from: Bun.stringWidth(plain.slice(0, plain.indexOf('+'))), to: Bun.stringWidth(plain.slice(0, plain.indexOf('+'))) + 1 });
  expect(buildTabRow(ROWS, 'p1', 10).plus).toBeUndefined();
});

test('xterm cells and hitboxes agree for shell tabs and the plus at 80, 120 and 200 columns', async () => {
  const shells: SpaceTabRow[] = [
    { pane: 's1', wsId: 'w', workspace: 'w', title: 'one', state: 'idle', command: ['sh'] },
    { pane: 's2', wsId: 'w', workspace: 'w', title: 'two', state: 'idle', command: ['zsh'] },
  ];
  for (const width of [80, 120, 200]) {
    const row = buildTabRow(shells, 's1', width);
    const terminal = new Terminal({ cols: width, rows: 2, allowProposedApi: true });
    await new Promise<void>((resolve) => terminal.write(row.line!, resolve));
    const screen = terminal.buffer.active.getLine(0)!;
    expect(row.tabs).toEqual([{ from: 0, to: 8, pane: 's1' }, { from: 9, to: 17, pane: 's2' }]);
    expect(row.plus).toEqual({ from: 18, to: 19 });
    expect(screen.getCell(18)!.getChars()).toBe('+');
    expect(screen.getCell(17)!.getChars()).toBe(' ');
    expect(screen.getCell(19)!.getChars()).toBe(' ');
    expect(screen.translateToString(false, 0, 8)).toBe(' ⌨︎  ONE ');
    expect(screen.translateToString(false, 9, 17)).toBe(' ⌨︎  TWO ');
    terminal.dispose();
  }
});
