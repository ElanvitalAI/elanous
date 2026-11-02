import { expect, test } from 'bun:test';
import { createGateRunner } from '../../scripts/release-loop/gate-node.js';
import { createFakeSsh } from './fake-ssh.js';
import { withSimClock } from './fake-clock.js';

test('fake-ssh: GateRunner uses fixed host session snapshots and MaxStartups without opening a connection', async () => {
  const gcpFixture = { activeSessions: 19, maxStartups: 20 };
  const awsFixture = { activeSessions: 20, maxStartups: 20 };
  const device = createFakeSsh({ hosts: { gcp1: gcpFixture, aws1: awsFixture } });
  gcpFixture.activeSessions = 20;
  awsFixture.activeSessions = 0;
  const gcp = createGateRunner('/repo', 'gcp1', undefined, undefined, undefined, undefined, { ssh: device.ssh });
  const aws = createGateRunner('/repo', 'aws1', undefined, undefined, undefined, undefined, { ssh: device.ssh });

  const allowed = await gcp.command('bun', ['--version'], '/repo');
  const refused = await aws.command('bun', ['--version'], '/repo');

  expect(allowed.rc).toBe(0);
  expect(refused.rc).not.toBe(0);
  expect(refused.output).toContain('MaxStartups');
  expect(device.calls.map(call => [call.host, call.activeSessions])).toEqual([['gcp1', 19], ['aws1', 20]]);
});

test('fake-ssh: saturated banner timeout advances the existing fake clock through GateRunner', async () => {
  await withSimClock(1_000, async (clock) => {
    const device = createFakeSsh({ hosts: {
      gcp1: { activeSessions: 20, maxStartups: 24, bannerTimeoutAt: 20, bannerDelayMs: 6_000, bannerTimeoutMs: 5_000 },
    }, clock });
    const runner = createGateRunner('/repo', 'gcp1', undefined, undefined, undefined, undefined, {
      ssh: device.ssh, now: clock.now,
    });

    const first = await runner.command('bun', ['--version'], '/repo', 10_000);
    const second = await runner.command('bun', ['--version'], '/repo', 10_000);

    expect(first.rc).toBe(255);
    expect(first.output).toContain('banner exchange timeout');
    expect(second).toEqual(first);
    expect(clock.now()).toBe(11_000);
  });
});

test('fake-ssh: caller deadline wins before the banner deadline and stops fake time there', async () => {
  await withSimClock(2_000, async (clock) => {
    const device = createFakeSsh({ hosts: {
      gcp1: { activeSessions: 20, maxStartups: 24, bannerTimeoutAt: 20, bannerDelayMs: 6_000, bannerTimeoutMs: 10_000 },
    }, clock });
    const runner = createGateRunner('/repo', 'gcp1', undefined, undefined, undefined, undefined, {
      ssh: device.ssh, now: clock.now,
    });

    const result = await runner.command('bun', ['--version'], '/repo', 5_000);

    expect(result).toMatchObject({ rc: 124, timedOut: true });
    expect(result.output).toContain('banner exchange timeout');
    expect(clock.now()).toBe(7_000);
  });
});

test('fake-ssh: injected scp disconnect fails only scp and leaves host available', async () => {
  const device = createFakeSsh({ hosts: {
    gcp1: { activeSessions: 2, maxStartups: 20, scpDisconnect: true },
  } });
  const runner = createGateRunner('/repo', 'gcp1', undefined, undefined, undefined, undefined, { ssh: device.ssh });

  const copied = await runner.command('/usr/bin/scp', ['artifact.tgz', 'remote:/tmp/artifact.tgz'], '/repo', 5_000);
  const followUp = await runner.command('bun', ['--version'], '/repo');

  expect(copied.rc).toBe(255);
  expect(copied.output).toContain('Connection reset by peer');
  expect(followUp.rc).toBe(0);
});

test('fake-ssh: inherited host names fail closed through the injected seam', async () => {
  const device = createFakeSsh({ hosts: { aws1: { activeSessions: 0, maxStartups: 10 } } });
  const inheritedNames = ['toString', '__proto__'];
  const results = await Promise.all(inheritedNames.map(async (host) => {
    const runner = createGateRunner('/repo', host, undefined, undefined, undefined, undefined, { ssh: device.ssh });
    return runner.command('bun', ['--version'], '/repo');
  }));

  expect(results.every(result => result.rc === 255 && result.output.includes('unconfigured fake-ssh host'))).toBe(true);
  expect(device.calls.map(call => call.activeSessions)).toEqual([null, null]);
});

test('fake-ssh: banner-timeout fixtures reject missing delay or deadline inputs', () => {
  expect(() => createFakeSsh({ hosts: {
    gcp1: { activeSessions: 20, maxStartups: 24, bannerTimeoutAt: 20 },
  } })).toThrow('banner timeout requires delay and deadline');
});

test('fake-ssh: a banner received before its deadline succeeds after only its configured delay', async () => {
  await withSimClock(3_000, async (clock) => {
    const device = createFakeSsh({ hosts: {
      gcp1: { activeSessions: 20, maxStartups: 24, bannerTimeoutAt: 20, bannerDelayMs: 4_000, bannerTimeoutMs: 5_000 },
    }, clock });
    const runner = createGateRunner('/repo', 'gcp1', undefined, undefined, undefined, undefined, {
      ssh: device.ssh, now: clock.now,
    });

    const result = await runner.command('bun', ['--version'], '/repo', 10_000);

    expect(result.rc).toBe(0);
    expect(result.output).toContain('connected gcp1');
    expect(clock.now()).toBe(7_000);
  });
});
