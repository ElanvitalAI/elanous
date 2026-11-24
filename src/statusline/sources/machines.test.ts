import { describe, expect, test } from 'bun:test';
import type { ResourcesMap } from '../../ops/resources';
import { createFleetSegment, fleetFromResources, FLEET_STALE_MS, hostLoads, readNexusResources, startFleetPoller, type FleetRead } from './machines';
import { localNexusBaseUrl, localNexusTokenPath } from '../../nexus/local-endpoint';
import { ensureAuthToken } from '../../auth/acp-token';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNextTuiStatusline } from '../next-tui';

const NOW = Date.parse('2026-11-17T14:00:00Z');
const cell = (value: number | null, observedAt: string | null = new Date(NOW).toISOString()) => ({ value, observedAt, missing: value === null ? 'no beat' : null });
function host(name: string, load: number | null, cpus: number | null, observedAt?: string | null) {
  return { name, load1: cell(load, observedAt === undefined ? new Date(NOW).toISOString() : observedAt), load5: cell(load), load15: cell(load),
    cpuCount: cell(cpus), memFreeGb: cell(8), memTotalGb: cell(32) };
}
const map = (...hosts: ReturnType<typeof host>[]): ResourcesMap => ({ generatedAt: '', readAt: '', hosts, pods: [], missing: [] });

describe('fleet fold (§2c bands · exception first)', () => {
  test('all hosts between idle and warn → one quiet dot', () => {
    expect(fleetFromResources(map(host('mshq', 6, 24), host('node-b', 9, 16)), NOW)).toMatchObject({ level: 'ok', text: '●' });
    // An idle host is not an exception for the status line.
    expect(fleetFromResources(map(host('aws1', 0.2, 8)), NOW)).toMatchObject({ level: 'ok', text: '●', idle: 1 });
  });
  test('over the overload line → red, worst host first, others counted', () => {
    expect(fleetFromResources(map(host('mshq', 6, 24), host('node-c', 22, 14), host('node-b', 40, 32)), NOW))
      .toMatchObject({ level: 'danger', text: '⚑ node-c 1.6× +1 hot', hot: 2 });
  });
  test('between 0.9 and 1.2 → amber', () => {
    expect(fleetFromResources(map(host('node-c', 14, 14)), NOW)).toMatchObject({ level: 'warn', text: '▲ node-c 1.0×' });
  });
  test('stale or unmeasured hosts are «?», never healthy; no hosts at all is «fleet ?»', () => {
    const stale = new Date(NOW - FLEET_STALE_MS - 1).toISOString();
    expect(fleetFromResources(map(host('node-b', 3, 16, stale)), NOW)).toMatchObject({ level: 'unknown', text: 'node-b ?' });
    expect(fleetFromResources(map(host('node-b', null, 16), host('node-c', 3, 14)), NOW)).toMatchObject({ level: 'unknown', text: 'node-b ?' });
    expect(fleetFromResources(map(), NOW)).toMatchObject({ level: 'unknown', text: 'fleet ?' });
    expect(fleetFromResources(null, NOW)).toMatchObject({ level: 'unknown', text: 'fleet ?' });
  });
});

describe('fleet poller and segment', () => {
  test('a failed read keeps drawing «fleet ?» and onChange fires only when the drawn value changes', async () => {
    const answers: Array<ResourcesMap | Error> = [map(host('mshq', 6, 24)), map(host('mshq', 6, 24)), new Error('down')];
    const changes: string[] = [];
    const poller = startFleetPoller({ read: async () => { const next = answers.shift(); if (next instanceof Error) throw next; return next ?? null; },
      onChange: (value) => changes.push(value.text), intervalMs: 1, now: () => NOW });
    await new Promise((resolve) => setTimeout(resolve, 30));
    poller.stop();
    expect(changes).toEqual(['●', 'fleet ?']);
    expect(poller.current().text).toBe('fleet ?');
  });

  test('the segment stays hidden until the Nexus has reported a host (no Nexus, or no tracked hosts = no segment)', async () => {
    let answer: FleetRead = { kind: 'ok', map: map() };
    let repaints = 0;
    const segment = createFleetSegment({ onChange: () => { repaints += 1; }, read: async () => answer, intervalMs: 1, now: () => NOW });
    segment.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(segment.value()).toBeUndefined();
    expect(repaints).toBe(0);
    answer = { kind: 'ok', map: map(host('node-c', 22, 14)) };
    await new Promise((resolve) => setTimeout(resolve, 20));
    segment.stop();
    expect(segment.value()?.level).toBe('danger');
    expect(repaints).toBe(1);
  });

  test('reader: the view on 200 with the bearer; anything else (refused, wrong shape, no Nexus) is no answer', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const answering = (status: number, body: unknown) => (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
    const view = map(host('mshq', 6, 24));
    expect(await readNexusResources({ baseUrl: () => 'http://127.0.0.1:1/', token: () => 'tok', fetchImpl: answering(200, view) })).toEqual({ kind: 'ok', map: view });
    expect(seen).toEqual([{ url: 'http://127.0.0.1:1/v1/ops/resources', auth: 'Bearer tok' }]);
    expect(await readNexusResources({ baseUrl: () => 'http://x', token: () => undefined, fetchImpl: answering(401, { error: 'unauthorized' }) })).toEqual({ kind: 'refused', status: 401 });
    // Operator mode off: the ops view refuses, but the token works on an owner route → quiet «not-operator».
    const operatorOff = (async (url: string | URL | Request) => String(url).endsWith('/v1/ops/resources')
      ? new Response('{"error":"unauthorized"}', { status: 401 }) : new Response('{}', { status: 200 })) as typeof fetch;
    expect(await readNexusResources({ baseUrl: () => 'http://x', token: () => 'tok', fetchImpl: operatorOff })).toEqual({ kind: 'not-operator' });
    expect(await readNexusResources({ baseUrl: () => 'http://x', token: () => undefined, fetchImpl: answering(200, { nope: true }) })).toEqual({ kind: 'failed' });
    expect(await readNexusResources({ baseUrl: () => undefined, token: () => undefined, fetchImpl: answering(200, view) })).toEqual({ kind: 'no-nexus' });
  });
});

