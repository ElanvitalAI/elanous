import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { matchTextInputGlobalAction } from '../src/chat/global-actions.js';
import type { Key } from '../src/tui.js';
import { buildDashboardSlashRegistry } from '../src/dashboard/slash-runtime/dashboard-handlers.js';

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

test('retired virtual-window implementation and picker are absent', () => {
  const legacy = 'virtual-' + 'windows';
  expect(existsSync(resolve(root, 'src', legacy))).toBe(false);
  expect(existsSync(resolve(root, 'src/window-picker-modal.ts'))).toBe(false);
  const guard = source('src/tui-client/headless-core-guard.ts');
  const address = source('src/element-registry/address.ts');
  const ssh = source('src/ssh/ssh-picker-modal.ts');
  expect(guard).not.toContain(`'../${legacy}/'`);
  expect(address).not.toContain(`${legacy}/addressing.ts`);
  expect(ssh).not.toContain('window-picker-modal');
  const publicBaseline = source('scripts/public-leak-baseline.txt');
  const homeBaseline = source('test/test-home-state-write-audit-baseline.txt');
  expect(publicBaseline).not.toContain(`src/${legacy}/`);
  expect(publicBaseline).not.toContain(`test/${legacy}-skip-store-alt.test.ts`);
  expect(homeBaseline).not.toContain(`test/${legacy}/layout/persistence.test.ts`);
});

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
  for (const removed of ['windowing/lifecycle.ts', 'windowing/virtual-windows.ts', 'windowing/fast-switch.ts', 'agent-spawn-tools-boot.ts']) {
    expect(existsSync(resolve(root, `src/dashboard/${removed}`))).toBe(false);
  }
});

test('dashboard boot and input do not import or read virtual windows', () => {
  const index = source('src/dashboard/index.ts');
  const layout = source('src/dashboard/layout-display-runtime-registration.ts');
  const handlers = source('src/dashboard/slash-runtime/dashboard-handlers.ts');
  for (const text of [index, layout, handlers]) {
    expect(text).not.toMatch(/virtual-windows|windowing\/virtual-windows|window-picker-modal|resident-vw|benchmark-preset/);
  }
  expect(index).not.toMatch(/initDashboardVirtualWindows|virtualWindows\.registry|registerPaneContentKind\('vw-browser'/);
  expect(layout).not.toMatch(/registerLayoutRuntimes|windowRegistry/);
  expect(handlers).not.toMatch(/registry\.register\('bench'/);
  expect(index).toContain('vw: null,');
  expect(index).toContain('currentVwId: null,');
  expect(index).toContain('const vwLocalComposerActive = false;');
  expect(index).not.toContain('enablePtyHosts:');
  expect(index).not.toContain('createExternalTerminalPaneContent');
  expect(index).not.toContain('createRunnerHostFactory');
  expect(source('src/surface/shell-runner-boot.ts')).not.toContain('enablePtyHosts');
  expect(source('src/shell-runner/index.ts')).not.toContain('createExternalTerminalPaneContent');
  expect(existsSync(resolve(root, 'src/shell-runner/external-terminal-pane.ts'))).toBe(false);
  expect(index).not.toContain('registerPaneContentKind: () => {}');
  expect(index).not.toContain('spawnBrowserVirtualWindow: () => {}');
  expect(index).not.toContain('openVwCompanion: () => {}');
  expect(source('src/dashboard/compact-surface-inventory.ts')).not.toContain("id: 'vw:");
  expect(source('src/dashboard-pane-context-menu.ts')).not.toContain("id: 'dashboard-pane.open-vw'");
  expect(index).not.toContain('switchToVirtualWindow: () => {}');
  expect(index).not.toContain('virtualWindowsSwitchTo: () => {}');
  expect(index).toContain('Unknown command: /${cmdLower}');
});

test('VW spawn slashes and /bench are unregistered while /help remains available', async () => {
  const registry = buildDashboardSlashRegistry();
  for (const command of ['bench', 'acp-vw', 'claude-vw', 'codex-vw']) {
    expect(registry.has(command)).toBe(false);
    expect(await registry.dispatch(command, ['codex'], {} as never)).toEqual({ kind: 'unregistered' });
  }
  expect(registry.has('help')).toBe(true);
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
