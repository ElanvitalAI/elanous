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

// Each scenario explicitly boots this tree's classic TUI (`--tui classic`) on a real PTY with the network-free
// fake LLM (`ELANOUS_TEST_FAKE_LLM_AS_PROVIDER=1`) and reads the universe back through the same CLI's
// `logs`. One TUI at a time (sequential tests) — the seat host carries one isolated TUI per run.
async function run(scenario: ClassicTuiScenario, rows = 30) {
  const dir = mkdtempSync(join(tmpdir(), `n03-${scenario}-`));
  try {
    return await runClassicTuiScenario({ scenario, root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI, rows });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('classic TUI scenarios on N03 (this tree · fake LLM)', () => {
  test('scenario list is the CLI contract', () => {
    expect([...CLASSIC_TUI_SCENARIOS]).toEqual(['classic-first-screen-noise', 'classic-inline-picker', 'classic-400-heal', 'classic-400-exhausted', 'classic-seat-boot', 'classic-typing-lag', 'classic-priority-keys', 'classic-mcp-calltool', 'classic-wakeup', 'classic-goal-continue', 'classic-goal-interim', 'classic-paste', 'classic-orphan-autostop']);
  });

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
