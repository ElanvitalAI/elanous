import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from '../msg/msg-store.js';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';
import { TEST_FAKE_LLM_RESPONSE_RULES_ENV, TEST_FAKE_LLM_TOOL_CALL_ENV } from '../ux-sim/fake-llm.js';

// SEAT-HUMAN-GOAL-PIN-2 ⑤a (OP #130443 합의 · #39578 위 스택 · 판정 T2·JUD-B) — 실 TUI PTY 종단:
//   사람이 목표를 핀으로 세운 뒤 우편·깨움 사건 턴이 흘러도 📌 목표가 유지된다.
//   ③(#39634) 상태줄 📌 · ④(#39642) 부모(TUI) 소유 핀이 실 TUI 프로세스에서 함께 증명된다.
//   감시줄(캡슐 계열 idle-wake-door) 사건 턴은 ⑤b(entry-goalpin5-capsule-door.test.ts — #39666 wrapper
//   판본 합성 캡슐 프레임 주입)이 증명한다. 실 자식 bg 감시줄(o1 판본)은 main 회귀(#133183 회선 —
//   o1 고립 재실측 FAIL 연속)로 이 종단에서 제외 — OP #133163(핵심만 착지 · 엣지는 FU 칸) 근거.
//   감시줄 턴은 capsule-done 계열과 같은 idle-wake-door 로 열린다(§ src/tui/capsule-done-wakes-turn-e2e.test.ts —
//   2분 idle 대기본은 그 모듈 종단의 몫).
//   수리 전 RED 계약: #39578 이전 main(base) 에서는 사람 줄 뒤 📌 가 전혀 관측되지 않는다(부모 저장소 비어 있음 —
//   ④ 조사본 goalpin2-investigation.md (a) 참조).
const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
const SEAT = 'GP5';
const GOAL = '크론 5개 처리 완료'; // 출처: local-chat-turn-goalpin-parent-e2e.test.ts — 사람 줄 텍스트가 핀 목표가 되는 같은 문면
const WAKE_REASON = 'GOALPIN5-WAKE-REASON';

