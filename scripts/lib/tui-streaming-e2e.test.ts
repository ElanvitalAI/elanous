import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainTurnTypeaheadOnce } from '../../src/chat/turn-typeahead.js';
import { drawDashboardTurnTypeaheadPromptRows } from '../../src/dashboard/index.js';
import { createDashboardMouseWiring } from '../../src/dashboard/input/mouse-wiring.js';
import { renderLogEntry, summarizeToolCall } from '../../src/log-entry.js';
import { ptyAvailable, startPty } from '../../src/pty-shell/registry.js';
import { startPinnedThinking } from '../../src/thinking-line.js';
import { simHeadlessDashboardFrames, type HeadlessDashboardFrame } from '../../src/ux-sim/headless-tui.js';
import { simAgentRegistry, simEscGate } from '../../src/ux-sim/interaction.js';
import { simTypeaheadState } from '../../src/ux-sim/turn-states.js';

const repoRoot = join(import.meta.dir, '..', '..');
// 이 시험은 공급자·설정 폴더를 스스로 주입한다 — 게이트가 깐 공용 env 를 자식에게 넘기지 않는다.
//  ⛔ 게이트 shard env 는 XDG_CONFIG_HOME·ELANOUS_CONFIG_DIR 를 임시 폴더로 깐다(deterministic-env) —
//  자식이 그걸 받으면 `--test` 폴더의 config.json 대신 빈 legacy XDG 설정을 읽어 «Choose LLM» 화면에
//  갇히고 60초 뒤 시간초과로 죽었다(f2 사이드 · NOTE-mock-tui-two).
//  startPty 는 로그인 셸 캡처본(없으면 process.env)을 env «밑에» 깐다 — PTY 자식은 unsetEnv 로도 뺀다.
const CHILD_DROP_ENV = ['ELANOUS_TEST_FAKE_LLM', 'XDG_CONFIG_HOME', 'ELANOUS_CONFIG_DIR'] as const;
const childEnv = (extra: Record<string, string | undefined> = {}): Record<string, string> => {
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  for (const key of CHILD_DROP_ENV) delete env[key];
  return env as Record<string, string>;
};

