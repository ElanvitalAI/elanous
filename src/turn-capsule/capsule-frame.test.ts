import { describe, expect, spyOn, test } from 'bun:test';
import { AgentRegistry, globalAgentRegistry } from '../agent/registry.js';
import type { AgentTask } from '../agent/types.js';
import { createNextTuiBackgroundBridge, watchCapsuleDone } from '../repl/index.js';
import { debug } from '../debug/log.js';
import {
  CAPSULE_FRAME_PREFIX, CAPSULE_FRAME_TEXT_CAP, capsuleDoneFromAgentTask, capsuleDoneTurnEvent,
  encodeCapsuleFrame, parseCapsuleFrame,
} from './capsule-frame.js';
import type { CapsuleDoneEvent } from './contract.js';

const DONE: CapsuleDoneEvent = {
  type: 'capsule-done', capsuleId: 'c-7', kind: 'agent', sessionId: 's-1',
  startedAt: 1_000, endedAt: 61_000, status: 'ok', summary: 'grep tui · ok · 60s',
};
const body = (line: string): string => line.slice(CAPSULE_FRAME_PREFIX.length).trimEnd();

describe('capsule frame (B1)', () => {
  test('encode → parse round-trips a done event and a progress event; one line each', () => {
    const line = encodeCapsuleFrame(DONE);
    expect(line.startsWith(CAPSULE_FRAME_PREFIX)).toBe(true);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1).includes('\n')).toBe(false);
    expect(parseCapsuleFrame(body(line), 's-1')).toEqual(DONE);
    const progress = { type: 'capsule-progress', capsuleId: 'c-7', kind: 'agent', sessionId: 's-1', at: 5, line: 'Grep src/tui' } as const;
    expect(parseCapsuleFrame(body(encodeCapsuleFrame(progress)), 's-1')).toEqual(progress);
  });

  test('parse refuses another session, unknown kind/status, reversed times, bad JSON', () => {
    const json = body(encodeCapsuleFrame(DONE));
    expect(parseCapsuleFrame(json, 's-2')).toBeNull();
    expect(parseCapsuleFrame(JSON.stringify({ ...DONE, kind: 'daemon' }), 's-1')).toBeNull();
    expect(parseCapsuleFrame(JSON.stringify({ ...DONE, status: 'done' }), 's-1')).toBeNull();
    expect(parseCapsuleFrame(JSON.stringify({ ...DONE, endedAt: 500 }), 's-1')).toBeNull();
    expect(parseCapsuleFrame(JSON.stringify({ ...DONE, capsuleId: '' }), 's-1')).toBeNull();
    expect(parseCapsuleFrame('{not json', 's-1')).toBeNull();
  });

  test('summary is one capped line — newlines and control bytes never cross the wire', () => {
    const noisy = { ...DONE, summary: `a\nb\u001b[31m${'x'.repeat(400)}` };
    const parsed = parseCapsuleFrame(body(encodeCapsuleFrame(noisy)), 's-1') as CapsuleDoneEvent;
    expect(parsed.summary.startsWith('a b [31m')).toBe(true);
    expect(parsed.summary.length).toBe(CAPSULE_FRAME_TEXT_CAP);
    expect(parsed.summary.endsWith('…')).toBe(true);
  });

  test('agent task → done event: done=ok · error=failed · aborted=cancelled · running=null', () => {
    const task = { id: 't-1', label: 'scan', definition: { name: 'general' }, startedAt: 10_000, finishedAt: 72_400 };
    expect(capsuleDoneFromAgentTask({ ...task, state: 'done' }, 's-1')).toEqual({
      type: 'capsule-done', capsuleId: 't-1', kind: 'agent', sessionId: 's-1',
      startedAt: 10_000, endedAt: 72_400, status: 'ok', summary: 'scan · ok · 62s',
    });
    expect(capsuleDoneFromAgentTask({ ...task, state: 'error' }, 's-1')?.status).toBe('failed');
    expect(capsuleDoneFromAgentTask({ ...task, state: 'aborted' }, 's-1')?.status).toBe('cancelled');
    expect(capsuleDoneFromAgentTask({ ...task, state: 'running' }, 's-1')).toBeNull();
  });

  test('bus event: source capsule-done · dedupeKey per capsule (a replay is the same key)', () => {
    const event = capsuleDoneTurnEvent(DONE, 99);
    expect(event).toEqual({
      id: 'capsule-done:c-7', source: 'capsule-done', dedupeKey: 'capsule:c-7', arrivedAt: 99,
      text: '[capsule agent c-7 ok] grep tui · ok · 60s', capsule: DONE,
    });
    expect(capsuleDoneTurnEvent(DONE, 100).dedupeKey).toBe(event.dedupeKey);
  });
});

