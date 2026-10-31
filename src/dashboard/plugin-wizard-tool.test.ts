import { expect, test } from 'bun:test';
import { createTuiPluginWizardTool, TUI_PLUGIN_WIZARD_TOOL_NAME } from './plugin-wizard-tool.js';

test('StartPluginWizard returns a run id immediately and starts one background request', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const starts: unknown[] = [];
  const tool = createTuiPluginWizardTool(async (request) => { starts.push(request); await pending; }, () => 'wizard-run-1');
  const catalog = tool.getTools([]);
  expect(catalog.map(({ name }) => name)).toEqual([TUI_PLUGIN_WIZARD_TOOL_NAME]);

  const result = await tool.dispatchTool(TUI_PLUGIN_WIZARD_TOOL_NAME, { mission: 'Finish the task', missing: 'csv export' }, { callId: 'tui-call-1' });
  expect(result).toMatchObject({ status: 'running', id: 'wizard-run-1' });
  await Promise.resolve();
  expect(starts).toEqual([{ runId: 'wizard-run-1', mission: 'Finish the task', missing: 'csv export', context: { callId: 'tui-call-1' } }]);
  release();
});

test('StartPluginWizard rejects malformed tool input without starting work', async () => {
  let starts = 0;
  const tool = createTuiPluginWizardTool(async () => { starts++; }, () => 'unused');
  await expect(tool.dispatchTool(TUI_PLUGIN_WIZARD_TOOL_NAME, { mission: 'Do it', missing: 'tool', extra: true }))
    .resolves.toMatchObject({ status: 'error', body: 'arguments contain unsupported fields' });
  expect(starts).toBe(0);
});
