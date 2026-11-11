import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mockSeatPtySequence } from './mock-seat-pty-sequence.js';

test('next TUI header rule fills a wide real PTY', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-wrap-pty-'));
  writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
  try {
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [resolve(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root,
      // Source: 내부 문서 `next-tui-stream-polish-2` reproduces OP's wide PTY header observation.
      rows: 36, cols: 120,
      env: { ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1' },
      ready: { label: 'boot', until: 'Ctrl+Q 종료' },
      steps: [{ label: 'turn', text: '넓은 화면 질문', until: '응답 완료' }],
    });
    // Source: 내부 문서 `next-tui-stream-polish-2` compares 80-column baseline with 120-column PTY.
    expect(run.frames[0]?.screen.split('\n')[1]).toBe('─'.repeat(120));
    expect(run.frames.at(-1)?.screen.split('\n')[1]).toBe('─'.repeat(120));
    expect(run.exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
