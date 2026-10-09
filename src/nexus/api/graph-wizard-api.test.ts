import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { NexusEventBus } from './event-bus.js';
import { routeRequest } from './http-server.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { HARNESS_EXAMPLE } from '../../graph-wizard/generate.js';

const reply = (yaml: string) => `SLUG: digest\nSUMMARY: 요약\n\`\`\`yaml\n${yaml}\`\`\``;

function request(body: unknown, llm: (p: string) => Promise<string>, authorized = true) {
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  state.bus = bus;
  return routeRequest(new Request('http://localhost/v1/graphs/wizard', {
    method: 'POST',
    headers: authorized ? { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site' } : { 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify(body),
  }), {
    state, registry: new TabRegistry(state), eventBus: bus, metaApi: { bearerToken: 'owner-secret', noAuth: false },
    graphWizard: { callLLM: llm, graphsDir: join(import.meta.dir, '../../../graphs'), existingIds: () => new Set() },
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
