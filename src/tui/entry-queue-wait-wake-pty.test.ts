import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';
import { TEST_FAKE_LLM_DELAY_MS_ENV, TEST_FAKE_LLM_DELAY_WHEN_ENV } from '../ux-sim/fake-llm.js';

// JUD-C #129060 HOLD · OP #129068 결정 (2026-11-22): ELS-QUEUE-WAIT-DISPLAY 착지 #39556의 기존 PTY 시험은
// Esc 중단(interrupt) 경로만 증명했다 — 정상 턴 종료 뒤 대기 발화 FIFO 소비는 src/tui/core/queue.ts:424-446의
// 별도 wake 분기(settle → {kind:'wake'} → entry injectKey(queueWake))를 지나므로 그 시험만으로는 입증되지 않는다.
// 이 시험은 그 종단을 증명한다:
//   1) SLOW 턴 진행 중 3줄을 입력 → 기본 화면에 대기 행(원문 · 나: · 대기 i/n)이 즉시 보인다.
//   2) **Esc를 전혀 누르지 않는다** — SLOW 턴이 스스로 끝나고 응답 QW-SLOW-DONE이 화면에 착지한다(정상 종료의 증명.
//      Esc 중단 경로였다면 이 응답은 취소되어 보이지 않는다 — 기존 시험 4건이 전부 이 대조군이었다).
//   3) 정상 종료의 wake가 큐를 깨워 대기 3줄이 고유 응답(ANS-A/ANS-B/ANS-C)으로 FIFO · 각 1회 소비된다.
//   4) 소비가 끝나면 대기 표식(대기 i/n · 외 N건)은 화면에서 사라진다.
// 기대값은 제품 상수·렌더 함수와 독립인 리터럴·정규식이다(OP 규칙 11 — 시험 기대값은 제품과 독립).
const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
const SLOW = 'QW-SLOW';
// 15s: 길어야 «자연 종료»를 기다릴 수 있다 — 120s 지연은 스텝 타임아웃(60s)·시험 타임아웃(90s)보다 길어
// 반드시 타임아웃된다. 3줄 입력(~1s)을 하기에 충분하고, 15s 뒤 턴이 스스로 끝나 wake 경로가 지나진다.
const SLOW_MS = '15000';
const running = (screen: string) => /Turn running|● running|응답 중|esc to interrupt/.test(screen);
const promptRow = (screen: string) => screen.split('\n').filter((row) => row.trimStart().startsWith('❯')).at(-1) ?? '';

// 고유 응답 rules: QW-A→ANS-A, QW-B→ANS-B, QW-C→ANS-C — 같은 응답 카운터로는 A,A와 A,B를 가릴 수 없다(#39556 r2 ①).
const RULES = JSON.stringify([
  { when: SLOW, text: 'QW-SLOW-DONE' },
  { when: 'QW-A', text: 'ANS-A' },
  { when: 'QW-B', text: 'ANS-B' },
  { when: 'QW-C', text: 'ANS-C' },
]);

async function waitWakeRun(
  steps: Parameters<typeof mockSeatPtySequence>[0]['steps'],
  { rows, cols }: { rows: number; cols: number },
) {
  const root = mkdtempSync(join(tmpdir(), 'next-queue-wait-wake-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    return {
      run: await mockSeatPtySequence({
        executable: process.execPath,
        args: [BIN, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
        root, rows, cols,
        env: {
          ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
          [TEST_FAKE_LLM_DELAY_MS_ENV]: SLOW_MS, [TEST_FAKE_LLM_DELAY_WHEN_ENV]: SLOW,
          ELANOUS_TEST_FAKE_LLM_RESPONSE_RULES: RULES,
        },
        ready: { label: 'boot', until: (screen) => /Ctrl\+Q (종료|quit)/.test(screen) },
        steps,
      }),
      root,
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

test('normal turn end wakes the queue: no Esc — SLOW finishes on its own (QW-SLOW-DONE lands), waiting 3 lines drain FIFO once each, marks clear', async () => {
  const { run, root } = await waitWakeRun([
    { label: 'slow', text: `${SLOW} 시작`, until: running },
    { label: 'three waiting', chunks: ['QW-A 첫째 대기', '\r', 'QW-B 둘째 대기', '\r', 'QW-C 셋째 대기', '\r'], gapMs: 150,
      until: (screen) => screen.includes('대기 1/3 · 나: QW-A 첫째 대기') && screen.includes('대기 2/3 · 나: QW-B 둘째 대기') && screen.includes('대기 3/3 · 나: QW-C 셋째 대기') },
    // ★ 이 시험의 핵심: 여기서 Esc를 누르지 않는다. 스텝은 아무 키도 보내지 않고 화면만 기다린다 —
    // SLOW 턴이 delay를 다 채우고 스스로 끝나며 응답이 착지하는 정상 종료 경로(settle → wake)를 지나게 한다.
    { label: 'slow settled', until: (screen) => screen.includes('QW-SLOW-DONE') },
    // wake가 큐를 깨운 뒤: A → B → C 순서(FIFO)로 각 1회 응답, 대기 표식은 사라진다.
    { label: 'drained', until: (screen) => (screen.split('ANS-A').length - 1) >= 1 && (screen.split('ANS-B').length - 1) >= 1 && (screen.split('ANS-C').length - 1) >= 1 },
  ], { rows: 32, cols: 120 });
  const frame = (label: string) => run.frames.find((entry) => entry.label === label)?.screen ?? '';
  const waiting = frame('three waiting');
  const settled = frame('slow settled');
  const drained = frame('drained');
  rmSync(root, { recursive: true, force: true });
  expect(run.exitCode).toBe(0);
  // (1) 턴 진행 중: 대기 행 3줄이 원문·정체성·표식과 함께 보였다.
  expect(waiting).toContain('대기 1/3 · 나: QW-A 첫째 대기');
  expect(waiting).toContain('대기 3/3 · 나: QW-C 셋째 대기');
  // (2) 정상 종료 증명: 중단 없이 SLOW 응답이 착지했다(Esc 중단이었으면 취소되어 없다).
  expect(settled).toContain('QW-SLOW-DONE');
  // (3) FIFO · 각 1회: 고유 응답이 순서대로 정확히 한 번씩.
  expect(drained.split('ANS-A').length - 1).toBe(1);
  expect(drained.split('ANS-B').length - 1).toBe(1);
  expect(drained.split('ANS-C').length - 1).toBe(1);
  expect(drained.indexOf('ANS-A')).toBeLessThan(drained.indexOf('ANS-B'));
  expect(drained.indexOf('ANS-B')).toBeLessThan(drained.indexOf('ANS-C'));
  // (4) 소비 완료: 대기 표식은 화면에서 사라졌다.
  expect(drained).not.toMatch(/대기 \d\/\d/);
  expect(drained).not.toContain('대기 외 ');
}, 90_000);
