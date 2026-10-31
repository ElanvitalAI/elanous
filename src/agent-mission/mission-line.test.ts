import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMissionLineStore, handleMissionLineRequest, MissionLineHttpError, postMissionLineEvent, type MissionLineEvent, type MissionLineInput } from './mission-line.js';
import { createMissionOutStore } from './mission-out.js';
import { createNexusState } from '../nexus/state/state.js';
import { TabRegistry } from '../nexus/state/tab-registry.js';
import { NexusEventBus } from '../nexus/api/event-bus.js';
import { routeRequest, type NexusHttpServerOpts } from '../nexus/api/http-server.js';
import { createDevProxyRuntimeRef } from '../nexus/api/admin-dev-proxy.js';

const roots: string[] = [];
const root = () => { const value = mkdtempSync(join(tmpdir(), 'mission-line-')); roots.push(value); return value; };
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

test('mission line scopes writes to the current attempt token and revokes on final', async () => {
  const stateRoot = root();
  const store = createMissionLineStore(stateRoot);
  const missionId = '12345678-1234-4234-8234-123456789abc';
  const out = createMissionOutStore(stateRoot);
  out.create({ missionId, agent: 'codex', prompt: 'Research and repair', cwd: '/repo', outputPath: join(stateRoot, 'result.tmp'), targetOutputPath: join(stateRoot, 'result.md') });
  const auth = store.issue({ missionId, attemptId: 'attempt-2', agent: 'codex', who: 'Codex', what: 'Research and repair' });
  expect(auth.finalLineId).not.toBe(auth.attemptId);
  const body: MissionLineInput = { lineId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', missionId, attemptId: auth.attemptId, agent: 'codex', type: 'progress', source: 'codex-notify', text: 'working' };
  const publish: MissionLineEvent[] = [];
  const send = (payload: typeof body, token = auth.token) => handleMissionLineRequest(new Request(`http://nexus/v1/missions/${body.missionId}/line`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload),
  }), stateRoot, async (input, authority) => {
    const reply = await out.reply(input.missionId, input.text, input.type === 'final', {
      attemptId: input.attemptId, agent: input.agent, lineType: input.type, source: input.source, who: authority.who, what: authority.what,
    });
    return { ...input, sequence: reply.sequence, createdAt: reply.createdAt, done: reply.done, ...(reply.graphEvents ? { graphEvents: reply.graphEvents } : {}) };
  }, (event) => { publish.push(event); });

  expect((await send({ ...body, attemptId: 'old-attempt' }))?.status).toBe(401);
  const accepted = await send(body);
  expect(accepted?.status).toBe(202);
  expect(await accepted?.json()).toMatchObject({ type: 'progress', attemptId: 'attempt-2', sequence: 1, graphEvents: [{ type: 'node-added', kind: 'hand', who: 'Codex', what: 'Research and repair' }] });
  const final = await send({ ...body, type: 'final', text: 'done' });
  expect(final?.status).toBe(202);
  expect((await send(body))?.status).toBe(401);
  expect(publish.map((event) => event.type)).toEqual(['progress', 'final']);
  expect(out.replies(missionId)).toMatchObject([
    { sequence: 1, graphEvents: [{ type: 'node-added', kind: 'hand', who: 'Codex', what: 'Research and repair' }] },
    { sequence: 2, done: true, lineType: 'final' },
  ]);
});

test('routeRequest persists mission line and publishes the existing NEXUS SSE event', async () => {
  const stateRoot = root();
  const previousStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = stateRoot;
  try {
    const missionId = '12345678-1234-4234-8234-123456789abc';
    const out = createMissionOutStore(stateRoot);
    out.create({ missionId, agent: 'claude', prompt: 'inspect issue', cwd: '/repo', outputPath: join(stateRoot, 'result.tmp'), targetOutputPath: join(stateRoot, 'result.md') });
    const auth = createMissionLineStore(stateRoot).issue({ missionId, attemptId: 'attempt-route', agent: 'claude', who: 'Claude', what: 'inspect issue' });
    const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
    const eventBus = new NexusEventBus();
    state.bus = eventBus;
    const published: unknown[] = [];
    eventBus.subscribe((event) => published.push(event), ['mission.line']);
    const response = await routeRequest(new Request(`http://nexus/v1/missions/${missionId.toUpperCase()}/line`, {
      method: 'POST', headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ lineId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', missionId, attemptId: auth.attemptId, agent: 'claude', type: 'progress', source: 'claude-hook', text: 'reading' }),
    }), {
      state, registry: new TabRegistry(state), eventBus,
    } as NexusHttpServerOpts, { requestIP: () => ({ address: '127.0.0.1' }) } as never, null, createDevProxyRuntimeRef());
    expect(response?.status).toBe(202);
    expect(out.replies(missionId)).toMatchObject([{ lineType: 'progress', graphEvents: [{ type: 'node-added', kind: 'hand', who: 'Claude', what: 'inspect issue', missionId }] }]);
    expect(published).toMatchObject([{ kind: 'mission.line', detail: { sequence: 1, graphEvents: [{ kind: 'hand', missionId }] } }]);
  } finally {
    if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previousStateDir;
  }
});

