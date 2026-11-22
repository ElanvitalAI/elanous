import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';
import { TEST_FAKE_LLM_DELAY_MS_ENV, TEST_FAKE_LLM_DELAY_WHEN_ENV } from '../ux-sim/fake-llm.js';

const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
const SLOW = 'PREEMPT-QUIT-SLOW';

async function longTurnQuit(quitKeys: string, steps: Parameters<typeof mockSeatPtySequence>[0]['steps']) {
  const root = mkdtempSync(join(tmpdir(), 'seat-preempt-quit-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    return await mockSeatPtySequence({ executable: process.execPath,
      args: [BIN, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 28, cols: 110, quitKeys, exitTimeoutMs: 5_000,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: 'SHOULD-NOT-WAIT', [TEST_FAKE_LLM_DELAY_MS_ENV]: '120000',
        [TEST_FAKE_LLM_DELAY_WHEN_ENV]: SLOW },
      ready: { label: 'boot', until: (screen) => screen.includes('elanous') && screen.includes('Enter send') },
      steps,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('physical Ctrl+Q exits a busy seat with queued input before its long model request finishes', async () => {
  const run = await longTurnQuit('\x11', [
    // 출처: #126648 30초 맥락 진입 목표; 첫 화면과 대기 입력 화면마다 최대 10초의 PTY 대기 예산.
    { label: 'slow', text: SLOW, until: (screen) => /Thinking|턴 스트리밍/.test(screen), timeoutMs: 10_000 },
    // 출처: #126648 30초 맥락 진입 목표; 첫 화면과 대기 입력 화면마다 최대 10초의 PTY 대기 예산.
    { label: 'queued', text: 'waiting person input', until: (screen) => /Steer 1|Queue 1|S1|Q1|대기 1|steer pending/.test(screen), timeoutMs: 10_000 },
  ]);
  expect(run.exitCode).toBe(0);
  expect(run.frames.at(-1)?.screen).not.toContain('SHOULD-NOT-WAIT');
}, 45_000);

test('/exit exits the busy seat while queued input and the long model request remain', async () => {
  const run = await longTurnQuit('', [
    // 출처: #126648 30초 맥락 진입 목표; 첫 화면과 대기 입력 화면마다 최대 10초의 PTY 대기 예산.
    { label: 'slow', text: SLOW, until: (screen) => /Thinking|턴 스트리밍/.test(screen), timeoutMs: 10_000 },
    // 출처: #126648 30초 맥락 진입 목표; 첫 화면과 대기 입력 화면마다 최대 10초의 PTY 대기 예산.
    { label: 'queued', text: 'waiting person input', until: (screen) => /Steer 1|Queue 1|S1|Q1|대기 1|steer pending/.test(screen), timeoutMs: 10_000 },
    { label: 'exit command', text: '/exit', until: () => true },
  ]);
  expect(run.exitCode).toBe(0);
}, 45_000);
