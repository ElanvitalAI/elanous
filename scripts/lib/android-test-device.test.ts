import { describe, expect, test } from 'bun:test';
import { attachedSerials, pickInstrumentedTestDevice } from './android-test-device.js';

const header = 'List of devices attached\n';

describe('instrumented Android test device', () => {
  test('never picks a physical phone by default — Gradle uninstalls the app after the run', () => {
    const out = `${header}R5KL807651A            device usb:1249280X product:h8qksx model:SM_F971N\n`;
    const pick = pickInstrumentedTestDevice(out);
    expect(pick.kind).toBe('skip');
    if (pick.kind === 'skip') expect(pick.reason).toContain('실기기 1대');
  });

  test('picks the emulator when a phone and an emulator are both attached', () => {
    const out = `${header}R5KL807651A\tdevice\nemulator-5554\tdevice\n`;
    expect(pickInstrumentedTestDevice(out)).toEqual({ kind: 'use', serial: 'emulator-5554' });
  });

  test('an explicit serial is honoured only when attached', () => {
    const out = `${header}R5KL807651A\tdevice\n`;
    expect(pickInstrumentedTestDevice(out, 'R5KL807651A')).toEqual({ kind: 'use', serial: 'R5KL807651A' });
    expect(pickInstrumentedTestDevice(out, 'emulator-5556').kind).toBe('skip');
  });

  test('offline / unauthorized rows are not usable', () => {
    expect(attachedSerials(`${header}emulator-5554\toffline\nABC\tunauthorized\n`)).toEqual([]);
    expect(pickInstrumentedTestDevice(`${header}`).kind).toBe('skip');
  });
});