describe('fleet in the Next TUI footer', () => {
  const footer = (fleet: ReturnType<typeof fleetFromResources> | undefined, width: number, color = false) => createNextTuiStatusline({
    build: { version: '0.3.28-dev.0', sha: '', source: 'checkout' }, cwd: () => '/work/repo', color, userPath: '/nonexistent/statusline.yaml',
    fleet: () => fleet,
  }).render({ width, turnState: 'idle', model: 'grok-4.7', queueCount: 0, backgroundCount: 0 } as never);
  const hot = fleetFromResources(map(host('mshq', 6, 24), host('node-c', 22, 14)), NOW);
  const ok = fleetFromResources(map(host('mshq', 6, 24)), NOW);

  test('no fleet value → the footer is exactly as before (no segment)', () => {
    for (const width of [200, 130, 100, 80, 40]) expect(footer(undefined, width).plain).not.toContain('●');
  });
  test('md and lg draw it after the version; xs/sm leave it out (slice 1)', () => {
    expect(footer(ok, 130).plain.endsWith(' · ●')).toBe(true);
    expect(footer(hot, 100).plain).toContain('dev · ⚑ node-c 1.6×');
    expect(footer(hot, 60).plain).not.toContain('node-c');
    expect(footer(hot, 40).plain).not.toContain('node-c');
  });
  test('hot is red, warm is amber (meaning also in the glyph for NO_COLOR)', () => {
    expect(footer(hot, 100, true).shown).toContain('\x1b[31m⚑ node-c 1.6×\x1b[39m');
    const warm = fleetFromResources(map(host('node-c', 14, 14)), NOW);
    expect(footer(warm, 100, true).shown).toContain('\x1b[33m▲ node-c 1.0×\x1b[39m');
  });
});

describe('#38260 REVIEW-2 ①: one endpoint for the CLI and the status line', () => {
  test('the token path is the one ensureAuthToken writes (same config dir), and reading never creates it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-token-'));
    try {
      expect(localNexusTokenPath(dir)).toBe(ensureAuthToken(dir).path);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('the address: ELANOUS_NEXUS_URL first, else the runtime host and port (wildcard → loopback), not a fixed 127.0.0.1', () => {
    expect(localNexusBaseUrl({ ELANOUS_NEXUS_URL: 'http://nexus.test:9/' }, { httpPort: 1 })).toBe('http://nexus.test:9');
    expect(localNexusBaseUrl({}, { httpHost: '100.64.0.7', httpPort: 31415 })).toBe('http://100.64.0.7:31415');
    expect(localNexusBaseUrl({}, { httpHost: '0.0.0.0', httpPort: 31415 })).toBe('http://127.0.0.1:31415');
    expect(localNexusBaseUrl({}, { httpHost: '::1', httpPort: 31415 })).toBe('http://[::1]:31415');
    expect(localNexusBaseUrl({}, null)).toBeUndefined();
  });
  test('a refused token shows «fleet auth?» (never a silently hidden segment); no Nexus stays hidden', async () => {
    let answer: FleetRead = { kind: 'refused', status: 401 };
    let repaints = 0;
    const segment = createFleetSegment({ onChange: () => { repaints += 1; }, read: async () => answer, intervalMs: 1, now: () => NOW });
    segment.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(segment.value()?.text).toBe('fleet auth?');
    expect(repaints).toBe(1);
    answer = { kind: 'no-nexus' };
    await new Promise((resolve) => setTimeout(resolve, 10));
    segment.stop();
    expect(segment.value()).toBeUndefined();
  });
});

test('#38260 REVIEW-2 ②: stop() ends the poller — no read after it, even when one was in flight', async () => {
  let reads = 0;
  let release: (() => void) | undefined;
  const segment = createFleetSegment({ onChange: () => {}, intervalMs: 1, now: () => NOW,
    read: () => { reads += 1; return new Promise<FleetRead>((resolve) => { release = () => resolve({ kind: 'ok', map: map(host('mshq', 6, 24)) }); }); } });
  segment.start();
  segment.start(); // a second start on the same segment does not start a second poller
  expect(reads).toBe(1);
  segment.stop();
  release?.();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(reads).toBe(1);
  expect(segment.value()).toBeUndefined();
});

test('TUI-STATUS-3ROW row 3: per-host load from the same answer — rounded, ⚠ from the 0.9 band, «?» when unmeasured or stale', () => {
  expect(hostLoads(map(host('mshq', 12.4, 24), host('node-b', 25.2, 16), host('minim5', 4, 10), host('mbp', null, 10),
    host('aws1', 3, 8, new Date(NOW - FLEET_STALE_MS - 1).toISOString())), NOW).map((row) => row.text))
    .toEqual(['mshq 12', 'node-b 25⚠', 'minim5 4', 'mbp ?', 'aws1 ?']);
  expect(hostLoads(null, NOW)).toEqual([]);
});
