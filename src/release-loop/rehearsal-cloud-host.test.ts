import { describe, expect, test } from 'bun:test';
import { withSimClock } from '../ux-sim/fake-clock.js';
import { createFakeCloudVm } from '../ux-sim/fake-cloud-vm.js';
import { REHEARSAL_CLOUD_HOST, runRehearsalCloudHostStep, type RehearsalCloudHostPort,
  type RehearsalCloudHostRequest, type RehearsalRepairHandoffObserver } from './rehearsal-cloud-host.js';

const EPOCH = Date.parse('2026-11-10T00:00:00Z');
const CUT = new Date(EPOCH + 8 * 60 * 60_000).toISOString();
const IMAGE = 'sha256:rehearsal-image';
const COMMIT = 'a'.repeat(40);
const LOCK = 'b'.repeat(64);

function fixture(readyAfterMs = 0) {
  const fleet = createFakeCloudVm();
  fleet.createFromImage({ id: REHEARSAL_CLOUD_HOST, imageDigest: IMAGE, hourlyCost: 36, readyAfterMs });
  const port: RehearsalCloudHostPort = {
    async start(host) {
      expect(host).toBe('aws1');
      if (fleet.status(host).state === 'parked') fleet.resume(host);
    },
    async inspect(host) {
      const vm = fleet.status(host);
      return { host, state: vm.state === 'ready' ? 'ready' : vm.state === 'parked' ? 'stopped' : vm.state === 'warming' ? 'warming' : 'failed',
        imageDigest: vm.imageDigest, commit: COMMIT, lockHash: LOCK };
    },
    async openLease(host) { fleet.openLease(host); },
    async closeLease(host) { fleet.closeLease(host); },
    async stop(host) { fleet.stop(host); },
  };
  return { fleet, port };
}

const base = { expected: { imageDigest: IMAGE, commit: COMMIT, lockHash: LOCK }, cutAt: CUT, startedAt: EPOCH,
  finalStep: true, repair: 'none' as const, now: EPOCH };

function runStep<T>(request: RehearsalCloudHostRequest, port: RehearsalCloudHostPort,
  run: (host: typeof REHEARSAL_CLOUD_HOST) => Promise<{ value: T; outcome: 'ok' | 'regression' | 'unmeasured' | 'error'; receiptPersisted: boolean }>,
  alert: (message: string) => void | Promise<void> = () => {}, now: () => number = () => Date.now(),
  observer: RehearsalRepairHandoffObserver = { currentRepair: () => request.repair, markHandoffRequired() {}, recordAlertFailure() {} }) {
  return runRehearsalCloudHostStep(request, port, run, alert, now, observer);
}