// ── 실물 계약 «1건» (spawn 레인 · src/self-dev/spawn-lane-files.ts) ──────────────────
//  진입점(bin/elanous.mjs → TUI → 로컬 OpenAI 호환 SSE)과 첫 턴 세션 귀속을 «한 번의 spawn» 으로 문다.
//  옛 두 파일의 실물 세 건(분할 SSE 전사 · SSE 중 ESC · 첫 턴 세션)을 이 한 건으로 합쳤다 —
//  ESC·화면 행은 아래 장치판, 세션 조각은 `test/dashboard-first-turn-session-live.test.ts` 장치판.
test.skipIf(!ptyAvailable())('first real TUI turn streams split local SSE text and attributes submit/turn to one registered session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-streaming-first-turn-'));
  const state = join(root, 'state');
  const xdg = join(root, 'xdg');
  mkdirSync(state);
  mkdirSync(xdg);
  let requestPath = '';
  let requestBody: Record<string, unknown> | undefined;
  const encoder = new TextEncoder();
  const llm = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === '/v1/models') return Response.json({ object: 'list', data: [{ id: 'test-model', object: 'model' }] });
      if (pathname !== '/v1/chat/completions') return new Response('not found', { status: 404 });
      requestPath = pathname;
      requestBody = await request.json() as Record<string, unknown>;
      // 프레임 경계가 SSE 이벤트 경계와 어긋나게 쪼갠다 — 파서가 조각을 이어 붙여야 한다.
      const frames = [
        'data: {"choices":[{"delta":{"content":"TUI "}}]}\n',
        '\ndata: {"choices":[{"delta":{"content":"stream"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" works"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      ];
      let index = 0;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          const frame = frames[index++];
          if (frame === undefined) controller.close();
          else controller.enqueue(encoder.encode(frame));
        },
      }), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    onboarding: { completed: true },
    llm: { provider: 'local', model: 'test-model', baseUrl: `http://127.0.0.1:${llm.port}/v1` },
    skillRouter: { llmFallback: false },
    mcp: { enabled: false },
  }));
  const handle = startPty({
    cmd: 'bun',
    args: ['bin/elanous.mjs', `--test=${root}`, '--chat-only'],
    workdir: repoRoot,
    cols: 120,
    rows: 30,
    env: childEnv({ NODE_ENV: 'development', XDG_STATE_HOME: xdg, ELANOUS_STATE_DIR: state, TERM: 'xterm-256color' }),
    unsetEnv: CHILD_DROP_ENV,
  });
  let screen = '';
  const fail = (message: string) => new Error(`${message}\nrequest=${requestPath || 'none'}\nfull screen:\n${screen}`);
  try {
    const deadline = Date.now() + 60_000;
    const emptyComposer = (s: string) => s.split('\n').some((line) => line.trim() === '❯');
    while (Date.now() < deadline) {
      screen = await handle.renderScreen();
      if (emptyComposer(screen)) break;
      await Bun.sleep(100);
    }
    if (!emptyComposer(screen)) throw fail('TUI boot prompt never appeared');
    handle.write('안녕\r');

    while (Date.now() < deadline) {
      screen = await handle.renderScreen();
      if (screen.includes('TUI stream works') && emptyComposer(screen)) break;
      await Bun.sleep(100);
    }
    if (requestPath !== '/v1/chat/completions') throw fail('TUI did not reach the local SSE server');
    expect(requestBody).toEqual(expect.objectContaining({ model: 'test-model', stream: true }));
    if (!screen.includes('TUI stream works')) throw fail('split SSE text was not assembled on the TUI screen');

    const dbPath = join(root, 'logs', 'logs.db');
    let ids: { category: string; event: string; session_id: string | null }[] = [];
    while (Date.now() < deadline) {
      if (existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: true });
        try {
          ids = db.query("select category,event,session_id from logs where category in ('input.submit','core.turn') order by id").all() as typeof ids;
        } finally { db.close(); }
      }
      if (ids.filter((row) => row.category === 'input.submit').length >= 3
        && ids.filter((row) => row.category === 'core.turn').length >= 2) break;
      await Bun.sleep(100);
    }
    const submits = ids.filter((row) => row.category === 'input.submit');
    const turns = ids.filter((row) => row.category === 'core.turn');
    expect(submits.map((row) => row.event)).toEqual(['create', 'execute.begin', 'execute.ok']);
    expect(turns.map((row) => row.event)).toEqual(['callbacks-wired', 'dispatch-summary']);
    const sessionId = submits[0]?.session_id;
    expect(sessionId).toMatch(/^elanous-session-/);
    if (typeof sessionId !== 'string') throw fail(`first turn session id missing: ${String(sessionId)}`);
    expect([...submits, ...turns].every((row) => row.session_id === sessionId)).toBe(true);

    // 첫 턴 완료 뒤 격리 state 에 그 ACP 세션이 등록되고 active 가 된다(대시보드 클로저 배선 — 장치 밖).
    const sessionFile = join(state, 'sessions', `${sessionId}.jsonl`);
    const activePath = join(state, 'elanous', 'active');
    while (Date.now() < deadline && !(existsSync(sessionFile) && existsSync(activePath))) await Bun.sleep(100);
    expect(existsSync(sessionFile)).toBe(true);
    expect(readFileSync(activePath, 'utf8').trim()).toBe(sessionId);

    // /quit 안내가 그 세션 id 를 싣는다(«기록하지 못했습니다» 없음).
    handle.write('/quit\r');
    let exitOutput = '';
    while (Date.now() < deadline && !exitOutput.includes('[session]')) {
      exitOutput = handle.snapshot();
      if (!exitOutput.includes('[session]')) await Bun.sleep(100);
    }
    expect(exitOutput).not.toContain('기록하지 못했');
    expect(exitOutput).toContain(sessionId);
  } finally {
    handle.kill();
    llm.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);

