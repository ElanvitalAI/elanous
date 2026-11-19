import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NEXT_TUI_TITLE } from '../src/tui/core/render.js';
import { mockSeatPtySequence } from '../src/ux-sim/mock-seat-pty-sequence.js';

const REPO_CLI = join(import.meta.dir, '..', 'bin', 'elanous.mjs');

test('next prompt shows a short paste label in the same isolated screen as the before cast', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-paste-display-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      onboarding: { completed: true }, errorReports: { enabled: false },
      llm: { provider: 'local', model: 'fake-local' },
    }));
    const result = await mockSeatPtySequence({
      executable: process.execPath,
      args: [REPO_CLI, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 24, cols: 100,
      artifactPath: process.env.NEXT_INPUT_PASTE_RECEIPT_DIR
        ? join(process.env.NEXT_INPUT_PASTE_RECEIPT_DIR, 'paste-after.json') : undefined,
      ready: { label: 'boot', until: (screen) => screen.includes(NEXT_TUI_TITLE) && screen.includes('Ctrl+Q quit') }, // 출처: #38058 next TUI 크롬 영문 스윕
      steps: [
        { label: 'four-line-paste', chunks: ['\x1b[200~first line\nsecond line\nthird line\nfourth line\x1b[201~'],
          until: (screen) => screen.includes('[Paste #1 · 4 lines · full text]') }, // 출처: #38058 next TUI 크롬 영문 스윕
      ],
    });
    const paste = result.frames.find((frame) => frame.label === 'four-line-paste')?.screen ?? '';
    expect(result.exitCode).toBe(0);
    expect(paste).toContain('❯ [Paste #1 · 4 lines · full text]'); // 출처: #38058 next TUI 크롬 영문 스윕
    expect(paste).not.toContain('45 chars'); // 출처: #38058 next TUI 크롬 영문 스윕
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 150_000);

test('a fake next turn receives the full pasted lines instead of the display token', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-paste-submit-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      onboarding: { completed: true }, errorReports: { enabled: false },
      llm: { provider: 'auto' },
    }));
    const result = await mockSeatPtySequence({
      executable: process.execPath,
      args: [REPO_CLI, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 24, cols: 100,
      env: { ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: 'fake paste reply' },
      ready: { label: 'boot', until: (screen) => screen.includes(NEXT_TUI_TITLE) && screen.includes('Ctrl+Q quit') }, // 출처: #38058 next TUI 크롬 영문 스윕
      steps: [
        { label: 'paste', chunks: ['\x1b[200~first line\nsecond line\nthird line\nfourth line\x1b[201~'],
          until: (screen) => screen.includes('[Paste #1 · 4 lines · full text]') }, // 출처: #38058 next TUI 크롬 영문 스윕
        { label: 'submit', keys: '\r', until: (screen) => screen.includes('fake paste reply')
          && screen.includes('> first line') && screen.includes('fourth line') }, // 출처: #38058 next TUI 크롬 영문 스윕
      ],
    });
    const submitted = result.frames.find((frame) => frame.label === 'submit')?.screen ?? '';
    expect(result.exitCode).toBe(0);
    expect(submitted).toContain('> first line'); // 출처: #38058 next TUI 크롬 영문 스윕
    expect(submitted).toContain('  fourth line');
    expect(submitted).toContain('fake paste reply');
    expect(submitted).not.toContain('[Paste #1'); // 출처: #38058 next TUI 크롬 영문 스윕
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 150_000);
