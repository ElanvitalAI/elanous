import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextNow, type ContextNowDeps } from './context-now.js';
import { recordExternalEvent } from './external-events.js';
import { openSurfaceEventsDb } from '../domains/surface-events.js';
import { DecisionLedger } from '../decisions/decision-ledger.js';
import { add } from '../release-loop/feature-store.js';
import { seatLedgerPath } from '../seat-loop/seat-loop.js';
import { routeRequest } from '../nexus/api/http-server.js';
import { createDevProxyRuntimeRef } from '../nexus/api/admin-dev-proxy.js';
import { SELF_COGNITION_RUNTIMES } from '../tool-runtime/self-cognition-runtimes.js';
import { buildCoreTools } from '../domains/core-tools.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';

const at = '2026-10-03T04:00:00.000Z';

// Fake ledger readers exercise filtering and source preservation without creating a store.
test('topic filters cell IDs/titles and event summaries; lines carry sources and no conversation bodies', () => {
  const answer = contextNow({ topic: 'K6' }, {
    now: () => new Date(at), version: () => '0.2.0',
    checklist: v => ({ version: v, released: '', dev: v, history: [], items: v === '0.2.0' ? [
      { id: 'K6', title: 'Ship the context door', status: 'red', updatedAt: at, updatedBy: 'TC' },
      { id: 'K7', title: 'Another feature', status: 'yellow', updatedAt: at, updatedBy: 'TC' },
    ] : [] }),
    decisions: () => [{ id: 'D1', title: 'Approve launch', status: 'open', raisedBy: { agent: 'TC' },
      category: 'scope', scqa: { s: 'SECRET CONVERSATION', c: 'x' }, options: [], recommendation: { skipped: true, reason: 'x' }, history: [] }],
    seatEntries: () => [
      { entry: { seat: 'TC', at, status: 'shadow', item: { source: 'checklist', id: 'K6', title: 'Ship the context door', text: 'SECRET CONVERSATION' } }, source: 'elanous://seat-loop/TC/1#1' },
      { entry: { seat: 'MK', at, status: 'shadow', item: { source: 'request', id: 'R1', title: 'Other', text: 'SECRET CONVERSATION' } }, source: 'elanous://seat-loop/MK/1#2' },
    ],
    events: () => [
      { id: 'a', at, summary: 'K6 ready', text: 'SECRET CONVERSATION', kind: '보고', refs: { seat: 'TC', recipients: [], all: false, kind: '보고', slot: null, deadline: null, url: null } },
      { id: 'b', at, summary: 'Other work', text: 'SECRET CONVERSATION', kind: '보고', refs: { seat: 'TC', recipients: [], all: false, kind: '보고', slot: null, deadline: null, url: null } },
    ],
  });
  expect(answer.facts.map(f => f.kind)).toEqual(['cell', 'seat']);
  expect(answer.facts[0]).toMatchObject({ kind: 'cell', id: 'K6', title: 'Ship the context door' });
  expect(answer.events.map(e => e.summary)).toEqual(['K6 ready']);
  expect(answer.facts.some(f => f.kind === 'decision')).toBe(false);
  expect([...answer.facts, ...answer.events].every(line => !!line.source)).toBe(true);
  expect(JSON.stringify(answer)).not.toContain('SECRET CONVERSATION');
  const byTitle = contextNow({ topic: 'another FEATURE' }, {
    now: () => new Date(at), version: () => '0.2.0',
    checklist: v => ({ version: v, released: '', dev: v, history: [], items: v === '0.2.0'
      ? [{ id: 'K7', title: 'Another feature', status: 'yellow', updatedAt: at, updatedBy: 'TC' }] : [] }),
    decisions: () => [], seatEntries: () => [], events: () => [],
  });
  expect(byTitle.facts).toMatchObject([{ kind: 'cell', id: 'K7' }]);
});

test('unfiltered version facts, bounded limit and empty ledgers retain the read-only answer shape', () => {
  const answer = contextNow({ limit: 1 }, {
    now: () => new Date(at), version: () => '0.2.0',
    checklist: version => ({ version, released: '', dev: version, history: [], items: [] }),
    decisions: () => [], seatEntries: () => [], events: () => [],
  });
  expect(answer).toEqual({ at, topic: null, facts: [{ kind: 'version', version: '0.2.0', source: 'elanous://release/0.2.0/checklist' }], events: [], guide: [] });
});

test('crowded ledgers retain decisions and the latest seat status within the fact limit', () => {
  const earlier = '2026-10-03T02:00:00.000Z';
  const later = '2026-10-03T03:00:00.000Z';
  const deps: ContextNowDeps = {
    now: () => new Date(at), version: () => '0.2.0',
    checklist: version => ({ version, released: '', dev: version, history: [], items: version === '0.2.0'
      ? Array.from({ length: 25 }, (_, i) => ({ id: `K${i}`, title: `Open cell ${i}`, status: 'yellow' as const, updatedAt: at, updatedBy: 'TC' })) : [] }),
    decisions: () => [{ id: 'D1', title: 'Decision needed', status: 'open', raisedBy: { agent: 'TC' },
      category: 'scope', scqa: { s: 's', c: 'c' }, options: [], recommendation: { skipped: true, reason: 'x' }, history: [] }],
    seatEntries: () => [
      { entry: { seat: 'TC', at: earlier, status: 'attempting', item: { source: 'checklist', id: 'K0', title: 'Old work', text: 'private' } }, source: 'elanous://seat-loop/TC/1#1' },
      { entry: { seat: 'TC', at: later, status: 'launched', item: { source: 'checklist', id: 'K0', title: 'New work', text: 'private' } }, source: 'elanous://seat-loop/TC/1#2' },
    ],
    events: () => [],
  };
  const answer = contextNow({ limit: 6 }, deps);
  expect(answer.facts).toHaveLength(6);
  expect(answer.facts.map(f => f.kind)).toEqual(['version', 'cell', 'cell', 'cell', 'decision', 'seat']);
  expect(answer.facts).toContainEqual(expect.objectContaining({ kind: 'decision', id: 'D1' }));
  expect(answer.facts).toContainEqual(expect.objectContaining({ kind: 'seat', status: 'launched', at: later, source: 'elanous://seat-loop/TC/1#2' }));
  expect(answer.facts).not.toContainEqual(expect.objectContaining({ kind: 'seat', status: 'attempting' }));
  expect(answer.facts.every(f => !!f.source)).toBe(true);
  const defaultAnswer = contextNow({}, deps);
  expect(defaultAnswer.facts).toHaveLength(20);
  expect(defaultAnswer.facts).toContainEqual(expect.objectContaining({ kind: 'decision', id: 'D1' }));
  expect(defaultAnswer.facts).toContainEqual(expect.objectContaining({ kind: 'seat', status: 'launched', at: later }));
  expect(defaultAnswer.facts.filter(f => f.kind === 'seat').map(f => f.status)).toEqual(['launched', 'attempting']);
});

