import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';
import { NEXT_TUI_TITLE } from './core/render.js';

test('next TUI PageUp/PageDown and wheel move a long log in both directions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-scroll-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const reply = Array.from({ length: 45 }, (_, i) => `SCROLL-LINE-${String(i).padStart(2, '0')}`).join('\n');
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 24, cols: 80,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', ELANOUS_TEST_FAKE_LLM_RESPONSE: reply,
        ELANOUS_NEXT_TUI_COMPACT_HEIGHT: '20' },
      ready: { label: 'boot', until: (screen) => screen.split('\n').includes(NEXT_TUI_TITLE) && screen.includes('Ctrl+Q 종료') },
      steps: [
        { label: 'bottom', text: 'scroll probe', until: (s) => s.includes('SCROLL-LINE-44') && (s.includes('응답 완료') || s.includes('턴 완료')) },
        { label: 'PageUp', keys: '\x1b[5~', until: (s) => s.includes('SCROLL-LINE-35') && !s.includes('SCROLL-LINE-44') && (s.includes('로그 탐색') || s.includes('턴 로그')) },
        { label: 'wheel up', keys: '\x1b[<64;30;10M', until: (s) => s.includes('SCROLL-LINE-32') && !s.includes('SCROLL-LINE-35') },
        { label: 'PageDown', keys: '\x1b[6~', until: (s) => s.includes('SCROLL-LINE-42') && !s.includes('SCROLL-LINE-44') },
        { label: 'wheel down', keys: '\x1b[<65;30;10M', until: (s) => s.includes('SCROLL-LINE-44') && (s.includes('로그 탐색') || s.includes('턴 로그')) },
      ],
    });
    expect(run.frames.map((f) => f.label)).toEqual(['boot', 'bottom', 'PageUp', 'wheel up', 'PageDown', 'wheel down']);
    expect(run.frames[2]?.screen).not.toContain('SCROLL-LINE-44');
    expect(run.frames[3]?.screen).not.toContain('SCROLL-LINE-35');
    expect(run.frames[4]?.screen).not.toContain('SCROLL-LINE-44');
    expect(run.frames[5]?.screen).toContain('SCROLL-LINE-44');
    expect(run.exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
