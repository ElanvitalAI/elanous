import { beforeEach, describe, expect, test } from 'bun:test';
import { registerAllDefaultToolRuntimes } from './index.js';
import {
  _resetToolRuntimeRegistryForTest,
  dispatchToolByName,
  getToolRuntime,
  listToolRuntimes,
} from './registry.js';
import { SELF_COGNITION_TOOL_NAMES } from './self-cognition-runtimes.js';

describe('self-cognition runtime registry wiring', () => {
  beforeEach(() => {
    _resetToolRuntimeRegistryForTest();
    registerAllDefaultToolRuntimes();
  });

  test('lists every ledger entry for MCP', () => {
    const mcpNames = new Set(listToolRuntimes('mcp').map(runtime => runtime.id));
    for (const name of SELF_COGNITION_TOOL_NAMES) expect(mcpNames).toContain(name);
  });

  test('omits retired virtual-window control and context runtimes on every surface', () => {
    for (const id of [
      'control_window_resize', 'control_pane_resize', 'control_pane_layout',
      'context_windows_list', 'context_window_detail', 'context_pane_detail',
    ]) expect(getToolRuntime(id)).toBeUndefined();
    for (const id of ['control_tool_toggle', 'control_prompt_append', 'control_prompt_clear', 'dashboard_state', 'context_bootstrap']) {
      expect(getToolRuntime(id)?.id).toBe(id);
    }
  });

  test('keeps browser runtimes out of the MCP proxy registry', () => {
    const mcpNames = new Set(listToolRuntimes('mcp').map(runtime => runtime.id));

    expect(mcpNames.has('browser_navigate')).toBe(false);
    expect(mcpNames.has('browser_read')).toBe(false);
    expect(mcpNames.has('browser_open')).toBe(false);
    expect(mcpNames.has('browser_screenshot')).toBe(false);
    expect(mcpNames.has('browser_close')).toBe(false);
  });

  test('dispatches a listed self-cognition tool through the registry', async () => {
    const result = await dispatchToolByName('memory_recall', {}, { surface: 'mcp' });
    expect(result).toEqual(expect.any(Object));
    expect('hits' in result || 'error' in result).toBe(true);
  });
});