test('authenticated HTTP and chat runtime return the same JSON from isolated release, decision, seat and context ledgers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'context-now-'));
  const previous = { config: process.env.ELANOUS_CONFIG_DIR, state: process.env.ELANOUS_STATE_DIR };
  process.env.ELANOUS_CONFIG_DIR = root;
  process.env.ELANOUS_STATE_DIR = root;
  setElanousConfigDir(root);
  try {
    const version = (await import('../release-loop/checklist.js')).devVersion().replace(/-.*$/, '');
    add(version, { id: 'K6', title: 'Context door', status: 'red', updatedAt: at, updatedBy: 'TC' });
    add(version, { id: 'K7', title: 'Unrelated feature', status: 'yellow', updatedAt: at, updatedBy: 'TC' });
    const ledger = new DecisionLedger({ stateDir: root, resolveVersion: () => ({ released: version, dev: version, codename: version }) });
    ledger.raise({ title: 'K6 decision', category: 'scope', scqa: { s: 'release', c: 'approve' },
      options: [{ key: 'a', label: 'Yes', consequence: 'go' }, { key: 'b', label: 'No', consequence: 'wait' }],
      recommendation: { skipped: true, reason: 'owner' }, raisedBy: { agent: 'TC' }, raisedAt: at });
    const now = new Date();
    const seatPath = seatLedgerPath('TC', root, now);
    mkdirSync(join(root, 'seat-loop', 'TC'), { recursive: true });
    writeFileSync(seatPath, [
      { seat: 'TC', at: now.toISOString(), status: 'shadow', item: { source: 'checklist', id: 'K6', title: 'Context door', text: 'PRIVATE CHAT' } },
      { seat: 'TC', at: now.toISOString(), status: 'shadow', item: { source: 'checklist', id: 'K7', title: 'Other', text: 'PRIVATE CHAT' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const db = openSurfaceEventsDb();
    try { recordExternalEvent({ origin: 'claude-code', kind: 'guide-changed', summary: 'K6 guide changed\nPRIVATE CHAT', source: 'https://example.org/guide' }, { db }); }
    finally { db.close(); }
    const runtime = SELF_COGNITION_RUNTIMES.find(tool => tool.id === 'context_now')!;
    expect(runtime.spec.name).toBe('context_now');
    const core = buildCoreTools();
    expect(core.names.has('context_now')).toBe(true);
    const request = (headers?: HeadersInit) => new Request('http://localhost/v1/context/now?topic=K6', { headers });
    const opts = { metaApi: { bearerToken: 'owner-token' } } as Parameters<typeof routeRequest>[1];
    const run = (req: Request) => routeRequest(req, opts, { requestIP: () => ({ address: '198.51.100.1' }) } as unknown as Parameters<typeof routeRequest>[2], null, createDevProxyRuntimeRef());
    const denied = await run(request());
    expect(denied?.status).toBe(401);
    expect((await run(request({ authorization: 'Bearer wrong-token' })))?.status).toBe(401);
    expect(await denied?.json()).toEqual({ error: 'unauthorized' });
    const response = await run(request({ authorization: 'Bearer owner-token' }));
    expect(response?.status).toBe(200);
    const http = await response?.json();
    const chat = await runtime.run({ topic: 'K6' }, { surface: 'skill' });
    expect(http).toEqual(chat);
    expect(await core.dispatch('context_now', { topic: 'K6' })).toEqual(http);
    expect(http.facts.map((fact: { kind: string }) => fact.kind)).toEqual(['cell', 'seat']);
    expect(http.events).toHaveLength(1);
    expect(http.guide).toHaveLength(1);
    expect(http.guide[0]).toContain('https://example.org/guide');
    const unfiltered = await runtime.run({}, { surface: 'skill' }) as { facts: Array<{ kind: string; id?: string }> };
    expect(unfiltered.facts).toContainEqual(expect.objectContaining({ kind: 'decision', id: expect.any(String) }));
    expect(JSON.stringify(http)).not.toContain('PRIVATE CHAT');
    expect([...http.facts, ...http.events].every((line: { source: string }) => !!line.source)).toBe(true);
  } finally {
    resetElanousConfigDir();
    if (previous.config === undefined) delete process.env.ELANOUS_CONFIG_DIR; else process.env.ELANOUS_CONFIG_DIR = previous.config;
    if (previous.state === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previous.state;
    rmSync(root, { recursive: true, force: true });
  }
});
