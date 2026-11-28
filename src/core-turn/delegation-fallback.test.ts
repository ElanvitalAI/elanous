// TURN-GIVES-UP-NO-WORK — the delegation fallback shape, the row verdict that continues a turn, and the spawn-guard
// fan-out exception. Expected values are hand-written literals (rule 11), not product constants.
import { describe, expect, test } from 'bun:test';
import { delegationFailedResult, delegationResultFailed, delegationFailureMessage, isDelegationTool } from './delegation-fallback.js';
import { turnDelegationFailedWithoutWork } from '../tui/input/goal-continue.js';
import { AgentSpawnGuard, guardedAgentSpawn, isContentFanOutSibling } from '../skills/tools/agent-spawn-guard.js';

describe('delegation fallback result', () => {
  test('one structured failed shape with an inline instruction', () => {
    expect(delegationFailedResult('spawn-threw', ' NOT SPAWNED — limit 3 ')).toEqual({
      success: false,
      status: 'failed',
      delegation: 'failed',
      fallback: 'inline',
      reason: 'spawn-threw',
      error: 'NOT SPAWNED — limit 3',
      instruction: 'The delegated agent did not start, so none of this work was delegated. Do the same work yourself now, in this turn, with your own tools (search, read, and write any file the request asked for). Do not end the turn by saying the work could not be done.',
    });
  });

  test('failure is read from fields only', () => {
    expect(delegationResultFailed({ success: false })).toBe(true);
    expect(delegationResultFailed({ ok: false })).toBe(true);
    expect(delegationResultFailed({ isError: true })).toBe(true);
    expect(delegationResultFailed({ error: 'Research tool budget reached. Answer with the evidence collected so far.' })).toBe(true);
    expect(delegationResultFailed({ error: '   ' })).toBe(false);
    expect(delegationResultFailed({ taskId: 'bg-1', background: true })).toBe(false);
    expect(delegationResultFailed('agent findings')).toBe(false);
    expect(delegationFailureMessage({ error: 'NOT SPAWNED — x' })).toBe('NOT SPAWNED — x');
    expect(delegationFailureMessage({ success: false })).toBe('delegation refused');
    expect(isDelegationTool('Agent')).toBe(true);
    expect(isDelegationTool('Task')).toBe(true);
    expect(isDelegationTool('AgentSend')).toBe(false);
  });
});

describe('row verdict for a continuation', () => {
  const failedAgent = { role: 'tool', toolName: 'Agent', toolResult: { error: 'Research tool budget reached. Answer with the evidence collected so far.' } };
  test('failed delegation and no state change → continue', () => {
    expect(turnDelegationFailedWithoutWork([failedAgent])).toBe(true);
    expect(turnDelegationFailedWithoutWork([failedAgent, { role: 'tool', toolName: 'Read', toolResult: 'file text' }])).toBe(true);
  });
  test('a write after it, a running delegation, or no rows → nothing to continue', () => {
    expect(turnDelegationFailedWithoutWork([failedAgent, { role: 'tool', toolName: 'Write', toolResult: { ok: true } }])).toBe(false);
    expect(turnDelegationFailedWithoutWork([{ role: 'tool', toolName: 'Agent', toolResult: { taskId: 'bg-1', background: true } }])).toBe(false);
    expect(turnDelegationFailedWithoutWork([])).toBe(false);
  });
});

describe('verify-chain does not swallow a fan-out sibling', () => {
  test('a sibling whose prompt says 확인 spawns; a spawn named as a check is refused', async () => {
    const tasks = new Map<string, { state: string }>();
    const guard = new AgentSpawnGuard({ now: () => 1_000_000, taskState: id => tasks.get(id), isCoordinator: () => false });
    let n = 0;
    const spawn = (args: Record<string, unknown>) => guardedAgentSpawn(args, async () => {
      const taskId = `s${++n}`;
      tasks.set(taskId, { state: 'running' });
      return { taskId, background: true };
    }, guard, 'local');
    await expect(spawn({ name: '메모리 생성 저장 조사', reason: 'r', prompt: '메모리 생성과 저장 경로를 코드에서 추적하고 저장 형식을 확인하라' }))
      .resolves.toMatchObject({ taskId: 's1' });
    await expect(spawn({ name: '메모리 회상 검색 조사', reason: 'r', prompt: '메모리 회상과 검색 경로를 코드에서 추적하고 주입 방식을 확인하라' }))
      .resolves.toMatchObject({ taskId: 's2' });
    await expect(spawn({ name: '메모리 저장 검증', reason: 'r', prompt: '메모리 생성과 저장 경로 추적 결과를 검증하라' }))
      .rejects.toThrow('NOT SPAWNED — wait for 메모리 생성 저장 조사; verify once after.');
    expect(isContentFanOutSibling({ name: 'independent check', prompt: 'verify the 18 roster rows moved to next release' },
      { prompt: 'move the 18 roster rows of release ledger to next release' })).toBe(false);
  });
});
