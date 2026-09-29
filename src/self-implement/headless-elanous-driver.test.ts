import { lookupLlmTierSpec } from '../model-tier/index.js';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { harnessScreenPath } from '../harness/harness-screen.js';
import { controlInboxPath, drainControlInbox, enqueueControlMemo } from '../harness/control-inbox.js';
import { encodeDetachedProgressFrame } from '../harness/dispatch-detached.js';
import { readGrokTokenFreshness } from '../acp/grok-auth.js';
import {
  CHILD_LIVENESS_HEARTBEAT_FILE,
  DEFAULT_ACTIVITY_GRACE_SEC,
  DEFAULT_MAX_HARD_WAIT_SEC,
  FRAME_STALL_SAME_COMMAND_RULE_HINT_THRESHOLD,
  buildPtyDeltaProgressObservation,
  driveHeadlessElanous,
  formatFrameStallProgressLine,
  resolveChildLivenessHeartbeatPath,
  runHeadlessGoalLoopPty,
  watchHarnessBoundaryRequests,
  type BoundaryBehaviorAxisAnswers,
} from './headless-elanous-driver.js';
import { CHILD_LIVENESS_HEARTBEAT_ENV } from '../core-turn/child-liveness-heartbeat.js';
import { DEFAULT_STEP_TIMEOUTS } from './orchestrator.js';

const previousStateDir = process.env.ELANOUS_STATE_DIR;
const previousHarnessSpace = process.env.ELANOUS_HARNESS_SPACE;
const previousHarnessSpaceId = process.env.ELANOUS_HARNESS_SPACE_ID;
const stateDirs: string[] = [];

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = previousStateDir;
  if (previousHarnessSpace === undefined) delete process.env.ELANOUS_HARNESS_SPACE;
  else process.env.ELANOUS_HARNESS_SPACE = previousHarnessSpace;
  if (previousHarnessSpaceId === undefined) delete process.env.ELANOUS_HARNESS_SPACE_ID;
  else process.env.ELANOUS_HARNESS_SPACE_ID = previousHarnessSpaceId;
  for (const stateDir of stateDirs.splice(0)) rmSync(stateDir, { recursive: true, force: true });
});

function configureHeartbeatState(): { stateDir: string; cwd: string } {
  const stateDir = mkdtempSync(join(tmpdir(), 'headless-parent-pid-'));
  stateDirs.push(stateDir);
  process.env.ELANOUS_STATE_DIR = stateDir;
  process.env.ELANOUS_HARNESS_SPACE = 'self-implement';
  process.env.ELANOUS_HARNESS_SPACE_ID = 'parent-pid-worktree';
  return { stateDir, cwd: '/tmp/parent-pid-worktree' };
}

function heartbeatPath(stateDir: string): string {
  return `${harnessScreenPath('parent-pid-worktree', { ELANOUS_STATE_DIR: stateDir }).replace(/\.screen$/, '')}.hb`;
}

function alivePtyHandle(id = 'self_parent_pid') {
  return {
    id, write: () => {}, renderScreen: async () => 'working', renderScreenPng: async () => null,
    snapshot: () => 'working', drainDelta: () => '', isAlive: () => true, canWrite: () => true, exitCode: null, kill: () => {},
  };
}

function alivePty(id = 'self_parent_pid') {
  return (() => alivePtyHandle(id)) as never;
}

function alternatingStatePty(id = 'self_alternating_screen') {
  return (() => {
    let renderCount = 0;
    const screens = ['building... esc to interrupt', 'Do you want to proceed? (y/n)'];
    return {
      id,
      write: () => {},
      renderScreen: async () => screens[renderCount++ % screens.length]!,
      renderScreenPng: async () => null,
      snapshot: () => 'working',
      drainDelta: () => '',
      isAlive: () => true,
      canWrite: () => true,
      exitCode: null,
      kill: () => {},
    };
  }) as never;
}

function onePollPty(id = 'self_timeout_caps') {
  let aliveReads = 0;
  return (() => ({
    id, write: () => {}, renderScreen: async () => 'working', renderScreenPng: async () => null,
    snapshot: () => 'working', drainDelta: () => '', isAlive: () => aliveReads++ < 2, exitCode: 0, kill: () => {},
  })) as never;
}

async function captureChildEnv(options: Partial<Parameters<typeof runHeadlessGoalLoopPty>[0]> = {}): Promise<Record<string, string>> {
  let env: Record<string, string> | undefined;
  await runHeadlessGoalLoopPty({
    binRoot: '/tmp/repo', cwd: '/tmp/worktree', featurePrompt: 'x', maxWaitSec: 1, maxHardWaitSec: 1,
    pollMs: 1, activityGraceSec: 100, ptyAvailable: () => true,
    spawn: ((spawnOptions: { env: Record<string, string> }) => {
      env = spawnOptions.env;
      return alivePtyHandle() as never;
    }) as never,
    ...options,
  });
  return env!;
}

async function captureScreenKey(
  driver: 'tui' | 'goal-loop',
  cwd: string,
  inheritedSpaceId?: string,
): Promise<string> {
  const stateDir = mkdtempSync(join(tmpdir(), 'headless-screen-key-'));
  stateDirs.push(stateDir);
  process.env.ELANOUS_STATE_DIR = stateDir;
  if (inheritedSpaceId) {
    process.env.ELANOUS_HARNESS_SPACE = 'self-implement';
    process.env.ELANOUS_HARNESS_SPACE_ID = inheritedSpaceId;
  } else {
    delete process.env.ELANOUS_HARNESS_SPACE;
    delete process.env.ELANOUS_HARNESS_SPACE_ID;
  }
  const events: Array<Record<string, unknown>> = [];
  const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
    if (event === 'headless.spawn') events.push(data ?? {});
  }) as never);
  try {
    if (driver === 'tui') {
      await driveHeadlessElanous({
        repoRoot: '/tmp/repo', cwd, prompt: 'x', bootSec: 0, maxWaitSec: 1, ptyAvailable: () => true,
        spawn: (() => ({
          ...alivePtyHandle('self_screen_key_tui'), renderScreen: async () => 'GOAL-COMPLETE', snapshot: () => 'GOAL-COMPLETE',
        })) as never,
      });
    } else {
      await runHeadlessGoalLoopPty({
        binRoot: '/tmp/repo', cwd, featurePrompt: 'x', maxWaitSec: 1, maxHardWaitSec: 1,
        pollMs: 1, activityGraceSec: 100, ptyAvailable: () => true, spawn: alivePty('self_screen_key_goal_loop'),
      });
    }
    expect(events).toHaveLength(1);
    const screenKey = events[0]!.screenKey as string;
    expect(existsSync(harnessScreenPath(screenKey, { ELANOUS_STATE_DIR: stateDir }))).toBe(true);
    return screenKey;
  } finally {
    log.mockRestore();
  }
}

describe('headless control inbox handoff', () => {
  test.each(['tui', 'goal-loop'] as const)('preserves the inherited absolute inbox through a nested %s spawn and drains it once', async (driver) => {
    const parentStateDir = mkdtempSync(join(tmpdir(), 'headless-inbox-parent-'));
    const childStateDir = mkdtempSync(join(tmpdir(), 'headless-inbox-child-'));
    stateDirs.push(parentStateDir, childStateDir);
    const spaceId = 'nested-control-space';
    const inheritedInboxDir = controlInboxPath(spaceId, { ELANOUS_STATE_DIR: parentStateDir });
    const previousControlInboxDir = process.env.ELANOUS_CONTROL_INBOX_DIR;
    process.env.ELANOUS_STATE_DIR = childStateDir;
    process.env.ELANOUS_HARNESS_SPACE = 'self-implement';
    process.env.ELANOUS_HARNESS_SPACE_ID = spaceId;
    process.env.ELANOUS_CONTROL_INBOX_DIR = inheritedInboxDir;
    let childEnv: Record<string, string> | undefined;
    try {
      if (driver === 'tui') {
        await driveHeadlessElanous({
          repoRoot: '/tmp/repo', cwd: '/tmp/nested-child', prompt: 'x', bootSec: 0, maxWaitSec: 1, ptyAvailable: () => true,
          spawn: ((spawnOptions: { env: Record<string, string> }) => {
            childEnv = spawnOptions.env;
            return { ...alivePtyHandle('self_nested_tui'), renderScreen: async () => 'GOAL-COMPLETE', snapshot: () => 'GOAL-COMPLETE' } as never;
          }) as never,
        });
      } else {
        childEnv = await captureChildEnv({ cwd: '/tmp/nested-child' });
      }
      expect(childEnv!.ELANOUS_CONTROL_INBOX_DIR).toBe(inheritedInboxDir);
      enqueueControlMemo(spaceId, 'nested handoff memo', { env: { ELANOUS_STATE_DIR: parentStateDir }, explicitInboxDir: inheritedInboxDir });
      expect(drainControlInbox(spaceId, { env: { ELANOUS_STATE_DIR: childStateDir, ELANOUS_CONTROL_INBOX_DIR: childEnv!.ELANOUS_CONTROL_INBOX_DIR } })).toEqual({
        stop: false, count: 1, memos: ['nested handoff memo'],
        memoEntries: [{ body: 'nested handoff memo' }], receivedCount: 1, structuredCount: 0,
        structuredMemos: [], urgentCount: 0, malformedFallbackCount: 0,
      });
      expect(drainControlInbox(spaceId, { env: { ELANOUS_STATE_DIR: childStateDir, ELANOUS_CONTROL_INBOX_DIR: childEnv!.ELANOUS_CONTROL_INBOX_DIR } })).toEqual({
        stop: false, count: 0, memos: [],
        memoEntries: [], receivedCount: 0, structuredCount: 0, structuredMemos: [], urgentCount: 0, malformedFallbackCount: 0,
      });
    } finally {
      if (previousControlInboxDir === undefined) delete process.env.ELANOUS_CONTROL_INBOX_DIR;
      else process.env.ELANOUS_CONTROL_INBOX_DIR = previousControlInboxDir;
    }
  });
});

