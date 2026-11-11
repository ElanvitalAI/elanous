import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';
import { NEXT_TUI_TITLE } from './core/render.js';

test('next TUI edits at the cursor and applies Ctrl+W/U in a real PTY', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-input-edit-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 24, cols: 80,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1' },
      ready: { label: 'boot', until: (screen) => screen.split('\n').includes(NEXT_TUI_TITLE) && screen.includes('Ctrl+Q 종료') },
      steps: [
        { label: 'typed', text: 'alpha beta gamma', enter: false, until: '❯ alpha beta gamma' },
        { label: 'cursor-left', keys: '\x1b[D', until: '❯ alpha beta gamma' },
        { label: 'insert-at-cursor', keys: 'X', until: '❯ alpha beta gammXa' },
        { label: 'Ctrl+W', keys: '\x17', until: '❯ alpha beta a' },
        { label: 'Ctrl+U', keys: '\x15', until: (s) => s.endsWith('❯ ') },
      ],
    });
    expect(run.frames.map((f) => f.label)).toEqual(['boot', 'typed', 'cursor-left', 'insert-at-cursor', 'Ctrl+W', 'Ctrl+U']);
    expect(run.frames[3]?.screen).toContain('alpha beta gammXa');
    expect(run.frames[4]?.screen).not.toContain('gamm');
    expect(run.frames[5]?.screen).toEndWith('❯ ');
    expect(run.exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
