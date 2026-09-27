import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { matchTextInputGlobalAction } from '../src/chat/global-actions.js';
import type { Key } from '../src/tui.js';

const root = resolve(import.meta.dir, '..');
const source = (name: string): string => readFileSync(resolve(root, name), 'utf8');
const retired = [
  'input/mouse-workspace-restore|runtime',
  'input/virtual-window-key|router',
  'virtual-window-control|runtime',
  'virtual-window-help|runtime',
  'virtual-window-input|runtime',
  'virtual-window-mutation|runtime',
  'virtual-window-split|runtime',
  'vw-popup|openers',
  'window-picker|popup',
  'window-slash|runtime',
  'windowing/companion|slash',
  'windowing/visibility|chord',
].map((parts) => parts.replace('|', '-'));

test('retired dashboard VW surface files and their index imports are absent', () => {
  const index = source('src/dashboard/index.ts');
  for (const module of retired) {
    expect(existsSync(resolve(root, `src/dashboard/${module}.ts`))).toBe(false);
    expect(index).not.toContain(`./${module}.js`);
  }
  for (const file of ['src/dashboard/browser-help-runtime.ts', 'src/dashboard/index.ts']) {
    const text = source(file);
    for (const module of retired) {
      expect(text).not.toContain(`${module}.js`);
    }
  }
  for (const preserved of ['windowing/lifecycle.ts', 'windowing/virtual-windows.ts', 'windowing/fast-switch.ts']) {
    expect(existsSync(resolve(root, `src/dashboard/${preserved}`))).toBe(true);
  }
});

test('VW prefix and modal chords are not registered, without removing the input route', () => {
  const index = source('src/dashboard/index.ts');
  expect(index).not.toContain('dashboard:vw-chord:');
  expect(index).not.toContain('dashboard:pane-modal-chord:');
  expect(index).not.toContain('routePopupCloseChord:');
  expect(index).toContain('allowSpawnTerminalModal: false');
  expect(index).toContain('allowToggleLogZoom: false');
  expect(index).not.toContain('routeVwTerminalKey:');
  expect(index).toContain('const inputLoopControl =');
});

test('retired popup and zoom chords do not match dashboard global actions', () => {
  for (const key of [
    { name: 't', ctrl: true, shift: true },
    { name: 't', ctrl: false, shift: false, alt: true },
    { name: 'z', ctrl: true, shift: true },
    { name: 'z', ctrl: false, shift: false, alt: true },
  ] satisfies Key[]) {
    expect(matchTextInputGlobalAction(key, {
      allowSpawnTerminalModal: false,
      allowToggleLogZoom: false,
    })).toBeNull();
  }
});