describe('headless child screen keys', () => {
  test.each([
    ['prefers a known inherited space even when it differs from the worktree', '/tmp/child-worktree', 'parent-worktree', 'parent-worktree'],
    ['keeps the child worktree without an inherited space', '/tmp/cli-worktree', undefined, 'cli-worktree'],
    ['keeps the worktree key when the inherited space matches it', '/tmp/shared-worktree', 'shared-worktree', 'shared-worktree'],
  ])('%s in both driver paths', async (_caseName, cwd, inheritedSpaceId, expectedScreenKey) => {
    await expect(captureScreenKey('tui', cwd, inheritedSpaceId)).resolves.toBe(expectedScreenKey);
    await expect(captureScreenKey('goal-loop', cwd, inheritedSpaceId)).resolves.toBe(expectedScreenKey);
  });
});

describe('headless supervisor delivery observation', () => {
  test('records the delivered supervisor input on the existing verdict event without changing surface progress', async () => {
    const verdicts: Record<string, unknown>[] = [];
    const surfaceLines: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'run-supervision.verdict') verdicts.push(data ?? {});
    }) as never);
    try {
      await runHeadlessGoalLoopPty({
        binRoot: '/tmp/repo', cwd: '/tmp/worktree', featurePrompt: 'x', maxWaitSec: 2, pollMs: 1,
        activityGraceSec: 0, nowMs: (() => { const values = [2_000, 302_001, 302_002]; let i = 0; return () => values[Math.min(i++, values.length - 1)]!; })(),
        ptyAvailable: () => true, spawn: alivePty('supervisor_delivery'),
        autoAssist: { enabled: true, minRung: 2 },
        brain: { decide: () => ({ action: 'input', text: 'continue implementation' }) },
        onSupervisorInput: (_text, updateDelivery) => updateDelivery('delivered'),
        onSurfaceProgress: (line) => surfaceLines.push(line),
      });

      expect(verdicts).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: 'input', actionDetail: 'continue implementation', supervisionRecordStage: 'verdict-input' }),
        expect.objectContaining({ action: 'input', actionDetail: 'continue implementation', supervisionRecordStage: 'delivery-outcome', delivery: 'delivered' }),
      ]));
      const normalVerdictSteps = verdicts
        .filter(({ supervisionRecordStage }) => supervisionRecordStage === 'verdict-input' || supervisionRecordStage === 'verdict-no-input')
        .map(({ step }) => step);
      const deliveryOutcomeSteps = verdicts
        .filter(({ supervisionRecordStage }) => supervisionRecordStage === 'delivery-outcome')
        .map(({ step }) => step);
      expect(normalVerdictSteps).toEqual([...new Set(normalVerdictSteps)]);
      expect(deliveryOutcomeSteps).toEqual(normalVerdictSteps);
      expect(surfaceLines).toContain('[supervision] action=input reason=continue implementation delivery=queued\n');
      expect(surfaceLines).toContain('[supervision] action=input reason=continue implementation delivery=delivered\n');
    } finally {
      log.mockRestore();
    }
  });

  test('annotates repeated input instruction occurrence on surface progress without changing verdict logs or delivery text', async () => {
    const verdicts: Record<string, unknown>[] = [];
    const surfaceLines: string[] = [];
    const deliveredInputs: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'run-supervision.verdict') verdicts.push(data ?? {});
    }) as never);
    try {
      await runHeadlessGoalLoopPty({
        binRoot: '/tmp/repo', cwd: '/tmp/worktree', featurePrompt: 'x', maxWaitSec: 3, maxHardWaitSec: 3, pollMs: 1,
        activityGraceSec: 100, nowMs: (() => { let i = 0; return () => 2_000 + (i++ * 1_000); })(),
        ptyAvailable: () => true, spawn: alternatingStatePty('supervisor_repeated_input_occurrence'),
        autoAssist: { enabled: true, minRung: 2 },
        brain: { decide: () => ({ action: 'input', text: 'continue implementation' }) },
        onSupervisorInput: (text, updateDelivery) => { deliveredInputs.push(text); updateDelivery('delivered'); },
        onSurfaceProgress: (line) => surfaceLines.push(line),
      });

      const initialVerdicts = verdicts.filter(({ supervisionRecordStage }) => supervisionRecordStage === 'verdict-input');
      const deliveryVerdicts = verdicts.filter(({ supervisionRecordStage }) => supervisionRecordStage === 'delivery-outcome');
      expect(initialVerdicts).toHaveLength(2);
      expect(deliveryVerdicts).toHaveLength(2);
      expect(deliveredInputs).toEqual([
        'continue implementation',
        'continue implementation',
      ]);
      expect(initialVerdicts.map(({ action }) => action)).toEqual(['input', 'input']);
      expect(deliveryVerdicts.map(({ action, delivery }) => ({ action, delivery }))).toEqual([
        { action: 'input', delivery: 'delivered' },
        { action: 'input', delivery: 'delivered' },
      ]);
      expect(surfaceLines.filter((line) => line.startsWith('[supervision] action=input'))).toEqual([
        '[supervision] action=input reason=continue implementation delivery=queued\n',
        '[supervision] action=input reason=continue implementation delivery=delivered\n',
        '[supervision] action=input reason=continue implementation delivery=queued inputInstructionOccurrence=2\n',
        '[supervision] action=input reason=continue implementation delivery=delivered inputInstructionOccurrence=2\n',
      ]);
      expect(verdicts.every((verdict) => !('inputInstructionOccurrence' in verdict))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  test('adds identical federation observation to initial and delivery verdicts only when supplied', async () => {
    const verdicts: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'run-supervision.verdict') verdicts.push(data ?? {});
    }) as never);
    try {
      await runHeadlessGoalLoopPty({
        binRoot: '/tmp/repo', cwd: '/tmp/worktree', featurePrompt: 'x', maxWaitSec: 2, pollMs: 1,
        activityGraceSec: 0, nowMs: (() => { const values = [2_000, 302_001, 302_002]; let i = 0; return () => values[Math.min(i++, values.length - 1)]!; })(),
        ptyAvailable: () => true, spawn: alivePty('supervisor_federated_delivery'),
        autoAssist: { enabled: true, minRung: 2 },
        brain: { decide: () => ({ action: 'input', text: 'continue implementation' }) },
        onSupervisorInput: (_text, updateDelivery) => updateDelivery('delivered'),
        shardIdentity: { orchestrationId: 'orch-6', shardId: 'shard-4', pieceIndex: 4, pieceTotal: 6 },
      });

      expect(verdicts.length).toBeGreaterThanOrEqual(2);
      const federationKeys = ['orchestrationId', 'shardId', 'shardPosition', 'pieceTotal'] as const;
      for (const verdict of verdicts) {
        expect(verdict).toEqual(expect.objectContaining({
          action: 'input', actionDetail: 'continue implementation', orchestrationId: 'orch-6',
          shardId: 'shard-4', shardPosition: 4, pieceTotal: 6,
        }));
      }
      for (const initial of verdicts.filter(({ supervisionRecordStage }) => supervisionRecordStage === 'verdict-input')) {
        const delivery = verdicts.find(({ supervisionRecordStage, step }) => supervisionRecordStage === 'delivery-outcome' && step === initial.step);
        expect(delivery).toBeDefined();
        for (const key of federationKeys) expect(delivery![key]).toBe(initial[key]);
      }
    } finally {
      log.mockRestore();
    }
  });

  test('omits every federation field when identity is absent or non-federated', async () => {
    const captureVerdicts = async (shardIdentity?: { pieceTotal: number }) => {
      const verdicts: Record<string, unknown>[] = [];
      const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
        if (event === 'run-supervision.verdict') verdicts.push(data ?? {});
      }) as never);
      try {
        await runHeadlessGoalLoopPty({
          binRoot: '/tmp/repo', cwd: '/tmp/worktree', featurePrompt: 'x', maxWaitSec: 2, pollMs: 1,
          activityGraceSec: 0, nowMs: (() => { const values = [2_000, 302_001, 302_002]; let i = 0; return () => values[Math.min(i++, values.length - 1)]!; })(),
          ptyAvailable: () => true, spawn: alivePty(`supervisor_non_federated_${shardIdentity?.pieceTotal ?? 'absent'}`),
          autoAssist: { enabled: true, minRung: 2 },
          brain: { decide: () => ({ action: 'input', text: 'continue implementation' }) },
          onSupervisorInput: (_text, updateDelivery) => updateDelivery('delivered'),
          ...(shardIdentity ? { shardIdentity } : {}),
        });
        return verdicts;
      } finally {
        log.mockRestore();
      }
    };

    for (const verdicts of [await captureVerdicts(), await captureVerdicts({ pieceTotal: 1 })]) {
      expect(verdicts.length).toBeGreaterThanOrEqual(2);
      for (const verdict of verdicts) {
        expect(verdict).toEqual(expect.objectContaining({ action: 'input', actionDetail: 'continue implementation' }));
        for (const key of ['orchestrationId', 'shardId', 'shardPosition', 'pieceTotal', 'siblingShardIds', 'siblingShardCount']) {
          expect(key in verdict).toBe(false);
        }
      }
    }
  });

  test('records a no-input verdict separately from an input verdict initial record', async () => {
    const verdicts: Record<string, unknown>[] = [];
    const surfaceLines: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'run-supervision.verdict') verdicts.push(data ?? {});
    }) as never);
    try {
      await runHeadlessGoalLoopPty({
        binRoot: '/tmp/repo', cwd: '/tmp/worktree', featurePrompt: 'x', maxWaitSec: 2, pollMs: 1,
        activityGraceSec: 0, nowMs: (() => { const values = [2_000, 302_001, 302_002]; let i = 0; return () => values[Math.min(i++, values.length - 1)]!; })(),
        ptyAvailable: () => true, spawn: alivePty('supervisor_no_input'),
        autoAssist: { enabled: true, minRung: 2 },
        brain: { decide: () => ({ action: 'wait' }) },
        onSurfaceProgress: (line) => surfaceLines.push(line),
      });

      expect(verdicts).toContainEqual(expect.objectContaining({ action: 'wait', supervisionRecordStage: 'verdict-no-input' }));
      expect(verdicts).not.toContainEqual(expect.objectContaining({ supervisionRecordStage: 'delivery-outcome' }));
      expect(surfaceLines).toEqual(expect.arrayContaining([
        '[supervision] action=wait reason=waitCount=2 latestJudgment=wait\n',
      ]));
    } finally {
      log.mockRestore();
    }
  });

  test('batches repeated wait verdicts into fewer supervision surface lines without changing verdict logs', async () => {
    const verdicts: Record<string, unknown>[] = [];
    const surfaceLines: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'run-supervision.verdict') verdicts.push(data ?? {});
    }) as never);
    try {
      await runHeadlessGoalLoopPty({
        binRoot: '/tmp/repo', cwd: '/tmp/worktree', featurePrompt: 'x', maxWaitSec: 12, maxHardWaitSec: 12, pollMs: 1,
        activityGraceSec: 100, nowMs: (() => { let i = 0; return () => 2_000 + (i++ * 2_000); })(),
        ptyAvailable: () => true, spawn: alternatingStatePty('supervisor_wait_batch'),
        autoAssist: { enabled: true, minRung: 2 },
        brain: { decide: () => ({ action: 'wait' }) },
        onSurfaceProgress: (line) => surfaceLines.push(line),
      });

      const waitVerdicts = verdicts.filter(({ action, supervisionRecordStage }) => action === 'wait' && supervisionRecordStage === 'verdict-no-input');
      const waitSurfaceLines = surfaceLines.filter((line) => line.startsWith('[supervision] action=wait'));
      expect(waitVerdicts).toHaveLength(12);
      expect(waitSurfaceLines.length).toBeGreaterThan(0);
      expect(waitSurfaceLines.length).toBeLessThan(waitVerdicts.length / 2);
      expect(waitSurfaceLines).toEqual([
        '[supervision] action=wait reason=waitCount=5 latestJudgment=wait\n',
        '[supervision] action=wait reason=waitCount=5 latestJudgment=wait\n',
        '[supervision] action=wait reason=waitCount=2 latestJudgment=wait\n',
      ]);
      expect(verdicts).not.toContainEqual(expect.objectContaining({ supervisionRecordStage: 'delivery-outcome' }));
    } finally {
      log.mockRestore();
    }
  });

  test('continues delivery and surface progress when the delivery verdict log fails', async () => {
    const surfaceLines: string[] = [];
    let verdictCalls = 0;
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string) => {
      if (event === 'run-supervision.verdict' && ++verdictCalls === 2) throw new Error('log unavailable');
    }) as never);
    try {
      await runHeadlessGoalLoopPty({
        binRoot: '/tmp/repo', cwd: '/tmp/worktree', featurePrompt: 'x', maxWaitSec: 2, pollMs: 1,
        activityGraceSec: 0, nowMs: (() => { const values = [2_000, 302_001, 302_002]; let i = 0; return () => values[Math.min(i++, values.length - 1)]!; })(),
        ptyAvailable: () => true, spawn: alivePty('supervisor_delivery_fail_soft'),
        autoAssist: { enabled: true, minRung: 2 },
        brain: { decide: () => ({ action: 'input', text: 'continue implementation' }) },
        onSupervisorInput: (_text, updateDelivery) => updateDelivery('delivered'),
        onSurfaceProgress: (line) => surfaceLines.push(line),
      });

      expect(surfaceLines).toContain('[supervision] action=input reason=continue implementation delivery=delivered\n');
    } finally {
      log.mockRestore();
    }
  });
});

