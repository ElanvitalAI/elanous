import { expect, test } from 'bun:test';

import { createHerdrAgentReporter } from './herdr-agent-report.js';
import { HerdrSequenceLease } from './herdr-sequence-lease.js';
import { createFakeHerdr } from '../ux-sim/fake-herdr.js';

test('a same-millisecond restart reserves past a killed reporter and clears its stale agent first', () => {
  const store = { value: undefined as number | undefined, read() { return this.value; }, write(n: number) { this.value = n; } };
  const herdr = createFakeHerdr({ panes: [] });
  const run = (argv: string[]) => {
    const result = herdr.runSync(argv);
    return { ok: result.code === 0, stderr: result.stderr };
  };
  const reporter = (sessionId: string) => createHerdrAgentReporter({
    env: { HERDR_ENV: '1', HERDR_PANE_ID: 'wM:p1' }, run, seqStore: store, now: () => 100, sessionId, log: () => {},
    pruneStaleOnStart: true,
  })!;

  const first = reporter('first');
  first.start();
  first.turn('busy'); // SIGKILL: no release, but the reserved high-watermark survives.
  const staleSeq = herdr.reportedAgents()[0]?.seq ?? 0;
  expect(herdr.reportedAgents()[0]?.state).toBe('working');

  const restarted = reporter('second');
  restarted.start();
  expect(herdr.reportedAgents()).toHaveLength(1);
  expect(herdr.reportedAgents()[0]?.state).toBe('idle');
  const calls = herdr.calls();
  const lastReport = calls.map((argv) => argv[1]).lastIndexOf('report-agent');
  const cleanup = calls.map((argv) => argv[1]).lastIndexOf('release-agent');
  expect(cleanup).toBeGreaterThan(0);
  expect(cleanup).toBeLessThan(lastReport);
  const cleanupArgs = calls[cleanup] ?? [];
  const cleanupSeq = Number(cleanupArgs[cleanupArgs.indexOf('--seq') + 1]);
  expect(cleanupSeq).toBeGreaterThan(staleSeq);
});

test('failed stale cleanup is logged but does not prevent the new idle registration', () => {
  const herdr = createFakeHerdr({ panes: [] });
  const calls: string[][] = [];
  const logs: string[] = [];
  let cleanupFailed = false;
  const reporter = createHerdrAgentReporter({
    env: { HERDR_ENV: '1', HERDR_PANE_ID: 'wM:p1' },
    run(argv) {
      calls.push(argv);
      if (argv[1] === 'release-agent' && !cleanupFailed) {
        cleanupFailed = true;
        return { ok: false, stderr: 'cleanup denied' };
      }
      const result = herdr.runSync(argv);
      return { ok: result.code === 0, stderr: result.stderr };
    },
    seqStore: { read: () => undefined, write: () => {} },
    now: () => 100,
    sessionId: 'new-session',
    log: (event) => logs.push(event),
    pruneStaleOnStart: true,
  })!;

  reporter.start();

  expect(calls.map((argv) => argv[1])).toEqual(['release-agent', 'report-agent', 'report-agent-session']);
  expect(logs).toContain('startup-prune-failed');
  expect(herdr.reportedAgents()).toHaveLength(1);
  expect(herdr.reportedAgents()[0]?.state).toBe('idle');
});

test('sequence lease ignores a corrupt stored high-watermark instead of propagating NaN', () => {
  const writes: number[] = [];
  const lease = new HerdrSequenceLease({ read: () => Number.NaN, write: (seq) => writes.push(seq) }, () => 100, () => {}, 2);

  expect(lease.next()).toBe(103);
  expect(writes).toEqual([104]);
});

test('a sequence issued at the reservation boundary is still below the next process sequence', () => {
  const store = { value: undefined as number | undefined, read() { return this.value; }, write(seq: number) { this.value = seq; } };
  const first = new HerdrSequenceLease(store, () => 100, () => {}, 2);
  first.next();
  const boundarySeq = first.next();
  expect(store.value).toBe(boundarySeq);

  const restarted = new HerdrSequenceLease(store, () => 100, () => {}, 2);
  expect(restarted.next()).toBeGreaterThan(boundarySeq);
});

test('sequence lease reserves another window before issuing beyond the prior high-watermark', () => {
  const writes: number[] = [];
  const store = { read: () => undefined, write: (seq: number) => writes.push(seq) };
  const lease = new HerdrSequenceLease(store, () => 100, () => {}, 2);

  expect(lease.next()).toBe(103);
  expect(lease.next()).toBe(104);
  expect(lease.next()).toBe(105);
  expect(lease.next()).toBe(106);
  expect(lease.next()).toBe(107);
  expect(lease.next()).toBe(108);
  expect(writes).toEqual([104, 107, 110]);
});
