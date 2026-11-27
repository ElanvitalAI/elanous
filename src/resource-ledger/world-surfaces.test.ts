// WORLD-REGISTRY surfaces — the one-line digest (fed snapshot · OP pulse) and the Nexus read API body.
// Expectations are literals (independent of the product's renderers).
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { WorldLedgerEvent } from './world-ledger-events.js';
import { foldWorld } from './world-registry.js';
import { worldApiBody, worldDigest } from './world-summary.js';
import { handleWorldApi } from '../nexus/api/resource-ledger.js';
import { buildFedSnapshot, formatSnapshot, type FedSources } from '../fed-observe/snapshot.js';
import { loadRhythm, renderPulseTable, rhythmRow, type PulseMeasure } from '../loops/op-pulse.js';

const T0 = new Date('2026-11-27T01:00:00.000Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000).toISOString();
const events: WorldLedgerEvent[] = [
  { event: 'world-actor', at: at(0), by: 'OP', actor: { id: 'loop:ok', kind: 'loop', mode: 'owner', registered: true, owner: 'JUD' } },
  { event: 'world-actor', at: at(0), by: 'loop:guardian', actor: { id: 'cron:abc@mshq', kind: 'cron', mode: 'discover', host: 'mshq', purpose: 'deploy',
    meta: { command: 'curl -H "Authorization: Bearer sk-ant-api03-SECRETSECRETSECRETSECRET" https://x' } } },
  { event: 'world-sweep', at: at(0), by: 'loop:guardian', scope: 'mshq', ok: true, appeared: ['cron:abc@mshq'], gone: [], beats: {}, counts: { cron: 1 } },
  { event: 'world-sweep', at: at(0), by: 'loop:guardian', scope: 'gcp2', ok: false, error: 'ssh timeout', appeared: [], gone: [], beats: {}, counts: {} },
];

describe('worldDigest', () => {
  test('fresh sweep: counts, sweep age and unreachable scopes in one line', () => {
    const d = worldDigest(foldWorld(events, new Date(at(10))), new Date(at(10)));
    expect(d.line).toBe('세계: live 1 · zombie 0 · unregistered 1 · no-owner 0 (shadow 0 · off 0 · total 2) · sweep 10m ago · unreachable gcp2');
    expect(d.stale).toBe(false);
  });
  test('no sweep newer than 35m → stale is said, never read as all-well', () => {
    const d = worldDigest(foldWorld(events, new Date(at(40))), new Date(at(40)));
    expect(d.stale).toBe(true);
    expect(d.line.endsWith('· sweep 40m ago ⚠ stale · unreachable gcp2')).toBe(true);
  });
  test('an empty ledger says it was never swept', () => {
    expect(worldDigest(foldWorld([], T0), T0).line).toBe('세계: live 0 · zombie 0 · unregistered 0 · no-owner 0 (shadow 0 · off 0 · total 0) · never swept (eln world sweep)');
  });
});

describe('read API', () => {
  test('filters and views', () => {
    const view = foldWorld(events, T0);
    expect(worldApiBody(view, T0, { kind: 'loop' }).actors!.map(a => a.id)).toEqual(['loop:ok']);
    expect(worldApiBody(view, T0, { view: 'anomalies' }).anomalies!.map(a => a.kind).sort()).toEqual(['unreachable', 'unregistered']);
    expect(worldApiBody(view, T0, { view: 'summary' }).actors).toBeUndefined();
  });
  test('handler: secrets never leave · bad view is 400 · no-store', async () => {
    const res = handleWorldApi(new URL('http://x/v1/ops/resources/world?kind=cron'), T0, () => events);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).not.toContain('SECRETSECRETSECRETSECRET');
    expect(text).toContain('cron:abc@mshq');
    expect(handleWorldApi(new URL('http://x/v1/ops/resources/world?view=everything'), T0, () => events).status).toBe(400);
  });
});

describe('OP surfaces carry the world line', () => {
  const line = '세계: live 3 · zombie 1 · unregistered 2 · no-owner 0 (shadow 0 · off 0 · total 6) · sweep 4m ago';
  test('fed snapshot prints it; an unread ledger prints «?» (not silence)', () => {
    const src: FedSources = { now: T0, installedSha: null, panes: [], pool: [], turns: [], errors: [], queues: [], mail: [], hands: [], blocks: [],
      landingFreeze: null, landHolds: [], commitments: null, land: null, judge: null, loops: null, release: null, kpi: null, unmeasured: [] };
    expect(formatSnapshot(buildFedSnapshot({ ...src, world: { line, stale: false, zombie: 1, unregistered: 2, noOwner: 0 } }))).toContain(line);
    expect(formatSnapshot(buildFedSnapshot({ ...src, world: null }))).toContain('세계: ? (lease ledger unread)');
    expect(formatSnapshot(buildFedSnapshot(src))).not.toContain('세계');
  });
  test('pulse table prints it', () => {
    const rhythm = loadRhythm(join(import.meta.dir, '../../graphs/triggers/op-pulse.rhythm.yaml'));
    const m: PulseMeasure = { at: '2026-11-27T01:00:00Z', version: '0.3.38', landedPerH: 20, greenPerH: 10, judgeQueue: 0, judgeWaitMedianMin: 0, budget: [], unmeasured: [], spaces: [], world: line };
    expect(renderPulseTable(m, { phase: 'build', evidence: 'e' }, rhythmRow(rhythm, 'build'), [])).toContain(line);
  });
});
