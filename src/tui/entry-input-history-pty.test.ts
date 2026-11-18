import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence, type SeatPtyStep } from '../ux-sim/mock-seat-pty-sequence.js';

const promptRow = (screen: string) => {
  const rows = screen.split('\n');
  for (let index = rows.length - 1; index >= 0; index -= 1) if (rows[index]!.trimStart().startsWith('❯')) return rows[index]!;
  return '';
};

async function session(root: string, steps: SeatPtyStep[]) {
  return mockSeatPtySequence({
    executable: process.execPath,
    args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
    root, rows: 24, cols: 100,
    env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
      ELANOUS_TEST_FAKE_LLM_RESPONSE: 'HIST-DONE', ELANOUS_CONFIG_DIR: root, ELANOUS_STATE_DIR: root },
    ready: { label: 'boot', until: (screen) => /Ctrl\+Q (종료|quit)/.test(screen) },
    steps,
  });
}

test('NEXT-TUI-INPUT-HISTORY: a prompt from an earlier session comes back with ↑ in a new one; a secret-like prompt does not', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-input-history-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const secret = `HIST-SECRET ghp_${'z'.repeat(36)}`;
    const first = await session(root, [
      { label: 'kept', text: 'HIST-PERSIST one', until: (screen) => screen.includes('HIST-DONE') && /Worked for|턴 완료/.test(screen) },
      { label: 'secret', text: secret, until: (screen) => screen.split('HIST-DONE').length > 2 },
      { label: 'quit', keys: '\x11', until: () => true },
    ]);
    expect(first.exitCode).toBe(0);
    let recalled = '';
    const second = await session(root, [
      // The secret-like prompt was never stored, so the first ↑ already reaches the earlier prompt.
      { label: 'up', keys: '\x1b[A', until: (screen) => { recalled = promptRow(screen); return recalled.includes('HIST-PERSIST one'); } },
      { label: 'quit', keys: '\x11', until: () => true },
    ]);
    expect(second.exitCode).toBe(0);
    expect(recalled).toContain('HIST-PERSIST one');
    expect(recalled).not.toContain('ghp_');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
