import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSessions, loadSession } from '../session/index.js';
import { TEST_FAKE_LLM_ENV, TEST_FAKE_LLM_RESPONSE_ENV, TEST_FAKE_LLM_TOOL_CALL_ENV } from './fake-llm.js';
import { mockSeatPtySequence } from './mock-seat-pty-sequence.js';
import { parseData, runNextTuiScenario } from './next-tui-seat-scenarios.js';

const PROBE = join(import.meta.dir, 'mock-seat-pty-sequence-child.ts');
const REPO_CLI = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
const nextTuiTurnSettled = (screen: string): boolean => {
  const lines = screen.split('\n');
  const composer = lines.reduce((last, line, index) => line.startsWith('❯ ') ? index : last, -1);
  const status = composer > 0 ? lines[composer - 1]!.trim() : '';
  return status.startsWith('턴 완료 ·') && !/대기\s+[1-9]\d*/.test(status);
};

describe('N03 key sequence: one screen per step on a real PTY', () => {
  test('seat-seq CLI advertises the next-resume scenario', () => {
    const run = spawnSync('bun', ['scripts/ux-sim.ts', 'seat-seq', 'not-a-scenario', '--root', '/tmp/n03-unused'], {
      cwd: join(import.meta.dir, '..', '..'), encoding: 'utf8', timeout: 30_000,
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('next-resume');
    expect(run.stderr).toContain('next-core-harden');
  });

  test('B3 /quit migration: quit-like plain text stays a chat turn in classic and next PTY', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-quit-text-'));
    const reply = '[fake-llm] quit text handled';
    const inputs = ['quit', 'exit', '종료', '그만'];
    try {
      for (const mode of ['classic', 'next'] as const) {
        for (const input of inputs) {
          const root = join(dir, mode, input);
          mkdirSync(root, { recursive: true });
          writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
          const run = await mockSeatPtySequence({
            executable: process.execPath,
            args: [REPO_CLI, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', mode],
            root,
            env: {
              [TEST_FAKE_LLM_ENV]: '1',
              ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
              [TEST_FAKE_LLM_RESPONSE_ENV]: reply,
              ELANOUS_SESSION_ROOT: join(root, 'sessions'),
              ELANOUS_CONFIG_DIR: root,
              ELANOUS_STATE_DIR: root,
              ELANOUS_STATE_DIR_SOURCE: 'explicit',
            },
            ready: { label: `${mode} boot`, until: (screen) => screen.includes('❯ ') },
            steps: [{
              label: `${mode} treats ${input} as ordinary text`,
              text: input,
              until: (screen) => screen.includes(input) && screen.includes(reply)
                && (mode === 'classic' ? screen.includes('✔ 완료') : nextTuiTurnSettled(screen)),
              timeoutMs: 30_000, // Source: #36860 bounded fake-provider PTY reply deadline.
            }],
            quitKeys: '\x11',
            exitTimeoutMs: 20_000, // Source: #36860 bounded Ctrl+Q terminal cleanup wait.
          });
          expect(run.frames).toHaveLength(2);
          expect(run.exitCode).toBe(0);
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 180_000);

  test('each step is read back as the screen the probe rendered, in order, with an isolated HOME', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-seq-'));
    try {
      const root = join(dir, 'root');
      const artifactPath = join(dir, 'seq.json');
      const run = await mockSeatPtySequence({
        executable: process.execPath, args: [PROBE], root, runId: 'n03-seq-1', artifactPath, cols: 200,
        ready: { label: 'boot', until: 'N03 seq ready' },
        steps: [
          { label: 'a', keys: 'a', until: 'count=1 last=a' },
          { label: 'b', keys: 'b', until: 'count=2 last=b' },
        ],
      });
      expect(run.frames.map((f) => f.label)).toEqual(['boot', 'a', 'b']);
      expect(run.frames[0]!.screen).toContain(`home=${root}`);
      expect(run.frames[0]!.screen).toContain('skipLogin=1');
      expect(run.frames[1]!.screen).toContain('N03 seq count=1 last=a');
      expect(run.frames[2]!.screen).toContain('N03 seq count=2 last=b');
      expect(run.frames[2]!.input).toBe('b');
      expect(run.exitCode).toBe(0);
      expect(run.binarySha256).toMatch(/^[a-f0-9]{64}$/);
      expect(run.entrySha256).toMatch(/^[a-f0-9]{64}$/);
      expect(run.rootKept).toBe(true);
      expect(existsSync(root)).toBe(true);
      expect(JSON.parse(readFileSync(artifactPath, 'utf8'))).toEqual(JSON.parse(JSON.stringify(run)));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  test('refuses credential-shaped child env and a different executable SHA before spawning', async () => {
    const base = { executable: process.execPath, args: [PROBE], ready: { label: 'boot', until: 'x' }, steps: [{ label: 's', keys: 'a', until: 'x' }] };
    await expect(mockSeatPtySequence({ ...base, env: { XAI_API_KEY: 'k' } })).rejects.toThrow('credential-shaped env: XAI_API_KEY');
    await expect(mockSeatPtySequence({ ...base, env: { ANTHROPIC_BASE_URL: 'u' } })).rejects.toThrow('credential-shaped env');
    await expect(mockSeatPtySequence({ ...base, expectedBinarySha256: '0'.repeat(64) })).rejects.toThrow('binary SHA mismatch');
    await expect(mockSeatPtySequence({ ...base, steps: [] })).rejects.toThrow('at least one step');
  });
});

// The scenarios drive the real `--tui next` of this tree on the network-free fake LLM and read
// the universe back through the same CLI's `logs`. The busy-/new probe is a timing race (the fake
// LLM answers in milliseconds), so it is reported as a check but not asserted here.
describe('next TUI scenarios on N03 (this tree · fake LLM)', () => {
  test('classic and next PTY compare the same three-child request; next folds lifecycle noise into one completed card', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-three-child-tui-compare-'));
    const ask = '세 자식으로 조사해줘';
    const parentReply = '[fake] 세 자식 작업 완료';
    async function runPtyMode(name: 'classic' | 'next') {
      const root = join(dir, name);
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
      const next = name === 'next';
      const calls: Array<{ name: string; args: Record<string, unknown> }> = [1, 2, 3].map((index) => ({
        name: 'Agent', args: { description: `child ${index}`, prompt: `고정 child 지시 ${index}` },
      }));
      if (next) calls.push({ name: 'AgentOutput', args: { taskId: '$previousToolResult.taskId', block: false } });
      const sequence = JSON.stringify({ when: '세 자식', calls });
      return await mockSeatPtySequence({
        executable: process.execPath,
        args: [REPO_CLI, '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', next ? 'next' : 'classic'],
        root, rows: 30, cols: 100, runId: `n03-three-child-${name}`,
        env: {
          ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
          ELANOUS_TEST_FAKE_LLM_RESPONSE: parentReply, [TEST_FAKE_LLM_TOOL_CALL_ENV]: sequence,
        },
        quitKeys: next ? '\x11' : '/exit\r', exitTimeoutMs: 20_000,
        ready: { label: 'boot', until: next
          ? (screen) => screen.includes('바로 입력해 보세요:') && screen.includes('Ctrl+Q 종료')
          : (screen) => (screen.includes('elanous | daemon') || screen.includes('Opening web setup…')
            || screen.includes('웹 화면을 여는 중…') || screen.trimStart().startsWith('elanous')) && screen.includes('❯') },
        steps: [{ label: 'three-child request', text: ask,
          until: (screen) => screen.includes(parentReply) && (next
            ? screen.includes('완료 3') && nextTuiTurnSettled(screen)
            : screen.includes('✔ 완료')) }],
      });
    }
    try {
      const classic = await runPtyMode('classic');
      const next = await runPtyMode('next');
      const classicScreen = classic.frames.at(-1)?.screen ?? '';
      const nextScreen = next.frames.at(-1)?.screen ?? '';
      const sessionMessages = (name: 'classic' | 'next') => {
        const root = join(dir, name);
        const sessionRoot = join(root, 'sessions');
        return listSessions({}, sessionRoot).flatMap(({ id }) => loadSession(id, sessionRoot)?.messages ?? []);
      };
      const classicMessages = sessionMessages('classic');
      const nextMessages = sessionMessages('next');
      const toolNames = (messages: typeof classicMessages) => messages
        .filter((message) => message.role === 'tool').map((message) => message.toolName ?? '');
      const classicTools = toolNames(classicMessages);
      const nextTools = toolNames(nextMessages);
      expect(classic.exitCode).toBe(0);
      expect(next.exitCode).toBe(0);
      expect(nextScreen.match(/하위 에이전트 ·/g)?.length).toBe(1);
      expect(nextScreen).toContain('완료 3');
      expect(nextScreen).not.toMatch(/실행 중 \d|진행 중/);
      expect(nextScreen).not.toContain('AgentOutput');
      expect(classicTools).toContain('Agent');
      expect(nextTools).toContain('Agent');
      expect(classicTools.filter((name) => name === 'Agent')).toHaveLength(3);
      expect(nextTools).toContain('AgentOutput');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 180_000);

  test('next TUI PTY dispatches its read-only AgentList runtime', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-next-runtime-dispatch-'));
    const root = join(dir, 'iso');
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'config.json'), JSON.stringify({
        onboarding: { completed: true }, errorReports: { enabled: false },
      }));
      const run = await mockSeatPtySequence({
        executable: process.execPath,
        args: [REPO_CLI, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
        root,
        env: {
          ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
          ELANOUS_TEST_FAKE_LLM_RESPONSE: '[fake] runtime dispatch complete',
          [TEST_FAKE_LLM_TOOL_CALL_ENV]: JSON.stringify({ when: 'PLUGIN-RUNTIME-PTY', name: 'AgentList', args: {} }),
        },
        ready: { label: 'boot', until: (screen) => screen.startsWith('elanous\n') && screen.includes('Ctrl+Q 종료') },
        steps: [{
          label: 'runtime dispatch', text: 'PLUGIN-RUNTIME-PTY',
          until: (screen) => screen.includes('[fake] runtime dispatch complete') && screen.includes('❯') && !screen.includes('INVALID TOOL'),
        }],
      });
      const screen = run.frames.find((frame) => frame.label === 'runtime dispatch')?.screen ?? '';
      const messages = listSessions({}, join(root, 'sessions'))
        .flatMap(({ id }) => loadSession(id, join(root, 'sessions'))?.messages ?? []);
      expect(run.exitCode).toBe(0);
      expect(messages.some((message) => message.role === 'tool' && message.toolName === 'AgentList')).toBe(true);
      expect(screen).toContain('[fake] runtime dispatch complete');
      const sessionFiles = readdirSync(root, { recursive: true }).map(String).filter((path) => path.endsWith('.jsonl'));
      expect(sessionFiles.some((path) => readFileSync(join(root, path), 'utf8').includes('"toolName":"AgentList"'))).toBe(true);
      expect(screen).not.toContain('runtime unavailable in REPL');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 150_000);

  test('next TUI PTY resolves a declared graph route and reports its owner-required denial', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-next-plugin-dispatch-'));
    const root = join(dir, 'iso');
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'config.json'), JSON.stringify({
        onboarding: { completed: true }, errorReports: { enabled: false },
      }));
      const run = await mockSeatPtySequence({
        executable: process.execPath,
        args: [REPO_CLI, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
        root,
        env: {
          ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
          ELANOUS_TEST_FAKE_LLM_RESPONSE: '[fake] plugin dispatch complete',
          [TEST_FAKE_LLM_TOOL_CALL_ENV]: JSON.stringify({ when: 'PLUGIN-GRAPH-PTY', name: 'suggest_list', args: {} }),
        },
        ready: { label: 'boot', until: (screen) => screen.startsWith('elanous\n') && screen.includes('Ctrl+Q 종료') },
        steps: [{
          label: 'graph plugin dispatch', text: 'PLUGIN-GRAPH-PTY',
          until: (screen) => screen.includes('[fake] plugin dispatch complete')
            && screen.includes('graph route requires a verified owner context') && screen.includes('❯'),
        }],
      });
      const screen = run.frames.find((frame) => frame.label === 'graph plugin dispatch')?.screen ?? '';
      expect(run.exitCode).toBe(0);
      expect(screen).toContain('graph route requires a verified owner context');
      expect(screen).not.toContain('native plugin handler is not registered');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 150_000);

  test('next-seat-turn-cap: the seat turn returns at its cap, accepts a new turn, then cancels a fresh draft', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-next-seat-cap-'));
    try {
      const r = await runNextTuiScenario({ scenario: 'next-seat-turn-cap', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
      expect(r.checks).toEqual({
        capRecordedInRealSeatTurn: true, capExhaustionObservedBeforeIdleInput: true, nextSubmittedHumanTurnFinished: true, nextDraftReachedIdleComposer: true,
        escapeCanceledIdleDraft: true, onlyFakeProvider: true, exitedClean: true,
      });
      expect(r.logs.rc).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 150_000);

  test('next-at-picker: loads on @, lists a local file, and sends its path as an attachment with the prompt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-next-at-picker-'));
    try {
      const r = await runNextTuiScenario({ scenario: 'next-at-picker', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
      expect(Object.values(r.checks).every(Boolean)).toBe(true);
      expect(r.checks).toMatchObject({
        'pickerLivesImmediatelyAboveComposer:24': true,
        'selectionClosesPanelAndRestoresComposer:24': true,
        'slashCandidatesInInputArea:24': true,
        'slashPickerLivesImmediatelyAboveComposer:24': true,
        'slashEscRestoresDraft:24': true,
        'slashSelectionRunsCommand:24': true,
        'ordinaryTurnEscCancelsImmediately:24': true,
        'pickerLivesImmediatelyAboveComposer:40': true,
        'selectionClosesPanelAndRestoresComposer:40': true,
        'slashCandidatesInInputArea:40': true,
        'slashPickerLivesImmediatelyAboveComposer:40': true,
        'slashEscRestoresDraft:40': true,
        'slashSelectionRunsCommand:40': true,
        'ordinaryTurnEscCancelsImmediately:40': true,
      });
      expect(parseData<{ value: string }>(['not', 'an', 'object'])).toEqual({});
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 150_000);

  test('next-context-area-clear: attachment inventory replaces stale paths after drop', async () => {
    const dir = mkdtempSync('/tmp/cx-');
    try {
      const root = join(dir, ...Array.from({ length: 6 }, (_, index) => `long-segment-${index}-${'x'.repeat(64)}`), 'iso');
      const r = await runNextTuiScenario({ scenario: 'next-context-area-clear', root, executable: process.execPath, entry: REPO_CLI });
      expect(r.checks).toEqual({
        firstPageShowsFixture: true, secondPageShowsFixture: true, longPathIsNavigable: true,
        inputRemainsVisibleDuringPathNavigation: true, areaStaysVisibleAfterLongActivity: true,
        pageUpAtFirstAttachmentPageEntersLogNavigation: true, logNavigationReturnsToComposer: true,
        longPathStaysVisibleAfterLongActivity: true, attachmentAddedAfterOpenRefreshesCount: true,
        attachmentAddedAfterOpenIsReachable: true,
        dropRemovesOnlySecondPath: true, clearRemovesLastPath: true, emptyListClearsPreviousArea: true, exitedClean: true,
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 150_000);

  test('next-dock-long-stream: keeps the composer pinned during a long stream and picker open/close', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-next-dock-stream-'));
    try {
      const r = await runNextTuiScenario({ scenario: 'next-dock-long-stream', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
      expect(Object.values(r.checks).every(Boolean)).toBe(true);
      expect(r.checks).toEqual({
        longOutputVisibleWhileBusy: true, composerPinnedDuringLongOutput: true, composerPinnedAfterCancel: true,
        composerPinnedWhilePickerOpen: true, composerPinnedAfterPickerClose: true,
        pickerClosedAndDraftRestored: true, exitedClean: true,
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 150_000);

  test('next-subagent-e4: Agent dispatch gives the child an inherited tool catalog and completes in the isolated universe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-next-subagent-e4-'));
    try {
      const r = await runNextTuiScenario({ scenario: 'next-subagent-e4', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
      expect(r.checks).toEqual({
        parentAndChildProviderCallsObserved: true, childWasNotForcedTextOnly: true,
        unknownAllowIgnored: true,
        childDispatchObservedInIsolatedLedger: true, childInheritedTools: true,
        parentTurnCompletedOnce: true, onlyFakeProvider: true, exitedClean: true,
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 180_000);

  test('next-subagent-e4 scopes dispatch and tool-filter checks when an isolated universe is reused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-next-subagent-reused-root-'));
    try {
      const root = join(dir, 'iso');
      const first = await runNextTuiScenario({ scenario: 'next-subagent-e4', root, executable: process.execPath, entry: REPO_CLI });
      const second = await runNextTuiScenario({ scenario: 'next-subagent-e4', root, executable: process.execPath, entry: REPO_CLI });
      const expected = {
        parentAndChildProviderCallsObserved: true, childWasNotForcedTextOnly: true,
        unknownAllowIgnored: true,
        childDispatchObservedInIsolatedLedger: true, childInheritedTools: true,
        parentTurnCompletedOnce: true, onlyFakeProvider: true, exitedClean: true,
      };
      expect(first.checks).toEqual(expected);
      expect(second.checks).toEqual(expected);
      expect(second.store.capturedRequests).toBe(first.store.capturedRequests);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 180_000);

  test('next-queue: Esc immediately restores queued input ahead of the draft', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-next-queue-restore-'));
    try {
      const r = await runNextTuiScenario({ scenario: 'next-queue', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
      expect(r.checks).toMatchObject({
        queueShownWhileBusy: true,
        userTurnsInOrder: true,
        threeReplies: true,
        draftKept: true,
        escCancelsWithoutShellConfirmation: true,
        escRestoresQueue: true,
        escRestoresQueueAndDraft: true,
        queueRestoreEventCarriesRestoredCount: true,
        onlyFakeProvider: true,
        exitedClean: true,
      });
      expect(r.logs.rc).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 180_000);

  test('next-core-harden: one verdict bundles large paste, queued turns plus Esc, long tool rendering, and multiple child agents', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-next-core-harden-'));
    try {
      const r = await runNextTuiScenario({ scenario: 'next-core-harden', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
      expect(r.checks).toEqual({
        largePasteSurvivesSubmission: true,
        queueBacklogPreservesOrder: true,
        escapeDuringTurnRestoresQueuedPrompt: true,
        longToolOutputRendersAndRefolds: true,
        multipleSubagentsInheritTools: true,
        allScenariosExitCleanly: true,
      });
      expect(r.logs.rc).toBe(0);
      expect(r.store).toMatchObject({ scenarios: [
        { name: 'large-paste' }, { name: 'queue-and-escape' }, { name: 'long-tool-output' },
        { name: 'multiple-subagents-one' }, { name: 'multiple-subagents-two' },
      ] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 600_000);

  test('next-new-session: /new clears the screen, the next turn uses a new session, the old one stays', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-next-new-'));
    try {
      const r = await runNextTuiScenario({ scenario: 'next-new-session', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
      const { busyNewRejected: _b, busyKeptSession: _k, ...deterministic } = r.checks;
      expect(deterministic).toEqual({
        screenClearedWithNewTitle: true, statusNamesPrevious: true, sessionNewObservedOnce: true,
        nextTurnInNewSession: true, oldSessionKept: true, onlyFakeProvider: true, exitedClean: true,
      });
      expect(r.logs.rc).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 150_000);

  test('next-clear-session: /clear is the same new-session action as /new', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-next-clear-'));
    try {
      const r = await runNextTuiScenario({ scenario: 'next-clear-session', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
      expect(r.checks).toEqual({
        screenClearedWithNewTitle: true, statusNamesPrevious: true, sessionNewObservedOnce: true,
        nextTurnInNewSession: true, oldSessionKept: true, busyNewRejected: true, busyKeptSession: true,
        onlyFakeProvider: true, exitedClean: true,
      });
      expect(r.logs.rc).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 150_000);

  test('next-compact: a seeded long session compacts once before the turn, then /compact once more', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-next-compact-'));
    try {
      const r = await runNextTuiScenario({ scenario: 'next-compact', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
      expect(r.checks).toEqual({
        autoCompactOnce: true, autoBeforeIsSeeded12: true, manualCompactOnce: true, screenShowsAuto: true,
        summaryFromFakeLlm: true, onlyFakeProvider: true, exitedClean: true,
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 150_000);

  test('next-resume: /resume lists saved sessions, resumes a selected session, then sends the next turn there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-next-resume-'));
    try {
      const r = await runNextTuiScenario({ scenario: 'next-resume', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
      expect(r.checks).toEqual({
        listDisplaysSavedSession: true, selectedSessionBecomesActive: true, resumedHistoryRenders: true,
        oldSessionPreserved: true, newTurnUsesResumedSession: true, onlyFakeProvider: true, exitedClean: true,
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 150_000);

  test('next-tool-fold: a real Bash call is folded and Enter advances L1 summary → L2 steps → L3 referenced output → folded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-next-fold-'));
    try {
      const r = await runNextTuiScenario({ scenario: 'next-tool-fold', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
      expect(r.checks).toEqual({
        realToolResultStored: true, collapsedAfterTurn: true, summaryAtL1: true, stepsAtL2: true,
        expandedOnL3: true, foldedAgainOnEnter: true,
        sessionUnchanged: true, onlyFakeProvider: true, exitedClean: true,
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 150_000);

  test('next-tool-fold-read (TUI-NEXT-TOOL-RESULT-RENDER): a real Read stays folded without exposing its raw JSON envelope', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-next-fold-read-'));
    try {
      const r = await runNextTuiScenario({ scenario: 'next-tool-fold-read', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
      expect(r.checks).toEqual({
        realReadEnvelopeStored: true, collapsedAfterTurn: true, noRawEnvelope: true,
        onlyFakeProvider: true, exitedClean: true,
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 150_000);

  test('next-esc-confirm-long-shell: long Bash Esc asks default-N, N continues, y stops', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-next-esc-shell-'));
    try {
      const r = await runNextTuiScenario({ scenario: 'next-esc-confirm-long-shell', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
      expect(r.checks).toEqual({
        longShellShownWhileRunning: true, longEscShowsDefaultNInlinePanel: true, noKeepsTheSameShellRunning: true,
        declinedShellCompletesNormally: true, yesStopsTheSecondTurn: true, cancelledShellProcessExitedAtYConfirmation: true,
        onlyFakeProvider: true, exitedClean: true,
      });
      expect(r.run.frames.map((f) => f.label)).toEqual([
        'boot', 'long Bash running', 'long Bash Esc asks y/N', 'N keeps Bash running', 'N command completes',
        'second long Bash running', 'second long Bash Esc asks y/N', 'y stops Bash turn',
      ]);
      expect(r.run.frames[2]!.screen).toContain('y/n 입력 · 기본 N');
      expect(r.run.frames[3]!.screen).toContain('긴 셸 명령 계속 실행');
      expect(r.run.frames[6]!.screen).toContain('y/n 입력 · 기본 N');
      expect(r.run.frames[7]!.screen).toContain('응답 취소됨');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 150_000);

  // 재현(TUI-GOAL-INTERIM-QUIET · n8n 10-22 22:4x): every step ends «아직 못 했다» and the internal input was drawn
  // «나: [골 이어가기] …». Four real turns on a PTY — opt-in (ELANOUS_N03_SLOW=1) like the other long scenarios.
  test.skipIf(process.env.ELANOUS_N03_SLOW !== '1')('next-goal-interim: goal-continue to its cap folds each continued step and shows the «not done» paragraph once, no «나:» header', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-next-interim-'));
    try {
      const r = await runNextTuiScenario({ scenario: 'next-goal-interim', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
      expect(r.checks).toEqual({
        continuedSeveral: true, eachInterimOneLine: true, everyStepOnScreen: true, notDoneAtMostOnce: true, finalReportShown: true, foldedEachContinued: true,
        noUserHeaderForInternal: true, toolLineKept: true, internalTurnsStored: true, onlyFakeProvider: true, exitedClean: true,
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 240_000);
});

