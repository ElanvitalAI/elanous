// TUI-AGENT-CAPS (core + wiring) — subagent ceiling helpers: turn clamp, one-level
// nest strip, background fan-out ceiling + live count, and the ceiling's single
// enforcement point inside the production `dispatchAgent` dispatch path
// (after dedup, before `sessionCache.noteSeen`).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  AGENT_TOOL_BACKGROUND_FANOUT_CEILING,
  AGENT_TOOL_DEFAULT_MAX_TURNS,
  AGENT_TOOL_TURNS_CEILING,
  countLiveBackgroundFanout,
  countSessionBackgroundFanout,
  dispatchAgent,
  resolveAgentToolMaxTurns,
  stripAgentToolForOneLevelNesting,
  type AgentToolResult,
} from './agent.js';
import { globalAgentRegistry } from '../../agent/registry.js';
import { SessionCache } from '../../session/cache.js';
import type { AgentDefinition } from '../../agent/types.js';
import type { LLMProvider, LLMStreamEvent, LLMToolSpec } from '../../llm.js';

function fakeProvider(turns: LLMStreamEvent[][]): LLMProvider {
  let call = 0;
  const p: LLMProvider = {
    name: 'fake',
    defaultModel: 'fake-model',
    available: () => true,
    async *streamChat() {
      const events = turns[call++] ?? [];
      for (const ev of events) yield ev;
    },
    async *chat(messages, opts) {
      for await (const ev of p.streamChat!(messages, opts)) {
        if (ev.type === 'text') yield ev.delta;
      }
    },
  };
  return p;
}

/** Provider whose every child call parks until the test releases it, so
 *  background workers stay LIVE (state running) instead of finishing between
 *  dispatches. `calls` counts real provider invocations — the spawn ruler. */
function gatedProvider(calls: { count: number }, releases: Array<() => void>): LLMProvider {
  return {
    name: 'gated',
    defaultModel: 'gated-model',
    available: () => true,
    async *streamChat() {
      calls.count += 1;
      await new Promise<void>((resolve) => { releases.push(resolve); });
      yield { type: 'text', delta: 'worker done' };
    },
    async *chat() {},
  };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => { setTimeout(resolve, 2); });
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}

const stubDef: AgentDefinition = {
  name: 'value-investor',
  systemPrompt: 'You are Margaret Chen.',
  tools: ['Bash'],
};

beforeEach(() => {
  globalAgentRegistry.clear();
});
afterEach(() => {
  globalAgentRegistry.clear();
});

describe('Agent-tool cap helpers', () => {
  test('turn ceiling constants match the documented defaults', () => {
    expect(AGENT_TOOL_DEFAULT_MAX_TURNS).toBe(20);
    expect(AGENT_TOOL_TURNS_CEILING).toBe(50);
    expect(AGENT_TOOL_BACKGROUND_FANOUT_CEILING).toBe(8);
  });

  test('resolveAgentToolMaxTurns defaults, honours, and clamps', () => {
    expect(resolveAgentToolMaxTurns(undefined)).toBe(AGENT_TOOL_DEFAULT_MAX_TURNS);
    expect(resolveAgentToolMaxTurns(7)).toBe(7);
    expect(resolveAgentToolMaxTurns(9999)).toBe(AGENT_TOOL_TURNS_CEILING);
    expect(resolveAgentToolMaxTurns(0)).toBe(1);
    expect(resolveAgentToolMaxTurns(Number.NaN)).toBe(AGENT_TOOL_DEFAULT_MAX_TURNS);
    expect(resolveAgentToolMaxTurns('20')).toBe(AGENT_TOOL_DEFAULT_MAX_TURNS);
  });

  test('stripAgentToolForOneLevelNesting drops Agent and keeps the rest', () => {
    const tools: LLMToolSpec[] = [
      { name: 'Bash', description: 'b', parameters: { type: 'object' } },
      { name: 'Agent', description: 'a', parameters: { type: 'object' } },
      { name: 'Read', description: 'r', parameters: { type: 'object' } },
    ];
    expect(stripAgentToolForOneLevelNesting(tools).map(t => t.name)).toEqual(['Bash', 'Read']);
  });

  test('countLiveBackgroundFanout ignores foreground and terminal tasks', () => {
    expect(countLiveBackgroundFanout([
      { background: true, state: 'running' },
      { background: true, state: 'pending' },
      { background: true, state: 'done' },
      { background: true, state: 'error' },
      { background: true, state: 'aborted' },
      { background: false, state: 'running' },
      { state: 'running' },
    ])).toBe(2);
  });
});

