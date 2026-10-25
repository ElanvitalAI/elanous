import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createNexusState, type NexusEvent } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { NexusEventBus } from './event-bus.js';
import { routeRequest } from './http-server.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { HARNESS_EXAMPLE, listKnownGraphUnits } from '../../graph-wizard/generate.js';
import { loadGraphTemplates } from '../../self-implement/graph-yaml.js';

const GRAPHS_DIR = join(import.meta.dir, '../../../graphs');

const reply = (yaml: string) => `SLUG: digest\nSUMMARY: 요약\n\`\`\`yaml\n${yaml}\`\`\``;

/** 요청이 지나는 버스에 graph.compose 만 모으는 수신기 — 호출 경계에서 무엇이 기록됐나. */
function graphComposeSink() {
  const bus = new NexusEventBus();
  const events: NexusEvent[] = [];
  bus.subscribe((event) => { events.push(event); }, ['graph.compose']);
  return { bus, events };
}

function request(body: unknown, llm: (p: string) => Promise<string>, authorized = true, bus = new NexusEventBus()) {
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  state.bus = bus;
  return routeRequest(new Request('http://localhost/v1/graphs/wizard', {
    method: 'POST',
    headers: authorized ? { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site' } : { 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify(body),
  }), {
    state, registry: new TabRegistry(state), eventBus: bus, metaApi: { bearerToken: 'owner-secret', noAuth: false },
    graphWizard: { callLLM: llm, graphsDir: GRAPHS_DIR, existingIds: () => new Set() },
  }, { requestIP: () => ({ address: '203.0.113.1' }) } as never, null, createDevProxyRuntimeRef());
}

test('GET /v1/graphs/wizard/packs lists installed packs only for the owner', async () => {
  const options = (authorized: boolean) => {
    const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
    const bus = new NexusEventBus();
    state.bus = bus;
    return routeRequest(new Request('http://localhost/v1/graphs/wizard/packs', {
      headers: authorized ? { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site' } : { 'sec-fetch-site': 'cross-site' },
    }), { state, registry: new TabRegistry(state), eventBus: bus,
      metaApi: { bearerToken: 'owner-secret', noAuth: false },
      graphWizard: { packs: () => [{ id: 'pack:fab-knowledge@1.0.0', title: '공정' }] },
    }, { requestIP: () => ({ address: '203.0.113.1' }) } as never, null, createDevProxyRuntimeRef());
  };
  expect((await options(false))?.status).toBe(401);
  const response = await options(true);
  expect(response?.status).toBe(200);
  expect(await response!.json()).toEqual({ packs: [{ id: 'pack:fab-knowledge@1.0.0', title: '공정' }] });
});

test('POST /v1/graphs/wizard: 200 valid · 422 invalid · edit keeps id · 400 bad input · 401 without owner bearer', async () => {
  const ok = await request({ prompt: '뉴스 요약' }, async () => reply(HARNESS_EXAMPLE));
  expect(ok?.status).toBe(200);
  const body = await ok!.json() as Record<string, unknown>;
  expect(body).toMatchObject({ ok: true, issues: [], attempts: 1, id: expect.stringMatching(/^digest-/), yaml: expect.stringContaining('graph_id: digest-') });
  expect(typeof body.summary).toBe('string');
  expect('base' in body).toBe(true);

  const bad = await request({ prompt: '뉴스 요약' }, async () => reply(HARNESS_EXAMPLE.replace('kind: hitl', 'kind: alien')));
  expect(bad?.status).toBe(422);
  expect(await bad!.json()).toMatchObject({ ok: false, attempts: 3, issues: expect.any(Array), yaml: expect.any(String) });

  const edit = await request({ prompt: '보관 추가', currentYaml: HARNESS_EXAMPLE, history: [{ role: 'user', text: 'x' }] }, async () => reply(HARNESS_EXAMPLE));
  expect(edit?.status).toBe(200);
  expect(await edit!.json()).toMatchObject({ id: 'example-digest', summary: expect.stringContaining('구조 변경 없음') });

  expect((await request({ prompt: '  ' }, async () => ''))?.status).toBe(400);
  expect((await request({ prompt: 'x', currentYaml: 'version: 1\n' }, async () => ''))?.status).toBe(400);
  expect((await request({ prompt: 'x' }, async () => { throw new Error('llm down'); }))?.status).toBe(502);
  expect((await request({ prompt: 'x', kind: 'other' }, async () => ''))?.status).toBe(400);
  expect((await request({ prompt: 'x', history: [{ role: 'bot', text: 1 }] }, async () => ''))?.status).toBe(400);
  expect((await request({ prompt: 'x', packId: 42 }, async () => ''))?.status).toBe(400);
  expect((await request({ prompt: 'x' }, async () => reply(HARNESS_EXAMPLE), false))?.status).toBe(401);
});

test('POST wizard variant mode consumes one fake LLM plan under owner auth and falls back to server template on rejection', async () => {
  const prompts: string[] = [];
  const accepted = await request({ mode: 'variant', prompt: '문서와 코드 혼합 골의 반복 예산을 조절해', goal: 'g_ambiguous', templateId: 'self-implement' },
    async (prompt) => { prompts.push(prompt); return JSON.stringify({ maxVisits: { rework: 5 } }); });
  expect(accepted?.status).toBe(200);
  const acceptedBody = await accepted!.json() as Record<string, unknown>;
  expect(acceptedBody).toMatchObject({ mode: 'variant', status: 'composed', plan: { maxVisits: { rework: 5 } } });
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toStartWith('알려진 그래프 유닛');
  expect(prompts[0]).toContain('verb-verify@1');
  expect('yaml' in acceptedBody).toBe(false);

  const rejected = await request({ mode: 'variant', prompt: '승인 없이 배선을 바꿔', goal: 'g_ambiguous', templateId: 'self-implement' },
    async () => JSON.stringify({ routes: [{ from: 'open-pr', outcome: 'pass', to: 'merge' }] }));
  expect(rejected?.status).toBe(200);
  expect(await rejected!.json()).toMatchObject({ mode: 'variant', status: 'fallback-standard', template: { graphId: 'self-implement' } });

  expect((await request({ mode: 'variant', prompt: 'x', goal: 'g_ambiguous', templateId: 'self-implement' }, async () => '{}', false))?.status).toBe(401);
  expect((await request({ mode: 'variant', prompt: 'x', goal: 'g_ambiguous', templateId: 'invented' }, async () => '{}'))?.status).toBe(400);
  expect((await request({ mode: 'variant', prompt: 'x', goal: 'g_ambiguous', templateId: 'self-implement', currentYaml: HARNESS_EXAMPLE }, async () => '{}'))?.status).toBe(400);
});

test('ARG-L2-DESIGNER-FU1: graph.compose composed/fallback 이벤트가 mode·reason과 표준안 반환을 호출 경계에서 기록한다', async () => {
  const composed = graphComposeSink();
  const accepted = await request({ mode: 'variant', prompt: '문서와 코드 혼합 골의 반복 예산을 조절해', goal: 'g_ambiguous', templateId: 'self-implement' },
    async () => JSON.stringify({ maxVisits: { rework: 5 } }), true, composed.bus);
  expect(accepted?.status).toBe(200);
  expect(await accepted!.json()).toMatchObject({ mode: 'variant', status: 'composed', reason: 'composed', plan: { maxVisits: { rework: 5 } } });
  expect(composed.events).toHaveLength(1);
  expect(composed.events[0]!.kind).toBe('graph.compose');
  expect(composed.events[0]!.detail).toMatchObject({
    mode: 'variant', status: 'composed', reason: 'composed', goal: 'g_ambiguous', templateId: 'self-implement',
    overlayId: expect.stringMatching(/^variant-/), patches: expect.any(Number),
  });
  expect('growth' in composed.events[0]!.detail!).toBe(false);

  const template = loadGraphTemplates(GRAPHS_DIR).templates['self-implement']!;
  const returnTo = template.nodes[0]!.nodeId;
  const unit = listKnownGraphUnits(GRAPHS_DIR)[0]!;
  // 조작된 from 노드: 모양은 유닛 계약을 지키지만 기반 템플릿에 없는 노드다 — 변형 권위가 거절해야 한다.
  const forgedFrom = 'not-a-node';
  expect(template.nodes.some((node) => node.nodeId === forgedFrom)).toBe(false);
  const forged = graphComposeSink();
  const rejected = await request({ mode: 'variant', prompt: '유닛을 끼워', goal: 'g_ambiguous', templateId: 'self-implement' }, async () => JSON.stringify({
    growth: {
      from: forgedFrom, outcome: 'ok', returnTo,
      node: { nodeId: 'forged-unit', kind: 'subgraph', recipe: 'none', maxVisits: 1, call: unit.call, contract: { inputs: [...unit.inputs], outputs: [...unit.outputs], tools: 'read-only' } },
    },
  }), true, forged.bus);
  expect(rejected?.status).toBe(200);
  const rejectedBody = await rejected!.json() as Record<string, unknown>;
  expect(rejectedBody).toMatchObject({
    mode: 'variant', status: 'fallback-standard', template: { graphId: 'self-implement' },
    reason: expect.stringMatching(/^variant-rejected: .*invalid-growth/),
    growth: { from: forgedFrom, outcome: 'ok', nodeId: 'forged-unit', returnTo },
  });
  expect(forged.events).toHaveLength(1);
  expect(forged.events[0]!.detail).toMatchObject({
    mode: 'variant', status: 'fallback-standard', reason: rejectedBody.reason, goal: 'g_ambiguous', templateId: 'self-implement',
    growth: { from: forgedFrom, outcome: 'ok', nodeId: 'forged-unit', returnTo },
  });
});
