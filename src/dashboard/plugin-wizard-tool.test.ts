import { expect, test } from 'bun:test';
import { createTuiPluginWizardTool, TUI_PLUGIN_WIZARD_TOOL_NAME } from './plugin-wizard-tool.js';
import { searchAvailablePluginWizardTools } from './plugin-wizard-runtime.js';

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

test('StartPluginWizard is blocked when ToolSearch finds a callable matching tool', async () => {
  let starts = 0;
  const specs = [{
    name: 'elanous_linear_issue',
    description: 'Perform one Linear issue action: create, comment, or complete an issue.',
    parameters: { type: 'object' },
  }] as never[];
  const tool = createTuiPluginWizardTool(async () => { starts++; }, {
    createId: () => 'unused',
    findAvailableTools: capability => searchAvailablePluginWizardTools(capability, specs),
  });
  const result = await tool.dispatchTool(TUI_PLUGIN_WIZARD_TOOL_NAME, {
    mission: 'Create the requested issue',
    missing: 'linear issue',
  });
  expect(result).toMatchObject({ status: 'error', body: expect.stringContaining('ToolSearch found matching available tool(s): ElanousLinearIssue') });
  await Promise.resolve();
  expect(starts).toBe(0);
});

test('StartPluginWizard can proceed when a matching tool is unavailable to the session', async () => {
  let starts = 0;
  const specs = [{ name: 'elanous_linear_issue', description: 'Linear issue create action', parameters: { type: 'object' } }] as never[];
  const matches = searchAvailablePluginWizardTools('linear issue', specs, { elanous_linear_issue: false });
  const tool = createTuiPluginWizardTool(async () => { starts++; }, {
    createId: () => 'wizard-run-2',
    findAvailableTools: () => matches,
  });
  await expect(tool.dispatchTool(TUI_PLUGIN_WIZARD_TOOL_NAME, { mission: 'Create one', missing: 'linear issue' }))
    .resolves.toMatchObject({ status: 'running', id: 'wizard-run-2' });
  await Promise.resolve();
  expect(starts).toBe(1);
});

test('StartPluginWizard rejects malformed tool input without starting work', async () => {
  let starts = 0;
  const tool = createTuiPluginWizardTool(async () => { starts++; }, () => 'unused');
  await expect(tool.dispatchTool(TUI_PLUGIN_WIZARD_TOOL_NAME, { mission: 'Do it', missing: 'tool', extra: true }))
    .resolves.toMatchObject({ status: 'error', body: 'arguments contain unsupported fields' });
  expect(starts).toBe(0);
});
