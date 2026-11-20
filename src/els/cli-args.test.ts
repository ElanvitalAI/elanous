import { expect, test } from 'bun:test';
import { misplacedOptionHint, withNewDefaults } from './cli-args.js';
import { keyBytes, keysToBytes } from './keys.js';
import { herdrCreated, herdrPanes, herdrTabs, herdrWorkspaces } from './herdr-shape.js';

test('new defaults: no command → $SHELL, no cwd → here, no ws → the folder name; given values win', () => {
  expect(withNewDefaults({ command: [] }, { SHELL: '/bin/zsh' }, '/Users/me/proj')).toEqual({ ws: 'proj', cwd: '/Users/me/proj', command: ['/bin/zsh'] });
  expect(withNewDefaults({ command: [] }, {}, '/work').command).toEqual(['/bin/sh']);
  expect(withNewDefaults({ ws: 'HQ', cwd: '/x', title: 't', command: ['eln', '-c'] }, { SHELL: '/bin/zsh' }, '/work'))
    .toEqual({ ws: 'HQ', cwd: '/x', command: ['eln', '-c'], title: 't' });
});

test('an els option right after the command name is explained; later words, a given option and --raw are left alone', () => {
  expect(misplacedOptionHint({ command: ['sh', '--cwd', '/x'] })).toContain('must come before --');
  expect(misplacedOptionHint({ command: ['sh', '--ws=HQ'] })).toContain('--ws');
  expect(misplacedOptionHint({ cwd: '/y', command: ['bun', '--cwd', '/x'] })).toBeUndefined();   // --cwd was given before --
  expect(misplacedOptionHint({ raw: true, command: ['bun', '--cwd', '/x', 'run', 'dev'] })).toBeUndefined();
  expect(misplacedOptionHint({ command: ['bun', 'run', '--cwd', '/x', 'dev'] })).toBeUndefined();   // not right after the command
  expect(misplacedOptionHint({ command: ['sh', '-c', 'ls'] })).toBeUndefined();
  expect(misplacedOptionHint({ command: [] })).toBeUndefined();
});

test('send-keys: the allowlist is separate from the person path — harmless keys only, whole-validated', () => {
  // #90792 P0 ② — esc, ctrl+<key> (ctrl+c, the interrupt, among them) and alt+<key> are control keys a
  // script must not press; enter and the editing/navigation keys are all it gets.
  expect(keyBytes('Enter')).toBe('\r');
  expect(keyBytes('ctrl+c')).toBeUndefined();
  expect(keyBytes('ctrl+d')).toBeUndefined();
  expect(keyBytes('esc')).toBeUndefined();
  expect(keyBytes('escape')).toBeUndefined();
  expect(keyBytes('alt+x')).toBeUndefined();
  expect(keyBytes('up')).toBe('\x1b[A');
  expect(keyBytes('x')).toBe('x');
  expect(keyBytes('ctrl+1')).toBeUndefined();
  expect(keyBytes('pageup')).toBe('\x1b[5~');
  expect(keyBytes('shift+tab')).toBe('\x1b[Z');
  expect(keysToBytes(['enter', 'up'])).toEqual({ bytes: '\r\x1b[A' });
  expect(keysToBytes(['ctrl+c', 'enter'])).toEqual({ unknown: 'ctrl+c' });      // refused before enter: nothing is sent
  expect(keysToBytes(['esc', 'bogus', 'enter'])).toEqual({ unknown: 'esc' });  // esc is the first refused key now
});

test('herdr-shaped JSON: *_id fields under result, workspace filter, creation shape', () => {
  const listed = { workspaces: [{ id: 'w1', name: 'HQ', rootCwd: '/work', host: 'local' }], tabs: [{ id: 't1', workspaceId: 'w1', label: 'sh', focusPaneId: 'p1' }],
    panes: [{ address: 'mshq:w1/t1/p1', workspace: 'HQ', tab: 't1', pane: 'p1', title: 'sh', cwd: '/work', state: 'idle', host: 'mshq', reach: 'local' },
      { address: 'node-b:w9/t9/p9', workspace: '', tab: 't9', pane: 'p9', title: 'gate', cwd: '/g', state: 'working', host: 'node-b', reach: 'up' }] };
  const panes = (herdrPanes(listed) as { result: { panes: { pane_id: string; workspace_id: string }[] } }).result.panes;
  expect(panes.map((row) => [row.pane_id, row.workspace_id])).toEqual([['p1', 'w1'], ['p9', 'w9']]);
  expect((herdrPanes(listed, 'w1') as { result: { panes: unknown[] } }).result.panes).toHaveLength(1);
  expect(herdrWorkspaces(listed)).toEqual({ result: { workspaces: [{ workspace_id: 'w1', name: 'HQ', cwd: '/work', host: 'local' }] } });
  expect(herdrTabs(listed, 'w2')).toEqual({ result: { tabs: [] } });
  const created = herdrCreated({ address: 'w1/t1/p1', pane: 'p1', ptyId: 'x', cwd: '/work' }) as { result: { pane: { pane_id: string }; root_pane: { pane_id: string }; tab: { tab_id: string } } };
  expect([created.result.pane.pane_id, created.result.root_pane.pane_id, created.result.tab.tab_id]).toEqual(['p1', 'p1', 't1']);
});
