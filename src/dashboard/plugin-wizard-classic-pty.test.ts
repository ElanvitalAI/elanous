import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

test('classic dashboard directs plugin-wizard phrases to next TUI instead of the LLM', async () => {
  const root = mkdtempSync(join(tmpdir(), 'classic-plugin-wizard-'));
  const fakeReply = 'CLASSIC_PLUGIN_WIZARD_FAKE_REPLY';
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true } }));
    const evidence = await mockSeatPtySequence({
      runId: 'classic-plugin-wizard-guidance',
      executable: process.execPath,
      args: [
        join(import.meta.dir, '../../bin/elanous.mjs'),
        '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'classic',
      ],
      root,
      rows: 30,
      cols: 100,
      env: {
        ELANOUS_SESSION_ROOT: join(root, 'sessions'),
        ELANOUS_TEST_FAKE_LLM: '1',
        ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: fakeReply,
      },
      // Source: #97873 classic PTY probe; allow startup to settle before sending the real phrase.
      ready: { label: 'classic dashboard prompt', until: screen => screen.includes('ChatLog') && screen.includes('❯'), timeoutMs: 30_000 },
      steps: [{
        label: 'plugin wizard phrase',
        text: '플러그인 만들어 줘',
        until: '플러그인 마법사는 next TUI에서 지원합니다.',
        // Source: #97873 classic PTY probe; bounds the user's first-request response.
        timeoutMs: 30_000,
      }],
      exitTimeoutMs: 5_000,
    });
    expect(evidence.exitCode).toBe(0);
    expect(evidence.frames.at(-1)?.screen).toContain('플러그인 마법사는 next TUI에서 지원합니다.');
    expect(evidence.frames.at(-1)?.screen).not.toContain(fakeReply);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
// Source: #97873 classic PTY probe; includes startup, interaction, and clean PTY exit.
}, { timeout: 45_000 });
