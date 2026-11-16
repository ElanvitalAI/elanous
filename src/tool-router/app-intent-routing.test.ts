import { expect, test } from 'bun:test';
import { buildReplTools } from '../repl/index.js';
import { takeHydratedTools, TOOL_SEARCH_NAME } from '../skills/tools/tool-search-spec.js';

// Exercise the real surface catalog and manifest route index, not a synthetic index.
test.each([
    '도서관 시스템을 만들어서 가상 데이터로 채워 넣고 배포해줘',
    '설문 앱을 만들어서 시험하고 배포해줘',
    '재고 앱 만들어 배포해줘',
    'Build an app with frontend backend database and seed data, test it then deploy app',
    'create an app for library loans and deploy app',
] )('new application intent routes to app_build: %s', async (request) => {
  const tools = buildReplTools();
  const result = await tools.dispatch(TOOL_SEARCH_NAME, { query: 'route:' + request });
  expect(takeHydratedTools(result).map(tool => tool.name)).toEqual(['app_build']);
});

test('existing-artifact deployment and exact selection retain their separate tool', async () => {
  const tools = buildReplTools();
  for (const request of ['등록된 앱 배포해줘', '기존 앱 산출물을 배포해줘', 'deploy existing app', 'deploy app']) {
    const result = await tools.dispatch(TOOL_SEARCH_NAME, { query: 'route:' + request });
    expect(takeHydratedTools(result).map(tool => tool.name)).toEqual(['app_deploy']);
  }
  for (const name of ['app_build', 'app_deploy']) {
    const result = await tools.dispatch(TOOL_SEARCH_NAME, { query: 'select:' + name });
    expect(takeHydratedTools(result).map(tool => tool.name)).toEqual([name]);
  }
});
