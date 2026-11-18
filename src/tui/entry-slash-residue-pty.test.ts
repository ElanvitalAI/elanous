import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

// TUI-SLASH-TEXT-KOREAN-AND-RESIDUE (SLASH-SWEEP-0328): Esc leaves no picker guide behind,
// and a second /help replaces the first block instead of stacking another one.
test('slash picker guide clears on Esc and repeated /help shows one help block', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-slash-residue-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 40, cols: 100,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1' },
      ready: { label: 'boot', until: (screen) => /Ctrl\+Q (종료|quit)/.test(screen) },
      steps: [
        { label: 'picker', keys: '/', until: (screen) => screen.includes('/ Commands') },
        { label: 'escaped', keys: '\x1b', until: (screen) => !screen.includes('/ Commands') },
        { label: 'help1', keys: 'help\r', until: (screen) => screen.split('\n').some((line) => line.trim() === 'Commands') },
        { label: 'help2', text: '/help', until: (screen) => (screen.match(/\/help/g) ?? []).length >= 1 && screen.includes('PgUp/PgDn') },
      ],
    });
    const frame = (label: string) => run.frames.find((entry) => entry.label === label)?.screen ?? '';
    expect(run.exitCode).toBe(0);
    expect(frame('escaped')).not.toContain('Slash commands');
    expect(frame('help2').split('\n').filter((line) => line.trim() === 'Commands')).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