describe('headless goal-loop document reference forwarding', () => {
  test('forwards a non-empty document reference list to the spawned child environment', async () => {
    const documentReferences = [{ path: 'docs/reference.md', result: { kind: 'ok' as const, contents: 'reference' } }];
    const env = await captureChildEnv({ documentReferences });

    expect(env.ELANOUS_DOCUMENT_REFERENCES).toBe(JSON.stringify(documentReferences));
  });

  test('omits the document reference environment entry when the list is absent or empty', async () => {
    const absent = await captureChildEnv();
    const empty = await captureChildEnv({ documentReferences: [] });

    expect(absent.ELANOUS_DOCUMENT_REFERENCES).toBeUndefined();
    expect(empty.ELANOUS_DOCUMENT_REFERENCES).toBeUndefined();
  });
});

describe('headless goal-loop Grok credential preflight', () => {
  const tokenValue = 'credential-value-must-not-appear';

  function writeGrokAuth(expiresAt: string): string {
    const home = mkdtempSync(join(tmpdir(), 'headless-grok-auth-'));
    stateDirs.push(home);
    const path = join(home, 'auth.json');
    writeFileSync(path, JSON.stringify({
      expired: { expires_at: '2020-01-01T00:00:00.000Z', key: tokenValue },
      selected: { expires_at: expiresAt, refresh_token: tokenValue },
    }));
    return path;
  }

  async function runGrokPreflight(readGrokTokenFreshness: Parameters<typeof runHeadlessGoalLoopPty>[0]['readGrokTokenFreshness']) {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const sequence: string[] = [];
    const surfaceLines: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      events.push({ event, data: data ?? {} });
      if (event === 'headless.grok-credential-preflight') sequence.push('preflight');
      if (event === 'headless.spawn') sequence.push('spawn-log');
    }) as never);
    try {
      await runHeadlessGoalLoopPty({
        binRoot: '/tmp/repo', cwd: '/tmp/worktree', featurePrompt: 'x', maxWaitSec: 1, maxHardWaitSec: 1,
        pollMs: 1, activityGraceSec: 100, ptyAvailable: () => true,
        childLlm: { provider: 'grok', model: 'grok-4', source: 'flag' }, readGrokTokenFreshness,
        onSurfaceProgress: (line) => surfaceLines.push(line),
        spawn: (() => { sequence.push('spawn'); return alivePtyHandle() as never; }) as never,
      });
      return { events, sequence, surfaceLines };
    } finally {
      log.mockRestore();
    }
  }

  test('records an expired refreshable nested-account snapshot before spawning without exposing credential values', async () => {
    const path = writeGrokAuth('2020-01-02T00:00:00.000Z');
    const { events, sequence, surfaceLines } = await runGrokPreflight(() => readGrokTokenFreshness({ path, nowMs: Date.parse('2021-01-01T00:00:00.000Z') }));
    const preflight = events.find(({ event }) => event === 'headless.grok-credential-preflight')!.data;
    const spawn = events.find(({ event }) => event === 'headless.spawn')!.data;

    expect(sequence.indexOf('preflight')).toBeLessThan(sequence.indexOf('spawn'));
    expect(preflight).toEqual(expect.objectContaining({ status: 'expired-refreshable', expiresAt: '2020-01-02T00:00:00.000Z', action: expect.stringContaining('갱신') }));
    expect(spawn).toEqual(expect.objectContaining({ grokCredentialFreshness: expect.objectContaining({ status: 'expired-refreshable' }) }));
    expect(surfaceLines).toContainEqual(expect.stringContaining('[grok-credential-preflight] status=expired-refreshable'));
    expect(JSON.stringify({ events, surfaceLines })).not.toContain(tokenValue);
  });

  test.each([
    ['fresh', () => ({ present: true, fresh: true as const, expiresAt: '2030-01-01T00:00:00.000Z' })],
    ['unknown', () => ({ present: false, fresh: null, expiresAt: null })],
  ])('keeps %s distinct and still spawns the child', async (status, reader) => {
    let spawns = 0;
    const events: Array<Record<string, unknown>> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'headless.grok-credential-preflight') events.push(data ?? {});
    }) as never);
    try {
      await runHeadlessGoalLoopPty({
        binRoot: '/tmp/repo', cwd: '/tmp/worktree', featurePrompt: 'x', maxWaitSec: 1, maxHardWaitSec: 1,
        pollMs: 1, activityGraceSec: 100, ptyAvailable: () => true,
        childLlm: { provider: 'grok', model: 'grok-4', source: 'flag' }, readGrokTokenFreshness: reader,
        spawn: (() => { spawns += 1; return alivePtyHandle() as never; }) as never,
      });
      expect(spawns).toBe(1);
      expect(events).toContainEqual(expect.objectContaining({ status }));
    } finally {
      log.mockRestore();
    }
  });

  test('records lookup-failed without blocking spawn and does not preflight non-Grok children', async () => {
    let spawns = 0;
    let reads = 0;
    const events: Array<Record<string, unknown>> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'headless.grok-credential-preflight') events.push(data ?? {});
    }) as never);
    try {
      await runHeadlessGoalLoopPty({
        binRoot: '/tmp/repo', cwd: '/tmp/worktree', featurePrompt: 'x', maxWaitSec: 1, maxHardWaitSec: 1,
        pollMs: 1, activityGraceSec: 100, ptyAvailable: () => true,
        childLlm: { provider: 'grok', model: 'grok-4', source: 'flag' }, readGrokTokenFreshness: () => { reads += 1; throw new Error('unreadable'); },
        spawn: (() => { spawns += 1; return alivePtyHandle() as never; }) as never,
      });
      expect(spawns).toBe(1);
      expect(reads).toBe(1);
      expect(events).toContainEqual(expect.objectContaining({ status: 'lookup-failed' }));

      await captureChildEnv({ childLlm: { provider: 'anthropic', model: 'claude-opus-4-8', source: 'flag' }, readGrokTokenFreshness: () => { throw new Error('must not read'); } });
    } finally {
      log.mockRestore();
    }
  });
});

