import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

// Source: one fake provider call and one human answer in a bounded local PTY.
const INTERVIEW_PTY_TIMEOUT_MS = 60_000;

test('the actual Next TUI tool call shows questions and assumptions in composer and consumes one answer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-harness-ask-user-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 24, cols: 90,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1',
        ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({ when: 'interview fixture', name: 'HarnessAskUser',
          args: { questions: ['어떤 좌석을 판매하나요?', '환불 마감은 언제인가요?'],
            assumptions: ['좌석 중복 판매는 허용하지 않음'] } }),
        ELANOUS_TEST_FAKE_LLM_RESPONSE: '인터뷰 반영 완료.' },
      ready: { label: 'boot', until: screen => screen.includes('Ctrl+Q quit'), timeoutMs: INTERVIEW_PTY_TIMEOUT_MS },
      steps: [
        { label: 'ask-in-composer', text: 'interview fixture', until: screen => screen.includes('어떤 좌석을 판매하나요?')
          && screen.includes('환불 마감은 언제인가요?') && screen.includes('가정 1. 좌석 중복 판매는 허용하지 않음')
          && screen.includes('❯ '), timeoutMs: INTERVIEW_PTY_TIMEOUT_MS },
        { label: 'answered', text: '지정석, 공연 하루 전까지', until: screen => screen.includes('인터뷰 반영 완료.') && screen.includes('● Turn done'),
          timeoutMs: INTERVIEW_PTY_TIMEOUT_MS },
        { label: 'next-request-ask-in-composer', text: 'interview fixture again',
          until: screen => screen.includes('질문 · 한 번 답변하면 이 라운드를 마칩니다')
            && screen.includes('환불 마감은 언제인가요?') && screen.includes('❯ '),
          timeoutMs: INTERVIEW_PTY_TIMEOUT_MS },
        { label: 'next-request-answered', text: '다음 요청의 사람 답변',
          until: screen => screen.includes('● Turn done') && screen.includes('인터뷰 반영 완료.'),
          timeoutMs: INTERVIEW_PTY_TIMEOUT_MS },
      ],
    });
    expect(run.exitCode).toBe(0);
    const ask = run.frames.find(frame => frame.label === 'ask-in-composer')?.screen ?? '';
    expect(ask).toContain('어떤 좌석을 판매하나요?');
    expect(ask).toContain('환불 마감은 언제인가요?');
    expect(ask).toContain('가정 1. 좌석 중복 판매는 허용하지 않음');
    expect(run.frames.find(frame => frame.label === 'answered')?.screen).toContain('인터뷰 반영 완료.');
    expect(run.frames.find(frame => frame.label === 'next-request-ask-in-composer')?.screen)
      .toContain('질문 · 한 번 답변하면 이 라운드를 마칩니다');
    const sessionFile = readdirSync(join(root, 'sessions')).find(name => name.endsWith('.jsonl'));
    if (!sessionFile) throw new Error('missing interview transcript');
    const results = readFileSync(join(root, 'sessions', sessionFile), 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { toolName?: string; toolResult?: string })
      .filter(row => row.toolName === 'HarnessAskUser');
    expect(results).toHaveLength(2);
    expect(results[1]?.toolResult).toContain('다음 요청의 사람 답변');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
