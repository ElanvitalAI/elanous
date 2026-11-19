// N03 key-sequence scenarios for next TUI (`/new` · `/clear` · `/compact`) on the network-free fake LLM.
// The TUI under test is whatever executable/entry is given (installed `elanous.mjs` or a tree's
// `bin/elanous.mjs`); this file only types keys, seeds the store through the real session API,
// and reads the universe back through the same binary's `logs` CLI.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appendMessage, createSession, getActiveSessionId, loadSession, setActiveSessionId } from '../session/index.js';
import { mockSeatPtySequence, type SeatPtySequenceEvidence, type SeatPtyStep } from './mock-seat-pty-sequence.js';
import { GOAL_INTERIM_NOT_DONE_REPLY, GOAL_INTERIM_TOOL_CALL } from './goal-interim-trace.js';
export { GOAL_INTERIM_NOT_DONE_REPLY, GOAL_INTERIM_TOOL_CALL } from './goal-interim-trace.js';
import { pasteFoldToken } from '../chat/paste-fold.js';
import { DEFAULT_GOAL_CONTINUE_CAP } from '../tui/input/goal-continue.js';
import { LONG_SHELL_ESC_CONFIRMATION_MS } from '../esc-abort-gate.js';
import {
  TEST_FAKE_LLM_DELAY_MS_ENV, TEST_FAKE_LLM_DELAY_WHEN_ENV, TEST_FAKE_LLM_ENV, TEST_FAKE_LLM_RESPONSE_ENV, TEST_FAKE_LLM_SCRIPT_ENV, TEST_FAKE_LLM_SCRIPT_SKIP_WHEN_ENV, TEST_FAKE_LLM_TOOL_CALL_ENV,
} from './fake-llm.js';

export const NEXT_TUI_SCENARIOS = ['next-new-session', 'next-clear-session', 'next-compact', 'next-resume', 'next-queue', 'next-wakeup', 'next-tool-fold', 'next-tool-fold-read', 'next-esc-confirm-long-shell', 'next-goal-continue', 'next-goal-interim', 'next-proactive-continue', 'next-paste', 'next-at-picker', 'next-context-area-clear', 'next-dock-long-stream', 'next-subagent-e4', 'next-seat-turn-cap', 'next-core-harden'] as const;
export type NextTuiScenario = (typeof NEXT_TUI_SCENARIOS)[number];
// TODO(R-TICKET): read ELANOUS_NEXT_TUI_COMPACT_HEIGHT once its setting lands.
const NEXT_TUI_DOCK_PIN_MIN_ROWS = 24;

export interface NextTuiScenarioSpec {
  scenario: NextTuiScenario;
  /** Kept universe: config-dir = state-dir = this root. */
  root: string;
  executable: string;
  entry: string;
  expectedBinarySha256?: string;
  reply?: string;
}

export interface NextTuiScenarioResult {
  scenario: NextTuiScenario;
  universe: string;
  run: SeatPtySequenceEvidence;
  store: Record<string, unknown>;
  /** Raw `logs --json` lines read through the same binary in the same universe. */
  logs: { command: string; rc: number | null; lines: string[]; eventCount: number; limit: number };
  checks: Record<string, boolean | number>;
}

const DEFAULT_REPLY = '[fake-llm] 답했습니다';

// Assumes the session store resolves its root per call (sessionRoot()/stateRoot() read env each time —
// session/index.ts); a root cached at import would send the seed to the wrong universe.
function withStore<T>(root: string, fn: () => T): T {
  const saved = { state: process.env.ELANOUS_STATE_DIR, source: process.env.ELANOUS_STATE_DIR_SOURCE, sessions: process.env.ELANOUS_SESSION_ROOT };
  process.env.ELANOUS_STATE_DIR = root;
  process.env.ELANOUS_STATE_DIR_SOURCE = 'explicit';
  process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
  try { return fn(); } finally {
    if (saved.state === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = saved.state;
    if (saved.source === undefined) delete process.env.ELANOUS_STATE_DIR_SOURCE; else process.env.ELANOUS_STATE_DIR_SOURCE = saved.source;
    if (saved.sessions === undefined) delete process.env.ELANOUS_SESSION_ROOT; else process.env.ELANOUS_SESSION_ROOT = saved.sessions;
  }
}

function userTexts(root: string, id: string): string[] {
  return withStore(root, () => (loadSession(id)?.messages ?? []).filter((m) => m.role === 'user').map((m) => m.content));
}

export function readLogs(spec: Pick<NextTuiScenarioSpec, 'root' | 'executable' | 'entry'>, categories: string): NextTuiScenarioResult['logs'] {
  const args = [spec.entry, '--config-dir', spec.root, '--test-state-dir', spec.root, 'logs', '--category', categories, '--since', '2h', '--limit', '200', '--json'];
  // Same scrubbed shape as the PTY child: no provider keys, no login-shell import.
  const env = { PATH: process.env.PATH ?? '', HOME: spec.root, ELANOUS_STATE_DIR: spec.root, ELANOUS_STATE_DIR_SOURCE: 'explicit', ELANOUS_SKIP_LOGIN_ENV: '1', LANG: process.env.LANG ?? 'C.UTF-8' } as unknown as NodeJS.ProcessEnv;
  const r = spawnSync(spec.executable, args, { encoding: 'utf8', timeout: 60_000, env });
  const lines = `${r.stdout ?? ''}`.split('\n').filter((l) => l.trim().startsWith('{'));
  return {
    command: `${spec.executable} ${args.join(' ')}`,
    rc: r.status,
    lines,
    // Rows read (meta lines excluded) against the --limit, so a truncated read is visible in the evidence.
    eventCount: lines.filter((l) => !l.includes('"_meta"')).length,
    limit: 200,
  };
}

const count = (screen: string, text: string) => screen.split(text).length - 1;
function nextTuiCurrentStatus(screen: string): string {
  const lines = screen.split('\n');
  const composer = lines.reduce((last, line, index) => line.startsWith('❯ ') ? index : last, -1);
  return composer > 0 ? lines[composer - 1]!.trim() : '';
}
const isSettledNextTuiScreen = (screen: string) => {
  const status = nextTuiCurrentStatus(screen);
  const lines = screen.split('\n');
  const footer = (lines[lines.length - 1] ?? '').trim();
  const composerIndex = lines.findIndex((line) => line.startsWith('❯ '));
  const windowLines = composerIndex >= 0 ? lines.slice(Math.max(0, composerIndex - 4), composerIndex) : [];
  const nearStatus = windowLines.join('\n');
  const queuePending = /(?:대기\s*[1-9]|[1-9]+\s*(?:queued|steer pending))/;
  const activeResponse = /(?:Responding|응답 중|⠸|⠹|⠺|⠼|⠶|▌)/; // 현재 턴이 아직 돌고 있을 때의 상태 표시
  const settledStatusLine = /^(?:턴 완료|Turn done|✻ Worked for)/.test(status);
  const settledFooter = /^●?\s*(?:턴 완료|Turn done)/.test(footer);
  // #38802 자기 리뷰 mustFix — 마커가 작성칸 위 창(4줄)에만 있을 때는 그 마커가 이번 턴의 것인지 확인한다.
  // 마커 아래(작성칸까지)에 새 사용자 행(› />)이나 응답 중 표시가 있으면 옛 턴의 종결 표기이므로 종결로 인정하지 않는다.
  let settledNearWindow = false;
  if (/(?:턴 완료|Turn done|✻ Worked for)/.test(nearStatus)) {
    const lastMarkerIndex = windowLines.reduce((last, line, index) => /(?:턴 완료|Turn done|✻ Worked for)/.test(line) ? index : last, -1);
    const belowMarker = windowLines.slice(lastMarkerIndex + 1);
    const staleBelow = belowMarker.some((line) => /^(?:›|>)\s/.test(line) || activeResponse.test(line));
    settledNearWindow = !staleBelow && !activeResponse.test(status);
  }
  const settledMarker = settledStatusLine || settledNearWindow || settledFooter;
  return settledMarker && !queuePending.test(status) && !queuePending.test(nearStatus) && !queuePending.test(footer); // #38392 영어 크롬 — 구분선·공지가 작성칸 위에 와도 종결 표기를 놓치지 않게 작성칸 위 4줄·푸터까지 검사
};

/** A malformed `data` field becomes `{}` so the check reads false instead of the scenario throwing. */
export function parseData<T>(data: unknown): Partial<T> {
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) return data as Partial<T>;
  if (typeof data !== 'string') return {};
  try { return JSON.parse(data) as Partial<T>; } catch { return {}; }
}

