// ELS-SHORTCUTS-POPUP — the one key table, the router that reads it and the ctrl+b ? popup that reads it.
// Expectations are literals (the keys and words a person sees), never built from the table under test.
import { expect, test } from 'bun:test';
import { createKeyRouter } from './attach-keys.js';
import { AFTER_PREFIX, AFTER_PREFIX_KEYS, shortcutSections, shortcutsMarkdown, tileActionOf } from './key-bindings.js';
import { renderShortcuts, shortcutsKey, shortcutsLayout, shortcutsProps, shortcuts } from './elements/shortcuts.js';

const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

// Every one-key ctrl+b chord els has (11-28), written out by hand.
const PREFIX_KEYS = [',', 'q', 'j', 'l', 'n', 'k', 'h', 'p', 'w', 'b', 's', 'g', 'c', 'a', 'N', 'x', 'D', 'm', '?', '[', ']', '+', '-', ' ', '\r', 'A', 't',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', 'f', 'o', ':', '/', 'M', '\t', 'r', '`', '\u001b', 'Q'];
const PREFIX_SEQUENCES = ['\u001b[5~', '\u001b[6~', '\u001b[H', '\u001b[1~', '\u001bOH', '\u001b[F', '\u001b[4~', '\u001bOF', '\u001b[D', '\u001bOD', '\u001b[C', '\u001bOC'];

test('the router table is exactly the hand-written chord list (one-key chords and the PgUp/Home/arrow sequences)', () => {
  expect(Object.keys(AFTER_PREFIX).sort()).toEqual([...PREFIX_KEYS].sort());
  expect(AFTER_PREFIX_KEYS.map(([seq]) => seq).sort()).toEqual([...PREFIX_SEQUENCES].sort());
});

test('router: the keys that used to be one-off cases are actions from the table now', () => {
  const router = createKeyRouter();
  const one = (text: string) => router.feed(text);
  expect(one('\u0002?')).toEqual([{ kind: 'action', action: 'help' }]);
  expect(one('\u0002:')).toEqual([{ kind: 'action', action: 'voice' }]);
  expect(one('\u0002o')).toEqual([{ kind: 'action', action: 'obsidian' }]);
  expect(one('\u0002`')).toEqual([{ kind: 'action', action: 'popup-term' }]);
  expect(one('\u0002\t')).toEqual([{ kind: 'action', action: 'cycle-focus' }]);
  expect(one('\u0002Q')).toEqual([{ kind: 'action', action: 'quit' }]);
  expect(one('\u00027')).toEqual([{ kind: 'action', action: 'goto', n: 7 }]);
  expect(one('\u0002\u001b[6~')).toEqual([{ kind: 'action', action: 'list-page-down' }]);
  expect(one('\u0002G')).toEqual([{ kind: 'unknown', key: 'G' }]);
});

test('popup: every ctrl+b chord the router knows sits in exactly one popup row, in every context', () => {
  for (const context of ['normal', 'tile', 'popup-term', 'overlay'] as const) {
    const rows = shortcutSections(context).flatMap((section) => section.rows);
    for (const key of [...PREFIX_KEYS, ...PREFIX_SEQUENCES]) {
      expect({ key, context, rows: rows.filter((row) => row.prefix && row.keys.includes(key)).length }).toEqual({ key, context, rows: 1 });
    }
  }
});

test('popup: the groups, normal order and the chords as written', () => {
  expect(shortcutSections('normal').map((section) => section.group)).toEqual(['Panes & tabs', 'Workspaces', 'Views', 'Popup terminal', 'Scrolling', 'Session', 'Tile view']);
  const chords = shortcutSections('normal').flatMap((section) => section.rows.map((row) => `${row.chord} = ${row.label}`));
  for (const line of ['ctrl+b j / l / n = Next tab', 'ctrl+b 1…9 = Go to tab 1 to 9', 'ctrl+b ? = Show or hide these shortcuts', 'ctrl+b q / Esc = On it: hide (keeps running)',
    'ctrl+b PgUp / PgDn = Side list: page up / down', 'ctrl+b ← / → = Scroll the tab row', 'ctrl+b [ / ] = Scroll the tab\'s history', '←↑↓→ / hjkl = Move between tiles',
    'Enter = Back to the pane (open the tile)', 'ctrl+b o = Obsidian notes', 'ctrl+b : = Tell els what to do', 'ctrl+b f = File browser', 'ctrl+b t = Tile view (every tab, live)']) {
    expect(chords).toContain(line);
  }
});

