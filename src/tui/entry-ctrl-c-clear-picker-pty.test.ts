import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

// TUI-CTRLC-CLEAR-PICKER-CLEANUP-FU · REVIEW-2 #131196 / OP #131201 (2026-11-22, #39550 MERGED 뒤 FU):
// idle Ctrl+C clear-input이 공통 취소 경로(submit/cancel·entry.ts applyKey 뒤 atFileInput.close() ⊕
// slashPicker=null ⊕ slashNavigated=false)와 같은 팝업 정리를 건너뛴다 — 글이 있을 때 첫 Ctrl+C가 지운
// 텍스트가 띄운 / ·@ 팝업과 탐색 상태(slashNavigated)가 살아남아, 다음 Tab/Enter가 «이미 취소한» 이전
// 후보를 발화할 수 있다. 이 회귀는 계약을 실화면 PTY로 고정한다:
//   1) '/' 입력 — / 커맨드 팝업이 열린다(패널 제목 '/ Commands').
//   2) ↑ — 후보 탐색 상태가 선다(slashNavigated).
//   3) 글 있는 상태 Ctrl+C = clear-input — 작성 행이 비고, «팝업도 함께 닫혀야 한다».
//   4) 그 뒤 Enter — 닫힌 팝업의 이전 후보가 발화되지 않는다(패널 부재 = 발화 경로 차단).
// 기대값은 제품 상수가 아니라 화면 리터럴('/ Commands' 패널 제목)과 정규식이다(OP 규칙 11).
// 경계 단언(모형이 운영보다 관대하지 않다): 드라이버 capture는 스텝 조건이 충족되기 전까지 throw하므로
// — 옛 결함 코드에서는 «cleared» 조건(패널 소멸)이 영원히 충족되지 않아 이 시험은 RED다.
const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
// 패널 제목 — 화면 리터럴(제품 렌더 함수와 독립적으로 화면에서 읽은 문자열).
const PICKER_PANEL = '/ Commands';

async function clearPickerRun(
  steps: Parameters<typeof mockSeatPtySequence>[0]['steps'],
  { rows, cols }: { rows: number; cols: number },
) {
  const root = mkdtempSync(join(tmpdir(), 'next-ctrl-c-picker-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    return {
      run: await mockSeatPtySequence({
        executable: process.execPath,
        args: [BIN, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
        root, rows, cols,
        env: {
          ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
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

test('clear-input closes the popups its text opened: / picker + ↑ navigation → Ctrl+C clears the row and the panel must close with it', async () => {
  const { run, root } = await clearPickerRun([
    // 1) '/' 입력(Enter 없음) — / 커맨드 팝업이 열린다.
    { label: 'open', text: '/', enter: false, until: (screen) => screen.includes(PICKER_PANEL) },
    // 2) ↑ 탐색 — 후보 선택이 움직이고 탐색 상태(slashNavigated)가 선다. 패널은 그대로 열려 있다.
    { label: 'navigated', keys: '\x1b[A', until: (screen) => screen.includes(PICKER_PANEL) },
    // 3) 글('/') 있는 상태 Ctrl+C = clear-input — 작성 행이 비는 것과 «같은 핸들러·같은 렌더»에서
    //    팝업도 닫혀야 한다. (RED-first: 옛 코드는 slashPicker를 남겨 이 조건이 충족되지 않아 타임아웃된다.)
    { label: 'cleared', chunks: ['\x03'], until: (screen) => !screen.includes(PICKER_PANEL) },
    // 4) 그 뒤 Enter — 닫힌 패널의 이전 후보가 발화되지 않는다(패널 부재가 발화 경로 차단의 화면 증거).
    { label: 'after-enter', keys: '\r', until: (screen) => !screen.includes(PICKER_PANEL) },
  ], { rows: 32, cols: 120 });
  const frame = (label: string) => run.frames.find((entry) => entry.label === label)?.screen ?? '';
  const opened = frame('open');
  const navigated = frame('navigated');
  const cleared = frame('cleared');
  const afterEnter = frame('after-enter');
  rmSync(root, { recursive: true, force: true });
  expect(run.exitCode).toBe(0); // 출처: #39550 FU — Ctrl+Q 정상 종료 exit 0: clear-input이 종료 아님(무장·패널 경로 격리) 증명
  // (1) '/' 로 팝업이 열렸다.
  expect(opened).toContain(PICKER_PANEL);
  // (2) ↑ 탐색 뒤에도 패널은 살아 있었다(탐색 상태가 성립한 화면 증거).
  expect(navigated).toContain(PICKER_PANEL);
  // (3) clear-input: 행이 비었고 패널도 같이 닫혔다 — 취소한 텍스트가 띄운 팝업이 살아남지 않는다.
  expect(cleared).not.toContain(PICKER_PANEL);
  // (4) 다음 Enter로 이전 후보가 발화되지 않았다.
  expect(afterEnter).not.toContain(PICKER_PANEL);
}, 90_000);
