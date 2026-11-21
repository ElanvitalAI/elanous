import { afterEach, expect, test } from 'bun:test';
import { buildReplTools } from './index.js';

const originalSocket = process.env.ELANOUS_ELS_SOCKET;

afterEach(() => {
  if (originalSocket === undefined) delete process.env.ELANOUS_ELS_SOCKET;
  else process.env.ELANOUS_ELS_SOCKET = originalSocket;
});

test('Next TUI advertises ElsControl only with an els socket, and routes calls to its existing door', async () => {
  delete process.env.ELANOUS_ELS_SOCKET;
  expect(buildReplTools({ nextTui: true }).specs.some(spec => spec.name === 'ElsControl')).toBe(false);

  process.env.ELANOUS_ELS_SOCKET = '/tmp/els-control-unreachable.sock';
  expect(buildReplTools().specs.some(spec => spec.name === 'ElsControl')).toBe(false);
  const tools = buildReplTools({ nextTui: true });
  expect(tools.specs.filter(spec => spec.name === 'ElsControl')).toHaveLength(1);
  const result = await tools.dispatch('ElsControl', { action: 'read', pane: 'missing' });
  expect(JSON.parse(String(result))).toMatchObject({ tool: 'ElsControl', action: 'read', allowed: false, code: 'lookup-failed' });
});