describe('dispatchAgent — helpers on the existing path', () => {
  test('max_turns still clamps through resolveAgentToolMaxTurns', async () => {
    const provider = fakeProvider([[{ type: 'text', delta: 'k' }]]);
    const over = await dispatchAgent(
      { description: 'd', prompt: 'p', max_turns: 9999 },
      { provider, resolveAgentDef: () => stubDef },
    );
    expect(over.maxTurns).toBe(AGENT_TOOL_TURNS_CEILING);
    const def = await dispatchAgent(
      { description: 'd2', prompt: 'p2' },
      { provider: fakeProvider([[{ type: 'text', delta: 'k' }]]), resolveAgentDef: () => stubDef },
    );
    expect(def.maxTurns).toBe(AGENT_TOOL_DEFAULT_MAX_TURNS);
  });

  test('child tool list is stripped of Agent (one-level nest)', async () => {
    let childToolNames: string[] = [];
    const provider: LLMProvider = {
      name: 'capture',
      defaultModel: 'd',
      available: () => true,
      async *streamChat(_m, opts) {
        childToolNames = (opts?.tools ?? []).map(t => t.name);
        yield { type: 'text', delta: 'done' };
      },
      async *chat() {},
    };
    const hostTools: LLMToolSpec[] = [
      { name: 'Bash', description: 'b', parameters: { type: 'object' } },
      { name: 'Read', description: 'r', parameters: { type: 'object' } },
      { name: 'Agent', description: 'a', parameters: { type: 'object' } },
    ];
    const def: AgentDefinition = { ...stubDef, tools: ['Bash', 'Read', 'Agent'] };
    await dispatchAgent(
      { description: 'd', prompt: 'p' },
      { provider, hostTools, resolveAgentDef: () => def },
    );
    expect(childToolNames).toContain('Bash');
    expect(childToolNames).toContain('Read');
    expect(childToolNames).not.toContain('Agent');
  });
});

