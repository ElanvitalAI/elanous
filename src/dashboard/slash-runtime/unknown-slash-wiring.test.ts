import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TEST_FAKE_LLM_ENV, TEST_FAKE_LLM_RESPONSE_ENV } from '../../ux-sim/fake-llm.js';
import { mockSeatPtySequence } from '../../ux-sim/mock-seat-pty-sequence.js';

const REPO_CLI = join(import.meta.dir, '..', '..', '..', 'bin', 'elanous.mjs');
const LEGACY_SLASHES = ['board', 'reply', 'capture', 'inject'] as const;
const MOVED_SLASH = 'implement';

test('removed wrappers and /implement advice submitted through the real classic TUI show their replies in chat', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'unknown-slash-pty-'));
  const root = join(temp, 'test-universe');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));

  try {
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [REPO_CLI, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'classic'],
      root,
      artifactPath: join(temp, 'pty.json'),
      rows: 32,
      cols: 120,
      env: {
        ELANOUS_SESSION_ROOT: join(root, 'sessions'),
        ELANOUS_CONFIG_DIR: root,
        ELANOUS_STATE_DIR: root,
        [TEST_FAKE_LLM_ENV]: '1',
        ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        [TEST_FAKE_LLM_RESPONSE_ENV]: 'unused fake response',
      },
      ready: { label: 'boot', until: (screen) => (screen.includes('elanous | daemon') || screen.includes('Opening web setup…') || screen.includes('웹 화면을 여는 중…')) && screen.includes('❯') },
      quitKeys: '/exit\r',
      exitTimeoutMs: 20_000,
      steps: [
        ...LEGACY_SLASHES.map((name) => ({
          label: `/${name}`,
          text: `/${name} probe`,
          until: (screen: string) => screen.includes(`Unknown command: /${name}`) && screen.includes('Type /help for the list of commands.'),
        })),
        {
          label: `/${MOVED_SLASH}`,
          text: `/${MOVED_SLASH} probe`,
          until: (screen: string) => screen.includes('/implement has moved; use /harness ask <무엇을 왜 고칠지 한 문장>'),
        },
      ],
    });

    expect(run.frames.map(({ label }) => label)).toEqual([
      'boot', ...LEGACY_SLASHES.map((name) => `/${name}`), `/${MOVED_SLASH}`,
    ]);
    for (const [index, name] of LEGACY_SLASHES.entries()) {
      const frame = run.frames[index + 1]!;
      expect(frame.input).toContain(`/${name} probe`);
      expect(frame.screen).toContain(`Unknown command: /${name}`);
      expect(frame.screen).toContain('Type /help for the list of commands.');
    }
    const implementFrame = run.frames.at(-1)!;
    expect(implementFrame.input).toContain('/implement probe');
    expect(implementFrame.screen).toContain('/implement has moved; use /harness ask <무엇을 왜 고칠지 한 문장>');
    expect(run.exitCode).toBe(0);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}, 150_000);
