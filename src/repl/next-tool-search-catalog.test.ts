import { expect, test } from 'bun:test';
import { buildReplTools } from './index.js';
import { TOOL_SEARCH_NAME } from '../skills/tools/tool-search-spec.js';

test('Next REPL advertises the routed ToolSearch exactly once so model calls pass catalog validation', async () => {
  const tools = buildReplTools();
  expect(tools.specs.filter(spec => spec.name === TOOL_SEARCH_NAME)).toHaveLength(1);
  const result = await tools.dispatch(TOOL_SEARCH_NAME, { query: 'route:GCP 확장안' });
  expect(JSON.stringify(result)).toContain('gcp_architect_expand');
});