describe('headless goal-loop child LLM selection', () => {
  const parentProvider = process.env.ELANOUS_LLM_PROVIDER;
  const parentModel = process.env.ELANOUS_LLM_MODEL;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const solModel = process.env.ELANOUS_SELFDEV_SOL_MODEL;
  const solProvider = process.env.ELANOUS_SELFDEV_SOL_PROVIDER;
  const solEffort = process.env.ELANOUS_SELFDEV_SOL_EFFORT;

  afterEach(() => {
    if (parentProvider === undefined) delete process.env.ELANOUS_LLM_PROVIDER; else process.env.ELANOUS_LLM_PROVIDER = parentProvider;
    if (parentModel === undefined) delete process.env.ELANOUS_LLM_MODEL; else process.env.ELANOUS_LLM_MODEL = parentModel;
    if (anthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = anthropicKey;
    if (solModel === undefined) delete process.env.ELANOUS_SELFDEV_SOL_MODEL; else process.env.ELANOUS_SELFDEV_SOL_MODEL = solModel;
    if (solProvider === undefined) delete process.env.ELANOUS_SELFDEV_SOL_PROVIDER; else process.env.ELANOUS_SELFDEV_SOL_PROVIDER = solProvider;
    if (solEffort === undefined) delete process.env.ELANOUS_SELFDEV_SOL_EFFORT; else process.env.ELANOUS_SELFDEV_SOL_EFFORT = solEffort;
  });

  test('미지정이면 기존 부모 선택 상속과 승격 env를 그대로 유지한다', async () => {
    process.env.ELANOUS_LLM_PROVIDER = 'parent';
    process.env.ELANOUS_LLM_MODEL = 'parent-model';
    const env = await captureChildEnv();
    expect(env.ELANOUS_LLM_PROVIDER).toBe('parent');
    expect(env.ELANOUS_LLM_MODEL).toBe('parent-model');
    expect(env.ELANOUS_ESCALATE_PROVIDER).toBeUndefined();
  });

  test('명시 childLlm은 자식 spawn에만 적용하고 선택 provider 키를 릴레이한다', async () => {
    process.env.ELANOUS_LLM_PROVIDER = 'parent';
    process.env.ELANOUS_LLM_MODEL = 'parent-model';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-parent';
    const env = await captureChildEnv({ childLlm: { provider: 'anthropic', model: 'claude-opus-4-8', source: 'flag' } });
    expect(env).toEqual(expect.objectContaining({
      ELANOUS_LLM_PROVIDER: 'anthropic', ELANOUS_LLM_MODEL: 'claude-opus-4-8', ANTHROPIC_API_KEY: 'sk-ant-parent',
    }));
    expect(process.env.ELANOUS_LLM_PROVIDER).toBe('parent');
    expect(process.env.ELANOUS_LLM_MODEL).toBe('parent-model');
  });

  test('결정 2026-09-23 — childLlm=openrouter 는 자식에 provider·모델이 그대로 실리고 키를 릴레이한다', async () => {
    process.env.ELANOUS_LLM_PROVIDER = 'parent';
    process.env.ELANOUS_LLM_MODEL = 'parent-model';
    process.env.OPENROUTER_API_KEY = 'sk-or-parent';
    try {
      const env = await captureChildEnv({ childLlm: { provider: 'openrouter', model: 'openrouter/moonshotai/kimi-k3', source: 'flag' } });
      expect(env.ELANOUS_LLM_PROVIDER).toBe('openrouter');
      expect(env.ELANOUS_LLM_MODEL).toBe('openrouter/moonshotai/kimi-k3');
      expect(env.OPENROUTER_API_KEY).toBe('sk-or-parent');
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  test.each(['flag', 'config'] as const)('명시 childLlm source=%s 는 spawn 관측에 보존된다', async (source) => {
    const events: Array<Record<string, unknown>> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'headless.spawn') events.push(data ?? {});
    }) as never);
    try {
      await captureChildEnv({ childLlm: { provider: 'grok', model: 'grok-4.6', source } });
      expect(events).toHaveLength(1);
      expect(events[0]!.childLlm).toEqual({ provider: 'grok', model: 'grok-4.6', source });
    } finally {
      log.mockRestore();
    }
  });

  test('명시 childLlm은 tier 없음이면 선택을 유지하고 승격 env를 받지 않는다', async () => {
    const env = await captureChildEnv({ childLlm: { provider: 'anthropic', model: 'claude-opus-4-8', source: 'flag' }, escalateTier: 'none' });
    expect(env.ELANOUS_LLM_PROVIDER).toBe('anthropic');
    expect(env.ELANOUS_LLM_MODEL).toBe('claude-opus-4-8');
    expect(env.ELANOUS_ESCALATE_PROVIDER).toBeUndefined();
    expect(env.ELANOUS_ESCALATE_MODEL).toBeUndefined();
    expect(env.ELANOUS_ESCALATE_EFFORT).toBeUndefined();
  });

  test('대표 09-25 B9 — 명시 anthropic 자식은 승급하지 않는다(codex·anthropic 은 이미 최상위급)', async () => {
    const childLlm = { provider: 'anthropic', model: 'claude-opus-4-8', source: 'flag' as const };
    const sol = await captureChildEnv({ childLlm, escalateTier: 'sol' });
    const opus = await captureChildEnv({ childLlm, escalateTier: 'opus' });
    for (const env of [sol, opus]) {
      expect(env.ELANOUS_LLM_MODEL).toBe('claude-opus-4-8');
      expect(env.ELANOUS_ESCALATE_PROVIDER).toBeUndefined();
      expect(env.ELANOUS_ESCALATE_MODEL).toBeUndefined();
    }
  });

  test('대표 09-25 B9 — codex 부모도 승급하지 않는다', async () => {
    process.env.ELANOUS_LLM_PROVIDER = 'openai-codex';
    process.env.ELANOUS_LLM_MODEL = 'gpt-6-sol';
    const env = await captureChildEnv({ escalateTier: 'sol' });
    expect(env.ELANOUS_ESCALATE_PROVIDER).toBeUndefined();
    expect(env.ELANOUS_ESCALATE_MODEL).toBeUndefined();
  });

  test('대표 09-25 B14 — 모델 미지정이면 자식은 역할 implement(better)로 — anthropic 은 Opus 5.5', async () => {
    process.env.ELANOUS_LLM_PROVIDER = 'anthropic';
    delete process.env.ELANOUS_LLM_MODEL;
    const env = await captureChildEnv();
    expect(env.ELANOUS_LLM_PROVIDER).toBe('anthropic');
    expect(env.ELANOUS_LLM_MODEL).toBe(lookupLlmTierSpec('anthropic', 'better').model);
    expect(lookupLlmTierSpec('anthropic', 'better').model).toBe('claude-opus-5-5');
  });

  test('결정 명시 OpenRouter 자식 — glm 은 같은 사다리 한 칸 위로(노력은 안 싣는다) · 꼭대기(kimi)는 승급 안 함', async () => {
    const glm = await captureChildEnv({ childLlm: { provider: 'openrouter', model: lookupLlmTierSpec('openrouter', 'balanced').model, source: 'flag' }, escalateTier: 'sol' });
    expect(glm.ELANOUS_ESCALATE_PROVIDER).toBe('openrouter');
    expect(glm.ELANOUS_ESCALATE_MODEL).toBe(lookupLlmTierSpec('openrouter', 'better').model);
    expect(glm.ELANOUS_ESCALATE_EFFORT).toBeUndefined();
    const kimi = await captureChildEnv({ childLlm: { provider: 'openrouter', model: lookupLlmTierSpec('openrouter', 'loaded').model, source: 'flag' }, escalateTier: 'sol' });
    expect(kimi.ELANOUS_ESCALATE_PROVIDER).toBeUndefined();
    expect(kimi.ELANOUS_ESCALATE_MODEL).toBeUndefined();
  });

  test('명시 childLlm 승격도 운영자의 SOL 환경 변수 덮어쓰기를 따른다', async () => {
    process.env.ELANOUS_SELFDEV_SOL_MODEL = 'configured-terra';
    process.env.ELANOUS_SELFDEV_SOL_PROVIDER = 'configured-codex';
    process.env.ELANOUS_SELFDEV_SOL_EFFORT = 'medium';
    // ⭐ 09-25 B9 뒤: 승급이 살아 있는 provider(grok)로 «덮어쓰기» 경로를 문다(anthropic 은 이제 승급 없음).
    const env = await captureChildEnv({ childLlm: { provider: 'grok', model: 'grok-4.7', source: 'flag' }, escalateTier: 'opus' });
    expect(env).toEqual(expect.objectContaining({
      ELANOUS_ESCALATE_MODEL: 'configured-terra', ELANOUS_ESCALATE_PROVIDER: 'configured-codex', ELANOUS_ESCALATE_EFFORT: 'medium',
    }));
  });

  test('미지정 childLlm의 기존 tier별 승격과 provider 키 릴레이는 보존된다 — codex·anthropic «밖»(grok 부모)', async () => {
    process.env.ELANOUS_LLM_PROVIDER = 'grok';
    process.env.ELANOUS_LLM_MODEL = 'grok-4.7';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-parent';
    const sol = await captureChildEnv({ escalateTier: 'sol' });
    const opus = await captureChildEnv({ escalateTier: 'opus' });
    expect(sol).toEqual(expect.objectContaining({ ELANOUS_ESCALATE_MODEL: lookupLlmTierSpec('openai-codex', 'best').model, ELANOUS_ESCALATE_PROVIDER: 'openai-codex', ELANOUS_ESCALATE_EFFORT: 'high' }));
    expect(opus).toEqual(expect.objectContaining({ ELANOUS_ESCALATE_MODEL: lookupLlmTierSpec('anthropic', 'loaded').model, ELANOUS_ESCALATE_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-parent' }));
  });

  test.each([
    [{ provider: '', model: 'model', source: 'flag' as const }],
    [{ provider: 'provider', model: '', source: 'flag' as const }],
    [{ provider: '  ', model: 'model', source: 'flag' as const }],
    [{ provider: 'provider', model: '  ', source: 'flag' as const }],
  ])('부분 또는 빈 childLlm은 spawn 전에 거부한다', async (childLlm) => {
    await expect(captureChildEnv({ childLlm })).rejects.toThrow('childLlm.provider and childLlm.model must both be non-empty');
  });
});

async function runParentPidPoll(cwd: string, readParentPid: () => number, maxHardWaitSec = 1) {
  return runHeadlessGoalLoopPty({
    binRoot: '/tmp/repo', cwd, featurePrompt: 'x', maxWaitSec: maxHardWaitSec, maxHardWaitSec,
    pollMs: 1, activityGraceSec: 100, ptyAvailable: () => true, spawn: alivePty(), readParentPid,
  });
}

describe('frame-stall command and progress context', () => {
  test('preserves the latest command-start token across non-command records and observes it on frame stalls', async () => {
    const stalls: Array<Record<string, unknown>> = [];
    const lines: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'frame-stall') stalls.push(data ?? {});
    }) as never);
    const { stateDir } = configureHeartbeatState();
    expect(process.env.ELANOUS_STATE_DIR).toBe(stateDir);
    let now = 0;
    let aliveChecks = 0;
    try {
      await runHeadlessGoalLoopPty({
        binRoot: '/tmp/repo', cwd: '/tmp/worktree', featurePrompt: 'x', runId: 'frame-stall-command-context',
        maxWaitSec: 30, maxHardWaitSec: 30, pollMs: 1, nowMs: () => (now += 15_000), onSurfaceProgress: (line) => lines.push(line),
        ptyAvailable: () => true,
        spawn: ((options: { env: Record<string, string> }) => {
          writeFileSync(options.env.ELANOUS_HARNESS_BOUNDARY_REQUESTS!, [
            JSON.stringify({ requestType: 'command-start', commandFirstToken: 'bun' }),
            JSON.stringify({ requestId: 'approval', boundary: '/tmp/worktree', cwd: '/tmp/worktree', targetKnown: false }),
            JSON.stringify({ requestType: 'command-start', commandFirstToken: 'tsc' }),
          ].join('\n').concat('\n'));
          return {
            id: 'frame-stall-command-context', write: () => {}, renderScreen: async () => 'working', renderScreenPng: async () => null,
            snapshot: () => '⏺ Read({})', drainDelta: () => '', isAlive: () => aliveChecks++ < 20, exitCode: 0, kill: () => {},
          };
        }) as never,
      });
      expect(lines).toContain('[frame-stall] previousRung=unknown currentRung=0 command=tsc toolCalls=1 chars=10\n');
      expect(stalls).toContainEqual(expect.objectContaining({
        rung: 0, previousRung: null, toolCalls: 1, chars: 10, lastCommandFirstToken: 'tsc', sameCommandStreak: 1,
      }));
      expect(stalls).toContainEqual(expect.objectContaining({ rung: 1, previousRung: 0 }));
      expect(stalls.every((stall) => Object.hasOwn(stall, 'previousRung'))).toBe(true);
      expect(stalls.filter((stall) => Object.hasOwn(stall, 'lastCommandFirstToken'))
        .every((stall) => typeof stall.sameCommandStreak === 'number')).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  test('keeps the legacy stall line byte-identical without optional values and reports deltas with them', () => {
    expect(formatFrameStallProgressLine({ previousRung: 1, currentRung: 2 }))
      .toBe('[frame-stall] previousRung=1 currentRung=2\n');
    expect(formatFrameStallProgressLine({
      previousRung: 0, currentRung: 1, lastCommandFirstToken: 'bun', toolCalls: 5, chars: 120, previousToolCalls: 3, previousChars: 100,
    })).toBe('[frame-stall] previousRung=0 currentRung=1 command=bun toolCalls=5 delta=2 chars=120 delta=20\n');
  });
});

describe('frame-stall same-command R-RUN11 pointer', () => {
  const N = FRAME_STALL_SAME_COMMAND_RULE_HINT_THRESHOLD;

  function writeCommandStart(path: string, token: string): void {
    appendFileSync(path, `${JSON.stringify({ requestType: 'command-start', commandFirstToken: token })}\n`);
  }

  async function collectSameCommandFrameStalls(opts: {
    runId: string;
    stallLimit: number;
    afterStall?: (stallCount: number, requestsPath: string) => void;
    screenFor?: (stallCount: number) => string;
    omitCommandStart?: boolean;
  }): Promise<{ stalls: Array<Record<string, unknown>>; levels: Array<string | undefined> }> {
    const stalls: Array<Record<string, unknown>> = [];
    const levels: Array<string | undefined> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>, extra?: { level?: string }) => {
      if (event === 'frame-stall') {
        stalls.push(data ?? {});
        levels.push(extra?.level);
      }
    }) as never);
    configureHeartbeatState();
    let now = 0;
    try {
      await runHeadlessGoalLoopPty({
        binRoot: '/tmp/repo', cwd: '/tmp/worktree', featurePrompt: 'x', runId: opts.runId,
        maxWaitSec: 40, maxHardWaitSec: 40, pollMs: 1, activityGraceSec: 1000,
        nowMs: () => (now += 15_000),
        ptyAvailable: () => true,
        boundaryRequestsWatchOptions: { pollMs: 1 },
        spawn: ((options: { env: Record<string, string> }) => {
          const requestsPath = options.env.ELANOUS_HARNESS_BOUNDARY_REQUESTS!;
          writeFileSync(requestsPath, opts.omitCommandStart
            ? ''
            : `${JSON.stringify({ requestType: 'command-start', commandFirstToken: 'git' })}\n`);
          return {
            id: opts.runId, write: () => {},
            renderScreen: async () => {
              const screen = opts.screenFor?.(stalls.length) ?? 'working';
              opts.afterStall?.(stalls.length, requestsPath);
              return screen;
            },
            renderScreenPng: async () => null,
            snapshot: () => 'working', drainDelta: () => '',
            isAlive: () => stalls.length < opts.stallLimit, exitCode: null, kill: () => {},
          };
        }) as never,
      });
      return { stalls, levels };
    } finally {
      log.mockRestore();
    }
  }

  test('points at R-RUN11 on the Nth consecutive same-command frame-stall and stays silent at N-1', async () => {
    const atThreshold = await collectSameCommandFrameStalls({
      runId: 'frame-stall-same-command-n', stallLimit: N,
    });
    const belowThreshold = await collectSameCommandFrameStalls({
      runId: 'frame-stall-same-command-n-minus-1', stallLimit: N - 1,
    });

    expect(atThreshold.stalls).toHaveLength(N);
    const hinted = atThreshold.stalls[N - 1]!;
    expect(typeof hinted.ruleHint).toBe('string');
    expect(hinted.ruleHint).toContain('R-RUN11');
    expect(String(hinted.ruleHint).length).toBeGreaterThan(0);
    expect(String(hinted.ruleHint).length).toBeLessThanOrEqual(200);
    expect(String(hinted.ruleHint).includes('\n')).toBe(false);
    expect(atThreshold.stalls.slice(0, N - 1).every((stall) => !Object.hasOwn(stall, 'ruleHint'))).toBe(true);
    expect(atThreshold.stalls.map((stall) => stall.sameCommandStreak)).toEqual(
      Array.from({ length: N }, (_, i) => i + 1),
    );
    expect(hinted.sameCommandStreak).toBe(N);
    expect(Object.hasOwn(hinted, 'ruleHint')).toBe(true);

    expect(belowThreshold.stalls).toHaveLength(N - 1);
    expect(belowThreshold.stalls.every((stall) => !Object.hasOwn(stall, 'ruleHint'))).toBe(true);
    expect(belowThreshold.stalls.every((stall) => stall.lastCommandFirstToken === 'git')).toBe(true);
    const belowKeys = new Set(belowThreshold.stalls.flatMap((stall) => Object.keys(stall)));
    expect(belowKeys.has('ruleHint')).toBe(false);
    expect(belowKeys.has('lastCommandFirstToken')).toBe(true);
    expect(belowKeys.has('sameCommandStreak')).toBe(true);
    expect(belowThreshold.stalls.map((stall) => stall.sameCommandStreak)).toEqual(
      Array.from({ length: N - 1 }, (_, i) => i + 1),
    );
    const belowLast = belowThreshold.stalls[N - 2]!;
    expect(belowLast.sameCommandStreak).toBe(N - 1);
    expect(Object.hasOwn(belowLast, 'ruleHint')).toBe(false);
    expect(belowThreshold.stalls[0]!.sameCommandStreak).toBe(1);

    const noToken = await collectSameCommandFrameStalls({
      runId: 'frame-stall-no-command-start', stallLimit: N, omitCommandStart: true,
    });
    expect(noToken.stalls.length).toBeGreaterThan(0);
    expect(noToken.stalls.every((stall) => !Object.hasOwn(stall, 'lastCommandFirstToken'))).toBe(true);
    expect(noToken.stalls.every((stall) => !Object.hasOwn(stall, 'sameCommandStreak'))).toBe(true);
    expect(noToken.stalls.every((stall) => !Object.hasOwn(stall, 'ruleHint'))).toBe(true);
    expect(noToken.stalls.every((stall) => stall.sameCommandStreak !== 0)).toBe(true);

    expect(atThreshold.levels[0]).toBe('debug');
    expect(atThreshold.levels[1]).toBe('warn');
    const src = readFileSync(join(import.meta.dir, 'headless-elanous-driver.ts'), 'utf8');
    expect(src).toContain("st.state !== 'idle' && st.rung >= 1 ? 'warn' : 'debug'");
  });

  test('resets the consecutive streak when the command token changes, including a stall-less B between A runs', async () => {
    const alternating = await collectSameCommandFrameStalls({
      runId: 'frame-stall-alternating-commands', stallLimit: 3,
      screenFor: (stallCount) => `working-${stallCount}`,
      afterStall: (stallCount, requestsPath) => {
        if (stallCount === 1) writeCommandStart(requestsPath, 'tsc');
        if (stallCount === 2) writeCommandStart(requestsPath, 'git');
      },
    });
    expect(alternating.stalls.length).toBeGreaterThanOrEqual(3);
    expect(alternating.stalls.every((stall) => !Object.hasOwn(stall, 'ruleHint'))).toBe(true);

    let injectedB = false;
    let injectedA = false;
    const reset = await collectSameCommandFrameStalls({
      runId: 'frame-stall-n-minus-1-then-other-then-a', stallLimit: N,
      screenFor: (stallCount) => {
        if (stallCount < N - 1) return 'working-a';
        if (!injectedA) return injectedB ? 'working-b' : 'working-a';
        return 'working-a2';
      },
      afterStall: (stallCount, requestsPath) => {
        if (stallCount === N - 1 && !injectedB) {
          writeCommandStart(requestsPath, 'tsc');
          injectedB = true;
          return;
        }
        if (injectedB && !injectedA) {
          writeCommandStart(requestsPath, 'git');
          injectedA = true;
        }
      },
    });
    expect(reset.stalls.length).toBeGreaterThan(N - 1);
    expect(reset.stalls.slice(0, N - 1).every((stall) => !Object.hasOwn(stall, 'ruleHint'))).toBe(true);
    const afterBreak = reset.stalls[N - 1]!;
    expect(Object.hasOwn(afterBreak, 'ruleHint')).toBe(false);
    expect(reset.stalls.slice(N - 1).every((stall) => !Object.hasOwn(stall, 'ruleHint'))).toBe(true);
  });
});