describe('REHEARSAL-CLOUD-HOST lifecycle through fake-cloud-vm', () => {
  test('alerts at the 90-minute handoff deadline even when the rehearsal call already returned', async () => {
    await withSimClock(EPOCH, async (clock) => {
      const { fleet, port } = fixture();
      const alerts: string[] = [];
      let repair: RehearsalCloudHostRequest['repair'] = 'pending';
      const observer: RehearsalRepairHandoffObserver = { currentRepair: () => repair,
        markHandoffRequired() { repair = 'handed-off'; }, recordAlertFailure(warning) { alerts.push(`warning:${warning}`); } };
      const result = await runStep({ ...base, lastRehearsalAt: EPOCH, repair: 'pending', finalStep: false }, port,
        async () => ({ value: 'still-pending', outcome: 'regression', receiptPersisted: false }),
        (message) => { alerts.push(message); }, clock.now, observer);
      expect(result).toMatchObject({ outcome: 'measured', stopped: false });
      expect(alerts).toEqual([]);
      expect(fleet.status('aws1').state).toBe('ready');

      await clock.tickAndFlushMicrotasks(90 * 60_000);
      expect(alerts).toEqual(['aws1 repair window reached 90 minutes; hand off the repair and persist its receipt before stopping']);
      expect(repair).toBe('handed-off');
      expect(fleet.status('aws1').state).toBe('ready');
    });
  });

  test('counts VM start and readiness latency against the repair deadline', async () => {
    await withSimClock(EPOCH, async (clock) => {
      const { port } = fixture();
      const alerts: string[] = [];
      const slowStart: RehearsalCloudHostPort = { ...port, async start(host) {
        await port.start(host);
        clock.tick(20 * 60_000);
      } };
      await runStep({ ...base, lastRehearsalAt: EPOCH, repair: 'pending', finalStep: false }, slowStart,
        async () => ({ value: 'pending', outcome: 'regression', receiptPersisted: false }),
        (message) => { alerts.push(message); }, clock.now);
      expect(alerts).toEqual([]);
      await clock.tickAndFlushMicrotasks(70 * 60_000 - 1);
      expect(alerts).toEqual([]);
      await clock.tickAndFlushMicrotasks(1);
      expect(alerts).toEqual(['aws1 repair window reached 90 minutes; hand off the repair and persist its receipt before stopping']);
    });
  });

  test('does not report stale handoff after repair resolves and records a deadline alert transport failure', async () => {
    await withSimClock(EPOCH, async (clock) => {
      const { port } = fixture();
      let repair: RehearsalCloudHostRequest['repair'] = 'pending';
      const warnings: string[] = [];
      const observer: RehearsalRepairHandoffObserver = { currentRepair: () => repair,
        markHandoffRequired() { repair = 'handed-off'; }, recordAlertFailure(warning) { warnings.push(warning); } };
      await runStep({ ...base, lastRehearsalAt: EPOCH, repair: 'pending', finalStep: false }, port,
        async () => ({ value: 'repaired', outcome: 'ok', receiptPersisted: true }), async () => {}, clock.now, observer);
      repair = 'resolved';
      await clock.tickAndFlushMicrotasks(90 * 60_000);
      expect(repair).toBe('resolved');
      expect(warnings).toEqual([]);

      clock.setTime(EPOCH);
      repair = 'pending';
      const failedAlerts: string[] = [];
      const failingObserver: RehearsalRepairHandoffObserver = { currentRepair: () => repair,
        markHandoffRequired() { repair = 'handed-off'; }, recordAlertFailure(warning) { failedAlerts.push(warning); } };
      await runStep({ ...base, lastRehearsalAt: EPOCH, repair: 'pending', finalStep: false }, port,
        async () => ({ value: 'still pending', outcome: 'regression', receiptPersisted: false }),
        async () => { throw new Error('mail offline'); }, clock.now, failingObserver);
      await clock.tickAndFlushMicrotasks(90 * 60_000);
      expect(repair).toBe('handed-off');
      expect(failedAlerts).toEqual(['mail offline']);
    });
  });

  test('runs on aws1 only, keeps other resources unchanged, and stops only after final receipt', async () => {
    await withSimClock(EPOCH, async () => {
      const { fleet, port } = fixture();
      fleet.createFromImage({ id: 'node-b-gate', imageDigest: IMAGE, hourlyCost: 0 });
      const otherBefore = fleet.status('node-b-gate');
      fleet.stop('aws1');
      const result = await runStep(base, port, async (host) => ({ value: host, outcome: 'ok', receiptPersisted: true }));
      expect(result).toMatchObject({ outcome: 'measured', measurementOutcome: 'ok', host: 'aws1', value: 'aws1', receiptPersisted: true, stopped: true });
      expect(fleet.status('aws1').state).toBe('parked');
      expect(fleet.events().some((event) => event.type === 'resume' && event.id === 'aws1')).toBe(true);
      expect(fleet.status('node-b-gate')).toEqual(otherBefore);
      expect(fleet.events().some((event) => event.type === 'forbidden-terminate')).toBe(false);
    });
  });

  test('postpones a slow start without running or selecting a fallback host', async () => {
    await withSimClock(EPOCH, async () => {
      const { fleet, port } = fixture(60_000);
      let ran = false;
      const result = await runStep(base, port, async () => { ran = true; return { value: 1, outcome: 'ok', receiptPersisted: true }; });
      expect(result).toEqual({ outcome: 'postponed', reason: 'aws1 is still warming; no failover' });
      expect(ran).toBe(false);
      expect(fleet.events().some((event) => event.type === 'resume' && event.id !== 'aws1')).toBe(false);
    });
  });

  test('postpones a failed start and records an alert without running elsewhere', async () => {
    await withSimClock(EPOCH, async () => {
      const { port } = fixture();
      const alerts: string[] = [];
      const result = await runStep(base, { ...port, async start() { throw new Error('provider unavailable'); } },
        async () => ({ value: 1, outcome: 'ok', receiptPersisted: true }), (message) => { alerts.push(message); });
      expect(result).toEqual({ outcome: 'postponed', reason: 'aws1 start failed; no failover: provider unavailable' });
      expect(alerts[0]).toContain('postponed without failover');
    });
  });

  test('keeps aws1 powered after a regression and stops only after repaired receipt is ready', async () => {
    await withSimClock(EPOCH, async () => {
      const { fleet, port } = fixture();
      const failed = await runStep({ ...base, repair: 'pending', finalStep: false }, port,
        async () => ({ value: 'regression', outcome: 'regression', receiptPersisted: false }));
      expect(failed).toMatchObject({ outcome: 'measured', measurementOutcome: 'regression', receiptPersisted: false, stopped: false });
      expect(fleet.status('aws1').state).toBe('ready');
      const repaired = await runStep({ ...base, lastRehearsalAt: EPOCH,
        repair: 'none', finalStep: true }, port, async () => ({ value: 'receipt', outcome: 'ok', receiptPersisted: true }));
      expect(repaired).toMatchObject({ outcome: 'measured', measurementOutcome: 'ok', receiptPersisted: true, stopped: true, value: 'receipt' });
      expect(fleet.events().filter((event) => event.type === 'stop')).toHaveLength(1);
    });
  });

  test('hands off unresolved repair at 90 minutes and stops after the handoff receipt is persisted', async () => {
    await withSimClock(EPOCH, async () => {
      const { fleet, port } = fixture();
      const alerts: string[] = [];
      const lastRehearsalAt = EPOCH;
      const beforeBound = await runStep({ ...base, lastRehearsalAt, repair: 'pending', finalStep: false }, port,
        async () => ({ value: 'regression', outcome: 'regression', receiptPersisted: false }),
        (message) => { alerts.push(message); }, () => EPOCH + 90 * 60_000 - 1);
      expect(beforeBound).toMatchObject({ outcome: 'measured', measurementOutcome: 'regression', stopped: false });
      expect(alerts).toEqual([]);
      expect(fleet.status('aws1').state).toBe('ready');

      const boundReached = await runStep({ ...base, lastRehearsalAt, repair: 'pending', finalStep: false }, port,
        async () => ({ value: 'regression', outcome: 'regression', receiptPersisted: false }),
        (message) => { alerts.push(message); }, () => EPOCH + 90 * 60_000);
      expect(boundReached).toMatchObject({ outcome: 'measured', measurementOutcome: 'regression', stopped: false, repairHandoffRequired: true });
      expect(alerts).toEqual(['aws1 repair window reached 90 minutes; hand off the repair and persist its receipt before stopping']);
      expect(fleet.status('aws1').state).toBe('ready');

      const handedOff = await runStep({ ...base, lastRehearsalAt, repair: 'handed-off', finalStep: false }, port,
        async () => ({ value: 'handoff receipt', outcome: 'ok', receiptPersisted: true }),
        (message) => { alerts.push(message); }, () => EPOCH + 90 * 60_000 + 1);
      expect(handedOff).toMatchObject({ outcome: 'measured', value: 'handoff receipt', receiptPersisted: true, stopped: true });
      expect(fleet.status('aws1').state).toBe('parked');
      expect(fleet.events().filter((event) => event.type === 'stop')).toHaveLength(1);
      expect(fleet.events().some((event) => event.type === 'forbidden-terminate')).toBe(false);
    });
  });

  test('keeps the host for cutoff escalation and treats stop failure as alert-only', async () => {
    await withSimClock(EPOCH, async () => {
      const { fleet, port } = fixture();
      const alerts: string[] = [];
      const cutoff = await runStep({ ...base, cutAt: new Date(EPOCH + 20 * 60_000).toISOString(),
        repair: 'none' }, port, async () => ({ value: 1, outcome: 'regression', receiptPersisted: false }), (message) => { alerts.push(message); });
      expect(cutoff).toMatchObject({ outcome: 'measured', measurementOutcome: 'regression', stopped: false });
      expect(alerts[0]).toContain('escalate to OP');
      const stopFailed = await runStep(base, { ...port, async stop() { throw new Error('AWS1_HOLD_UNTIL'); } },
        async () => ({ value: 'green', outcome: 'ok', receiptPersisted: true }), (message) => { alerts.push(message); });
      expect(stopFailed).toMatchObject({ outcome: 'measured', measurementOutcome: 'ok', receiptPersisted: true, value: 'green', stopped: false, stopWarning: 'AWS1_HOLD_UNTIL' });
      expect(fleet.status('aws1').state).toBe('ready');
      expect(alerts.at(-1)).toContain('measurement retained');
    });
  });

  test('does not measure when observed host or prepared inputs differ', async () => {
    await withSimClock(EPOCH, async () => {
      const { port } = fixture();
      const mismatch: RehearsalCloudHostPort = { ...port, async inspect(host) {
        const identity = await port.inspect(host);
        return { ...identity, commit: 'c'.repeat(40) };
      } };
      const result = await runStep(base, mismatch, async () => ({ value: 1, outcome: 'ok', receiptPersisted: true }));
      expect(result).toMatchObject({ outcome: 'unmeasured', reason: expect.stringContaining('does not match') });
    });
  });

  test('does not stop without this run receipt and preserves the gate result when lease cleanup fails', async () => {
    await withSimClock(EPOCH, async () => {
      const { fleet, port } = fixture();
      const noReceipt = await runStep(base, port,
        async () => ({ value: 'green-but-unreceipted', outcome: 'ok', receiptPersisted: false }));
      expect(noReceipt).toMatchObject({ outcome: 'measured', measurementOutcome: 'ok', receiptPersisted: false, stopped: false });
      const alerts: string[] = [];
      const cutoff = await runStep({ ...base, cutAt: new Date(EPOCH + 20 * 60_000).toISOString() },
        { ...port, async closeLease() { throw new Error(''); } },
        async () => ({ value: 'regression', outcome: 'regression', receiptPersisted: false }), (message) => { alerts.push(message); });
      expect(cutoff).toMatchObject({ outcome: 'measured', measurementOutcome: 'regression', cleanupWarning: 'lease cleanup failed without diagnostic' });
      expect(alerts[0]).toContain('escalate to OP');
      const cleanupFailed = await runStep(base, { ...port, async closeLease() { throw new Error('lease ledger unavailable'); } },
        async () => ({ value: 'measured', outcome: 'ok', receiptPersisted: true }));
      expect(cleanupFailed).toMatchObject({ outcome: 'measured', measurementOutcome: 'ok', value: 'measured', stopped: false,
        cleanupWarning: 'lease ledger unavailable' });
      expect(fleet.status('aws1').state).toBe('ready');
    });
  });

  test('escalates an unresolved repair at cutoff even when this measurement is unmeasured', async () => {
    await withSimClock(EPOCH, async () => {
      const { port } = fixture();
      const alerts: string[] = [];
      const result = await runStep({ ...base, cutAt: new Date(EPOCH + 20 * 60_000).toISOString(),
        repair: 'pending' }, port, async () => ({ value: 'no measurement', outcome: 'unmeasured', receiptPersisted: false }),
      (message) => { alerts.push(message); });
      expect(result).toMatchObject({ outcome: 'measured', measurementOutcome: 'unmeasured', stopped: false });
      expect(alerts).toEqual(['rehearsal repair remains within 30 minutes of cut (unmeasured); preserve aws1 and escalate to OP']);
    });
  });

  test('uses completion time for cutoff escalation when a run crosses the 30-minute boundary', async () => {
    await withSimClock(EPOCH, async (clock) => {
      const { fleet, port } = fixture();
      const alerts: string[] = [];
      const result = await runStep({ ...base, cutAt: new Date(EPOCH + 60 * 60_000).toISOString() }, port,
        async () => { clock.tick(40 * 60_000); return { value: 'regression', outcome: 'regression', receiptPersisted: false }; },
        (message) => { alerts.push(message); });
      expect(result).toMatchObject({ outcome: 'measured', measurementOutcome: 'regression', stopped: false });
      expect(alerts).toEqual(['rehearsal regression remains within 30 minutes of cut; preserve aws1 and escalate to OP']);
      expect(fleet.status('aws1').state).toBe('ready');
    });
  });

  test('returns alert transport failure separately without replacing a completed measurement', async () => {
    await withSimClock(EPOCH, async () => {
      const { port } = fixture();
      const result = await runStep(base, { ...port, async stop() { throw new Error('stop refused'); } },
        async () => ({ value: 'green', outcome: 'ok', receiptPersisted: true }), async () => { throw new Error('mail unavailable'); });
      expect(result).toMatchObject({ outcome: 'measured', value: 'green', measurementOutcome: 'ok', stopped: false,
        stopWarning: 'stop refused', alertWarnings: ['mail unavailable'] });
    });
  });

  test('retains a visible failure marker when alert transport throws an empty error', async () => {
    await withSimClock(EPOCH, async () => {
      const { port } = fixture();
      const result = await runStep(base, { ...port, async stop() { throw new Error('stop refused'); } },
        async () => ({ value: 'green', outcome: 'ok', receiptPersisted: true }), async () => { throw new Error(''); });
      expect(result).toMatchObject({ outcome: 'measured', measurementOutcome: 'ok', alertWarnings: ['notification failed without diagnostic'] });
    });
  });

  test('preserves a measured result and lease cleanup when the completion clock fails', async () => {
    await withSimClock(EPOCH, async () => {
      const { fleet, port } = fixture();
      const alerts: string[] = [];
      const result = await runStep({ ...base, cutAt: new Date(EPOCH + 20 * 60_000).toISOString() }, port,
        async () => ({ value: 'regression', outcome: 'regression', receiptPersisted: false }),
        (message) => { alerts.push(message); }, () => { throw new Error('clock unavailable'); });
      expect(result).toMatchObject({ outcome: 'measured', measurementOutcome: 'regression', receiptPersisted: false,
        stopped: false, clockWarning: 'clock unavailable' });
      expect(alerts).toEqual(['completion clock unavailable; preserve aws1 and escalate to OP: clock unavailable']);
      expect(fleet.status('aws1')).toMatchObject({ activeLeases: 0, state: 'ready' });
    });
  });
});
