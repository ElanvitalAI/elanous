import { describe, expect, test } from 'bun:test';

import {
  inspectPtyShellStartStage,
  runPtyShellStartStage,
} from './boot-daemon-tools-pty-shell-device.js';
import { TUI_SELF_NEST_REJECT_MARKER } from '../agent/terminal-surface.js';

// Stage: ux-sim fixed-input (L2 env injection) driving the production
// PtyShellStart dispatcher in src/boot/daemon-tools/pty-shell.ts.

const TUI_CTX = { parentPtyId: 'pty-tui-0231', nestDepth: 1 } as const;

describe('TUI-NO-SELF-NEST #27 — production PtyShellStart stage', () => {
  test('TUI 안에서 eln 기동은 거부되고 안내가 출력된다', async () => {
    const result = await runPtyShellStartStage({ argv: ['eln'], ...TUI_CTX });
    expect(result.rejected).toBe(true);
    expect(result.rc).toBe(0);
    expect(result.spawnedPid).toBeNull();
    expect(result.output.startsWith(TUI_SELF_NEST_REJECT_MARKER)).toBe(true);
    expect(result.output).toContain('pty-tui-0231');
    expect(result.output).toContain('elanous pty list');
    expect(result.output).toContain('PtyShellStart { cmd: "bash" }');
  }, 60_000);

  test('TUI 안에서 elanous chat 기동은 거부된다 (안내 꼬리 보존)', async () => {
    const result = await runPtyShellStartStage({ argv: ['/usr/local/bin/elanous', 'chat'], ...TUI_CTX });
    expect(result.rejected).toBe(true);
    expect(result.output).toContain('elanous chat');
    expect(result.outputTail.split('\n').length).toBeLessThanOrEqual(3);
  }, 60_000);

  test('nest depth 만으로도 TUI 안 판정이 된다', async () => {
    const result = await runPtyShellStartStage({ argv: ['eln', 'dashboard'], parentPtyId: null, nestDepth: 2 });
    expect(result.rejected).toBe(true);
    expect(result.output).toContain('nest depth 2');
  }, 60_000);

  test('bun bin/elanous.mjs 기동 형식도 같은 경로에서 거부된다', async () => {
    const result = await runPtyShellStartStage({ argv: ['bun', 'bin/elanous.mjs'], ...TUI_CTX });
    expect(result.rejected).toBe(true);
  }, 60_000);

  test('TUI 밖에서는 같은 명령을 거부하지 않는다 (allow 확인)', () => {
    const outside = inspectPtyShellStartStage({ argv: ['eln', 'chat'], parentPtyId: null, nestDepth: 0 });
    expect(outside.reject).toBe(false);
    expect(outside.command).toBe('elanous-tui-launch');
  });

  test('TUI 안이라도 TUI 기동이 아닌 명령은 그대로 통과한다', () => {
    const rows = [
      ['eln', 'pty', 'list'],
      ['eln', 'msg', 'post', '--from', 'OP', '--to', 'MK'],
      ['bash', '-lc', 'eln pty list'],
      ['elanous', 'logs', '--all'],
    ];
    for (const argv of rows) {
      const decision = inspectPtyShellStartStage({ argv, ...TUI_CTX });
      expect(decision.reject).toBe(false);
      expect(decision.command).toBe('other');
    }
  });

  test('TUI 안이라도 버전·도움말 정보성 호출은 거부되지 않는다 (거짓 양성 금지)', () => {
    const rows = [
      ['eln', '--version'],
      ['elanous', '--version'],
      ['eln', '--help'],
      ['eln', '-h'],
      ['elanous', 'chat', '--help'],
      ['node', '/opt/elanous/elanous.cjs', '--version'],
    ];
    for (const argv of rows) {
      const decision = inspectPtyShellStartStage({ argv, ...TUI_CTX });
      expect(decision.reject).toBe(false);
      expect(decision.command).toBe('other');
      expect(decision.output).toBeNull();
    }
  });
});
