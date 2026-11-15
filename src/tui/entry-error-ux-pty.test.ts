import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

test('a failed real next TUI turn shows one clear receipt and a usable retry hint', async () => {
  // Source: this scenario sends one failed turn and one recalled turn with Enter.
  const sentTurnLabels = ['failed', 'resent'] as const;
  const [firstSendLabel, resendLabel] = sentTurnLabels;
  const expectedSentTurns = sentTurnLabels.length;
  const sentTurnMarker = '❯ ERRORUX-FAIL';
  const root = mkdtempSync(join(tmpdir(), 'next-error-ux-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 24, cols: 85,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: 'SHOULD-NOT-REPLY', ELANOUS_TEST_FAKE_LLM_FAIL_WHEN: 'ERRORUX-FAIL' },
      ready: { label: 'boot', until: (screen) => screen.includes('Ctrl+Q 종료') },
      steps: [
        { label: firstSendLabel, text: 'ERRORUX-FAIL', until: (screen) => screen.includes('턴 응답 실패') && screen.includes('✘ 요청을 처리하지 못했습니다.') },
        { label: 'recall', keys: '\x1b[A', until: (screen) => screen.includes('❯ ERRORUX-FAIL') },
        { label: resendLabel, keys: '\r', until: (screen) => screen.split(sentTurnMarker).slice(1).length >= expectedSentTurns
          && screen.includes('턴 응답 실패') },
      ],
    });
    const failed = run.frames.find((frame) => frame.label === 'failed')?.screen ?? '';
    expect(run.exitCode).toBe(0);
    expect(failed).toContain('✘ 요청을 처리하지 못했습니다.');
    expect(failed).toContain('↑ 입력 불러오기 → Enter 재전송 · /provider 확인');
    expect(failed).toContain('턴 응답 실패');
    expect(failed).not.toContain('  요청을 처리하지 못했습니다.');
    expect(failed).not.toContain('SHOULD-NOT-REPLY');
    expect(run.frames.find((frame) => frame.label === 'recall')?.screen).toContain('❯ ERRORUX-FAIL');
    expect(run.frames.find((frame) => frame.label === 'resent')?.screen.split(sentTurnMarker).slice(1).length)
      .toBeGreaterThanOrEqual(expectedSentTurns);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
