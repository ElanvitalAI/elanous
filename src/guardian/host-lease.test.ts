import { describe, expect, test } from 'bun:test';
import { createHostLeaseSimulator, type HostLeaseRequest } from './host-lease.js';

const initialTime = Date.parse('2026-11-07T10:00:00.000+09:00');
const request = (overrides: Partial<HostLeaseRequest> = {}): HostLeaseRequest => ({
  requestId: 'req-1',
  runId: 'run-1',
  requestedBy: 'coordinator',
  consumer: 'TSC-DIET',
  purpose: 'edge-import-cut',
  host: 'gcp1',
  priority: 'P1: dedicated cut',
  expiresAt: new Date(initialTime + 60_000).toISOString(),
  ...overrides,
});

describe('Guardian host lease simulation device', () => {
  test('gcp1 keeps the current TSC-DIET lease and denies new cross-tab work with alternatives', () => {
    const sim = createHostLeaseSimulator({ now: () => new Date(initialTime) });
    const owner = sim.request(request());
    expect(owner.state).toBe('granted');
    if (owner.state !== 'granted') return;
    expect(sim.admit({ host: 'gcp1', leaseId: owner.lease.leaseId, runId: 'run-1', consumer: 'TSC-DIET' }))
      .toEqual({ admitted: true });

    const denied = sim.request(request({ requestId: 'req-remote-test', runId: 'remote-test-8', consumer: 'RLA-RFC',
      purpose: 'remote-test', priority: 'P2: verification' }));
    expect(denied).toEqual({ state: 'denied', requestId: 'req-remote-test', reason: 'exclusive-lease-conflict',
      alternatives: ['mshq', 'node-c', 'aws1', 'gcp2'] });
    expect(sim.request(request({ requestId: 'req-1', host: 'aws1', consumer: 'RLA-RFC', runId: 'spoofed-run',
      purpose: 'remote-test' }))).toEqual({ state: 'denied', requestId: 'req-1', reason: 'request-id-conflict', alternatives: [] });
    expect(sim.ledger()).toMatchObject([{ leaseId: 'lease:req-1', state: 'active', request: { consumer: 'TSC-DIET', runId: 'run-1' } }]);
    expect(sim.coordinatorNotices().map((notice) => notice.eventType)).toEqual(['lease.granted', 'lease.denied', 'lease.denied']);
  });

  test('node-b grants the release cut gate and denies unrelated work, then records release, expiry, and notices', () => {
    let now = initialTime;
    const sim = createHostLeaseSimulator({ now: () => new Date(now) });
    const cutGateRequest = request({ requestId: 'req-cut-gate', runId: 'cut-036', consumer: 'release-gate',
      purpose: 'release-cut-gate', host: 'node-b', releaseVersion: '0.3.7', expiresAt: new Date(now + 10_000).toISOString() });
    const cutGate = sim.request(cutGateRequest);
    expect(cutGate.state).toBe('granted');
    if (cutGate.state !== 'granted') return;
    expect(sim.admit({ host: 'node-b', leaseId: cutGate.lease.leaseId, runId: 'cut-036', consumer: 'release-gate' }))
      .toEqual({ admitted: true });

    const denied = sim.request(request({ requestId: 'req-unrelated', runId: 'remote-test-9', consumer: 'RLA-RFC',
      purpose: 'remote-test', host: 'node-b', priority: 'P2: verification' }));
    expect(denied).toMatchObject({ state: 'denied', reason: 'host-purpose-restricted', alternatives: ['mshq', 'node-c', 'aws1', 'gcp2'] });
    expect(sim.release(cutGate.lease.leaseId)).toBe(true);
    expect(sim.release(cutGate.lease.leaseId)).toBe(false);
    expect(sim.request(cutGateRequest).state).toBe('released');

    const secondRequest = request({ requestId: 'req-cut-gate-2', runId: 'cut-036-2', consumer: 'release-gate',
      purpose: 'release-cut-gate', host: 'node-b', releaseVersion: '0.3.7', expiresAt: new Date(now + 20_000).toISOString() });
    const second = sim.request(secondRequest);
    expect(second.state).toBe('granted');
    now += 20_000;
    expect(sim.expireDue()).toEqual(['lease:req-cut-gate-2']);
    expect(sim.admit({ host: 'node-b', leaseId: 'lease:req-cut-gate-2', runId: 'cut-036-2', consumer: 'release-gate' }))
      .toEqual({ admitted: false, reason: 'lease-not-active' });
    expect(sim.eventLog().map((event) => event.type)).toContain('lease.violation');
    expect(sim.request(secondRequest).state).toBe('expired');
    expect(sim.request(request({ requestId: 'req-cut-gate-3', runId: 'cut-036-3', consumer: 'release-gate',
      purpose: 'release-cut-gate', host: 'node-b', releaseVersion: '0.3.7', expiresAt: new Date(now + 10_000).toISOString() })).state)
      .toBe('granted');
    expect(sim.coordinatorNotices().map((notice) => notice.eventType)).toEqual([
      'lease.granted', 'lease.denied', 'lease.released', 'lease.granted', 'lease.expired', 'lease.violation', 'lease.granted',
    ]);
  });
});
