import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

// JUD-B REVIEW-2 T1 HOLD · OP #130576 중계 (2026-11-22): #39550 mustFix — the empty-input Ctrl+C arm
// (this PR, #22868) promises «한 번 더 누르면 나갑니다» while armed. Typing text disarms the arm
// (resolver: clear-input · armedAt=null · hint=null), but the handler kept the old status line — the
// exit hint outlived its arm: the next Ctrl+C re-arms (it cannot exit) while the screen still promised
// exit. This regression pins the #22868 hint-expiry contract end to end on the real TUI:
//   1) empty-input Ctrl+C arms → the hint is on screen.
//   2) typing text (no Enter) lands in the composer row.
//   3) Ctrl+C with text = clear-input: the composer row is emptied AND the hint retires with the arm
//      (the status slot returns to its default — the footer shows «Turn idle» again; that return is
//      the retirement made visible) — a hint may never outlive the promise it made.
//   4) the disarm reset the arm state: the next empty-input Ctrl+C re-arms (hint back), it does NOT
//      exit — the run then quits cleanly via Ctrl+Q (exit 0), proving nothing exited early.
// 기대값은 제품 상수·렌더 함수와 독립인 리터럴·정규식이다(OP 규칙 11 — 시험 기대값은 제품과 독립).
// 경계 단언(모형이 운영보다 관대하지 않다): 드라이버 capture는 스텝 조건이 충족되기 전까지 throw하므로
// — 옛 결함 코드에서는 «cleared» 조건(기본 상태 복귀 ⊕ 안내 소멸)이 영원히 충족되지 않아 이 시험은 RED다.
const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
const HINT = '한 번 더 누르면 나갑니다 · /quit';
// 기본 상태의 화면 표현 — status 변수는 footer 턴 슬롯에 흐르고(entry.ts rawTurnStatus),
// 기본('Enter 전송 · Esc 취소 · Ctrl+Q 종료')은 «Turn idle» 로 표시된다. 그 문자 자체는 기대값이 아니다.
const DEFAULT_TURN = 'Turn idle';
// #39550 r4 · REVIEW-2 #130694(OP #130692) «상태 보존» — 다른 안내의 화면 표현(독립 리터럴 정규식).
// Esc 취소가 status 슬롯에 세우는 «입력 취소됨 · Enter 전송 · Ctrl+Q 종료» 를 화면 그대로 잡는다
// (footer 영문 변역 «Input cancelled» · 한·영 둘 다 — #38144 와 같은 이유).
const CANCEL_GUIDANCE = /입력 취소됨|Input cancelled/;

