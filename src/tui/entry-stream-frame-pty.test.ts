import { NEXT_TUI_TITLE } from './core/render.js';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

test('next TUI paints the first chunk while the response is still streaming', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-stream-frame-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 24, cols: 80,
      env: {
        ELANOUS_SESSION_ROOT: join(root, 'sessions'),
        ELANOUS_NEXT_TUI_COMPACT_HEIGHT: '20',
        ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_SCRIPT: 'stall:STREAM-FIRST-CHUNK',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: 'NEVER-FINAL',
      },
      ready: { label: 'boot', until: (screen) => screen.split('\n').includes(NEXT_TUI_TITLE) && screen.includes('Ctrl+Q 종료') },
      steps: [{ label: 'first chunk while busy', text: 'stream probe', until: (s) =>
        s.includes('엘라누스: STREAM-FIRST-CHUNK') && s.includes('응답 중') && !s.includes('응답 완료') }],
    });
    const stream = run.frames[1]?.screen ?? '';
    expect(stream).toContain('엘라누스: STREAM-FIRST-CHUNK');
    expect(stream).toContain('응답 중');
    expect(stream).not.toContain('NEVER-FINAL');
    expect(run.exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
