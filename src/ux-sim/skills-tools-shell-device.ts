// ── skills-tools-shell-device — RunShell HQ 무거운 명령 가드 mock 무대 ──
//
// DEVICE-FIRST-STAGE 산출 장치. 부모 조각(TUI-HQ-LOCAL-HEAVY-GUARD)이
// src/skills/tools/shell.ts 의 RunShell 정책에 넣을 «HQ 자리에서 무거운
// 명령을 실제 자식 spawn 전에 거부하고 원격 대안을 제시» 동작을, 생산
// 코드 무수정(운영 코드 변경 0)으로 시험하는 in-process mock 무대.
//
// 장치 재고(2026-10-22 실측):
//   • src/ux-sim/headless-tui.ts — ANSI 해석·캡처. 거부 «원문»이 화면에서
//     나올 때 재사용(본 시험은 결과 객체 원문이라 직접 쓰지 않음).
//   • src/ux-sim/mock-seat-pty-frame.ts — 격리 PTY mock 무대. 실물 TUI
//     무대 뒷 조각에서 재사용.
//   • 이 장치는 위 두 장치가 못 주는 «spawn 카운트 0 ⊕ 원격 대안 ⊕
//     격리 debug.log 거부 이벤트» 관측을 채운다.
//
// 배선 경계(의도적): 시험 무대 전용 — 생산 실행 경로에 연결하지 않는다.
// 시험 파일(src/ux-sim/skills-tools-shell-device.test.ts)만 import한다.

/** HQ 자리에서 실행 전 거부하는 무거운 명령 argv 패턴(하위 명령 토큰열). */
export const HQ_HEAVY_COMMANDS: readonly (readonly string[])[] = [
  ['self', 'gate', '--local'],
];

/** 거부 결과에 담기는 원격 대안 안내 템플릿. */
export const REMOTE_ALTERNATIVE_TEMPLATE =
  'run the gate from the ops harness host instead: elanous self gate (remote, not the HQ seat)';

export const HQ_REJECTION_REASON =
  'HQ 자리의 무거운 명령(self gate --local)은 실제 자식 spawn 전에 거부했다';

/** elanous CLI 바이너리로 보이는 토큰(설치본 eln · elanous · bin/elanous.mjs). */
const CLI_BIN = /(?:^|[/\\])(?:elanous|elanous\.mjs|elanous\.cjs|eln)$/;

/** argv 앞의 실행 래퍼(bun/node/env …)를 벗겨 [cliBin, ...args]를 돌려준다. */
function unwrapCliArgv(command: readonly string[]): { args: readonly string[] } | null {
  let i = 0;
  if (/(?:^|[/\\])env$/.test(command[0] ?? '')) {
    i = 1;
    while (i < command.length) {
      const arg = command[i]!;
      if (arg === '--') { i += 1; break; }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) { i += 1; continue; }
      break;
    }
  }
  if (command[i] === 'bun' || command[i] === 'bunx' || command[i] === 'node' || command[i] === 'npx') {
    i += 1;
    if (command[i] === '--bun') i += 1;
  }
  if (!CLI_BIN.test(command[i] ?? '')) return null;
  return { args: command.slice(i + 1) };
}

/** 무거운 명령이면 그 args(전 CLI argv)를, 아니면 null. */
export function matchHqHeavyCommand(
  command: readonly string[],
): readonly string[] | null {
  const cli = unwrapCliArgv(command);
  if (!cli) return null;
  for (const pattern of HQ_HEAVY_COMMANDS) {
    if (cli.args.length < pattern.length) continue;
    if (pattern.every((token, k) => cli.args[k] === token)) return cli.args;
  }
  return null;
}

export interface DeviceSpawnResult {
  output: string;
  exitCode: number | null;
}

export interface DeviceLogEvent {
  category: string;
  event: string;
  data: Record<string, unknown>;
}

export interface SkillsToolsShellRunResult {
  seat: string;
  command: readonly string[];
  rejected: boolean;
  rejection?: { reason: string; remoteAlternative: string };
  output: string;
  exitCode: number | null;
  spawnCount: number;
}

export interface SkillsToolsShellDevice {
  readonly seat: string;
  run(command: readonly string[]): SkillsToolsShellRunResult;
  spawnCount(): number;
  logEvents(): readonly DeviceLogEvent[];
}

export interface SkillsToolsShellDeviceSpec {
  /** 무대 자리. 'hq'(기본)면 무거운 명령 가드가 켜진다. */
  seat?: string;
  /** 자식 실행 mock. 기본: 성공(exit 0)하는 세이프 가짜. */
  spawn?: (command: readonly string[]) => DeviceSpawnResult;
}

export function createSkillsToolsShellDevice(spec: SkillsToolsShellDeviceSpec = {}): SkillsToolsShellDevice {
  const seat = spec.seat ?? 'hq';
  const spawn = spec.spawn ?? ((command: readonly string[]): DeviceSpawnResult => ({
    output: `spawned: ${command.join(' ')}`,
    exitCode: 0,
  }));
  let spawnCount = 0;
  const logEvents: DeviceLogEvent[] = [];
  const isHq = seat === 'hq';

  return {
    seat,
    spawnCount: () => spawnCount,
    logEvents: () => [...logEvents],
    run(command: readonly string[]): SkillsToolsShellRunResult {
      const heavy = isHq ? matchHqHeavyCommand(command) : null;
      if (heavy) {
        const rejection = {
          reason: HQ_REJECTION_REASON,
          remoteAlternative: REMOTE_ALTERNATIVE_TEMPLATE,
        };
        logEvents.push({
          category: 'shell.dispatch',
          event: 'hq-heavy.rejected',
          data: { command: [...command], reason: rejection.reason, remoteAlternative: rejection.remoteAlternative },
        });
        return {
          seat,
          command: [...command],
          rejected: true,
          rejection,
          output: `RunShell rejected \`${heavy.join(' ')}\` on seat ${seat}: ${rejection.reason}. ${rejection.remoteAlternative}`,
          exitCode: null,
          spawnCount,
        };
      }
      const spawned = spawn(command);
      spawnCount += 1;
      const runCommand = [...command];
      logEvents.push({
        category: 'shell.dispatch',
        event: 'exec',
        data: { command: runCommand, seat },
      });
      return {
        seat,
        command: runCommand,
        rejected: false,
        output: spawned.output,
        exitCode: spawned.exitCode,
        spawnCount,
      };
    },
  };
}