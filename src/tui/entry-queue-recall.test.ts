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
      ready: { label: 'boot', until: (s) => s.includes('elanous') && /Enter (전송|send)/.test(s) }, // #37922 English footer — 둘 다 승인
      steps: [
        { label: 'queued', chunks: ['slow first', '\r', 'queued second', '\r'], gapMs: 350, until: (s) => /대기 1|1 queued|1 steer pending/.test(s) }, // #38392 spinner · N queued / A200 footer N steer pending
        kind === 'recall'
          ? { label: 'Ctrl+Up', keys: '\x1b[1;5A', until: (s) => s.includes('❯ queued second') && /대기 1건을 입력칸으로|1 queued drafts restored/.test(s) && /응답 중|running/.test(s) }
          : { label: 'empty Enter', keys: '\r', until: (s) => /^> queued second\s*$/m.test(s) && /Turn done|턴 완료/.test(s) && !/(?:대기\s*[1-9]|[1-9]+\s*(?:queued|steer pending))/.test(s) && s.includes('❯ ') }, // #38802 자기 리뷰 mustFix — 화면 어디에나 있는 문장 대신 대화 행 `> queued second` 제출 + 큐 표시 소멸을 확인한다 (#38392 영어 크롬)
      ],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('Ctrl+Up pulls a busy turn queue entry into the editable composer', async () => {
  const run = await runQueueKeys('recall');
  expect(/대기 1|1 queued|1 steer pending/.test(run.frames[1]?.screen ?? '')).toBe(true);
  expect(run.frames[2]?.screen).toContain('❯ queued second');
  expect(/응답 중|running/.test(run.frames[2]?.screen ?? '')).toBe(true);
  expect(run.exitCode).toBe(0);
}, 30_000);

test('empty Enter interrupts an idle model reply and sends the queued entry now', async () => {
  const run = await runQueueKeys('push');
  const elapsedMs = Date.parse(run.frames[2]!.at) - Date.parse(run.frames[1]!.at);
  // 출처: .rules/30-harness/testing-gates.md R-TST36 — 이 PTY 장치의 fake 응답 지연 8000ms보다 먼저 끝나야 한다.
  expect(elapsedMs).toBeLessThan(8_000);
  expect(/^> queued second\s*$/m.test(run.frames[2]?.screen ?? '')).toBe(true); // #38802 자기 리뷰 mustFix — 대기 항목이 대화 행 `> queued second`로 제출됨 (#38392)
  expect(/(?:대기\s*[1-9]|[1-9]+\s*(?:queued|steer pending))/.test(run.frames[2]?.screen ?? '')).toBe(false); // 제출 뒤 큐 표시는 지워진다
  expect(run.exitCode).toBe(0);
}, 30_000);
