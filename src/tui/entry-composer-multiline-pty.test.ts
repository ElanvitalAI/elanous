import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');

test('next TUI grows, scrolls and shrinks its composer with Kitty and xterm newline keys in a small PTY', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-composer-multiline-'));
  try {
    const capture = join(root, 'requests.jsonl');
    const wrapText = 'a'.repeat(38); // Source: #36682 — 40 columns minus the two-cell prompt
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      artifactPath: process.env.NT_SW1_COMPOSER_RECEIPT_DIR ? join(process.env.NT_SW1_COMPOSER_RECEIPT_DIR, 'next-small.json') : undefined,
      root, rows: 8, cols: 40,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_CAPTURE: capture, ELANOUS_TEST_FAKE_LLM_RESPONSE: 'MULTILINE-PROBE-OK' },
      ready: { label: 'boot', until: (screen) => screen.includes('elanous') && screen.includes('❯'), timeoutMs: 10_000 }, // Source: #36682
      steps: [
        { label: 'Kitty Shift+Enter', chunks: ['alpha', '\x1b[13;2u', 'beta'], until: (s: string) => s.includes('❯ alpha\n  beta') },
        { label: 'xterm Shift+Enter', chunks: ['\x1b[27;2;13~', 'gamma'], until: (s: string) => s.includes('  beta\n  gamma') },
        { label: 'Alt+Enter', chunks: ['\x1b\r', 'delta'], until: (s: string) => s.includes('  gamma\n  delta') },
        { label: 'Ctrl+J', chunks: ['\n', 'epsilon'], until: (s: string) => s.includes('  delta\n  epsilon') },
        { label: 'overflow', chunks: ['\n', 'zeta', '\n', 'eta', '\n', 'theta', '\n', 'iota', '\n', 'kappa'], until: (s: string) => s.includes('  kappa') && !s.includes('❯ alpha') },
        { label: 'shrink', keys: '\x15', until: (s: string) => s.endsWith('❯ ') && !s.includes('kappa') },
        { label: 'wrap boundary cursor', chunks: [wrapText, 'X', '\x1b[D'], until: (s: string) => s.includes('  X') },
        { label: 'clear boundary', keys: '\x1b[F\x15', until: (s: string) => s.endsWith('❯ ') && !s.includes('  X') },
        { label: 'submit multiline', chunks: ['first', '\x1b[13;2u', 'second', '\r'], until: (s: string) => s.includes('MULTILINE-PROBE-OK') },
      ].map((step) => ({ ...step, timeoutMs: 5_000 })), // Source: #36682
    });
    expect(run.frames[1]?.cursor.row).toBeLessThanOrEqual(8); // Source: #36682
    expect(run.frames[2]?.cursor.row).toBeLessThanOrEqual(8); // Source: #36682
    expect(run.frames[3]?.cursor.row).toBeLessThanOrEqual(8); // Source: #36682
    expect(run.frames[4]?.cursor.row).toBeLessThanOrEqual(8); // Source: #36682
    expect(run.frames[5]?.screen).not.toContain('❯ alpha');
    expect(run.frames[6]?.screen).toEndWith('❯ ');
    expect(run.frames[7]?.cursor).toEqual({ row: 8, col: 3 }); // Source: #36682
    const requests = readFileSync(capture, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as {
      messages: Array<{ role: string; content: unknown }>;
    });
    expect(requests.some(({ messages }) => messages.some(({ role, content }) => role === 'user' && content === 'first\nsecond'))).toBe(true);
    expect(run.exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000); // Source: #36682

test('classic PTY accepts the same Kitty Shift+Enter sequence as next', async () => {
  const root = mkdtempSync(join(tmpdir(), 'classic-composer-comparison-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'classic'],
      artifactPath: process.env.NT_SW1_COMPOSER_RECEIPT_DIR ? join(process.env.NT_SW1_COMPOSER_RECEIPT_DIR, 'classic.json') : undefined,
      root, rows: 24, cols: 80, quitKeys: '\x11',
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1' },
      ready: { label: 'classic boot', until: (s) => (s.includes('elanous | daemon') || s.includes('Opening web setup…')) && s.includes('❯'), timeoutMs: 20_000 }, // Source: #36682
      steps: [{ label: 'classic Kitty newline', chunks: ['alpha', '\x1b[13;2u', 'beta'], until: (s) => s.includes('alpha') && s.includes('beta'), timeoutMs: 10_000 }], // Source: #36682
    });
    expect(run.frames[1]?.screen).toContain('alpha');
    expect(run.frames[1]?.screen).toContain('beta');
    expect(run.exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000); // Source: #36682
