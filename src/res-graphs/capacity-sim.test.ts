/**
 * SIM world — capacity lease requests (RES-CAPACITY-LEASE · 대표 11-25 22:4x «size, not a host»).
 * Fixture catalog (literals, not DEFAULT_HOSTS): requests of 16/64/128/256 GB with mixed availability, the release
 * reservation, budget caps, nothing fits → refusal with options, local lease through the lease graph without a cloud
 * start/stop, discovery from a fake ssh/cloud map, and the NL intake schema.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitCapacity, discoverCatalog, loadCatalog, planCapacity, parseSize, type CapacityRequest, type HostSpec } from './capacity.js';
import { classifyCapacityRequest, validateIntake } from './capacity-intake.js';
import { loadLeases, markReady, requestLease } from './burst.js';
import { runNode, type NodeContext } from './res-nodes.js';

let dir: string; let root: string; const now = new Date('2026-11-25T14:00:00Z');
const H = (host: string, kind: HostSpec['kind'], ramGiB: number, rate: number, extra: Partial<HostSpec> = {}): HostSpec =>
  ({ host, kind, ramGiB, cpu: 16, ratePerHourUsd: rate, source: 'config', ...extra });
const CAT: HostSpec[] = [
  H('lan64', 'lan', 64, 0, { load1: 2 }),
  H('lan512', 'lan', 512, 0, { cpu: 32, load1: 4 }),
  H('cheap128', 'cloud', 128, 1.1),
  H('dear128', 'cloud', 128, 1.3),
  H('mid64', 'cloud', 64, 0.6),
];
const req = (ramGiB: number, extra: Partial<CapacityRequest> = {}): CapacityRequest =>
  ({ ramGiB, ttlMin: 240, count: 1, reason: 'sim', requester: 'OP', ...extra });
const reserve = () => writeFileSync(join(root, 'reservation.json'), JSON.stringify({ active: true, host: 'node-b', nonReleaseSlots: 1, phase: 'window', version: '9.9.9', since: now.toISOString() }));
// 출처: #40170 CapacityPolicy — sim fixture budget (not a product bound)
const policy = { cloudBudgetUsd: 10, maxLoadPerCpu: 0.8, releaseReservedHosts: ['lan512'] };

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'res-cap-')); root = join(dir, 'gs'); mkdirSync(root, { recursive: true }); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('capacity planner', () => {
  test('16 GB → a free LAN host, zero cost, smallest-first tie by name', () => {
    const d = planCapacity(root, req(16), now, CAT, policy);
    expect(d.outcome).toBe('picked');
    if (d.outcome !== 'picked') return;
    expect(d.picks.map(p => p.host)).toEqual(['lan512']);
    expect(d.estUsd).toBe(0);
  });
  test('64 GB with lan512 release-reserved → lan64', () => {
    reserve();
    const d = planCapacity(root, req(64), now, CAT, policy);
    expect(d.outcome === 'picked' && d.picks[0]!.host).toBe('lan64');
    expect(d.rejected).toContainEqual({ host: 'lan512', why: 'reserved for release 9.9.9' });
  });
  test('128 GB while lan512 reserved → ready cloud beats cheaper stopped cloud', () => {
    reserve();
    markReady(root, 'dear128', 'ready', 'sim', now);
    const d = planCapacity(root, req(128), now, CAT, policy);
    expect(d.outcome).toBe('picked');
    if (d.outcome !== 'picked') return;
    expect(d.picks[0]!.host).toBe('dear128');
    expect(d.estUsd).toBe(5.2);
    expect(d.rejected).toContainEqual({ host: 'lan64', why: '64 GB too small' });
  });
  test('128 GB nothing ready → cheapest cloud type, ready checks first', () => {
    reserve();
    const d = planCapacity(root, req(128), now, CAT, policy);
    expect(d.outcome === 'picked' && d.picks[0]!.host).toBe('cheap128');
    expect(d.outcome === 'picked' && d.reasons[0]).toBe('cheap128 128 GB stopped → ready checks first, $1.10/h');
  });
  test('budget cap: 2× 128 GB for 8h exceeds $10 → CEO card, nothing written', () => {
    reserve();
    const d = planCapacity(root, req(128, { count: 2, ttlMin: 480 }), now, CAT, policy);
    expect(d.outcome).toBe('needs-ceo');
    if (d.outcome !== 'needs-ceo') return;
    expect(d.estUsd).toBe(19.2);
    expect(d.card).toContain('est $19.20');
    expect(loadLeases(root)).toEqual([]);
  });
  test('--budget on the request covers it → picked', () => {
    reserve();
    // 출처: #40170 planCapacity — request budget covers est 19.2
    const d = planCapacity(root, req(128, { count: 2, ttlMin: 480, budgetUsd: 25 }), now, CAT, policy);
    expect(d.outcome === 'picked' && d.picks.map(p => p.host)).toEqual(['cheap128', 'dear128']);
  });
  test('no cloud budget at all → every cloud start is a card', () => {
    reserve();
    const d = planCapacity(root, req(128), now, CAT, { ...policy, cloudBudgetUsd: null });
    expect(d.outcome).toBe('needs-ceo');
  });
  test('256 GB with lan512 reserved → refused with options', () => {
    reserve();
    const d = planCapacity(root, req(256), now, CAT, policy);
    expect(d.outcome).toBe('refused');
    if (d.outcome !== 'refused') return;
    expect(d.reasons[0]).toBe('nothing fits 1× 256 GB for 4h: 0/1 hosts available');
    expect(d.options[0]).toBe('wait for lan512 (leased/reserved/busy now) — eln res lease list');
    expect(d.options.some(o => o.includes('cloud type ≥ 256 GB'))).toBe(true);
  });
  test('busy LAN host and leased cloud are skipped', () => {
    const cat = [H('lanbusy', 'lan', 128, 0, { load1: 15 }), H('c1', 'cloud', 128, 1), H('c2', 'cloud', 128, 2)];
    requestLease(root, { host: 'c1', ttlMin: 60, reason: 'other', requester: 'TC' }, now);
    const d = planCapacity(root, req(128), now, cat, policy);
    expect(d.outcome === 'picked' && d.picks[0]!.host).toBe('c2');
    expect(d.rejected.map(r => r.host)).toEqual(['lanbusy', 'c1']);
  });
  test('not-leasable host never picked', () => {
    const d = planCapacity(root, req(16), now, [H('rev', 'lan', 128, 0, { leasable: false, notLeasableWhy: 'review only' })], policy);
    expect(d.outcome).toBe('refused');
  });
  test('parseSize', () => {
    expect(parseSize('128G')).toBe(128); expect(parseSize('64GB')).toBe(64); expect(parseSize('1T')).toBe(1024);
    expect(() => parseSize('big')).toThrow();
  });
});

describe('commit → lease graph', () => {
  const ctx = (runId: string): NodeContext => ({ graphId: 'res-burst-lease', runId, input: { window: runId, stage: 'live', vars: { seatState: dir, stateRoot: dir } }, nodeInput: { root } });
  test('LAN pick becomes a local lease: start/stop never touch the actuator', () => {
    const d = planCapacity(root, req(16), now, CAT, policy);
    if (d.outcome !== 'picked') throw new Error('expected pick');
    const [lease] = commitCapacity(root, req(16), d, now);
    expect(lease!.local).toBe(true);
    const calls: string[] = [];
    const deps = { now: () => now, actuate: (s: string, h: string) => { calls.push(`${s}:${h}`); return { status: 0, stdout: '0\n', stderr: '' }; } };
    expect(runNode('lease-route', ctx('r1'), deps).outcome).toBe('activate');
    expect(runNode('lease-start', ctx('r1'), deps).outcome).toBe('ready');
    expect(runNode('lease-register', ctx('r1'), deps).outcome).toBe('ok');
    const later = new Date(now.getTime() + 241 * 60_000);
    const d2 = { ...deps, now: () => later };
    expect(runNode('lease-route', ctx('r2'), d2)).toMatchObject({ outcome: 'drain', why: 'ttl' });
    runNode('lease-drain', ctx('r2'), d2);
    expect(runNode('run-stop', ctx('r2'), d2).outcome).toBe('ok');
    expect(calls).toEqual(['inflight:lan512']);
    expect(loadLeases(root)[0]!.state).toBe('stopped');
  });
  test('cloud pick splits --budget across leases by cost share', () => {
    reserve();
    const r = req(128, { count: 2, ttlMin: 480, budgetUsd: 25 });
    const d = planCapacity(root, r, now, CAT, policy);
    if (d.outcome !== 'picked') throw new Error('expected pick');
    const leases = commitCapacity(root, r, d, now);
    expect(leases.map(l => [l.host, l.budgetUsd, l.local])).toEqual([['cheap128', 11.46, undefined], ['dear128', 13.54, undefined]]);
  });
});

describe('catalog discovery', () => {
  test('ssh sysctl + cloud map type → specs; a silent host keeps its old value', () => {
    const seat = join(dir, 'seat'); mkdirSync(join(seat, 'OP', 'tools'), { recursive: true });
    writeFileSync(join(seat, 'OP', 'cloud-rates.tsv'), 'vm\tr8g.4xlarge\tap-northeast-2\tlinux\t1.5\thour\n');
    const sh = (cmd: string, args: string[]) => {
      if (cmd.endsWith('cloud-vm.sh')) return { status: 0, stdout: '# host\naws1\taws\tx\ty\tr8g.4xlarge\tlinux\t-\naws2\taws\tx\ty\tweird.type\tlinux\t-\n' };
      const host = args[4];
      if (host === 'node-b') return { status: 0, stdout: `${512 * 2 ** 30} 32 3.5 ${100 * 2 ** 20}\n` };
      return { status: 255, stdout: '' };
    };
    const { hosts, failed } = discoverCatalog(root, now, { sh, seatState: seat });
    const by = Object.fromEntries(hosts.map(h => [h.host, h]));
    expect([by['node-b']!.ramGiB, by['node-b']!.cpu, by['node-b']!.load1, by['node-b']!.diskGiB, by['node-b']!.source]).toEqual([512, 32, 3.5, 100, 'discovered']);
    expect([by['aws1']!.ramGiB, by['aws1']!.ratePerHourUsd]).toEqual([128, 1.5]);
    expect(failed).toContainEqual({ host: 'aws2', why: 'unknown instance type weird.type' });
    expect(failed).toContainEqual({ host: 'minim5', why: 'ssh probe failed (exit 255)' });
    expect(loadCatalog(root).find(h => h.host === 'aws1')!.ratePerHourUsd).toBe(1.5);
  });
  test('config override wins over cache', () => {
    writeFileSync(join(root, 'host-catalog.config.json'), JSON.stringify({ hosts: [{ host: 'minim5', ramGiB: 96 }], policy: { cloudBudgetUsd: 3 } }));
    expect(loadCatalog(root).find(h => h.host === 'minim5')!.ramGiB).toBe(96);
  });
});

describe('natural-language intake', () => {
  test('judge JSON → fields', async () => {
    const call = async () => ({ text: '{"ramGiB":128,"cpu":null,"ttlMin":240,"count":1,"budgetUsd":null,"urgency":"normal","reason":null}' });
    expect(await classifyCapacityRequest('128GB 머신 하나 4시간', call)).toEqual({ ramGiB: 128, ttlMin: 240, count: 1, cpu: null, budgetUsd: null, urgency: 'normal', reason: null });
  });
  test('missing size or duration → unmeasured (null), never guessed', async () => {
    expect(await classifyCapacityRequest('머신 하나 줘', async () => ({ text: '{"ramGiB":null}' }))).toBeNull();
    expect(validateIntake({ ramGiB: 64 })).toBeNull();
    expect(validateIntake({ ramGiB: 64, ttlMin: 90, count: 20 })).toBeNull();
  });
});