// ── SSE 도는 중 ESC·typeahead — 장치판 ─────────────────────────────────────────
//  종전 실물 케이스(S1 스트리밍 → S2 typeahead → S3 ESC 중단·입력 보존)를 진짜 ESC 게이트(`simEscGate`)
//  ⊕ 진짜 턴 종료 핸드오프(`drainTurnTypeaheadOnce`) ⊕ 진짜 입력 행·턴 줄 렌더 위로 옮긴다.
//  ⚠️ 입력 행의 「입력하면…」 안내 문면은 대시보드 클로저 값이라 같은 문면을 쓴다. 키 → 게이트 배선은 장치 밖.
const TYPEAHEAD_HINT = '입력하면 이 응답 뒤에 이어서 보냅니다';

describe('ESC and typeahead while streaming (headless dashboard device)', () => {
  test('presses ESC and typeahead while the stream is still running', async () => {
    const rows = 14;
    const cols = 120;
    const promptRow = rows;
    const frame = (log: string[], turnLine: string | null, draft: string, streaming: boolean): HeadlessDashboardFrame => {
      let caret: { row: number; col: number; visible: boolean } | null = null;
      const prompt = drawDashboardTurnTypeaheadPromptRows({
        frame: { inputHeight: 1, promptTopRow: promptRow, promptBottomRow: promptRow, topDividerRow: promptRow - 1, bottomDividerRow: rows },
        height: 1, placeholder: '❯ ', prompt: '❯ ', width: cols,
        state: simTypeaheadState({ phase: streaming ? 'streaming' : 'idle', draft }),
        ...(streaming ? { hint: TYPEAHEAD_HINT } : {}),
      }, (paint) => { caret = paint.caret; });
      const body = rows - 3;
      const tail = log.slice(-body);
      return {
        lines: [...tail, ...Array.from({ length: body - tail.length }, () => ''), turnLine ?? '', '─'.repeat(cols), ...prompt],
        input: { overlay: '', force: false, cursorOwner: 'none', claimedCursor: null, promptCaret: caret, suppressPromptArea: false },
      };
    };
    const target: { current: string | null } = { current: null };
    const thinking = startPinnedThinking({ target, onFrame: () => {}, message: 'Streaming', intervalMs: 0, metrics: { startedAt: Date.now() - 2_000, hint: 'esc 중단' } });
    const log = ['', '❯ hello world', '청크0 청크1 청크2 '];
    const s1Frame = frame(log, target.current, '', true);
    const s2Frame = frame(log, target.current, 'abc', true);

    const esc = simEscGate({ runningChildren: 0 });
    esc.esc();
    await esc.settle();
    expect(esc.isOpen()).toBe(false);
    expect(esc.abortCtrl.signal.aborted).toBe(true);
    thinking.stop({ status: 'interrupted' });
    const handoff = drainTurnTypeaheadOnce(simTypeaheadState({ phase: 'streaming', draft: 'abc' }), undefined, { interrupted: true });
    expect(handoff.injectEnter).toBe(false);
    const s3Frame = frame([...log, target.current ?? ''], null, handoff.nextInitial ?? '', false);

    const [s1, s2, s3] = await simHeadlessDashboardFrames([s1Frame, s2Frame, s3Frame], { rows, cols });
    const lastPromptLine = (lines: readonly string[]) => [...lines].reverse().find((line) => line.trimStart().startsWith('❯'))!.trimStart();
    const turnLineOf = (lines: readonly string[]) => lines.find((line) => line.includes('esc 중단') && !line.trimStart().startsWith('❯'));

    expect(s1!.lines.join('\n')).toContain('Streaming…');
    expect(lastPromptLine(s1!.lines)).not.toContain('hello world');
    expect(turnLineOf(s1!.lines)).toBeDefined();
    expect(lastPromptLine(s1!.lines)).not.toContain('esc 중단');
    expect(lastPromptLine(s1!.lines)).toContain('입력하면');
    expect(s1!.cursor).toEqual({ row: promptRow, col: '❯ '.length + 1 });

    expect(lastPromptLine(s2!.lines).startsWith('❯ abc')).toBe(true);
    expect(s2!.cursor).toEqual({ row: promptRow, col: '❯ abc'.length + 1 });

    expect(s3!.lines.join('\n')).toContain('중단됨');
    expect(s3!.lines.join('\n')).not.toContain('Streaming…');
    expect(lastPromptLine(s3!.lines).startsWith('❯ abc')).toBe(true);
  });
});

