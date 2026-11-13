import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createObjectStore } from '../../storage/object-store.js';
import { createAppVersionStore, openAppVersionStore, type AppVersionTrigger } from './app-versions.js';
import { createAppLifecycleStore } from './app-db.js';
import { createAppLifecycleEvent, type AppLifecycleAction } from './app-lifecycle-ledger.js';
import { createAppSimulationStore } from './app-simulation-db.js';
import { routeRequest, type NexusHttpServerOpts } from '../api/http-server.js';
import { createDevProxyRuntimeRef } from '../api/admin-dev-proxy.js';

function world() {
  const root = mkdtempSync(join(tmpdir(), 'app-version-history-'));
  const lifecycle = createAppLifecycleStore(join(root, 'app-lifecycle.sqlite'));
  const simulations = createAppSimulationStore(join(root, 'app-simulation.sqlite'));
  const thumbnails = createObjectStore({ provider: 'local', localDir: join(root, 'objects'), bucket: '', publicBucket: '', prefix: '' });
  const store = createAppVersionStore({ databasePath: join(root, 'app-versions.sqlite'), lifecycle, simulations, thumbnails });
  function seed(index: number, trigger: AppVersionTrigger, extra: { appId?: string; fingerprint?: string; environment?: 'simulation' | 'live'; outcome?: 'succeeded' | 'failed'; simulationOutcome?: 'passed' | 'failed'; action?: AppLifecycleAction; versionId?: string } = {}) {
    const appId = extra.appId ?? 'notes';
    const fingerprint = extra.fingerprint ?? index.toString(16).padStart(64, '0');
    const event = createAppLifecycleEvent({ appId, action: extra.action ?? (trigger === 'restore' ? 'rolled-back' : trigger === 'deploy' ? 'promoted' : 'simulated'),
      environment: extra.environment ?? 'simulation', actor: 'system', outcome: extra.outcome ?? 'succeeded',
      appVersion: extra.versionId ?? `version-${index}`, appFingerprint: fingerprint, receiptId: `receipt-${index}`, runId: `run-${index}` },
    { id: () => `event-${index}`, now: () => new Date(`2026-11-12T03:${String(index).padStart(2, '0')}:00.000Z`) });
    lifecycle.appendEvent(event);
    simulations.record({ runId: event.runId, events: [{ kind: 'app.sim.step', appId, runId: event.runId, ts: index,
      data: { step: 'preview', message: 'done', receiptId: event.receiptId } }],
    receipts: [{ id: event.receiptId, appId, runId: event.runId, appFingerprint: fingerprint, outcome: extra.simulationOutcome ?? 'passed', summary: 'Preview complete' }] });
    const thumbnailObjectKey = `apps/${appId}/versions/${event.appVersion}/${fingerprint}/${event.receiptId}.png`;
    thumbnails.put(thumbnailObjectKey, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nZsAAAAASUVORK5CYII=', 'base64'), { contentType: 'image/png' });
    return { eventId: event.id, trigger, summary: `Updated screen ${index}`,
      thumbnailObjectKey: `apps/${appId}/versions/${event.appVersion}/${fingerprint}/${event.receiptId}.png` };
  }
  return { root, lifecycle, simulations, thumbnails, store, seed, close() { store.close(); simulations.close(); lifecycle.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('node-b history simulation persists all four checkpoint triggers with exact ledger identity', () => {
  const w = world();
  try {
    for (const [index, trigger] of (['agent-turn', 'deploy', 'edit', 'restore'] as const).entries()) {
      const input = w.seed(index + 1, trigger);
      const saved = w.store.checkpoint('notes', input);
      expect(saved.versionId).toBe(`version-${index + 1}`);
      expect(saved.occurredAt).toBe(w.lifecycle.events('notes')[index]!.occurredAt);
      expect(saved.eventId).toBe(input.eventId);
      expect(saved.thumbnailObjectKey).toBe(input.thumbnailObjectKey);
      expect(w.store.checkpoint('notes', input)).toEqual(saved);
    }
    const first = w.store.get('notes', 'version-1', 'simulation')!;
    expect(w.store.checkpoint('notes', { eventId: first.eventId, trigger: first.trigger, summary: first.summary, thumbnailObjectKey: first.thumbnailObjectKey })).toEqual(first);
    const reopened = openAppVersionStore(w.root, w.thumbnails);
    try {
      expect(reopened.list('notes').map(row => row.trigger)).toEqual(['restore', 'edit', 'deploy', 'agent-turn']);
      expect(reopened.get('notes', 'version-2', 'simulation')?.receiptId).toBe('receipt-2');
      expect(reopened.get('other', 'version-2', 'simulation')).toBeNull();
      expect(reopened.list('notes', 'live')).toEqual([]);
    } finally { reopened.close(); }
  } finally { w.close(); }
});

test('history refuses mismatched app, receipt, thumbnail, failed event and immutable rewrites', () => {
  const w = world();
  try {
    const input = w.seed(1, 'edit');
    expect(() => w.store.checkpoint('other', input)).toThrow('lifecycle event unavailable');
    expect(() => w.store.checkpoint('notes', { ...input, thumbnailObjectKey: 'https://other.invalid/image.png' })).toThrow('thumbnail does not match');
    w.store.checkpoint('notes', input);
    expect(() => w.store.checkpoint('notes', { ...input, summary: 'Rewritten' })).toThrow('immutable');
    const mismatch = createAppVersionStore({ databasePath: join(w.root, 'mismatch.sqlite'), lifecycle: w.lifecycle, thumbnails: w.thumbnails,
      simulations: { snapshot: appId => ({ ...w.simulations.snapshot(appId), receipts: w.simulations.snapshot(appId).receipts.map(row => ({ ...row, appFingerprint: 'f'.repeat(64) })) }) } });
    try { expect(() => mismatch.checkpoint('notes', input)).toThrow('receipt does not match'); }
    finally { mismatch.close(); }
    expect(() => w.store.checkpoint('notes', w.seed(2, 'edit', { outcome: 'failed' }))).toThrow('lacks version evidence');
    const missingImage = w.seed(3, 'edit');
    w.thumbnails.delete(missingImage.thumbnailObjectKey);
    expect(() => w.store.checkpoint('notes', missingImage)).toThrow('thumbnail unavailable');
    expect(w.store.list('notes')).toHaveLength(1);
  } finally { w.close(); }
});

test('unchanged edits coalesce while restores remain new records and environments stay separate', () => {
  const w = world();
  try {
    const original = w.store.checkpoint('notes', w.seed(1, 'edit'));
    const fingerprint = original.fingerprint;
    expect(w.store.checkpoint('notes', w.seed(2, 'agent-turn', { fingerprint }))).toEqual(original);
    expect(w.store.checkpoint('notes', w.seed(3, 'restore', { fingerprint })).versionId).toBe('version-3');
    w.store.checkpoint('notes', w.seed(4, 'deploy', { fingerprint, environment: 'live' }));
    expect(w.store.list('notes', 'simulation')).toHaveLength(2);
    expect(w.store.list('notes', 'live')).toHaveLength(1);
  } finally { w.close(); }
});

test('owner history HTTP route uses the production store and rejects untrusted metadata before persistence', async () => {
  const w = world();
  let opened = 0;
  const opts = {
    metaApi: { bearerToken: 'owner', noAuth: false },
    appHost: { handle: () => undefined, getManifest: (slug: string) => slug === 'notes' ? { slug } : undefined },
    appVersionStore: () => { opened++; return openAppVersionStore(w.root, w.thumbnails); },
  } as unknown as NexusHttpServerOpts;
  const request = (path: string, method = 'GET', body?: unknown, authorized = true) => routeRequest(new Request(`http://nexus.invalid/v1/apps/${path}`, {
    method, headers: { 'sec-fetch-site': 'cross-site', ...(authorized ? { authorization: 'Bearer owner' } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), opts, {} as never, null, createDevProxyRuntimeRef());
  try {
    const input = w.seed(1, 'agent-turn');
    expect((await request('notes/versions/checkpoints', 'POST', input, false))?.status).toBe(401);
    expect((await request('other/versions'))?.status).toBe(404);
    expect((await request('notes/versions?environment=wrong'))?.status).toBe(400);
    expect((await request('notes/versions', 'POST', input))?.status).toBe(405);
    expect((await request('notes/versions/checkpoints', 'POST', { ...input, versionId: 'forged' }))?.status).toBe(400);
    expect((await request('notes/versions/checkpoints', 'POST', { ...input, summary: 'x'.repeat(5000) }))?.status).toBe(413);
    expect(opened).toBe(0);
    const saved = await request('notes/versions/checkpoints', 'POST', input);
    expect(saved?.status).toBe(201);
    expect(saved?.headers.get('cache-control')).toBe('no-store');
    const result = await saved!.json() as { checkpoint: { versionId: string } };
    expect(result.checkpoint.versionId).toBe('version-1');
    const listed = await request('notes/versions');
    expect(listed?.status).toBe(200);
    expect(await listed!.json()).toEqual({ versions: w.store.list('notes') });
    expect((await request('notes/versions/checkpoints', 'POST', { ...input, thumbnailObjectKey: 'wrong' }))?.status).toBe(409);
  } finally { w.close(); }
});


test('mf3 counterexample: a successful lifecycle event cannot checkpoint a failed simulation receipt', () => {
  const w = world();
  try {
    const input = w.seed(1, 'edit', { simulationOutcome: 'failed' });
    expect(() => w.store.checkpoint('notes', input)).toThrow('simulation receipt does not match version');
    expect(w.store.list('notes')).toEqual([]);
  } finally { w.close(); }
});

test('mf3 counterexample: coalesced event replay keeps its original return value after newer saves and reopen', () => {
  const w = world();
  try {
    const original = w.store.checkpoint('notes', w.seed(1, 'edit'));
    const unchanged = w.seed(2, 'agent-turn', { fingerprint: original.fingerprint });
    expect(w.store.checkpoint('notes', unchanged)).toEqual(original);
    w.store.checkpoint('notes', w.seed(3, 'edit'));
    const reopened = openAppVersionStore(w.root, w.thumbnails);
    try {
      expect(reopened.checkpoint('notes', unchanged)).toEqual(original);
      expect(() => reopened.checkpoint('notes', { ...unchanged, summary: 'Changed replay input' })).toThrow('immutable');
      expect(() => reopened.checkpoint('notes', { ...unchanged, trigger: 'deploy' })).toThrow('immutable');
      expect(() => reopened.checkpoint('other', unchanged)).toThrow('immutable');
      expect(reopened.list('notes')).toHaveLength(2);
    } finally { reopened.close(); }
  } finally { w.close(); }
});

test('mf3 counterexample: caller triggers cannot relabel lifecycle actions or bypass unchanged-edit coalescing', () => {
  const w = world();
  try {
    const original = w.store.checkpoint('notes', w.seed(1, 'edit'));
    const cases: readonly [AppVersionTrigger, AppLifecycleAction][] = [
      ['deploy', 'simulated'], ['restore', 'simulated'], ['edit', 'promoted'], ['agent-turn', 'restored'],
      ['deploy', 'created'], ['restore', 'paused'], ['edit', 'receipt-issued'],
    ];
    for (const [offset, [trigger, action]] of cases.entries()) {
      const input = w.seed(offset + 2, trigger, { action, fingerprint: original.fingerprint });
      expect(() => w.store.checkpoint('notes', input)).toThrow('lifecycle action does not match checkpoint trigger');
    }
    expect(w.store.list('notes')).toEqual([original]);
  } finally { w.close(); }
});

test('restore producer supports restored and rolled-back actions with an exact new OID as ledger version', () => {
  const w = world();
  try {
    const oid = 'a'.repeat(40);
    const restored = w.store.checkpoint('notes', w.seed(1, 'restore', { action: 'restored', versionId: oid }));
    expect(restored.versionId).toBe(oid);
    expect(restored.thumbnailObjectKey).toContain(`/versions/${oid}/`);
    expect(w.store.checkpoint('notes', w.seed(2, 'restore')).trigger).toBe('restore');
    expect(w.store.checkpoint('notes', w.seed(3, 'deploy', { action: 'upgrade' })).trigger).toBe('deploy');
  } finally { w.close(); }
});


test('mf1 same-version new edit and agent-turn events coalesce without weakening version immutability', () => {
  const w = world();
  try {
    const original = w.store.checkpoint('notes', w.seed(1, 'edit'));
    for (const [offset, trigger] of (['edit', 'agent-turn'] as const).entries()) {
      const unchanged = w.seed(offset + 2, trigger, { versionId: original.versionId, fingerprint: original.fingerprint });
      expect(w.store.checkpoint('notes', unchanged)).toEqual(original);
      expect(w.store.checkpoint('notes', unchanged)).toEqual(original);
    }
    expect(() => w.store.checkpoint('notes', w.seed(4, 'edit', { versionId: original.versionId }))).toThrow('immutable');
    expect(() => w.store.checkpoint('notes', w.seed(5, 'restore', { versionId: original.versionId, fingerprint: original.fingerprint }))).toThrow('immutable');
    expect(w.store.list('notes')).toEqual([original]);
  } finally { w.close(); }
});

test('mf1 mapping-write rollback permits retry of a same-version event and preserves replay after later saves', () => {
  const w = world();
  const db = new Database(join(w.root, 'app-versions.sqlite'));
  try {
    const original = w.store.checkpoint('notes', w.seed(1, 'edit'));
    const unchanged = w.seed(2, 'agent-turn', { versionId: original.versionId, fingerprint: original.fingerprint });
    db.exec(`CREATE TRIGGER reject_request BEFORE INSERT ON app_version_checkpoint_requests
      WHEN NEW.event_id = 'event-2' BEGIN SELECT RAISE(ABORT, 'checkpoint-map-failed'); END`);
    expect(() => w.store.checkpoint('notes', unchanged)).toThrow('checkpoint-map-failed');
    expect(db.query("SELECT event_id FROM app_version_checkpoint_requests WHERE event_id = 'event-2'").get()).toBeNull();
    expect(w.store.list('notes')).toEqual([original]);
    db.exec('DROP TRIGGER reject_request');
    expect(w.store.checkpoint('notes', unchanged)).toEqual(original);
    w.store.checkpoint('notes', w.seed(3, 'edit'));
    const reopened = openAppVersionStore(w.root, w.thumbnails);
    try {
      expect(reopened.checkpoint('notes', unchanged)).toEqual(original);
      expect(() => reopened.checkpoint('notes', { ...unchanged, summary: 'Changed retry' })).toThrow('immutable');
      expect(reopened.list('notes')).toHaveLength(2);
    } finally { reopened.close(); }
  } finally { db.close(); w.close(); }
});
