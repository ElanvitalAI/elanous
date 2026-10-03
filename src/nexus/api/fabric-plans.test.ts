import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFabricPlan, listFabricExecutionCandidates, loadFabricPlan, type FabricPlan } from '../../self-dev/fabric-plan-core.js';
import { runStewardStage } from '../../steward/triage.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { NexusEventBus } from './event-bus.js';
import { startNexusHttpServer } from './http-server.js';
import { isPublicRoute } from './public-routes.js';

const root = mkdtempSync(join(tmpdir(), 'nexus-fabric-plans-'));
const previousStateDir = process.env.ELANOUS_STATE_DIR;
process.env.ELANOUS_STATE_DIR = root;
const request = '경쟁사를 조사하고 기능을 개발한 뒤 배포하고 영상으로 홍보한다';
const headings = ['경쟁 조사', '기능 개발', '배포', '영상 제작'];
const authored = ['# RFC', '```work-breakdown', ...headings.flatMap((heading, i) => [
  `### 아크 ${i + 1}: ${heading}`, `- title: ${heading} 작업`, `  detail: ${heading} 결과물`,
]), '```'].join('\n');
let decompositions = 0;
const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
const server = startNexusHttpServer({
  state, registry: new TabRegistry(state), eventBus: new NexusEventBus(),
  startPort: 48000 + Math.floor(Math.random() * 1000),
  metaApi: { bearerToken: 'owner-secret', noAuth: false },
  fabricPlans: {
    create: (path, text) => createFabricPlan(path, text, {
      ground: async () => ({ documentLines: ['Grounded research'], memoryCount: 0, localSourceCount: 1,
        repositorySourceCount: 0, genericSearchScope: false, localReferenceAttempts: [],
        externalCount: 0, externalStatus: 'unavailable' }),
      resolve: async () => authored,
      decomposeGoal: async () => {
        decompositions++;
        return { goals: [{ id: 'work', feature: 'Update src/self-dev/fabric-decompose-adapter.ts' }],
          decomposition: { recommendedMaxTasks: 6, actualTaskCount: 1, truncatedAtHardMax: false,
            exceededRecommendedMax: false, outcome: 'decomposed' } };
      },
    }),
  },
});
afterAll(() => {
  server.stop();
  if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = previousStateDir;
  rmSync(root, { recursive: true, force: true });
});