describe('headless goal-loop timeout caps', () => {
  test('defaults the absolute cap to 6900 while preserving the soft cap and wallclock warning fields', async () => {
    const { stateDir, cwd } = configureHeartbeatState();
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      events.push({ event, data: data ?? {} });
    }) as never);
    const originalNow = Date.now;
    Date.now = () => 0;
    try {
      const defaultResult = await runHeadlessGoalLoopPty({
        binRoot: '/tmp/repo', cwd, featurePrompt: 'x', pollMs: 1, ptyAvailable: () => true,
        spawn: onePollPty(), readParentPid: () => 4242,
      });
      const defaultHeartbeat = JSON.parse(readFileSync(heartbeatPath(stateDir), 'utf8'));

      let wallclockNowCalls = 0;
      Date.now = () => wallclockNowCalls++ === 0 ? 0 : 6_900_000;
      const wallclockResult = await runHeadlessGoalLoopPty({
        binRoot: '/tmp/repo', cwd, featurePrompt: 'x', pollMs: 1, ptyAvailable: () => true,
        spawn: alivePty(), readParentPid: () => 4242,
      });
      const wallclockCap = events.find(({ event }) => event === 'headless.wallclock-cap')!;

      expect(defaultHeartbeat).toEqual(expect.objectContaining({ softI: 600, hardI: DEFAULT_MAX_HARD_WAIT_SEC }));
      expect(defaultResult).toEqual(expect.objectContaining({ exitReason: 'child-exit' }));
      expect(wallclockResult).toEqual(expect.objectContaining({ exitReason: 'wallclock-cap' }));
      expect(wallclockCap.data).toEqual(expect.objectContaining({ elapsedSec: DEFAULT_MAX_HARD_WAIT_SEC, hardI: DEFAULT_MAX_HARD_WAIT_SEC }));
    } finally {
      Date.now = originalNow;
      log.mockRestore();
    }
  });

  test('keeps the child hard cap before the parent implementation timeout', () => {
    expect(DEFAULT_MAX_HARD_WAIT_SEC * 1000).toBeLessThan(DEFAULT_STEP_TIMEOUTS.implement);
  });

  test('clamps a caller absolute cap below the soft cap to the soft cap', async () => {
    const { stateDir, cwd } = configureHeartbeatState();
    const originalNow = Date.now;
    Date.now = () => 0;
    try {
      const result = await runHeadlessGoalLoopPty({
        binRoot: '/tmp/repo', cwd, featurePrompt: 'x', maxWaitSec: 6000, maxHardWaitSec: 1,
        pollMs: 1, ptyAvailable: () => true, spawn: onePollPty(), readParentPid: () => 4242,
      });
      const heartbeat = JSON.parse(readFileSync(heartbeatPath(stateDir), 'utf8'));

      expect(heartbeat).toEqual(expect.objectContaining({ softI: 6000, hardI: 6000 }));
      expect(result).toEqual(expect.objectContaining({ exitReason: 'child-exit' }));
    } finally {
      Date.now = originalNow;
    }
  });

  test('preserves a caller absolute cap above the soft cap', async () => {
    const { stateDir, cwd } = configureHeartbeatState();
    const originalNow = Date.now;
    Date.now = () => 0;
    try {
      const result = await runHeadlessGoalLoopPty({
        binRoot: '/tmp/repo', cwd, featurePrompt: 'x', maxWaitSec: 6000, maxHardWaitSec: 7200,
        pollMs: 1, ptyAvailable: () => true, spawn: onePollPty(), readParentPid: () => 4242,
      });
      const heartbeat = JSON.parse(readFileSync(heartbeatPath(stateDir), 'utf8'));

      expect(heartbeat).toEqual(expect.objectContaining({ softI: 6000, hardI: 7200 }));
      expect(result).toEqual(expect.objectContaining({ exitReason: 'child-exit' }));
    } finally {
      Date.now = originalNow;
    }
  });
});

