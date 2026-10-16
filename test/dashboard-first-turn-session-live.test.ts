import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDashboardForExit } from '../src/dashboard/index.js';
import { drawDashboardTurnTypeaheadPromptRows } from '../src/dashboard/index.js';
import { createTurnSubmitFromIntent } from '../src/input/turn-submit.js';
import { adoptSession, getActiveSessionId, listSessions, setActiveSessionId } from '../src/session/index.js';
import { startPinnedThinking } from '../src/thinking-line.js';
import { simHeadlessDashboardFrames, type HeadlessDashboardFrame } from '../src/ux-sim/headless-tui.js';
import { simTypeaheadState } from '../src/ux-sim/turn-states.js';

// ── 첫 턴 세션 계약 — 장치판 (OP #6509·#6513) ─────────────────────────────────
//  종전 이 파일은 실물 TUI(PTY ⊕ 로컬 SSE)를 띄워 «첫 턴이 세션 하나를 만들고 submit·turn 이 그 세션에
//  묶이며 원장에 등록·active 가 되고 /quit 안내가 그 id 를 싣는다»를 쟀다. 게이트 env(XDG_CONFIG_HOME)에서
//  설정 폴더를 잘못 읽어 LLM 선택 화면에 갇혀 60초 시간초과로 죽었다(preexisting · NOTE-mock-tui-two).
//  ⇒ 계약을 이루는 «진짜» 조각을 같은 프로세스에서 문다 — 격리 ELANOUS_STATE_DIR 위의
//  `createTurnSubmitFromIntent`(귀속) · `adoptSession`/`setActiveSessionId`(대시보드 턴 완료 뒤 등록과 같은 호출) ·
//  `closeDashboardForExit`(종료 안내) · `simHeadlessDashboardFrames`(첫 턴 화면).
//  ⚠️ 대시보드 클로저의 배선(턴 완료 → currentSessionId → 등록)과 logs.db 행 귀속은 장치 밖이다 —
//  그 끝-끝 계약은 실물 1건(`scripts/lib/tui-streaming-e2e.test.ts` · spawn 레인)이 문다.
const SESSION = 'elanous-session-7';
let root = '';
let savedStateDir: string | undefined;
let savedSessionRoot: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'elanous-first-turn-sim-'));
  savedStateDir = process.env.ELANOUS_STATE_DIR;
  savedSessionRoot = process.env.ELANOUS_SESSION_ROOT;
  process.env.ELANOUS_STATE_DIR = join(root, 'state');
  delete process.env.ELANOUS_SESSION_ROOT;
});