async function disarmHintRun(
  steps: Parameters<typeof mockSeatPtySequence>[0]['steps'],
  { rows, cols }: { rows: number; cols: number },
) {
  const root = mkdtempSync(join(tmpdir(), 'next-ctrl-c-disarm-'));
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

test('disarm retires the exit hint: arm → type → Ctrl+C empties the row and restores the default status, the next Ctrl+C re-arms (not exit)', async () => {
  const { run, root } = await disarmHintRun([
    // 1) 빈 입력 Ctrl+C = 무장 — 안내가 화면에 오른다.
    { label: 'armed', chunks: ['\x03'], until: (screen) => screen.includes(HINT) },
    // 2) 글자를 입력(Enter 없음) — 텍스트가 작성 행에 착지한다.
    { label: 'typed', text: 'CC-잔류', enter: false, until: (screen) => screen.includes('CC-잔류') },
    // 3) 글자 있는 상태 Ctrl+C = clear-input — 행 청소 ⊕ 안내가 무장과 함께 소멸 ⊕ 기본 상태 복귀.
    //    (RED-first: 옛 코드는 안내가 잔존하므로 이 조건이 충족되지 않아 스텝이 타임아웃된다.)
    { label: 'cleared', chunks: ['\x03'], until: (screen) => screen.includes(DEFAULT_TURN) && !screen.includes(HINT) },
    // 4) 무장 해제 상태의 다음 Ctrl+C = 재무장(안내 복귀) — 종료가 아님을 화면으로 증명.
    { label: 'rearmed', chunks: ['\x03'], until: (screen) => screen.includes(HINT) },
  ], { rows: 32, cols: 120 });
  const frame = (label: string) => run.frames.find((entry) => entry.label === label)?.screen ?? '';
  const armed = frame('armed');
  const typed = frame('typed');
  const cleared = frame('cleared');
  const rearmed = frame('rearmed');
  rmSync(root, { recursive: true, force: true });
  expect(run.exitCode).toBe(0); // 출처: #39550 — Ctrl+Q 정상 종료 exit 0: 무장 해제 뒤 빈 입력 Ctrl+C가 종료가 아님(재무장)을 증명, 잘못된 조기 종료 탐지 용도
  // (1) 무장: 안내가 화면에 있었다.
  expect(armed).toContain(HINT);
  // (2) 입력: 텍스트가 작성 행에 있었다.
  expect(typed).toContain('CC-잔류');
  // (3) clear-input: 행이 비었고, 안내는 무장과 함께 소멸했으며, 기본 상태가 돌아왔다.
  expect(cleared).not.toContain('CC-잔류');
  expect(cleared).not.toContain(HINT);
  expect(cleared).toContain(DEFAULT_TURN);
  // (4) 재무장: armedAt가 해제 때 초기화됐다는 증명 — 다음 Ctrl+C는 종료가 아니라 무장이다(종료 0은 Ctrl+Q).
  expect(rearmed).toContain(HINT);
}, 90_000);

// #39550 r4 · REVIEW-2 #130694(OP #130692) mustFix «상태 보존» — #22868 «다른 키 사이엔 아무것도 안 함» 위반.
// 결함: (a) arm 만료 타이머가 footer status 슬롯을 무조건 기본값으로 덮어썼다 — arm 안내 뒤 다른 안내/상태가
// 세워져 있으면 만료(~2.05s) 때 그 안내가 지워졌다. (b) clear-input 경로(글 있을 때 첫 Ctrl+C)도 armed 여부와
// 무관하게 status를 무조건 덮었다. 계약: 두 경로 모두 «자기가 띄운 종료 안내일 때만» 지우고, 다른 안내는 보존한다.
// 기대값은 제품 상수·렌더 함수와 독립인 리터럴·정규식이다(OP 규칙 11).
test('arm-expiry preserves a status another key raised: arm → Esc raises «입력 취소됨» → expiry(~2.1s) must not wipe it', async () => {
  // esc 안내가 화면에 뜬 순간부터 잰다 — 그때부터 2.6s 뒤에는 arm 만료 타이머(무장+2.05s)가 반드시 발사한 뒤다.
  let cancelSeenAt = 0;
  const { run, root } = await disarmHintRun([
    // 1) 빈 입력 Ctrl+C = 무장 — 안내가 화면에 오른다.
    { label: 'armed2', chunks: ['\x03'], until: (screen) => screen.includes(HINT) },
    // 2) 글을 넣고 Esc — 작성 행이 지워지며 «입력 취소됨» 안내가 status 슬롯에 선다(arm 만료 전에 세워야 하는 다른 안내).
    //    (RED-first: 옛 코드는 만료 타이머가 이 안내를 기본값으로 덮어쓴다 — 만료 뒤 «입력 취소됨»이 사라져 3)이 충족되지 않는다.)
    { label: 'typed2', text: 'CC-보존', enter: false, until: (screen) => screen.includes('CC-보존') },
    { label: 'esc-canceled', chunks: ['\x1b'], until: (screen) => {
      const landed = CANCEL_GUIDANCE.test(screen) && !screen.includes('CC-보존');
      if (landed && cancelSeenAt === 0) cancelSeenAt = Date.now();
      return landed;
    } },
    // 3) 만료 타이머 발사 뒤에도 «입력 취소됨»이 살아 있는 프레임을 잡는다.
    //    출처: #39550 대기 2.6s = arm 만료(CTRL_C_ARM_MS 2.0s + 타이머 여유 0.05s)가 esc 착지 후 반드시 지나간 시간
    { label: 'after-expiry', timeoutMs: 30_000, until: (screen) => cancelSeenAt > 0 && Date.now() - cancelSeenAt >= 2_600 && CANCEL_GUIDANCE.test(screen) },
  ], { rows: 32, cols: 120 });
  const frame = (label: string) => run.frames.find((entry) => entry.label === label)?.screen ?? '';
  const afterExpiry = frame('after-expiry');
  rmSync(root, { recursive: true, force: true });
  expect(run.exitCode).toBe(0); // 출처: #39550 — 잘못된 조기 종료 없이 Ctrl+Q 정상 종료
  // 만료 타이머가 «자기» 안내만 지웠는가 — 다른 키가 세운 «입력 취소됨»은 살아 있다.
  expect(CANCEL_GUIDANCE.test(afterExpiry)).toBe(true);
}, 120_000);

test('clear-input preserves a status another key raised: type → Esc cancels → retype → Ctrl+C clears the row, must not wipe «입력 취소됨»', async () => {
  const { run, root } = await disarmHintRun([
    // 1) 글을 넣고 Esc — 작성 행이 지워지며 «입력 취소됨» 안내가 status 슬롯에 선다.
    { label: 'typed3', text: 'CC-보존2', enter: false, until: (screen) => screen.includes('CC-보존2') },
    { label: 'esc3-canceled', chunks: ['\x1b'], until: (screen) => CANCEL_GUIDANCE.test(screen) && !screen.includes('CC-보존2') },
    // 2) 다시 글을 넣는다 — 타이핑(edit)은 status 슬롯을 바꾸지 않으므로 «입력 취소됨»은 그대로다.
    { label: 'retyped3', text: 'CC-보존3', enter: false, until: (screen) => screen.includes('CC-보존3') && CANCEL_GUIDANCE.test(screen) },
    // 3) 글 있는 상태 Ctrl+C = clear-input — 행 청소와 status 덮기가 같은 핸들러·같은 렌더에 일어난다.
    //    (RED-first: 옛 코드는 이 경로가 «입력 취소됨»을 기본값으로 무조건 덮어써 이 조건이 충족되지 않는다.)
    { label: 'ctrlc3-clear', chunks: ['\x03'], until: (screen) => !screen.includes('CC-보존3') && CANCEL_GUIDANCE.test(screen) },
  ], { rows: 32, cols: 120 });
  const frame = (label: string) => run.frames.find((entry) => entry.label === label)?.screen ?? '';
  const ctrlcClear = frame('ctrlc3-clear');
  rmSync(root, { recursive: true, force: true });
  expect(run.exitCode).toBe(0); // 출처: #39550 — 잘못된 조기 종료 없이 Ctrl+Q 정상 종료
  // clear-input이 지운 것은 행뿐인가 — Esc 가 세운 «입력 취소됨»은 살아 있다.
  expect(ctrlcClear.includes('CC-보존3')).toBe(false);
  expect(CANCEL_GUIDANCE.test(ctrlcClear)).toBe(true);
}, 90_000);