describe('headless goal-loop parent PID observation', () => {
  test('adds the parent PID and alive status to the existing human heartbeat without changing the loop result', async () => {
    const { stateDir, cwd } = configureHeartbeatState();
    const result = await runParentPidPoll(cwd, () => 4242);
    const heartbeat = JSON.parse(readFileSync(heartbeatPath(stateDir), 'utf8'));

    expect(heartbeat).toEqual(expect.objectContaining({
      i: 0, alive: true, lastActivityI: -1, silentFor: -1, softI: 1, hardI: 1,
      parentPid: 4242, parentStatus: 'alive',
    }));
    expect(result).toEqual(expect.objectContaining({
      ok: true, reachedCompletion: false, timedOut: true, exitReason: 'loop-exhausted', ptyId: 'self_parent_pid',
    }));
  });

  test('records the transition to an orphaned parent exactly once with the existing poll.heartbeat event', async () => {
    const { cwd } = configureHeartbeatState();
    const events: Array<Record<string, unknown>> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'poll.heartbeat') events.push(data ?? {});
    }) as never);
    let reads = 0;
    try {
      const result = await runParentPidPoll(cwd, () => [4242, 1, 1][reads++]!, 3);
      const transitions = events.filter((event) => event.parentOrphanedTransition === true);

      expect(transitions).toEqual([expect.objectContaining({ parentPid: 1, parentStatus: 'orphaned' })]);
      expect(result).toEqual(expect.objectContaining({ timedOut: true, exitReason: 'loop-exhausted' }));
    } finally {
      log.mockRestore();
    }
  });

  test('keeps an unreadable parent distinct from alive and orphaned in both heartbeat outputs', async () => {
    const { stateDir, cwd } = configureHeartbeatState();
    const events: Array<Record<string, unknown>> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'poll.heartbeat') events.push(data ?? {});
    }) as never);
    try {
      await runParentPidPoll(cwd, () => { throw new Error('ppid unavailable'); });
      const heartbeat = JSON.parse(readFileSync(heartbeatPath(stateDir), 'utf8'));

      expect(heartbeat).toEqual(expect.objectContaining({ parentStatus: 'unreadable' }));
      expect(heartbeat.parentPid).toBeUndefined();
      expect(events).toContainEqual(expect.objectContaining({ parentStatus: 'unreadable' }));
      expect(events.some((event) => event.parentStatus === 'alive' || event.parentStatus === 'orphaned')).toBe(false);
    } finally {
      log.mockRestore();
    }
  });
});

function progressPty(deltas: string[], id = 'self_progress_frame') {
  return (() => ({
    id, write: () => {}, renderScreen: async () => 'working', renderScreenPng: async () => null,
    snapshot: () => 'working', drainDelta: () => deltas.shift() ?? '', isAlive: () => true, exitCode: null, kill: () => {},
  })) as never;
}

async function runProgressFramePoll(deltas: string[]) {
  const { cwd } = configureHeartbeatState();
  return runHeadlessGoalLoopPty({
    binRoot: '/tmp/repo', cwd, featurePrompt: 'x', maxWaitSec: deltas.length, maxHardWaitSec: deltas.length,
    pollMs: 1, activityGraceSec: 100, ptyAvailable: () => true, spawn: progressPty(deltas), readParentPid: () => 4242,
  });
}

function maxLengthProgressFrame(): string {
  const targetLength = 64 * 1024 - 1;
  let low = 0;
  let high = targetLength;
  while (low <= high) {
    const humanLine = 'x'.repeat(Math.floor((low + high) / 2));
    const frame = encodeDetachedProgressFrame({ version: 1, kind: 'step', seq: 64, humanLine });
    if (frame.length === targetLength) return frame;
    if (frame.length < targetLength) low = humanLine.length + 1;
    else high = humanLine.length - 1;
  }
  throw new Error('unable to construct max-length structured progress frame');
}

describe('PTY delta progress observations', () => {
  test('ANSI-containing 200-character delta reports a shorter stripped length and truncation', () => {
    const delta = `\u001B[31m${'x'.repeat(200)}\u001B[0m`;
    const observation = buildPtyDeltaProgressObservation(delta);

    expect(observation.strippedChars).toBe(200);
    expect(observation.strippedChars).toBeLessThan(delta.length);
    expect(observation.tailTruncated).toBe(true);
  });

  test('ANSI-free 50-character delta reports stripped length 50 without truncation', () => {
    const delta = 'x'.repeat(50);

    expect(buildPtyDeltaProgressObservation(delta)).toEqual({
      strippedChars: 50,
      tailTruncated: false,
      tail: delta,
    });
  });
});

