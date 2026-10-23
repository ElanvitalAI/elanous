// N03 key-sequence scenarios for next TUI (`/new` · `/compact`) on the network-free fake LLM.
// The TUI under test is whatever executable/entry is given (installed `elanous.mjs` or a tree's
// `bin/elanous.mjs`); this file only types keys, seeds the store through the real session API,
// and reads the universe back through the same binary's `logs` CLI.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appendMessage, createSession, getActiveSessionId, loadSession, setActiveSessionId } from '../session/index.js';
import { mockSeatPtySequence, type SeatPtySequenceEvidence, type SeatPtyStep } from './mock-seat-pty-sequence.js';
import { pasteFoldToken } from '../chat/paste-fold.js';
import { DEFAULT_GOAL_CONTINUE_CAP } from '../dashboard/input/goal-continue.js';
import {
  TEST_FAKE_LLM_DELAY_MS_ENV, TEST_FAKE_LLM_DELAY_WHEN_ENV, TEST_FAKE_LLM_ENV, TEST_FAKE_LLM_RESPONSE_ENV, TEST_FAKE_LLM_TOOL_CALL_ENV,
} from './fake-llm.js';

export const NEXT_TUI_SCENARIOS = ['next-new-session', 'next-compact', 'next-queue', 'next-wakeup', 'next-tool-fold', 'next-tool-fold-read', 'next-goal-continue', 'next-goal-interim', 'next-proactive-continue', 'next-paste'] as const;
export type NextTuiScenario = (typeof NEXT_TUI_SCENARIOS)[number];

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
  checks: Record<string, boolean>;
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

/** A malformed `data` field becomes `{}` so the check reads false instead of the scenario throwing. */
export function parseData<T>(data: unknown): Partial<T> {
  if (typeof data !== 'string') return {};
  try { return JSON.parse(data) as Partial<T>; } catch { return {}; }
}

