// N03 key-sequence scenarios for the classic TUI (bare `elanous` · dashboard) on the network-free fake LLM.
// Same contract as next-tui-seat-scenarios.ts: the TUI under test is whatever executable/entry is given
// (installed `elanous.mjs` or a tree's `bin/elanous.mjs`); this file only seeds the isolated universe
// through real store APIs, types keys, and reads the universe back through the same binary's `logs` CLI.
// ⛔ No production logic is reimplemented here — every judged behavior is the real TUI's.
//
//   classic-400-heal       TUI-400-AUTOHEAL-FALLBACK ① — fake LLM script `400,ok`: one 400 (history mismatch) → new session ⊕ summary → answer
//   classic-400-exhausted  TUI-400-AUTOHEAL-FALLBACK ③ — script `400,400,400`: the heal fails too, no fallback provider → one reason line · per-turn cap
//   classic-seat-boot      TUI-SESSION-BOOT — COORD_ID seat ⊕ seat-state dir ⊕ one unread mail → first-screen line ⊕ card-injected on the first turn
//                          ⊕ TUI-SEAT-MEMORY-RECALL: a hand handoff (HANDOFF-now.md) → one `memory-recall` hit (source · chars ≤ cap)
//   classic-typing-lag     TUI-TYPING-LAG-REST — keys typed right after Enter in a git repo cwd → echo complete ⊕ `tui.input-lag` turn-start/keystroke rows
//   classic-mcp-calltool   CLASSIC-IDLE-MCP-LAZY — cached tools leave the child absent at boot; first real TUI dispatch starts one
//                          fake MCP child and completes one tools/call through the production proxy
//   classic-paste          TUI-PASTE-ECHO — short bracketed paste shows as typed · 50-line paste shows one placeholder ·
//                          the model receives the whole original text (fake LLM request capture)
//   classic-goal-continue  TURN-END-BEFORE-GOAL — every reply only promises («…진행하겠습니다.») → one goal-continue
//                          internal turn on its own · the identical second reply stops it (same-reply · no loop)
//   classic-orphan-autostop TUI-ORPHAN-AUTO-RESUME-STOP — autowake seat (COORD_ID ⊕ seat-state/autowake ⊕ unread mail) ⊕ fake
//                          Codex orphan 400 every call → human turn fails · autowake turn fails the same call_id → one
//                          `tui.autowake terminal` · no autowake turn after it (a fresh mail too) · a human turn still answers
//   classic-goal-interim   TUI-GOAL-INTERIM-QUIET — every step ends with «아직 못 했다» (different per turn) → goal-continue
//                          runs to its cap · each continued step folds to one line · the «not done» paragraph shows once ·
//                          no internal input drawn with a user header
//   classic-wakeup         TUI-WAKEUP-DEFER-NOT-DROP — ScheduleWakeup(60s) ⊕ a human turn busy for ~2.5 min over the due time →
//                          NotIdle three times or more (the old code dropped after the second) · skipped 0 · then one internal turn
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openMsgStore } from '../msg/msg-store.js';
import { SEAT_MEMORY_RECALL_MAX_CHARS, SEAT_MEMORY_RECALL_PREFIX } from '../dashboard/seat-boot-preamble.js';
import { AUTOHEAL_MAX_ATTEMPTS } from '../self-health/autoheal.js';
import { mockSeatPtySequence, type SeatPtySequenceEvidence, type SeatPtyStep } from './mock-seat-pty-sequence.js';
import {
  TEST_FAKE_LLM_CAPTURE_ENV, TEST_FAKE_LLM_DELAY_MS_ENV, TEST_FAKE_LLM_DELAY_WHEN_ENV, TEST_FAKE_LLM_ENV,
  TEST_FAKE_LLM_RESPONSE_ENV, TEST_FAKE_LLM_SCRIPT_ENV, TEST_FAKE_LLM_SCRIPT_SKIP_WHEN_ENV, TEST_FAKE_LLM_TOOL_CALL_ENV,
} from './fake-llm.js';
import { pasteFoldToken } from '../chat/paste-fold.js';
import { bracketedPaste, CLIP_TEXT, GOAL_CONTINUE_PLEDGE_REPLY, GOAL_INTERIM_NOT_DONE_REPLY, GOAL_INTERIM_TOOL_CALL, goalInterimScreenCounts, INTERNAL_TURN_USER_HEADER, clipboardShimPath, PASTE_LONG, PASTE_LONG_TOKEN, PASTE_SHORT, parseData, readLogs } from './next-tui-seat-scenarios.js';

export const CLASSIC_TUI_SCENARIOS = ['classic-400-heal', 'classic-400-exhausted', 'classic-seat-boot', 'classic-typing-lag', 'classic-mcp-calltool', 'classic-wakeup', 'classic-goal-continue', 'classic-goal-interim', 'classic-paste', 'classic-orphan-autostop'] as const;
export type ClassicTuiScenario = (typeof CLASSIC_TUI_SCENARIOS)[number];

export interface ClassicTuiScenarioSpec {
  scenario: ClassicTuiScenario;
  /** Kept universe: config-dir = state-dir = HOME = cwd = this root. */
  root: string;
  executable: string;
  entry: string;
  expectedBinarySha256?: string;
}

export interface ClassicTuiScenarioResult {
  scenario: ClassicTuiScenario;
  universe: string;
  run: SeatPtySequenceEvidence;
  store: Record<string, unknown>;
  logs: { command: string; rc: number | null; lines: string[]; eventCount: number; limit: number };
  checks: Record<string, boolean>;
}