// ── 화면 행·status·커서 단언은 헤드리스 장치로 (OP #6282 · MANUAL-ux-simulation-devices §1) ──
//  종전 실물 PTY 두 건(heredoc 머리 · 배경 에이전트 status)은 TUI 를 띄우고 로컬 SSE 를 돌려
//  «화면 행»만 쟀다. 그 단언을 진짜 렌더 경로(`renderDashboardFrame` → `tui.render` → xterm 해석) 위로
//  옮긴다. 줄을 만드는 쪽도 진짜 함수다 — RunShell 머리 `summarizeToolCall`·`renderLogEntry` · 턴 줄
//  `startPinnedThinking` · 입력 행 `drawDashboardTurnTypeaheadPromptRows`(+ `simTypeaheadState`) ·
//  status 행 `createDashboardMouseWiring().buildStatusLine` · 도는 에이전트 수 `simAgentRegistry`.
//  ⚠️ 이 장치가 «못» 무는 것: 대시보드 클로저가 이 조각들을 실제로 어느 행에 쌓나(배치)와
//  SSE → 도구 호출 → 재요청 배선 — 그건 위 실물 SSE·ESC 두 건과 `tui-runshell-group-e2e` 의 몫이다.
const ROWS = 20;
const COLS = 120;
const PROMPT_ROW = ROWS - 1;
const promptFrame = {
  inputHeight: 1, promptTopRow: PROMPT_ROW, promptBottomRow: PROMPT_ROW,
  topDividerRow: PROMPT_ROW - 1, bottomDividerRow: ROWS,
};

function statusLineFor(runningAgents: number): string {
  const wiring = createDashboardMouseWiring({
    termSize: () => ({ rows: ROWS, cols: COLS }),
    getRotation: () => [],
    setActiveModel: () => {},
    getRecentWds: () => [],
    setSessionWd: () => {},
    pushModalSurface: () => ({ dispose: () => {} }),
    redraw: () => {},
  });
  try {
    return wiring.buildStatusLine({
      swd: '/tmp/sim', gitState: 'main', host: 'sim-host',
      providerInfo: { provider: 'local', model: 'test-model' },
      runningAgents,
    });
  } finally {
    wiring.dispose();
  }
}

function streamingTurnLine(): string {
  const target: { current: string | null } = { current: null };
  const handle = startPinnedThinking({
    target, onFrame: () => {}, message: 'Streaming', intervalMs: 0,
    metrics: { startedAt: Date.now() - 3_000, hint: 'esc 중단' },
  });
  const line = target.current ?? '';
  handle.stop();
  return line;
}

/** 아래에서부터 쌓는다: 로그 · 턴 줄 · 구분선 · 입력 행 · status 행. */
function screenFrame(parts: {
  log: string[];
  turnLine: string | null;
  draft: string;
  status: string;
}): HeadlessDashboardFrame {
  const state = simTypeaheadState({ phase: parts.turnLine ? 'streaming' : 'idle', draft: parts.draft });
  let caret: { row: number; col: number; visible: boolean } | null = null;
  const promptRows = drawDashboardTurnTypeaheadPromptRows({
    frame: promptFrame, height: 1, placeholder: '❯ ', prompt: '❯ ', state, width: COLS,
  }, (paint) => { caret = paint.caret; });
  const logRows = ROWS - 4;
  const log = parts.log.slice(-logRows);
  const lines = [
    ...log, ...Array.from({ length: logRows - log.length }, () => ''),
    parts.turnLine ?? '',
    '─'.repeat(COLS),
    ...promptRows,
    parts.status,
  ];
  return {
    lines,
    input: {
      overlay: '', force: false, cursorOwner: 'none', claimedCursor: null,
      promptCaret: caret, suppressPromptArea: false,
    },
  };
}

const rowOf = (screen: readonly string[], predicate: (line: string) => boolean) => screen.findIndex(predicate);
const inputRow = (screen: readonly string[]) => {
  for (let i = screen.length - 1; i >= 0; i--) if (screen[i]!.trimStart().startsWith('❯')) return i;
  return -1;
};
const statusRow = (screen: readonly string[]) => rowOf(screen, line => line.includes('│ local:test-model │'));

