/** Deterministic mobile simulation. No real mobile tool or network is used. */
import { createFakeBins, type FakeBinSpec } from './fake-bin.js';
export type MobileFailure = 'download-interrupted' | 'disk-full' | 'permission-denied'
  | 'usb-disconnected' | 'adb-offline' | 'emulator-timeout' | 'kvm-unavailable'
  | 'store-pending' | 'store-rejected' | 'push-token-expired' | 'push-delivery-failed'
  | 'overload-aborted' | 'signature-failed' | 'dart-hung';

export interface MobileCard {
  readonly surface: 'install' | 'device' | 'store' | 'push';
  readonly status: 'ready' | 'retry' | 'blocked' | 'waiting';
  readonly reason: MobileFailure | 'ok';
  readonly message: string;
  readonly next: string;
}

export interface MobileEvent { readonly at: number; readonly action: string; readonly card: MobileCard }

const failures: Record<MobileFailure, Omit<MobileCard, 'reason'>> = {
  'download-interrupted': { surface: 'install', status: 'retry', message: 'SDK 다운로드가 끊겼습니다.', next: '이어받아 다시 다운로드' },
  'disk-full': { surface: 'install', status: 'blocked', message: 'SDK 설치 공간이 부족합니다.', next: '공간 확보 후 재시도' },
  'permission-denied': { surface: 'install', status: 'blocked', message: 'SDK 설치 권한이 없습니다.', next: '설치 경로 권한 확인' },
  'usb-disconnected': { surface: 'device', status: 'retry', message: 'USB 기기 연결이 끊겼습니다.', next: '기기 재연결 또는 무선 디버깅' },
  'adb-offline': { surface: 'device', status: 'retry', message: 'ADB 기기가 오프라인입니다.', next: '기기에서 디버깅 승인 후 재확인' },
  'emulator-timeout': { surface: 'device', status: 'retry', message: '에뮬레이터 부팅 시간이 초과됐습니다.', next: '에뮬레이터 재시작 후 재확인' },
  'kvm-unavailable': { surface: 'device', status: 'blocked', message: '하드웨어 가속을 사용할 수 없습니다.', next: '가속 가능한 호스트 또는 실기기 선택' },
  'store-pending': { surface: 'store', status: 'waiting', message: '스토어 심사를 기다리는 중입니다.', next: '심사 상태 다시 확인' },
  'store-rejected': { surface: 'store', status: 'blocked', message: '스토어 심사가 반려됐습니다.', next: '반려 사유 수정 후 재제출' },
  'push-token-expired': { surface: 'push', status: 'retry', message: '푸시 토큰이 만료됐습니다.', next: '기기에서 토큰 갱신' },
  'push-delivery-failed': { surface: 'push', status: 'retry', message: '푸시 전달에 실패했습니다.', next: '전달 상태 확인 후 재시도' },
  'overload-aborted': { surface: 'install', status: 'retry', message: '호스트 부하 상한으로 모바일 명령이 중단됐습니다.', next: '부하가 내려간 뒤 다시 실행' },
  'signature-failed': { surface: 'install', status: 'blocked', message: '앱 서명에 실패했습니다.', next: '서명 자격과 프로비저닝 설정 확인' },
  'dart-hung': { surface: 'install', status: 'retry', message: 'Dart 명령이 제한 시간 안에 끝나지 않았습니다.', next: 'Dart 프로세스를 종료하고 다시 실행' },
};

export function createFakeMobileToolchain(clock: () => number = Date.now) {
  const events: MobileEvent[] = [];
  const current = new Map<MobileCard['surface'], MobileCard>();
  function record(action: string, card: MobileCard): MobileCard {
    current.set(card.surface, card);
    events.push({ at: clock(), action, card });
    return card;
  }
  return {
    fail(reason: MobileFailure): MobileCard { return record(reason, { reason, ...failures[reason] }); },
    recover(surface: MobileCard['surface']): MobileCard {
      const previous = current.get(surface);
      if (!previous) throw new Error(`mobile-sim: no ${surface} event to recover`);
      return record('recover', { surface, status: 'ready', reason: 'ok', message: `${surface} 준비 완료`, next: '계속' });
    },
    status(surface: MobileCard['surface']): MobileCard | undefined { return current.get(surface); },
    events(): readonly MobileEvent[] { return [...events]; },
  };
}

/** PATH shims for CLI consumers. An incident can replace any tool's declared response. */
export function createFakeMobileBins(overrides: Readonly<Record<string, FakeBinSpec>> = {}) {
  return createFakeBins({
    flutter: { responses: [
      { argsStartWith: ['doctor'], stdout: '[✓] Flutter\n[✓] Android toolchain\n[✓] Connected device\n' },
      { argsStartWith: ['devices'], stdout: 'simulator-5554 • Android emulator • android-arm64\n' },
      { argsStartWith: ['build', 'apk'], stdout: 'Built build/app/outputs/flutter-apk/app-debug.apk\n' },
    ] },
    dart: { responses: [{ argsStartWith: ['--version'], stdout: 'Dart SDK version: simulated\n' }] },
    adb: { responses: [
      { argsStartWith: ['devices'], stdout: 'List of devices attached\nsimulator-5554\tdevice\n' },
      { argsStartWith: ['install'], stdout: 'Success\n' },
    ] },
    xcodebuild: { responses: [{ argsStartWith: ['-version'], stdout: 'Xcode simulated\n' }] },
    devicectl: { responses: [{ argsStartWith: ['list', 'devices'], stdout: 'Name          Hostname        Identifier\niPhone Sim    localhost       SIMULATOR-UUID\n' }] },
    ...overrides,
  });
}
