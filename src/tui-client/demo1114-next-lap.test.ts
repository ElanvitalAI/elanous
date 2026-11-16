import { expect, test } from 'bun:test';
import { createChildPluginRuntimeContract } from '../cli/child-plugin-runtime.js';
import { buildReplTools } from '../repl/index.js';
import { CAPABILITY_SEARCH_NAME, takeHydratedTools } from '../skills/tools/tool-search-spec.js';

test('demo Next route discovers the scene tools and consumes only a saved Scene 2 briefing', async () => {
  const graphId = 'absorb-brief';
  const calls: Array<{ graphId: string; owner?: string }> = [];
  const graph = {
    graphId, status: 'done', runId: 'demo-next-run', nodes: [
      { nodeId: 'brief', output: JSON.stringify({ evidence: { memberId: 'member-demo', briefing: {
        id: 'brief-demo', summary: '동시 접속과 공정 대기열', scrapIds: ['scrap-demo'],
      } } }) },
      { nodeId: 'save-brief', ok: true, executed: true, output: JSON.stringify({ result: { stored: true } }) },
    ],
  };
  const runtime = createChildPluginRuntimeContract({
    verifiedOwner: { id: 'member-demo' },
    dispatchGraph: async (_pluginId, routedGraphId, _graphFile, _args, context) => {
      calls.push({ graphId: routedGraphId, owner: context?.verifiedOwner?.id });
      return graph;
    },
  });
  const tools = buildReplTools({ pluginRuntime: runtime });
  for (const [query, expected] of [
    ['route:이 기사 스크랩해줘', 'scrap_add'],
    ['route:오늘 브리핑', 'brief_today'],
    ['route:제안 목록', 'suggest_list'],
    ['route:GCP 확장안', 'gcp_architect_expand'],
  ] as const) {
    const discovered = takeHydratedTools(await tools.dispatch(CAPABILITY_SEARCH_NAME, { query }));
    expect(discovered.map(tool => tool.name)).toContain(expected);
    expect(tools.specs.some(tool => tool.name === expected)).toBe(true);
  }
  const result = await tools.dispatch('brief_today', {});
  expect(calls).toEqual([{ graphId, owner: 'member-demo' }]);
  expect(result).toMatchObject({ graphId, runId: 'demo-next-run',
    output: expect.stringContaining('출처 스크랩: scrap-demo') });
  graph.status = 'failed';
  const failed = await tools.dispatch('brief_today', {});
  expect(calls).toHaveLength(2);
  expect(JSON.stringify(failed)).not.toContain('흡수·브리핑 완료');
});
