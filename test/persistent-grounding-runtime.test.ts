import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoreTurnContext, GoalLoopResult } from '../src/core-turn/index.js';
import { debug } from '../src/debug/log.js';
import { withSimClock } from '../src/ux-sim/fake-clock.js';
import type { PersistentGroundingDeps } from '../src/skills/tools/persistent-grounding.js';
import {
  _resetToolRuntimeRegistryForTest,
  dispatchToolByName,
  registerAllDefaultToolRuntimes,
  setPersistentGroundingRuntimeDeps,
} from '../src/tool-runtime/index.js';

function worktree(): string {
  const root = mkdtempSync(join(tmpdir(), 'persistent-grounding-runtime-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'candidate.ts'), 'export const candidate = true;\n');
  return root;
}

function completingLoop() {
  return async (ctx: CoreTurnContext): Promise<GoalLoopResult> => {
    const callCtx = { callId: 'grep-candidate', sessionId: ctx.sessionId, signal: ctx.signal };
    await ctx.dispatchTool('Grep', { pattern: 'candidate', path: 'src' }, callCtx);
    ctx.callbacks?.onToolCall?.({ id: callCtx.callId, name: 'Grep', args: { pattern: 'candidate', path: 'src' } });
    const readCtx = { ...callCtx, callId: 'read-candidate' };
    await ctx.dispatchTool('Read', { file_path: 'src/candidate.ts' }, readCtx);
    ctx.callbacks?.onToolCall?.({ id: readCtx.callId, name: 'Read', args: { file_path: 'src/candidate.ts' } });
    ctx.callbacks?.onToolCall?.({
      id: 'complete',
      name: 'update_goal',
      args: { status: 'complete', evidence: 'src/candidate.ts: read verified' },
    });
    return { stopReason: 'goal_complete', finalText: '', iterations: 1, goalComplete: true };
  };
}

describe('PersistentGrounding ToolRuntime', () => {
  test('default registration alias dispatch runs the guarded search loop and records session observations', async () => {
    const root = worktree();
    const sessionId = 'persistent-grounding-runtime-test';
    _resetToolRuntimeRegistryForTest();
    const wasMirrorEnabled = debug.isMirrorEnabled();
    debug.enable();
    const observations: Array<{ category: string; event: string; session_id?: string; data?: unknown }> = [];
    const off = debug.registerSink({ name: 'persistent-grounding-test', emit: (record) => { observations.push(record); } });
    try {
      setPersistentGroundingRuntimeDeps({ grounding: { runGoalLoop: completingLoop(), hasAstGrep: () => false } });
      registerAllDefaultToolRuntimes();
      const result = await dispatchToolByName(
        'PersistentGrounding',
        { goal: 'find the candidate implementation', cwd: root },
        { surface: 'skill', sessionId },
      ) as { output: string; result: { files: string[]; evidence: string[]; iterations: number; stopReason: string } | null };
      expect(result.result).toEqual({
        files: ['src/candidate.ts'],
        evidence: ['src/candidate.ts: read verified'],
        iterations: 1,
        stopReason: 'goal_complete',
      });
      expect(result.output).toContain('src/candidate.ts');

      const observation = observations.find((event) =>
        event.category === 'grounding.persistent'
        && event.event === 'finished'
        && event.session_id === sessionId,
      );
      expect(observation?.data).toEqual(expect.objectContaining({
        iterations: 1,
        toolCalls: { Grep: 1, Read: 1, update_goal: 1 },
      }));
    } finally {
      off();
      debug.setMirror(wasMirrorEnabled);
      setPersistentGroundingRuntimeDeps();
      _resetToolRuntimeRegistryForTest();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('generates one session ID for ambient observations and grounding when no session ID is supplied', async () => {
    const fixedNow = Date.parse('2026-10-15T00:00:00.000Z');
    const expectedSessionId = `persistent-grounding-${fixedNow}`;
    let receivedDeps: PersistentGroundingDeps | undefined;
    _resetToolRuntimeRegistryForTest();
    const wasMirrorEnabled = debug.isMirrorEnabled();
    debug.enable();
    const observations: Array<{ category: string; event: string; session_id?: string; data?: unknown }> = [];
    const off = debug.registerSink({ name: 'persistent-grounding-session-test', emit: (record) => { observations.push(record); } });
    try {
      setPersistentGroundingRuntimeDeps({
        groundPersistently: async (_goal, _cwd, deps = {}) => {
          receivedDeps = deps;
          debug.log('grounding.runtime', 'received-session', { sessionId: deps.sessionId });
          return null;
        },
      });
      registerAllDefaultToolRuntimes();
      await withSimClock(fixedNow, () => dispatchToolByName('PersistentGrounding', { goal: 'find candidate' }, { surface: 'skill' }));

      expect(receivedDeps?.sessionId).toBe(expectedSessionId);
      const observation = observations.find((event) =>
        event.category === 'grounding.runtime' && event.event === 'received-session',
      );
      expect(observation?.session_id).toBe(receivedDeps?.sessionId);
      expect((observation?.data as { sessionId?: string } | undefined)?.sessionId).toBe(receivedDeps?.sessionId);
    } finally {
      off();
      debug.setMirror(wasMirrorEnabled);
      setPersistentGroundingRuntimeDeps();
      _resetToolRuntimeRegistryForTest();
    }
  });

  test('default registration rejects an empty goal before entering the grounding loop', async () => {
    _resetToolRuntimeRegistryForTest();
    try {
      registerAllDefaultToolRuntimes();
      await expect(dispatchToolByName('PersistentGrounding', { goal: '  ' }, { surface: 'skill' })).resolves.toEqual({
        output: 'PersistentGrounding requires a non-empty goal.',
        result: null,
      });
    } finally {
      _resetToolRuntimeRegistryForTest();
    }
  });
});
