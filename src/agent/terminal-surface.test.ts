import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  classifyTuiLaunch,
  decideTuiSelfNest,
  readTuiNestEnv,
  TUI_SELF_NEST_REJECT_MARKER,
} from './terminal-surface.js';
import { dispatchPtyShellTool } from '../boot/daemon-tools/pty-shell.js';

const ENV_KEYS = ['ELANOUS_PARENT_PTY_ID', 'ELANOUS_NEST_DEPTH', 'ELANOUS_PTY_ID'] as const;
type SavedEnv = Record<string, string | undefined>;

function saveEnv(): SavedEnv {
  const saved: SavedEnv = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  return saved;
}

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

function restoreEnv(saved: SavedEnv): void {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

let saved: SavedEnv;
beforeEach(() => { saved = saveEnv(); clearEnv(); });
afterEach(() => { restoreEnv(saved); });

describe('classifyTuiLaunch — TUI 기동 명령 판별', () => {
  test('맨몸 eln / elanous 와 TUI 하위명령을 기동으로 본다', () => {
    for (const argv of [['eln'], ['elanous'], ['/usr/local/bin/eln', 'chat'], ['eln', '--config-dir', '/tmp/x', 'dashboard']]) {
      expect(classifyTuiLaunch(argv).kind).toBe('elanous-tui-launch');
    }
  });

  test('bun/node 로 엔트리 파일을 띄우는 형식도 기동으로 본다', () => {
    expect(classifyTuiLaunch(['bun', 'bin/elanous.mjs']).kind).toBe('elanous-tui-launch');
    expect(classifyTuiLaunch(['node', '/opt/elanous/elanous.cjs', 'nexus']).kind).toBe('elanous-tui-launch');
  });

  test('다른 명령·다른 하위명령은 기동이 아니다', () => {
    for (const argv of [['bash', '-lc', 'eln chat'], ['eln', 'pty', 'list'], ['eln', 'msg', 'post'], ['bun', 'test', 'src/x.test.ts'], []]) {
      expect(classifyTuiLaunch(argv).kind).toBe('other');
    }
  });

  test('포지셔널 없는 정보성 플래그 호출은 기동이 아니다 (거짓 양성 금지)', () => {
    for (const argv of [
      ['eln', '--version'],
      ['elanous', '--version'],
      ['eln', '--help'],
      ['eln', '-h'],
      ['node', '/opt/elanous/elanous.cjs', '--version'],
      ['bun', 'bin/elanous.mjs', '--help'],
    ]) {
      expect(classifyTuiLaunch(argv).kind).toBe('other');
      expect(classifyTuiLaunch(argv).subcommand).toBeNull();
    }
  });

  test('TUI 하위명령 뒤의 정보성 플래그도 기동이 아니다', () => {
    for (const argv of [
      ['eln', 'chat', '--help'],
      ['elanous', 'chat', '--help'],
      ['eln', 'dashboard', '-h'],
      ['elanous', 'nexus', '--version'],
    ]) {
      expect(classifyTuiLaunch(argv).kind).toBe('other');
    }
    // 하위명령은 보고하되 기동으로는 보지 않는다.
    expect(classifyTuiLaunch(['eln', 'chat', '--help']).subcommand).toBe('chat');
  });

  test('정보성 플래그가 없으면 값 있는 플래그 뒤 하위명령 판정은 그대로다', () => {
    expect(classifyTuiLaunch(['eln', '--config-dir', '/tmp/x', 'dashboard']).kind).toBe('elanous-tui-launch');
    expect(classifyTuiLaunch(['eln', '--help=false', 'chat']).kind).toBe('elanous-tui-launch');
  });
});

describe('readTuiNestEnv — 부모 pty id · nest depth 재료', () => {
  test('ELANOUS_PARENT_PTY_ID 와 ELANOUS_NEST_DEPTH 를 읽는다', () => {
    const env = { ELANOUS_PARENT_PTY_ID: 'pty-parent-1', ELANOUS_NEST_DEPTH: '3' } as NodeJS.ProcessEnv;
    expect(readTuiNestEnv(env)).toEqual({ parentPtyId: 'pty-parent-1', nestDepth: 3 });
  });

  test('값이 없거나 망가진 nest depth 는 0 이다', () => {
    expect(readTuiNestEnv({} as NodeJS.ProcessEnv)).toEqual({ parentPtyId: null, nestDepth: 0 });
    expect(readTuiNestEnv({ ELANOUS_NEST_DEPTH: 'abc' } as NodeJS.ProcessEnv).nestDepth).toBe(0);
  });
});

describe('decideTuiSelfNest — TUI 안 eln/elanous 기동 거부 ⊕ 안내', () => {
  test('TUI 안에서 기동하면 거부하고 안내를 낸다', () => {
    const decision = decideTuiSelfNest(['eln', 'chat'], {
      ELANOUS_PARENT_PTY_ID: 'pty-parent-2',
      ELANOUS_NEST_DEPTH: '1',
    } as NodeJS.ProcessEnv);
    expect(decision.reject).toBe(true);
    expect(decision.reason).toBe('already-inside-tui');
    expect(decision.output?.startsWith(TUI_SELF_NEST_REJECT_MARKER)).toBe(true);
    expect(decision.output).toContain('pty-parent-2');
    expect(decision.output).toContain('elanous pty snapshot <id>');
  });

  test('TUI 밖이면 기동을 막지 않는다', () => {
    const decision = decideTuiSelfNest(['eln'], {} as NodeJS.ProcessEnv);
    expect(decision.reject).toBe(false);
    expect(decision.output).toBeNull();
  });

  test('TUI 안이라도 TUI 기동이 아닌 명령은 막지 않는다', () => {
    const env = { ELANOUS_PARENT_PTY_ID: 'pty-parent-3' } as NodeJS.ProcessEnv;
    for (const argv of [['eln', 'pty', 'list'], ['bash'], ['eln', 'logs', '--all']]) {
      expect(decideTuiSelfNest(argv, env).reject).toBe(false);
    }
  });

  test('TUI 안이라도 버전·도움말 같은 정보성 호출은 거부하지 않는다 (보존 계약)', () => {
    const env = {
      ELANOUS_PARENT_PTY_ID: 'pty-parent-4',
      ELANOUS_NEST_DEPTH: '1',
    } as NodeJS.ProcessEnv;
    for (const argv of [
      ['eln', '--version'],
      ['eln', '--help'],
      ['eln', '-h'],
      ['elanous', 'chat', '--help'],
      ['node', '/opt/elanous/elanous.cjs', '--version'],
    ]) {
      const decision = decideTuiSelfNest(argv, env);
      expect(decision.reject).toBe(false);
      expect(decision.output).toBeNull();
      expect(decision.command).toBe('other');
    }
    // 진짜 기동의 거부 문면은 그대로다.
    const real = decideTuiSelfNest(['eln'], env);
    expect(real.reject).toBe(true);
    expect(real.output?.startsWith(TUI_SELF_NEST_REJECT_MARKER)).toBe(true);
  });
});

describe('생산 진입점 wiring — dispatchPtyShellTool(PtyShellStart)', () => {
  test('TUI 맥락에서 eln 기동은 스폰 없이 거부 응답을 돌려준다', async () => {
    process.env.ELANOUS_PARENT_PTY_ID = 'pty-wire-1';
    const result = await dispatchPtyShellTool('PtyShellStart', { cmd: 'eln', args: [] });
    const shaped = result as { output?: string; process_id?: string };
    expect(shaped.process_id).toBeUndefined();
    expect(shaped.output?.startsWith(TUI_SELF_NEST_REJECT_MARKER)).toBe(true);
  }, 60_000);
});