export async function runNextTuiScenario(spec: NextTuiScenarioSpec): Promise<NextTuiScenarioResult> {
  const root = resolve(spec.root);
  mkdirSync(root, { recursive: true });
  // First-run onboarding would otherwise ask for a provider before the TUI opens.
  writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
  const reply = spec.reply ?? DEFAULT_REPLY;
  const base = {
    executable: spec.executable,
    args: [spec.entry, '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
    root,
    rows: 24,
    cols: 80,
    ...(spec.expectedBinarySha256 ? { expectedBinarySha256: spec.expectedBinarySha256 } : {}),
    env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), [TEST_FAKE_LLM_ENV]: '1', [TEST_FAKE_LLM_RESPONSE_ENV]: reply },
    ready: { label: 'boot', until: (s: string) => s.includes('elanous next ·') && s.includes('Ctrl+Q 종료') },
  };
  const done = (n: number, also?: string) => (s: string) => count(s, reply) === n && s.includes('응답 완료') && (!also || s.includes(also));

  if (spec.scenario === 'next-new-session') {
    // Step 1–2: two turns · step 3: /new · step 4: one turn · step 5: a turn with /new typed while it is busy.
    let oldId = '';
    const steps: SeatPtyStep[] = [
      { label: 'after message 1', text: '첫 메시지', until: done(1) },
      { label: 'before /new (2 messages)', text: '둘째 메시지', until: done(2) },
      { label: 'after /new', text: '/new', until: (s) => /새 대화 · 이전 = [0-9a-f]{8}/.test(s) },
      { label: 'after message 3 (new session)', text: '셋째 메시지', until: done(1, '셋째 메시지') },
      // `/new` lands while the 4th turn is in flight: the TUI must refuse it and keep the session.
      { label: 'busy /new', chunks: ['넷째 메시지', '\r', '/new\r'], until: (s) => s.includes('응답 중에는 /new') || done(2, '넷째 메시지')(s) },
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
    const afterNew = run.frames.find((f) => f.label === 'after /new')?.screen ?? '';
    const checks = {
      screenClearedWithNewTitle: afterNew.includes('elanous next · 새 대화') && !afterNew.includes('첫 메시지') && !afterNew.includes(reply),
      statusNamesPrevious: Boolean(oldId) && afterNew.includes(`새 대화 · 이전 = ${oldId.slice(0, 8)}`),
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

  if (spec.scenario === 'next-tool-fold') return runNextToolFoldScenario(spec, root, base, reply, done);
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
    { label: 'after turn (auto compact)', text: '긴 대화 뒤 질문', until: (s) => s.includes('응답 완료') && s.includes(reply) },
    { label: 'after /compact', text: '/compact', until: /압축 \d+→\d+ 메시지 · Enter 전송/ },
  ];
  const run = await mockSeatPtySequence({
    ...base,
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
    screenShowsAuto: /압축 12→\d+ 메시지/.test(run.frames.find((f) => f.label === 'after turn (auto compact)')?.screen ?? ''),
    summaryFromFakeLlm: Boolean(summary?.content.includes(reply)),
    onlyFakeProvider: routes.length > 0 && routes.every((r) => r.provider === 'test-fake-llm'),
    exitedClean: run.exitCode === 0,
  };
  return { scenario: spec.scenario, universe: root, run, store: { sessionId: id, messages: stored.length, summaryHead: summary?.content.slice(0, 80) ?? null }, logs, checks };
}

type ScenarioBase = Omit<Parameters<typeof mockSeatPtySequence>[0], 'steps'> & { env: Record<string, string> };
type Done = (n: number, also?: string) => (s: string) => boolean;
type LogEvent = { category?: string; event?: string; data?: string };

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

/** TUI-NEXT-QUEUE-AND-WAKE ① — two sentences ⊕ a draft typed while one slow turn runs; then Esc over a queued one. */
async function runNextQueueScenario(spec: NextTuiScenarioSpec, root: string, base: ScenarioBase, reply: string, done: Done): Promise<NextTuiScenarioResult> {
  const slow = '천천히';
  const steps: SeatPtyStep[] = [
    // One slow turn; while it runs: two submissions and an unsent draft.
    { label: 'busy with two queued', chunks: [`첫 질문 ${slow}`, '\r', '둘째 질문', '\r', '셋째 질문', '\r', '쓰던 초안'], gapMs: 300, until: (s) => s.includes('대기 2') && s.includes('쓰던 초안') },
    { label: 'after settle', until: (s) => done(3)(s) && s.includes('셋째 질문') && s.includes('쓰던 초안') && !s.includes('대기'), timeoutMs: 60_000 },
    // The draft becomes a slow turn; one more is queued behind it; Esc cancels the turn → the queued one returns to the prompt.
    { label: 'esc restores queue', chunks: [` ${slow}`, '\r', '다섯째', '\r', '\x1b'], gapMs: 400, until: (s) => s.includes('대기 1건을 입력칸으로') && s.includes('다섯째'), timeoutMs: 60_000 },
  ];
  const run = await mockSeatPtySequence({
    ...base,
    env: { ...base.env, [TEST_FAKE_LLM_DELAY_MS_ENV]: '3000', [TEST_FAKE_LLM_DELAY_WHEN_ENV]: slow },
    steps,
  });
  const logs = readLogs(spec, 'tui.next,llm.route-decision');
  const events = parseEvents(logs);
  const store = activeUserTexts(root);
  const frame = (label: string) => run.frames.find((f) => f.label === label)?.screen ?? '';
  const promptLine = (screen: string) => screen.split('\n').at(-1) ?? '';
  const checks = {
    queueShownWhileBusy: frame('busy with two queued').includes('대기 2'),
    userTurnsInOrder: JSON.stringify(store.user.slice(0, 3)) === JSON.stringify([`첫 질문 ${slow}`, '둘째 질문', '셋째 질문']),
    threeReplies: count(frame('after settle'), reply) === 3,
    draftKept: promptLine(frame('after settle')).includes('쓰던 초안'),
    escRestoresQueue: promptLine(frame('esc restores queue')).includes('다섯째') && !store.user.includes('다섯째'),
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
    const caseBase = { ...base, root: caseRoot, args: [spec.entry, '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'], env: { ...base.env, [TEST_FAKE_LLM_RESPONSE_ENV]: c.reply, ...(c.name === 'remaining' || c.name === 'buffer' ? { [TEST_FAKE_LLM_DELAY_MS_ENV]: '1500', [TEST_FAKE_LLM_DELAY_WHEN_ENV]: '천천히' } : {}) } };
    const steps: SeatPtyStep[] = c.name === 'remaining'
      ? [
        { label: 'remaining: user input queues before turn boundary', chunks: [c.prompt, '\r', '검증 결과를 먼저 보여줘', '\r'], gapMs: 300, until: (s) => s.includes('대기 1'), timeoutMs: 30_000 },
        { label: 'remaining: queued user turn is next', until: (s) => count(s, c.reply) >= 2 && s.includes('응답 완료'), timeoutMs: 30_000 },
        { label: 'remaining: auto continuation settled', until: (s) => count(s, c.reply) >= c.turns && s.includes('응답 완료'), timeoutMs: 30_000 },
      ]
      : c.name === 'cap'
        ? [{ label: 'cap: three automatic turns stop', text: c.prompt, until: (s) => s.includes('골 이어가기 상한(3회 연속)') && s.includes('응답 완료'), timeoutMs: 60_000 }]
      : c.name === 'buffer'
        ? [
          { label: 'buffer: draft typed while the turn is busy', chunks: [c.prompt, '\r', '미전송 초안'], gapMs: 300, until: (s) => s.includes('응답 중') && s.includes('미전송 초안'), timeoutMs: 30_000 },
          { label: 'buffer: response ends with draft preserved', until: (s) => s.includes(c.reply) && s.includes('미전송 초안') && s.includes('응답 완료'), timeoutMs: 30_000 },
        ]
      : [{ label: `${c.name}: human turn`, text: c.prompt, until: (s) => count(s, c.reply) >= 1 && s.includes('응답 완료'), timeoutMs: 30_000 }];
    const run = await mockSeatPtySequence({ ...caseBase, steps });
    results.push({ name: c.name, run, store: activeUserTexts(caseRoot), logs: readLogs(caseSpec, 'tui.next,tui.proactive,tui.goal-continue,tui.autoturn,llm.route-decision') });
  }
  const events = results.flatMap((r) => parseEvents(r.logs));
  const proactive = events.filter((e) => e.category === 'tui.proactive').map((e) => ({ event: e.event, ...parseData<Record<string, unknown>>(e.data) }));
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
      queuedUserInputWonBoundary: proactive.some((e) => e.event === 'yield-user-input') && nextQueueDispatched >= 0 && autoContinuedAfterQueue > nextQueueDispatched && queuedFrame.includes('나: 검증 결과를 먼저 보여줘'),
      remainingWorkContinued: proactive.some((e) => e.event === 'continue' && e.reason === 'work-remaining') && autoFrame.includes('↻ 자동 재개(goal-continue)'),
      repeatedRemainderStopped: proactive.some((e) => e.event === 'stop-no-progress' && e.reason === 'same-remaining'),
      humanWorkStopped: proactive.some((e) => e.event === 'stop-human' && e.reason === 'human-action') && results.find((r) => r.name === 'human')?.run.frames.at(-1)?.screen.includes('로그인이 필요합니다') === true,
      autoTurnCapStopsInPractice: DEFAULT_GOAL_CONTINUE_CAP === 3 && proactive.some((e) => e.event === 'stop-cap' && e.cap === 3 && e.autoTurn === 3)
        && results.find((r) => r.name === 'cap')?.run.frames.at(-1)?.screen.includes('골 이어가기 상한(3회 연속)') === true,
      typedBufferWinsAndStaysVisible: bufferEvents.some((e) => e.category === 'tui.proactive' && e.event === 'yield-user-input' && parseData<{ bufferedChars: number }>(e.data).bufferedChars > 0)
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
  let scheduledAt = 0;
  const banner = '↻ 자동 재개(scheduled): 점검';
  const steps: SeatPtyStep[] = [
    {
      label: 'scheduled',
      text: '60초 뒤 예약해줘',
      until: (s) => {
        const ok = done(1)(s) && s.includes('⏰ 예약 깨움');
        if (ok && scheduledAt === 0) scheduledAt = Date.now();
        return ok;
      },
    },
    { label: 'before due', until: () => scheduledAt > 0 && Date.now() >= scheduledAt + 45_000, timeoutMs: 60_000 },
    { label: 'busy over the due time', text: '긴 작업 하나', until: (s) => s.includes('응답 중') },
    { label: 'long turn done', until: done(2, '긴 작업 하나'), timeoutMs: 60_000 },
    { label: 'woke', until: (s) => s.includes(banner) && done(3)(s), timeoutMs: 150_000 },
  ];
  const run = await mockSeatPtySequence({
    ...base,
    env: {
      ...base.env,
      [TEST_FAKE_LLM_TOOL_CALL_ENV]: JSON.stringify({ when: '예약해줘', name: 'ScheduleWakeup', args: { delaySeconds: 60, reason: '점검' } }),
      [TEST_FAKE_LLM_DELAY_MS_ENV]: '25000',
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
    bannerOnScreen: (run.frames.at(-1)?.screen ?? '').includes(banner),
    wakeTurnStored: store.user.some((t) => t.startsWith('[예약 깨움 w1] 점검')),
    onlyFakeProvider: onlyFake(events),
    exitedClean: run.exitCode === 0,
  };
  return { scenario: spec.scenario, universe: root, run, store: { ...store, reply }, logs, checks };
}

/** TUI-NEXT-FOLD — one real turn: the fake model calls the registered Bash tool, which prints 30 lines
 *  (`seq`), so the stored tool result comes from the real tool path (not a seed). Then PageUp (log focus)
 *  → Enter (expand) → Enter (fold again). */
export const NEXT_TOOL_FOLD_COMMAND = 'seq -f fold-line-%02g 0 29';
async function runNextToolFoldScenario(spec: NextTuiScenarioSpec, root: string, base: ScenarioBase, reply: string, done: Done): Promise<NextTuiScenarioResult> {
  const ask = '도구 출력 접기 시험';
  const summaryRe = /▸ 도구 Bash · (\d+)줄 \(접힘\)/;
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
      until: (s) => { const ok = done(1)(s) && summaryRe.test(s); if (ok && !beforeToggle) beforeToggle = snapshot(); return ok; },
    },
    { label: 'log focus (PageUp)', keys: '\x1b[5~', until: '로그 탐색' },
    { label: 'expanded (Enter)', keys: '\r', until: (s) => s.includes('fold-line-29') && !summaryRe.test(s), timeoutMs: 15_000 },
    {
      label: 'folded again (Enter)', keys: '\r', timeoutMs: 15_000,
      until: (s) => { const ok = summaryRe.test(s) && !s.includes('fold-line-29'); if (ok && !afterToggles) afterToggles = snapshot(); return ok; },
    },
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
  const expanded = screen('expanded (Enter)');
  const folded1 = screen('folded again (Enter)');
  const checks = {
    // The 30 lines come from the Bash tool actually running in the turn loop.
    realToolResultStored: tool?.toolName === 'Bash' && stdoutLines.length === 30
      && stdoutLines.every((l, i) => l === `fold-line-${String(i).padStart(2, '0')}`),
    collapsedAfterTurn: summaryRe.test(folded0) && !folded0.includes('fold-line-12'),
    expandedOnEnter: expanded.includes('fold-line-29') && !summaryRe.test(expanded),
    foldedAgainOnEnter: summaryRe.test(folded1) && !folded1.includes('fold-line-29'),
    // Fold state is screen-only: the whole stored session read right after the first folded screen
    // equals the one read right after the second Enter (and it holds the real tool result).
    sessionUnchanged: beforeToggle !== '' && beforeToggle === afterToggles && beforeToggle.includes('fold-line-29'),
    onlyFakeProvider: onlyFake(events),
    exitedClean: run.exitCode === 0,
  };
  return { scenario: spec.scenario, universe: root, run, store: { sessionId: id, messages: stored.length, toolName: tool?.toolName ?? null, stdoutLines: stdoutLines.length, foldedAs: summaryRe.exec(folded0)?.[0] ?? null, sessionBytesBeforeToggle: beforeToggle.length, sessionBytesAfterToggles: afterToggles.length }, logs, checks };
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
  const summaryRe = /▸ 도구 Read · 20줄 \(접힘\)/;
  const headerRe = /도구: Read · 20줄 · \d+B/;
  const file = join(root, 'fold-read.txt');
  writeFileSync(file, Array.from({ length: NEXT_TOOL_FOLD_READ_LINES }, (_, i) => `fold-line-${i + 1}`).join('\n') + '\n');
  const steps: SeatPtyStep[] = [
    { label: 'after Read turn (folded)', text: ask, timeoutMs: 60_000, until: (s) => done(1)(s) && summaryRe.test(s) },
    { label: 'log focus (PageUp)', keys: '\x1b[5~', until: '로그 탐색' },
    { label: 'expanded (Enter)', keys: '\r', until: (s) => s.includes('fold-line-20') && !summaryRe.test(s), timeoutMs: 15_000 },
    // 24 rows cut the block's top — scroll up to its header line.
    { label: 'expanded top (↑)', keys: '\x1b[A'.repeat(6), until: (s) => headerRe.test(s), timeoutMs: 15_000 },
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
  const expanded = screen('expanded (Enter)');
  const top = screen('expanded top (↑)');
  // Every file line that is on screen sits on its own row as «<n> fold-line-<n>» (both expanded frames together cover all 20).
  const fileRows = new Set([...`${expanded}\n${top}`.matchAll(/^ +(\d+) fold-line-(\d+) *$/gm)].filter((m) => m[1] === m[2]).map((m) => Number(m[1])));
  const checks = {
    // The stored result is the real Read envelope (one JSON line) — the shape the incident showed raw.
    realReadEnvelopeStored: tool?.toolName === 'Read' && envelope?.linesRead === NEXT_TOOL_FOLD_READ_LINES
      && typeof envelope.output === 'string' && envelope.output.includes('\tfold-line-1\n'),
    collapsedAfterTurn: summaryRe.test(folded) && !folded.includes('fold-line-12'),
    // Expanded = the file's lines on their own rows with the status on the header, no raw envelope.
    expandedAsFileLines: headerRe.test(top) && fileRows.size === NEXT_TOOL_FOLD_READ_LINES,
    noRawEnvelope: ![folded, expanded, top].some((s) => s.includes('{"output"') || s.includes('\\n') || s.includes('"linesRead"')),
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

/** PATH shims so Ctrl+V reads a known clipboard instead of the person's: `pbpaste` prints CLIP_TEXT and
 *  `osascript` answers «no image». The TUI's own clipboard module spawns them by name from PATH. */
export function clipboardShimPath(root: string): string {
  const bin = join(root, 'clip-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'pbpaste'), `#!/bin/sh\nprintf '%s' '${CLIP_TEXT.replace(/\n/g, '\\n')}' | sed 's/\\\\n/\\n/g'\n`);
  writeFileSync(join(bin, 'osascript'), '#!/bin/sh\necho no\n');
  chmodSync(join(bin, 'pbpaste'), 0o755);
  chmodSync(join(bin, 'osascript'), 0o755);
  return `${bin}:${process.env.PATH ?? ''}`;
}

/** TUI-PASTE-ECHO — a short bracketed paste shows as typed; a 50-line paste shows one placeholder and the
 *  submitted turn carries the whole original text. */
async function runNextPasteScenario(spec: NextTuiScenarioSpec, root: string, base: ScenarioBase, reply: string): Promise<NextTuiScenarioResult> {
  const steps: SeatPtyStep[] = [
    { label: 'short pasted', keys: bracketedPaste(PASTE_SHORT), until: (s) => s.includes(`❯ ${PASTE_SHORT}`) },
    { label: 'cleared', keys: '\x15', until: (s) => !s.includes(PASTE_SHORT) },
    { label: 'long pasted', keys: bracketedPaste(PASTE_LONG), until: (s) => s.includes(PASTE_LONG_TOKEN) },
    { label: 'submitted', keys: '\r', until: (s) => s.includes(reply) && s.includes('응답 완료'), timeoutMs: 30_000 },
    { label: 'ctrl+v', keys: '\x16', until: (s) => s.includes(CLIP_TOKEN) },
    { label: 'clip submitted', keys: '\r', until: (s) => s.split(reply).length - 1 === 2 && s.includes('응답 완료'), timeoutMs: 30_000 },
  ];
  const run = await mockSeatPtySequence({ ...base, env: { ...base.env, PATH: clipboardShimPath(root) }, steps });
  const logs = readLogs(spec, 'tui.paste,llm.route-decision');
  const events = parseEvents(logs);
  const store = activeUserTexts(root);
  const screen = (label: string) => run.frames.find((f) => f.label === label)?.screen ?? '';
  const paste = (event: string) => events.filter((e) => e.category === 'tui.paste' && e.event === event).map((e) => parseData<{ lines: number; chars: number; count: number }>(e.data));
  const checks = {
    shortEchoed: screen('short pasted').includes(`❯ ${PASTE_SHORT}`),
    longPlaceholder: screen('long pasted').includes(PASTE_LONG_TOKEN) && !screen('long pasted').includes('paste-line-49'),
    submittedWhole: store.user.length === 2 && store.user[0] === PASTE_LONG,
    ctrlVPlaceholder: screen('ctrl+v').includes(CLIP_TOKEN),
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
        const ok = s.includes(banner) && replies(s) === 2 && s.includes('응답 완료');
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


/** TUI-GOAL-INTERIM-QUIET — every step ends with «아직 못 했다» (a different reply per turn via `{step}`, so the
 *  same-reply stop does not end it early). The fake reply's honesty sentence, counted on screen. */
export const GOAL_INTERIM_NOT_DONE_REPLY = '[fake-llm] {step}단계 렌더를 진행했습니다.\n남은 작업 {step}단계: 완료 영상 경로는 아직 보고할 수 없습니다 — 아직 못 했습니다.';
const GOAL_INTERIM_STEP_MARK = '단계 렌더를 진행했습니다';
const GOAL_INTERIM_NOT_DONE_MARK = '아직 못 했습니다';
/** An internal turn drawn as if a person typed it (classic «❯ …» · next «나: …»). */
/** The first (human) turn also calls one tool, so a folded reply must leave that turn's tool lines on screen.
 *  ScheduleWakeup an hour out: a real registered tool with no approval prompt that never fires inside the run. */
export const GOAL_INTERIM_TOOL_CALL = JSON.stringify({ when: '영상 만들어줘', name: 'ScheduleWakeup', args: { delaySeconds: 3600, reason: '렌더 점검' } });
export const INTERNAL_TURN_USER_HEADER = /(?:나:|❯)\s*\[(?:골 이어가기|자동 재개)\]/u;

export interface GoalInterimScreenCounts { steps: number; notDone: number; folded: number; userHeader: boolean }
export function goalInterimScreenCounts(screen: string): GoalInterimScreenCounts {
  const n = (t: string) => screen.split(t).length - 1;
  return { steps: n(GOAL_INTERIM_STEP_MARK), notDone: n(GOAL_INTERIM_NOT_DONE_MARK), folded: n('(접힘)'), userHeader: INTERNAL_TURN_USER_HEADER.test(screen) };
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
        const ok = s.includes(capLine) && s.includes('응답 완료');
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
  const last = goalInterimScreenCounts(run.frames.at(-1)?.screen ?? '');
  const checks = {
    continuedSeveral: opened >= 2,
    everyStepOnScreen: last.steps === opened + 1,
    notDoneAtMostOnce: last.notDone <= 1,
    finalReportShown: last.notDone === 1,
    foldedEachContinued: last.folded === opened && Math.max(0, ...foldedLogged) === opened,
    noUserHeaderForInternal: run.frames.every((f) => !INTERNAL_TURN_USER_HEADER.test(f.screen)),
    // The first turn's tool line survives the fold of that turn's reply (only the reply block folds).
    toolLineKept: (run.frames.at(-1)?.screen ?? '').includes('ScheduleWakeup'),
    internalTurnsStored: store.user.filter((u) => u.startsWith('[골 이어가기]')).length === opened,
    onlyFakeProvider: onlyFake(events),
    exitedClean: run.exitCode === 0,
  };
  return { scenario: spec.scenario, universe: root, run, store: { ...store, opened, last }, logs, checks };
}
