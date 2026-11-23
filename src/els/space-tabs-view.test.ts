import { expect, test } from 'bun:test';
import { Terminal } from '@xterm/headless';
import { buildSpaceList, buildTabDropdown, buildTabRow, layoutSpaceList, paneEmoji, withCommands, type SpaceTabRow } from './space-tabs-view.js';
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

test('HQ alone has a space star; each coordinator alone has a tab star and bold agent row', () => {
  const rows: SpaceTabRow[] = [
    { pane: 'op', wsId: 'hq', workspace: 'HQ', title: 'OP', state: 'idle', role: 'coordinator', spaceCoordinator: true },
    { pane: 'worker', wsId: 'hq', workspace: 'HQ', title: 'worker', state: 'idle', role: 'coordinator' },
    { pane: 'lead', wsId: 'sub', workspace: 'Sub', title: 'lead', state: 'idle', spaceCoordinator: true },
    { pane: 'member', wsId: 'sub', workspace: 'Sub', title: 'member', state: 'idle' },
  ];
  const lines = layoutSpaceList(rows, 'op', 28, 20).lines;
  expect(trim(lines)).toContain(' ⭐ HQ');
  expect(trim(lines)).toContain(' SUB');
  expect(lines.find(line => plain(line).includes(' OP'))).toContain('\u001b[1m');
  expect(lines.find(line => plain(line).includes(' lead'))).toContain('\u001b[1m');
  expect(lines.find(line => plain(line).includes(' worker'))).not.toContain('\u001b[1m');
  expect(plain(buildTabRow(rows, 'op', 80).line!)).toContain('  ⭐ OP  ');
  expect(plain(buildTabRow(rows, 'op', 80).line!)).not.toContain('⭐ WORKER');
  expect(plain(buildTabRow(rows, 'lead', 80).line!)).toContain('  ⭐ LEAD  ');
  expect(plain(buildTabRow(rows, 'lead', 80).line!)).not.toContain('⭐ MEMBER');
});

// 출처: OP #134199/#134203/#134223/#134227 — spaces 칸은 상태 없는 이름(조율자 ⭐만), 포커스된 스페이스만 2줄,
// 아래 «agents grouped» 칸이 뒤따른다.
test('left = herdr: «spaces» head, plain UPPERCASE name (no dot — OP #134203), the selected space\'s «N agents · branch» under it, then the agents panel, «new · menu» last', () => {
  const layout = layoutSpaceList(WITH_CWD, 'p2', 24, 8, '/Users/me');
  expect(trim(layout.lines)).toEqual([' spaces', ' UX', '   3 agents · ux', ' OP', ' MSHQ', '────────────────────────', ' agents          grouped', ' new · menu']);
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
  expect(trim(buildSpaceList(WITH_CWD, 'p4', 24, 5, '/Users/me'))).toEqual([' spaces', ' UX', ' OP', '   1 agent · op', ' new · menu']);
  const long = WITH_CWD.map((row) => row.wsId === 'ux' ? { ...row, workspace: '아주긴작업공간이름입니다만더길게써서잘리는지', cwd: '/Users/me/프로젝트/아주아주긴폴더이름/그리고또긴하위폴더' } : row);
  const lines = buildSpaceList(long, 'p1', 24, 8, '/Users/me');
  expect(trim(lines).slice(1, 3)).toEqual([' 아주긴작업공간이름입니…', '   …· 그리고또긴하위폴더']);
  expect(lines.every((line) => Bun.stringWidth(line) === 24)).toBe(true);
});

test('space lines carry no status dot any more (OP #134203): whatever the panes run, the name row is bare', () => {
  const rows = (...states: string[]): SpaceTabRow[] => states.map((state, at) => ({ pane: `q${at}`, wsId: 'w', workspace: 'w', title: 't', state }));
  for (const states of [['idle', 'failed', 'blocked'], ['working', 'blocked'], ['idle', 'working'], ['idle', 'idle']]) {
    expect(trim(buildSpaceList(rows(...states), 'q0', 12, 3))[1]).toBe(' W');
  }
});