test('mission line reports a durable-store append failure as 500', async () => {
  const stateRoot = root();
  const missionId = '12345678-1234-4234-8234-123456789abc';
  const auth = createMissionLineStore(stateRoot).issue({ missionId, attemptId: 'attempt-store-error', agent: 'codex', who: 'Codex', what: 'test store error' });
  const response = await handleMissionLineRequest(new Request(`http://nexus/v1/missions/${missionId}/line`, {
    method: 'POST', headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ lineId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', missionId, attemptId: auth.attemptId, agent: 'codex', type: 'progress', source: 'test', text: 'cannot append' }),
  }), stateRoot, async () => { throw new Error('disk unavailable'); }, () => {});
  expect(response?.status).toBe(500);
  expect(await response?.json()).toEqual({ error: 'mission_line_store_failed' });
});

test('mission state conflicts preserve their HTTP status after authentication', async () => {
  const stateRoot = root();
  const missionId = '12345678-1234-4234-8234-123456789abc';
  const auth = createMissionLineStore(stateRoot).issue({ missionId, attemptId: 'attempt-state-conflict', agent: 'codex', who: 'Codex', what: 'state conflict' });
  const response = await handleMissionLineRequest(new Request(`http://nexus/v1/missions/${missionId}/line`, {
    method: 'POST', headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ lineId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', missionId, attemptId: auth.attemptId, agent: 'codex', type: 'progress', source: 'test', text: 'late' }),
  }), stateRoot, async () => { throw new MissionLineHttpError(409); }, () => {});
  expect(response?.status).toBe(409);
  expect(await response?.json()).toEqual({ error: 'mission_state_conflict' });
});

test('mission line rejects missing credentials and malformed payloads', async () => {
  const stateRoot = root();
  const url = 'http://nexus/v1/missions/12345678-1234-4234-8234-123456789abc/line';
  const missing = await handleMissionLineRequest(new Request(url, { method: 'POST', body: '{}' }), stateRoot, async () => { throw new Error('must not append'); }, () => {});
  expect(missing?.status).toBe(401);
  const malformed = await handleMissionLineRequest(new Request(url, { method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: JSON.stringify({ lineId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', missionId: 'wrong', attemptId: 'a', agent: 'codex', type: 'progress', source: 'test', text: 'x' }) }), stateRoot, async () => { throw new Error('must not append'); }, () => {});
  expect(malformed?.status).toBe(400);
});

test('child client uses only supplied per-mission bearer and resolved NEXUS URL', async () => {
  let request: Request | undefined;
  const lineId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const event = await postMissionLineEvent({ lineId, missionId: '12345678-1234-4234-8234-123456789abc', attemptId: 'attempt-1', agent: 'claude', type: 'progress', source: 'claude-hook', text: 'working' }, {
    env: { ELANOUS_HAND_TOKEN: 'secret-token', ELANOUS_HAND_ATTEMPT_ID: 'attempt-1' },
    resolveUrl: () => 'http://nexus/',
    fetch: async (input, init) => { request = new Request(input, init); return Response.json({ lineId, missionId: '12345678-1234-4234-8234-123456789abc', attemptId: 'attempt-1', agent: 'claude', type: 'progress', source: 'claude-hook', text: 'working', sequence: 1, createdAt: new Date(0).toISOString(), done: false }); },
  });
  expect(request?.url).toBe('http://nexus/v1/missions/12345678-1234-4234-8234-123456789abc/line');
  expect(request?.headers.get('authorization')).toBe('Bearer secret-token');
  expect(event.attemptId).toBe('attempt-1');
  expect(event.lineId).toBe(lineId);
});

test('child client preserves HTTP rejection status so callers cannot fallback around a 401', async () => {
  try {
    await postMissionLineEvent({ lineId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', missionId: '12345678-1234-4234-8234-123456789abc', attemptId: 'attempt-1', agent: 'codex', type: 'progress', source: 'test', text: 'stale' }, {
      env: { ELANOUS_HAND_TOKEN: 'stale-token' }, resolveUrl: () => 'http://nexus',
      fetch: async () => new Response(null, { status: 401 }),
    });
  } catch (error) {
    expect(error).toBeInstanceOf(MissionLineHttpError);
    expect((error as MissionLineHttpError).status).toBe(401);
  }
});
