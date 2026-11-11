import { NEXT_TUI_TITLE } from './core/render.js';
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

// Source: each real PTY boot and approval response must arrive within one bounded minute.
const PTY_APPROVAL_STEP_TIMEOUT_MS = 60_000;

test('Next TUI real PTY denies rm -rf on default Enter and runs it only after direct y', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-bash-approval-pty-'));
  try {
    const deniedRoot = join(root, 'denied');
    const approvedRoot = join(root, 'approved');
    const deniedTarget = join(deniedRoot, 'target');
    const approvedTarget = join(approvedRoot, 'target');
    mkdirSync(deniedTarget, { recursive: true });
    mkdirSync(approvedTarget, { recursive: true });
    writeFileSync(join(deniedRoot, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    writeFileSync(join(approvedRoot, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    writeFileSync(join(deniedTarget, 'keep.txt'), 'must survive default Enter');
    writeFileSync(join(approvedTarget, 'remove.txt'), 'removed only after human y');

    const runCase = async (label: string, caseRoot: string, targetRoot: string, answer: string) => {
      const target = join(targetRoot, answer === '\r' ? 'keep.txt' : 'remove.txt');
      const command = `rm -rf '${targetRoot}'`;
      return mockSeatPtySequence({
        executable: process.execPath,
        args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
        root: caseRoot, rows: 24, cols: 90,
        env: {
          ELANOUS_SESSION_ROOT: join(caseRoot, 'sessions'),
          ELANOUS_NEXT_TUI_COMPACT_HEIGHT: '20',
          ELANOUS_CONFIG_DIR: caseRoot,
          ELANOUS_STATE_DIR: caseRoot,
          ELANOUS_TEST_FAKE_LLM: '1',
          ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
          ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({ when: 'delete fixture', name: 'Bash', args: { command } }),
          ELANOUS_TEST_FAKE_LLM_RESPONSE: 'Approval fixture complete.',
        },
        ready: { label: `${label}-boot`, until: (screen) => screen.split('\n').includes(NEXT_TUI_TITLE) && screen.includes('Ctrl+Q 종료'), timeoutMs: PTY_APPROVAL_STEP_TIMEOUT_MS },
        steps: [
          { label: `${label}-approval-prompt`, text: 'delete fixture', until: (screen) => screen.includes('Bash 실행 승인 · 전체 명령') && screen.includes('Enter 기본 N') && screen.includes(command.slice(0, 45)) },
          { label: `${label}-decision`, keys: answer, until: (screen) => screen.includes('응답 완료'), timeoutMs: PTY_APPROVAL_STEP_TIMEOUT_MS },
        ],
      }).then((evidence) => ({ evidence, target }));
    };

    const denied = await runCase('default-deny', deniedRoot, deniedTarget, '\r');
    expect(denied.evidence.frames.find((frame) => frame.label === 'default-deny-approval-prompt')?.screen).toContain('Enter 기본 N');
    expect(existsSync(denied.target)).toBe(true);

    const approved = await runCase('explicit-y', approvedRoot, approvedTarget, 'y');
    expect(approved.evidence.frames.find((frame) => frame.label === 'explicit-y-approval-prompt')?.screen).toContain('y 실행 · n 거부');
    expect(existsSync(approved.target)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 150_000);