test('a short list scrolls to keep the selected space and its subtitle line in view; the head and the last line stay', () => {
  expect(trim(buildSpaceList(ROWS, 'p5', 24, 4))).toEqual([' spaces', ' MSHQ', '   1 agent · mshq', ' new · menu']);
  const deep = ROWS.map((row) => row.wsId === 'mshq' ? { ...row, cwd: '/srv/mshq' } : row);
  expect(trim(buildSpaceList(deep, 'p5', 24, 4))).toEqual([' spaces', ' MSHQ', '   1 agent · mshq', ' new · menu']);
  expect(trim(buildSpaceList(ROWS, 'p5', 24, 2))).toEqual([' MSHQ', ' new · menu']);
});

// ELS-TAB-STYLE-HERDR: UPPERCASE names, padded blocks, «+» last; the focused tab blue (44;37), the others gray (100;37).
// ELS-AGENT-STATUS-UNKNOWN-AND-TAB-BAR (OP 11-23): no runtime emoji, two cells of padding inside each tab and two between tabs,
// one status glyph only when the tab is not plainly working or idle (🟡 waiting on a person · ⏸ stalled · 🔴 exited · ✕ host down).
const A = '\u001b[44;37m';
const I = '\u001b[100;37m';
const O = '\u001b[49;39m';
test('tab row = the selected space\'s panes as padded UPPERCASE «NAME» blocks without a runtime emoji: focused blue, others gray, «+» last', () => {
  const row = buildTabRow(ROWS, 'p2', 60);
  expect(row.line!.trimEnd()).toBe(`${I}  ELN  ${O}  ${A}  CODEX  ${O}  ${I}  ZSH 🟡  ${O}  +`);
  expect(row.tabs).toEqual([{ from: 0, to: 7, pane: 'p1' }, { from: 9, to: 18, pane: 'p2' }, { from: 20, to: 30, pane: 'p3' }]);
  expect(Bun.stringWidth(row.line!)).toBe(60);
  // Verify cell ranges with xterm below rather than slicing UTF-16 at cell offsets.
});

test('the stored title is never uppercased: only the drawn name is (Korean is unaffected)', () => {
  const ls = JSON.stringify({ panes: [{ address: 'w/t/p1', workspace: 'w', pane: 'p1', title: '한글 abc', state: 'idle', command: ['zsh'] }] });
  const rows = withCommands(parsePaneRows(ls), ls);
  expect(buildTabRow(rows, 'p1', 40).line).toContain('  한글 ABC  ');
  expect(rows[0]!.title).toBe(parsePaneRows(ls)[0]!.title);   // the stored title keeps its case
  expect(rows[0]!.title).toContain('abc');
});

test('a tab is its name plus two cells each side, plus « glyph» only when it has one', () => {
  const a = buildTabRow(ROWS, 'p1', 60).tabs;
  expect(a.map((tab) => tab.to - tab.from)).toEqual([7, 9, 10]);
});