describe('TUI streaming screen rows (headless dashboard device)', () => {
  test('keeps input and status rows visible after a heredoc RunShell header during streaming', async () => {
    const status = statusLineFor(0);
    const header = renderLogEntry({
      kind: 'tool-header', toolName: 'RunShell',
      summary: summarizeToolCall('RunShell', { command: ['sh', '-c', "cat <<'EOF'\nfirst\nEOF"], approval: 'none' }),
    });
    const prompt = ['❯ run heredoc', ''];
    const streamed = Array.from({ length: 6 }, (_, i) => `stream ${i + 1} `).join('');
    const [boot, streaming, typed, completed] = await simHeadlessDashboardFrames([
      screenFrame({ log: [], turnLine: null, draft: '', status }),
      screenFrame({ log: [...prompt, ...header, streamed], turnLine: streamingTurnLine(), draft: '', status }),
      screenFrame({ log: [...prompt, ...header, streamed], turnLine: streamingTurnLine(), draft: 'abc', status }),
      screenFrame({ log: [...prompt, ...header, `${streamed}done`], turnLine: null, draft: 'abc', status }),
    ], { rows: ROWS, cols: COLS });
    const screen = streaming!.lines;
    expect(header).toHaveLength(1);
    expect(screen.join('\n')).toContain(' ↵ ');
    expect(screen.filter(line => line.includes('RunShell('))).toHaveLength(1);
    expect(screen.some(line => line.trim() === 'first' || line.trim() === 'EOF')).toBe(false);
    expect(inputRow(boot!.lines)).toBeGreaterThan(0);
    expect(statusRow(boot!.lines)).toBeGreaterThan(0);
    expect(inputRow(screen)).toBe(inputRow(boot!.lines));
    expect(statusRow(screen)).toBe(statusRow(boot!.lines));
    expect(rowOf(screen, line => line.includes('esc 중단'))).toBe(inputRow(screen) - 2);
    expect(screen[inputRow(screen)]!.trimStart().startsWith('❯ abc')).toBe(false);

    expect(typed!.lines[inputRow(typed!.lines)]!.trimStart().startsWith('❯ abc')).toBe(true);
    expect(typed!.cursor).toEqual({ row: PROMPT_ROW, col: '❯ abc'.length + 1 });
    expect(inputRow(typed!.lines)).toBe(inputRow(boot!.lines));
    expect(statusRow(typed!.lines)).toBe(statusRow(boot!.lines));

    expect(completed!.lines.join('\n')).not.toContain('Streaming…');
    expect(completed!.lines.some(line => line.trimStart().startsWith('❯ abc'))).toBe(true);
    expect(inputRow(completed!.lines)).toBe(inputRow(boot!.lines));
    expect(statusRow(completed!.lines)).toBe(statusRow(boot!.lines));
  });

  test('shows running background agents in the essential status line and clears them after completion', async () => {
    const registry = simAgentRegistry({ background: 2 });
    // 대시보드 `buildStatusLine` 과 같은 셈(`globalAgentRegistry.list().filter(running)`).
    const running = () => registry.list().filter(agent => agent.state === 'running').length;
    const lastNonEmpty = (screen: readonly string[]) => [...screen].reverse().find(line => line.trim().length > 0) ?? '';
    const before = statusLineFor(running());
    for (const task of registry.list()) {
      task.state = 'done';
      task.finishedAt = Date.now();
      registry.notifyTaskDone(task);
    }
    const after = statusLineFor(running());
    const [a1, a2] = await simHeadlessDashboardFrames([
      screenFrame({ log: ['❯ AGENTS 둘', ''], turnLine: streamingTurnLine(), draft: '', status: before }),
      screenFrame({ log: ['❯ AGENTS 둘', '', 'spawned'], turnLine: null, draft: '', status: after }),
    ], { rows: ROWS, cols: COLS });
    expect(lastNonEmpty(a1!.lines)).toContain('◇ 2 agents');
    expect(running()).toBe(0);
    expect(lastNonEmpty(a2!.lines)).not.toContain('agents');
    expect(lastNonEmpty(a2!.lines)).toContain('local:test-model');
    expect(statusRow(a2!.lines)).toBe(statusRow(a1!.lines));
  });
});
