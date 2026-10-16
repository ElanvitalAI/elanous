import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyTurnTypeaheadKey, renderTurnTypeaheadQueueRow, type TurnTypeaheadState } from '../src/chat/turn-typeahead.js';
import { drawDashboardTurnTypeaheadPromptRows } from '../src/dashboard/index.js';
import {
  handoffTurnTypeaheadAtTurnEnd,
  steerLastTurnTypeaheadSubmission,
  type TurnTypeaheadRef,
} from '../src/dashboard/input/turn-steer-bridge.js';
import { clearPendingUserInput, drainPendingUserInput, pendingUserInputCount } from '../src/session/pending-input.js';
import { startPinnedThinking } from '../src/thinking-line.js';
import { wrapAnsiByWidth } from '../src/tui.js';
import { simHeadlessDashboardFrames, type HeadlessDashboardFrame } from '../src/ux-sim/headless-tui.js';
import { simTypeaheadState } from '../src/ux-sim/turn-states.js';
import { installTypeaheadFixtures, startAimockLocal } from './ux-sim/aimock-local.js';
import { tuiSourceText } from './helpers/dashboard-source.js';

const dashboard = tuiSourceText();
// TUI-INPUT-PLACEHOLDER-OFF — 빈 입력창에 안내 문구가 없으므로 «❯» 만 남은 줄로 입력 대기를 잰다.
const emptyComposer = (screen: string) => screen.split('\n').some(line => line.trim() === '❯');