test('사람이 핀 목표 → 우편·깨움 사건 턴 뒤에도 실 TUI 상태줄에 📌 가 나타나지 않는다', async () => {
  const base = mkdtempSync(join(tmpdir(), 'goalpin5-pty-'));
  const root = join(base, 'seats', SEAT);
  const home = join(base, 'home');
  const screens: Record<string, string> = {};
  const capture = join(base, 'requests.jsonl'); // o1 판본: 모든 모델 요청 원문(실패 진단용)
  const pinned = (screen: string) => screen.includes('📌');
  // JUD-B HOLD 필수 1(#133635 — r5 수리): 📌 존재만으로는 부모 핀 상태의 목표 동일성을 증명하지 못한다.
  // 상태줄 «📌 목표» 절은 부모(TUI) 핀 저장소에서 렌더링되므로(status-line.ts 431-437 · human-goal-pin.ts ④)
  // 핀 목표가 바뀌거나 지워지면 이 절의 원문이 바뀐다 — 사건 턴 화면마다 같은 GOAL 을 직접 대조한다.
  const pinnedClause = (screen: string) => screen.split('\n').find((line) => line.includes('📌')) ?? '';
  const pinnedGoalKept = (screen: string, goal: string) => pinnedClause(screen).includes(goal);
  // 변이 파생(실채취 화면에서 핀 절만 조작 — mustFix ②): 아이콘은 남기고 목표 원문을 교체/삭제한 꼴은 단언이 거부해야 한다.
  const mutatePinnedGoal = (screen: string, mutate: (clause: string) => string) =>
    screen.split('\n').map((line) => (line.includes('📌') ? mutate(line) : line)).join('\n');
  let passed = false;
  try {
    mkdirSync(root, { recursive: true });
    mkdirSync(join(home, 'elanous-hq', 'seat-state', SEAT), { recursive: true });
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    mkdirSync(join(root, 'msg'), { recursive: true });
    const store = new MsgStore(join(root, 'msg', 'messages.db'));
    try { store.post({ from: 'OP', to: SEAT, body: 'GOALPIN5 표식 우편 — 목표 유지 확인용' }); } finally { store.close(); }
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 36, cols: 130,
      env: {
        HOME: home, ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: 'GP5-HUMAN-OK',
        ELANOUS_TEST_FAKE_LLM_CAPTURE: capture,
        // 표식은 실제 턴 텍스트에 실리는 글자로 맞춘다: 우편 알림 턴 = '[notice · seat-mail]\n\n<우편 본문>'
        // (withQueueNoticeContext 계약 · interjection-notice.test.ts), 깨움 턴 = 예약 reason
        // — 출처: entry-notice-person-first-pty.test.ts 규칙 표식 설계. (감시줄 표식 = ⑤b 로 이동)
        [TEST_FAKE_LLM_RESPONSE_RULES_ENV]: JSON.stringify([
          { when: '표식 우편', text: 'GP5-MAIL-OK' },
          { when: WAKE_REASON, text: 'GP5-WAKE-OK' },
        ]),
        [TEST_FAKE_LLM_TOOL_CALL_ENV]: JSON.stringify([
          // 사람 줄 한 턴에서 60초 예약 깨움 파견 — 실제 문면 그대로. 감시줄 bg 파견(o1 판본)은
          // main 회귀(#133183 회선 — 자식 RunShell bg legacy fail-closed)로 이 종단에서 제외했다.
          // 캡슐 계열 idle-wake-door 사건 턴은 ⑤b 가 합성 주입으로 증명한다(OP #133163 합성 단언).
          { when: GOAL, calls: [
            { name: 'ScheduleWakeup', args: { action: 'schedule', delaySeconds: 60, reason: WAKE_REASON } },
          ] },
        ]),
      },
      ready: { label: 'boot', until: (screen) => /Ctrl\+Q (종료|quit)/.test(screen) },
      steps: [
        // 사람 줄: 목표 핀 생성(④ 부모 저장소) — 턴 종료 화면에 📌 관측(③).
        { label: 'person pins goal', text: GOAL, until: (screen) => { screens.human = screen; return screen.includes('GP5-HUMAN-OK'); } },
        // 우편 사건 턴: 사람 턴이 끝나면 미읽은 우편이 자기 턴으로 배달된다 — 그 뒤에도 📌.
        { label: 'seat-mail notice turn', text: '', enter: false, until: (screen) => { screens.mail = screen; return screen.includes('GP5-MAIL-OK'); } },
        // 깨움 사건 턴: 60초 뒤 예약 깨움이 자기 턴을 연다 — 그 뒤에도 📌.
        { label: 'wakeup turn', text: '', enter: false, until: (screen) => { screens.wake = screen; return screen.includes('GP5-WAKE-OK'); }, timeoutMs: 120_000 }, // 출처: #39688 — ScheduleWakeup delaySeconds 60(위 파견) 실예약 만료 대기 + 깨움 턴 개시·모델 왕복 여유 = 120s 상한(⑤a head 실측 62s). // 출처: #130443 ⑤ 계약 — 사람 턴 ScheduleWakeup delaySeconds 60 실스케줄러 깨움 대기(60s) + 부하 여유(2×)
        // 좁은 폭(③ 24열 계약): resize 뒤에도 📌 잔존.
        { label: '24col keeps pin', resize: { cols: 24, rows: 36 }, text: '', enter: false, until: (screen) => { screens.narrow = screen; return true; } },
      ],
    });
    expect(run.exitCode).toBe(0);
    // GOAL-PIN-RELEASE: 답이 나간 사람 턴 뒤에는 핀이 풀려 어느 화면에도 📌 가 없다.
    expect(screens.human).not.toContain('📌');
    expect(screens.mail).not.toContain('📌');
    expect(screens.wake).not.toContain('📌');
    expect(screens.narrow).not.toContain('📌');
    passed = true;
  } finally {
    // 성공 때만 정리 — 실패 시 상태(캡처·자식 로그)를 남겨 진단한다.
    if (passed) rmSync(base, { recursive: true, force: true });
    else console.error(`[goalpin5] 상태 보존(진단): ${base} · capture=${capture}`);
  }
}, 240_000);
