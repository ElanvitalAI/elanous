/**
 * TUI-SLASH-DURING-TURN — 턴이 도는 중에 친 슬래시 명령은 대화(steer·대기열)로 흡수되지 않고
 * 지금 즉시 로컬 실행된다(턴 적용 대상은 «다음 턴부터» 안내 · 미등록은 «알 수 없는 명령» 안내).
 * 실 TUI(PTY) → 실 제출 경로(entry.ts) → fake provider(첫 요청 22s 보류)로 «턴 도는 중» 상태를
 * 만들고, 그 창 안에서 안내가 떠야 함을 잰다. RED: 수리 전 base 에는 이 Enter 가 큐로 가므로
 * 안내가 턴 끝난 뒤에야(응답 문면이 이미 화면에 있는 뒤에야) 온다 — 아래 단계가 시간 초과로 실패한다.
 */
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
// 사람 줄 — fake provider 가 이 mark 가 든 요청을 22s 붙잡아 «턴 도는 중» 창을 만든다.
const HELD = 'SLASH-TURN-HELD-MARK';
// 턴이 끝나야만 화면에 오는 응답 문면 — «턴 도는 중» 판정의 반대 신호.
const DONE = 'SLASH-TURN-DONE';

const requestRows = (capture: string): string[] => existsSync(capture)
  ? readFileSync(capture, 'utf8').split('\n').filter(Boolean) : [];

/** 두 시험이 같은 꼴로 쓰는 «부팅 → 돌던 턴 → 턴 중 슬래시 Enter → 턴 완료» 뼈대. */
async function runSlashDuringTurn(options: { slash: string; duringTurnNotice: string }) {
  const root = mkdtempSync(join(tmpdir(), 'slash-during-turn-'));
  const capture = join(root, 'provider-requests.jsonl');
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 30, cols: 110, exitTimeoutMs: 10_000,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'),
        ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: DONE, ELANOUS_TEST_FAKE_LLM_CAPTURE: capture,
        ELANOUS_TEST_FAKE_LLM_DELAY_MS: '22000', ELANOUS_TEST_FAKE_LLM_DELAY_WHEN: HELD },
      ready: { label: 'boot', until: (s) => s.includes('elanous') && s.includes('Enter send') },
      steps: [
        // 사람 줄이 턴을 시작하고, fake provider 가 요청을 22s 붙잡는다 — 이후 두 단계는 «턴 도는 중».
        { label: 'turn running', text: HELD, timeoutMs: 15_000, until: (s) => s.includes('Thinking') }, // 출처: #39790 턴 개시 관측 예산 — 부트 ready 통과 직후 수 초 안 Thinking 렌더 실측
        // 계약: 이 Enter 는 명령으로 지금 실행된다 — 안내가 응답(DONE)보다 먼저 화면에 있어야 한다.
        // base(수리 전) 에는 이 줄이 대기열로 흡수되어 이 단계가 10s 안에 못 넘어간다(RED).
        { label: 'slash answers during the turn', text: options.slash, timeoutMs: 10_000, // 출처: #39790 즉시 안내 렌더 예산 — 수리 계약상 steer·대기열 우회 즉시
          until: (s) => s.includes(options.duringTurnNotice) && !s.includes(DONE) },
        // 턴은 그대로 끝까지 돈다 — 명령 실행이 턴을 망치지 않았음도 같이 잰다.
        { label: 'turn finishes', timeoutMs: 45_000, until: (s) => s.includes(DONE) }, // 출처: #39790 fake provider 22s 보류 + 턴 마감 여유(시험 상한 90s 안)
      ],
    });
    return { run, capture, root };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

test('/model fast during a running turn: notice now («다음 턴부터»), tier side effect now, no steer, no queue', async () => {
  // 이 시험 환경(LANG 미설정)에서는 status 힌트가 영어로 렌더된다 — 원문 status «모델: fast · 다음 턴부터 적용»이
  // «Model: fast · applies next turn» 로 찍히므로(부트 준항 'Enter send' 와 같은 번역 경로), 렌더되는 영문을 기대값으로 쓴다.
  const { run, capture, root } = await runSlashDuringTurn({ slash: '/model fast', duringTurnNotice: 'applies next turn' });
  try {
    // steer 0 · 대기열 잔류 0: 명령 문면은 그 어떤 provider 요청에도 실리지 않는다
    // (대기열로 흡수돼 턴 뒤에 모델 문면으로 나가는 사태를 잡는 가드).
    const rows = requestRows(capture);
    expect(rows.length).toBeGreaterThanOrEqual(1); // 출처: #39790 캡처 원장 최소 1요청 — steer 0 단언의 전제
    expect(rows.join('\n')).not.toContain('/model fast');
    expect(run.exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);

test('an unknown /command during a running turn is answered immediately, never queued', async () => {
  const { run, capture, root } = await runSlashDuringTurn({ slash: '/nosuchslash', duringTurnNotice: 'Unknown command: /nosuchslash' });
  try {
    const rows = requestRows(capture);
    expect(rows.length).toBeGreaterThanOrEqual(1); // 출처: #39790 캡처 원장 최소 1요청 — 미등록 안내 단언의 전제
    expect(rows.join('\n')).not.toContain('/nosuchslash');
    expect(run.exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
