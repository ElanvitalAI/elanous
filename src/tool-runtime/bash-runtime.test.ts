import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUserConfig, runWithUserConfigSnapshot } from '../user-config.js';
import { getDefaultConfirmChannels, registerDefaultConfirmChannels } from '../hitl/confirm.js';
import { bashRuntime, setBashRuntimeApprovalPolicyForTest, setBashRuntimeDeps } from './bash-runtime.js';
import { bashApprovalFinding } from './bash-approval.js';

let root: string;
let configPath: string;
let priorGuardianSetting: string | undefined;

// Source: each invocation has one approval decision.
const ONE_APPROVAL = 1;
// Source: denied Bash dispatches use the same no-execution shell status as the runtime.
const DENIED_EXIT_CODE = 126;
// Source: approved temp-tree removal is expected to finish with the conventional successful shell status.
const SUCCESS_EXIT_CODE = 0;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bash-approval-policy-'));
  configPath = join(root, 'config.json');
  priorGuardianSetting = process.env.ELANOUS_GUARDIAN;
  process.env.ELANOUS_GUARDIAN = 'on';
});

afterEach(() => {
  setBashRuntimeDeps(null);
  setBashRuntimeApprovalPolicyForTest(undefined);
  if (priorGuardianSetting === undefined) delete process.env.ELANOUS_GUARDIAN;
  else process.env.ELANOUS_GUARDIAN = priorGuardianSetting;
  rmSync(root, { recursive: true, force: true });
});

describe('Bash approval policy', () => {
  test('dangerous mode asks for destructive shell commands but allows ordinary commands', () => {
    expect(bashApprovalFinding('printf safe', 'dangerous')).toBeNull();
    expect(bashApprovalFinding('rm -rf /tmp/example', 'dangerous')?.reason).toBe('recursive rm');
  });

  test('all mode asks for confirmation even when the command is not destructive', () => {
    expect(bashApprovalFinding('printf safe', 'all')?.reason).toBe('all Bash calls require confirmation');
  });

  test('dangerous Bash command is not spawned when confirmation is declined', async () => {
    const target = join(root, 'target');
    mkdirSync(target);
    writeFileSync(join(target, 'keep.txt'), 'present');
    const calls: Array<{ cmd: string; args?: string[]; cwd?: string }> = [];
    setBashRuntimeDeps({ cwd: root });
    setBashRuntimeApprovalPolicyForTest('dangerous');

    const result = await bashRuntime.run({ command: `rm -rf '${target}'` }, {
      surface: 'tui',
      approver: async (request) => { calls.push(request); return false; },
    });

    expect(calls).toHaveLength(ONE_APPROVAL);
    const [call] = calls;
    expect(call?.args).toContain('recursive rm');
    expect(result.exitCode).toBe(DENIED_EXIT_CODE);
    expect(existsSync(join(target, 'keep.txt'))).toBe(true);
  });

  test('dangerous Bash command executes only after explicit approval', async () => {
    const target = join(root, 'target');
    mkdirSync(target);
    writeFileSync(join(target, 'remove.txt'), 'temporary');
    setBashRuntimeDeps({ cwd: root });
    setBashRuntimeApprovalPolicyForTest('dangerous');

    const result = await bashRuntime.run({ command: `rm -rf '${target}'` }, {
      surface: 'tui',
      approver: async () => true,
    });

    expect(result.exitCode).toBe(SUCCESS_EXIT_CODE);
    expect(existsSync(target)).toBe(false);
  });

  test('missing approver fails closed without spawning a destructive command', async () => {
    const target = join(root, 'target');
    mkdirSync(target);
    writeFileSync(join(target, 'keep.txt'), 'present');
    setBashRuntimeDeps({ cwd: root });
    setBashRuntimeApprovalPolicyForTest('dangerous');

    const priorChannels = getDefaultConfirmChannels();
    registerDefaultConfirmChannels([]);
    let result;
    try {
      result = await bashRuntime.run({ command: `rm -rf '${target}'` }, { surface: 'tui' });
    } finally {
      registerDefaultConfirmChannels(priorChannels);
    }

    expect(result.exitCode).toBe(DENIED_EXIT_CODE);
    expect(existsSync(join(target, 'keep.txt'))).toBe(true);
  });

  test('all mode gates a harmless Bash command before execution', async () => {
    const requests: Array<{ header?: string; prompt: string; detail?: string }> = [];
    const priorChannels = getDefaultConfirmChannels();
    let approved = false;
    registerDefaultConfirmChannels([{
      name: 'terminal',
      request: async (request) => { requests.push(request); return approved; },
      cancel: () => {},
    }]);
    setBashRuntimeDeps({ cwd: root, sandbox: 'off' });
    writeFileSync(configPath, JSON.stringify({ shell: { bashApproval: 'all' } }));
    const config = buildUserConfig(configPath);
    try {
      const denied = await runWithUserConfigSnapshot(config, () => bashRuntime.run({ command: 'printf protected-by-all-mode' }, {
        surface: 'dashboard',
      }));
      expect(requests.map(({ prompt }) => prompt)).toEqual(['printf protected-by-all-mode']);
      expect(denied.exitCode).toBe(DENIED_EXIT_CODE);
      expect(denied.stdout).toBe('');

      approved = true;
      const allowed = await runWithUserConfigSnapshot(config, () => bashRuntime.run({ command: 'printf approved-by-all-mode' }, {
        surface: 'dashboard',
      }));
      expect(requests.map(({ prompt }) => prompt)).toEqual([
        'printf protected-by-all-mode', 'printf approved-by-all-mode',
      ]);
      expect(allowed.exitCode).toBe(SUCCESS_EXIT_CODE);
      expect(allowed.stdout).toBe('approved-by-all-mode');
    } finally {
      registerDefaultConfirmChannels(priorChannels);
    }
  });
});
