import { afterEach, expect, test } from 'bun:test';
import { registerAllDefaultToolRuntimes } from './index.js';
import { _resetToolRuntimeRegistryForTest, listToolRuntimes } from './registry.js';
import { createElanousLinearIssueRuntime } from './elanous-linear-issue-runtime.js';

afterEach(() => _resetToolRuntimeRegistryForTest());

test('registers the mutating Linear issue tool on TUI and MCP', () => {
  registerAllDefaultToolRuntimes();
  expect(listToolRuntimes('tui').map(runtime => runtime.id)).toContain('elanous_linear_issue');
  expect(listToolRuntimes('mcp').map(runtime => runtime.id)).toContain('elanous_linear_issue');
});

test('routes only the selected create, comment and complete action', async () => {
  const calls: string[] = [];
  const runtime = createElanousLinearIssueRuntime({
    getApiKey: async id => { calls.push(`key:${id}`); return 'secret'; },
    create: async input => { calls.push(`create:${input.teamKey}:${input.title}`); return 'issue-1'; },
    comment: async input => { calls.push(`comment:${input.issueId}:${input.body}`); },
    complete: async input => { calls.push(`complete:${input.issueId}:${input.type}`); },
  });
  expect(await runtime.run({ action: 'create', teamKey: 'DEMO', title: 'example' }, { surface: 'tui' } as never))
    .toMatchObject({ ok: true, issueId: 'issue-1' });
  expect(await runtime.run({ action: 'comment', issueId: 'issue-1', body: 'done' }, { surface: 'tui' } as never))
    .toMatchObject({ ok: true });
  expect(await runtime.run({ action: 'complete', issueId: 'issue-1' }, { surface: 'tui' } as never))
    .toMatchObject({ ok: true });
  expect(calls).toEqual([
    'key:connector.linear.apiKey', 'create:DEMO:example',
    'key:connector.linear.apiKey', 'comment:issue-1:done',
    'key:connector.linear.apiKey', 'complete:issue-1:completed',
  ]);
});

test('rejects incomplete inputs before making a Linear mutation', async () => {
  let mutations = 0;
  const runtime = createElanousLinearIssueRuntime({ getApiKey: async () => 'secret',
    create: async () => { mutations++; return 'issue'; }, comment: async () => { mutations++; }, complete: async () => { mutations++; } });
  expect(await runtime.run({ action: 'create', teamKey: '', title: 'x' }, { surface: 'tui' } as never)).toMatchObject({ ok: false });
  expect(await runtime.run({ action: 'comment', issueId: 'x', body: '  ' }, { surface: 'tui' } as never)).toMatchObject({ ok: false });
  expect(await runtime.run({ action: 'complete', issueId: '' }, { surface: 'tui' } as never)).toMatchObject({ ok: false });
  expect(mutations).toBe(0);
});
