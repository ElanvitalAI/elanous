import { expect, test } from 'bun:test';
import type { SimClock } from './contract.js';
import { createRemoteHost, createSupplyTargets } from './supply-remote.js';

function stubClock(iso = '2026-11-20T00:00:00+09:00'): SimClock {
  let t = new Date(iso).getTime();
  return { now: () => new Date(t), advance: (ms) => { t += ms; }, set: (i) => { t = new Date(i).getTime(); } };
}

test('codex-team to pod: allowed, one lease line, no value', () => {
  const { pod } = createSupplyTargets(stubClock());
  const r = pod.supply('codex-team');
  expect(r).toEqual({ ok: true, leaseId: 'MD-UX-SIM-LLM-SUPPLY-TARGETS-TS:pod-lease-1' });
  expect(pod.name).toBe('pod:job-1');
  expect(pod.leases()).toEqual([{ vaultItem: 'codex-team', leaseId: 'MD-UX-SIM-LLM-SUPPLY-TARGETS-TS:pod-lease-1', expiresAt: '2026-11-19T16:00:00.000Z' }]);
  expect(JSON.stringify(pod.leases())).not.toMatch(/token|secret-value/);
});

test('claude-acp: pod/ta refused host-only-item, config-dir ok with 0600', () => {
  const t = createSupplyTargets(stubClock());
  expect(t.pod.supply('claude-acp')).toEqual({ ok: false, reason: 'host-only-item' });
  expect(t.ta.supply('claude-acp')).toEqual({ ok: false, reason: 'host-only-item' });
  expect(t.pod.leases().length).toBe(0);
  expect(t.configDir.supply('claude-acp').ok).toBe(true);
  expect(t.configDir.shape).toEqual({ mount: 'file', mode: 0o600 });
  expect(t.configDir.shape.mode).toBe(384);
});

test('refusal reasons match real supply.ts names', () => {
  const t = createSupplyTargets(stubClock());
  expect(t.pod.supply('codex-default')).toEqual({ ok: false, reason: 'target-not-allowed' });
  expect(t.pod.supply('nope')).toEqual({ ok: false, reason: 'item-not-allowed' });
  t.ta.setWired(false);
  expect(t.ta.supply('codex-team')).toEqual({ ok: false, reason: 'handler-unwired' });
  expect(t.configDir.supply('codex-team').ok).toBe(true);
});

test('revoke removes lease; clock past TTL empties list', () => {
  const clock = stubClock();
  const { pod, ta } = createSupplyTargets(clock);
  const a = pod.supply('codex-team');
  if (!a.ok) throw new Error('expected ok');
  pod.revoke(a.leaseId);
  expect(pod.leases().length).toBe(0);
  ta.supply('codex-team');
  expect(ta.leases().length).toBe(1);
  clock.advance(3_599_999);
  expect(ta.leases().length).toBe(1);
  clock.advance(1);
  expect(ta.leases().length).toBe(0);
});

test('remote host heartbeat reports drift between desired and observed sha', () => {
  const clock = stubClock();
  const h = createRemoteHost(clock, 'node-b');
  h.setDesiredSha('aaa111');
  h.setObservedSha('bbb222');
  expect(h.heartbeat()).toEqual({ at: '2026-11-19T15:00:00.000Z', desiredSha: 'aaa111', observedSha: 'bbb222', alive: true });
  expect(h.drifted()).toBe(true);
  clock.advance(60_000);
  h.setObservedSha('aaa111');
  h.setAlive(false);
  expect(h.heartbeat()).toEqual({ at: '2026-11-19T15:01:00.000Z', desiredSha: 'aaa111', observedSha: 'aaa111', alive: false });
  expect(h.drifted()).toBe(false);
  expect(h.name).toBe('node-b');
});
