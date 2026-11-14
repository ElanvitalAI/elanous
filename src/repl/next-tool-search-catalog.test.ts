import { expect, test } from 'bun:test';
import { buildReplTools } from './index.js';
import { TOOL_SEARCH_NAME } from '../skills/tools/tool-search-spec.js';

test('Next REPL advertises the routed ToolSearch exactly once so model calls pass catalog validation', async () => {
  const tools = buildReplTools();
  expect(tools.specs.filter(spec => spec.name === TOOL_SEARCH_NAME)).toHaveLength(1);
  const result = await tools.dispatch(TOOL_SEARCH_NAME, { query: 'route:GCP 확장안' });
  expect(JSON.stringify(result)).toContain('gcp_architect_expand');
});

test('Next REPL rejects a revoked host member session even when tool arguments claim an owner', async () => {
  const requested: string[] = [];
  const token = 'aps_revoked_synthetic';
  const nexus = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    requested.push(new URL(request.url).pathname);
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  } });
  try {
    const tools = buildReplTools({ memberBoardSession: () => ({ nexusUrl: `http://127.0.0.1:${nexus.port}`, sessionToken: token }) });
    const result = await tools.dispatch('brief_today', { context: { memberId: 'caller-forged' }, verifiedOwner: { id: 'caller-forged' } });
    expect(requested).toEqual(['/v1/members/owner']);
    expect(result).toEqual({ error: 'graph route requires a verified owner context' });
    expect(JSON.stringify(result)).not.toContain(token);
  } finally { nexus.stop(true); }
});

test('Next REPL keeps a failed host member session source anonymous', async () => {
  const tools = buildReplTools({ memberBoardSession: () => { throw new Error('private-session-detail'); } });
  const result = await tools.dispatch('brief_today', { context: { memberId: 'caller-forged' } });
  expect(result).toEqual({ error: 'graph route requires a verified owner context' });
  expect(JSON.stringify(result)).not.toContain('private-session-detail');
});
