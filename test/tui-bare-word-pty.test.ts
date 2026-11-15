import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../src/ux-sim/mock-seat-pty-sequence.js';

for (const mode of ['classic', 'next'] as const) {
  for (const word of ['quit', 'exit', '종료', '그만']) {
    const slashExit = word === 'exit' || word === '그만' ? '/exit' : '/quit';
    test(`${mode} TUI keeps bare ${word} in chat and accepts explicit ${slashExit}`, async () => {
      const root = mkdtempSync(join(tmpdir(), `bare-word-${mode}-`));
      const fakeReply = `BARE_WORD_CHAT_${mode.toUpperCase()}`;
      try {
        writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
        const evidence = await mockSeatPtySequence({
          runId: `bare-word-${mode}-${Buffer.from(word).toString('hex')}`,
          executable: process.execPath,
          args: [join(import.meta.dir, '../bin/elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', mode],
          root,
          rows: 30,
          cols: 100,
          env: {
            ELANOUS_SESSION_ROOT: join(root, 'sessions'),
            ELANOUS_TEST_FAKE_LLM: '1',
            ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
            ELANOUS_TEST_FAKE_LLM_RESPONSE: fakeReply,
          },
          ready: {
            label: `${mode} prompt`,
            until: screen => mode === 'classic' ? screen.includes('ChatLog') && screen.includes('❯') : screen.includes('Enter 전송'),
            timeoutMs: 30_000, // 출처: #37081 가짜 프로바이더 TUI 프롬프트 준비 상한 — 4fc386a 도입값 재배치, 수치 불변
          },
          steps: [{ label: `bare ${word}`, text: word, until: fakeReply, timeoutMs: 30_000 }], // 출처: #37081 bare 단어 가짜 응답 대기 상한 — 4fc386a 도입값 재배치, 수치 불변
          quitKeys: `${slashExit}\r`,
          exitTimeoutMs: 10_000,
        });
        expect(evidence.frames.at(-1)?.screen).toContain(fakeReply);
        expect(evidence.exitCode).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, { timeout: 60_000 }); // 출처: #37081 PTY 시험 전체 상한(2모드×4단어, 기존값 유지)
  }
}