describe('watchCapsuleDone (child side, B1)', () => {
  const spawnTask = (registry: AgentRegistry, opts: Record<string, unknown>): AgentTask =>
    registry.spawn({ definition: { name: 'general', description: 'd', systemPrompt: 'p' }, prompt: 'go', ...opts } as never).task;

  const finish = (registry: AgentRegistry, task: AgentTask, state: 'done' | 'error'): void => {
    task.state = state;
    task.startedAt = 1_000;
    task.finishedAt = 4_000;
    registry.notifyTaskDone(task);
  };

  test('one done frame per background root task of this session (supplement included); foreground, nested, other session: none', () => {
    const registry = new AgentRegistry();
    const lines: string[] = [];
    const known = new Set<string>();
    const watch = watchCapsuleDone('s-1', registry, known, (line) => { lines.push(line); });
    const bg = spawnTask(registry, { background: true, parentSessionId: 's-1', label: 'scan' });
    const fg = spawnTask(registry, { parentSessionId: 's-1' });
    const nested = spawnTask(registry, { background: true, parentSessionId: 's-1', parentTaskId: bg.id });
    const supplement = spawnTask(registry, { background: true, parentSessionId: 's-1', completionDelivery: 'supplement' });
    const other = spawnTask(registry, { background: true, parentSessionId: 's-2' });
    // task-notification flips a finished background task to foreground before this listener runs.
    known.add(bg.id);
    bg.background = false;
    for (const task of [bg, fg, nested, supplement, other]) finish(registry, task, 'done');
    finish(registry, bg, 'done');
    const done = lines.map((line) => parseCapsuleFrame(body(line), 's-1')).filter((event) => event?.type === 'capsule-done');
    expect(done).toEqual([{
      type: 'capsule-done', capsuleId: bg.id, kind: 'agent', sessionId: 's-1',
      startedAt: 1_000, endedAt: 4_000, status: 'ok', summary: 'scan · ok · 3s',
    }, {
      type: 'capsule-done', capsuleId: supplement.id, kind: 'agent', sessionId: 's-1',
      startedAt: 1_000, endedAt: 4_000, status: 'ok', summary: 'general · ok · 3s',
    }]);
    watch.dispose();
    const later = spawnTask(registry, { background: true, parentSessionId: 's-1' });
    finish(registry, later, 'error');
    expect(lines.filter((line) => line.includes('"capsule-done"')).length).toBe(2);
  });
});

describe('background bridge — B1 always on (no flag)', () => {
  const run = async (mode: 'on' | 'off'): Promise<string[]> => {
    const saved = { bg: process.env.ELANOUS_NEXT_TUI_BG_STATUS, mode: process.env.ELANOUS_TURN_CAPSULE_MODE };
    process.env.ELANOUS_NEXT_TUI_BG_STATUS = '1';
    process.env.ELANOUS_TURN_CAPSULE_MODE = mode;
    const frames: string[] = [];
    const write = spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      if (String(chunk).startsWith(CAPSULE_FRAME_PREFIX)) frames.push(String(chunk));
      return true;
    });
    const bridge = createNextTuiBackgroundBridge(`flag-${mode}`, () => 0);
    try {
      const task = globalAgentRegistry.spawn({ definition: { name: 'general', description: 'd', systemPrompt: 'p' },
        prompt: 'go', background: true, parentSessionId: `flag-${mode}` } as never).task;
      bridge!.observeToolResult('Agent', { run_in_background: true }, { taskId: task.id, background: true });
      task.state = 'done';
      task.startedAt = 0;
      task.finishedAt = 2_000;
      globalAgentRegistry.notifyTaskDone(task);
      return frames;
    } finally {
      bridge?.dispose();
      write.mockRestore();
      for (const [key, value] of [['ELANOUS_NEXT_TUI_BG_STATUS', saved.bg], ['ELANOUS_TURN_CAPSULE_MODE', saved.mode]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  };

  test('an old off env no longer stops it: exactly one capsule-done either way', async () => {
    expect((await run('off')).length).toBe(1);
    const log = spyOn(debug, 'log');
    const on = await run('on');
    const life = log.mock.calls.filter((call) => call[0] === 'turn-life' && call[1] === 'turn-life:capsule-done-emitted');
    log.mockRestore();
    expect(life.length).toBe(1);
    expect(life[0]![2]).toMatchObject({ sessionId: 'flag-on', kind: 'agent', status: 'ok', durationMs: 2_000 });
    expect(on.length).toBe(1);
    expect(parseCapsuleFrame(body(on[0]!), 'flag-on')).toMatchObject({ type: 'capsule-done', status: 'ok', kind: 'agent' });
  });
});

describe('watchCapsuleDone progress line from tool calls (B3 ask #88867)', () => {
  test('a background root task\'s tool start → one progress line: name and sequence only, never args/result', () => {
    const registry = new AgentRegistry();
    const lines: string[] = [];
    const watch = watchCapsuleDone('s-1', registry, new Set(), (line) => { lines.push(line); });
    const spawn = (opts: Record<string, unknown>) =>
      registry.spawn({ definition: { name: 'general', description: 'd', systemPrompt: 'p' }, prompt: 'go', ...opts } as never).task;
    const bg = spawn({ background: true, parentSessionId: 's-1', label: 'scan' });
    const fg = spawn({ parentSessionId: 's-1' });
    lines.length = 0;
    registry.emitToolCall({ agentId: bg.id, callIdx: 3, tool: 'Grep', args: { pattern: 'SECRET' }, phase: 'start', ts: 7 });
    registry.emitToolCall({ agentId: bg.id, callIdx: 3, tool: 'Grep', args: {}, phase: 'result', result: 'SECRET', ts: 8 });
    registry.emitToolCall({ agentId: fg.id, callIdx: 1, tool: 'Read', args: {}, phase: 'start', ts: 9 });
    registry.emitToolCall({ agentId: 'unknown', callIdx: 1, tool: 'Read', args: {}, phase: 'start', ts: 9 });
    expect(lines.map((line) => parseCapsuleFrame(body(line), 's-1'))).toEqual([
      { type: 'capsule-progress', capsuleId: bg.id, kind: 'agent', sessionId: 's-1', at: 7, line: 'scan · #3 Grep' },
    ]);
    expect(lines.join('').includes('SECRET')).toBe(false);
    watch.dispose();
    registry.emitToolCall({ agentId: bg.id, callIdx: 4, tool: 'Read', args: {}, phase: 'start', ts: 10 });
    expect(lines.length).toBe(1);
  });
});
