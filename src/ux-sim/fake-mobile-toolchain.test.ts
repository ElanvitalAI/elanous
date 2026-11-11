import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createFakeMobileBins, createFakeMobileToolchain, type MobileFailure } from './fake-mobile-toolchain.js';

describe('mobile simulation incidents', () => {
  const cases: readonly [MobileFailure, string, string][] = [
    ['download-interrupted', 'install', 'retry'], ['disk-full', 'install', 'blocked'],
    ['permission-denied', 'install', 'blocked'], ['usb-disconnected', 'device', 'retry'],
    ['adb-offline', 'device', 'retry'], ['emulator-timeout', 'device', 'retry'],
    ['kvm-unavailable', 'device', 'blocked'], ['store-pending', 'store', 'waiting'],
    ['store-rejected', 'store', 'blocked'], ['push-token-expired', 'push', 'retry'],
    ['push-delivery-failed', 'push', 'retry'],
    ['overload-aborted', 'install', 'retry'], ['signature-failed', 'install', 'blocked'],
    ['dart-hung', 'install', 'retry'],
  ];
  for (const [failure, surface, status] of cases) test(failure, () => {
    const sim = createFakeMobileToolchain(() => 42);
    const card = sim.fail(failure);
    expect(card).toMatchObject({ reason: failure, surface, status });
    // Source: #36066 failure-card contract requires an operator-facing explanation.
    expect(card.message.length).toBeGreaterThan(0);
    // Source: #36066 failure-card contract requires a recovery action.
    expect(card.next.length).toBeGreaterThan(0);
    expect(sim.recover(card.surface)).toMatchObject({ status: 'ready', reason: 'ok' });
    expect(sim.events()).toHaveLength(2);
    expect(sim.events()[0]?.at).toBe(42);
  });
});

test('Flutter and Android CLI calls stay inside declared PATH shims', () => {
  const bins = createFakeMobileBins();
  try {
    const doctor = spawnSync(bins.bin('flutter'), ['doctor'], { encoding: 'utf8', env: bins.env });
    const device = spawnSync(bins.bin('adb'), ['devices'], { encoding: 'utf8', env: bins.env });
    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain('Android toolchain');
    expect(device.stdout).toContain('simulator-5554');
    expect(bins.calls().map(call => [call.name, ...call.argv])).toEqual([['flutter', 'doctor'], ['adb', 'devices']]);
  } finally { bins.cleanup(); }
});

test('mobile toolchain shims preserve measured overload, signing, hang, and device results', () => {
  // Source: the fake Dart process exits after a short bound to exercise timeout handling.
  const DART_HANG_TIMEOUT_MS = 50;
  const bins = createFakeMobileBins({
    flutter: { stderr: 'mobile-toolchain: host overload guard aborted build\n', killSignal: 'KILL' },
    xcodebuild: { stderr: 'CodeSign error: signing certificate unavailable\n', exitCode: 65 },
    dart: { sleepSeconds: 1 },
  });
  try {
    const overload = spawnSync(bins.bin('flutter'), ['build', 'ipa'], { encoding: 'utf8', env: bins.env });
    const signing = spawnSync(bins.bin('xcodebuild'), ['archive'], { encoding: 'utf8', env: bins.env });
    const hung = spawnSync(bins.bin('dart'), ['analyze'], { encoding: 'utf8', env: bins.env, timeout: DART_HANG_TIMEOUT_MS });
    const adb = spawnSync(bins.bin('adb'), ['devices'], { encoding: 'utf8', env: bins.env });
    const devicectl = spawnSync(bins.bin('devicectl'), ['list', 'devices'], { encoding: 'utf8', env: bins.env });

    expect(overload.status).toBeNull();
    expect(overload.signal).toBe('SIGKILL');
    expect(overload.stderr).toContain('host overload guard aborted build');
    expect(signing.status).toBe(65);
    expect(signing.stderr).toContain('signing certificate unavailable');
    expect(hung.error?.code).toBe('ETIMEDOUT');
    expect(adb.status).toBe(0);
    expect(adb.stdout).toContain('simulator-5554');
    expect(devicectl.status).toBe(0);
    expect(devicectl.stdout).toContain('SIMULATOR-UUID');
    expect(bins.calls().map(call => call.name)).toEqual(['flutter', 'xcodebuild', 'dart', 'adb', 'devicectl']);
  } finally { bins.cleanup(); }
});