describe('dispatchAgent — background fan-out ceiling on the production path', () => {
  test('definition resolution failures release reservations before later launches', async () => {
    const sessionCache = new SessionCache();
    for (let i = 0; i < AGENT_TOOL_BACKGROUND_FANOUT_CEILING + 1; i++) {
      await expect(dispatchAgent(
        { description: `failing worker ${i}`, prompt: `failing work ${i}`, run_in_background: true },
        {
          provider: fakeProvider([]), sessionCache,
          resolveAgentDef: () => { throw new Error('resolver failed'); },
        },
      )).rejects.toThrow('resolver failed');
      expect(countSessionBackgroundFanout(sessionCache)).toBe(0);
    }

    const calls = { count: 0 };
    const releases: Array<() => void> = [];
    const provider = gatedProvider(calls, releases);
    try {
      for (let i = 0; i < AGENT_TOOL_BACKGROUND_FANOUT_CEILING; i++) {
        const result = await dispatchAgent(
          { description: `good worker ${i}`, prompt: `good work ${i}`, run_in_background: true },
          { provider, sessionCache, resolveAgentDef: () => stubDef },
        );
        expect(result.background).toBe(true);
      }
      await waitFor(() => calls.count === AGENT_TOOL_BACKGROUND_FANOUT_CEILING, 'all post-error workers spawned');
      expect(countSessionBackgroundFanout(sessionCache)).toBe(AGENT_TOOL_BACKGROUND_FANOUT_CEILING);
    } finally {
      for (const release of releases) release();
      await waitFor(() => countSessionBackgroundFanout(sessionCache) === 0, 'post-error workers drained');
    }
  });

  test('8 backgrounds spawn, the 9th is refused with spawn 0 + noteSeen 0, and a terminal slot re-opens it', async () => {
    const providerCalls = { count: 0 };
    const releases: Array<() => void> = [];
    const gated = gatedProvider(providerCalls, releases);
    const sessionCache = new SessionCache();
    const opts = { provider: gated, sessionCache, resolveAgentDef: () => stubDef };

    try {
    // ── 8 background launches fill every fan-out slot ──
    const launches: AgentToolResult[] = [];
    for (let i = 0; i < AGENT_TOOL_BACKGROUND_FANOUT_CEILING; i++) {
      launches.push(await dispatchAgent(
        { description: `bg worker ${i}`, prompt: `background work ${i}`, run_in_background: true },
        opts,
      ));
    }
    await waitFor(
      () => providerCalls.count === AGENT_TOOL_BACKGROUND_FANOUT_CEILING,
      'all background workers reached the provider',
    );
    const liveAtCeiling = countLiveBackgroundFanout(globalAgentRegistry.list());
    expect(liveAtCeiling).toBe(AGENT_TOOL_BACKGROUND_FANOUT_CEILING);
    for (const launch of launches) expect(launch.background).toBe(true);

    // Foreground dispatch is NOT gated by the background ceiling — unchanged behaviour.
    const foreground = await dispatchAgent(
      { description: 'foreground work', prompt: 'foreground work' },
      { provider: fakeProvider([[{ type: 'text', delta: 'fg-answer' }]]), sessionCache, resolveAgentDef: () => stubDef },
    );
    expect(foreground.output).toContain('fg-answer');
    expect(providerCalls.count).toBe(AGENT_TOOL_BACKGROUND_FANOUT_CEILING);

    // ── the 9th background launch is refused: spawn 0, noteSeen 0 ──
    const spawnsBeforeNinth = providerCalls.count;
    const tasksBeforeNinth = globalAgentRegistry.size;
    const cacheBeforeNinth = sessionCache.size;
    const ninth = await dispatchAgent(
      { description: 'bg worker 8', prompt: 'background work 8', run_in_background: true },
      opts,
    );
    const ninthSpawn = providerCalls.count - spawnsBeforeNinth;
    const ninthNoteSeen = sessionCache.size - cacheBeforeNinth;
    expect(ninthSpawn).toBe(0);
    expect(ninthNoteSeen).toBe(0);
    expect(globalAgentRegistry.size).toBe(tasksBeforeNinth);
    expect(ninth.taskId).toBe('background-fanout-limit');
    expect(ninth.output).toContain('NOT SPAWNED');

    // ── one worker terminals → its slot re-opens for the SAME prompt ──
    releases[0]!();
    await waitFor(
      () => globalAgentRegistry.list().some(t => t.background === true && t.state === 'done'),
      'a background worker reached a terminal state (state=done)',
    );
    const liveAfterTerminal = countLiveBackgroundFanout(globalAgentRegistry.list());
    expect(liveAfterTerminal).toBe(AGENT_TOOL_BACKGROUND_FANOUT_CEILING - 1);

    // Same description + prompt as the refused call: if the refusal had written
    // the cache entry, this retry would come back as taskId 'dedup' with no spawn.
    const reentry = await dispatchAgent(
      { description: 'bg worker 8', prompt: 'background work 8', run_in_background: true },
      opts,
    );
    await waitFor(() => providerCalls.count === AGENT_TOOL_BACKGROUND_FANOUT_CEILING + 1, 're-entry spawn reached the provider');
    const reentrySpawn = providerCalls.count - spawnsBeforeNinth - ninthSpawn;
    expect(reentrySpawn).toBe(1);
    expect(reentry.taskId).not.toBe('background-fanout-limit');
    expect(reentry.taskId).not.toBe('dedup');
    expect(sessionCache.size).toBe(cacheBeforeNinth + 1);

    console.log(
      `[fanout-ceiling] backgrounds_spawned=${AGENT_TOOL_BACKGROUND_FANOUT_CEILING} ` +
      `live_at_ceiling=${liveAtCeiling} ninth_spawn=${ninthSpawn} ` +
      `ninth_noteSeen=${ninthNoteSeen} ninth_taskId=${ninth.taskId} ` +
      `live_after_terminal=${liveAfterTerminal} reentry_spawn=${reentrySpawn} ` +
      `reentry_taskId=${reentry.taskId}`,
    );

    } finally {
      for (const release of releases) release();
      await waitFor(() => countLiveBackgroundFanout(globalAgentRegistry.list()) === 0, 'background workers drained');
    }
  });

  test('concurrent background dispatches cannot all pass the ceiling (atomic slot reservation)', async () => {
    const providerCalls = { count: 0 };
    const releases: Array<() => void> = [];
    const gated = gatedProvider(providerCalls, releases);
    const sessionCache = new SessionCache();
    const opts = { provider: gated, sessionCache, resolveAgentDef: () => stubDef };

    try {
    // 7 launches occupy 7 fan-out slots.
    for (let i = 0; i < AGENT_TOOL_BACKGROUND_FANOUT_CEILING - 1; i++) {
      await dispatchAgent(
        { description: `bg worker ${i}`, prompt: `background work ${i}`, run_in_background: true },
        opts,
      );
    }
    await waitFor(
      () => providerCalls.count === AGENT_TOOL_BACKGROUND_FANOUT_CEILING - 1,
      'seven background workers reached the provider',
    );

    // Two concurrent dispatches race for the last slot: the ceiling check and
    // the slot reservation are one synchronous block, so exactly one wins and
    // the other is refused — never 9 live in this session.
    const results = await Promise.all([
      dispatchAgent(
        { description: 'race winner', prompt: 'race winner work', run_in_background: true },
        opts,
      ),
      dispatchAgent(
        { description: 'race loser', prompt: 'race loser work', run_in_background: true },
        opts,
      ),
    ]);
    expect(results.filter(r => r.taskId === 'background-fanout-limit')).toHaveLength(1);
    expect(results.filter(r => r.background === true)).toHaveLength(1);
    expect(countSessionBackgroundFanout(sessionCache)).toBe(AGENT_TOOL_BACKGROUND_FANOUT_CEILING);
    expect(countLiveBackgroundFanout(globalAgentRegistry.list()))
      .toBe(AGENT_TOOL_BACKGROUND_FANOUT_CEILING);

    } finally {
      for (const release of releases) release();
      await waitFor(() => countLiveBackgroundFanout(globalAgentRegistry.list()) === 0, 'background workers drained');
    }
  });

  test("the ceiling is per session: another session's 8 live tasks do not refuse this session's first launch", async () => {
    const releases: Array<() => void> = [];
    const gatedA = gatedProvider({ count: 0 }, releases);
    const gatedB = gatedProvider({ count: 0 }, releases);
    const sessionA = new SessionCache();
    const sessionB = new SessionCache();
    const optsA = { provider: gatedA, sessionCache: sessionA, resolveAgentDef: () => stubDef };
    const optsB = { provider: gatedB, sessionCache: sessionB, resolveAgentDef: () => stubDef };

    try {
    // Session A fills all 8 slots.
    for (let i = 0; i < AGENT_TOOL_BACKGROUND_FANOUT_CEILING; i++) {
      await dispatchAgent(
        { description: `session A bg ${i}`, prompt: `session A background ${i}`, run_in_background: true },
        optsA,
      );
    }
    expect(countLiveBackgroundFanout(globalAgentRegistry.list()))
      .toBe(AGENT_TOOL_BACKGROUND_FANOUT_CEILING);

    // Session B's FIRST background launch is NOT refused by A's 8 live tasks —
    // the boundary is the session, not the global registry.
    const firstB = await dispatchAgent(
      { description: 'session B first bg', prompt: 'session B background 0', run_in_background: true },
      optsB,
    );
    expect(firstB.taskId).not.toBe('background-fanout-limit');
    expect(firstB.background).toBe(true);
    expect(countSessionBackgroundFanout(sessionA)).toBe(AGENT_TOOL_BACKGROUND_FANOUT_CEILING);
    expect(countSessionBackgroundFanout(sessionB)).toBe(1);

    // The boundary did not leak slots: session A's own 9th stays refused.
    const ninthA = await dispatchAgent(
      { description: 'session A ninth', prompt: 'session A ninth background', run_in_background: true },
      optsA,
    );
    expect(ninthA.taskId).toBe('background-fanout-limit');
    expect(countSessionBackgroundFanout(sessionA)).toBe(AGENT_TOOL_BACKGROUND_FANOUT_CEILING);
    expect(countSessionBackgroundFanout(sessionB)).toBe(1);

    } finally {
      for (const release of releases) release();
      await waitFor(() => countLiveBackgroundFanout(globalAgentRegistry.list()) === 0, 'background workers drained');
    }
  });
});
