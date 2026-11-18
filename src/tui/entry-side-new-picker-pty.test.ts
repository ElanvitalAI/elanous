import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

test('HERDR-C1-PICKER-FRICTION: typing on after «/side new» closes the picker instead of spawning a shell', async () => {
  const root = mkdtempSync(join(tmpdir(), 'side-new-picker-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const seen: Record<string, string> = {};
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 30, cols: 120,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_CONFIG_DIR: root, ELANOUS_STATE_DIR: root },
      ready: { label: 'boot', until: (screen) => /Ctrl\+Q (종료|quit)/.test(screen) },
      steps: [
        { label: 'picker', text: '/side new', until: (screen) => { seen.picker = screen; return /s shell · e elanous/.test(screen); } },
        // The person keeps typing the next command; «/» closes the picker and the line reaches the composer.
        { label: 'typed on', text: '/side all', until: (screen) => { seen.after = screen; return /All sidetab entries/.test(screen); } },
      ],
    });
    expect(run.exitCode).toBe(0);
    expect(seen.picker).toContain('c codex · l claude');
    expect(seen.after).not.toMatch(/s shell · e elanous/);
    // No shell was spawned and nothing was typed into one.
    expect(seen.after).not.toMatch(/command not found|PTY input active/);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
