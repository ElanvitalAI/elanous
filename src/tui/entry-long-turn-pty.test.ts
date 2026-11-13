import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');

// 출처: this scenario holds the first provider reply for ten seconds to exercise queued input.
const FIRST_REPLY_DELAY_MS = 10_000;
// 출처: allow next TUI startup twice the scenario's provider delay before interaction.
const READY_TIMEOUT_MS = FIRST_REPLY_DELAY_MS * 2;
// 출처: working and draft frames must appear before the delayed first reply.
const INPUT_TIMEOUT_MS = 8_000;
// 출처: reply frames allow the provider delay plus two seconds for PTY rendering.
const FRAME_TIMEOUT_MS = FIRST_REPLY_DELAY_MS + 2_000;
// 출처: startup plus five frame waits and cleanup fit in the existing ninety-second scenario budget.
const SCENARIO_TIMEOUT_MS = 90_000;


test('next TUI keeps a delayed turn visible, accepts a queued request, and returns both replies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-long-turn-'));
  const replyTemplate = '[fake-llm] long turn reply {reply}';
  const firstReply = '[fake-llm] long turn reply 1';
  const secondReply = '[fake-llm] long turn reply 2';
  const expectedTranscript = [
    '나: slow first', `엘라누스: ${firstReply}`,
    '나: second request', `엘라누스: ${secondReply}`,
  ];
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      onboarding: { completed: true }, errorReports: { enabled: false },
      llm: { goalLoop: { enabled: false }, memoryJudge: { enabled: false, crossRecall: false } },
    }));
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 24, cols: 100,
      env: {
        ELANOUS_SESSION_ROOT: join(root, 'sessions'),
        ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: replyTemplate,
        ELANOUS_TEST_FAKE_LLM_DELAY_MS: String(FIRST_REPLY_DELAY_MS), ELANOUS_TEST_FAKE_LLM_DELAY_WHEN: 'slow first',
      },
      ready: { label: 'ready', timeoutMs: READY_TIMEOUT_MS,
        until: (screen) => screen.includes('Ctrl+Q 종료') && screen.includes('❯') },
      steps: [
        { label: 'first turn working', text: 'slow first', timeoutMs: INPUT_TIMEOUT_MS,
          until: (screen) => screen.includes('나: slow first') && screen.includes('턴 스트리밍') },
        { label: 'draft during long turn', text: 'second request', enter: false,
          timeoutMs: INPUT_TIMEOUT_MS, until: (screen) => screen.includes('❯ second request') && screen.includes('턴 스트리밍') },
        { label: 'queued during long turn', keys: '\r', timeoutMs: FRAME_TIMEOUT_MS,
          until: (screen) => screen.includes('대기 1') && screen.includes('턴 스트리밍') },
        { label: 'first reply remains visible', timeoutMs: FRAME_TIMEOUT_MS,
          until: (screen) => screen.includes(firstReply) && screen.includes('나: slow first') },
        { label: 'second reply finishes', timeoutMs: FRAME_TIMEOUT_MS,
          until: (screen) => screen.includes('나: second request') && screen.includes(secondReply)
            && screen.includes('턴 완료') },
      ],
    });
    const [working, draft, queued, first, second] = run.frames.slice(1);
    expect(working?.screen).toContain('턴 스트리밍');
    expect(draft?.screen).toContain('❯ second request');
    expect(queued?.screen).toContain('대기 1');
    expect(Date.parse(queued!.at) - Date.parse(working!.at)).toBeLessThan(FIRST_REPLY_DELAY_MS);
    expect(first?.screen).toContain(firstReply);
    const transcript = second?.screen.split('\n').map((line) => line.trim())
      .filter((line) => line.startsWith('나: ') || line.startsWith('엘라누스: '));
    expect(transcript).toEqual(expectedTranscript);
    expect(run.exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, SCENARIO_TIMEOUT_MS);
