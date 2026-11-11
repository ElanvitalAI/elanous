import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mockSeatPtySequence } from './mock-seat-pty-sequence.js';

test('next TUI PTY shows a completed child and its grandchild', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-grandchild-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(resolve(import.meta.dir, '..', '..'), 'bin', 'elanous.mjs'), '--fake-llm', '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 32, cols: 100,
      env: {
        ELANOUS_SESSION_ROOT: join(root, 'sessions'),
        ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_CAPTURE: join(root, 'requests.jsonl'),
        ELANOUS_TEST_FAKE_LLM_RESPONSE: '[fake-llm] B4 finished',
        ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify([
          { when: 'B4 parent', name: 'Agent', args: { description: 'B4 child', prompt: 'B4 child prompt' } },
          { when: 'B4 child prompt', name: 'Agent', args: { description: 'B4 grandchild', prompt: 'B4 grandchild prompt' } },
        ]),
      },
      ready: { label: 'boot', until: 'Ctrl+Q 종료' },
      steps: [
        // 출처: #36673 NEXT-TUI-B4-GRANDCHILD 실 PTY 영수증; 중첩 Agent 완료 시험 상한.
        { label: 'two levels done', text: 'B4 parent', timeoutMs: 60_000,
          until: (screen) => screen.includes('턴 완료') && screen.includes('✓ Agent(B4 child) · 완료')
            && screen.includes('✓ Agent(↳ B4 grandchild) · 완료') },
        // 출처: #36673 NEXT-TUI-B4-GRANDCHILD 실 PTY 영수증; 후속 턴 행 정리 시험 상한.
        { label: 'next turn clears prior agent rows', text: 'B4 followup', timeoutMs: 30_000,
          until: (screen) => screen.includes('B4 followup') && screen.includes('턴 완료')
            && !screen.includes('✓ Agent(↳ B4 grandchild) · 완료') },
      ],
    });
    expect(run.exitCode).toBe(0);
    const requests = readFileSync(join(root, 'requests.jsonl'), 'utf8');
    expect(requests).toContain('B4 grandchild prompt');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 75_000);