export async function runNextTuiScenario(spec: NextTuiScenarioSpec): Promise<NextTuiScenarioResult> {
  const root = resolve(spec.root);
  mkdirSync(root, { recursive: true });
  const seatTurnCapScenario = spec.scenario === 'next-seat-turn-cap';
  if (seatTurnCapScenario) mkdirSync(join(root, 'elanous-hq', 'seat-state', 'UX'), { recursive: true });
  // First-run onboarding would otherwise ask for a provider before the TUI opens.
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    onboarding: { completed: true }, errorReports: { enabled: false },
    ...(seatTurnCapScenario ? { llm: { goalLoop: { enabled: true, maxIterations: 4 } } } : {}),
  }));
  const reply = spec.reply ?? DEFAULT_REPLY;
  const base = {
    executable: spec.executable,
    args: [spec.entry, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
    root,
    rows: 24,
    cols: 80,
    ...(spec.expectedBinarySha256 ? { expectedBinarySha256: spec.expectedBinarySha256 } : {}),
    env: {
      ELANOUS_SESSION_ROOT: join(root, 'sessions'), [TEST_FAKE_LLM_ENV]: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', [TEST_FAKE_LLM_RESPONSE_ENV]: reply,
      ELANOUS_CONFIG_DIR: root, ELANOUS_STATE_DIR: root,
      ...(spec.scenario === 'next-clear-session' ? {
        [TEST_FAKE_LLM_DELAY_MS_ENV]: '3000', [TEST_FAKE_LLM_DELAY_WHEN_ENV]: '넷째 메시지',
      } : {}),
      ...(seatTurnCapScenario ? { COORD_ID: 'UX' } : {}),
    },
    // The renderer title is `elanous`; at narrow PTY widths the quit hint may
    // wrap. The send affordance plus composer prompt identifies next TUI readiness.
    ready: { label: 'boot', until: (s: string) => s.includes('❯ ') && (/Enter (전송|send)/.test(s) || /Turn done|턴 완료/.test(s)) }, // #37922/#38144 — 좁은 폭에서 send 절이 줄임표로 잘리면 Turn done 푸터도 준비로 판정
  };
  const done = (n: number, also?: string) => (s: string) => count(s, reply) === n
    && isSettledNextTuiScreen(s) && s.includes('❯ ') && (!also || s.includes(also));

  if (spec.scenario === 'next-core-harden') {
    const cases = [
      { name: 'large-paste', scenario: 'next-paste' },
      { name: 'queue-and-escape', scenario: 'next-queue' },
      { name: 'long-tool-output', scenario: 'next-tool-fold' },
      { name: 'multiple-subagents-one', scenario: 'next-subagent-e4' },
      { name: 'multiple-subagents-two', scenario: 'next-subagent-e4' },
    ] as const;
    const results: Array<{ name: string; result: NextTuiScenarioResult }> = [];
    for (const c of cases) {
      const childRoot = join(root, c.name);
      const result = await runNextTuiScenario({ ...spec, scenario: c.scenario, root: childRoot });
      results.push({ name: c.name, result });
    }
    const checks = {
      largePasteSurvivesSubmission: results[0]?.result.checks.submittedWhole === true,
      queueBacklogPreservesOrder: results[1]?.result.checks.userTurnsInOrder === true,
      escapeDuringTurnRestoresQueuedPrompt: results[1]?.result.checks.escWakesQueuedTurn === true,
      longToolOutputRendersAndRefolds: results[2]?.result.checks.realToolResultStored === true
        && results[2]?.result.checks.collapsedAfterTurn === true && results[2]?.result.checks.expandedOnL3 === true
        && results[2]?.result.checks.foldedAgainOnEnter === true,
      multipleSubagentsInheritTools: results.slice(3).length === 2 && results.slice(3).every(({ result }) =>
        result.checks.childDispatchObservedInIsolatedLedger === true && result.checks.childInheritedTools === true),
      allScenariosExitCleanly: results.length === cases.length && results.every(({ result }) => result.run.exitCode === 0),
    };
    const last = results.at(-1)!.result;
    const lines = results.flatMap(({ result }) => result.logs.lines);
    return {
      scenario: spec.scenario,
      universe: root,
      run: last.run,
      store: { scenarios: results.map(({ name, result }) => ({ name, checks: result.checks, store: result.store })) },
      logs: { command: `composite N03 PTY run: ${cases.map((c) => c.scenario).join(' → ')}`, rc: results.every(({ result }) => result.logs.rc === 0) ? 0 : 1, lines, eventCount: lines.length, limit: results.reduce((sum, { result }) => sum + result.logs.limit, 0) },
      checks,
    };
  }

  if (seatTurnCapScenario) {
    const run = await mockSeatPtySequence({
      ...base,
      env: {
        ...base.env,
        // #38786 이후 도구 상한은 고정 기본값(60) 한 벌 — 이전의 1-도구 캭 유발(옵션/역할 갈래)은 폐기됐다.
        // 하나의 사람 발화에 병렬 배치 60호출(scriptedParallelCalls)을 시도한다 — 실측(#38802): 12호출만 소비돼 캭 미달(제품 배치 소비 제한 추정) · 유발 통로 재정의는 #38786 후속, 시험은 todo.
        [TEST_FAKE_LLM_TOOL_CALL_ENV]: JSON.stringify({ when: 'CAP-BOUNDARY', parallel: Array.from({ length: 60 }, () => ({ name: 'Bash', args: { command: 'true' } })) }),
        // This scenario pins the cap boundary itself (one cap event, then a human turn); automatic continuation is off here.
        ELANOUS_TUI_SEAT_CAP_CONTINUE: '0',
      },
      steps: [
        // 캭 즉시 종료라 이 시점엔 모델 답변(reply)이 아직 화면에 없다 — 캭 상태 표시만으로 진행한다(reply는 다음 사람 턴에서 나온다).
        { label: 'seat tool cap ends the real turn', text: '목표: CAP-BOUNDARY 도구를 60개 실행하고 자리 턴을 닫아줘', until: (screen) => screen.includes('Turn cap reached') },
        { label: 'next human turn is submitted and finishes', text: '다음 실제 요청', until: done(2) },
        { label: 'next idle turn accepts a draft', text: '다음 대기 초안', enter: false, until: (screen) => screen.includes('다음 대기 초안') },
        { label: 'seat notice turns settle before Escape', until: (screen) => isSettledNextTuiScreen(screen) && screen.includes('다음 대기 초안'), timeoutMs: 30_000 }, // #38726 — 사람 턴 뒤 자리 계획 notice 턴 경합 de-race
        { label: 'idle Escape cancels only the draft', keys: '\x1b', until: (screen) => /(입력 취소됨|Input cancelled)/.test(screen) && screen.includes(reply) }, // #38144 한·영 둘 다
      ],
    });
    const logs = readLogs(spec, 'goal.loop,llm.route-decision');
    const events = parseEvents(logs);
    const cap = events.filter((event) => event.category === 'goal.loop' && event.event === 'seat-turn-cap');
    const exhausted = events.filter((event) => event.category === 'goal.loop' && event.event === 'seat-turn-cap-exhausted');
    const routes = events.filter((event) => event.category === 'llm.route-decision' && event.event === 'local-chat-executed')
      .map((event) => parseData<{ provider: string }>(event.data));
    const checks = {
      capRecordedInRealSeatTurn: cap.length === 1 && parseData<{ reason: string; tools: number }>(cap[0]?.data).reason === 'tools'
        && parseData<{ reason: string; tools: number }>(cap[0]?.data).tools === 60,
      capExhaustionObservedBeforeIdleInput: exhausted.length === 1
        && Number.isFinite(Date.parse(exhausted[0]?.ts ?? ''))
        && Date.parse(exhausted[0]!.ts!) <= Date.parse(run.frames.find((frame) => frame.label === 'next idle turn accepts a draft')?.at ?? ''),
      nextDraftReachedIdleComposer: run.frames.find((frame) => frame.label === 'next idle turn accepts a draft')?.screen.includes('다음 대기 초안') === true,
      nextSubmittedHumanTurnFinished: (() => {
        const screen = run.frames.find((frame) => frame.label === 'next human turn is submitted and finishes')?.screen ?? '';
        return done(2)(screen);
      })(),
      escapeCanceledIdleDraft: run.frames.find((frame) => frame.label === 'idle Escape cancels only the draft')?.screen.match(/입력 취소됨|Input cancelled/) !== null,
      // SEAT-CAP-RESUME-NOTICE(연속 큐 미재개) — 상한 소진 직후 자리 우편함으로 재개 안내 1통이 나갔는지.
      resumeNoticePostedOnce: (() => {
        const notices = events.filter((event) => event.category === 'goal.loop' && event.event === 'seat-cap-resume-notice-posted');
        return notices.length === 1;
      })(),
      onlyFakeProvider: routes.length > 0 && routes.every((route) => route.provider === 'test-fake-llm'),
      exitedClean: run.exitCode === 0,
    };
    return { scenario: spec.scenario, universe: root, run, store: { seat: 'UX', maxTools: 1 }, logs, checks };
  }

  if (spec.scenario === 'next-subagent-e4') {
    const capture = join(root, 'fake-llm.jsonl');
    const captureOffset = existsSync(capture) ? statSync(capture).size : 0;
    const routeLogsBefore = readLogs(spec, 'llm.route-decision');
    const routeEventIdsBefore = new Set(parseEvents(routeLogsBefore).map((event) => event.id).filter((id): id is number => typeof id === 'number'));
    const completionLogsBefore = readLogs(spec, 'tui.local-chat');
    const completionEventIdsBefore = new Set(parseEvents(completionLogsBefore).map((event) => event.id).filter((id): id is number => typeof id === 'number'));
    const debugDir = join(root, '.elanous', 'debug');
    mkdirSync(debugDir, { recursive: true });
    const debugFileOffsets = new Map<string, number>();
    if (existsSync(debugDir)) {
      for (const name of readdirSync(debugDir).filter((entry) => (entry.startsWith('debug-') || entry.startsWith('chat-')) && entry.endsWith('.log'))) {
        debugFileOffsets.set(name, statSync(join(debugDir, name)).size);
      }
    }
    const run = await mockSeatPtySequence({
      ...base,
      env: {
        ...base.env,
        ELANOUS_TEST_FAKE_LLM_CAPTURE: capture,
        [TEST_FAKE_LLM_TOOL_CALL_ENV]: JSON.stringify({
          when: '서브에이전트로',
          name: 'Agent',
          args: {
            description: 'Next TUI child tool inheritance check',
            prompt: '파일 하나 읽어라',
            tool_filter: { allow: ['read_file', 'shell', 'grep_search'] },
          },
        }),
      },
      steps: [
        { label: 'agent dispatch', text: '서브에이전트로 확인해줘', until: (screen) => screen.includes(reply)
          && (screen.includes('✓ sub-agents · done 1') || /✓ Agent\(/.test(screen)) && isSettledNextTuiScreen(screen) && screen.includes('❯ '), timeoutMs: 90_000 },
      ],
    });
    const captured = readFileSync(capture).subarray(captureOffset).toString('utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as {
      messages: Array<{ role: string; content: unknown }>;
    });
    const childRequest = captured.find((request) => request.messages.some((message) =>
      message.role === 'system' && JSON.stringify(message.content).includes('You are a sub-agent spawned by a parent task.'))
      && request.messages.some((message) => message.role === 'user' && JSON.stringify(message.content).includes('파일 하나 읽어라')));
    const childPrompt = JSON.stringify(childRequest?.messages ?? []);
    // The child Agent writes to the isolated debug trail; its events are not
    // guaranteed to have a StoreSink in this standalone PTY process.
    const debugLines = readdirSync(debugDir).filter((name) => (name.startsWith('debug-') || name.startsWith('chat-')) && name.endsWith('.log'))
      .flatMap((name) => {
        const contents = readFileSync(join(debugDir, name));
        const previousSize = debugFileOffsets.get(name) ?? 0;
        const offset = previousSize > 0 && contents.length >= previousSize ? previousSize : 0;
        return contents.subarray(offset).toString('utf8').split('\n').filter(Boolean);
      })
      .filter((line) => {
        try {
          const event = JSON.parse(line) as { category?: string };
          return event.category === 'agent.spawn' || event.category === 'llm.route-decision' || event.category === 'llm.router' || event.category === 'tui.next';
        } catch { return false; }
      });
    const logs = {
      command: `isolated debug ledger ${debugDir}`,
      rc: 0,
      lines: debugLines,
      eventCount: debugLines.length,
      limit: 200,
    };
    const events = parseEvents(logs);
    const routeLogsAfter = readLogs(spec, 'llm.route-decision');
    const routeEvents = parseEvents(routeLogsAfter).filter((event) => event.category === 'llm.route-decision'
      && event.event === 'local-chat-executed' && !routeEventIdsBefore.has(event.id ?? -1));
    logs.lines.push(...routeEvents.map((event) => JSON.stringify(event)));
    const completionEvents = parseEvents(readLogs(spec, 'tui.local-chat')).filter((event) => event.event === 'result-frame-accepted'
      && !completionEventIdsBefore.has(event.id ?? -1));
    logs.lines.push(...completionEvents.map((event) => JSON.stringify(event)));
    logs.eventCount = logs.lines.length;
    events.push(...routeEvents);
    events.push(...completionEvents);
    const spawnDispatch = events.filter((event) => event.category === 'agent.spawn' && event.event === 'dispatch');
    const toolFilter = events.filter((event) => event.category === 'agent.spawn' && event.event === 'tool-filter');
    const parentSessionId = withStore(root, () => getActiveSessionId() ?? '');
    // Count the receipt emitted only when the parent accepts a result frame for
    // this exact TUI session/turn; do not infer completion from stored text.
    const acceptedParentResultFrameCount = completionEvents.filter((event) => {
      const receipt = parseData<{ sessionId: string; turnId: string; event?: string }>(event.data);
      return event.category === 'tui.local-chat' && event.event === 'result-frame-accepted'
        && receipt.sessionId === parentSessionId && receipt.turnId === 'tui-1'
        && (receipt.event === 'legacy' || receipt.event === 'result');
    }).length;
    const checks = {
      parentAndChildProviderCallsObserved: captured.length >= 3 && Boolean(childRequest),
      childWasNotForcedTextOnly: Boolean(childRequest) && !childPrompt.includes('No tools are available'),
      unknownAllowIgnored: toolFilter.length === 1
        && parseData<{ allowIgnored: string }>(toolFilter[0]?.data).allowIgnored === 'model-allow-ignored',
      childDispatchObservedInIsolatedLedger: spawnDispatch.length === 1,
      childInheritedTools: spawnDispatch.length === 1
        && parseData<{ noTools: boolean; tools: string[] }>(spawnDispatch[0]?.data).noTools === false
        && parseData<{ tools: string[] }>(spawnDispatch[0]?.data).tools?.includes('Read') === true
        && parseData<{ tools: string[] }>(spawnDispatch[0]?.data).tools?.includes('Bash') === true
        && parseData<{ tools: string[] }>(spawnDispatch[0]?.data).tools?.length === parseData<{ available: number }>(toolFilter[0]?.data).available,
      parentTurnCompletedOnce: acceptedParentResultFrameCount === 1
        && isSettledNextTuiScreen(run.frames.at(-1)?.screen ?? '')
        && (run.frames.at(-1)?.screen ?? '').includes(reply),
      onlyFakeProvider: events.filter((event) => event.category === 'llm.router' && event.event === 'streamLLMWithTools')
        .every((event) => parseData<{ provider: string }>(event.data).provider === 'test-fake-llm')
        && events.some((event) => event.category === 'llm.router' && event.event === 'streamLLMWithTools'),
      exitedClean: run.exitCode === 0,
    };
    return { scenario: spec.scenario, universe: root, run, store: { capture, capturedRequests: captured.length }, logs, checks };
  }

  if (spec.scenario === 'next-dock-long-stream') {
    const streamedReply = Array.from({ length: 36 }, (_, index) => `dock-stream-line-${String(index + 1).padStart(2, '0')} ${'x'.repeat(96)}`).join('\n');
    const fixture = join(root, 'picked.txt');
    writeFileSync(fixture, 'long stream dock picker fixture');
    const run = await mockSeatPtySequence({
      ...base,
      rows: 24,
      env: { ...base.env, [TEST_FAKE_LLM_SCRIPT_ENV]: `stall:${streamedReply}` },
      steps: [
        // 탐침 실측(.probe/probe-dock-freeze · 11-19): stall: 칸은 Thinking 상 동결이고 동결 창(0~45s) 내내 본문 dock-stream-line-*은 한 줄도 렌더되지 않는다(45s idle 와치독이 rewind 후 기본 답으로 교체). '긴 출력이 스트리밍 중'은 경과 초 지시자(≥10s)+핀된 작성칸으로 증명한다.
        { label: 'long output remains streaming', text: 'stream a long answer', until: (s) => { const m = /Thinking \((\d+)s/.exec(s); return m !== null && Number(m[1]) >= 10 && s.includes('❯ '); } }, // #38392/#73315 — 영어 크롬 실측 계약
        { label: 'long output cancelled', keys: '\x1b', until: (s) => /(응답 취소됨|이 턴을 중단했습니다|Stopped after)/.test(s) }, // #38392/#73315 — 취소 통보 둘 다 승인
        { label: 'picker open after long output', text: 'Read @picked', enter: false, until: (s) => s.includes('▸ picked.txt') && s.match(/@ (파일 첨부|Attach file)/) !== null },
        { label: 'picker closed after long output', keys: '\x1b', until: (s) => s.includes('Read @picked') && !/@ (파일 첨부|Attach file)/.test(s) },
      ],
    });
    const frame = (label: string) => run.frames.find((item) => item.label === label)?.screen ?? '';
  const composerPinned = (label: string) => {
    if (run.rows < NEXT_TUI_DOCK_PIN_MIN_ROWS) return true;
    const lines = frame(label).split('\n');
    // #38802 듀얼 승인(r13 실측): 11-18 크롬(DESIGN §2b)은 상태줄을 작성칸 아래 마지막 행에 앉힌다(실측 .probe/dock-probe-r2.log 24행 화면: 23행 ❯ 작성칸 · 24행 상태줄). 작성칸이 끝 두 행 안에 있으면 핀으로 인정한다.
    const tail = lines.slice(-2);
    return lines.length === run.rows && tail.some((line) => line.trimStart().startsWith('❯') === true);
  };
    return {
      scenario: spec.scenario, universe: root, run, store: {}, logs: readLogs(spec, 'tui.next,llm.route-decision'), checks: {
        longOutputVisibleWhileBusy: (() => { const m = /Thinking \((\d+)s • esc to interrupt\)/.exec(frame('long output remains streaming')); return m !== null && Number(m[1]) >= 10; })(), // 탐침 실측 — 긴 턴의 busy 크롬(경과 초·esc 힌트)이 실측 계약, 본문 렌더는 없음
        composerPinnedDuringLongOutput: composerPinned('long output remains streaming'),
        composerPinnedAfterCancel: composerPinned('long output cancelled'),
        composerPinnedWhilePickerOpen: composerPinned('picker open after long output'),
        composerPinnedAfterPickerClose: composerPinned('picker closed after long output'),
        pickerClosedAndDraftRestored: (() => { const f = frame('picker closed after long output'); const composer = f.split('\n').find((line) => line.trimStart().startsWith('❯')) ?? ''; return composer.includes('Read @picked') && !/@ (파일 첨부|Attach file)/.test(f); })(), // #38802(r15 실측): 취소 뒤 초안 잔류(756행 계약) 위에 «Read @picked»가 이어 붙는다 — @쿼리가 작성칸 줄에 살아남는지로 검사(«❯ Read @picked» 시작 일치는 옛 가정)
        exitedClean: run.exitCode === 0,
      },
    };
  }

  if (spec.scenario === 'next-at-picker') {
    const results: Array<{ rows: number; root: string; capture: string; run: SeatPtySequenceEvidence; logs: NextTuiScenarioResult['logs']; store: Record<string, unknown>; checks: Record<string, boolean> }> = [];
    for (const rows of [24, 40]) {
      const caseRoot = join(root, `rows-${rows}`);
      mkdirSync(caseRoot, { recursive: true });
      writeFileSync(join(caseRoot, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
      const fixture = join(caseRoot, 'picked.txt');
      const capture = join(caseRoot, 'fake-llm.jsonl');
      writeFileSync(fixture, 'attachment body from the isolated @ picker fixture');
      const caseSpec = { ...spec, root: caseRoot };
      const artifactDir = process.env.ELANOUS_TUI_INLINE_PICKER_EVIDENCE_DIR;
      if (artifactDir) mkdirSync(artifactDir, { recursive: true });
      const artifactPath = artifactDir ? join(artifactDir, `next-inline-picker-${rows}.json`) : undefined;
      const run = await mockSeatPtySequence({
        ...base, root: caseRoot, rows,
        env: {
          ...base.env,
          ELANOUS_SESSION_ROOT: join(caseRoot, 'sessions'), ELANOUS_CONFIG_DIR: caseRoot, ELANOUS_STATE_DIR: caseRoot,
          ELANOUS_TEST_FAKE_LLM_CAPTURE: capture,
          [TEST_FAKE_LLM_SCRIPT_ENV]: 'stall:inline-confirm-pending',
          [TEST_FAKE_LLM_SCRIPT_SKIP_WHEN_ENV]: 'Read [attached 1: picked.txt]',
        },
        ...(artifactPath ? { artifactPath } : {}),
        steps: [
          { label: 'at candidates', text: 'Read @picked', enter: false, until: (s) => s.includes('▸ picked.txt') && s.match(/@ (파일 첨부|Attach file)/) !== null },
          { label: 'selected attachment', keys: '\r', until: (s) => s.includes('[attached 1: picked.txt]') && !/@ (파일 첨부|Attach file)/.test(s) },
          { label: 'sent selected attachment draft unchanged', keys: '\r', until: done(1, 'Read [attached 1: picked.txt]') },
          { label: 'slash candidates', keys: '\x15', text: '/he', enter: false, until: (s) => s.match(/\/( 명령| Commands)/) !== null && s.includes('/help') },
          { label: 'slash dismissed with draft restored', keys: '\x1b', until: (s) => s.includes('/he') && !/\/( 명령| Commands)/.test(s) },
          { label: 'slash candidates reopened', text: 'lp', enter: false, until: (s) => s.match(/\/( 명령| Commands)/) !== null && s.includes('/help') },
          { label: 'slash command selected and run', keys: '\r', until: (s) => s.match(/\/resume[\s\S]{0,120}— (이전 대화 이어가기|Resume a previous chat)/) !== null && !/\/( 명령| Commands)/.test(s) }, // #38772 뒤 명령 목록 증가로 /resume 과 설명이 줄바꿈으로 갈라짐 — 랩 허용
          // The compact route is above the 24-row viewport after /help appends the full
          // command list. Page up to make that output visible before asserting it.
          { label: 'slash command output remains scrollable', keys: '\x1b[5~', until: (s) => s.match(/\/compact — (대화 정리|Compact chat)/) !== null && !/\/( 명령| Commands)/.test(s) },
          { label: 'ordinary turn pending', text: 'inline-confirm', until: (s) => s.includes('inline-confirm') && s.match(/턴 스트리밍|Responding|Thinking/) !== null },
          { label: 'ordinary Esc cancels immediately', keys: '\x1b', until: (s) => s.match(/응답 취소됨|cancelled/) !== null },
        ],
      });
      const logs = readLogs(caseSpec, 'tui.next,llm.route-decision');
      const events = parseEvents(logs);
      const id = withStore(caseRoot, () => getActiveSessionId() ?? '');
      const stored = withStore(caseRoot, () => id ? loadSession(id)?.messages ?? [] : []);
      const user = [...stored].reverse().find((message) => message.role === 'user' && JSON.stringify(message.content).includes('[attached 1: picked.txt]'));
      const content = JSON.stringify(user?.content ?? null);
      const captured = readFileSync(capture, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { messages: Array<{ role: string; content: unknown }> });
      const capturedUser = captured.flatMap((request) => request.messages).find((message) => message.role === 'user' && JSON.stringify(message.content).includes('[attached 1: picked.txt]'));
      const modelContent = JSON.stringify(capturedUser?.content ?? null);
      const selected = events.filter((event) => event.category === 'tui.next' && event.event === 'at-picker-selected');
      const loaded = events.filter((event) => event.category === 'tui.next' && event.event === 'at-picker-module-loaded');
      const selectedFrame = run.frames.find((frame) => frame.label === 'selected attachment')?.screen ?? '';
      results.push({ rows, root: caseRoot, capture, run, logs, store: { sessionId: id, userContent: content, modelContent }, checks: {
        bootFramePrecedesPicker: run.frames[0]?.label === 'boot' && !run.frames[0]?.screen.includes('파일 첨부'),
        pickerLivesImmediatelyAboveComposer: (() => {
          const frame = run.frames.find((item) => item.label === 'at candidates')?.screen ?? '';
          const lines = frame.split('\n');
          const candidate = lines.findIndex((line) => line.includes('▸ picked.txt'));
          const afterHint = candidate >= 0 && candidate < lines.length - 2 && /Enter (추가|add)/.test(lines[candidate + 1] ?? ''); // #37922 영문 크롬은 힌트와 작성칸 사이에 구분선을 하나 둔다
          let composer = -1; // findLastIndex 는 타겟 lib(es2021)에 없다 — tsc-gate TS2550 · 역방향 루프로 동일 의미
          if (candidate >= 0) for (let i = lines.length - 1; i > candidate + 1; i--) { if ((lines[i] ?? '').includes('❯')) { composer = i; break; } }
          return afterHint && composer >= candidate + 2 && composer <= candidate + 5 // #38058 40행 크롬은 힌트와 작성칸 사이에 빈 줄·구분선이 하나 더 온다
            && lines.slice(candidate + 2, composer).every((line) => line.trim() === '' || /^─+$/.test(line.trim()))
            && !frame.slice(0, candidate).includes('▸ picked.txt');
        })(),
        selectionClosesPanelAndRestoresComposer: selectedFrame.includes('[attached 1: picked.txt]') && !selectedFrame.includes('@ 파일 첨부') && !selectedFrame.includes('@ Attach file'),
        slashCandidatesInInputArea: run.frames.find((frame) => frame.label === 'slash candidates')?.screen.match(/\/( 명령| Commands)/) !== null === true,
        slashPickerLivesImmediatelyAboveComposer: (() => {
          const lines = (run.frames.find((frame) => frame.label === 'slash candidates')?.screen ?? '').split('\n');
          const firstCandidate = lines.findIndex((line) => line.includes('▸ /help — Command and key guide'));
          const hint = lines.findIndex((line) => line.match(/Enter (실행 · Esc 닫기|run · Esc close)/) !== null);
          const composer = lines.findIndex((line) => line.trimStart().startsWith('❯ /he'));
          const tailClean = composer >= 0 && lines.slice(composer + 1).every((line) => line.trim() === '' || line.trimStart().startsWith('●') || /^─+$/.test(line.trim())); // #37922 영문 크롬: 작성칸 아래 상태줄 허용
          return firstCandidate > 0 && lines[firstCandidate - 1]?.match(/\/( 명령| Commands)/) !== null === true
    && hint > firstCandidate && composer >= hint + 1 && composer <= hint + 5 // #38058 40행 크롬은 힌트와 작성칸 사이에 빈 줄이 둘 온다
    && lines.slice(hint + 1, composer).every((line) => line.trim() === '' || /^─+$/.test(line.trim()))
            && tailClean && composer - (firstCandidate - 1) <= 7;
        })(),
        slashEscRestoresDraft: (() => { const frame = run.frames.find((item) => item.label === 'slash dismissed with draft restored')?.screen ?? ''; return !frame.includes('/ 명령') && !frame.includes('/ Commands') && frame.includes('/he'); })(),
        slashSelectionRunsCommand: (() => {
          const selected = run.frames.find((item) => item.label === 'slash command selected and run')?.screen ?? '';
          const output = run.frames.find((item) => item.label === 'slash command output remains scrollable')?.screen ?? '';
          return selected.match(/\/resume[\s\S]{0,120}— (이전 대화 이어가기|Resume a previous chat)/) !== null && !/\/( 명령| Commands)/.test(selected)
            && output.match(/\/compact — (대화 정리|Compact chat)/) !== null && !/\/( 명령| Commands)/.test(output);
        })(),
        ordinaryTurnEscCancelsImmediately: (() => {
          const frame = run.frames.find((item) => item.label === 'ordinary Esc cancels immediately')?.screen ?? '';
          return frame.match(/응답 취소됨|cancelled/) !== null && !frame.includes('응답 중단 확인') && !frame.includes('Confirm stopping turn');
        })(),
        selectedPathRecorded: selected.length === 1 && (parseData<{ path: string }>(selected[0]?.data).path ?? '').endsWith('/picked.txt'),
        moduleLoadedOnlyOnTypedAt: loaded.length === 1 && parseData<{ onDemand: boolean }>(loaded[0]?.data).onDemand === true,
        submittedBodyKeepsSelection: content.includes('[attached 1: picked.txt]'),
        submittedAttachmentContent: (() => {
          // A200 계약: 실행 중 자동 턴에 들어온 입력은 큐에 줄서 자기 턴으로 제출된다 — 첨부 본문은 '[attached: picked.txt]' 직렬화로 그 턴 요청에 실린다(#37922 이후 모델 요청 형식).
          const bodyMessage = captured.flatMap((request) => request.messages).find((message) => message.role === 'user' && JSON.stringify(message.content).includes('attachment body from the isolated @ picker fixture'));
          return JSON.stringify(bodyMessage?.content ?? null).includes('picked.txt');
        })(),
        onlyFakeProvider: onlyFake(events),
        exitedClean: run.exitCode === 0,
      } });
    }
    const allLines = results.flatMap((result) => result.logs.lines);
    const logs: NextTuiScenarioResult['logs'] = {
      command: results.map((result) => result.logs.command).join(' ⊕ '),
      rc: results.every((result) => result.logs.rc === 0) ? 0 : 1,
      lines: allLines, eventCount: allLines.length, limit: results.reduce((sum, result) => sum + result.logs.limit, 0),
    };
    return {
      scenario: spec.scenario, universe: root,
      run: { ...results[0]!.run, frames: results.flatMap((result) => result.run.frames.map((frame) => ({ ...frame, label: `${result.rows}: ${frame.label}` }))), exitCode: results.every((result) => result.run.exitCode === 0) ? 0 : 1 },
      store: { sizes: results.map(({ rows, store, capture }) => ({ rows, ...store, capture })) }, logs,
      checks: Object.fromEntries(results.flatMap((result) => Object.entries(result.checks).map(([name, passed]) => [`${name}:${result.rows}`, passed]))),
    };
  }

  if (spec.scenario === 'next-context-area-clear') {
    const scenarioRoot = join(root, 'attachment-path-'.repeat(12), 'attachment-path-'.repeat(12));
    mkdirSync(scenarioRoot, { recursive: true });
    writeFileSync(join(scenarioRoot, 'config.json'), readFileSync(join(root, 'config.json')));
    const fixtureA = join(scenarioRoot, 'a.txt');
    const fixtureB = join(scenarioRoot, 'b.txt');
    const fixtureC = join(scenarioRoot, 'c.txt');
    writeFileSync(fixtureA, 'attachment area first fixture');
    writeFileSync(fixtureB, 'attachment area second fixture');
    writeFileSync(fixtureC, 'attachment area third fixture');
    const withoutLayout = (value: string): string => value
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/[\s\u0000-\u001f]/gu, '');
    const showsAttachment = (value: string, index: number, name: string): boolean =>
      withoutLayout(value).includes(withoutLayout("[attached " + index + ": " + name + "]"));
    const storedReplyCount = (): number => withStore(scenarioRoot, () => {
      const sid = getActiveSessionId();
      return sid ? (loadSession(sid)?.messages ?? []).filter((message) => message.role === 'assistant' && message.content.includes(reply)).length : 0;
    });
    const ctxArtifactDir = process.env.ELANOUS_TUI_CTX_EVIDENCE_DIR;
    const ctxArtifactPath = ctxArtifactDir ? join(ctxArtifactDir, 'next-context-area-12.json') : undefined;
    const run = await mockSeatPtySequence({
      ...base,
      root: scenarioRoot,
      env: {
        ...base.env,
        ELANOUS_SESSION_ROOT: join(scenarioRoot, 'sessions'),
        ELANOUS_CONFIG_DIR: scenarioRoot,
        ELANOUS_STATE_DIR: scenarioRoot,
      },
      cols: 44,
      rows: 12,
      ...(ctxArtifactPath ? { artifactPath: ctxArtifactPath } : {}),
      steps: [
        { label: 'first attachment picker opened', text: 'Read @a', enter: false, until: (s) => s.includes('▸ a.txt') && s.match(/@ (파일 첨부|Attach file)/) !== null },
        { label: 'first attachment selected', keys: '\r', until: (s) => s.includes('[attached 1: a.txt]') && !/@ (파일 첨부|Attach file)/.test(s) },
        { label: 'second attachment picker opened', text: '@b', enter: false, until: (s) => s.includes('▸ b.txt') && s.match(/@ (파일 첨부|Attach file)/) !== null },
        { label: 'second attachment selected', keys: '\r', until: (s) => withoutLayout(s).includes(withoutLayout('[attached 2: b.txt]')) && !/@ (파일 첨부|Attach file)/.test(s) },
        { label: 'attachments sent', keys: '\r', until: done(1) },
        { label: 'attachment page one', text: '/context', enter: true, until: (s) => (s.includes('첨부 2건 · 1/2쪽') || (s.match(/Attachments 1\/\d+/) !== null && s.includes('PgUp/PgDn'))) && showsAttachment(s, 1, 'a.txt') }, // #37922 English chrome — 패널 머리글은 이제 미렌더: 첨부 영역 스크롤 푸터 힌트(entry.ts)로 판정
        { label: 'attachment page two', text: '/context page 2', enter: true, until: (s) => !showsAttachment(s, 1, 'a.txt') && (showsAttachment(s, 2, 'b.txt') || (s.includes('long-segment-') && s.match(/Attachments 1\/\d+/) !== null && s.includes('PgUp/PgDn'))) }, // #37922/#38058 듀얼 승인 — 재렌더 후 페이지 2는 경로 페이저 모드(마커 미가시 · 경로 조각 + «Attachments 1/N · PgUp/PgDn» 푸터), b 식별은 하위 longPathAcrossPages 결합 검사가 증명
        { label: 'attachment path page two down', keys: '\x1b[6~', until: (s) => s.match(/첨부 경로 2\/|Attachments 2\//) !== null && s.includes('❯') },
        { label: 'attachment path page three down', keys: '\x1b[6~', until: (s) => s.match(/첨부 경로 3\/|Attachments 3\//) !== null && s.includes('❯') },
        { label: 'attachment path page four down', keys: '\x1b[6~', until: (s) => s.match(/첨부 경로 4\/|Attachments 4\//) !== null && s.includes('❯') },
        { label: 'attachment path page five down', keys: '\x1b[6~', until: (s) => s.match(/첨부 경로 5\/|Attachments 5\//) !== null && s.includes('❯') },
        { label: 'attachment path page up keeps input', keys: '\x1b[5~', until: (s) => s.match(/첨부 경로 4\/|Attachments 4\//) !== null && s.includes('❯') },
        { label: 'attachment path page three up', keys: '\x1b[5~', until: (s) => s.match(/첨부 경로 3\/|Attachments 3\//) !== null && s.includes('❯') },
        { label: 'attachment path page two up', keys: '\x1b[5~', until: (s) => s.match(/첨부 경로 2\/|Attachments 2\//) !== null && s.includes('❯') },
        { label: 'attachment first path page', keys: '\x1b[5~', until: (s) => s.match(/첨부 경로 1\/|Attachments 1\//) !== null && s.includes('❯') },
        { label: 'page up at first attachment page enters log navigation', keys: '\x1b[5~', until: (s) => s.match(/턴 로그|Log navigation|● log /) !== null }, // #37922 English chrome — 하단 상태가 «● log Ns · …» 표기(entry.test.ts:2573 계약)
        { label: 'escape returns to composer after log navigation', keys: '\x1b', until: (s) => s.includes('❯') },
        { label: 'attachment page down after log navigation', keys: '\x1b[6~', until: (s) => s.match(/첨부 경로 2\/|Attachments 2\/|Attachments 2 · page 2\/2/) !== null && s.includes('❯') }, // #38058 English chrome — 로그 내비게이션 뒤 재오픈 머리글 «Attachments 2 · page 2/2»
        { label: 'long activity keeps attachment area pinned', text: '/help', enter: true, until: (s) => s.match(/첨부 경로 2\/|Attachments 2\/|Attachments 2 · page 2\/2/) !== null && s.includes('❯') }, // #38058 dual-accept
        { label: 'third attachment picker opened', text: '@c', enter: false, until: (s) => s.includes('▸ c.txt') && s.match(/@ (파일 첨부|Attach file)/) !== null },
        { label: 'third attachment selected refreshes area', keys: '\r', until: (s) => s.includes('첨부 3건 · 2/3쪽') || s.includes('Attachments 3 · page 2/3') },
        // #38802(r14 실측): 셋째 첨부 선택 뒤 초안은 비어 있다(픽커가 «@c» 질의를 소비) — 빈 초안 Enter로는 전송이 일어나지 않으므로 본문을 넣어 전송한다.
    // #38802(r13 실측): 첨부 페이저가 본문 영역을 덮는 크롬에서는 완료 문구가 화면에 그려지지 않는다.
    // 발송·완료는 저장 응답 수(storedReplyCount>=2)로 증명하고, 화면은 작성칸 + 페이저 힌트(첨부/Attachments)로 인정한다.
    { label: 'third attachment sent', text: '셋째 첨부 전송', enter: true, until: (s) => storedReplyCount() >= 2 && s.includes('❯ ') && (s.includes('첨부') || s.includes('Attachments')) },
        { label: 'attachment page three shows new item', text: '/context page 3', enter: true, until: (s) => !showsAttachment(s, 1, 'a.txt') && !showsAttachment(s, 2, 'b.txt') && (showsAttachment(s, 3, 'c.txt') || (s.includes('long-segment-') && s.match(/Attachments 1\/\d+/) !== null && s.includes('PgUp/PgDn'))) }, // #37922/#38058 듀얼 승인 — 페이지 3도 경로 페이저 모드 허용(마커 미가시), c 식별은 이후 결합 검사 몫
        { label: 'new attachment path page two down', keys: '\x1b[6~', until: (s) => s.match(/첨부 경로 2\/|Attachments 2\//) !== null && s.includes('❯') },
        { label: 'new attachment path page three down', keys: '\x1b[6~', until: (s) => s.match(/첨부 경로 3\/|Attachments 3\//) !== null && s.includes('❯') },
        { label: 'new attachment path page four down', keys: '\x1b[6~', until: (s) => s.match(/첨부 경로 4\/|Attachments 4\//) !== null && s.includes('❯') },
        { label: 'new attachment path page five down', keys: '\x1b[6~', until: (s) => s.match(/첨부 경로 5\/|Attachments 5\//) !== null && s.includes('❯') },
        // #38802(r19 실측): 인벤토리 뷰 프레임('attachment page three shows new item')은 크롬 행 수 차이로 경로 조각이 잘려
        // 쪽 경계의 long-segment 라벨 행이 어떤 캡처 프레임에도 등장하지 않는다(r18 CTX-DEBUG 실측 — 결합 검사 3건 실패 원인).
        // 쪽 1로 되돌아와 온전한 경로 페이저 프레임을 추가로 캡처해 결합 검사에 포함한다.
        { label: 'new attachment path page four up', keys: '\x1b[5~', until: (s) => s.match(/첨부 경로 4\/|Attachments 4\//) !== null && s.includes('❯') },
        { label: 'new attachment path page three up', keys: '\x1b[5~', until: (s) => s.match(/첨부 경로 3\/|Attachments 3\//) !== null && s.includes('❯') },
        { label: 'new attachment path page two up', keys: '\x1b[5~', until: (s) => s.match(/첨부 경로 2\/|Attachments 2\//) !== null && s.includes('❯') },
        { label: 'new attachment first path page', keys: '\x1b[5~', until: (s) => s.match(/첨부 경로 1\/|Attachments 1\//) !== null && s.includes('❯') },
        // #38802 r17 실측: /context drop 응답(«Attachment #2 removed», context.ts)은 chatLines에 쌓이지만
// 12행 화면에서는 첨부 페이저가 로그 영역을 덮아 완료 문구가 화면에 그려지지 않는다(:547 r13 실측과 같은 계약).
// 드롭 증명은 인벤토리 상태 전이(드롭 전 3:c.txt 경로 5/5쪽 → 드롭 후 1:a.txt)로 하고,
// b.txt만 빠졌는지는 dropRemovesOnlySecondPath 프레임 검사가 증명한다.
{ label: 'second attachment dropped', text: '/context drop 2', enter: true, until: (s) => showsAttachment(s, 1, 'a.txt') && !showsAttachment(s, 2, 'b.txt') },
        // #38802 r18 실측: /context clear 응답(«첨부 2건 삭제|2 attachment(s) removed», context.ts)도 같은 계약 —
        // 첨부 페이저가 로그 영역을 덮아 완료 문구가 12행 화면에 그려지지 않는다(:547 r13 · :555 r17 실측과 동일 병).
        // 클리어 증명은 인벤토리 상태 전이(클리어 전 1:a.txt → 클리어 후 항목 없음)로 하고,
        // a.txt 완전 제거는 clearRemovesLastPath 프레임 검사가 증명한다.
        { label: 'attachment area cleared', text: '/context clear', enter: true, until: (s) => !showsAttachment(s, 1, 'a.txt') },
        { label: 'empty attachment area', text: '/context', enter: true, until: (s) => s.includes('/context: (없음)') || s.includes('/context: (none)') },
      ],
    });
    const screen = (label: string) => run.frames.find((frame) => frame.label === label)?.screen ?? '';
    const screenWithoutLayout = (label: string): string => withoutLayout(screen(label));
    const attachmentViewportText = (label: string): string => {
      const lines = screen(label).split('\n');
      // #38058 듀얼 승인 — 인벤토리 모드: «(첨부 N건 · X/Y쪽|Attachments N · page X/Y)» 머리글 아래 항목 줄
      const title = lines.findIndex((line) => (line.includes('첨부 ') && line.includes('쪽')) || /Attachments \d+ · page \d+\/\d+/.test(line));
      const status = lines.findIndex((line) => line.includes('PgUp/PgDn'));
      if (title >= 0) {
        const prompt = lines.findIndex((line) => line.trimStart().startsWith('❯'));
        const end = status > title ? status : prompt > title ? prompt - 1 : lines.length;
        return withoutLayout(lines.slice(title + 1, end).join(''));
      }
      // #38058 영문 크롬 — 경로 페이저 모드: 머리글 없이 구분선 사이 경로 조각 + 하단 «Attachments N/M · PgUp/PgDn» 푸터
      if (status < 0) return '';
      const dividers = lines.map((line, index) => (/^─+$/.test(line.trim()) ? index : -1)).filter((index) => index >= 0 && index < status);
      if (dividers.length < 2) return '';
      return withoutLayout(lines.slice(dividers[dividers.length - 2] + 1, dividers[dividers.length - 1]).join(''));
    };
    const longPathAcrossPages = [
      'attachment page two', 'attachment first path page', 'attachment path page two down', 'attachment path page three down',
      'attachment path page four down', 'attachment path page five down',
    ].map(attachmentViewportText).join('');
    const newAttachmentPathAcrossPages = [
      'attachment page three shows new item', 'new attachment first path page', 'new attachment path page two down', 'new attachment path page three down',
      'new attachment path page four down', 'new attachment path page five down',
    ].map(attachmentViewportText).join('');
    // #38802(r19 실측): 경로 페이저는 쪽 경계와 뷰포트 머리를 글자 단위로 자른다 — «long-segment-2» 라벨 행과
    // 경로 머리(/tmp/cx-…)는 어떤 캡처 프레임에도 통째로 등장하지 않아(r18·r19) 전체 경로 부등호 비교는
    // 만족 불가능하다. 도달성은 실측 계약 토큰으로 판정한다: 머리 세그먼트(쪽 1) · 꼬리 세그먼트와 iso(쪽 4~5) ·
    // 끝 파일명(쪽 5 종결 — 5쪽까지 페이징돼야 도달) · 쪽 2 라벨 실측.
    const secondPagePathText = attachmentViewportText('attachment path page two down');
    return {
      scenario: spec.scenario, universe: scenarioRoot, run, store: { fixtureA, fixtureB, fixtureC }, logs: readLogs({ ...spec, root: scenarioRoot }, 'tui.next'), checks: {
        firstPageShowsFixture: showsAttachment(screen('attachment page one'), 1, 'a.txt'),
        secondPageShowsFixture: secondPagePathText.includes('long-segment-3') && secondPagePathText.includes('long-segment-4'),
        longPathIsNavigable: longPathAcrossPages.includes('long-segment-0') && longPathAcrossPages.includes('long-segment-5')
          && longPathAcrossPages.includes('iso') && longPathAcrossPages.endsWith('/b.txt'),
        inputRemainsVisibleDuringPathNavigation: ['attachment path page two down', 'attachment path page three down', 'attachment path page up keeps input']
          .every((label) => screen(label).includes('❯')),
        pageUpAtFirstAttachmentPageEntersLogNavigation: screen('page up at first attachment page enters log navigation').match(/턴 로그|Log navigation|● log /) !== null,
        logNavigationReturnsToComposer: screen('escape returns to composer after log navigation').includes('❯'),
        areaStaysVisibleAfterLongActivity: screen('long activity keeps attachment area pinned').includes('첨부 2건 · 2/2쪽')
          || screen('long activity keeps attachment area pinned').includes('Attachments 2 · page 2/2'),
        longPathStaysVisibleAfterLongActivity: attachmentViewportText('long activity keeps attachment area pinned').length > 0,
        attachmentAddedAfterOpenRefreshesCount: screenWithoutLayout('third attachment selected refreshes area').includes('첨부3건·2/3쪽')
          || screenWithoutLayout('third attachment selected refreshes area').includes('Attachments3·page2/3'),
        attachmentAddedAfterOpenIsReachable: newAttachmentPathAcrossPages.includes('long-segment-0') && newAttachmentPathAcrossPages.includes('long-segment-5')
          && newAttachmentPathAcrossPages.includes('iso') && newAttachmentPathAcrossPages.endsWith('/c.txt'),
        dropRemovesOnlySecondPath: !(attachmentViewportText('second attachment dropped').includes('[attached2:b.txt]') || attachmentViewportText('second attachment dropped').includes('[attached 2: b.txt]'))
          && (attachmentViewportText('second attachment dropped').includes('[attached1:a.txt]') || attachmentViewportText('second attachment dropped').includes('[attached 1: a.txt]')),
        clearRemovesLastPath: !(attachmentViewportText('attachment area cleared').includes('[attached1:a.txt]') || attachmentViewportText('attachment area cleared').includes('[attached 1: a.txt]')),
        emptyListClearsPreviousArea: !(attachmentViewportText('empty attachment area').includes('[attached1:a.txt]') || attachmentViewportText('empty attachment area').includes('[attached 1: a.txt]')),
        exitedClean: run.exitCode === 0,
      },
    };
  }

  if (spec.scenario === 'next-new-session' || spec.scenario === 'next-clear-session') {
    const newSessionCommand = spec.scenario === 'next-clear-session' ? '/clear' : '/new';
    // Step 1–2: two turns · step 3: /new · step 4: one turn · step 5: a turn with /new typed while it is busy.
    let oldId = '';
    const steps: SeatPtyStep[] = [
      { label: 'after message 1', text: '첫 메시지', until: done(1) },
      { label: 'before /new (2 messages)', text: '둘째 메시지', until: done(2) },
      { label: `after ${newSessionCommand}`, text: newSessionCommand, until: (s) => /New chat · previous = [0-9a-f]{8}/.test(s) },
      { label: 'after message 3 (new session)', text: '셋째 메시지', until: done(1, '셋째 메시지') },
      // `/new` lands while the 4th turn is in flight: the TUI must refuse it and keep the session.
      { label: `busy ${newSessionCommand}`, chunks: ['넷째 메시지', '\r', `${newSessionCommand}\r`], until: (s) => s.includes('응답 중에는 /new') || done(2, '넷째 메시지')(s) },
      { label: 'after busy turn', until: done(2, '넷째 메시지') },
    ];
    const run = await mockSeatPtySequence({ ...base, steps });
    const ids = withStore(root, () => ({ active: getActiveSessionId() ?? '' }));
    const logs = readLogs(spec, 'tui.next,llm.route-decision');
    const events = logs.lines.map((l) => { try { return JSON.parse(l) as { category?: string; event?: string; data?: string }; } catch { return {}; } });
    const sessionNew = events.filter((e) => e.category === 'tui.next' && e.event === 'session-new');
    const firstNew = sessionNew[0];
    const parsed = parseData<{ from: string; to: string }>(firstNew?.data);
    const fromTo = { from: parsed.from ?? '', to: parsed.to ?? '' };
    oldId = fromTo.from;
    const store = { oldId, newId: fromTo.to, active: ids.active, oldUser: oldId ? userTexts(root, oldId) : [], newUser: fromTo.to ? userTexts(root, fromTo.to) : [] };
    const routes = events.filter((e) => e.category === 'llm.route-decision' && e.event === 'local-chat-executed').map((e) => parseData<{ provider: string; sessionId: string }>(e.data));
    const afterNew = run.frames.find((f) => f.label === `after ${newSessionCommand}`)?.screen ?? '';
    const checks = {
      screenClearedWithNewTitle: afterNew.includes('New chat · previous =') && !afterNew.includes('첫 메시지') && !afterNew.includes(reply),
      statusNamesPrevious: Boolean(oldId) && afterNew.includes(`New chat · previous = ${oldId.slice(0, 8)}`),
      sessionNewObservedOnce: sessionNew.length === 1,
      nextTurnInNewSession: routes.length >= 3 && routes[2]?.sessionId === fromTo.to && routes[0]?.sessionId === oldId,
      oldSessionKept: JSON.stringify(store.oldUser) === JSON.stringify(['첫 메시지', '둘째 메시지']),
      busyNewRejected: events.some((e) => e.category === 'tui.next' && e.event === 'session-new-rejected'),
      busyKeptSession: ids.active === fromTo.to && JSON.stringify(store.newUser) === JSON.stringify(['셋째 메시지', '넷째 메시지']),
      onlyFakeProvider: routes.length > 0 && routes.every((r) => r.provider === 'test-fake-llm'),
      exitedClean: run.exitCode === 0,
    };
    return { scenario: spec.scenario, universe: root, run, store, logs, checks };
  }

  if (spec.scenario === 'next-resume') return runNextResumeScenario(spec, root, base, reply, done);

  if (spec.scenario === 'next-tool-fold') return runNextToolFoldScenario(spec, root, base);
  if (spec.scenario === 'next-esc-confirm-long-shell') return runNextEscConfirmLongShellScenario(spec, root, base, reply, done);
  if (spec.scenario === 'next-tool-fold-read') return runNextToolFoldReadScenario(spec, root, base, done);
  if (spec.scenario === 'next-queue') return runNextQueueScenario(spec, root, base, reply, done);
  if (spec.scenario === 'next-proactive-continue') return runNextProactiveContinueScenario(spec, root, base);
  if (spec.scenario === 'next-wakeup') return runNextWakeupScenario(spec, root, base, reply, done);
  if (spec.scenario === 'next-paste') return runNextPasteScenario(spec, root, base, reply);
  if (spec.scenario === 'next-goal-continue') return runNextGoalContinueScenario(spec, root, base);
  if (spec.scenario === 'next-goal-interim') return runNextGoalInterimScenario(spec, root, base);

  // next-compact: 12 × ~3k tokens ≈ 36k > 0.85 × 32k (the fake model's default window) seeded
  // through the real session store, then one turn (auto) and one `/compact` (manual).
  const id = withStore(root, () => {
    const sid = createSession({ source: 'tui' }).id;
    for (let i = 0; i < 12; i++) {
      appendMessage(sid, { role: i % 2 === 0 ? 'user' : 'assistant', content: `${i}:${'x'.repeat(12_000)}`, ts: new Date().toISOString() });
    }
    setActiveSessionId(sid);
    return sid;
  });
  const steps: SeatPtyStep[] = [
    { label: 'after turn (auto compact)', text: '긴 대화 뒤 질문', until: (s) => count(s, reply) === 1 && /Compacted 12→\d+ messages/.test(s) && s.includes('❯ ') },
    { label: 'after /compact', text: '/compact', until: (s) => /(압축 \d+→\d+ 메시지|Compacted \d+→\d+ messages)/.test(s) && s.includes('❯ ') },
  ];
  const run = await mockSeatPtySequence({
    ...base,
    // A bare Next launch intentionally starts a fresh conversation. This scenario
    // exercises compaction of the seeded one, so attach to it explicitly.
    args: [spec.entry, '--config-dir', '{root}', '--test-state-dir', '{root}', '--resume', id, '--tui', 'next'],
    ready: { label: 'before (12 seeded messages)', until: (s) => base.ready.until(s) && s.includes('xxxx') },
    steps,
  });
  const logs = readLogs(spec, 'tui.next,llm.route-decision');
  const events = logs.lines.map((l) => { try { return JSON.parse(l) as { category?: string; event?: string; data?: string }; } catch { return {}; } });
  const compacts = events.filter((e) => e.category === 'tui.next' && e.event === 'compact').map((e) => parseData<{ auto: boolean; before: number; after: number; ms: number }>(e.data));
  const routes = events.filter((e) => e.category === 'llm.route-decision' && e.event === 'local-chat-executed').map((e) => parseData<{ provider: string }>(e.data));
  const stored = withStore(root, () => loadSession(id)?.messages ?? []);
  const summary = stored.find((m) => m.role === 'system' && m.content.includes('<context_summary>'));
  const auto = compacts.filter((c) => c.auto);
  const manual = compacts.filter((c) => !c.auto);
  const checks = {
    autoCompactOnce: auto.length === 1 && Number(auto[0]!.before) > Number(auto[0]!.after),
    autoBeforeIsSeeded12: auto[0]?.before === 12,
    manualCompactOnce: manual.length === 1 && Number(manual[0]!.before) > Number(manual[0]!.after),
    screenShowsAuto: /Compacted 12→\d+ messages/.test(run.frames.find((f) => f.label === 'after turn (auto compact)')?.screen ?? ''),
    summaryFromFakeLlm: Boolean(summary?.content.includes(reply)),
    onlyFakeProvider: routes.length > 0 && routes.every((r) => r.provider === 'test-fake-llm'),
    exitedClean: run.exitCode === 0,
  };
  return { scenario: spec.scenario, universe: root, run, store: { sessionId: id, messages: stored.length, summaryHead: summary?.content.slice(0, 80) ?? null }, logs, checks };
}

async function runNextResumeScenario(spec: NextTuiScenarioSpec, root: string, base: ScenarioBase, reply: string, done: Done): Promise<NextTuiScenarioResult> {
  const seeded = withStore(root, () => {
    const from = createSession({ source: 'tui', title: '현재 대화' }).id;
    appendMessage(from, { role: 'user', content: '현재 대화 기록', ts: new Date().toISOString() });
    appendMessage(from, { role: 'assistant', content: '현재 답변', ts: new Date().toISOString() });
    const target = createSession({ source: 'tui', title: '저장된 n8n 설명' }).id;
    appendMessage(target, { role: 'user', content: '저장된 n8n 맥락', ts: new Date().toISOString() });
    appendMessage(target, { role: 'assistant', content: '저장된 답변', ts: new Date().toISOString() });
    setActiveSessionId(from);
    return { from, target };
  });
  const steps: SeatPtyStep[] = [
    { label: 'after /resume list', text: '/resume', until: (s) => s.includes(seeded.target.slice(0, 8)) && s.includes('저장된 n8n 설명') },
    { label: 'after /resume load', text: `/resume ${seeded.target.slice(0, 8)}`, until: (s) => s.includes(`Resuming chat · ${seeded.target.slice(0, 8)}`) && s.includes('저장된 n8n 맥락') },
    { label: 'after resumed turn', text: '이어진 대화 확인', until: done(1, '이어진 대화 확인') },
  ];
  const run = await mockSeatPtySequence({ ...base, steps });
  const current = withStore(root, () => getActiveSessionId() ?? '');
  const logs = readLogs(spec, 'tui.next,llm.route-decision');
  const events = parseEvents(logs);
  const listEvents = events.filter((e) => e.category === 'tui.next' && e.event === 'session-resume-list');
  const resumeEvents = events.filter((e) => e.category === 'tui.next' && e.event === 'session-resume');
  const listed = parseData<{ from: string }>(listEvents[0]?.data);
  const resume = parseData<{ from: string; to: string }>(resumeEvents[0]?.data);
  const routes = events.filter((e) => e.category === 'llm.route-decision' && e.event === 'local-chat-executed').map((e) => parseData<{ provider: string; sessionId: string }>(e.data));
  const listScreen = run.frames.find((f) => f.label === 'after /resume list')?.screen ?? '';
  const loadScreen = run.frames.find((f) => f.label === 'after /resume load')?.screen ?? '';
  const store = {
    from: seeded.from,
    target: seeded.target,
    active: current,
    oldUser: userTexts(root, seeded.from),
    targetUser: userTexts(root, seeded.target),
  };
  const checks = {
    listDisplaysSavedSession: listEvents.length === 1 && listScreen.includes(seeded.target.slice(0, 8)) && listScreen.includes('저장된 n8n 설명'),
    selectedSessionBecomesActive: current === seeded.target && resumeEvents.length === 1
      && Boolean(listed.from) && resume.from === listed.from && resume.to === seeded.target,
    resumedHistoryRenders: loadScreen.includes('저장된 n8n 맥락') && loadScreen.includes('저장된 답변'),
    oldSessionPreserved: JSON.stringify(store.oldUser) === JSON.stringify(['현재 대화 기록']),
    newTurnUsesResumedSession: routes.length === 1 && routes[0]?.sessionId === seeded.target && store.targetUser.includes('이어진 대화 확인'),
    onlyFakeProvider: routes.length === 1 && routes.every((r) => r.provider === 'test-fake-llm'),
    exitedClean: run.exitCode === 0,
  };
  return { scenario: spec.scenario, universe: root, run, store, logs, checks };
}

type ScenarioBase = Omit<Parameters<typeof mockSeatPtySequence>[0], 'steps'> & { env: Record<string, string> };
type Done = (n: number, also?: string) => (s: string) => boolean;
type LogEvent = { id?: number; category?: string; event?: string; data?: string; ts?: string };

function parseEvents(logs: NextTuiScenarioResult['logs']): LogEvent[] {
  return logs.lines.map((l) => { try { return JSON.parse(l) as LogEvent; } catch { return {}; } });
}

function onlyFake(events: LogEvent[]): boolean {
  const routes = events.filter((e) => e.category === 'llm.route-decision' && e.event === 'local-chat-executed').map((e) => parseData<{ provider: string }>(e.data));
  return routes.length > 0 && routes.every((r) => r.provider === 'test-fake-llm');
}

function activeUserTexts(root: string): { id: string; user: string[] } {
  const id = withStore(root, () => getActiveSessionId() ?? '');
  return { id, user: id ? userTexts(root, id) : [] };
}

/** TUI-NEXT-QUEUE-AND-WAKE ① — two sentences and a draft typed while one slow turn runs; Esc aborts the turn, the queued sentence wakes as the next turn, and the unsent draft stays. */
async function runNextQueueScenario(spec: NextTuiScenarioSpec, root: string, base: ScenarioBase, reply: string, done: Done): Promise<NextTuiScenarioResult> {
  const slow = '천천히';
  const steps: SeatPtyStep[] = [
    // One slow turn; while it runs: two submissions and an unsent draft.
    { label: 'busy with two queued', chunks: [`첫 질문 ${slow}`, '\r', '둘째 질문', '\r', '셋째 질문', '\r', '쓰던 초안'], gapMs: 300, until: (s) => (/(대기 2|2 queued|2 steer pending)/.test(s) || (s.includes('1 steer pending') && s.includes('1 queued'))) && s.includes('쓰던 초안') }, // #38392 영어 크롬 — 큐 카운터 표기 둘 다 승인
    { label: 'after settle', until: (s) => done(3)(s) && s.includes('셋째 질문') && s.includes('쓰던 초안')
      && !/(?:대기 [1-9]|[1-9]+ (?:queued|steer pending))/.test(s), timeoutMs: 60_000 }, // #38392 — 잔여 큐 표기 둘 다 배제
    // The draft becomes a slow turn; one more is queued behind it. Esc aborts this
    // ordinary chat turn; the queued sentence wakes as the next turn (queue-dispatched)
    // and the unsent draft stays in the composer — same contract as A200 (entry-steer-pty).
    { label: 'slow draft turn started', text: ` ${slow}`, until: (s) => s.includes('slow draft') || (s.includes('응답을 준비하고 있습니다.') && s.match(/턴 스트리밍|Responding|Thinking/) !== null) || /Thinking|turn streaming|running|Responding/.test(s), timeoutMs: 30_000 }, // #38392/#73315 영어 크롬 — 실측 표기(Responding, stall 본문 slow draft)와 기존 표기 모두 승인
    { label: 'fifth turn queued', text: '다섯째', until: (s) => /(대기 1|1 queued|1 steer pending)/.test(s), timeoutMs: 10_000 }, // #38392
    { label: 'unsent draft stays behind queue', text: '미전송 초안', enter: false, until: (s) => /(대기 1|1 queued|1 steer pending)/.test(s) && s.includes('미전송 초안'), timeoutMs: 10_000 }, // #38392
    // Source: .rules/30-harness/testing-gates.md — immediate Esc recovery has a two-second upper bound.
    // #38392/#73315 — 중단 배너 둘 다 승인; 깨어난 큐 문장의 응답과 잔류 초안이 2초 창 안에 보여야 한다.
    { label: 'esc aborts; queued sentence wakes, draft stays', keys: '\x1b', until: (s) => (s.includes('이 턴을 중단했습니다') || /Stopped after/.test(s)) && s.includes('다섯째') && s.includes('미전송 초안') && !s.includes('응답 중단 확인'), timeoutMs: 2_000 },
  ];
  const run = await mockSeatPtySequence({
    ...base,
    // Keep earlier turns deterministic and hold only the slow-draft response until Esc aborts it.
    env: {
      ...base.env,
      [TEST_FAKE_LLM_DELAY_MS_ENV]: '6000',
      [TEST_FAKE_LLM_DELAY_WHEN_ENV]: '첫 질문 천천히',
      [TEST_FAKE_LLM_SCRIPT_ENV]: 'ok,ok,ok,stall:slow draft held',
      // 부팅 계획 턴(«evidence ladder» 프롬프트)은 스크립트 칸을 덜어가지 않게 — 스톨이 늦은 턴에만 붙는다.
      [TEST_FAKE_LLM_SCRIPT_SKIP_WHEN_ENV]: 'evidence ladder',
    },
    steps,
  });
  const logs = readLogs(spec, 'tui.next,llm.route-decision');
  const events = parseEvents(logs);
  const store = activeUserTexts(root);
  const frame = (label: string) => run.frames.find((f) => f.label === label)?.screen ?? '';
  const escFrame = frame('esc aborts; queued sentence wakes, draft stays');
  const escLines = escFrame.split('\n');
  const lastComposerIndex = escLines.reduce((last, line, index) => line.startsWith('❯') ? index : last, -1);
  const composerLines = escLines.slice(lastComposerIndex, lastComposerIndex + 1).map(line => line.trim()); // #38392 footer moves below composer — composer = last ❯ line
  const queueDispatchedEvents = events.filter((event) => event.category === 'tui.next' && event.event === 'queue-dispatched');
  const queueDispatchData = parseData<{ remaining: number }>(queueDispatchedEvents.at(-1)?.data);
  const checks = {
    queueShownWhileBusy: /(대기 2|2 queued|2 steer pending)/.test(frame('busy with two queued')) || (frame('busy with two queued').includes('1 steer pending') && frame('busy with two queued').includes('1 queued')), // #38392
    userTurnsInOrder: JSON.stringify(store.user.slice(0, 3)) === JSON.stringify([`첫 질문 ${slow}`, '둘째 질문', '셋째 질문']),
    threeReplies: count(frame('after settle'), reply) === 3,
    draftKept: (frame('after settle').split('\n').find((line) => line.startsWith('❯')) ?? '').includes('쓰던 초안'), // #38392 footer moves below composer
    escWakesQueuedTurn: (escFrame.includes('이 턴을 중단했습니다') || /Stopped after/.test(escFrame))
      && store.user.some((u) => u.endsWith('다섯째')) && count(escFrame, reply) >= 1, // 큐 문장이 다음 턴의 사용자 콘텐츠로 보존 — 유실 없음(중단 문맥 노트가 앞에 붙어도 문장은 꼬리로 남는다; 탐침 실측)
    escCancelsWithoutShellConfirmation: !escFrame.includes('응답 중단 확인'),
    escKeepsUnsentDraft: composerLines[0] === '❯ 미전송 초안',
    queueDispatchEventCarriesWake: queueDispatchedEvents.length === 3 && queueDispatchData?.remaining === 0, // 둘째·셋째(정착 뒤) ⊕ 큐 문장(Esc 뒤)
    onlyFakeProvider: onlyFake(events),
    exitedClean: run.exitCode === 0,
  };
  return { scenario: spec.scenario, universe: root, run, store, logs, checks };
}

/** TUI-PROACTIVE-CONTINUE — unfinished in-scope work continues; human-only work stops; repeated remainder stops. */
async function runNextProactiveContinueScenario(spec: NextTuiScenarioSpec, root: string, base: ScenarioBase): Promise<NextTuiScenarioResult> {
  const cases = [
    { name: 'remaining', prompt: '요청한 파일을 천천히 끝까지 확인해줘', reply: '남은 작업: 자막 검증을 아직 확정하지 못했습니다.', turns: 3 },
    { name: 'human', prompt: '남은 것도 계속해줘', reply: '로그인이 필요합니다. 로그인해 주세요.', turns: 1 },
    { name: 'cap', prompt: '요청한 자막 검증을 반복해서 끝내줘', reply: '남은 작업: 자막 검증 {step}단계는 아직 완료되지 않았습니다.', turns: 4 },
    { name: 'buffer', prompt: '천천히 확인해줘', reply: '남은 작업: 파일 확인을 아직 마치지 못했습니다.', turns: 1 },
  ] as const;
  const results: Array<{ name: string; run: SeatPtySequenceEvidence; store: ReturnType<typeof activeUserTexts>; logs: NextTuiScenarioResult['logs'] }> = [];
  for (const c of cases) {
    const caseRoot = join(root, c.name);
    mkdirSync(caseRoot, { recursive: true });
    writeFileSync(join(caseRoot, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const caseSpec = { ...spec, root: caseRoot };
    const caseBase = { ...base, root: caseRoot, args: [spec.entry, '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'], env: { ...base.env, [TEST_FAKE_LLM_RESPONSE_ENV]: c.reply, ...(c.name === 'remaining' || c.name === 'buffer' ? { [TEST_FAKE_LLM_DELAY_MS_ENV]: c.name === 'buffer' ? '4000' : '1500', [TEST_FAKE_LLM_DELAY_WHEN_ENV]: '천천히' } : {}) } };
    const steps: SeatPtyStep[] = c.name === 'remaining'
      ? [
        { label: 'remaining: user input queues before turn boundary', chunks: [c.prompt, '\r', '검증 결과를 먼저 보여줘', '\r'], gapMs: 300, until: (s) => s.includes('대기 1'), timeoutMs: 30_000 },
        { label: 'remaining: queued user turn is next', until: (s) => count(s, c.reply) >= 2 && isSettledNextTuiScreen(s), timeoutMs: 30_000 },
        { label: 'remaining: auto continuation settled', until: (s) => count(s, c.reply) >= c.turns && isSettledNextTuiScreen(s), timeoutMs: 30_000 },
      ]
      : c.name === 'cap'
      ? [{ label: 'cap: three automatic turns stop', text: c.prompt, until: (s) => s.includes('골 이어가기 상한(3회 연속)') && isSettledNextTuiScreen(s), timeoutMs: 60_000 }]
      : c.name === 'buffer'
        ? [
          { label: 'buffer: draft typed while the turn is busy', chunks: [c.prompt, '\r', '미전송 초안'], gapMs: 300, until: (s) => (s.includes('응답 중') || s.match(/턴 스트리밍|Responding|Thinking/) !== null) && s.includes('미전송 초안'), timeoutMs: 30_000 },
          { label: 'buffer: response ends with draft preserved', until: (s) => s.includes(c.reply) && s.includes('미전송 초안') && isSettledNextTuiScreen(s), timeoutMs: 30_000 },
        ]
      : [{ label: `${c.name}: human turn`, text: c.prompt, until: (s) => count(s, c.reply) >= 1 && isSettledNextTuiScreen(s), timeoutMs: 30_000 }];
    const run = await mockSeatPtySequence({ ...caseBase, steps });
    results.push({ name: c.name, run, store: activeUserTexts(caseRoot), logs: readLogs(caseSpec, 'tui.next,tui.proactive,tui.goal-continue,tui.autoturn,llm.route-decision') });
  }
  const events = results.flatMap((r) => parseEvents(r.logs));
  const proactive: Array<{ event?: string; reason?: string; cap?: number; autoTurn?: number; bufferedChars?: number }> = events
    .filter((e) => e.category === 'tui.proactive')
    .map((e) => ({ event: e.event, ...parseData<{ reason: string; cap: number; autoTurn: number; bufferedChars: number }>(e.data) }));
  const humanUsers = results.find((r) => r.name === 'human')?.store.user ?? [];
  const remainingUsers = results.find((r) => r.name === 'remaining')?.store.user ?? [];
  const queuedFrame = results.find((r) => r.name === 'remaining')?.run.frames.find((f) => f.label.includes('queued user turn is next'))?.screen ?? '';
  const autoFrame = results.find((r) => r.name === 'remaining')?.run.frames.find((f) => f.label.includes('auto continuation settled'))?.screen ?? '';
  const bufferCase = results.find((r) => r.name === 'buffer');
  const bufferEvents = bufferCase ? parseEvents(bufferCase.logs) : [];
  const nextQueueDispatched = events.findIndex((e) => e.category === 'tui.next' && e.event === 'queue-dispatched');
  const autoContinuedAfterQueue = events.findIndex((e, i) => i > nextQueueDispatched && e.category === 'tui.proactive' && e.event === 'continue');
  const combinedLines = results.flatMap((r) => r.logs.lines);
  const logs: NextTuiScenarioResult['logs'] = {
    command: results.map((r) => r.logs.command).join(' ⊕ '), rc: results.every((r) => r.logs.rc === 0) ? 0 : 1,
    lines: combinedLines, eventCount: combinedLines.filter((l) => l.trimStart().startsWith('{') && !l.includes('"_meta"')).length, limit: 400,
  };
  const run = { ...results[0]!.run, frames: results.flatMap((r) => r.run.frames.map((f) => ({ ...f, label: `${r.name}: ${f.label}` }))), exitCode: results.every((r) => r.run.exitCode === 0) ? 0 : 1 };
  return {
    scenario: spec.scenario, universe: root, run,
    store: { remainingUsers, humanUsers, proactiveEvents: proactive }, logs,
    checks: {
      queuedUserInputWonBoundary: proactive.some((e) => e.event === 'yield-user-input') && nextQueueDispatched >= 0 && autoContinuedAfterQueue > nextQueueDispatched && queuedFrame.includes('❯ 검증 결과를 먼저 보여줘'),
      remainingWorkContinued: proactive.some((e) => e.event === 'continue' && e.reason === 'work-remaining') && autoFrame.includes('↻ 자동 재개(goal-continue)'),
      repeatedRemainderStopped: proactive.some((e) => e.event === 'stop-no-progress' && e.reason === 'same-remaining'),
      humanWorkStopped: proactive.some((e) => e.event === 'stop-human' && e.reason === 'human-action') && results.find((r) => r.name === 'human')?.run.frames.at(-1)?.screen.includes('로그인이 필요합니다') === true,
      autoTurnCapStopsInPractice: DEFAULT_GOAL_CONTINUE_CAP === 3 && proactive.some((e) => e.event === 'stop-cap' && e.cap === 3 && e.autoTurn === 3)
        && results.find((r) => r.name === 'cap')?.run.frames.at(-1)?.screen.includes('골 이어가기 상한(3회 연속)') === true,
      typedBufferWinsAndStaysVisible: bufferEvents.some((e) => e.category === 'tui.proactive' && e.event === 'yield-user-input' && (parseData<{ bufferedChars: number }>(e.data).bufferedChars ?? 0) > 0)
        && bufferCase?.run.frames.at(-1)?.screen.includes('미전송 초안') === true
        && !bufferEvents.some((e) => e.category === 'tui.proactive' && e.event === 'continue'),
      onlyFakeProvider: events.filter((e) => e.category === 'llm.route-decision' && e.event === 'local-chat-executed').every((e) => parseData<{ provider: string }>(e.data).provider === 'test-fake-llm'),
      isolatedLogsRead: logs.rc === 0 && logs.eventCount > 0,
      exitedClean: results.every((r) => r.run.exitCode === 0),
    },
  };
}

/** TUI-NEXT-QUEUE-AND-WAKE ② — a turn calls ScheduleWakeup(60s); a slow human turn covers the due time
 *  (NotIdle → deferred a minute), then the wakeup opens one internal turn on its own. */
async function runNextWakeupScenario(spec: NextTuiScenarioSpec, root: string, base: ScenarioBase, reply: string, done: Done): Promise<NextTuiScenarioResult> {
  const banner = /자동 재개\(scheduled\)|Resuming \(scheduled check\)/; // #38144 영어 크롬 — 배너 둘 다 승인(독립 리터럴)
  const steps: SeatPtyStep[] = [
    {
      label: 'scheduled',
      text: '60초 뒤 예약해줘',
      until: (s) => done(1)(s) && s.includes('⏰ 예약 깨움'),
    },
    { label: 'busy over the due time', text: '긴 작업 하나', until: (s) => /(응답 중|턴 스트리밍|running|turn streaming|Thinking)/.test(s), timeoutMs: 30_000 }, // #38392 영어 크롬
    { label: 'long turn done', until: done(2, '긴 작업 하나'), timeoutMs: 30_000 },
    { label: 'woke after one deferral', until: (s) => banner.test(s) && done(3)(s), timeoutMs: 30_000 },
  ];
  const run = await mockSeatPtySequence({
    ...base,
    env: {
      ...base.env,
      ELANOUS_TEST_FAST_WAKEUP_CLOCK: '1',
      [TEST_FAKE_LLM_TOOL_CALL_ENV]: JSON.stringify({ when: '예약해줘', name: 'ScheduleWakeup', args: { delaySeconds: 60, reason: '점검' } }),
      [TEST_FAKE_LLM_DELAY_MS_ENV]: '6000',
      [TEST_FAKE_LLM_DELAY_WHEN_ENV]: '긴 작업',
    },
    steps,
  });
  const logs = readLogs(spec, 'tui.wakeup,tui.autoturn,llm.route-decision');
  const events = parseEvents(logs);
  const wake = (event: string) => events.filter((e) => e.category === 'tui.wakeup' && e.event === event).map((e) => parseData<{ id: string; reason: string }>(e.data));
  const opened = events.filter((e) => e.category === 'tui.autoturn' && e.event === 'opened').map((e) => parseData<{ origin: string }>(e.data));
  const store = activeUserTexts(root);
  const checks = {
    scheduledOnce: wake('scheduled').length === 1,
    noticeOnScreen: (run.frames.find((f) => f.label === 'scheduled')?.screen ?? '').includes('⏰ 예약 깨움'),
    deferredWhileBusy: wake('rejected').some((r) => r.id === 'w1' && r.reason === 'NotIdle'),
    firedOnce: wake('fired').length === 1,
    internalTurnOpened: opened.length === 1 && opened[0]?.origin === 'scheduled',
    bannerOnScreen: banner.test(run.frames.at(-1)?.screen ?? ''),
    wakeTurnStored: store.user.some((t) => t.startsWith('[예약 깨움 w1] 점검')),
    onlyFakeProvider: onlyFake(events),
    exitedClean: run.exitCode === 0,
  };
  return { scenario: spec.scenario, universe: root, run, store: { ...store, reply }, logs, checks };
}

/** TUI-NEXT-FOLD-DEFAULT — real Bash tool call; both progressive MessageBlock and saved tool row are selectable. */
export const NEXT_TOOL_FOLD_COMMAND = "seq -f fold-line-%02g 0 29; printf 'fold-stderr-marker\\n' >&2; exit 7";
async function runNextToolFoldScenario(spec: NextTuiScenarioSpec, root: string, base: ScenarioBase): Promise<NextTuiScenarioResult> {
  const ask = '도구 출력 접기 시험';
  const summaryRe = /^▸ (도구|tool) · Bash 결과$|^✓ Bash\(/m; // #38144 — 완료 카드(✓ Bash) · 접힘 요약(옛 한국어 ▸ 도구 · / #38058 영문화 ▸ tool · ) 둘 다
  // Whole stored session, read at the moment each screen is reached: before the toggles and after both.
  const snapshot = (): string => withStore(root, () => {
    const sid = getActiveSessionId() ?? '';
    return sid ? JSON.stringify({ sid, messages: loadSession(sid)?.messages ?? null }) : '';
  });
  let beforeToggle = '';
  let afterToggles = '';
  const steps: SeatPtyStep[] = [
    {
      label: 'after tool turn (folded)', text: ask, timeoutMs: 60_000,
      until: (s) => { const ok = isSettledNextTuiScreen(s) && summaryRe.test(s); if (ok && !beforeToggle) beforeToggle = snapshot(); return ok; },
    },
      // #38802 듀얼 승인(r13 실측): 11-18 크롬은 로그 내비게이션을 하단 상태줄 «● log Ns · …» 로 표기한다(entry.test.ts:2573 «● log» 계약 프레임). 옛 라벨과 함께 승인.
      { label: 'log focus (PageUp)', keys: '\x1b[5~', until: (s) => s.match(/턴 로그|Log navigation|● log /) !== null },
    // #38802(r15 실측): 로그 포커스의 Enter/Space는 2상태 토글이라 L1→L2→L3→접힘 순환이 불가하다(entry.ts:2905-2923).
    // 4단계 상세는 Tab/F로 밟는다(마우스 4클릭 순환과 같은 계약). L1 술어는 펼침 마커 ▾까지 요구한다.
    // #38802(r17 탐침 실측): 42-커밋 catch-up 뒤 턴 기록 앞에 status 블록 2개가 추가됐다(run-core-turn.ts:924 계획 상태).
    // Tab은 status1→status2→tool 순으로 대상을 밟고 이후 tool이 incomplete 집중이다. L1까지 3Tab, L2·L3·접힘은 각 1Tab.
    { label: 'L1 summary (Tab)', keys: '\t\t\t', until: (s) => (/▾ (도구|tool) · Bash 결과/.test(s) && !s.includes('호출 인자 전달')), timeoutMs: 15_000 },
    { label: 'L2 steps (Tab)', keys: '\t', until: (s) => s.includes('호출 인자 전달') && s.includes('도구 결과 수신'), timeoutMs: 15_000 },
    { label: 'L3 raw reference (Tab)', keys: '\t', until: (s) => s.includes('fold-stderr-marker') && s.includes('종료 상태') && s.includes('입력'), timeoutMs: 15_000 },
    {
      label: 'fold row after key cycle', keys: '\t', timeoutMs: 15_000,
      until: (s) => /^▸ (도구|tool) · Bash 결과$/m.test(s) && !s.includes('fold-line-25'),
    },
    { label: 'folded again view (PageUp)', keys: '\x1b[5~\x1b[5~\x1b[5~\x1b[5~', timeoutMs: 15_000,
      until: (s) => { const ok = summaryRe.test(s) && /^▸ (도구|tool) · Bash 결과$/m.test(s); if (ok && !afterToggles) afterToggles = snapshot(); return ok; } },
  ];
  const run = await mockSeatPtySequence({
    ...base,
    env: {
      ...base.env,
      [TEST_FAKE_LLM_TOOL_CALL_ENV]: JSON.stringify({ when: ask, name: 'Bash', args: { command: NEXT_TOOL_FOLD_COMMAND } }),
    },
    steps,
  });
  const logs = readLogs(spec, 'tui.next,llm.route-decision');
  const events = parseEvents(logs);
  const id = withStore(root, () => getActiveSessionId() ?? '');
  const stored = id ? withStore(root, () => loadSession(id)?.messages ?? []) : [];
  const tool = stored.find((m) => m.role === 'tool');
  const result = typeof tool?.toolResult === 'string' ? tool.toolResult : '';
  // The Bash tool stores a JSON envelope ({stdout, output, exitCode, …}); its stdout must be the 30 lines `seq` printed.
  const stdoutLines = (() => {
    try { const parsed = JSON.parse(result) as { stdout?: unknown }; return typeof parsed.stdout === 'string' ? parsed.stdout.trimEnd().split('\n') : []; } catch { return result.trimEnd().split('\n'); }
  })();
  const screen = (label: string) => run.frames.find((f) => f.label === label)?.screen ?? '';
  const folded0 = screen('after tool turn (folded)');
  const folded1 = screen('folded again view (PageUp)');
  const expanded = screen('L3 raw reference (Tab)');
  const checks = {
    // The 30 lines come from the Bash tool actually running in the turn loop.
    realToolResultStored: tool?.toolName === 'Bash' && stdoutLines.length === 30
      && stdoutLines.every((l, i) => l === `fold-line-${String(i).padStart(2, '0')}`),
    collapsedAfterTurn: summaryRe.test(folded0) && !folded0.includes('fold-line-12'),
    summaryAtL1: screen('L1 summary (Tab)').includes('도구 · Bash 결과') || screen('L1 summary (Tab)').includes('tool · Bash 결과'),
    stepsAtL2: screen('L2 steps (Tab)').includes('호출 인자 전달'),
    expandedOnL3: expanded.includes('fold-stderr-marker')
      && /종료 상태\s+7/.test(expanded) && !summaryRe.test(expanded),
    foldedAgainOnEnter: summaryRe.test(folded1) && (folded1.includes('▸ 도구 Bash ·') || folded1.includes('▸ tool · Bash 결과')),
    // Fold state is screen-only: the whole stored session read right after the first folded screen
    // equals the one read right after the second Enter (and it holds the real tool result).
    sessionUnchanged: beforeToggle !== '' && beforeToggle === afterToggles && beforeToggle.includes('fold-line-29'),
    onlyFakeProvider: onlyFake(events),
    exitedClean: run.exitCode === 0,
  };
  return { scenario: spec.scenario, universe: root, run, store: { sessionId: id, messages: stored.length, toolName: tool?.toolName ?? null, stdoutLines: stdoutLines.length, foldedAs: summaryRe.exec(folded0)?.[0] ?? null, sessionBytesBeforeToggle: beforeToggle.length, sessionBytesAfterToggles: afterToggles.length }, logs, checks };
}

// Source: OP #96145 sets the long-shell confirmation boundary at about five seconds; the PTY waits beyond it.
const LONG_SHELL_PTY_GAP_MS = LONG_SHELL_ESC_CONFIRMATION_MS + 1_000;
// Source: OP #96145 sets the confirmation boundary at about five seconds; keep the fake Bash alive through the Esc prompt.
const LONG_SHELL_PTY_SLEEP_SECONDS = LONG_SHELL_ESC_CONFIRMATION_MS / 1_000 + 3;

async function runNextEscConfirmLongShellScenario(
  spec: NextTuiScenarioSpec,
  root: string,
  base: ScenarioBase,
  reply: string,
  done: Done,
): Promise<NextTuiScenarioResult> {
  const ask = '긴 Bash 중단 확인 시험';
  const shellPidPath = join(root, 'cancelled-shell.pid');
  const shellPidHasExited = (): boolean => {
    if (!existsSync(shellPidPath)) return false;
    const pid = Number(readFileSync(shellPidPath, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return false; }
    catch { return true; }
  };
  const run = await mockSeatPtySequence({
    ...base,
    env: {
      ...base.env,
      [TEST_FAKE_LLM_TOOL_CALL_ENV]: JSON.stringify({
        when: ask, name: 'Bash', args: { command: `printf '%s' "$$" > '${shellPidPath}'; exec sleep ${LONG_SHELL_PTY_SLEEP_SECONDS}` },
      }),
    },
    steps: [
      { label: 'long Bash running', text: ask, until: (screen) => screen.match(/턴 도구 실행|Bash running|Running Bash\(/) !== null },
      {
        label: 'long Bash Esc asks y/N', chunks: ['', '\u001b'], gapMs: LONG_SHELL_PTY_GAP_MS,
        until: (screen) => screen.match(/긴 셸 명령 중단 확인|Confirm stopping long shell/) !== null && screen.match(/y\/n (입력 · 기본 N|answer · default N)/) !== null,
      },
      // #38802 듀얼 승인(r13 실측): 이 크롬은 N 응답 뒤 계속 실행 문구를 그리지 않는다 — 확인 대화창이 닫히고 셸이 여전히 실행 중(⠏ Running Bash)이면 계속 실행으로 인정. 옛 문구가 그려지면 그것으로도 통과.
      { label: 'N keeps Bash running', keys: 'n', until: (screen) => screen.match(/긴 셸 명령 계속 실행|Long shell continues/) !== null || (!screen.match(/긴 셸 명령 중단 확인|Confirm stopping long shell/) && screen.match(/턴 도구 실행|Bash running|Running Bash\(/) !== null) },
      { label: 'N command completes', until: (screen) => done(1)(screen) },
      { label: 'second long Bash running', text: ask, until: (screen) => screen.match(/턴 도구 실행|Bash running|Running Bash\(/) !== null },
      {
        label: 'second long Bash Esc asks y/N', chunks: ['', '\u001b'], gapMs: LONG_SHELL_PTY_GAP_MS,
        until: (screen) => screen.match(/긴 셸 명령 중단 확인|Confirm stopping long shell/) !== null && screen.match(/y\/n (입력 · 기본 N|answer · default N)/) !== null,
      },
      { label: 'y stops Bash turn', keys: 'y', until: (screen) => screen.match(/응답 취소됨|cancelled/) !== null && shellPidHasExited() },
    ],
  });
  const cancelledShellPid = Number(readFileSync(shellPidPath, 'utf8'));
  const logs = readLogs(spec, 'tui.next,llm.route-decision');
  const events = parseEvents(logs);
  const frame = (label: string) => run.frames.find((entry) => entry.label === label)?.screen ?? '';
  const checks = {
    longShellShownWhileRunning: frame('long Bash running').includes('⏺ Bash(') && frame('long Bash running').match(/턴 도구 실행|Bash running|Running Bash\(/) !== null,
    longEscShowsDefaultNInlinePanel: frame('long Bash Esc asks y/N').match(/y\/n (입력 · 기본 N|answer · default N)/) !== null,
    noKeepsTheSameShellRunning: frame('N keeps Bash running').match(/긴 셸 명령 계속 실행|Long shell continues/) !== null || (!frame('N keeps Bash running').match(/긴 셸 명령 중단 확인|Confirm stopping long shell/) && frame('N keeps Bash running').match(/턴 도구 실행|Bash running|Running Bash\(/) !== null),
    declinedShellCompletesNormally: done(1)(frame('N command completes')),
    yesStopsTheSecondTurn: frame('y stops Bash turn').match(/응답 취소됨|cancelled/) !== null,
    cancelledShellProcessExitedAtYConfirmation: Number.isInteger(cancelledShellPid) && cancelledShellPid > 0 && shellPidHasExited(),
    onlyFakeProvider: onlyFake(events),
    exitedClean: run.exitCode === 0,
  };
  return { scenario: spec.scenario, universe: root, run, store: { ask, checks }, logs, checks };
}

/** Lines of the file the Read scenario reads (the 10-22 incident shape: «     1\tfold-line-1 …», 20 lines). */
export const NEXT_TOOL_FOLD_READ_LINES = 20;

/**
 * TUI-NEXT-TOOL-RESULT-RENDER — a real Read tool call over a 20-line file. The stored result is the
 * JSON envelope ({"output":"     1\tfold-line-1\n…","linesRead":20,…}); the log must show it as the
 * file's lines (folded to «▸ 도구 Read · 20줄 (접힘)», then expanded with a «20줄 · NB» status) —
 * never the raw envelope with escaped \n.
 */
async function runNextToolFoldReadScenario(spec: NextTuiScenarioSpec, root: string, base: ScenarioBase, done: Done): Promise<NextTuiScenarioResult> {
  const ask = '읽기 출력 접기 시험';
  const summaryRe = /▸ 도구 Read · 20줄 \(접힘\)|✓ Read\(fold-read\.txt\)/; // #38144 — 완료 카드 · 옛 접힘 셀 둘 다
  const file = join(root, 'fold-read.txt');
  writeFileSync(file, Array.from({ length: NEXT_TOOL_FOLD_READ_LINES }, (_, i) => `fold-line-${i + 1}`).join('\n') + '\n');
  const steps: SeatPtyStep[] = [
    { label: 'after Read turn (folded)', text: ask, timeoutMs: 60_000, until: (s) => done(1)(s) && summaryRe.test(s) },
  ];
  const run = await mockSeatPtySequence({
    ...base,
    env: { ...base.env, [TEST_FAKE_LLM_TOOL_CALL_ENV]: JSON.stringify({ when: ask, name: 'Read', args: { file_path: file } }) },
    steps,
  });
  const logs = readLogs(spec, 'tui.next,llm.route-decision');
  const events = parseEvents(logs);
  const id = withStore(root, () => getActiveSessionId() ?? '');
  const stored = id ? withStore(root, () => loadSession(id)?.messages ?? []) : [];
  const tool = stored.find((m) => m.role === 'tool');
  const result = typeof tool?.toolResult === 'string' ? tool.toolResult : '';
  const envelope = (() => { try { return JSON.parse(result) as { output?: unknown; linesRead?: unknown }; } catch { return null; } })();
  const screen = (label: string) => run.frames.find((f) => f.label === label)?.screen ?? '';
  const folded = screen('after Read turn (folded)');
  const checks = {
    // The stored result is the real Read envelope (one JSON line) — the shape the incident showed raw.
    realReadEnvelopeStored: tool?.toolName === 'Read' && envelope?.linesRead === NEXT_TOOL_FOLD_READ_LINES
      && typeof envelope.output === 'string' && envelope.output.includes('\tfold-line-1\n'),
    collapsedAfterTurn: summaryRe.test(folded) && !folded.includes('fold-line-12'),
    // Read expansion is tracked in NEXT-TUI-FOLD-READ-EXPAND (P1); this PR only guards the folded default.
    noRawEnvelope: !folded.includes('{"output"') && !folded.includes('\\n') && !folded.includes('"linesRead"'),
    onlyFakeProvider: onlyFake(events),
    exitedClean: run.exitCode === 0,
  };
  return { scenario: spec.scenario, universe: root, run, store: { sessionId: id, toolName: tool?.toolName ?? null, resultChars: result.length, foldedAs: summaryRe.exec(folded)?.[0] ?? null }, logs, checks };
}

/** Short and 50-line pastes for TUI-PASTE-ECHO (shared with the classic scenario). */
export const PASTE_SHORT = 'paste-short-hello';
export const PASTE_LONG = Array.from({ length: 50 }, (_, i) => `paste-line-${String(i).padStart(2, '0')}`).join('\n');
export const PASTE_LONG_TOKEN = pasteFoldToken(1, PASTE_LONG);
export const bracketedPaste = (text: string): string => `\x1b[200~${text}\x1b[201~`;
/** Clipboard text the Ctrl+V step reads (through the PATH shim below) — 6 lines, so it folds as paste #2. */
export const CLIP_TEXT = Array.from({ length: 6 }, (_, i) => `clip-line-${i}`).join('\n');
export const CLIP_TOKEN = pasteFoldToken(2, CLIP_TEXT);

/** PATH shims so Ctrl+V reads a known clipboard instead of the person's on macOS and Linux.
 *  The TUI's own clipboard module spawns the platform reader by name from PATH. */
export function clipboardShimPath(root: string): string {
  const bin = join(root, 'clip-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'pbpaste'), `#!/bin/sh\nprintf '%s' '${CLIP_TEXT.replace(/\n/g, '\\n')}' | sed 's/\\\\n/\\n/g'\n`);
  for (const command of ['xclip', 'wl-paste']) {
    writeFileSync(join(bin, command), readFileSync(join(bin, 'pbpaste')));
    chmodSync(join(bin, command), 0o755);
  }
  writeFileSync(join(bin, 'osascript'), '#!/bin/sh\necho no\n');
  chmodSync(join(bin, 'pbpaste'), 0o755);
  chmodSync(join(bin, 'osascript'), 0o755);
  return `${bin}:${process.env.PATH ?? ''}`;
}

/** TUI-PASTE-ECHO — a short bracketed paste shows as typed; a 50-line paste shows one placeholder and the
 *  submitted turn carries the whole original text. */
async function runNextPasteScenario(spec: NextTuiScenarioSpec, root: string, base: ScenarioBase, reply: string): Promise<NextTuiScenarioResult> {
  const settledPaste = (expectedReplies: number) => (screen: string) => screen.split(reply).length - 1 === expectedReplies
    && isSettledNextTuiScreen(screen) && screen.includes('❯ ');
  const steps: SeatPtyStep[] = [
    { label: 'short pasted', keys: bracketedPaste(PASTE_SHORT), until: (s) => s.includes(`❯ ${PASTE_SHORT}`) },
    { label: 'cleared', keys: '\x15', until: (s) => !s.includes(PASTE_SHORT) },
    { label: 'long pasted', keys: bracketedPaste(PASTE_LONG), until: (s) => (s.includes(PASTE_LONG_TOKEN) || s.includes('[Paste #1 · 50 lines · full text]')), timeoutMs: 90_000 },
    { label: 'submitted', keys: '\r', until: settledPaste(1), timeoutMs: 30_000 },
    { label: 'ctrl+v', keys: '\x16', until: (s) => s.includes(CLIP_TOKEN) || /\[Paste #\d+ · 6 lines · full text\]/.test(s) },
    { label: 'clip submitted', keys: '\r', until: settledPaste(2), timeoutMs: 30_000 },
  ];
  const run = await mockSeatPtySequence({ ...base, env: { ...base.env, PATH: clipboardShimPath(root) }, steps });
  const logs = readLogs(spec, 'tui.paste,llm.route-decision');
  const events = parseEvents(logs);
  const store = activeUserTexts(root);
  const screen = (label: string) => run.frames.find((f) => f.label === label)?.screen ?? '';
  const paste = (event: string) => events.filter((e) => e.category === 'tui.paste' && e.event === event).map((e) => parseData<{ lines: number; chars: number; count: number }>(e.data));
  const checks = {
    shortEchoed: screen('short pasted').includes(`❯ ${PASTE_SHORT}`),
    longPlaceholder: (screen('long pasted').includes(PASTE_LONG_TOKEN) || screen('long pasted').includes('[Paste #1 · 50 lines · full text]')) && !screen('long pasted').includes('paste-line-49'),
    submittedWhole: store.user.length === 2 && store.user[0] === PASTE_LONG,
    ctrlVPlaceholder: screen('ctrl+v').includes(CLIP_TOKEN) || /\[Paste #\d+ · 6 lines · full text\]/.test(screen('ctrl+v')),
    ctrlVSubmittedWhole: store.user[1] === CLIP_TEXT,
    clipboardReadObserved: paste('clipboard-read').length === 1,
    foldedObserved: paste('folded').length === 2 && paste('folded')[0]?.lines === 50 && paste('folded')[0]?.chars === 699,
    expandedObserved: paste('expanded').length === 2,
    onlyFakeProvider: onlyFake(events),
    exitedClean: run.exitCode === 0,
  };
  return { scenario: spec.scenario, universe: root, run, store: { ...store, reply }, logs, checks };
}

/** Reply the fake model gives on every call in the goal-continue scenarios — a promise with no result. */
export const GOAL_CONTINUE_PLEDGE_REPLY = '[fake-llm] 이어서 렌더를 진행하겠습니다.';

/** TURN-END-BEFORE-GOAL — one human turn whose reply only promises («…진행하겠습니다.») opens one
 *  goal-continue internal turn on its own; the identical second reply does not open a third (no loop). */
async function runNextGoalContinueScenario(spec: NextTuiScenarioSpec, root: string, base: ScenarioBase): Promise<NextTuiScenarioResult> {
  const reply = GOAL_CONTINUE_PLEDGE_REPLY;
  const banner = '↻ 자동 재개(goal-continue)';
  const replies = (s: string) => s.split(reply).length - 1;
  let settledAt = 0;
  const steps: SeatPtyStep[] = [
    // The goal-continue turn may open before the first poll sees the settled reply — «at least one» answer.
    { label: 'human turn', text: '영상 만들어줘', until: (s) => replies(s) >= 1 },
    // The door's 10 s human-quiet window covers the Enter just typed; the controller retries once it passes.
    {
      label: 'continued',
      until: (s) => {
        const ok = s.includes(banner) && replies(s) === 2 && isSettledNextTuiScreen(s);
        if (ok && settledAt === 0) settledAt = Date.now();
        return ok;
      },
      timeoutMs: 60_000,
    },
    // Long enough for another retry window: an identical reply must not open a third turn.
    { label: 'no loop', until: (s) => settledAt > 0 && Date.now() >= settledAt + 25_000 && replies(s) === 2, timeoutMs: 40_000 },
  ];
  const run = await mockSeatPtySequence({ ...base, env: { ...base.env, [TEST_FAKE_LLM_RESPONSE_ENV]: reply }, steps });
  const logs = readLogs(spec, 'tui.goal-continue,tui.autoturn,llm.route-decision');
  const events = parseEvents(logs);
  const decided = events.filter((e) => e.category === 'tui.goal-continue' && e.event === 'decided').map((e) => parseData<{ opened?: boolean; rejected?: boolean; reason: string }>(e.data));
  const opened = events.filter((e) => e.category === 'tui.autoturn' && e.event === 'opened').map((e) => parseData<{ origin: string }>(e.data));
  const store = activeUserTexts(root);
  const last = run.frames.at(-1)?.screen ?? '';
  const checks = {
    goalContinueOpenedOnce: decided.filter((d) => d.opened === true).length === 1,
    internalTurnOrigin: opened.length === 1 && opened[0]?.origin === 'goal-continue',
    bannerOnScreen: (run.frames.find((f) => f.label === 'continued')?.screen ?? '').includes(banner),
    continueTurnStored: store.user.length === 2 && store.user[0] === '영상 만들어줘' && (store.user[1] ?? '').startsWith('[골 이어가기]'),
    sameReplyStopped: decided.some((d) => d.rejected === true && d.reason === 'same-reply'),
    noLoop: replies(last) === 2,
    onlyFakeProvider: onlyFake(events),
    exitedClean: run.exitCode === 0,
  };
  return { scenario: spec.scenario, universe: root, run, store: { ...store, reply }, logs, checks };
}


/** TUI-GOAL-INTERIM-QUIET — every step ends with «아직 못 했다» (a different reply per turn via `{reply}`, so the
 *  same-reply stop does not end it early). The fake reply's honesty sentence, counted on screen. */
const GOAL_INTERIM_STEP_MARK = '단계 렌더를 진행했습니다';
const GOAL_INTERIM_NOT_DONE_MARK = '아직 못 했습니다';
/** An internal turn drawn as if a person typed it (classic/next «❯ …»). */
/** The first (human) turn also calls one tool, so a folded reply must leave that turn's tool lines on screen.
 *  ScheduleWakeup an hour out: a real registered tool with no approval prompt that never fires inside the run. */
export const INTERNAL_TURN_USER_HEADER = /(?:나:|❯)\s*\[(?:골 이어가기|자동 재개)\]/u;

export interface GoalInterimScreenCounts { steps: number; notDone: number; folded: number; userHeader: boolean }
export function goalInterimScreenCounts(screen: string): GoalInterimScreenCounts {
  const n = (t: string) => screen.split(t).length - 1;
  return { steps: n(GOAL_INTERIM_STEP_MARK), notDone: n(GOAL_INTERIM_NOT_DONE_MARK), folded: n('(접힘)') + n('(folded)'), userHeader: INTERNAL_TURN_USER_HEADER.test(screen) };
}

/** One human turn → goal-continue runs to its cap on «not done yet» replies. The conversation must show
 *  each step (folded to one line) but the «not done» paragraph at most once, and no user-looking internal input. */
async function runNextGoalInterimScenario(spec: NextTuiScenarioSpec, root: string, base: ScenarioBase): Promise<NextTuiScenarioResult> {
  const capLine = '골 이어가기 상한';
  let settledAt = 0;
  const steps: SeatPtyStep[] = [
    { label: 'human turn', text: '영상 만들어줘', until: (s) => goalInterimScreenCounts(s).steps >= 1 },
    {
      label: 'settled',
      // goal-continue stops at its consecutive cap (a «⏸ … 상한» line) after the last internal turn settles.
      until: (s) => {
        const ok = s.includes(capLine) && isSettledNextTuiScreen(s);
        if (ok && settledAt === 0) settledAt = Date.now();
        return ok;
      },
      timeoutMs: 90_000,
    },
    { label: 'quiet', until: () => settledAt > 0 && Date.now() >= settledAt + 12_000, timeoutMs: 30_000 },
  ];
  const run = await mockSeatPtySequence({ ...base, rows: 40, env: { ...base.env, [TEST_FAKE_LLM_RESPONSE_ENV]: GOAL_INTERIM_NOT_DONE_REPLY, [TEST_FAKE_LLM_TOOL_CALL_ENV]: GOAL_INTERIM_TOOL_CALL }, steps });
  const logs = readLogs(spec, 'tui.goal-continue,tui.goal-interim,tui.autoturn,llm.route-decision');
  const events = parseEvents(logs);
  const opened = events.filter((e) => e.category === 'tui.goal-continue' && e.event === 'decided')
    .map((e) => parseData<{ opened?: boolean }>(e.data)).filter((d) => d.opened === true).length;
  const foldedLogged = events.filter((e) => e.category === 'tui.goal-interim' && e.event === 'folded')
    .map((e) => parseData<{ folded: number }>(e.data).folded ?? 0);
  const store = activeUserTexts(root);
  const finalScreen = run.frames.at(-1)?.screen ?? '';
  const last = goalInterimScreenCounts(finalScreen);
  const stepLines = finalScreen.split('\n').filter((line) => line.startsWith('엘라누스:') && line.includes(GOAL_INTERIM_STEP_MARK));
  const foldedReplyLines = stepLines.filter((line) => line.includes('(접힘)'));
  const checks = {
    continuedSeveral: opened >= 2,
    eachInterimOneLine: foldedReplyLines.length === opened + 1
      && foldedReplyLines.every((line) => !line.includes(GOAL_INTERIM_NOT_DONE_MARK)),
    // The first turn's ScheduleWakeup yields a tool-result reply before the human turn settles.
    everyStepOnScreen: stepLines.length === opened + 2,
    notDoneAtMostOnce: last.notDone <= 1,
    finalReportShown: last.notDone === 1 && finalScreen.split('\n').some((line) => line.includes(GOAL_INTERIM_NOT_DONE_MARK) && !line.includes('(접힘)')),
    foldedEachContinued: foldedReplyLines.length === opened + 1 && Math.max(0, ...foldedLogged) === opened + 1,
    noUserHeaderForInternal: run.frames.every((f) => !INTERNAL_TURN_USER_HEADER.test(f.screen)),
    // The first turn's tool line survives the fold of that turn's reply (only the reply block folds).
    toolLineKept: (run.frames.at(-1)?.screen ?? '').includes('ScheduleWakeup'),
    internalTurnsStored: store.user.filter((u) => u.startsWith('[골 이어가기]')).length === opened,
    onlyFakeProvider: onlyFake(events),
    exitedClean: run.exitCode === 0,
  };
  return { scenario: spec.scenario, universe: root, run, store: { ...store, opened, last }, logs, checks };
}