afterEach(() => {
  if (savedStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = savedStateDir;
  if (savedSessionRoot === undefined) delete process.env.ELANOUS_SESSION_ROOT;
  else process.env.ELANOUS_SESSION_ROOT = savedSessionRoot;
  rmSync(root, { recursive: true, force: true });
});

const intent = (text: string, sessionId?: string) => ({
  kind: 'submit-turn' as const,
  source: { kind: 'keyboard' as const, surface: 'dashboard-chat-main' },
  text,
  route: 'plain' as const,
  ...(sessionId ? { sessionId } : {}),
});

/** 대시보드가 첫 턴 완료 뒤 부르는 등록(adopt → active) — 같은 함수·같은 인자. */
function registerCompletedTurn(sessionId: string): void {
  adoptSession(sessionId, { source: 'tui', transport: 'acp' });
  setActiveSessionId(sessionId);
}

describe('first TUI turn session (in-process devices)', () => {
  test('an isolated universe starts with no session and attributes nothing before the first turn', () => {
    expect(getActiveSessionId()).toBeNull();
    expect(listSessions()).toEqual([]);
    expect(createTurnSubmitFromIntent(intent('안녕')).sessionId).toBeUndefined();
  });

  test('first turn registers exactly one session, makes it active, and later submits fall back to it', () => {
    // 첫 submit 은 ACP 가 민팅한 currentSessionId 를 명시로 싣는다.
    const first = createTurnSubmitFromIntent(intent('안녕', SESSION));
    expect(first.sessionId).toBe(SESSION);
    registerCompletedTurn(SESSION);
    registerCompletedTurn(SESSION); // 멱등 — 같은 세션은 한 번만 등록된다

    const state = process.env.ELANOUS_STATE_DIR!;
    expect(existsSync(join(state, 'sessions', `${SESSION}.jsonl`))).toBe(true);
    expect(readFileSync(join(state, 'elanous', 'active'), 'utf8').trim()).toBe(SESSION);
    expect(getActiveSessionId()).toBe(SESSION);
    expect(listSessions().map((session) => session.id)).toEqual([SESSION]);
    // 명시 id 가 없는 다음 submit 도 같은 세션에 묶인다(active 포인터 폴백).
    expect(createTurnSubmitFromIntent(intent('둘째')).sessionId).toBe(SESSION);
  });

  test('/quit guidance names the first-turn session and warns only when none was recorded', () => {
    registerCompletedTurn(SESSION);
    const named: string[] = [];
    closeDashboardForExit({ closeTui: () => {}, getSessionId: () => getActiveSessionId() ?? undefined, write: (m) => named.push(m), forceQuit: true });
    expect(named.join('')).toContain('[session]');
    expect(named.join('')).toContain(SESSION);
    expect(named.join('')).not.toContain('기록하지 못했');

    const missing: string[] = [];
    closeDashboardForExit({ closeTui: () => {}, getSessionId: () => undefined, write: (m) => missing.push(m), forceQuit: true });
    expect(missing.join('')).toContain('기록하지 못했');
  });

  test('first turn screen: empty composer → echoed prompt and streamed answer → empty composer again', async () => {
    const rows = 12;
    const cols = 80;
    const frame = (log: string[], turnLine: string | null): HeadlessDashboardFrame => {
      let caret: { row: number; col: number; visible: boolean } | null = null;
      const prompt = drawDashboardTurnTypeaheadPromptRows({
        frame: { inputHeight: 1, promptTopRow: rows, promptBottomRow: rows, topDividerRow: rows - 1, bottomDividerRow: rows },
        height: 1, placeholder: '❯ ', prompt: '❯ ', state: simTypeaheadState({ phase: turnLine ? 'streaming' : 'idle' }), width: cols,
      }, (paint) => { caret = paint.caret; });
      const body = rows - 3;
      const tail = log.slice(-body);
      return {
        lines: [...tail, ...Array.from({ length: body - tail.length }, () => ''), turnLine ?? '', '─'.repeat(cols), ...prompt],
        input: { overlay: '', force: false, cursorOwner: 'none', claimedCursor: null, promptCaret: caret, suppressPromptArea: false },
      };
    };
    const target: { current: string | null } = { current: null };
    const thinking = startPinnedThinking({ target, onFrame: () => {}, message: 'Streaming', intervalMs: 0, metrics: { startedAt: Date.now() - 1_000, hint: 'esc 중단' } });
    const streaming = target.current ?? '';
    thinking.stop();
    const done = target.current ?? '';
    const [boot, turn, after] = await simHeadlessDashboardFrames([
      frame([], null),
      frame(['', '❯ 안녕', '안녕!'], streaming),
      frame(['', '❯ 안녕', '안녕!', done], null),
    ], { rows, cols });
    const emptyComposer = (lines: readonly string[]) => lines.some((line) => line.trim() === '❯');
    expect(emptyComposer(boot!.lines)).toBe(true);
    expect(turn!.lines.join('\n')).toContain('esc 중단');
    expect(emptyComposer(turn!.lines)).toBe(true);
    expect(after!.lines.join('\n')).toContain('✔ 완료');
    expect(after!.lines.join('\n')).not.toContain('Streaming…');
    expect(after!.lines.filter((line) => line.includes('❯ 안녕'))).toHaveLength(1);
    expect(emptyComposer(after!.lines)).toBe(true);
    expect(after!.cursor).toEqual({ row: rows, col: '❯ '.length + 1 });
  });
});
