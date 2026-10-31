import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { enrichResourceSnapshot, RESOURCE_CELLS, ResourceMap, resourceCells, resourceGraph, type ResourceEventWire, type ResourceSnapshot } from './ResourceMap';
import { loopsView } from './loops-view';
import { RESOURCE_NODE } from '@/components/inside/loop-activity-map';
import { createNexusState, pushEvent } from '../../../../../src/nexus/state/state';
import { TabRegistry } from '../../../../../src/nexus/state/tab-registry';
import { NexusEventBus } from '../../../../../src/nexus/api/event-bus';
import { startNexusHttpServer } from '../../../../../src/nexus/api/http-server';
import { observeLoopResources } from '../../../../../src/nexus/api/loop-resources';

const snapshot: ResourceSnapshot = { resource: { now: '2026-10-05T00:00:00Z', unassigned: 1,
  seats: [
    { seat: 'MK', running: 2, cap: 6, baseShare: 3, borrowed: 1, lent: 0, launchCap: 4, idle: true,
      nextCell: { id: 'MK-1', title: '다음 잡' } },
    { seat: 'TC', running: 4, cap: 4, baseShare: 4, borrowed: 0, lent: 1, launchCap: 4, idle: false, nextCell: null },
  ] } };

test('GET /v1/loops/resources production observation reaches the resource screen with zero runs and pending MK work', async () => {
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const nexusEvent = pushEvent(state, { kind: 'mission.line', detail: { who: 'Codex', text: 'Codex researches the resource map' } });
  const eventBus = new NexusEventBus();
  state.bus = eventBus;
  const server = startNexusHttpServer({ state, eventBus, registry: new TabRegistry(state),
    startPort: 46000 + Math.floor(Math.random() * 1000), metaApi: { bearerToken: 'auth', noAuth: false },
    loopResources: () => observeLoopResources({
      now: new Date('2026-10-05T00:00:00Z'), version: '0.2.28',
      processes: { status: 'ok', records: [], excludedCount: 0 },
      openCells: [{ id: 'RES-LOOP-M3', title: 'waiting work', owner: 'MK', status: 'yellow' }],
      nextRound: [], totalSlots: 0,
    }),
  });
  try {
    const response = await fetch(`${server.url}/v1/loops/resources`, {
      headers: { authorization: 'Bearer auth', 'sec-fetch-site': 'cross-site' },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as ResourceSnapshot;
    expect(body.resource.seats.find(row => row.seat === 'MK')).toMatchObject({
      running: 0, idle: false, nextCell: { id: 'RES-LOOP-M3' },
    });
    const html = renderToStaticMarkup(<ResourceMap snapshot={body} />);
    expect(html).toContain('RES-LOOP-M3');
    expect(resourceGraph(body, true).nodes[0]?.data.detail).toContain('대기 잡 RES-LOOP-M3');
    const servedCellIds = body.resource.seats.flatMap(row => row.nextCell ? [row.nextCell.id] : []);
    expect(servedCellIds).toEqual(['RES-LOOP-M3']);
    expect(html.match(/data-cell-id="([^"]*)"/g)).toEqual(['data-cell-id="RES-LOOP-M3"']);
    expect(html).toContain(`data-observed-at="${body.resource.now}"`);
    const nexusResponse = await fetch(`${server.url}/v1/nexus`, {
      headers: { authorization: 'Bearer auth', 'sec-fetch-site': 'cross-site' },
    });
    expect(nexusResponse.status).toBe(200);
    const nexus = await nexusResponse.json() as { recentEvents: ResourceEventWire[] };
    expect(typeof nexus.recentEvents[0]?.ts).toBe('number');
    expect(nexus.recentEvents[0]).toMatchObject({ kind: 'mission.line', detail: { who: 'Codex', text: 'Codex researches the resource map' } });
    expect(nexus.recentEvents[0]?.ts).toBe(nexusEvent.ts);
    const enriched = enrichResourceSnapshot({ resource: body.resource, podWorkers: body.podWorkers }, nexus, null);
    expect(resourceCells(enriched).find(cell => cell.id === '손')).toMatchObject({ lit: true, activity: expect.stringContaining('Codex researches') });
  } finally { server.stop(); }
});

test('resources is opt-in, leaving the default and interact views unchanged', () => {
  expect(loopsView(new URLSearchParams())).toBe('status');
  expect(loopsView(new URLSearchParams('view=interact'))).toBe('interact');
  expect(loopsView(new URLSearchParams('view=resources'))).toBe('resources');
});

test('resource loop and seat detail remain visible beside the fixed resource-cell nodes', () => {
  const html = renderToStaticMarkup(<ResourceMap snapshot={snapshot} />);
  for (const text of ['자원 관리 루프', '자리', '잡', '임대 1', '대여 1', '대기 잡 CMO-1', '2/6']) expect(html).toContain(text);
  expect(html.match(/data-id="loop:resources"/g)).toHaveLength(1);
  expect(html).toContain('data-cell-id="MK-1"');
  expect(html.match(/data-cell-id=/g)).toHaveLength(1);
  expect(html).toContain('data-observed-at="2026-10-05T00:00:00Z"');
  const near = resourceGraph(snapshot, true);
  expect(near.nodes).toHaveLength(1 + RESOURCE_CELLS.length);
  expect(near.nodes[0]?.id).toBe(RESOURCE_NODE);
  expect(near.nodes[0]?.data.detail).toContain('MK 2/6');
  expect(near.nodes[0]?.data.detail).toContain('임대 1');
  expect(near.nodes[0]?.data.detail).toContain('대기 잡 MK-1 다음 잡');
  expect(near.edges).toHaveLength(RESOURCE_CELLS.length);
  expect(resourceGraph(snapshot, false).nodes[0]?.data.detail).toBe('자리 2 · 미배정 런 1');
});

test('DEMO1104 §3b keeps all six resource groups visible and connects them to the resource loop', () => {
  expect(RESOURCE_CELLS.map(cell => cell.members ? `${cell.id}(${cell.members})` : cell.id)).toEqual([
    '머신(mbp·node-b·node-c·minim5·elangram·host-e(WSL))', '손(Codex·Claude Code)',
    '모델(gpt 계열·Claude·Grok·GLM)', '검색(Exa·Firecrawl·Grok)',
    '업무 도구(Linear·Telegram·browser·메일(초안))', '영상 파이프라인(graphs/video/explainer-line.yaml)',
  ]);
  const graph = resourceGraph(snapshot, true);
  expect(graph.nodes.map(node => node.id)).toEqual([
    RESOURCE_NODE, ...RESOURCE_CELLS.map(cell => `resource-cell:${cell.id}`),
  ]);
  expect(graph.edges).toHaveLength(RESOURCE_CELLS.length);
  expect(graph.edges.every(edge => edge.source === RESOURCE_NODE)).toBe(true);
  expect(graph.edges.map(edge => edge.target)).toEqual(RESOURCE_CELLS.map(cell => `resource-cell:${cell.id}`));
  expect(resourceCells(snapshot).every(cell => !cell.lit && cell.status === 'unmeasured')).toBe(true);
});

test('DEMO1104 §3b lights a matching resource for recent graph, host probe, or Pod lease evidence', () => {
  const recentEvents: ResourceEventWire[] = [
    { ts: Date.now(), kind: 'tab.up', detail: { title: 'mbp browser tab' } },
    { ts: Date.now(), kind: 'mission.line', detail: { who: 'Codex', text: 'Codex handles the task' } },
    { ts: Date.now(), kind: 'session.output', detail: { model: 'openrouter/z-ai/glm-5.3', text: 'GLM response' } },
    { ts: Date.now(), kind: 'trigger.fired', detail: { variant: 'exa-search', workflowName: 'research' } },
    { ts: Date.now(), kind: 'hitl.banner.show', detail: { toolName: 'Telegram', prompt: 'Approval request' } },
    { ts: Date.now(), kind: 'media.feedback', detail: { message: 'video render started' } },
  ];
  const active: ResourceSnapshot = {
    ...snapshot,
    recentEvents,
    podWorkers: [{ id: 'lease-1', machine: 'node-b', workerId: 'claude-code-1', state: 'leased', generation: 1, ageMs: 500, expired: false }],
    grid: { members: [{ context: 'node-c', capacity: 4, running: 1, pending: 0, occupied: 1, reason: null }] },
  };
  const cells = resourceCells(active);
  expect(cells.every(cell => cell.lit)).toBe(true);
  expect(cells.map(cell => cell.activity)).toEqual([
    'tab.up — mbp browser tab · node-c 1/4 occupied · node-b·claude-code-1 leased',
    'mission.line — Codex handles the task · node-b·claude-code-1 leased',
    'session.output — GLM response',
    'trigger.fired — exa-search',
    'hitl.banner.show — Approval request',
    'media.feedback — video render started',
  ]);
  const graph = resourceGraph(active, true);
  expect(graph.edges.filter(edge => edge.animated)).toHaveLength(RESOURCE_CELLS.length);
});

test('DEMO1104 §3b combines existing Nexus events, resource ledger and host grid without a new collector', () => {
  const resource: Omit<ResourceSnapshot, 'recentEvents' | 'grid'> = { resource: snapshot.resource,
    podWorkers: [{ id: 'lease-1', machine: 'node-b', workerId: 'codex-1', state: 'leased', generation: 2, ageMs: 10, expired: false }] };
  const events: ResourceEventWire[] = [{ ts: Date.now(), kind: 'mission.line', detail: { who: 'Codex', text: 'Codex building task' } }];
  const combined = enrichResourceSnapshot(resource, { recentEvents: events }, {
    members: [{ context: 'node-c', capacity: 4, running: 2, pending: 0, occupied: 2, reason: null }],
  });
  expect(combined.recentEvents).toBe(events);
  expect(combined.podWorkers).toBe(resource.podWorkers);
  expect(combined.grid?.members?.[0]?.context).toBe('node-c');
  expect(resourceCells(combined).find(cell => cell.id === '머신')?.activity).toContain('node-c 2/4 occupied');
  expect(resourceCells(combined).find(cell => cell.id === '손')?.activity).toContain('Codex building task');
});

test('DEMO1104 §3b ignores stale events, non-search triggers, unrelated HITL, and expired Pod leases', () => {
  const inactive: ResourceSnapshot = {
    ...snapshot,
    recentEvents: [
      { ts: Date.now() - 5 * 60_000, kind: 'trigger.fired', detail: { variant: 'weekly-report' } },
      { ts: Date.now(), kind: 'hitl.banner.show', detail: { prompt: 'Please open the browser and approve' } },
    ],
    podWorkers: [{ id: 'lease-1', machine: 'node-b', workerId: 'codex-worker', state: 'leased', generation: 1, ageMs: 5_000, expired: true }],
    grid: { members: [{ context: 'node-b', capacity: 4, running: null, pending: null, occupied: null, reason: 'probe failed' }] },
  };
  const cells = resourceCells(inactive);
  expect(cells.find(cell => cell.id === '머신')?.lit).toBe(false);
  expect(cells.find(cell => cell.id === '손')?.lit).toBe(false);
  expect(cells.find(cell => cell.id === '검색')?.lit).toBe(false);
  expect(cells.find(cell => cell.id === '업무 도구')?.lit).toBe(false);
});

test('DEMO1104 §3b surfaces failed event, host, and Pod observations as unmeasured', () => {
  const unknown = enrichResourceSnapshot({ resource: snapshot.resource, podWorkers: null }, null, null);
  const cells = resourceCells(unknown);
  expect(cells.every(cell => !cell.lit && cell.status === 'unmeasured')).toBe(true);
  const html = renderToStaticMarkup(<ResourceMap snapshot={unknown} />);
  expect(html).toContain('이벤트 스트림 미측정');
  expect(html).toContain('호스트 프로브 미측정');
  expect(html).toContain('Pod 원장 미측정');
  expect(html).not.toContain('○ 대기');
});

test('DEMO1104 §3b keeps absent and empty host-grid member observations unmeasured', () => {
  const absentMembers: ResourceSnapshot = { ...snapshot, grid: {} };
  const absentCell = resourceCells(absentMembers).find(cell => cell.id === '머신');
  expect(absentCell).toMatchObject({ lit: false, status: 'unmeasured' });
  expect(absentCell?.activity).toContain('호스트 프로브 미측정');

  const emptyPool: ResourceSnapshot = { ...snapshot, grid: { members: [], poolReason: 'pool unavailable' } };
  const emptyCell = resourceCells(emptyPool).find(cell => cell.id === '머신');
  expect(emptyCell).toMatchObject({ lit: false, status: 'unmeasured' });
  expect(emptyCell?.activity).toContain('호스트 프로브 미측정 (pool unavailable)');
});

test('DEMO1104 §3b keeps per-source failures visible beside active machine and hand evidence', () => {
  const mixed: ResourceSnapshot = {
    ...snapshot,
    recentEvents: null,
    podWorkers: [{ id: 'lease-1', machine: 'node-b', workerId: 'codex-worker', state: 'leased', generation: 2, ageMs: 20, expired: false }],
    grid: { members: [
      { context: 'node-c', capacity: 4, running: 1, pending: 0, occupied: 1, reason: null },
      { context: 'node-b', capacity: 8, running: null, pending: null, occupied: null, reason: 'probe failed' },
    ] },
  };
  const cells = resourceCells(mixed);
  expect(cells.find(cell => cell.id === '머신')).toMatchObject({ lit: true });
  expect(cells.find(cell => cell.id === '머신')?.activity).toContain('node-c 1/4 occupied');
  expect(cells.find(cell => cell.id === '머신')?.activity).toContain('node-b 호스트 프로브 미측정');
  expect(cells.find(cell => cell.id === '머신')?.activity).toContain('이벤트 스트림 미측정');
  expect(cells.find(cell => cell.id === '손')?.activity).toContain('이벤트 스트림 미측정');
  expect(cells.find(cell => cell.id === '손')?.activity).toContain('codex-worker leased');
});

test('a blank waiting cell id shows as no cell on the resource screen, the same rule the API serves', () => {
  const blank: ResourceSnapshot = { resource: { ...snapshot.resource, seats: [
    { ...snapshot.resource.seats[0]!, nextCell: { id: '   ', title: 'unnamed work' } },
    snapshot.resource.seats[1]!,
  ] } };
  const html = renderToStaticMarkup(<ResourceMap snapshot={blank} />);
  expect(html.match(/data-cell-id=/g)).toBeNull();
  expect(html.match(/다음 잡 판정 없음/g)!.length).toBeGreaterThanOrEqual(2);
  expect(resourceGraph(blank, true).nodes[0]?.data.detail).not.toContain('unnamed work');
});
