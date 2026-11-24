// NEXT-TUI-FOOTER-24-ROWS (대표 «CWD·버전 기본 · 밀려나면 안 됨»): a standard 80×24 terminal is compact mode
// (rows ≤ compactHeight 24). Its footer is the same declarative line as a tall screen, so the folder and the version
// stay visible — before and after a turn — and what only compact mode said takes the turn's place.
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { mockSeatPtySequence } from '../../ux-sim/mock-seat-pty-sequence.js';
import { NEXT_TUI_TITLE } from '../core/render.js';

const REPO_CLI = join(import.meta.dir, '..', '..', '..', 'bin', 'elanous.mjs');

/** The footer block: the screen line that carries the folder name (TUI-STATUS-3ROW seat row) and the work row under it. */
function footerRow(screen: string, folder: string): string {
  const lines = screen.split('\n');
  const at = lines.findIndex((line) => line.includes(folder));
  return at < 0 ? '' : `${lines[at]} ${lines[at + 1] ?? ''}`;
}

test('80×24 Next PTY: the compact footer keeps the folder and the version before and after a turn', async () => {
  // A short folder name stays under the 16-cell leaf cap, so the row can be matched exactly.
  const root = mkdtempSync(join(tmpdir(), 'f24-'));
  const folder = basename(root);
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      onboarding: { completed: true }, errorReports: { enabled: false },
      llm: { memoryJudge: { enabled: false, crossRecall: false } },
    }));
    const evidence = await mockSeatPtySequence({
      executable: process.execPath,
      args: [REPO_CLI, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 24, cols: 80,
      env: {
        ELANOUS_SESSION_ROOT: join(root, 'sessions'),
        ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: 'F24 short reply',
      },
      // Boot: the welcome key hint sits in the turn's place on the same row as the folder and the version.
      ready: { label: 'boot', until: (screen) => screen.includes(NEXT_TUI_TITLE) && footerRow(screen, folder).includes('Ctrl+Q quit') },
      steps: [
        { label: 'answered', text: 'F24 prompt', until: (screen) => screen.includes('F24 short reply') && footerRow(screen, folder) !== '' },
      ],
    });
    expect(evidence.exitCode).toBe(0);
    const boot = footerRow(evidence.frames[0]!.screen, folder);
    expect(boot).toContain('Ctrl+Q quit');
    expect(boot).toMatch(/\bdev\b/u);
    const after = footerRow(evidence.frames[1]!.screen, folder);
    // After the turn: the short turn clause (not the old sentence twice), and the folder and the version still there.
    expect(after).not.toContain('Turn Turn');
    expect(after.indexOf(folder)).toBeLessThan(after.indexOf('dev'));
    expect(after).toMatch(/\bdev\b/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