test('popup: the context it opens in comes first (tile grid · popup terminal · a popup)', () => {
  expect(shortcutSections('tile')[0]!.group).toBe('Tile view');
  expect(shortcutSections('tile')[0]!.rows.map((row) => row.chord)).toEqual(['←↑↓→ / hjkl', 'Enter', '[ / ]', 'Esc']);
  expect(shortcutSections('popup-term')[0]!.group).toBe('Popup terminal');
  expect(shortcutSections('popup-term')[0]!.rows[0]!.chord).toBe('ctrl+b q / Esc');
  expect(shortcutSections('overlay')[0]!.group).toBe('Views');
  expect(shortcutSections('overlay')[0]!.rows.map((row) => row.chord).slice(0, 3)).toEqual(['ctrl+b Tab', 'ctrl+b r', 'ctrl+b t']);
  const tile = renderShortcuts({ context: 'tile', scroll: 0 }, { w: 60, h: 12 }, true).map(plain);
  expect(tile[0]).toContain('Shortcuts · Tile view: Enter = back to the pane');
  expect(tile[1]).toBe('│Tile view                                                 │');
  expect(tile[3]).toBe('│ Enter        Back to the pane (open the tile)            │');
});

test('popup: two columns when wide, one when narrow; taller than the box = scroll, clamped', () => {
  expect(shortcutsLayout('normal', 107).columns).toBe(2);
  expect(shortcutsLayout('normal', 78).columns).toBe(1);
  const wide = renderShortcuts({ context: 'normal', scroll: 0 }, { w: 109, h: 26 }, true).map(plain);
  expect(wide[1]!.startsWith('│Panes & tabs')).toBe(true);
  expect(wide[1]).toContain('Views (cont.)');
  expect(wide.at(-1)).toContain('Esc or ctrl+b ? close');
  const narrow = renderShortcuts({ context: 'normal', scroll: 0 }, { w: 50, h: 10 }, true).map(plain);
  expect(narrow).toHaveLength(10);
  expect(narrow[1]).toBe('│Panes & tabs                                    │');
  expect(narrow[2]).toBe('│ ctrl+b j / l / n      Next tab                 │');
  expect(narrow.at(-1)).toContain('1-8/46 · ↑↓ scroll · Esc close');
  const down = shortcutsKey({ context: 'normal', scroll: 0 }, '\u001b[B');
  expect(down).toEqual({ context: 'normal', scroll: 1 });
  expect(plain(renderShortcuts(down as { context: 'normal'; scroll: number }, { w: 50, h: 10 }, true)[1]!)).toBe('│ ctrl+b j / l / n      Next tab                 │');
  expect(shortcutsKey({ context: 'normal', scroll: 0 }, '\u001b[A')).toBe('consumed');            // already at the top
  expect(shortcutsKey({ context: 'normal', scroll: 0 }, '\u001b[F')).toEqual({ context: 'normal', scroll: 45 });
  expect(shortcutsKey({ context: 'normal', scroll: 45 }, 'j')).toBe('consumed');               // the last line stays the last
  const end = renderShortcuts({ context: 'normal', scroll: 45 }, { w: 50, h: 10 }, true).map(plain);
  expect(end.at(-1)).toContain('39-46/46');                                                    // drawn clamped to a full box
});

test('popup: Esc and every other key are the popup\'s (consumed — the overlay closes it on Esc); props from outside are checked', () => {
  const layer = { id: 'ov1', kind: 'shortcuts', key: 'default', band: 'popup', seq: 1, rect: { anchor: 'center', w: 110, h: 27 }, focus: 'owns', props: { context: 'tile', scroll: 0 } } as const;
  expect(shortcuts.key!(layer, '\u001b')).toBe('consumed');
  expect(shortcuts.key!(layer, 'x')).toBe('consumed');
  expect(shortcuts.key!(layer, '\u0003')).toBe('consumed');
  expect(shortcuts.key!(layer, '\u001b[B')).toEqual({ update: { context: 'tile', scroll: 1 } });
  expect(shortcutsProps({ context: 'evil', scroll: -3 })).toEqual({ context: 'normal', scroll: 0 });
  expect(shortcutsProps({ context: 'overlay', scroll: 9_999 })).toEqual({ context: 'overlay', scroll: 45 });
  expect(shortcutsProps('nope')).toBeUndefined();
  expect(shortcuts.defaults).toEqual({ band: 'popup', focus: 'owns' });
  expect(shortcuts.frames).toEqual(['popup']);
});

test('tile grid keys come from the same table', () => {
  expect(['h', '\u001b[D', 'j', '\u001b[B', 'k', '\u001bOA', 'l', '\u001b[C', '\r', '[', ']', '\u001b', 'z'].map(tileActionOf))
    .toEqual(['tile-left', 'tile-left', 'tile-down', 'tile-down', 'tile-up', 'tile-up', 'tile-right', 'tile-right', 'tile-zoom', 'tile-page-prev', 'tile-page-next', 'tile-level-up', undefined]);
});

test('the docs table: a markdown section per group with every row', () => {
  const md = shortcutsMarkdown();
  expect(md.startsWith('# els keyboard shortcuts\n')).toBe(true);
  expect(md).toContain('## Panes & tabs\n\n| Keys | What it does | Where |\n|---|---|---|\n| `ctrl+b j / l / n` | Next tab | anywhere |');
  expect(md).toContain('| `ctrl+b q / Esc` | On it: hide (keeps running) | on the popup terminal |');
  expect(md).toContain('| `Enter` | Back to the pane (open the tile) | on the tile grid |');
  expect(md.match(/^## /gm)).toHaveLength(7);
});
