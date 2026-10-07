import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from '../../task-cards/card-store.js';
import { listCoordEvents } from '../../context-bus/coord-events.js';
import { openSurfaceEventsDb, recordEvent } from '../../domains/surface-events.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { NexusEventBus } from './event-bus.js';
import { startNexusHttpServer } from './http-server.js';
import { handleLoopEdgesGet, type LoopEdge } from './loop-edges.js';
import type { SeatRequestRow } from '../../seat-dispatch/seat-request-ledger.js';

const now = new Date().toISOString();
const earlier = new Date(Date.now() - 60_000).toISOString();
const since = new Date(Date.now() - 120_000).toISOString();
const path = `http://nexus.test/v1/loops/edges?since=${encodeURIComponent(since)}&limit=20`;

test('three persisted sources yield only timestamp, kind, endpoints and reference, without source prose', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-edges-'));
  try {
    const store = new CardStore(root);
    const card = store.createCard({ goalId: 'wish:pwa:example', title: 'PRIVATE-WISH-BODY' });
    store.appendSection(card.id, { key: 'intake:wish:0', owner: 'steward', content: JSON.stringify({ source: 'pwa', text: 'PRIVATE-WISH-BODY' }) });
    store.appendSection(card.id, { key: 'intake:reply:0', owner: 'steward', content: JSON.stringify({ surface: 'pwa', address: 'PRIVATE-ADDRESS' }) });
    store.appendSection(card.id, { key: 'flow:split:0', owner: 'flow', content: JSON.stringify({ cells: [{ id: 'FLOW-1', owner: 'TC', title: 'PRIVATE-CELL-TITLE' }] }) });
    store.appendSection(card.id, { key: 'flow:placed:FLOW-1', owner: 'flow', content: JSON.stringify({ decision: { id: 'FLOW-1', version: '0.2.18', title: 'PRIVATE-PLACEMENT' } }) });
    store.appendSection(card.id, { key: 'flow:result:0', owner: 'flow', content: JSON.stringify({ cardId: card.id, text: 'PRIVATE-REPLY-BODY' }) });
    store.close();
    const dir = join(root, 'run-ledger');
    mkdirSync(dir);
    const runId = 'run-12345678-1234-1234-1234-123456789abc';
    writeFileSync(join(dir, `${runId}.jsonl`), `${JSON.stringify({ runId, event: 'start', timestamp: earlier, data: { seat: 'OP', feature: 'PRIVATE-RUN-BODY' } })}\n`);
    const response = handleLoopEdgesGet(new Request(path), {
      cardRoot: root, ledgerDir: dir, listLoopOwners: () => [],
      listCoord: () => [{ id: 'coord-1', at: now, kind: '요청', text: 'PRIVATE-COORD-BODY', summary: 'PRIVATE-COORD-SUMMARY',
        refs: { seat: 'UX', recipients: ['TC'], all: false, kind: '요청', slot: null, deadline: null, url: null } }],
    });
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain('PRIVATE-');
    const edges = (JSON.parse(raw) as { edges: unknown[] }).edges;
    expect(edges).toContainEqual({ at: now, kind: 'request', from: 'UX', to: 'TC', ref: 'coord-1' });
    expect(edges).toContainEqual({ at: earlier, kind: 'run', from: 'OP', to: `loop:${runId}`, ref: runId });
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'card', from: 'surface:pwa', to: `card:${card.id}`, ref: card.id }),
      expect.objectContaining({ kind: 'card', from: `card:${card.id}`, to: 'loop:FLOW-1', ref: card.id }),
      expect.objectContaining({ kind: 'card', from: 'loop:FLOW-1', to: 'TC', ref: card.id }),
      expect.objectContaining({ kind: 'card', from: 'TC', to: 'surface:pwa', ref: card.id }),
    ]));
    for (const edge of edges) expect(Object.keys(edge as object).sort()).toEqual(['at', 'from', 'kind', 'ref', 'to']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

async function placedRunFixture(options: { request?: boolean; key?: boolean; run?: boolean; merged?: boolean; wrongCell?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'loop-card-run-'));
  const store = new CardStore(root);
  const card = store.createCard({ goalId: 'wish:pwa:linked', title: 'PRIVATE-CARD-TITLE' });
  store.appendSection(card.id, { key: 'flow:split:0', owner: 'flow', content: JSON.stringify({ cells: [{ id: 'FLOW-1', owner: 'TC' }] }) });
  store.appendSection(card.id, { key: 'flow:placed:FLOW-1', owner: 'flow', content: JSON.stringify({ decision: { id: 'FLOW-1', version: '0.2.18', text: 'PRIVATE-PLACEMENT' } }) });
  store.close();
  const key = `orch:${card.id}:FLOW-1`;
  const runId = 'run-12345678-1234-1234-1234-123456789abc';
  const mergedAt = new Date(Date.parse(earlier) + 1_000).toISOString();
  const requests: SeatRequestRow[] = options.request === false ? [] : [{
    key, seat: 'TC', cell: options.wrongCell ? 'FLOW-2' : 'FLOW-1', source: 'orchestrator', status: 'queued',
    text: 'PRIVATE-REQUEST-BODY', queuedAt: earlier,
  }];
  const dir = join(root, 'run-ledger');
  mkdirSync(dir);
  if (options.run !== false) {
    writeFileSync(join(dir, `${runId}.jsonl`), [
      { runId, event: 'start', timestamp: earlier, data: { seat: 'TC', feature: 'PRIVATE-RUN-BODY' } },
      ...(options.merged ? [{ runId, event: 'merged', timestamp: mergedAt, data: { merged: true, number: 123, prose: 'PRIVATE-MERGE-BODY' } }] : []),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
  }
  const response = handleLoopEdgesGet(new Request(path), {
    cardRoot: root, ledgerDir: dir, listCoord: () => [], listLoopOwners: () => [],
    listSeatRequests: () => requests,
    listOrchestratorLaunches: () => options.key === false ? [] : [{ key, runId }],
  });
  const raw = await response.text();
  const edges = (JSON.parse(raw) as { edges: LoopEdge[] }).edges;
  return { root, card, runId, mergedAt, raw, edges };
}

test('placed card, orchestrator request cell and key, and started run add a card-referenced launch edge', async () => {
  const fixture = await placedRunFixture({});
  try {
    expect(fixture.edges).toContainEqual({ at: earlier, kind: 'card', from: 'TC', to: `loop:${fixture.runId}`, ref: fixture.card.id });
    expect(fixture.edges).toContainEqual({ at: earlier, kind: 'run', from: 'TC', to: `loop:${fixture.runId}`, ref: fixture.runId });
    expect(fixture.edges.some(edge => edge.from === `loop:${fixture.runId}` && edge.to.startsWith('landed:'))).toBe(false);
    expect(fixture.edges).toContainEqual(expect.objectContaining({ from: `card:${fixture.card.id}`, to: 'loop:FLOW-1' }));
    expect(fixture.raw).not.toContain('PRIVATE-');
    for (const edge of fixture.edges) expect(Object.keys(edge).sort()).toEqual(['at', 'from', 'kind', 'ref', 'to']);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('confirmed merge adds a return edge only at the merged event time', async () => {
  const fixture = await placedRunFixture({ merged: true });
  try {
    expect(fixture.edges).toContainEqual({ at: fixture.mergedAt, kind: 'card', from: `loop:${fixture.runId}`, to: 'landed:FLOW-1', ref: fixture.card.id });
    expect(fixture.raw).not.toContain('PRIVATE-');
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('a run started before since still lands on its in-window merge without out-of-window launch edges', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-card-late-merge-'));
  try {
    const store = new CardStore(root);
    const card = store.createCard({ goalId: 'wish:pwa:late-merge', title: 'PRIVATE-CARD' });
    store.appendSection(card.id, { key: 'flow:split:0', owner: 'flow', content: JSON.stringify({ cells: [{ id: 'FLOW-1', owner: 'TC' }] }) });
    store.appendSection(card.id, { key: 'flow:placed:FLOW-1', owner: 'flow', content: JSON.stringify({ decision: { id: 'FLOW-1', version: '0.2.18' } }) });
    store.close();
    const key = `orch:${card.id}:FLOW-1`;
    const runId = 'run-12345678-1234-1234-1234-123456789abc';
    const startedAt = new Date(Date.parse(since) - 60_000).toISOString();
    const dir = join(root, 'run-ledger');
    mkdirSync(dir);
    writeFileSync(join(dir, `${runId}.jsonl`), [
      { runId, event: 'start', timestamp: startedAt, data: { seat: 'TC', text: 'PRIVATE-RUN-BODY' } },
      { runId, event: 'merged', timestamp: earlier, data: { merged: true, text: 'PRIVATE-MERGE-BODY' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const raw = await handleLoopEdgesGet(new Request(path), {
      cardRoot: root, ledgerDir: dir, listCoord: () => [], listLoopOwners: () => [],
      listSeatRequests: () => [{ key, cell: 'FLOW-1', seat: 'TC', source: 'orchestrator', status: 'queued', text: 'PRIVATE-REQUEST', queuedAt: startedAt }],
      listOrchestratorLaunches: () => [{ key, runId }],
    }).text();
    const edges = (JSON.parse(raw) as { edges: LoopEdge[] }).edges;
    expect(edges).toContainEqual({ at: earlier, kind: 'card', from: `loop:${runId}`, to: 'landed:FLOW-1', ref: card.id });
    expect(edges.some(edge => edge.to === `loop:${runId}`)).toBe(false);
    expect(raw).not.toContain('PRIVATE-');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing key or mismatched request cell cannot link a card to a run', async () => {
  for (const options of [{ key: false }, { request: false }, { wrongCell: true }]) {
    const fixture = await placedRunFixture(options);
    try {
      expect(fixture.edges.filter(edge => edge.ref === fixture.card.id && edge.to === `loop:${fixture.runId}`)).toEqual([]);
      expect(fixture.edges).toContainEqual({ at: earlier, kind: 'run', from: 'TC', to: `loop:${fixture.runId}`, ref: fixture.runId });
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

test('only an actual merged=true event creates a landing edge', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-card-merge-false-'));
  try {
    const store = new CardStore(root);
    const card = store.createCard({ goalId: 'wish:pwa:failed-merge', title: 'PRIVATE-CARD' });
    store.appendSection(card.id, { key: 'flow:split:0', owner: 'flow', content: JSON.stringify({ cells: [{ id: 'FLOW-1', owner: 'TC' }] }) });
    store.appendSection(card.id, { key: 'flow:placed:FLOW-1', owner: 'flow', content: JSON.stringify({ decision: { id: 'FLOW-1', version: '0.2.18' } }) });
    store.close();
    const key = `orch:${card.id}:FLOW-1`;
    const runId = 'run-12345678-1234-1234-1234-123456789abc';
    const dir = join(root, 'run-ledger');
    mkdirSync(dir);
    writeFileSync(join(dir, `${runId}.jsonl`), [
      { runId, event: 'start', timestamp: earlier, data: { seat: 'TC' } },
      { runId, event: 'merged', timestamp: now, data: { merged: false, text: 'PRIVATE-MERGE-FAILED' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const raw = await handleLoopEdgesGet(new Request(path), {
      cardRoot: root, ledgerDir: dir, listCoord: () => [], listLoopOwners: () => [],
      listSeatRequests: () => [{ key, cell: 'FLOW-1', seat: 'TC', source: 'orchestrator', status: 'queued', text: 'PRIVATE-REQUEST', queuedAt: earlier }],
      listOrchestratorLaunches: () => [{ key, runId }],
    }).text();
    const edges = (JSON.parse(raw) as { edges: LoopEdge[] }).edges;
    expect(edges).toContainEqual({ at: earlier, kind: 'card', from: 'TC', to: `loop:${runId}`, ref: card.id });
    expect(edges.some(edge => edge.to === 'landed:FLOW-1')).toBe(false);
    expect(raw).not.toContain('PRIVATE-');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a key without a run-ledger start cannot invent launch or landing edges', async () => {
  const fixture = await placedRunFixture({ run: false, merged: true });
  try {
    expect(fixture.edges.some(edge => edge.to === `loop:${fixture.runId}` || edge.from === `loop:${fixture.runId}`)).toBe(false);
    expect(fixture.raw).not.toContain('PRIVATE-');
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('reads the actual seat-request cell/key and orchestrator launch key/runId from their journals', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-card-journals-'));
  try {
    const store = new CardStore(root);
    const card = store.createCard({ goalId: 'wish:pwa:journal', title: 'PRIVATE-CARD' });
    store.appendSection(card.id, { key: 'flow:split:0', owner: 'flow', content: JSON.stringify({ cells: [{ id: 'FLOW-1', owner: 'TC' }] }) });
    store.appendSection(card.id, { key: 'flow:placed:FLOW-1', owner: 'flow', content: JSON.stringify({ decision: { id: 'FLOW-1', version: '0.2.18' } }) });
    store.close();
    const key = `orch:${card.id}:FLOW-1`;
    const runId = 'run-98765432-1234-1234-1234-123456789abc';
    mkdirSync(join(root, 'seat-requests'));
    writeFileSync(join(root, 'seat-requests', 'requests.jsonl'), `${JSON.stringify({ key, seat: 'TC', cell: 'FLOW-1', source: 'orchestrator', status: 'queued', text: 'PRIVATE-REQUEST', queuedAt: earlier })}\n`);
    mkdirSync(join(root, 'loop', 'orchestrator'), { recursive: true });
    writeFileSync(join(root, 'loop', 'orchestrator', 'tick.json'), JSON.stringify({ mode: 'live', cards: [{ title: 'PRIVATE-SNAPSHOT' }], launched: [{ key, runId, seat: 'TC', status: 'launched' }] }));
    const dir = join(root, 'run-ledger');
    mkdirSync(dir);
    writeFileSync(join(dir, `${runId}.jsonl`), [
      { runId, event: 'start', timestamp: earlier, data: { seat: 'TC', text: 'PRIVATE-RUN' } },
      { runId, event: 'merged', timestamp: now, data: { merged: true, text: 'PRIVATE-MERGE' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const raw = await handleLoopEdgesGet(new Request(path), { cardRoot: root, ledgerDir: dir, listCoord: () => [], listLoopOwners: () => [] }).text();
    const edges = (JSON.parse(raw) as { edges: LoopEdge[] }).edges;
    expect(edges).toContainEqual({ at: earlier, kind: 'card', from: 'TC', to: `loop:${runId}`, ref: card.id });
    expect(edges).toContainEqual({ at: now, kind: 'card', from: `loop:${runId}`, to: 'landed:FLOW-1', ref: card.id });
    expect(raw).not.toContain('PRIVATE-');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('run launched by registered loop uses the registry seat when start has no seat', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-run-owner-'));
  try {
    const dir = join(root, 'run-ledger');
    mkdirSync(dir);
    const runId = 'run-abcdef12-1234-1234-1234-123456789abc';
    writeFileSync(join(dir, `${runId}.jsonl`), `${JSON.stringify({ runId, event: 'start', timestamp: earlier, data: { feature: 'daily-cycle', message: 'PRIVATE-RUN-BODY' } })}\n`);
    const response = await handleLoopEdgesGet(new Request(path), {
      listCoord: () => [], listCards: () => [], ledgerDir: dir,
      listLoopOwners: () => [{ id: 'daily-cycle', owner: 'MK' }],
    }).json() as { edges: unknown[] };
    expect(response.edges).toEqual([{ at: earlier, kind: 'run', from: 'MK', to: `loop:${runId}`, ref: runId }]);
    expect(JSON.stringify(response)).not.toContain('PRIVATE-RUN-BODY');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reply destination alone does not invent a completed card flow', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-edges-pending-'));
  try {
    const store = new CardStore(root);
    const card = store.createCard({ goalId: 'wish:tui:pending', title: 'PRIVATE-PENDING' });
    store.appendSection(card.id, { key: 'intake:wish:0', owner: 'steward', content: JSON.stringify({ source: 'tui', text: 'PRIVATE-PENDING' }) });
    store.appendSection(card.id, { key: 'intake:reply:0', owner: 'steward', content: JSON.stringify({ surface: 'tui', address: null }) });
    store.close();
    const response = await handleLoopEdgesGet(new Request(path), { cardRoot: root, listCoord: () => [], listRunStarts: () => [] }).json() as { edges: unknown[] };
    expect(response.edges).toEqual([expect.objectContaining({ from: 'surface:tui', to: `card:${card.id}`, ref: card.id })]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('coordination projection selects channel events, not context messages with seat-shaped refs', async () => {
  const db = openSurfaceEventsDb(':memory:');
  try {
    for (const surface of ['coord:channel', 'context:external']) {
      recordEvent(db, { surface, direction: 'outbound', kind: '요청', domain: 'elanous', category: 'coordination',
        text: 'PRIVATE-CONTEXT-BODY', summary: 'PRIVATE-CONTEXT-SUMMARY', ts: earlier,
        refs: JSON.stringify({ seat: 'OP', recipients: ['UX'], kind: '요청' }) });
    }
    const rows = listCoordEvents({ since, channelOnly: true }, { db });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.refs.seat).toBe('OP');
    const response = handleLoopEdgesGet(new Request(path), {
      listCoord: options => listCoordEvents(options, { db }), listCards: () => [], listRunStarts: () => [],
    });
    const raw = await response.text();
    expect(raw).not.toContain('PRIVATE-');
    expect((JSON.parse(raw) as { edges: Array<{ kind: string; from: string; to: string }> }).edges).toEqual([
      expect.objectContaining({ kind: 'request', from: 'OP', to: 'UX' }),
    ]);
  } finally { db.close(); }
});

test('filters time window, sorts newest first, caps rows, and rejects invalid query', async () => {
  const old = new Date(Date.now() - 300_000).toISOString();
  const events = [old, earlier, now].map((at, index) => ({ id: `id-${index}`, at, kind: '보고', text: 'PRIVATE', summary: 'PRIVATE',
    refs: { seat: 'OP', recipients: ['UX'], all: false, kind: '보고', slot: null, deadline: null, url: null } }));
  events.push({ id: 'decision-1', at: earlier, kind: '결정', text: 'PRIVATE', summary: 'PRIVATE',
    refs: { seat: 'TC', recipients: ['OP', 'UX'], all: false, kind: '결정', slot: null, deadline: null, url: null } });
  const deps = { listCoord: () => events, listCards: () => [], listRunStarts: () => [] };
  const response = await handleLoopEdgesGet(new Request(path.replace('limit=20', 'limit=1')), deps).json() as { edges: Array<{ ref: string }> };
  expect(response.edges.map(edge => edge.ref)).toEqual(['id-2']);
  const full = await handleLoopEdgesGet(new Request(path), deps).json() as { edges: Array<{ kind: string; from: string; to: string; ref: string }> };
  expect(full.edges.filter(edge => edge.kind === 'decision')).toEqual([
    expect.objectContaining({ from: 'TC', to: 'OP', ref: 'decision-1' }),
    expect.objectContaining({ from: 'TC', to: 'UX', ref: 'decision-1' }),
  ]);
  expect(full.edges.some(edge => edge.ref === 'id-0')).toBe(false);
  const subSeat = { listCoord: () => [{ ...events[2]!, id: 'sub-1', refs: { ...events[2]!.refs, seat: 'TC/engineering', recipients: ['UX'] } }],
    listCards: () => [], listRunStarts: () => [], seatIds: () => ['OP', 'TC', 'MK', 'UX', 'TC/engineering'] };
  const sub = await handleLoopEdgesGet(new Request(path), subSeat).json() as { edges: Array<{ from: string; to: string }> };
  expect(sub.edges).toEqual([expect.objectContaining({ from: 'TC/engineering', to: 'UX' })]);
  expect(handleLoopEdgesGet(new Request(path.replace('limit=20', 'limit=0')), deps).status).toBe(400);
  expect(handleLoopEdgesGet(new Request(path.replace(encodeURIComponent(since), 'invalid')), deps).status).toBe(400);
  expect(handleLoopEdgesGet(new Request(path.replace(encodeURIComponent(since), '2026-10-04')), deps).status).toBe(400);
});

test('daemon GET requires owner bearer and cannot write through this route', async () => {
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const eventBus = new NexusEventBus();
  state.bus = eventBus;
  const server = startNexusHttpServer({ state, eventBus, registry: new TabRegistry(state), startPort: 45000 + Math.floor(Math.random() * 1000), metaApi: { bearerToken: 'owner-token', noAuth: false } });
  try {
    const target = `${server.url}/v1/loops/edges?since=${encodeURIComponent(since)}&limit=1`;
    expect((await fetch(target, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(401);
    const authorized = await fetch(target, { headers: { authorization: 'Bearer owner-token', 'sec-fetch-site': 'cross-site' } });
    expect(authorized.status).toBe(200);
    expect((await authorized.json() as { edges: unknown[] }).edges).toBeInstanceOf(Array);
    const sameOrigin = await fetch(target, { headers: { 'sec-fetch-site': 'same-origin' } });
    expect(sameOrigin.status).toBe(401);
    expect((await fetch(target, { method: 'POST', headers: { authorization: 'Bearer owner-token', 'sec-fetch-site': 'cross-site' } })).status).not.toBe(200);
    const withoutBearer = startNexusHttpServer({ state, eventBus, registry: new TabRegistry(state), startPort: 45000 + Math.floor(Math.random() * 1000), metaApi: { bearerToken: 'owner-token', noAuth: true } });
    try {
      expect((await fetch(`${withoutBearer.url}/v1/loops/edges`, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(401);
    } finally { withoutBearer.stop(); }
  } finally { server.stop(); }
});
