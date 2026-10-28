import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLASSIC_TUI_SCENARIOS, runClassicTuiScenario, type ClassicTuiScenario } from './classic-tui-seat-scenarios.js';
import { dispatchDashboardChatMainAcpSend } from '../dashboard/input/chat-main-acp-dispatch.js';
import { DashboardAcpChat } from '../dashboard/chat/acp-chat.js';
import { goalInterimScreenCounts } from './next-tui-seat-scenarios.js';
import { GOAL_INTERIM_RENDER_TRACE, goalInterimRenderMessages } from './goal-interim-trace.js';
import { logViewLines } from '../tui/chat/log-view.js';

const REPO_CLI = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');

// Each scenario boots this tree's classic TUI (bare `elanous`) on a real PTY with the network-free
// fake LLM (`ELANOUS_TEST_FAKE_LLM_AS_PROVIDER=1`) and reads the universe back through the same CLI's
// `logs`. One TUI at a time (sequential tests) — the seat host carries one isolated TUI per run.
async function run(scenario: ClassicTuiScenario) {
  const dir = mkdtempSync(join(tmpdir(), `n03-${scenario}-`));
  try {
    return await runClassicTuiScenario({ scenario, root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('classic TUI scenarios on N03 (this tree · fake LLM)', () => {
  test('ACP production renderer folds two goal iterations, preserving tool and final reply', async () => {
    const lines: string[] = [];
    const { interimReplies: interim, userInput, finalReply, toolCalls } = GOAL_INTERIM_RENDER_TRACE;
    const chat = new DashboardAcpChat({
      cwd: process.cwd(), disableStreamSmoothing: true,
      sessionStore: { get: () => null, set: () => {}, delete: () => true },
      agentManager: { getAgent: async () => ({
        newSession: async () => 'goal-iteration-mock',
        prompt: async (_sessionId, _blocks, onUpdate) => {
          const chunk = (text: string) => onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
          const tool = (label: string) => onUpdate({ sessionUpdate: 'tool_call', toolCallId: label, title: label, kind: 'other', status: 'completed' });
          tool(toolCalls[0]);
          for (const reply of interim) {
            chunk(reply.split('\n')[0]!);
            tool(toolCalls[1]);
            chunk(reply.split('\n')[1]!);
            onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' }, _meta: { goalInterim: reply } });
          }
          chunk(finalReply);
          return { stopReason: 'end_turn' };
        },
        cancel: async () => {},
      }) },
    });
    const done = Promise.withResolvers<void>();
    dispatchDashboardChatMainAcpSend({
      dashboardAcpChat: chat,
      backend: 'claude', message: userInput, attachments: [], debugEnabled: false,
      chatLines: lines, setChatScrollToTail: () => {}, redraw: () => {},
      formatAssistantLines: (text) => text.split('\n'), formatUserLine: (_display, text) => text,
      formatMutedLine: (line) => line, formatToolLine: (line) => line,
      formatDebugLine: () => '', formatErrorLine: (_display, text) => text,
      formatAssistantPrefix: () => '엘라누스:',
      onTurnDone: () => done.resolve(),
    });
    await done.promise;
    const screen = lines.join('\n');
    const nextScreen = logViewLines(goalInterimRenderMessages('2026-10-22T00:00:00.000Z'), 100).join('\n');
    const classicInterimCount = screen.match(/· 진행 —/g)?.length ?? 0;
    const nextInterimCount = goalInterimScreenCounts(nextScreen).folded;
    expect(interim.length).toBeGreaterThan(0);
    expect(classicInterimCount).toBe(interim.length);
    expect(nextInterimCount).toBe(classicInterimCount);
    expect(screen.split('\n').filter((line) => line.includes('· 진행 —')).every((line) => !line.includes('아직 못 했습니다.'))).toBe(true);
    expect(screen).not.toContain('아직 못 했습니다.');
    expect(screen).not.toContain('  1단계 렌더했습니다.');
    expect(screen).not.toContain('  2단계 렌더했습니다.');
    expect(screen.match(/ScheduleWakeup progress/g)).toHaveLength(2);
    expect(screen).toContain(toolCalls[0]);
    expect(screen).toContain(finalReply);
  });
  test('scenario list is the CLI contract', () => {
    expect([...CLASSIC_TUI_SCENARIOS]).toEqual(['classic-400-heal', 'classic-400-exhausted', 'classic-seat-boot', 'classic-typing-lag', 'classic-mcp-calltool', 'classic-wakeup', 'classic-goal-continue', 'classic-goal-interim', 'classic-paste', 'classic-orphan-autostop']);
  });

  test('classic-400-heal: a 400 (history mismatch) turn heals with a new session and answers', async () => {
    const r = await run('classic-400-heal');
    expect(r.checks).toEqual({
      before400Screen: true, healLineOnScreen: true, answeredAfterHeal: true, attemptNewSession: true,
      recoveredObserved: true, sessionRenewed: true, onlyFakeProvider: true, exitedClean: true,
    });
  }, 150_000);

  test('classic-400-exhausted: a 400 that persists stops with one reason line inside the per-turn cap', async () => {
    const r = await run('classic-400-exhausted');
    expect(r.checks).toEqual({
      healLineOnScreen: true, stopReasonOnScreen: true, failedTurnOnScreen: true, exhaustedObserved: true,
      attemptsWithinCap: true, noRecovered: true, onlyFakeProvider: true, exitedClean: true,
    });
  }, 150_000);

  test('classic-seat-boot: a seat universe shows the boot line on the first screen and injects the card into the first turn', async () => {
    const r = await run('classic-seat-boot');
    expect(r.checks).toEqual({
      memoryRecallObserved: true, memoryRecallInFirstTurnPreamble: true, memoryRecallWithinCap: true,
      bootLineOnFirstScreen: true, cardInjectedObserved: true, cardUnreadMatchesSeed: true,
      cardOncePerConversation: true, firstTurnAnswered: true, onlyFakeProvider: true, exitedClean: true,
    });
  }, 150_000);

  test('classic-typing-lag: keys typed right after Enter echo completely and the lag probe measures turn start and keystrokes', async () => {
    const r = await run('classic-typing-lag');
    expect(r.checks).toEqual({
      typedEchoedComplete: true, turnStartMeasured: true, keystrokeMeasured: true,
      turnAnswered: true, onlyFakeProvider: true, exitedClean: true,
    });
    expect(typeof r.store.keyToPaintMaxMs).toBe('number');
  }, 150_000);

  test('classic-mcp-calltool: deferred MCP child is absent at boot and the first TUI tool dispatch succeeds once', async () => {
    const r = await run('classic-mcp-calltool');
    expect(r.checks).toEqual({
      childWasAbsentAfterDeferredBoot: true,
      fakeServerStartedOnce: true,
      actualMcpToolsCallOnce: true,
      lazyBootDeferredThenFirstCall: true,
      firstCallResultReachedTui: true,
      onlyFakeProvider: true,
      exitedClean: true,
    });
  }, 150_000);

  // ~6 min on a real PTY (the minute retry is the production interval, not a fake clock) — opt-in so the changed-file
  // gate stays bounded. Run it with ELANOUS_N03_SLOW=1, or as the device: `bun scripts/ux-sim.ts seat-seq classic-wakeup`.
  test.skipIf(process.env.ELANOUS_N03_SLOW !== '1')('classic-wakeup: a wakeup due while a long human turn runs is deferred past the old drop point and opens one turn', async () => {
    const r = await run('classic-wakeup');
    expect(r.checks).toEqual({
      scheduledOnce: true, deferredPastOldDrop: true, notSkipped: true, firedOnceAfterDefer: true,
      internalTurnOpened: true, noMissedLine: true, bannerOnScreen: true, onlyFakeProvider: true, exitedClean: true,
    });
  }, 900_000);

  // Two real turns ⊕ a clipboard read on a real PTY — past the gate's per-test 120 s on a loaded side host
  // (10-22 train host-e timed-out) — opt-in like classic-wakeup; the device CLI stays the E4 path.
  // TUI-ORPHAN-AUTO-RESUME-STOP E4 (10-23): ~2.5 min on a real PTY (two 30s human-quiet windows ⊕ a 45s hold) — opt-in.
  // Against main's product code with only this PR's fake-llm cells, the four stop checks were false.
  test.skipIf(process.env.ELANOUS_N03_SLOW !== '1')('classic-orphan-autostop: the same Codex orphan 400 twice stops autowake once · a fresh mail does not wake it · a person still gets an answer', async () => {
    const r = await run('classic-orphan-autostop');
    expect(r.checks).toEqual({
      orphan400Injected: true, autowakeOpenedOnce: true, terminalLoggedOnce: true, stopLineOnScreen: true, noAutowakeAfterTerminal: true,
      humanInputStillWorks: true, onlyFakeProvider: true, exitedClean: true,
    });
  }, 300_000);

  test.skipIf(process.env.ELANOUS_N03_SLOW !== '1')('classic-paste: short paste echoes · 50-line paste shows one placeholder · Ctrl+V pastes clipboard text · the model gets the whole text', async () => {
    const r = await run('classic-paste');
    expect(r.checks).toEqual({
      shortEchoed: true, longPlaceholder: true, modelGotWhole: true, ctrlVPlaceholder: true, ctrlVModelGotWhole: true,
      clipboardReadObserved: true, foldedObserved: true, expandedObserved: true, onlyFakeProvider: true, exitedClean: true,
    });
  }, 180_000);

  test('classic-goal-continue: same-reply rejection stops the loop without a timed quiet window', async () => {
    const r = await run('classic-goal-continue');
    expect(r.checks).toEqual({
      goalContinueOpenedOnce: true, classicTurnEndReachedProactiveJudge: true, classicHumanOnlyActionStops: true, classicRemainingWorkContinues: true,
      internalTurnOrigin: true, bannerOnScreen: true, sameReplyStopped: true,
      noLoop: true, onlyFakeProvider: true, exitedClean: true,
    });
  }, 180_000);

  // 재현(TUI-GOAL-INTERIM-QUIET · n8n 10-22 22:4x): every step ends «아직 못 했다» → before, one «not done» paragraph
  // per step piled up. Four real turns on a PTY — opt-in like classic-paste; the device CLI is the E4 path.
  test.skipIf(process.env.ELANOUS_N03_SLOW !== '1')('classic-goal-interim: goal-continue to its cap folds each continued step to one line and shows the «not done» paragraph once', async () => {
    const r = await run('classic-goal-interim');
    expect(r.checks).toEqual({
      continuedSeveral: true, everyStepOnScreen: true, notDoneAtMostOnce: true, finalReportShown: true,
      foldedEachContinued: true, noUserHeaderForInternal: true, toolLineKept: true, onlyFakeProvider: true, exitedClean: true,
    });
  }, 240_000);
});
