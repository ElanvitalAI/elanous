import { expect, test } from 'bun:test';
import { buildReplTools } from './index.js';
import { CAPABILITY_SEARCH_NAME, takeHydratedTools, TOOL_SEARCH_NAME } from '../skills/tools/tool-search-spec.js';

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

test('Next REPL advertises capability_search once and routes discovery into callable surface schemas', async () => {
  const tools = buildReplTools();
  expect(tools.specs.filter(spec => spec.name === CAPABILITY_SEARCH_NAME)).toHaveLength(1);
  const result = await tools.dispatch(CAPABILITY_SEARCH_NAME, { query: 'route:GCP 확장안' });
  const hydrated = takeHydratedTools(result);
  expect(hydrated.map(tool => tool.name)).toContain('gcp_architect_expand');
  expect(hydrated.every(tool => tools.specs.some(spec => spec.name === tool.name))).toBe(true);
  const absent = await tools.dispatch(CAPABILITY_SEARCH_NAME, { query: 'select:unregistered_synthetic_capability' });
  expect(takeHydratedTools(absent)).toEqual([]);
});

test('general capability search rejects incidental words but preserves explicit app intent and exact hydration', async () => {
  const tools = buildReplTools();
  for (const query of ['도서관 대출 상태 조회', '병원 예약 기록 조회', '사내 설문 결과를 분석해 줘']) {
    expect(takeHydratedTools(await tools.dispatch(CAPABILITY_SEARCH_NAME, { query }))).toEqual([]);
  }
  const app = takeHydratedTools(await tools.dispatch(CAPABILITY_SEARCH_NAME,
    { query: 'Solar Pro로 앱 구현하고 배포해 줘' }));
  expect(app.map(tool => tool.name)).toContain('app_deploy');
  expect(app.map(tool => tool.name)).not.toContain('scrap_add');
  expect(takeHydratedTools(await tools.dispatch(CAPABILITY_SEARCH_NAME,
    { query: 'select:app_deploy' })).map(tool => tool.name)).toEqual(['app_deploy']);
});

test('unmatched project context does not hide registered capabilities in a long natural request', async () => {
  const tools = buildReplTools();
  const result = await tools.dispatch(CAPABILITY_SEARCH_NAME, {
    query: 'Project Quartz inventory portal for our regional team with unfamiliar catalog fields, custom workflows and a private staging environment: build frontend backend database tests then deploy app',
  });
  expect(takeHydratedTools(result).map(tool => tool.name)).toContain('app_deploy');
  const representative = await tools.dispatch(CAPABILITY_SEARCH_NAME, {
    query: '이 폴더에서 콘서트 티케팅 시스템을 만들어줘. 프론트엔드, 백엔드 시스템을 설계하고 실제 배포해줘',
  });
  expect(takeHydratedTools(representative).map(tool => tool.name)).toContain('app_deploy');
});

test('short Korean app requests preserve one-letter subject words and polite verb variants', async () => {
  const tools = buildReplTools();
  for (const query of ['도서관 대출 앱 만들어줘', '병원 예약 앱 만들어 줘', '사내 설문 앱 개발해줘']) {
    expect(takeHydratedTools(await tools.dispatch(CAPABILITY_SEARCH_NAME, { query }))
      .map(tool => tool.name)).toContain('app_deploy');
  }
});

test('Korean particle variants retain app discovery without unrelated member tools', async () => {
  const tools = buildReplTools();
  for (const query of ['도서관 앱을 만들어줘', '도서관앱을만들어줘', '병원 예약 앱을 개발해줘', '사내 설문 앱으로 만들어줘', '사내설문앱으로만들어줘', '도서관앱을게시해줘']) {
    const names = takeHydratedTools(await tools.dispatch(CAPABILITY_SEARCH_NAME, { query })).map(tool => tool.name);
    expect(names).toContain('app_deploy');
    for (const unrelated of ['scrap_add', 'brief_today', 'suggest_list', 'suggest_accept']) expect(names).not.toContain(unrelated);
  }
});