function call(path: string, method = 'GET', body?: unknown, authorized = true): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    method,
    headers: { 'sec-fetch-site': 'cross-site', ...(authorized ? { authorization: 'Bearer owner-secret' } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
}

test('private daemon HTTP decomposes a compound request into a persisted tree; only approval offers one execution candidate', async () => {
  for (const [method, path] of [['POST', '/v1/fabric/decompose'], ['GET', '/v1/fabric/plans/abc'],
    ['POST', '/v1/fabric/plans/abc/approve']] as const) {
    expect(isPublicRoute(method, path, { setupMode: false })).toBe(false);
    expect((await call(path, method, method === 'POST' ? { request } : undefined, false)).status).toBe(401);
  }
  expect(decompositions).toBe(0);
  expect((await fetch(`${server.url}/v1/fabric/decompose`, {
    method: 'POST', headers: { authorization: 'Bearer wrong-secret', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
    body: JSON.stringify({ request }),
  })).status).toBe(401);
  expect(decompositions).toBe(0);
  expect(listFabricExecutionCandidates(root)).toHaveLength(0);
  expect((await call('/v1/fabric/decompose', 'POST', {})).status).toBe(400);
  expect((await call('/v1/fabric/decompose', 'POST', '{')).status).toBe(400);
  const created = await call('/v1/fabric/decompose', 'POST', { request });
  expect(created.status).toBe(201);
  const { plan } = await created.json() as { plan: FabricPlan };
  expect(decompositions).toBe(4);
  expect(plan.request).toBe(request);
  expect(plan.status).toBe('draft');
  expect(plan.nodes.map((node) => node.title)).toEqual(headings);
  expect(plan.nodes.flatMap((node) => [node, ...node.children])).toHaveLength(8);
  expect(plan.nodes[1]?.dependsOn).toEqual(['arc-1:task-1']);
  expect(plan.nodes[2]?.kind).toBe('deploy');
  expect(loadFabricPlan(root, plan.id)).toEqual(plan);
  expect(listFabricExecutionCandidates(root)).toHaveLength(0);
  const path = `/v1/fabric/plans/${plan.id}`;
  const fetched = await call(path);
  expect(fetched.status).toBe(200);
  expect(await fetched.json()).toEqual({ plan });
  expect((await call(`${path}/approve`, 'POST', undefined, false)).status).toBe(401);
  expect(listFabricExecutionCandidates(root)).toHaveLength(0);
  const approved = await call(`${path}/approve`, 'POST');
  expect(approved.status).toBe(200);
  const { candidate } = await approved.json() as { candidate: { planId: string; nodes: FabricPlan['nodes'] } };
  expect(candidate.planId).toBe(plan.id);
  expect(candidate.nodes).toEqual(plan.nodes);
  expect(listFabricExecutionCandidates(root)).toHaveLength(1);
  expect(listFabricExecutionCandidates(root)[0]).toMatchObject(candidate);
  expect((await (await call(path)).json() as { plan: FabricPlan }).plan.status).toBe('approved');
  expect((await call(`${path}/approve`, 'POST')).status).toBe(409);
  expect(listFabricExecutionCandidates(root)).toHaveLength(1);
});

test('missing plans, invalid IDs and unsupported methods never create execution candidates', async () => {
  const before = listFabricExecutionCandidates(root).length;
  const missing = '12345678-1234-1234-1234-123456789012';
  expect((await call(`/v1/fabric/plans/${missing}`)).status).toBe(404);
  expect((await call(`/v1/fabric/plans/${missing}/approve`, 'POST')).status).toBe(404);
  expect((await call('/v1/fabric/plans/%2Fetc%2Fpasswd')).status).toBe(400);
  expect((await call('/v1/fabric/decompose')).status).toBe(405);
  expect((await call(`/v1/fabric/plans/${missing}`, 'POST')).status).toBe(405);
  expect((await call(`/v1/fabric/plans/${missing}/approve`)).status).toBe(405);
  expect(listFabricExecutionCandidates(root)).toHaveLength(before);
});

test('steward schedule exposes only approved plans as execution candidates without launching them', async () => {
  mkdirSync(join(root, 'steward'), { recursive: true });
  writeFileSync(join(root, 'steward', 'triage.json'), '[]');
  writeFileSync(join(root, 'steward', 'issues.json'), '[]');
  const deps = { root, getSecret: async () => 'fake', launchSettings: { mode: 'shadow' as const } };
  const draft = await call('/v1/fabric/decompose', 'POST', { request });
  expect(draft.status).toBe(201);
  const plan = (await draft.json() as { plan: FabricPlan }).plan;
  const before = listFabricExecutionCandidates(root);
  expect(before.some(candidate => candidate.planId === plan.id)).toBe(false);
  await runStewardStage('schedule', deps);
  const preApproval = JSON.parse(readFileSync(join(root, 'steward', 'fabric-candidates.json'), 'utf8')) as Array<{ planId: string }>;
  expect(preApproval.some(candidate => candidate.planId === plan.id)).toBe(false);
  expect(JSON.parse(readFileSync(join(root, 'steward', 'schedule.json'), 'utf8'))).toEqual([]);
  expect((await call(`/v1/fabric/plans/${plan.id}/approve`, 'POST')).status).toBe(200);
  await runStewardStage('schedule', deps);
  const approved = JSON.parse(readFileSync(join(root, 'steward', 'fabric-candidates.json'), 'utf8')) as Array<{ planId: string }>;
  expect(approved.filter(candidate => candidate.planId === plan.id)).toHaveLength(1);
  expect(approved).toHaveLength(before.length + 1);
  expect(JSON.parse(readFileSync(join(root, 'steward', 'schedule.json'), 'utf8'))).toEqual([]);
});

test('steward candidate file is rewritten from the ledger rather than retaining stale approvals', async () => {
  const otherRoot = mkdtempSync(join(tmpdir(), 'steward-fabric-'));
  try {
    mkdirSync(join(otherRoot, 'steward'), { recursive: true });
    writeFileSync(join(otherRoot, 'steward', 'triage.json'), '[]');
    writeFileSync(join(otherRoot, 'steward', 'issues.json'), '[]');
    writeFileSync(join(otherRoot, 'steward', 'fabric-candidates.json'), JSON.stringify([{ planId: 'stale' }]));
    await runStewardStage('schedule', { root: otherRoot, getSecret: async () => 'fake', launchSettings: { mode: 'shadow' } });
    expect(JSON.parse(readFileSync(join(otherRoot, 'steward', 'fabric-candidates.json'), 'utf8'))).toEqual([]);
    expect(JSON.parse(readFileSync(join(otherRoot, 'steward', 'schedule.json'), 'utf8'))).toEqual([]);
  } finally { rmSync(otherRoot, { recursive: true, force: true }); }
});
