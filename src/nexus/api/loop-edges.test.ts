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
import { handleLoopEdgesGet } from './loop-edges.js';

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
