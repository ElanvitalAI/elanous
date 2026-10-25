import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { dispatchPtyShellTool } from './pty-shell.js';
import { TUI_SELF_NEST_REJECT_MARKER, decideTuiSelfNest } from '../../agent/terminal-surface.js';
import { runPtyShellStartStage } from '../../ux-sim/boot-daemon-tools-pty-shell-device.js';

// Production entry point coverage for TUI-NO-SELF-NEST (#27):
// dispatchPtyShellTool('PtyShellStart') is the function the daemon tool
// surface calls; the stage below injects a TUI PTY context (L2) and lets the
// real dispatcher answer.

const ENV_KEYS = ['ELANOUS_PARENT_PTY_ID', 'ELANOUS_NEST_DEPTH', 'ELANOUS_PTY_ID'] as const;
type SavedEnv = Record<string, string | undefined>;

function saveEnv(): SavedEnv {
  const saved: SavedEnv = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved: SavedEnv): void {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

let saved: SavedEnv;
beforeEach(() => {
  saved = saveEnv();
  for (const key of ENV_KEYS) delete process.env[key];
});
afterEach(() => { restoreEnv(saved); });

describe('PtyShellStart — TUI 자기중첩 거부 (생산 호출 경로)', () => {
  test('TUI 안 eln 기동은 spawn 없이 거부 ⊕ 안내를 돌려준다', async () => {
    process.env.ELANOUS_PARENT_PTY_ID = 'pty-prod-1';
    const result = await dispatchPtyShellTool('PtyShellStart', { cmd: 'eln', args: [] });
    const shaped = result as { output?: string; process_id?: string };
    expect(shaped.process_id).toBeUndefined();
    expect(shaped.output?.startsWith(TUI_SELF_NEST_REJECT_MARKER)).toBe(true);
    expect(shaped.output).toContain('pty-prod-1');
  }, 60_000);

  test('ux-sim 무대: 고정 입력으로 같은 거부를 재현한다 (command·rc·output 꼬리)', async () => {
    const result = await runPtyShellStartStage({
      argv: ['elanous', 'tui'],
      parentPtyId: 'pty-prod-2',
      nestDepth: 1,
    });
    expect(result.rejected).toBe(true);
    expect(result.rc).toBe(0);
    expect(result.spawnedPid).toBeNull();
    expect(result.outputTail).not.toBe('');
    expect(result.output).toContain('elanous tui');
  }, 60_000);

  test('TUI 맥락이 없으면 거부 분기를 타지 않는다 (보존)', () => {
    expect(decideTuiSelfNest(['eln', 'chat'], {} as NodeJS.ProcessEnv).reject).toBe(false);
  });

  test('TUI 안이라도 eln --version 모양은 거부 분기에 걸리지 않는다', () => {
    const ctx = { ELANOUS_PARENT_PTY_ID: 'pty-prod-4', ELANOUS_NEST_DEPTH: '1' } as NodeJS.ProcessEnv;
    for (const argv of [['eln', '--version'], ['eln', '--help'], ['eln', '-h'], ['elanous', 'chat', '--help']]) {
      const decision = decideTuiSelfNest(argv, ctx);
      expect(decision.reject).toBe(false);
      expect(decision.output).toBeNull();
    }
  });
});
