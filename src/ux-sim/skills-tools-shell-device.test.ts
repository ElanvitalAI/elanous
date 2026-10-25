// DEVICE-FIRST-STAGE — 장치 재고 (측정 기록)
//
// 기존 장치 조사 결과 (src/ux-sim + src/skills/tools, 2026-10-22 Read 실측):
//   • src/ux-sim/headless-tui.ts — stdout 경계 ANSI(xterm headless) 해석·캡처 장치.
//     RunShell «거부 원문» 캡처에는 재사용 가능하다(화면 원문을 그대로 뽑는다).
//     이 시험의 단언은 in-process 결과 객체 원문이므로 여기선 직접 쓰지 않는다.
//   • src/ux-sim/mock-seat-pty-frame.ts — 격리 HOME/상태 디렉터리(.elanous-test)에서
//     실제 PTY 자식을 띄워 firstFrame/afterKeyFrame을 캡처하는 mock 무대 장치.
//     실물 TUI 무대가 필요한 뒷 조각에서 재사용한다. 이 시험의 무대는
//     자식을 spawn 하지 않는 in-process mock(경계: «spawn 전 거부»를 단언하므로
//     spawn 카운트 0이 핵심 관측치다).
//   • src/skills/tools/shell.ts — RunShell 정책 생산 코드. cd 거부·ops-ledger CLI
//     스티어·long-sleep 경고까지 있으나 «HQ 자리 무거운 명령 실행 전 거부» 정책은
//     아직 없다(완료 경계 코드는 부모 조각 TUI-HQ-LOCAL-HEAVY-GUARD 산물).
//     이 조각은 운영 코드 변경 0 — shell.ts·shell.test.ts 무수정.
//
// 장치 재고 측정 절차 (미결 항목 — 사용자 확인 요청):
//   골 원문에 «장치 재고 측정에 쓸 대상 저장소 루트» 경로가 없어 임의로 정하지 않았다.
//   실물 측정이 필요하면 아래를 확정해야 한다:
//     1. 대상 저장소 루트 경로(본 worktree 경로 또는 운영 트리 경로)를 사용자가 지정.
//     2. 그 루트에서 `test -f src/ux-sim/headless-tui.ts && test -f src/ux-sim/mock-seat-pty-frame.ts`
//        로 두 기존 장치의 실재를 재확인하고 sha256을 기록한다.
//   ⇒ 확인 요청: «장치 재고 측정의 기준 루트를 어디로 정할까요? (지정 없으면 이 worktree를 기준으로 기록한다)»
//
// 배선 경계 (의도적 결정):
//   신규 장치 src/ux-sim/skills-tools-shell-device.ts는 «시험 무대 전용»이며 생산
//   실행 경로에 연결하지 않는다 — 이 시험 파일 안에서만 import된다. 이유: 이 조각의
//   완료 경계는 운영 코드 변경 0이며, HQ 무거운 명령 가드의 생산 배선은 부모 조각
//   (TUI-HQ-LOCAL-HEAVY-GUARD)이 shell.ts 에서 수행한다. 따라서 MS-05 생산
//   orchestrationId 호출 배선은 이 조각에서 만들지 않는다.
import { describe, expect, test } from 'bun:test';
// RED 증거 형태 계약(verify-by-breaking): 장치 모듈은 시험 몸통 안에서 동적으로 적재한다.
// 정적 import 는 «장치가 없는 기준선(base)»에서 모듈 적재 오류로 시험 파일 전체가 죽고,
// 그 출력은 게이트가 infrastructure-unknown 으로 분류해 red 증거가 되지 못한다(라운드 0 실측).
// 동적 적재는 base 에서도 시험이 «실행»되게 해 «(fail)» 원문을 남긴다.
type DeviceModule = typeof import('./skills-tools-shell-device.js');

async function loadDeviceModule(): Promise<DeviceModule> {
  let mod: DeviceModule | undefined;
  try {
    mod = await import('./skills-tools-shell-device.js');
  } catch {
    mod = undefined;
  }
  expect(mod, 'RED: 장치 구현이 없는 상태라면 이 시험은 실패해야 한다(DEVICE-FIRST-STAGE RED 원문)').toBeDefined();
  return mod!;
}

describe('DEVICE-FIRST-STAGE: RunShell HQ 자리 무거운 명령 가드 mock 무대', () => {
  test('HQ 자리에서 eln self gate --local 을 실제 자식 spawn 전에 거부하고 원격 대안을 결과에 담는다', async () => {
    const { createSkillsToolsShellDevice, REMOTE_ALTERNATIVE_TEMPLATE } = await loadDeviceModule();
    const device = createSkillsToolsShellDevice({ seat: 'hq' });
    const result = device.run(['bun', 'bin/elanous.mjs', 'self', 'gate', '--local']);
    expect(result.rejected).toBe(true);
    expect(result.rejection).toBeDefined();
    expect(result.rejection!.reason).toContain('spawn 전에 거부');
    expect(result.rejection!.remoteAlternative).toContain('self gate');
    // 실행 전 거부 — 어떤 자식도 spawn 되지 않았다.
    expect(device.spawnCount()).toBe(0);
    expect(result.spawnCount).toBe(0);
    expect(result.output).toContain('rejected');
    expect(result.output).toContain(REMOTE_ALTERNATIVE_TEMPLATE);
    // 격리 무대의 debug.log 거부 이벤트가 남는다.
    const events = device.logEvents();
    const rejectEvent = events.find((e) => e.event === 'hq-heavy.rejected');
    expect(rejectEvent).toBeDefined();
    expect(rejectEvent!.category).toBe('shell.dispatch');
    expect(rejectEvent!.data.command).toEqual(['bun', 'bin/elanous.mjs', 'self', 'gate', '--local']);
    expect(rejectEvent!.data.reason).toBe(result.rejection!.reason);
    expect(rejectEvent!.data.remoteAlternative).toBe(result.rejection!.remoteAlternative);
  });

  test('설치본 eln wrapper 로도 같은 무거운 명령을 거부한다', async () => {
    const { createSkillsToolsShellDevice } = await loadDeviceModule();
    const device = createSkillsToolsShellDevice({ seat: 'hq' });
    const result = device.run(['eln', 'self', 'gate', '--local']);
    expect(result.rejected).toBe(true);
    expect(device.spawnCount()).toBe(0);
  });

  test('가벼운 명령은 HQ 자리에서도 그대로 실행된다', async () => {
    const { createSkillsToolsShellDevice } = await loadDeviceModule();
    const device = createSkillsToolsShellDevice({ seat: 'hq' });
    const result = device.run(['echo', 'hi']);
    expect(result.rejected).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(device.spawnCount()).toBe(1);
    expect(result.output).toContain('hi');
  });

  test('원격 자리는 무거운 명령을 거부하지 않는다', async () => {
    const { createSkillsToolsShellDevice } = await loadDeviceModule();
    const device = createSkillsToolsShellDevice({ seat: 'remote' });
    const result = device.run(['elanous', 'self', 'gate', '--local']);
    expect(result.rejected).toBe(false);
    expect(device.spawnCount()).toBe(1);
  });

  test('HQ 무거운 명령 목록은 self gate --local 을 포함한다', async () => {
    const { HQ_HEAVY_COMMANDS } = await loadDeviceModule();
    const joined = HQ_HEAVY_COMMANDS.map((argv) => argv.join(' '));
    expect(joined).toContain('self gate --local');
  });
});