describe('dashboard real user echo wiring', () => {
  // macOS: the TUI does not render inside `bun test` here (empty screen · same as the Linux-pod PTY tests from 10-02).
  // The same Q2 → Q3 order is checked on a real PTY on mac by `bun scripts/tui-regress.ts` (R7).
  test.skipIf(process.platform === 'darwin')('PTY screen preserves submitted Q2 → answer Q2 → submitted Q3 → answer Q3', async () => {
    const { startPty, unregisterPty } = await import('../src/pty-shell/registry.js');
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const dir = await mkdtemp(join(tmpdir(), 'elanous-echo-'));
    let handle: ReturnType<typeof startPty> | undefined;
    const local = await startAimockLocal((mock) => {
      // The TUI includes earlier prompts in the last user message. Match Q3 before Q2
      // so the Q2 substring in the accumulated context cannot shadow the Q3 answer.
      mock.onMessage('Q3MARK', { content: 'Q3MARK\n' });
      // Hold the tool boundary open long enough for the LIVEQMARK submission.
      mock.on({ userMessage: 'Bash 도구', hasToolResult: false },
        { content: '파일 이름을 확인합니다.\n', toolCalls: [{ id: 'fake-bash-list-1', name: 'Bash', arguments: '{"command":"ls"}' }] },
        { streamingProfile: { ttft: 2500, tps: 50, jitter: 0 } });
      installTypeaheadFixtures(mock);
    }).catch(async (error: unknown) => {
      await rm(dir, { recursive: true, force: true });
      throw error;
    });
    const childEnv = {
      ELANOUS_DRIVE_TUI: '1', ELANOUS_STATE_DIR: dir, NODE_ENV: 'test',
      LOCAL_LLM_URL: `${local.mock.url}/v1`, LOCAL_LLM_MODEL: 'test-model',
      ELANOUS_LLM_PROVIDER: 'local', ELANOUS_LLM_MODEL: 'test-model',
      ELANOUS_LLM_BASE_URL: `${local.mock.url}/v1`,
    };
    const logDir = join(process.cwd(), 'log');
    const debugFiles = async () => {
      const names = await readdir(logDir).catch(() => [] as string[]);
      return names.filter(name => /^debug-\d+\.log$/.test(name)).map(name => join(logDir, name));
    };
    const before = new Map(await Promise.all((await debugFiles()).map(async path => [path, (await stat(path)).size] as const)));
    const observed = async (offsets = before) => {
      const chunks = await Promise.all((await debugFiles()).map(async path => {
        const bytes = await readFile(path);
        return bytes.subarray(offsets.get(path) ?? 0).toString('utf8');
      }));
      return chunks.join('\n').split('\n').flatMap(line => {
        try { return [JSON.parse(line) as { category?: string; event?: string; data?: { path?: string; length?: number; disposition?: string } }]; }
        catch { return []; }
      }).filter(event => event.category === 'dashboard.turn-typeahead');
    };
    try {
      // Auto selection permits the local fixture; a configured explicit provider still wins.
      await writeFile(join(dir, 'config.json'), JSON.stringify({
        llm: { provider: 'auto' }, onboarding: { completed: true, version: 1 },
        skillRouter: { llmFallback: false }, mcp: { enabled: false },
      }));
      handle = startPty({
        cmd: 'bun', args: ['bin/elanous.mjs', '--config-dir', dir, '--test-state-dir', dir],
        workdir: process.cwd(),
        env: childEnv,
        unsetEnv: ['ELANOUS_TEST_FAKE_LLM'],
        cols: 160, rows: 50, kind: 'shell', detach: false,
      });
      await sleep(9000);
      expect(emptyComposer(await handle.renderScreen())).toBe(true);
      handle.write('1부터 30까지 천천히 한 줄에 하나씩 써 줘. 도구는 쓰지 마.\r');
      // A FIFO classification exists only while the first turn owns the keyboard.
      // Do not accept a normal submission after the first turn has ended.
      for (let i = 0; i < 20; i++) {
        if ((await handle.renderScreen()).includes('❯ 1부터 30까지')) break;
        await sleep(250);
      }
      handle.write('Q2MARK 라고만 답해\r');
      let events = await observed();
      for (let i = 0; i < 40 && !events.some(e => e.event === 'submission-classified' && e.data?.disposition === 'fifo' && e.data.length === 'Q2MARK 라고만 답해'.length); i++) {
        await sleep(250);
        events = await observed();
      }
      expect(events.some(e => e.event === 'submission-classified' && e.data?.disposition === 'fifo' && e.data.length === 'Q2MARK 라고만 답해'.length)).toBe(true);
      handle.write('Q3MARK 라고만 답해\r');
      let screen = '';
      let fifoInputReady = false;
      for (let i = 0; i < 45; i++) {
        await sleep(1000);
        screen = await handle.renderScreen();
        events = await observed();
        const q3Echo = screen.indexOf('❯ Q3MARK 라고만 답해');
        const q3Answer = screen.indexOf('Q3MARK\n', q3Echo + '❯ Q3MARK 라고만 답해'.length);
        fifoInputReady = q3Echo >= 0 && q3Answer > q3Echo
          && screen.indexOf('✔ 완료', q3Answer) > q3Answer
          && emptyComposer(screen);
        if (fifoInputReady) break;
      }
      expect(fifoInputReady).toBe(true);
      expect(events.some(e => e.event === 'submission-classified' && e.data?.disposition === 'fifo' && e.data.length === 'Q3MARK 라고만 답해'.length)).toBe(true);
      expect(events.filter(e => e.event === 'echoed' && e.data?.path === 'turn-end' && e.data.length === 'Q2MARK 라고만 답해'.length)).toHaveLength(2);
      console.log('PTY_ECHO_OBSERVED:', JSON.stringify(events.filter(e => e.event === 'echoed').map(e => e.data)));
      const q2 = screen.indexOf('❯ Q2MARK 라고만 답해');
      const a2 = screen.indexOf('Q2MARK\n', q2 + '❯ Q2MARK 라고만 답해'.length);
      const q3 = screen.indexOf('❯ Q3MARK 라고만 답해');
      const a3 = screen.indexOf('Q3MARK\n', q3 + '❯ Q3MARK 라고만 답해'.length);
      console.log('PTY_ECHO_SCREEN:', screen.slice(Math.max(0, q2 - 15), a3 + 8).replace(/\n/g, ' | '));
      expect(q2).toBeGreaterThanOrEqual(0);
      expect(a2).toBeGreaterThan(q2);
      expect(q3).toBeGreaterThan(a2);
      expect(a3).toBeGreaterThan(q3);
      expect(screen.split('❯ Q2MARK 라고만 답해').length - 1).toBe(1);
      expect(screen.split('❯ Q3MARK 라고만 답해').length - 1).toBe(1);

      // Restart the PTY so pending items from the plain-text turn cannot be
      // mistaken for items drained in the tool-boundary turn.
      handle.kill();
      for (let i = 0; i < 30 && handle.isAlive(); i++) await sleep(100);
      unregisterPty(handle.id);
      handle = startPty({
        cmd: 'bun', args: ['bin/elanous.mjs', '--config-dir', dir, '--test-state-dir', dir],
        workdir: process.cwd(),
        env: childEnv,
        unsetEnv: ['ELANOUS_TEST_FAKE_LLM'],
        cols: 160, rows: 50, kind: 'shell', detach: false,
      });
      await sleep(9000);
      expect(emptyComposer(await handle.renderScreen())).toBe(true);
      const beforeLive = new Map(await Promise.all((await debugFiles()).map(async path => [path, (await stat(path)).size] as const)));
      handle.write('Bash 도구를 사용해서 현재 디렉터리의 파일 이름을 확인하고 설명해 줘.\r');
      await sleep(800);
      handle.write('LIVEQMARK 라고만 답해\r');
      for (let i = 0; i < 55; i++) {
        await sleep(1000);
        events = await observed(beforeLive);
        screen = await handle.renderScreen();
        if (events.some(e => e.event === 'echoed' && e.data?.path === 'live') && screen.includes('❯ LIVEQMARK 라고만 답해')) break;
      }
      console.log('PTY_LIVE_OBSERVED:', JSON.stringify(events.filter(e => e.event === 'echoed').map(e => e.data)));
      console.log('PTY_LIVE_SCREEN:', screen.slice(-1600).replace(/\n/g, ' | '));
      expect(events.filter(e => e.event === 'submission-classified' && e.data?.disposition === 'fifo' && e.data.length === 'LIVEQMARK 라고만 답해'.length)).toHaveLength(1);
      expect(events.filter(e => e.event === 'echoed' && e.data?.path === 'live' && e.data.length === 'LIVEQMARK 라고만 답해'.length)).toHaveLength(1);
      expect(events.some(e => e.event === 'echoed' && e.data?.path === 'turn-end' && e.data.length === 'LIVEQMARK 라고만 답해'.length)).toBe(false);
      expect(screen.split('❯ LIVEQMARK 라고만 답해').length - 1).toBe(1);
      expect(screen).toContain('↳ 이어서');
      expect(screen.indexOf('↳ 이어서')).toBeLessThan(screen.indexOf('❯ LIVEQMARK 라고만 답해'));
      // An answer token alone does not prove the turn-end FIFO handoff has run.
      // The empty composer placeholder returns only after the completed turn
      // has re-entered the input loop and is waiting for the next submission.
      let nextInputReady = false;
      for (let i = 0; i < 55; i++) {
        await sleep(1000);
        screen = await handle.renderScreen();
        events = await observed(beforeLive);
        nextInputReady = screen.includes('LIVEQMARK\n')
          && screen.includes('✔ 완료')
          && emptyComposer(screen)
          && !/⏳ 대기|다음 도구 경계에 넣음/.test(screen);
        if (nextInputReady) break;
      }
      expect(nextInputReady).toBe(true);
      console.log('PTY_LIVE_FINAL_SCREEN:', screen.slice(-2400).replace(/\n/g, ' | '));
      console.log('PTY_LIVE_FINAL_OBSERVED:', JSON.stringify(events.filter(e => e.event === 'echoed').map(e => e.data)));
      expect(screen.indexOf('LIVEQMARK\n', screen.indexOf('❯ LIVEQMARK 라고만 답해'))).toBeGreaterThan(screen.indexOf('❯ LIVEQMARK 라고만 답해'));
      expect(screen.split('❯ LIVEQMARK 라고만 답해').length - 1).toBe(1);
      expect(events.filter(e => e.event === 'submission-classified' && e.data?.disposition === 'fifo' && e.data.length === 'LIVEQMARK 라고만 답해'.length)).toHaveLength(1);
      expect(events.filter(e => e.event === 'echoed' && e.data?.path === 'live' && e.data.length === 'LIVEQMARK 라고만 답해'.length)).toHaveLength(1);
      expect(events.filter(e => e.event === 'echoed' && e.data?.path === 'turn-end' && e.data.length === 'LIVEQMARK 라고만 답해'.length)).toHaveLength(0);
      console.log('PTY_LIVE_VERDICT: next-input-ready=1 live=1 turn-end=0 echo-on-screen=1 answer-on-screen=1');
    } finally {
      if (handle) {
        handle.kill();
        for (let i = 0; i < 30 && handle.isAlive(); i++) await sleep(100);
        if (handle.isAlive()) handle.kill('SIGKILL');
        unregisterPty(handle.id);
      }
      await local.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 110_000);

  test('normal submission and each delivered live item share the same chat-log renderer', () => {
    expect(dashboard).toContain('echoSubmittedUserText(tok.text);');
    const callback = dashboard.slice(dashboard.indexOf('steerLastTurnTypeaheadSubmission(turnTypeaheadRef, sid, ({ texts, remaining }) => {'));
    const body = callback.slice(0, callback.indexOf("debug.log('dashboard.turn-typeahead', 'drained-into-live-turn'"));
    // 큐 떨어내기는 다리 모듈이 id 로 한다(10-14) — 여기서는 «떨어낸 것만» 에코한다.
    expect(body).toContain('for (const text of texts) {\n                      echoSubmittedUserText(text, { live: true });');
    expect(dashboard).toContain('turnStreamRuntime.onText(chunk, accumulated);\n                  restoreLiveTypeaheadEchoes();');
    expect(dashboard).toContain("if (opts?.live) chatLines.push(C.muted('  ↳ 이어서'));");
    expect(dashboard).toContain('wrapAnsiByWidth(`❯ ${text}`, echoWrapCols)');
  });

  test('turn-end injected Enter reaches the regular echo without an extra pre-echo', () => {
    expect(dashboard).toContain("const queuedTurnEndText = drained.injectEnter ? drained.nextInitial : undefined;");
    expect(dashboard).toContain("handoffTurnTypeaheadAtTurnEnd(turnTypeaheadRef, nextInitial, { interrupted }, () => {\n            injectKey({ name: 'enter', ctrl: false, shift: false });");
    expect(dashboard).toContain('initialText: nextInitial,');
    expect(dashboard).toContain('echoSubmittedUserText(tok.text);');
    expect(dashboard).not.toContain('wireDashboardTurnTypeaheadEcho(drained)');
  });

  test('only lengths and paths are emitted by the echoed observation', () => {
    expect(dashboard).toContain("debug.log('dashboard.turn-typeahead', 'echoed', { path: 'live', length: text.length });");
    expect(dashboard).toContain("debug.log('dashboard.turn-typeahead', 'echoed', { path: 'turn-end', length: queuedTurnEndText.length });");
    const echoedCalls = [...dashboard.matchAll(/debug\.log\('dashboard\.turn-typeahead', 'echoed', \{([^}]+)\}\)/g)];
    expect(echoedCalls).toHaveLength(2);
    for (const [, payload] of echoedCalls) {
      expect(payload).not.toMatch(/\btext\s*:/);
      expect(payload).toMatch(/\bpath\s*:/);
      expect(payload).toMatch(/\blength\s*:/);
    }
    expect(dashboard).toContain("debug.log('dashboard.turn-typeahead', 'submission-classified', {");
    expect(dashboard).toContain('length: (r.immediateSubmission ?? turnTypeaheadRef.state.queuedSubmissions.at(-1))?.length ?? 0');
  });
});

// ── 화면 에코·큐 상태는 장치로 (OP #6282 · 적용표 순위 4 · MANUAL-ux-simulation-devices §1) ──
//  위 실물 PTY 케이스(Q2→Q3 · 도구 경계)는 «그대로» 둔다 — AIMock 이전은 #27825 몫이다.
//  그 케이스는 macOS 에서 건너뛰고(위 skipIf) 리눅스에서도 고정 sleep 9초×2 뒤에야 화면을 본다.
//  여기서는 같은 순서를 «진짜» 큐 판정기(`applyTurnTypeaheadKey` · `simTypeaheadState`) ⊕ 진짜 다리
//  (`steerLastTurnTypeaheadSubmission` · `drainPendingUserInput` · `handoffTurnTypeaheadAtTurnEnd`) ⊕ 진짜
//  큐 행·입력 행 렌더(`renderTurnTypeaheadQueueRow` · `drawDashboardTurnTypeaheadPromptRows`)로 세우고,
//  진짜 `renderDashboardFrame` → xterm 해석 화면(`simHeadlessDashboardFrames`)에서 잰다.
//  ⚠️ 에코 줄 모양(`''` · `  ↳ 이어서` · `wrapAnsiByWidth(\`❯ ${text}\`)`)은 대시보드 클로저
//  `echoSubmittedUserText` 의 문면이다 — 클로저라 부를 수 없어 같은 문면을 쓰고, 그 문면은 위
//  «same chat-log renderer» 정적 시험이 원본에 못 박는다. 모델 응답·배선 순서는 실물 케이스 몫.
const ECHO_ROWS = 24;
const ECHO_COLS = 100;
const Q2 = 'Q2MARK 라고만 답해';
const Q3 = 'Q3MARK 라고만 답해';
const LIVEQ = 'LIVEQMARK 라고만 답해';

function echoSubmitted(text: string, opts?: { live?: boolean }): string[] {
  return ['', ...(opts?.live ? ['  ↳ 이어서'] : []), ...wrapAnsiByWidth(`❯ ${text}`, Math.max(20, ECHO_COLS - 6))];
}

function typeAndEnter(state: TurnTypeaheadState, text: string): TurnTypeaheadState {
  let next = state;
  for (const ch of text) next = applyTurnTypeaheadKey(next, { name: ch } as never).state;
  return applyTurnTypeaheadKey(next, { name: 'enter' } as never, () => true).state;
}

function startTurn(): { line: () => string; stop: () => string } {
  const target: { current: string | null } = { current: null };
  const handle = startPinnedThinking({
    target, onFrame: () => {}, message: 'Streaming', intervalMs: 0,
    metrics: { startedAt: Date.now() - 2_000, hint: 'esc 중단' },
  });
  return {
    line: () => target.current ?? '',
    stop: () => { handle.stop(); return target.current ?? ''; },
  };
}

function echoFrame(log: readonly string[], state: TurnTypeaheadState, turnLine: string | null): HeadlessDashboardFrame {
  const promptRow = ECHO_ROWS - 1;
  let caret: { row: number; col: number; visible: boolean } | null = null;
  const promptRows = drawDashboardTurnTypeaheadPromptRows({
    frame: { inputHeight: 1, promptTopRow: promptRow, promptBottomRow: promptRow, topDividerRow: promptRow - 1, bottomDividerRow: ECHO_ROWS },
    height: 1, placeholder: '❯ ', prompt: '❯ ', state, width: ECHO_COLS,
  }, (paint) => { caret = paint.caret; });
  const queueRow = renderTurnTypeaheadQueueRow(state, ECHO_COLS);
  const logRows = ECHO_ROWS - 4;
  const tail = log.slice(-logRows);
  return {
    lines: [
      ...tail, ...Array.from({ length: logRows - tail.length }, () => ''),
      queueRow ?? '',
      turnLine ?? '',
      '─'.repeat(ECHO_COLS),
      ...promptRows,
    ],
    input: { overlay: '', force: false, cursorOwner: 'none', claimedCursor: null, promptCaret: caret, suppressPromptArea: false },
  };
}

const screenText = (lines: readonly string[]) => lines.map(line => line.trimEnd()).join('\n');
const composerEmpty = (lines: readonly string[]) => lines.some(line => line.trim() === '❯');
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('dashboard typeahead echo on the headless terminal (ux-sim)', () => {
  test('plain turn: queued Q2 → answer Q2 → queued Q3 → answer Q3, each echoed once in FIFO order', async () => {
    const sid = `sim-echo-${randomUUID()}`;
    try {
      const ref: TurnTypeaheadRef = { state: simTypeaheadState({ phase: 'streaming', queued: [Q2] }) };
      expect(steerLastTurnTypeaheadSubmission(ref, sid, () => { throw new Error('a plain turn has no tool boundary'); })).not.toBeNull();
      ref.state = typeAndEnter(ref.state, Q3);
      expect(steerLastTurnTypeaheadSubmission(ref, sid, () => { throw new Error('a plain turn has no tool boundary'); })).not.toBeNull();
      expect(ref.state.queuedSubmissions).toEqual([Q2, Q3]);
      expect(ref.state.buffer).toBe('');
      expect(pendingUserInputCount(sid)).toBe(2);

      const log: string[] = [...echoSubmitted('1부터 30까지 천천히 한 줄에 하나씩 써 줘. 도구는 쓰지 마.'), '1', '2', '3'];
      const frames: HeadlessDashboardFrame[] = [];
      let turn = startTurn();
      frames.push(echoFrame(log, ref.state, turn.line()));
      const injected: string[] = [];
      for (const answer of ['30', 'Q2MARK', 'Q3MARK']) {
        log.push(answer, turn.stop());
        const drained = handoffTurnTypeaheadAtTurnEnd(ref, undefined, { interrupted: false }, () => injected.push('enter'));
        if (!drained.injectEnter) break;
        log.push(...echoSubmitted(drained.nextInitial!));
        turn = startTurn();
        frames.push(echoFrame(log, ref.state, turn.line()));
      }
      // 마지막 턴 종료 뒤 큐가 비어 Enter 주입이 없고 입력창이 빈 채로 다음 발화를 기다린다.
      frames.push(echoFrame(log, ref.state, null));
      const screens = await simHeadlessDashboardFrames(frames, { rows: ECHO_ROWS, cols: ECHO_COLS });

      const first = screens[0]!.lines;
      expect(screenText(first)).toContain(`↳ 다음 도구 경계에 넣음 2건 · "${Q2}"`);
      expect(composerEmpty(first)).toBe(true);
      const afterQ2 = screenText(screens[1]!.lines);
      expect(count(afterQ2, `❯ ${Q2}`)).toBe(1);
      expect(afterQ2).toContain(`↳ 다음 도구 경계에 넣음 1건 · "${Q3}"`);
      expect(count(afterQ2, `"${Q2}"`)).toBe(0);

      const final = screens.at(-1)!;
      const screen = screenText(final.lines);
      const q2 = screen.indexOf(`❯ ${Q2}`);
      const a2 = screen.indexOf('Q2MARK\n', q2 + `❯ ${Q2}`.length);
      const q3 = screen.indexOf(`❯ ${Q3}`);
      const a3 = screen.indexOf('Q3MARK\n', q3 + `❯ ${Q3}`.length);
      expect(q2).toBeGreaterThanOrEqual(0);
      expect(a2).toBeGreaterThan(q2);
      expect(q3).toBeGreaterThan(a2);
      expect(a3).toBeGreaterThan(q3);
      expect(screen.indexOf('✔ 완료', a3)).toBeGreaterThan(a3);
      expect(count(screen, `❯ ${Q2}`)).toBe(1);
      expect(count(screen, `❯ ${Q3}`)).toBe(1);
      expect(screen).not.toMatch(/⏳ 대기|다음 도구 경계에 넣음/);
      expect(composerEmpty(final.lines)).toBe(true);
      expect(final.cursor).toEqual({ row: ECHO_ROWS - 1, col: '❯ '.length + 1 });
      expect(injected).toHaveLength(2);
      expect(pendingUserInputCount(sid)).toBe(0);
    } finally {
      clearPendingUserInput(sid);
    }
  });

  test('tool boundary: a live-drained item echoes «↳ 이어서» once and turn end does not echo it again', async () => {
    const sid = `sim-echo-${randomUUID()}`;
    try {
      const log: string[] = [...echoSubmitted('Bash 도구를 사용해서 현재 디렉터리의 파일 이름을 확인하고 설명해 줘.')];
      const drainedEvents: Array<{ texts: string[]; remaining: number }> = [];
      const ref: TurnTypeaheadRef = { state: simTypeaheadState({ phase: 'streaming', queued: [LIVEQ] }) };
      expect(steerLastTurnTypeaheadSubmission(ref, sid, (event) => {
        drainedEvents.push(event);
        for (const text of event.texts) log.push(...echoSubmitted(text, { live: true }));
      })).not.toBeNull();
      const turn = startTurn();
      const frames: HeadlessDashboardFrame[] = [echoFrame(log, ref.state, turn.line())];

      log.push('⏺ Bash(ls)', '  ⎿  package.json');
      expect(drainPendingUserInput(sid)).toEqual([LIVEQ]);
      frames.push(echoFrame(log, ref.state, turn.line()));

      log.push('LIVEQMARK', turn.stop());
      const injected: string[] = [];
      const drained = handoffTurnTypeaheadAtTurnEnd(ref, undefined, { interrupted: false }, () => injected.push('enter'));
      if (drained.injectEnter) log.push(...echoSubmitted(drained.nextInitial!));
      frames.push(echoFrame(log, ref.state, null));
      const [queued, live, done] = await simHeadlessDashboardFrames(frames, { rows: ECHO_ROWS, cols: ECHO_COLS });

      expect(screenText(queued!.lines)).toContain(`↳ 다음 도구 경계에 넣음 1건 · "${LIVEQ}"`);
      expect(drainedEvents).toEqual([{ texts: [LIVEQ], remaining: 0 }]);
      const liveScreen = screenText(live!.lines);
      expect(count(liveScreen, `❯ ${LIVEQ}`)).toBe(1);
      expect(liveScreen).toContain('↳ 이어서');
      expect(liveScreen.indexOf('↳ 이어서')).toBeLessThan(liveScreen.indexOf(`❯ ${LIVEQ}`));
      expect(liveScreen).not.toMatch(/⏳ 대기|다음 도구 경계에 넣음/);

      expect(drained.injectEnter).toBe(false);
      expect(injected).toHaveLength(0);
      const screen = screenText(done!.lines);
      expect(screen.indexOf('LIVEQMARK\n', screen.indexOf(`❯ ${LIVEQ}`))).toBeGreaterThan(screen.indexOf(`❯ ${LIVEQ}`));
      expect(screen).toContain('✔ 완료');
      expect(count(screen, `❯ ${LIVEQ}`)).toBe(1);
      expect(screen).not.toMatch(/⏳ 대기|다음 도구 경계에 넣음/);
      expect(composerEmpty(done!.lines)).toBe(true);
      expect(pendingUserInputCount(sid)).toBe(0);
    } finally {
      clearPendingUserInput(sid);
    }
  });
});