describe('headless goal-loop structured progress-frame observation', () => {
  test('emits one observation when a complete frame is split across two output deltas', async () => {
    const frame = `${encodeDetachedProgressFrame({ version: 1, kind: 'step', seq: 3, planId: 'plan-1', stepId: 'step-1', humanLine: 'implement' })}\n`;
    const events: Array<Record<string, unknown>> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'headless.progress-frame') events.push(data ?? {});
    }) as never);
    try {
      await runProgressFramePoll([frame.slice(0, 'PROGRESS_'.length), frame.slice('PROGRESS_'.length)]);
      expect(events).toEqual([expect.objectContaining({
        ptyId: 'self_progress_frame', kind: 'step', seq: 3, planId: 'plan-1', stepId: 'step-1', humanLine: 'implement',
      })]);
      expect(events[0]?.runId).toEqual(expect.any(String));
    } finally {
      log.mockRestore();
    }
  });

  test('emits one observation for each complete frame in a single output delta', async () => {
    const frames = [
      encodeDetachedProgressFrame({ version: 1, kind: 'plan', seq: 1, planId: 'plan-1' }),
      encodeDetachedProgressFrame({ version: 1, kind: 'step', seq: 2, humanLine: 'test' }),
    ].join('\n').concat('\n');
    const events: Array<Record<string, unknown>> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'headless.progress-frame') events.push(data ?? {});
    }) as never);
    try {
      await runProgressFramePoll([frames]);
      expect(events).toEqual([
        expect.objectContaining({ kind: 'plan', seq: 1, planId: 'plan-1' }),
        expect.objectContaining({ kind: 'step', seq: 2, humanLine: 'test' }),
      ]);
    } finally {
      log.mockRestore();
    }
  });

  test('silently drops an undecodable prefixed frame while poll processing continues', async () => {
    const events: Array<Record<string, unknown>> = [];
    const progressEvents: Array<Record<string, unknown>> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'headless.progress-frame') events.push(data ?? {});
      if (event === 'headless.progress') progressEvents.push(data ?? {});
    }) as never);
    try {
      const result = await runProgressFramePoll(['PROGRESS_FRAME:not-valid-base64\n', 'still polling\n']);
      expect(events).toHaveLength(0);
      expect(progressEvents).toHaveLength(2);
      expect(result).toEqual(expect.objectContaining({ timedOut: true, exitReason: 'loop-exhausted' }));
    } finally {
      log.mockRestore();
    }
  });

  test('does not emit an incomplete line and preserves the existing progress tail truncation', async () => {
    const partial = `${encodeDetachedProgressFrame({ version: 1, kind: 'plan', seq: 8 })}${'x'.repeat(140)}`;
    const frames: Array<Record<string, unknown>> = [];
    const progressEvents: Array<Record<string, unknown>> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'headless.progress-frame') frames.push(data ?? {});
      if (event === 'headless.progress') progressEvents.push(data ?? {});
    }) as never);
    try {
      await runProgressFramePoll([partial]);
      expect(frames).toHaveLength(0);
      expect(progressEvents).toEqual([expect.objectContaining({ chars: partial.length, tail: partial.slice(-120) })]);
    } finally {
      log.mockRestore();
    }
  });

  test('applies the physical-line limit equally to complete and split frames', async () => {
    const maxLengthFrame = maxLengthProgressFrame();
    const captureFrames = async (deltas: string[]) => {
      const frames: Array<Record<string, unknown>> = [];
      const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
        if (event === 'headless.progress-frame') frames.push(data ?? {});
      }) as never);
      try {
        await runProgressFramePoll(deltas);
        return frames;
      } finally {
        log.mockRestore();
      }
    };
    const atLimit = `${maxLengthFrame}\r\n`;
    const aboveLimit = `${maxLengthFrame}\r\r\n`;

    expect(atLimit.length - 1).toBe(64 * 1024);
    expect(aboveLimit.length - 1).toBe(64 * 1024 + 1);
    expect(await captureFrames([atLimit])).toHaveLength(1);
    expect(await captureFrames([atLimit.slice(0, 17), atLimit.slice(17)])).toHaveLength(1);
    expect(await captureFrames([aboveLimit])).toHaveLength(0);
    expect(await captureFrames([aboveLimit.slice(0, 17), aboveLimit.slice(17)])).toHaveLength(0);
  });

  test('drops long newline-free non-frame output, then resynchronizes only after an explicit newline', async () => {
    const nonFrameOutput = 'x'.repeat(128 * 1024);
    const frame = `${encodeDetachedProgressFrame({ version: 1, kind: 'plan', seq: 9 })}\n`;
    const frames: Array<Record<string, unknown>> = [];
    const progressEvents: Array<Record<string, unknown>> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'headless.progress-frame') frames.push(data ?? {});
      if (event === 'headless.progress') progressEvents.push(data ?? {});
    }) as never);
    try {
      const result = await runProgressFramePoll([nonFrameOutput, `\n${frame}`]);
      expect(frames).toEqual([expect.objectContaining({ kind: 'plan', seq: 9 })]);
      expect(progressEvents).toHaveLength(2);
      expect(progressEvents[0]).toEqual(expect.objectContaining({ chars: nonFrameOutput.length, tail: nonFrameOutput.slice(-120) }));
      expect(progressEvents[1]).toEqual(expect.objectContaining({ chars: frame.length + 1, tail: ` ${frame.trim()} ` }));
      expect(result).toEqual(expect.objectContaining({ timedOut: true, exitReason: 'loop-exhausted' }));
    } finally {
      log.mockRestore();
    }
  });

  test('does not promote a prefixed fragment after noise, whether it crosses a poll boundary or not', async () => {
    const frame = `${encodeDetachedProgressFrame({ version: 1, kind: 'plan', seq: 10 })}\n`;
    const mixedLine = `noise PROGRESS_${frame.slice('PROGRESS_'.length)}`;
    const captureFrames = async (deltas: string[]) => {
      const frames: Array<Record<string, unknown>> = [];
      const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
        if (event === 'headless.progress-frame') frames.push(data ?? {});
      }) as never);
      try {
        await runProgressFramePoll(deltas);
        return frames;
      } finally {
        log.mockRestore();
      }
    };

    expect(await captureFrames(['noise PROGRESS_', frame.slice('PROGRESS_'.length)])).toHaveLength(0);
    expect(await captureFrames([mixedLine])).toHaveLength(0);
  });
});

describe('headless goal-loop child file heartbeat — 갈림 ① ㉢ · ② ㉠', () => {
  test('passes the workspace heartbeat path through the existing spawned-process env', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'child-liveness-env-'));
    stateDirs.push(cwd);
    const env = await captureChildEnv({ cwd });
    expect(env[CHILD_LIVENESS_HEARTBEAT_ENV]).toBe(resolveChildLivenessHeartbeatPath(cwd));
    expect(env[CHILD_LIVENESS_HEARTBEAT_ENV]).toBe(join(cwd, CHILD_LIVENESS_HEARTBEAT_FILE));
  });

  test('silent periodic heartbeats refresh lastActivityI and prevent soft-timeout past the soft cap', async () => {
    const { stateDir } = configureHeartbeatState();
    const cwd = mkdtempSync(join(tmpdir(), 'child-liveness-live-'));
    stateDirs.push(cwd);
    const path = resolveChildLivenessHeartbeatPath(cwd);
    let at = 0;
    const lastActivity: number[] = [];
    const originalNow = Date.now;
    Date.now = () => 0;
    try {
      const result = await runHeadlessGoalLoopPty({
        binRoot: '/tmp/repo', cwd, featurePrompt: 'x',
        maxWaitSec: 3, maxHardWaitSec: 8, activityGraceSec: 2, pollMs: 1,
        ptyAvailable: () => true,
        spawn: (() => ({
          id: 'self_liveness_refresh', write: () => {}, renderScreen: async () => 'working',
          renderScreenPng: async () => null, snapshot: () => 'working',
          drainDelta: () => {
            at += 1;
            writeFileSync(path, JSON.stringify({ at }));
            return '';
          },
          isAlive: () => true, exitCode: null, kill: () => {},
        })) as never,
        onProgress: () => {
          lastActivity.push(JSON.parse(readFileSync(heartbeatPath(stateDir), 'utf8')).lastActivityI);
        },
      });
      expect(result.exitReason).toBe('loop-exhausted');
      expect(result.exitReason).not.toBe('soft-timeout');
      expect(Math.max(...lastActivity)).toBeGreaterThanOrEqual(2);
      expect(lastActivity.some((value, i) => i > 0 && value > lastActivity[i - 1]!)).toBe(true);
    } finally {
      Date.now = originalNow;
    }
  });

  test('a no-heartbeat child still terminates at the same soft-timeout tick', async () => {
    const { stateDir } = configureHeartbeatState();
    const cwd = mkdtempSync(join(tmpdir(), 'child-liveness-silent-'));
    stateDirs.push(cwd);
    const originalNow = Date.now;
    Date.now = () => 0;
    try {
      const result = await runHeadlessGoalLoopPty({
        binRoot: '/tmp/repo', cwd, featurePrompt: 'x',
        maxWaitSec: 3, maxHardWaitSec: 20, activityGraceSec: 2, pollMs: 1,
        ptyAvailable: () => true,
        spawn: (() => ({
          id: 'self_liveness_legacy', write: () => {}, renderScreen: async () => 'working',
          renderScreenPng: async () => null, snapshot: () => 'working', drainDelta: () => '',
          isAlive: () => true, exitCode: null, kill: () => {},
        })) as never,
      });
      expect(result.exitReason).toBe('soft-timeout');
      expect(result.timedOut).toBe(true);
      const hb = JSON.parse(readFileSync(heartbeatPath(stateDir), 'utf8'));
      expect(hb.i).toBe(2);
      expect(hb.lastActivityI).toBe(-1);
    } finally {
      Date.now = originalNow;
    }
  });

  test('a stopped heartbeat file does not keep refreshing activity after at stops advancing', async () => {
    const { stateDir } = configureHeartbeatState();
    const cwd = mkdtempSync(join(tmpdir(), 'child-liveness-stopped-'));
    stateDirs.push(cwd);
    const path = resolveChildLivenessHeartbeatPath(cwd);
    writeFileSync(path, JSON.stringify({ at: 1 }));
    const originalNow = Date.now;
    Date.now = () => 0;
    try {
      const result = await runHeadlessGoalLoopPty({
        binRoot: '/tmp/repo', cwd, featurePrompt: 'x',
        maxWaitSec: 3, maxHardWaitSec: 20, activityGraceSec: 2, pollMs: 1,
        ptyAvailable: () => true,
        spawn: (() => ({
          id: 'self_liveness_stopped', write: () => {}, renderScreen: async () => 'working',
          renderScreenPng: async () => null, snapshot: () => 'working', drainDelta: () => '',
          isAlive: () => true, exitCode: null, kill: () => {},
        })) as never,
      });
      expect(result.exitReason).toBe('soft-timeout');
      expect(result.timedOut).toBe(true);
      expect(JSON.parse(readFileSync(heartbeatPath(stateDir), 'utf8')).i).toBe(2);
    } finally {
      Date.now = originalNow;
    }
  });

  test('does not change default soft/hard/grace caps and keeps screen-based termination off', async () => {
    expect(DEFAULT_ACTIVITY_GRACE_SEC).toBe(240);
    expect(DEFAULT_MAX_HARD_WAIT_SEC).toBe(6_900);
    const src = readFileSync(join(import.meta.dir, 'headless-elanous-driver.ts'), 'utf8');
    expect(src).toContain('const softI = opts.maxWaitSec ?? 600;');
    expect(src).toContain('opts.maxHardWaitSec ?? DEFAULT_MAX_HARD_WAIT_SEC');
    expect(src).toContain('opts.screenStallTermination?.enabled ?? false');
    expect(src).not.toContain('queryObservationStore');
  });

  test('emits shadow approval candidates distinctly through runHeadlessGoalLoopPty boundary watcher', async () => {
    const lines: string[] = [];
    let aliveChecks = 0;
    await runHeadlessGoalLoopPty({
      binRoot: '/tmp/repo', cwd: '/tmp/worktree', featurePrompt: 'x', runId: 'boundary-shadow-candidate',
      maxWaitSec: 2, maxHardWaitSec: 2, pollMs: 1, activityGraceSec: 100,
      ptyAvailable: () => true, onSurfaceProgress: (line) => lines.push(line),
      boundaryRequestsWatchOptions: { pollMs: 1 },
      spawn: ((options: { env: Record<string, string> }) => {
        writeFileSync(options.env.ELANOUS_HARNESS_BOUNDARY_REQUESTS!, [
          JSON.stringify({ requestId: 'shadow-candidate', boundary: '/tmp/worktree', cwd: '/tmp/worktree', targetKnown: true, target: '/tmp/worktree/src/a.ts', commandFirstToken: 'bun' }),
          JSON.stringify({ requestId: 'shadow-preserved', boundary: '/tmp/worktree', cwd: '/tmp/worktree', targetKnown: false }),
        ].join('\n').concat('\n'));
        return {
          id: 'boundary-shadow-candidate', write: () => {}, renderScreen: async () => 'working', renderScreenPng: async () => null,
          snapshot: () => 'working', drainDelta: () => '', isAlive: () => aliveChecks++ < 8, exitCode: 0, kill: () => {},
        };
      }) as never,
    });

    expect(lines).toContain('[boundary] requestId=shadow-candidate reason=boundary-shell-syntax-with-bun parentWouldApprove=true approvalEnforced=false childRejection=would-have-been-approved observedRawShellMetacharacters=unknown\n');
    expect(lines).toContain('[boundary] requestId=shadow-preserved reason=command-token-missing parentWouldApprove=false approvalEnforced=false childRejection=preserved observedRawShellMetacharacters=unknown\n');
  });
});

