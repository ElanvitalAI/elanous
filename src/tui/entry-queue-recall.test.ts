import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');

async function runQueueKeys(kind: 'recall' | 'push') {
  const root = mkdtempSync(join(tmpdir(), `next-queue-${kind}-`));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    return await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 24, cols: 80,
      env: {
        ELANOUS_SESSION_ROOT: join(root, 'sessions'),
        ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_DELAY_MS: '8000', ELANOUS_TEST_FAKE_LLM_DELAY_WHEN: 'slow',
      },
      ready: { label: 'boot', until: (s) => s.includes('elanous') && s.includes('Enter 전송') },
      steps: [
        { label: 'queued', chunks: ['slow first', '\r', 'queued second', '\r'], gapMs: 350, until: (s) => s.includes('대기 1') },
        kind === 'recall'
          ? { label: 'Ctrl+Up', keys: '\x1b[1;5A', until: (s) => s.includes('❯ queued second') && s.includes('대기 1건을 입력칸으로') && s.includes('응답 중') }
          : { label: 'empty Enter', keys: '\r', until: (s) => s.includes('나: queued second') && (s.includes('응답 완료') || s.includes('턴 완료')) },
      ],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('Ctrl+Up pulls a busy turn queue entry into the editable composer', async () => {
  const run = await runQueueKeys('recall');
  expect(run.frames[1]?.screen).toContain('대기 1');
  expect(run.frames[2]?.screen).toContain('❯ queued second');
  expect(run.frames[2]?.screen).toContain('응답 중');
  expect(run.exitCode).toBe(0);
}, 30_000);

test('empty Enter interrupts an idle model reply and sends the queued entry now', async () => {
  const run = await runQueueKeys('push');
  const elapsedMs = Date.parse(run.frames[2]!.at) - Date.parse(run.frames[1]!.at);
  // 출처: .rules/30-harness/testing-gates.md R-TST36 — 이 PTY 장치의 fake 응답 지연 8000ms보다 먼저 끝나야 한다.
  expect(elapsedMs).toBeLessThan(8_000);
  expect(run.frames[2]?.screen).toContain('나: queued second');
  expect(run.exitCode).toBe(0);
}, 30_000);
