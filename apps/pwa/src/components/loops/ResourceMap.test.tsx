import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResourceMap, resourceGraph, type ResourceSnapshot } from './ResourceMap';
import { loopsView } from './loops-view';
import { RESOURCE_NODE } from '@/components/inside/loop-activity-map';
import { createNexusState } from '../../../../../src/nexus/state/state';
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
  } finally { server.stop(); }
});

test('resources is opt-in, leaving the default and interact views unchanged', () => {
  expect(loopsView(new URLSearchParams())).toBe('status');
  expect(loopsView(new URLSearchParams('view=interact'))).toBe('interact');
  expect(loopsView(new URLSearchParams('view=resources'))).toBe('resources');
});

test('one resource loop node contains measured seats, jobs, loans and waits with a near zoom lens', () => {
  const html = renderToStaticMarkup(<ResourceMap snapshot={snapshot} />);
  for (const text of ['자원 관리 루프', '자리', '잡', '임대 1', '대여 1', '대기 잡 CMO-1', '2/6']) expect(html).toContain(text);
  expect(html.match(/data-id="loop:resources"/g)).toHaveLength(1);
  const near = resourceGraph(snapshot, true);
  expect(near.nodes).toHaveLength(1);
  expect(near.nodes[0]?.id).toBe(RESOURCE_NODE);
  expect(near.nodes[0]?.data.detail).toContain('MK 2/6');
  expect(near.nodes[0]?.data.detail).toContain('임대 1');
  expect(near.nodes[0]?.data.detail).toContain('대기 잡 MK-1 다음 잡');
  expect(near.edges).toEqual([]);
  expect(resourceGraph(snapshot, false).nodes[0]?.data.detail).toBe('자리 2 · 미배정 런 1');
});
