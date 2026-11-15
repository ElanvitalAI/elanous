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
        ELANOUS_TEST_FAKE_LLM_SCRIPT: 'stall:STREAM-FIRST-CHUNK waiting',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: 'NEVER-FINAL',
      },
      ready: { label: 'boot', until: (screen) => screen.includes('Enter 전송') && screen.includes('❯ ') },
      steps: [{ label: 'first chunk while busy', text: '이 폴더에서 콘서트 티케팅 시스템을 만들어줘. 프론트엔드, 백엔드 시스템을 설계하고 실제 배포해줘', until: (s) =>
        s.includes('  STREAM-FIRST-CHUNK') && s.includes('턴 스트리밍') && /추정(?: 7|7t)/u.test(s) && !s.includes('응답 완료') },
      { label: 'elapsed advances without inventing more tokens', until: (s) => {
        const elapsed = /(?:경과 )?(\d+\.\d+)초/u.exec(s);
        return Boolean(elapsed && Number(elapsed[1]) >= 0.5 && /추정(?: 7|7t)/u.test(s));
      } }],
    });
    const stream = run.frames[1]?.screen ?? '';
    expect(stream).toContain('  STREAM-FIRST-CHUNK');
    expect(stream).toContain('턴 스트리밍');
    expect(stream).not.toContain('NEVER-FINAL');
    expect(run.frames[2]?.screen).toMatch(/추정(?: 7|7t)/u);
    expect(run.exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
