// ELS-ELEMENT-HOST-FU (대표 11-26 «둘 다 고쳐주세요»): ① a `frame → tab` answer names the host pane (the pressing viewer
// follows it) · ② server start restores element tabs as elements (a host pane without its PTY is drawn again; plain
// shells are never touched). Expected panes and commands are literals.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOverlayRegistry } from './overlay-registry.js';
import type { OverlayLayer } from './overlay-stack.js';
import { createTabHostSync } from './element-host.js';

let root = '';
let vault = '';
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'els-host-fu-'));
  vault = join(root, 'Vault');
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, 'a.md'), '# a\n');
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

type Row = { id: string; command?: string[]; state?: string; ptyId?: string };
const fakePanes = (rows: Row[]) => {
  const closed: string[] = [];
  const spawned: string[][] = [];
  let next = 0;
  const sync = createTabHostSync({ cwd: '/home', panes: () => rows, command: (kind, key) => ['bun', 'x.mjs', 'side', 'element', 'host', kind, key],
    newPane: (input) => { const id = `pn${++next}`; spawned.push(input.command); rows.push({ id, command: input.command, state: 'working', ptyId: `h:${id}` }); return { exitCode: 0, message: JSON.stringify({ pane: id, address: `w/t/${id}` }) }; },
    close: (pane) => { closed.push(pane); const at = rows.findIndex((row) => row.id === pane); if (at >= 0) rows.splice(at, 1); } });
  return { sync, closed, spawned, rows };
};
const host = (kind: string, key = 'default'): string[] => ['bun', 'x.mjs', 'side', 'element', 'host', kind, key];
const tabLayer = (id: string, kind: string): OverlayLayer => ({ id, kind, key: 'default', band: 'float', seq: 1, rect: { anchor: 'center', w: '80%', h: '80%' }, focus: 'owns', frame: 'tab' });

test('① frame → tab answers with the host pane; an already-live host is named instead of a second one', () => {
  const panes = fakePanes([{ id: 'p1', command: ['zsh'], state: 'idle', ptyId: 'h:p1' }]);
  const registry = createOverlayRegistry({ dir: join(root, 'one'), context: () => ({ vault }), setTimer: () => 0, clearTimer: () => {}, onTabHosts: panes.sync });
  const id = (JSON.parse(registry.apply({ action: 'open', kind: 'obsidian', props: {} }).message) as { id: string }).id;
  expect(JSON.parse(registry.apply({ action: 'frame', id, frame: 'tab' }).message)).toEqual({ id, kind: 'obsidian', key: 'default', frame: 'tab', pane: 'pn1' });
  expect(JSON.parse(registry.apply({ action: 'frame', id, frame: 'popup' }).message)).toEqual({ id, kind: 'obsidian', key: 'default', frame: 'popup' });
  expect(panes.closed).toEqual(['pn1']);
  // open straight into a tab also names its pane
  expect(JSON.parse(registry.apply({ action: 'open', kind: 'sidechat', props: {}, frame: 'tab' }).message)).toMatchObject({ kind: 'sidechat', frame: 'tab', pane: 'pn2' });
});

test('② restore: a host pane without its PTY is replaced, a live one kept, a stale or exited host closed, shells untouched', () => {
  const panes = fakePanes([
    { id: 'p1', command: ['zsh'], state: 'idle', ptyId: '' },                               // a plain shell that lost its PTY
    { id: 'p2', command: ['zsh'], state: 'working', ptyId: 'h:p2' },
    { id: 'p3', command: host('obsidian'), state: 'idle', ptyId: '' },                       // obsidian's host came back without PTY
    { id: 'p4', command: host('sidechat'), state: 'working', ptyId: 'h:p4' },                // sidechat's host survived (holder)
    { id: 'p5', command: host('files'), state: 'idle', ptyId: 'h:p5' },                      // files is a popup now: stale host
    { id: 'p6', command: host('obsidian'), state: 'exited', ptyId: '' },                     // an exited host row (old server): closed
  ]);
  const hosts = panes.sync.restore([tabLayer('ov1', 'obsidian'), tabLayer('ov2', 'sidechat'), tabLayer('ov3', 'toast'),
    { ...tabLayer('ov4', 'files'), frame: undefined } as OverlayLayer]);
  expect(panes.closed.sort()).toEqual(['p3', 'p5', 'p6']);
  expect(panes.spawned).toEqual([host('obsidian'), host('toast')]);
  expect([...hosts]).toEqual([['ov1', 'pn1'], ['ov2', 'p4'], ['ov3', 'pn2']]);
  expect(panes.rows.map((row) => row.id)).toEqual(['p1', 'p2', 'p4', 'pn1', 'pn2']);
});

test('② restore with no tab layers closes every live host pane and nothing else', () => {
  const panes = fakePanes([{ id: 'p1', command: ['zsh'], state: 'idle', ptyId: '' }, { id: 'p2', command: host('obsidian'), state: 'working', ptyId: 'h:p2' }]);
  expect([...panes.sync.restore([])]).toEqual([]);
  expect(panes.closed).toEqual(['p2']);
  expect(panes.spawned).toEqual([]);
});