describe('boundary Jev shadow watcher wiring', () => {
  test('starts only the rejected enabled shadow after response and callback without awaiting it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'boundary-jev-watcher-'));
    const requests = join(dir, 'requests');
    const responses = join(dir, 'responses');
    const calls: string[] = [];
    let finish!: (value: { model: string; answers: {} }) => void;
    try {
      writeFileSync(requests, [
        JSON.stringify({ requestId: 'started', requestType: 'command-start', commandFirstToken: 'git' }),
        JSON.stringify({ requestId: 'rejected-1', boundary: '/tmp/worktree', cwd: '/tmp/worktree', targetKnown: false }),
      ].join('\n').concat('\n'));
      const stop = watchHarnessBoundaryRequests(requests, { ptyId: 'pty', runId: 'run' }, {
        responsePath: responses, pollMs: 1_000_000,
        boundaryShadow: { enabled: true, endpoint: 'http://localhost:1234/v1/systemone' },
        boundaryShadowDeps: {
          callJev: async (req) => {
            calls.push((req.state as { request: { requestId: string } }).request.requestId);
            return new Promise((resolve) => { finish = resolve; });
          },
          log: (_category, event) => { if (event === 'judged') calls.push(event); },
          logUsage: () => {},
        },
        onVerdict: () => { expect(readFileSync(responses, 'utf8')).toContain('"requestId":"rejected-1"'); calls.push('callback'); },
      });
      try {
        expect(calls).toEqual(['callback']);
        await Promise.resolve();
        expect(calls).toEqual(['callback', 'rejected-1']);
        finish({ model: 'local', answers: { irreversible: { type: 'noul', noul: 0.9 } } });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(calls).toEqual(['callback', 'rejected-1', 'judged']);
      } finally { stop(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('boundary behavior-axis shadow', () => {
  const dirs: string[] = [];
  const previousKey = process.env.TYPESAFE_API_KEY;
  afterEach(() => {
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function mailbox(): { requests: string; responses: string } {
    const dir = mkdtempSync(join(tmpdir(), 'behavior-axis-'));
    dirs.push(dir);
    return { requests: join(dir, 'requests'), responses: join(dir, 'responses') };
  }

  function answers(noul: Partial<Record<keyof BoundaryBehaviorAxisAnswers, number>> = {}): BoundaryBehaviorAxisAnswers {
    return {
      irreversible: { type: 'noul', noul: noul.irreversible ?? 0.02 },
      outside_workdir: { type: 'noul', noul: noul.outside_workdir ?? 0.1 },
      reaches_network: { type: 'noul', noul: noul.reaches_network ?? 0.03 },
    };
  }

  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  test('records the token axis and the three behavior answers on the same requestId, including one disagreement', async () => {
    const box = mailbox();
    const events: Array<Record<string, unknown>> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'approval-shadow' || event === 'behavior-axis') events.push({ event, ...(data ?? {}) });
    }) as never);
    const calls: string[] = [];
    writeFileSync(box.requests, [
      JSON.stringify({ requestId: 'ls-safe', boundary: '/tmp/worktree', cwd: '/tmp/worktree', targetKnown: true, target: '/tmp/worktree/src/a.ts', commandFirstToken: 'ls', command: 'ls -la src/' }),
      JSON.stringify({ requestId: 'git-force', boundary: '/tmp/worktree', cwd: '/tmp/worktree', targetKnown: true, target: '/tmp/worktree/src/a.ts', commandFirstToken: 'git', command: 'git push --force origin main' }),
    ].join('\n').concat('\n'));
    const stop = watchHarnessBoundaryRequests(box.requests, { ptyId: 'pty', runId: 'run' }, {
      pollMs: 1_000_000,
      responsePath: box.responses,
      behaviorAxis: {
        env: { TYPESAFE_API_KEY: 'test-key' },
        readCache: () => undefined,
        call: (state) => {
          calls.push(state.cmd);
          return state.cmd.startsWith('git')
            ? answers({ irreversible: 0.75, outside_workdir: 0.48, reaches_network: 0.98 })
            : answers();
        },
      },
    });
    try {
      await flush();
      const shadows = events.filter((event) => event.event === 'approval-shadow');
      const axes = events.filter((event) => event.event === 'behavior-axis');
      const ls = axes.find((event) => event.requestId === 'ls-safe');
      const git = axes.find((event) => event.requestId === 'git-force');
      expect(shadows.map((event) => event.requestId)).toEqual(['ls-safe', 'git-force']);
      expect(axes.map((event) => event.requestId)).toEqual(['ls-safe', 'git-force']);
      expect(ls).toEqual(expect.objectContaining({
        tokenWouldApprove: false,
        tokenEvidenceWhy: 'command-token-not-allowlisted',
        recipeVerdict: 'act',
        axesDiffer: true,
        answers: answers(),
      }));
      expect(git).toEqual(expect.objectContaining({
        tokenWouldApprove: true,
        tokenEvidenceWhy: 'boundary-shell-syntax-with-git',
        recipeVerdict: 'escalate',
        axesDiffer: true,
      }));
      const gitAnswers = git?.answers as BoundaryBehaviorAxisAnswers;
      expect(gitAnswers.irreversible.noul).toBe(0.75);
      expect(gitAnswers.outside_workdir.noul).toBe(0.48);
      expect(gitAnswers.reaches_network.noul).toBe(0.98);
      expect(calls).toEqual(['ls -la src/', 'git push --force origin main']);
      expect(readFileSync(box.responses, 'utf8')).toContain('"requestId":"ls-safe"');
    } finally {
      stop();
      log.mockRestore();
    }
  });

  test('writes the response line before a behavior caller that never settles', async () => {
    const box = mailbox();
    writeFileSync(box.requests, `${JSON.stringify({ requestId: 'hung', boundary: '/tmp/worktree', cwd: '/tmp/worktree', targetKnown: true, target: '/tmp/worktree/src/a.ts', commandFirstToken: 'ls', command: 'ls -la src/' })}\n`);
    const started = Date.now();
    const stop = watchHarnessBoundaryRequests(box.requests, { ptyId: 'pty', runId: 'run' }, {
      pollMs: 1_000_000,
      responsePath: box.responses,
      behaviorAxis: {
        env: { TYPESAFE_API_KEY: 'test-key' },
        readCache: () => undefined,
        call: () => new Promise<BoundaryBehaviorAxisAnswers>(() => {}),
      },
    });
    try {
      await flush();
      expect(Date.now() - started).toBeLessThan(1000);
      expect(readFileSync(box.responses, 'utf8')).toContain('"requestId":"hung"');
      expect(readFileSync(box.responses, 'utf8')).toContain('"wouldApprove":false');
    } finally {
      stop();
    }
  });

  test('records credential absence without calling the recipe and keeps the token shadow', async () => {
    delete process.env.TYPESAFE_API_KEY;
    const box = mailbox();
    const events: Array<Record<string, unknown>> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'approval-shadow' || event === 'behavior-axis') events.push({ event, ...(data ?? {}) });
    }) as never);
    writeFileSync(box.requests, `${JSON.stringify({ requestId: 'no-key', boundary: '/tmp/worktree', cwd: '/tmp/worktree', targetKnown: true, target: '/tmp/worktree/src/a.ts', commandFirstToken: 'ls', command: 'ls -la src/' })}\n`);
    const stop = watchHarnessBoundaryRequests(box.requests, { ptyId: 'pty', runId: 'run' }, {
      pollMs: 1_000_000,
      responsePath: box.responses,
      behaviorAxis: { env: {}, readCache: () => undefined },
    });
    try {
      await flush();
      const axis = events.find((event) => event.event === 'behavior-axis');
      expect(events).toContainEqual(expect.objectContaining({
        event: 'approval-shadow', requestId: 'no-key', wouldApprove: false, evidenceWhy: 'command-token-not-allowlisted',
      }));
      expect(axis).toEqual(expect.objectContaining({ requestId: 'no-key', skipped: 'credential-absent' }));
      expect(axis).not.toHaveProperty('recipeVerdict');
      expect(axis).not.toHaveProperty('answers');
    } finally {
      stop();
      log.mockRestore();
    }
  });
});

describe('headless goal-loop output artifact watchdog', () => {
  test('rejects a completion marker without required artifacts and queues a restart packet', async () => {
    const supervisorInputs: string[] = [];
    const result = await runHeadlessGoalLoopPty({
      binRoot: '/tmp/repo', cwd: '/tmp/watchdog-fixture', featurePrompt: 'implement watchdog',
      maxWaitSec: 1, maxHardWaitSec: 1, pollMs: 1, ptyAvailable: () => true,
      spawn: (() => ({ ...alivePtyHandle('self_output_watchdog'), renderScreen: async () => 'GOAL-COMPLETE', snapshot: () => 'GOAL-COMPLETE' })) as never,
      outputArtifactWatchdog: {
        initial: { observedAtMs: 0, goal: false, code: false, test: false },
        snapshot: () => ({ observedAtMs: 1, goal: true, code: false, test: false }),
        policy: { required: ['goal', 'code', 'test'], deadlineMs: 100, exactNextAction: 'Write code and run tests.', condensedContext: 'Child declared completion without code or tests.' },
      },
      onSupervisorInput: (text) => supervisorInputs.push(text),
    });

    expect(result.reachedCompletion).toBe(false);
    expect(supervisorInputs).toHaveLength(1);
    expect(supervisorInputs[0]).toContain('WATCHDOG: required artifacts missing: code, test');
    expect(supervisorInputs[0]).toContain('NEXT ACTION: Write code and run tests.');
  });
});
