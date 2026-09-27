import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { ptyAvailable } from './pty-shell/registry.js';
import { nativeToolCatalog, listNativeToolsForHost } from './native-tool-catalog.js';

test('virtual-window control and context tools are absent while essential tools remain', () => {
  const names = new Set(nativeToolCatalog.flatMap(tool => [tool.id, tool.displayName, ...tool.aliases]));
  for (const name of [
    'ControlWindowResize', 'ControlPaneResize', 'ControlPaneLayout',
    'ContextWindowsList', 'ContextWindowDetail', 'ContextPaneDetail',
    'control_window_resize', 'control_pane_resize', 'control_pane_layout',
    'context_windows_list', 'context_window_detail', 'context_pane_detail',
  ]) expect(names.has(name)).toBe(false);
  for (const name of ['ControlToolToggle', 'ControlPromptAppend', 'ControlPromptClear', 'GetDashboardState', 'ContextBootstrap']) {
    expect(names.has(name)).toBe(true);
  }
  const mcpNames = new Set(listNativeToolsForHost('mcp').flatMap(tool => [tool.id, tool.displayName, ...tool.aliases]));
  for (const name of ['ContextWindowsList', 'ContextWindowDetail', 'ContextPaneDetail']) {
    expect(mcpNames.has(name)).toBe(false);
  }
  expect(mcpNames.has('GetDashboardState')).toBe(true);
  expect(mcpNames.has('ContextBootstrap')).toBe(true);
});

describe('solve_mission native catalog entry', () => {
  test('names self-implement as the default and staged as explicit option', () => {
    const entry = nativeToolCatalog.find((tool) => tool.id === 'solve_mission');
    expect(entry).toBeDefined();
    expect(entry!.description).toContain('default executor is self-implement');
    expect(entry!.description).toContain('executor: "staged"');
    expect(entry!.description).not.toContain('through the full staged harness');
    expect(entry!.promptSummary).toContain('self-implement default');
    expect(entry!.promptSummary).toContain('executor: staged explicitly selects');
  });
});

describe('PTY native catalog probes', () => {
  const ptyProbes = nativeToolCatalog
    .map((tool) => ({ tool, probe: tool.probe }))
    .filter((entry) => entry.probe?.kind === 'custom' && entry.probe.custom === ptyAvailable);

  test('delegate to the canonical availability function without changing probe policy', () => {
    expect(ptyProbes).toHaveLength(29);
    for (const { probe } of ptyProbes) {
      expect(probe).toMatchObject({ kind: 'custom', custom: ptyAvailable, onFail: 'hide', ttlMs: 300_000 });
    }
  });

  test.each([true, false])('return the controlled canonical availability outcome: %s', (available) => {
    const script = `import { mock } from 'bun:test';
const value = ${available};
const ptyAvailable = () => value;
mock.module('./src/pty-shell/registry.js', () => ({ ptyAvailable }));
const { nativeToolCatalog } = await import('./src/native-tool-catalog.ts');
const probes = nativeToolCatalog.filter((tool) => tool.probe?.kind === 'custom' && tool.probe.custom === ptyAvailable);
if (probes.length !== 29 || probes.some((tool) => tool.probe?.custom() !== value)) process.exit(1);`;
    const result = spawnSync(process.execPath, ['-e', script], { cwd: process.cwd(), encoding: 'utf8' });
    expect(result.status).toBe(0);
  });
});