test('overflow keeps the selected tab and shows ‹ ›; no panes = no row', () => {
  const narrow = buildTabRow(ROWS, 'p3', 16);
  expect(narrow.line).toBe(`‹${A}  ZSH 🟡  ${O}  +  `);
  expect(narrow.tabs).toEqual([{ from: 1, to: 11, pane: 'p3' }]);
  const first = buildTabRow(ROWS, 'p1', 16);
  expect(first.line).toBe(`${A}  ELN  ${O}  ›      `);
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
const CLIP_ONE_LESS = 8;      // 출처: #38438 must[1] — the single «  EDGE  » tab exactly (padded; no badge, no mark)
const WIDE_ROW_WIDTH = 80;    // 출처: #38438 must[1] — the whole two-tab row fits

test('#38438 must[1]: a too-wide selected tab is clipped to the row and keeps a click range — narrow', () => {
  const row = buildTabRow(LONG_ROWS, 'p1', NARROW_ROW_WIDTH);
  expect(row.line).toBe(`${A}  LONG TIT  ${O}`);   // the name is cut, the padding stays
  expect(row.tabs).toEqual([{ from: 0, to: NARROW_ROW_WIDTH, pane: 'p1' }]);
  expect(Bun.stringWidth(row.line!)).toBe(NARROW_ROW_WIDTH);
});

test('#38438 must[1]: wide row = the whole row, click ranges unchanged', () => {
  const row = buildTabRow(LONG_ROWS, 'p1', WIDE_ROW_WIDTH);
  expect(row.line!.trimEnd()).toBe(`${A}  LONG TITLE  ${O}  ${I}  LONG ONE  ${O}  +`);
  expect(row.tabs).toEqual([{ from: 0, to: 14, pane: 'p1' }, { from: 16, to: 28, pane: 'p2' }]);
});

test('#38438 must[1]: boundary — the single tab fits without its separator, clips one cell shorter', () => {
  const whole = buildTabRow(EDGE_ROWS, 'p1', CLIP_ONE_LESS);
  expect(whole.line).toBe(`${A}  EDGE  ${O}`);
  expect(whole.tabs).toEqual([{ from: 0, to: CLIP_ONE_LESS, pane: 'p1' }]);
  const clipped = buildTabRow(EDGE_ROWS, 'p1', CLIP_ONE_LESS - 1);
  expect(clipped.line).toBe(`${A}  EDG  ${O}`);
  expect(clipped.tabs).toEqual([{ from: 0, to: CLIP_ONE_LESS - 1, pane: 'p1' }]);
});

test('#38438 must[1]: a too-wide selected tab after ‹ is clipped into what is left of the row', () => {
  const row = buildTabRow(LONG_ROWS, 'p2', NARROW_ROW_WIDTH);
  expect(row.line).toBe(`‹${A}  LONG ON  ${O}`);
  expect(row.tabs).toEqual([{ from: 1, to: NARROW_ROW_WIDTH, pane: 'p2' }]);
});

// Terra #39800 must: a narrow row keeps ⭐ and the status glyph; at exactly head + tail the name is empty, never the glyph cut.
test('narrow: the coordinator star and the status glyph survive in the tab row and the dropdown header; the name gives way first', () => {
  const lead = { pane: 'l', wsId: 'w', workspace: 'w', title: 'reviewer', state: 'blocked', spaceCoordinator: true };
  expect(buildTabRow([lead], 'l', 13).line).toBe(`${A}  ⭐ REV 🟡  ${O}`);
  expect(buildTabRow([lead], 'l', 13).tabs).toEqual([{ from: 0, to: 13, pane: 'l' }]);
  expect(buildTabRow([lead], 'l', 10).line).toBe(`${A}  ⭐  🟡  ${O}`);    // exactly head + tail: no name, both glyphs
  expect(buildTabDropdown([lead], 'l', undefined, 13, 3).line).toBe(`${A}  ⭐ R 🟡  ${O} ▾`);
  const down = { pane: 'd', wsId: 'h:w', workspace: '⇄h w', title: 'gate', state: 'working', remote: 'h', stale: true };
  expect(buildTabRow([down], 'd', 8).line).toBe(`${A}  ⇄h ✕  ${O}`);
});

test('ELS-REMOTE-MARKER: a space of stale (host down) panes reads «✕» in the list, and its tabs read «⇄host … ✕» too', () => {
  const live = { pane: 'node-b:wa/tb/p1', wsId: 'node-b:wa', workspace: '⇄node-b wa', title: 'gate', state: 'working', remote: 'node-b' };
  const stale = [{ ...live, stale: true }, { ...live, pane: 'node-b:wa/tb/p2', title: 'review', state: 'blocked', stale: true }];
  expect(trim(buildSpaceList(stale, 'node-b:wa/tb/p1', 28, 2))).toEqual([' ✕ ⇄MSB1 WA', ' new · menu']);
  expect(buildTabRow(stale, 'node-b:wa/tb/p1', 60).line?.trimEnd()).toBe(`${A}  ⇄node-b GATE ✕  ${O}  ${I}  ⇄node-b REVIEW ✕  ${O}  +`);
  expect(trim(buildSpaceList([live], 'node-b:wa/tb/p1', 28, 1))).toEqual([' ⇄MSB1 WA']);  // 출처: OP #134203 — 살아있는 스페이스 줄에는 상태 마크가 없다; 사망(✕)만 예외
});

test('ELS-FIRST-RUN-LIVE-PANE: an exited pane\'s tab is dimmed (SGR 2), the focused one is blue, the exited one gray+dim — both in one pass, click ranges unchanged', () => {
  const ls = JSON.stringify({ panes: [
    { address: 'w/t/p1', workspace: 'w', pane: 'p1', title: 'zsh', state: 'exited', command: ['zsh'] },
    { address: 'w/t/p2', workspace: 'w', pane: 'p2', title: 'eln', state: 'idle', command: ['/usr/local/bin/eln'] },
  ] });
  const row = buildTabRow(withCommands(parsePaneRows(ls), ls), 'p2', 30);
  expect(row.line).toBe(`\u001b[2m${I}  ZSH 🔴  \u001b[22m${O}  ${A}  ELN  ${O}  +        `);
  expect(row.tabs).toEqual([{ from: 0, to: 10, pane: 'p1' }, { from: 12, to: 19, pane: 'p2' }]);
});

test('ELS-NEW-TAB-NAME-WIDGET: the tab row tells where its «+» is (one cell, after the last tab); an overflowing row has none', () => {
  const row = buildTabRow(ROWS, 'p1', 60);
  const plain = (row.line ?? '').replace(/\u001b\[[0-9;]*m/g, '');
  expect(row.plus).toEqual({ from: Bun.stringWidth(plain.slice(0, plain.indexOf('+'))), to: Bun.stringWidth(plain.slice(0, plain.indexOf('+'))) + 1 });
  expect(buildTabRow(ROWS, 'p1', 10).plus).toBeUndefined();
});

test('narrow dropdown closes the active background even when a title is clipped', () => {
  const row = { pane: 'p', wsId: 'w', workspace: 'w', title: 'long title', state: 'idle', command: ['bash'] };
  expect(buildTabDropdown([row], 'p', undefined, 8, 3).line).toBe(`${A}  LO  ${O} ▾`);   // the name gives way, the padding stays
  const empty = [{ wsId: 'w', name: '가나다라마바사' }];
  expect(buildTabDropdown([], undefined, undefined, 7, 3, empty, 'w').line).toBe(`${A} ⭐ 가${O} `);
  expect(buildTabDropdown([row], 'p', undefined, 30, 3).line).toContain(`${O} ▾`);
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
    expect(row.tabs).toEqual([{ from: 0, to: 7, pane: 's1' }, { from: 9, to: 16, pane: 's2' }]);
    expect(row.plus).toEqual({ from: 18, to: 19 });
    expect(screen.getCell(18)!.getChars()).toBe('+');
    expect(screen.getCell(17)!.getChars()).toBe(' ');
    expect(screen.getCell(19)!.getChars()).toBe(' ');
    expect(screen.translateToString(false, 0, 7)).toBe('  ONE  ');
    expect(screen.translateToString(false, 9, 16)).toBe('  TWO  ');
    terminal.dispose();
  }
});

// ELS-TAB-NAME-LABEL-FIRST: the seat/tab name (title) leads; the agent kind names the tab only when the title is empty or just a
// default command name. The tab carries no runtime emoji (the agents list shows the runtime). Literals.
test('ELS-TAB-NAME-LABEL-FIRST: title first (JUD-B · JUD-3), agent kind only for an empty title (CODEX), no runtime emoji', () => {
  const tab = (title: string, kind: string, fgCommand: string[]) => {
    const ls = JSON.stringify({ panes: [{ address: 'jud/t1/p1', workspace: 'jud', pane: 'p1', title, state: 'idle', command: ['/bin/zsh'], kind, fgCommand }] });
    return plain(buildTabRow(withCommands(parsePaneRows(ls), ls), 'p1', 40).line!).trimEnd();
  };
  expect(tab('JUD-B', 'eln', ['bun', '/opt/x/elanous.mjs'])).toBe('  JUD-B    +');
  expect(tab('', 'codex', ['codex', '--yolo'])).toBe('  CODEX    +');
  expect(tab('JUD-3', 'codex', ['codex'])).toBe('  JUD-3    +');
  expect(tab('/bin/zsh', 'claude', ['claude'])).toBe('  CLAUDE    +');   // a default command title still yields to the agent
});
