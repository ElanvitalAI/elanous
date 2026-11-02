import { describe, expect, test } from 'bun:test';
import { withSimClock } from './fake-clock.js';
import { createFakeCloudVm } from './fake-cloud-vm.js';

const EPOCH = Date.parse('2026-11-02T00:00:00Z');

describe('fake-cloud-vm control-plane simulation', () => {
  test('image creation and resume move parked VMs through warming to ready', async () => {
    await withSimClock(EPOCH, (clock) => {
      const fleet = createFakeCloudVm();
      const created = fleet.createFromImage({ id: 'aws2', imageDigest: 'sha256:image-a', hourlyCost: 2, readyAfterMs: 500, stopAfterAt: EPOCH + 10_000 });
      expect(created.state).toBe('warming');
      clock.tick(500);
      expect(fleet.status('aws2').state).toBe('ready');
      expect(fleet.stop('aws2').state).toBe('parked');

      expect(fleet.resume('aws2', { readyAfterMs: 200 }).state).toBe('warming');
      expect(fleet.status('aws2').stopAfterAt).toBeUndefined();
      clock.tick(200);
      expect(fleet.status('aws2').state).toBe('ready');
      expect(fleet.events().filter((event) => event.type === 'create-from-image')).toHaveLength(1);
      expect(fleet.events().filter((event) => event.type === 'resume')).toHaveLength(1);
    });
  });

  test('stopAfter refuses new leases, drains existing work, then stops without termination', async () => {
    await withSimClock(EPOCH, (clock) => {
      const fleet = createFakeCloudVm();
      fleet.createFromImage({ id: 'aws2', imageDigest: 'sha256:image-a', hourlyCost: 1, stopAfterAt: EPOCH + 1_000 });
      fleet.openLease('aws2');
      clock.tick(1_000);

      const draining = fleet.status('aws2');
      expect(draining.state).toBe('draining');
      expect(draining.activeLeases).toBe(1);
      expect(() => fleet.openLease('aws2')).toThrow('new lease refused');

      const parked = fleet.closeLease('aws2');
      expect(parked.state).toBe('parked');
      expect(parked.activeLeases).toBe(0);
      expect(fleet.events().some((event) => event.type === 'forbidden-terminate')).toBe(false);
      expect(fleet.events().filter((event) => event.type === 'stop')).toHaveLength(1);
    });
  });

  test('a late first status poll accounts cost and stop at the scheduled deadline', async () => {
    await withSimClock(EPOCH, (clock) => {
      const fleet = createFakeCloudVm();
      fleet.createFromImage({ id: 'aws2', imageDigest: 'sha256:image-a', hourlyCost: 36, stopAfterAt: EPOCH + 1_000 });
      clock.tick(60 * 60_000);

      expect(fleet.status('aws2')).toMatchObject({ state: 'parked', poweredOnMs: 1_000, estimatedCost: 0.01 });
      expect(fleet.events().find((event) => event.type === 'stop')).toMatchObject({ at: EPOCH + 1_000 });
    });
  });

  test('a deadline before readiness wins even when the first poll is late', async () => {
    await withSimClock(EPOCH, (clock) => {
      const fleet = createFakeCloudVm();
      fleet.createFromImage({ id: 'aws2', imageDigest: 'sha256:image-a', hourlyCost: 36, readyAfterMs: 2_000, stopAfterAt: EPOCH + 1_000 });
      clock.tick(3_000);

      expect(fleet.status('aws2')).toMatchObject({ state: 'parked', poweredOnMs: 1_000, estimatedCost: 0.01 });
      expect(fleet.events().map((event) => event.type)).toEqual(['create-from-image', 'stop-after-draining', 'stop']);
      expect(fleet.events().some((event) => event.type === 'ready')).toBe(false);
    });
  });

  test('a delayed poll preserves chronological readiness before stopAfter', async () => {
    await withSimClock(EPOCH, (clock) => {
      const fleet = createFakeCloudVm();
      fleet.createFromImage({ id: 'aws2', imageDigest: 'sha256:image-a', hourlyCost: 36, readyAfterMs: 500, stopAfterAt: EPOCH + 1_000 });
      clock.tick(3_000);

      expect(fleet.status('aws2').state).toBe('parked');
      expect(fleet.events().map((event) => event.type)).toEqual(['create-from-image', 'ready', 'stop-after-draining', 'stop']);
      expect(fleet.events().filter((event) => event.type !== 'create-from-image').map((event) => event.at)).toEqual([EPOCH + 500, EPOCH + 1_000, EPOCH + 1_000]);
    });
  });

  test('an expired deadline stops at power-on, never before it', async () => {
    await withSimClock(EPOCH, () => {
      const fleet = createFakeCloudVm();
      const created = fleet.createFromImage({ id: 'created', imageDigest: 'sha256:a', hourlyCost: 36, stopAfterAt: EPOCH - 1_000 });
      expect(created).toMatchObject({ state: 'parked', poweredOnMs: 0, estimatedCost: 0 });

      fleet.createFromImage({ id: 'resumed', imageDigest: 'sha256:b', hourlyCost: 36 });
      fleet.stop('resumed');
      const resumed = fleet.resume('resumed', { stopAfterAt: EPOCH - 2_000 });
      expect(resumed).toMatchObject({ state: 'parked', poweredOnMs: 0, estimatedCost: 0 });

      const deadlineEvents = fleet.events().filter((event) => event.type === 'stop-after-draining' || event.type === 'stop');
      expect(deadlineEvents.map((event) => event.at)).toEqual([EPOCH, EPOCH, EPOCH, EPOCH, EPOCH]);
    });
  });

  test('powered-on duration and cost accumulate across stop/resume, excluding parked time', async () => {
    await withSimClock(EPOCH, (clock) => {
      const fleet = createFakeCloudVm();
      fleet.createFromImage({ id: 'aws2', imageDigest: 'sha256:image-a', hourlyCost: 3 });
      clock.tick(10 * 60_000);
      expect(fleet.stop('aws2')).toMatchObject({ poweredOnMs: 10 * 60_000, estimatedCost: 0.5, state: 'parked' });

      clock.tick(60 * 60_000);
      fleet.resume('aws2');
      clock.tick(10 * 60_000);
      expect(fleet.status('aws2')).toMatchObject({ poweredOnMs: 20 * 60_000, estimatedCost: 1, state: 'ready' });
      expect(fleet.stop('aws2')).toMatchObject({ poweredOnMs: 20 * 60_000, estimatedCost: 1 });
    });
  });

  test('terminate is always recorded as forbidden, including when protection is disabled', async () => {
    await withSimClock(EPOCH, () => {
      const fleet = createFakeCloudVm();
      fleet.createFromImage({ id: 'protected', imageDigest: 'sha256:a', hourlyCost: 0 });
      fleet.createFromImage({ id: 'unprotected', imageDigest: 'sha256:b', hourlyCost: 0, terminationProtected: false });

      expect(() => fleet.terminate('protected')).toThrow('terminate is forbidden');
      expect(() => fleet.terminate('unprotected')).toThrow('terminate is forbidden');
      expect(() => fleet.terminate('unknown')).toThrow('terminate is forbidden');
      expect(fleet.events().filter((event) => event.type === 'forbidden-terminate').map((event) => [event.known, event.protected]))
        .toEqual([[true, true], [true, false], [false, false]]);
    });
  });

  test('invalid inputs, duplicate creation, and unknown VM ids fail closed', async () => {
    await withSimClock(EPOCH, () => {
      const fleet = createFakeCloudVm();
      expect(() => fleet.createFromImage({ id: 'bad', imageDigest: 'sha256:a', hourlyCost: -1 })).toThrow('hourlyCost');
      expect(() => fleet.createFromImage({ id: 'bad', imageDigest: '', hourlyCost: 1 })).toThrow('imageDigest');
      fleet.createFromImage({ id: 'aws2', imageDigest: 'sha256:a', hourlyCost: 1 });
      expect(() => fleet.createFromImage({ id: 'aws2', imageDigest: 'sha256:b', hourlyCost: 1 })).toThrow('already exists');
      expect(() => fleet.status('missing')).toThrow('unknown VM');
      expect(fleet.statusAll().map((vm) => vm.id)).toEqual(['aws2']);
    });
  });
});