const REPLY = '[fake-llm] 답했습니다';
const CLASSIC_MCP_SERVER_ID = 'classic-echo';
const CLASSIC_MCP_TOOL_NAME = 'echo';
const CLASSIC_MCP_TOOL = {
  name: CLASSIC_MCP_TOOL_NAME,
  description: 'Return the supplied value from the isolated MCP fixture.',
  inputSchema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
  },
};
const CLASSIC_MCP_SERVER_SOURCE = `
import { appendFileSync } from 'node:fs';

const [eventFile] = process.argv.slice(2);
const record = (event, data = {}) => appendFileSync(eventFile, JSON.stringify({ event, ...data }) + '\\n');
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
record('start');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index = buffer.indexOf('\\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf('\\n');
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    if (message.method === 'initialize') {
      record('initialize');
      reply(message.id, {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'classic-calltool-fixture', version: '0.0.0' },
      });
    } else if (message.method === 'tools/list') {
      record('tools/list');
      reply(message.id, { tools: [${JSON.stringify(CLASSIC_MCP_TOOL)}] });
    } else if (message.method === 'tools/call') {
      record('tools/call', { name: message.params?.name, arguments: message.params?.arguments });
      reply(message.id, { content: [{ type: 'text', text: JSON.stringify(message.params?.arguments ?? {}) }] });
    } else {
      reply(message.id, {});
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;
/** Env name the fake provider needs to count as «a provider» in the live TUI (llm.ts · isolated stages only). */
const FAKE_AS_PROVIDER_ENV = 'ELANOUS_TEST_FAKE_LLM_AS_PROVIDER';
/** The per-turn autoheal cap (TUI-400-AUTOHEAL-FALLBACK: «턴당 2회 상한») — the production constant, not a copy. */
const AUTOHEAL_CAP = AUTOHEAL_MAX_ATTEMPTS;

type Row = { category?: string; event?: string; data?: unknown };

const classicReady = (s: string) => s.includes('elanous | daemon') && s.includes('실행 ') && s.includes('❯');
const turnDone = (s: string) => /✔ 완료|✘ 실패/.test(s);

type CapturedRequest = { messages: Array<{ role: string; content: string | null }> };

/** The fake provider's request capture (`TEST_FAKE_LLM_CAPTURE_ENV`) — one JSONL row per model call, in call order. */
function readCapturedRequests(path: string): CapturedRequest[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as CapturedRequest]; } catch { return []; }
  });
}

function rowsOf(logs: ClassicTuiScenarioResult['logs']): Row[] {
  return logs.lines.map((l) => { try { return JSON.parse(l) as Row; } catch { return {}; } });
}

/** Every model call the TUI made went to the fake provider (and at least one was made). */
function onlyFake(rows: Row[]): boolean {
  const calls = rows.filter((r) => r.category === 'llm.router' && r.event === 'streamLLMWithTools').map((r) => parseData<{ provider: string }>(r.data).provider);
  return calls.length > 0 && calls.every((p) => p === 'test-fake-llm');
}

export async function runClassicTuiScenario(spec: ClassicTuiScenarioSpec): Promise<ClassicTuiScenarioResult> {
  const root = resolve(spec.root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
  const env: Record<string, string> = {
    ELANOUS_SESSION_ROOT: join(root, 'sessions'),
    [TEST_FAKE_LLM_ENV]: '1',
    [FAKE_AS_PROVIDER_ENV]: '1',
    [TEST_FAKE_LLM_RESPONSE_ENV]: REPLY,
  };
  const base = {
    executable: spec.executable,
    args: [spec.entry, '--config-dir', '{root}', '--test-state-dir', '{root}'],
    root,
    rows: 30,
    cols: 100,
    ...(spec.expectedBinarySha256 ? { expectedBinarySha256: spec.expectedBinarySha256 } : {}),
    ready: { label: 'boot', until: classicReady, timeoutMs: 90_000 },
    // Ctrl+C tears down slower than the device's default window; `/exit` is the clean path.
    quitKeys: '/exit\r',
    exitTimeoutMs: 20_000,
  };
  const logCategories = 'llm.router,mcp.client,self-health.autoheal,dashboard.seat-boot,tui.input-lag,tui.wakeup,tui.autoturn,tui.paste,tui.goal-continue,tui.proactive,tui.goal-interim,tui.autowake';
  const finish = (run: SeatPtySequenceEvidence, store: Record<string, unknown>, checks: (rows: Row[]) => Record<string, boolean>): ClassicTuiScenarioResult => {
    const logs = readLogs({ root, executable: spec.executable, entry: spec.entry }, logCategories);
    return { scenario: spec.scenario, universe: root, run, store, logs, checks: checks(rowsOf(logs)) };
  };

  if (spec.scenario === 'classic-400-heal' || spec.scenario === 'classic-400-exhausted') {
    const heal = spec.scenario === 'classic-400-heal';
    // The fake throws the real «No tool call found for function call output» 400 shape per script cell.
    env[TEST_FAKE_LLM_SCRIPT_ENV] = heal ? '400,ok' : '400,400,400';
    const steps: SeatPtyStep[] = [{ label: heal ? 'after 400 turn (healed)' : 'after 400 turn (exhausted)', text: '다시 해줘', until: turnDone }];
    const run = await mockSeatPtySequence({ ...base, env, steps });
    const after = run.frames.at(-1)?.screen ?? '';
    return finish(run, { script: env[TEST_FAKE_LLM_SCRIPT_ENV] }, (rows): Record<string, boolean> => {
      const ah = rows.filter((r) => r.category === 'self-health.autoheal');
      const attempts = ah.filter((r) => r.event === 'attempt').map((r) => parseData<{ step: string; attempt: number; sessionRenewed: boolean }>(r.data));
      const recovered = ah.filter((r) => r.event === 'recovered');
      const exhausted = ah.filter((r) => r.event === 'exhausted').map((r) => parseData<{ attempts: number; reason: string }>(r.data));
      if (heal) {
        return {
          before400Screen: !(run.frames[0]?.screen ?? '').includes('자동 회복'),
          healLineOnScreen: after.includes('자동 회복: 새 세션'),
          answeredAfterHeal: after.includes(REPLY) && after.includes('✔ 완료'),
          attemptNewSession: attempts.length === 1 && attempts[0]?.step === 'new-session',
          recoveredObserved: recovered.length === 1 && parseData<{ step: string }>(recovered[0]?.data).step === 'new-session',
          sessionRenewed: attempts[0]?.sessionRenewed === true,
          onlyFakeProvider: onlyFake(rows),
          exitedClean: run.exitCode === 0,
        };
      }
      return {
        healLineOnScreen: after.includes('자동 회복: 새 세션'),
        stopReasonOnScreen: /자동 회복 \d회 실패/.test(after),
        failedTurnOnScreen: after.includes('✘ 실패') && !after.includes(REPLY),
        exhaustedObserved: exhausted.length === 1,
        // No fallback provider exists on this stage, so the cap stops after exactly one (new-session) attempt —
        // asserted exactly so a regression that loops (or skips ①) is caught, and never above the production cap.
        attemptsWithinCap: attempts.length === 1 && attempts[0]?.step === 'new-session' && Number(exhausted[0]?.attempts) === 1
          && exhausted[0]?.reason === 'no-fallback-provider' && attempts.length <= AUTOHEAL_CAP,
        noRecovered: recovered.length === 0,
        onlyFakeProvider: onlyFake(rows),
        exitedClean: run.exitCode === 0,
      };
    });
  }

  if (spec.scenario === 'classic-seat-boot') {
    // Seat by COORD_ID (cwd = root has no /seats/<자리>) ⊕ the seat-state dir under the isolated HOME ⊕ one unread mail.
    const seat = 'OP';
    env.COORD_ID = seat;
    const seatDir = join(root, 'elanous-hq', 'seat-state', seat);
    mkdirSync(seatDir, { recursive: true });
    writeFileSync(join(seatDir, 'HANDOFF.md'), '# HANDOFF (n03 classic-seat-boot)\n- 열린 일 하나\n');
    // TUI-SEAT-MEMORY-RECALL — a hand handoff (HANDOFF-*.md) → the card carries one «직전 인계 회상» line.
    const handoffPath = join(seatDir, 'HANDOFF-now.md');
    writeFileSync(handoffPath, '# OP 이어받기 (n03 classic-seat-boot)\n열차 등록 확인부터 잇는다\n');
    const capturePath = join(root, 'fake-llm-requests.jsonl');
    env[TEST_FAKE_LLM_CAPTURE_ENV] = capturePath;
    const msgPath = join(root, 'msg', 'messages.db');
    mkdirSync(join(root, 'msg'), { recursive: true });
    const store = openMsgStore(msgPath);
    try { store.post({ from: 'TF', to: seat, body: 'n03 classic-seat-boot 안 읽은 우편 하나' }); } finally { store.close(); }
    const steps: SeatPtyStep[] = [{ label: 'after first turn', text: '안녕', until: turnDone }];
    const run = await mockSeatPtySequence({ ...base, env, steps });
    const first = run.frames[0]?.screen ?? '';
    const after = run.frames.at(-1)?.screen ?? '';
    // The line the model actually received: the fake provider's request capture of the first turn (the TUI does not print the preamble).
    const firstRequest = readCapturedRequests(capturePath)[0];
    const recallLines = (firstRequest?.messages ?? [])
      .filter((m) => m.role === 'system' && typeof m.content === 'string')
      .flatMap((m) => String(m.content).split('\n'))
      .filter((line) => line.startsWith(SEAT_MEMORY_RECALL_PREFIX));
    const recallLine = recallLines[0] ?? null;
    return finish(run, { seat, seatDir, msgPath, seededUnread: 1, handoffPath, capturePath, recallLine }, (rows) => {
      const sb = rows.filter((r) => r.category === 'dashboard.seat-boot');
      const injected = sb.filter((r) => r.event === 'card-injected').map((r) => parseData<{ seat: string; source: string; unread: number; chars: number }>(r.data));
      const recalls = sb.filter((r) => r.event === 'memory-recall').map((r) => parseData<{ source: string | null; chars: number; hit: boolean }>(r.data));
      return {
        memoryRecallObserved: recalls.length === 1 && recalls[0]?.hit === true && recalls[0]?.source === handoffPath,
        // First-turn system preamble (captured) carries exactly one recall line with the seeded title · first line · path, within the cap.
        memoryRecallInFirstTurnPreamble: recallLines.length === 1 && recallLine !== null
          && recallLine.includes('OP 이어받기 (n03 classic-seat-boot)') && recallLine.includes('열차 등록 확인부터 잇는다') && recallLine.includes(handoffPath),
        memoryRecallWithinCap: recallLine !== null && recallLine.length <= SEAT_MEMORY_RECALL_MAX_CHARS && recallLine.length === Number(recalls[0]?.chars),
        bootLineOnFirstScreen: first.includes(`🪪 ${seat} 자리 · 안 읽은 우편 1`),
        cardInjectedObserved: injected.length >= 1 && injected[0]?.seat === seat && injected[0]?.source === 'coord-id' && Number(injected[0]?.chars) > 0,
        cardUnreadMatchesSeed: injected[0]?.unread === 1,
        // One card per conversation: the first-screen line and every turn share the same snapshot.
        cardOncePerConversation: injected.length === 1,
        firstTurnAnswered: after.includes(REPLY) && after.includes('✔ 완료'),
        onlyFakeProvider: onlyFake(rows),
        exitedClean: run.exitCode === 0,
      };
    });
  }

  if (spec.scenario === 'classic-mcp-calltool') {
    const serverScript = join(root, 'fake-classic-mcp-server.mjs');
    const eventPath = join(root, 'fake-classic-mcp-events.jsonl');
    const capturePath = join(root, 'fake-llm-requests.jsonl');
    const logsDirectory = join(root, '.elanous', 'debug');
    writeFileSync(serverScript, CLASSIC_MCP_SERVER_SOURCE, 'utf8');
    // A prior boot's index is the production deferred-boot contract: no child starts until callTool.
    writeFileSync(join(root, 'mcp-tool-index.json'), JSON.stringify({ [CLASSIC_MCP_SERVER_ID]: [CLASSIC_MCP_TOOL] }, null, 2));
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      onboarding: { completed: true },
      errorReports: { enabled: false },
      mcp: {
        enabled: true,
        servers: [{
          id: CLASSIC_MCP_SERVER_ID,
          transport: 'stdio',
          command: [process.execPath, serverScript, eventPath],
          authorizedTools: [CLASSIC_MCP_TOOL_NAME],
        }],
      },
    }));
    env[TEST_FAKE_LLM_CAPTURE_ENV] = capturePath;
    env[TEST_FAKE_LLM_TOOL_CALL_ENV] = JSON.stringify({
      when: 'MCP 도구를 호출해',
      name: `${CLASSIC_MCP_SERVER_ID}.${CLASSIC_MCP_TOOL_NAME}`,
      args: { value: 'first-call-success' },
    });
    const readMcpDebugRows = (): Row[] => {
      if (!existsSync(logsDirectory)) return [];
      return readdirSync(logsDirectory)
        .filter((name) => (name.startsWith('debug-') || name.startsWith('chat-')) && name.endsWith('.log'))
        .flatMap((name) => readFileSync(join(logsDirectory, name), 'utf8').split('\n').filter(Boolean))
        .flatMap((line) => { try { return [JSON.parse(line) as Row]; } catch { return []; } })
        .filter((row) => row.category === 'mcp.client');
    };
    const deferredBeforeCall = { value: false };
    const run = await mockSeatPtySequence({
      ...base,
      env,
      steps: [
        {
          label: 'deferred with no child',
          until: (screen) => {
            if (!classicReady(screen)) return false;
            const deferred = readMcpDebugRows().some((row) => {
              const data = parseData<{ server: string; reason: string }>(row.data);
              return row.event === 'lazy-boot' && data.server === CLASSIC_MCP_SERVER_ID && data.reason === 'deferred';
            });
            deferredBeforeCall.value = deferred && !existsSync(eventPath);
            return deferredBeforeCall.value;
          },
          timeoutMs: 60_000,
        },
        {
          label: 'first MCP callTool answered',
          text: 'MCP 도구를 호출해',
          until: (screen) => screen.includes(REPLY) && screen.includes(`${CLASSIC_MCP_SERVER_ID}.${CLASSIC_MCP_TOOL_NAME} — result (`) && turnDone(screen),
          timeoutMs: 90_000,
        },
      ],
    });
    const fakeServerEvents = existsSync(eventPath)
      ? readFileSync(eventPath, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
          try { return [JSON.parse(line) as { event?: string; name?: string; arguments?: Record<string, unknown> }]; }
          catch { return []; }
        })
      : [];
    const mcpRows = readMcpDebugRows();
    const lazyBoots = mcpRows.filter((row) => row.event === 'lazy-boot')
      .map((row) => parseData<{ server: string; reason: string }>(row.data))
      .filter((row) => row.server === CLASSIC_MCP_SERVER_ID);
    const callEvents = fakeServerEvents.filter((event) => event.event === 'tools/call');
    const response = run.frames.at(-1)?.screen ?? '';
    const debugLines = existsSync(logsDirectory)
      ? readdirSync(logsDirectory)
        .filter((name) => (name.startsWith('debug-') || name.startsWith('chat-')) && name.endsWith('.log'))
        .flatMap((name) => readFileSync(join(logsDirectory, name), 'utf8').split('\n').filter(Boolean))
        .filter((line) => { try { return (JSON.parse(line) as Row).category === 'mcp.client'; } catch { return false; } })
      : [];
    const logs = { command: `isolated debug ledger ${logsDirectory}`, rc: 0, lines: debugLines, eventCount: debugLines.length, limit: 200 };
    const providerLogs = readLogs({ root, executable: spec.executable, entry: spec.entry }, 'llm.router');
    return {
      scenario: spec.scenario,
      universe: root,
      run,
      store: { eventPath, fakeServerEvents, capturePath, providerCalls: readCapturedRequests(capturePath).length },
      logs,
      checks: {
        childWasAbsentAfterDeferredBoot: deferredBeforeCall.value,
        fakeServerStartedOnce: fakeServerEvents.filter((event) => event.event === 'start').length === 1,
        actualMcpToolsCallOnce: callEvents.length === 1
          && callEvents[0]?.name === CLASSIC_MCP_TOOL_NAME
          && callEvents[0]?.arguments?.value === 'first-call-success',
        lazyBootDeferredThenFirstCall: lazyBoots.map((event) => event.reason).join(',') === 'deferred,first-call',
        firstCallResultReachedTui: response.includes(`${CLASSIC_MCP_SERVER_ID}.${CLASSIC_MCP_TOOL_NAME} — result (`)
          && callEvents.length === 1 && callEvents[0]?.arguments?.value === 'first-call-success'
          && response.includes(REPLY) && turnDone(response),
        onlyFakeProvider: onlyFake(rowsOf(providerLogs)),
        exitedClean: run.exitCode === 0,
      },
    };
  }

  if (spec.scenario === 'classic-orphan-autostop') {
    // Autowake seat: COORD_ID ⊕ seat-state/<자리>/autowake ⊕ one unread mail, so the turn end would wake the seat.
    const seat = 'OPT';
    env.COORD_ID = seat;
    const seatDir = join(root, 'elanous-hq', 'seat-state', seat);
    mkdirSync(seatDir, { recursive: true });
    writeFileSync(join(seatDir, 'autowake'), '');
    const msgPath = join(root, 'msg', 'messages.db');
    mkdirSync(join(root, 'msg'), { recursive: true });
    const post = (body: string) => { const store = openMsgStore(msgPath); try { store.post({ from: 'TF', to: seat, body }); } finally { store.close(); } };
    post('n03 classic-orphan-autostop 안 읽은 우편 하나');
    // Every model call throws the Codex orphan 400 (autoheal's new-session try included) — except a human turn
    // carrying the marker, which answers: the stop must not block a person.
    const humanMarker = '사람 확인';
    env[TEST_FAKE_LLM_SCRIPT_ENV] = Array(40).fill('400codex').join(',');
    env[TEST_FAKE_LLM_SCRIPT_SKIP_WHEN_ENV] = humanMarker;
    const wakeBanner = '↻ 자동 재개(autowake)';
    const stopLine = '⏹ Codex 400 자동 재개 중단';
    let wokeAt = 0;
    let answeredAt = 0;
    let freshPosted = false;
    const wakeCount = (s: string) => s.split(wakeBanner).length - 1;
    const steps: SeatPtyStep[] = [
      { label: 'human turn fails', text: '이어서 해줘', until: turnDone, timeoutMs: 60_000 },
      // Autowake waits out the 30s human-quiet window, opens one turn, it fails with the same call_id → terminal.
      // The step waits for that autowake turn to end (not for the stop line) so a missing stop is a failed check, not a timeout.
      {
        label: 'autowake turn ended',
        until: (s) => {
          const at = s.lastIndexOf(wakeBanner);
          if (at < 0 || !turnDone(s.slice(at))) return false;
          if (wokeAt === 0) wokeAt = Date.now();
          if (Date.now() < wokeAt + 2_000) return false; // let the stop notice land
          if (!freshPosted) { post('n03 classic-orphan-autostop 새 우편'); freshPosted = true; }
          return true;
        },
        timeoutMs: 120_000,
      },
      // A fresh mail changes the order fingerprint, then a human turn ends: without the stop, autowake would open again.
      {
        label: 'human turn answers', text: humanMarker,
        until: (s) => {
          const ok = s.includes(REPLY) && turnDone(s.slice(s.lastIndexOf(humanMarker)));
          if (ok && answeredAt === 0) answeredAt = Date.now();
          return ok;
        },
        timeoutMs: 60_000,
      },
      // Past the 30s human-quiet window — the old behaviour shows a second autowake banner here.
      { label: 'still stopped', until: () => answeredAt > 0 && Date.now() >= answeredAt + 45_000, timeoutMs: 70_000 },
    ];
    const run = await mockSeatPtySequence({ ...base, env, steps });
    const frame = (label: string) => run.frames.find((f) => f.label === label)?.screen ?? '';
    const last = run.frames.at(-1)?.screen ?? '';
    return finish(run, { seat, seatDir, msgPath, script: env[TEST_FAKE_LLM_SCRIPT_ENV], freshPosted }, (rows) => {
      const aw = (event: string) => rows.filter((r) => r.category === 'tui.autowake' && r.event === event).map((r) => parseData<Record<string, unknown>>(r.data));
      const terminal = aw('terminal');
      const opened = aw('decided').filter((d) => d.opened === true);
      const autoturns = rows.filter((r) => r.category === 'tui.autoturn' && r.event === 'opened')
        .map((r) => parseData<{ origin: string }>(r.data)).filter((o) => o.origin === 'autowake');
      return {
        // Precondition: the binary's fake provider knows the `400codex` cell (older builds answer it as `ok`, and
        // then every check below is «not measured», not a product verdict).
        orphan400Injected: rows.some((r) => r.category === 'self-health.autoheal' && r.event === 'attempt'),
        autowakeOpenedOnce: opened.length === 1 && autoturns.length === 1,
        terminalLoggedOnce: terminal.length === 1 && terminal[0]?.callId === 'call_fake_llm' && terminal[0]?.errorKind === 'codex-orphan-tool-output-400',
        stopLineOnScreen: frame('autowake turn ended').includes(stopLine),
        // After the stop: the fresh mail ⊕ a human turn end ⊕ 45s quiet open no second autowake turn; the gate says why.
        noAutowakeAfterTerminal: freshPosted && wakeCount(last) === 1 && aw('terminal-blocked').length >= 1,
        humanInputStillWorks: frame('human turn answers').includes(REPLY),
        onlyFakeProvider: onlyFake(rows),
        exitedClean: run.exitCode === 0,
      };
    });
  }

  if (spec.scenario === 'classic-paste') {
    // classic numbers pastes per input session (the prompt reopens after each turn), so the clipboard paste is #1 again.
    const CLIP_TOKEN = pasteFoldToken(1, CLIP_TEXT);
    const capturePath = join(root, 'fake-llm-requests.jsonl');
    env[TEST_FAKE_LLM_CAPTURE_ENV] = capturePath;
    const steps: SeatPtyStep[] = [
      { label: 'short pasted', keys: bracketedPaste(PASTE_SHORT), until: (s) => s.includes(`❯ ${PASTE_SHORT}`) },
      { label: 'cleared', keys: '\x15', until: (s) => !s.includes(`❯ ${PASTE_SHORT}`) },
      { label: 'long pasted', keys: bracketedPaste(PASTE_LONG), until: (s) => s.includes(PASTE_LONG_TOKEN) },
      { label: 'submitted', keys: '\r', until: turnDone, timeoutMs: 30_000 },
      { label: 'ctrl+v', keys: '\x16', until: (s) => s.includes(CLIP_TOKEN) },
      { label: 'clip submitted', keys: '\r', until: (s) => readCapturedRequests(capturePath).length >= 2 && turnDone(s.slice(s.lastIndexOf(CLIP_TOKEN) >= 0 ? s.lastIndexOf('clip-line-5') : 0)), timeoutMs: 30_000 },
    ];
    env.PATH = clipboardShimPath(root);
    const run = await mockSeatPtySequence({ ...base, env, steps });
    const screen = (label: string) => run.frames.find((f) => f.label === label)?.screen ?? '';
    const requests = readCapturedRequests(capturePath);
    const userOf = (i: number) => requests[i]?.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
    const lastUser = userOf(0);
    const clipUser = userOf(1);
    return finish(run, { capturePath, lastUserChars: String(lastUser).length }, (rows) => {
      const paste = (event: string) => rows.filter((r) => r.category === 'tui.paste' && r.event === event).map((r) => parseData<{ lines: number; chars: number }>(r.data));
      return {
        shortEchoed: screen('short pasted').includes(`❯ ${PASTE_SHORT}`),
        longPlaceholder: screen('long pasted').includes(PASTE_LONG_TOKEN) && !screen('long pasted').includes('paste-line-49'),
        // The model's last user message carries every pasted line (first and last), not the placeholder.
        // Whole text, contiguous: the classic turn prompt prefixes screen context, so «equals» is not the test — the
        // full 699-char paste must appear unbroken (a dropped middle line fails), and no placeholder may leak (r1 must-fix).
        modelGotWhole: String(lastUser).includes(PASTE_LONG) && !String(lastUser).includes('[붙여넣음'),
        ctrlVPlaceholder: screen('ctrl+v').includes(CLIP_TOKEN),
        // Ctrl+V with text (no image) on the clipboard: the model receives the clipboard text (was: «No image», nothing in).
        ctrlVModelGotWhole: String(clipUser).includes(CLIP_TEXT) && !String(clipUser).includes('[붙여넣음'),
        clipboardReadObserved: paste('clipboard-read').length === 1,
        foldedObserved: paste('folded').length === 2 && paste('folded')[0]?.lines === 50 && paste('folded')[0]?.chars === 699,
        expandedObserved: paste('expanded').length === 2,
        onlyFakeProvider: onlyFake(rows),
        exitedClean: run.exitCode === 0,
      };
    });
  }

  if (spec.scenario === 'classic-goal-continue') {
    const reply = GOAL_CONTINUE_PLEDGE_REPLY;
    env[TEST_FAKE_LLM_RESPONSE_ENV] = reply;
    const banner = '↻ 자동 재개(goal-continue)';
    const replies = (s: string) => s.split(reply).length - 1;
    const steps: SeatPtyStep[] = [
      { label: 'human turn', text: '영상 만들어줘', until: (s) => replies(s) >= 1 },
      {
        label: 'continued',
        until: (s) => s.includes(banner) && replies(s) === 2 && turnDone(s.slice(s.lastIndexOf(banner))),
        timeoutMs: 60_000,
      },
    ];
    const run = await mockSeatPtySequence({ ...base, env, steps });
    const last = run.frames.at(-1)?.screen ?? '';
    const humanRoot = join(root, 'human-stop-case');
    mkdirSync(humanRoot, { recursive: true });
    writeFileSync(join(humanRoot, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const humanReply = '로그인이 필요합니다. 로그인해 주세요.';
    const humanRun = await mockSeatPtySequence({
      ...base, root: humanRoot,
      env: { ...env, ELANOUS_SESSION_ROOT: join(humanRoot, 'sessions'), [TEST_FAKE_LLM_RESPONSE_ENV]: humanReply },
      steps: [{ label: 'human-only action stops', text: '계정 상태 확인을 계속해줘', until: (s) => s.includes(humanReply) && turnDone(s), timeoutMs: 60_000 }],
    });
    const humanRows = rowsOf(readLogs({ root: humanRoot, executable: spec.executable, entry: spec.entry }, logCategories));
    const remainingRoot = join(root, 'remaining-work-case');
    mkdirSync(remainingRoot, { recursive: true });
    writeFileSync(join(remainingRoot, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const remainingReply = '남은 작업: 자막 검증은 아직 완료되지 않았습니다.';
    const remainingRun = await mockSeatPtySequence({
      ...base, root: remainingRoot,
      env: { ...env, ELANOUS_SESSION_ROOT: join(remainingRoot, 'sessions'), [TEST_FAKE_LLM_RESPONSE_ENV]: remainingReply },
      steps: [{ label: 'remaining work continues', text: '요청한 자막 검증을 완료해줘', until: (s) => s.includes('↻ 자동 재개(goal-continue)') && s.split(remainingReply).length - 1 >= 2 && turnDone(s), timeoutMs: 60_000 }],
    });
    const remainingRows = rowsOf(readLogs({ root: remainingRoot, executable: spec.executable, entry: spec.entry }, logCategories));
    return finish(run, { reply }, (rows) => {
      const decided = rows.filter((r) => r.category === 'tui.goal-continue' && r.event === 'decided')
        .map((r) => parseData<{ opened?: boolean; rejected?: boolean; reason: string }>(r.data));
      const opened = rows.filter((r) => r.category === 'tui.autoturn' && r.event === 'opened').map((r) => parseData<{ origin: string }>(r.data));
      const proactive = rows.filter((r) => r.category === 'tui.proactive' && r.event === 'continue').map((r) => parseData<{ reason: string }>(r.data));
      return {
        goalContinueOpenedOnce: decided.filter((d) => d.opened === true).length === 1,
        classicTurnEndReachedProactiveJudge: proactive.some((d) => d.reason === 'pledge-without-result'),
        classicHumanOnlyActionStops: humanRows.some((r) => r.category === 'tui.proactive' && r.event === 'stop-human' && parseData<{ reason: string }>(r.data).reason === 'human-action')
          && !humanRun.frames.at(-1)?.screen.includes('↻ 자동 재개(goal-continue)'),
        classicRemainingWorkContinues: remainingRows.some((r) => r.category === 'tui.proactive' && r.event === 'continue' && parseData<{ reason: string }>(r.data).reason === 'work-remaining')
          && remainingRun.exitCode === 0,
        internalTurnOrigin: opened.length === 1 && opened[0]?.origin === 'goal-continue',
        bannerOnScreen: (run.frames.find((f) => f.label === 'continued')?.screen ?? '').includes(banner),
        sameReplyStopped: decided.some((d) => d.rejected === true && d.reason === 'same-reply'),
        noLoop: replies(last) === 2,
        onlyFakeProvider: onlyFake(rows),
        exitedClean: run.exitCode === 0,
      };
    });
  }

  if (spec.scenario === 'classic-goal-interim') {
    env[TEST_FAKE_LLM_RESPONSE_ENV] = GOAL_INTERIM_NOT_DONE_REPLY;
    env[TEST_FAKE_LLM_TOOL_CALL_ENV] = GOAL_INTERIM_TOOL_CALL;
    const capLine = '골 이어가기 상한';
    let settledAt = 0;
    const steps: SeatPtyStep[] = [
      { label: 'human turn', text: '영상 만들어줘', until: (s) => goalInterimScreenCounts(s).steps >= 1 },
      {
        // goal-continue stops at its consecutive cap (a «⏸ … 상한» line) after the last internal turn settles.
        label: 'settled',
        until: (s) => {
          const ok = s.includes(capLine) && turnDone(s.slice(s.lastIndexOf('↻ 자동 재개')));
          if (ok && settledAt === 0) settledAt = Date.now();
          return ok;
        },
        timeoutMs: 90_000,
      },
      { label: 'quiet', until: () => settledAt > 0 && Date.now() >= settledAt + 12_000, timeoutMs: 30_000 },
    ];
    const run = await mockSeatPtySequence({ ...base, rows: 50, env, steps });
    const last = goalInterimScreenCounts(run.frames.at(-1)?.screen ?? '');
    return finish(run, { reply: GOAL_INTERIM_NOT_DONE_REPLY, last }, (rows) => {
      const opened = rows.filter((r) => r.category === 'tui.goal-continue' && r.event === 'decided')
        .map((r) => parseData<{ opened?: boolean }>(r.data)).filter((d) => d.opened === true).length;
      const folded = rows.filter((r) => r.category === 'tui.goal-interim' && r.event === 'folded').length;
      return {
        continuedSeveral: opened >= 2,
        everyStepOnScreen: last.steps === opened + 1,
        notDoneAtMostOnce: last.notDone <= 1,
        finalReportShown: last.notDone === 1,
        foldedEachContinued: last.folded === opened && folded === opened,
        noUserHeaderForInternal: run.frames.every((f) => !INTERNAL_TURN_USER_HEADER.test(f.screen)),
        // The first turn's tool line survives the fold of that turn's reply (only the reply block folds).
        toolLineKept: (run.frames.at(-1)?.screen ?? '').includes('ScheduleWakeup'),
        onlyFakeProvider: onlyFake(rows),
        exitedClean: run.exitCode === 0,
      };
    });
  }

  if (spec.scenario === 'classic-wakeup') {
    // The first turn calls ScheduleWakeup(60s). 45s later a human turn starts that the fake keeps busy for 150s,
    // so the due time and two more minute-retries all land inside it. Before the fix the scheduler dropped the
    // wakeup after one retry (`skipped` ⊕ «놓침» line); now it keeps deferring and opens one turn once idle.
    const banner = '↻ 자동 재개(scheduled): 점검';
    env[TEST_FAKE_LLM_TOOL_CALL_ENV] = JSON.stringify({ when: '예약해줘', name: 'ScheduleWakeup', args: { delaySeconds: 60, reason: '점검' } });
    env[TEST_FAKE_LLM_DELAY_MS_ENV] = '150000';
    env[TEST_FAKE_LLM_DELAY_WHEN_ENV] = '긴 작업';
    let scheduledAt = 0;
    const steps: SeatPtyStep[] = [
      {
        label: 'scheduled', text: '60초 뒤 예약해줘',
        until: (s) => {
          const ok = s.includes('⏰ 예약 깨움') && turnDone(s);
          if (ok && scheduledAt === 0) scheduledAt = Date.now();
          return ok;
        },
      },
      { label: 'before due', until: () => scheduledAt > 0 && Date.now() >= scheduledAt + 45_000, timeoutMs: 60_000 },
      { label: 'busy over the due time', text: '긴 작업 하나', until: (s) => s.includes('긴 작업 하나') },
      { label: 'woke', until: (s) => s.includes(banner) && turnDone(s.slice(s.lastIndexOf(banner))), timeoutMs: 600_000 },
      // ↑ the classic turn prompt carries recent screen output, which still holds «긴 작업», so the fake delays the
      //   wake turn too (~150s) — the window covers busy remainder ⊕ minute retry ⊕ that second delay.
    ];
    const run = await mockSeatPtySequence({ ...base, env, steps });
    const screens = run.frames.map((f) => f.screen).join('\n');
    const after = run.frames.at(-1)?.screen ?? '';
    return finish(run, { delaySeconds: 60, busyMs: 150_000 }, (rows) => {
      const wake = (event: string) => rows.filter((r) => r.category === 'tui.wakeup' && r.event === event)
        .map((r) => parseData<{ id: string; reason: string; retried?: boolean }>(r.data));
      const rejected = wake('rejected').filter((r) => r.reason === 'NotIdle' || r.reason === 'HumanTyping');
      const fired = wake('fired');
      const opened = rows.filter((r) => r.category === 'tui.autoturn' && r.event === 'opened').map((r) => parseData<{ origin: string }>(r.data));
      return {
        scheduledOnce: wake('scheduled').length === 1,
        // ≥ 3 busy refusals = due ⊕ two minute-retries — past the point where the old scheduler gave up.
        deferredPastOldDrop: rejected.length >= 3 && rejected.every((r) => r.id === rejected[0]?.id),
        notSkipped: wake('skipped').length === 0,
        firedOnceAfterDefer: fired.length === 1 && fired[0]?.id === rejected[0]?.id && fired[0]?.retried === true,
        internalTurnOpened: opened.length === 1 && opened[0]?.origin === 'scheduled',
        noMissedLine: !screens.includes('예약 깨움 놓침'),
        bannerOnScreen: after.includes(banner),
        onlyFakeProvider: onlyFake(rows),
        exitedClean: run.exitCode === 0,
      };
    });
  }

  // classic-typing-lag: cwd = a git repo with a few thousand tracked files so the turn-start git snapshot is real work.
  const git = (...args: string[]) => spawnSync('git', ['-C', root, '-c', 'user.name=n03', '-c', 'user.email=n03@example.invalid', ...args], { encoding: 'utf8' });
  if (git('init', '-q').status !== 0) throw new Error('N03 classic-typing-lag: git init failed');
  const files = join(root, 'work');
  mkdirSync(files, { recursive: true });
  for (let i = 0; i < 2000; i++) writeFileSync(join(files, `f${i}.txt`), `${i}\n`);
  writeFileSync(join(root, '.gitignore'), 'logs/\nsessions/\nmsg/\n*.db\n');
  if (git('add', '-A').status !== 0 || git('commit', '-qm', 'seed').status !== 0) throw new Error('N03 classic-typing-lag: seed commit failed');
  const typed = 'abcdefghijklmnopqrstuvwxyz0123';
  const steps: SeatPtyStep[] = [
    // Enter, then the next keys arrive while the turn starts (30ms apart, like a fast typist).
    { label: 'typed while turn starts', chunks: ['타이핑 지연 측정', '\r', ...typed.split('')], gapMs: 30, until: (s) => s.includes(`❯ ${typed}`) && turnDone(s) },
    // Send what was typed so the composer is empty again before `/exit` (otherwise `/exit` would append to it).
    { label: 'typed text sent', keys: '\r', until: (s) => s.split(REPLY).length - 1 === 2 && turnDone(s) },
  ];
  const run = await mockSeatPtySequence({ ...base, env, steps });
  const after = run.frames.find((f) => f.label === 'typed while turn starts')?.screen ?? '';
  const logs = readLogs({ root, executable: spec.executable, entry: spec.entry }, logCategories);
  const rows = rowsOf(logs);
  const lag = rows.filter((r) => r.category === 'tui.input-lag' && r.event === 'measured').map((r) => parseData<{ phase: string; keyToPaintMs?: number; loopDelayMs?: { p99: number; max: number } }>(r.data));
  const turnStart = lag.filter((l) => l.phase === 'turn-start');
  const keys = lag.filter((l) => l.phase === 'keystroke' && typeof l.keyToPaintMs === 'number');
  const store = {
    trackedFiles: 2000,
    typed,
    // Rows without a measured value are left out (never shown as 0ms); none at all → null.
    turnStartLoopDelayMaxMs: ((v) => (v.length ? Math.max(...v) : null))(turnStart.map((l) => l.loopDelayMs?.max).filter((n): n is number => typeof n === 'number')),
    keystrokeRows: keys.length,
    keyToPaintMaxMs: keys.length ? Math.max(...keys.map((l) => Number(l.keyToPaintMs))) : null,
  };
  return {
    scenario: spec.scenario, universe: root, run, store, logs,
    checks: {
      typedEchoedComplete: after.includes(`❯ ${typed}`),
      turnStartMeasured: turnStart.length >= 1,
      keystrokeMeasured: keys.length >= 1,
      turnAnswered: after.includes(REPLY),
      onlyFakeProvider: onlyFake(rows),
      exitedClean: run.exitCode === 0,
    },
  };
}
