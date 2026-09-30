// 계측 시험(`connectedDebugAndroidTest`)을 «어느 기기»에서 돌리나.
// ⛔ Gradle 은 시험이 끝나면 앱을 «지운다»(데이터까지). 실기기에서 돌면 대표 폰의 앱이 사라진다
//    (2026-09-30 실측: pr land 의 android-gate 가 USB 로 꽂힌 폴드 8 에서 돌아 설치본이 지워졌다).
// ⇒ 에뮬레이터(`emulator-*`)만 고른다. 실기기를 쓰려면 serial 을 «명시»해야 한다.

export type TestDevicePick =
  | { kind: 'use'; serial: string }
  | { kind: 'skip'; reason: string };

/** `adb devices` 출력에서 «device» 상태인 serial 들. */
export function attachedSerials(adbDevicesOutput: string): string[] {
  return adbDevicesOutput
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 2 && cols[1] === 'device')
    .map((cols) => cols[0]!);
}

export function pickInstrumentedTestDevice(adbDevicesOutput: string, explicitSerial?: string): TestDevicePick {
  const serials = attachedSerials(adbDevicesOutput);
  if (explicitSerial) {
    return serials.includes(explicitSerial)
      ? { kind: 'use', serial: explicitSerial }
      : { kind: 'skip', reason: `지정한 기기 ${explicitSerial} 가 연결돼 있지 않다` };
  }
  const emulator = serials.find((s) => s.startsWith('emulator-'));
  if (emulator) return { kind: 'use', serial: emulator };
  return serials.length > 0
    ? { kind: 'skip', reason: `에뮬레이터가 없다 — 실기기 ${serials.length}대에서는 돌리지 않는다(시험이 앱과 데이터를 지운다) · 실기기를 쓰려면 ELANOUS_ANDROID_TEST_SERIAL=<serial>` }
    : { kind: 'skip', reason: '연결된 기기·에뮬레이터가 없다' };
}
