// TUI-AGENT-CAPS (core + wiring) — subagent ceiling helpers: turn clamp, one-level
// nest strip, background fan-out ceiling + live count, and the ceiling's single
// enforcement point inside the production `dispatchAgent` dispatch path
// (after dedup, before `sessionCache.noteSeen`).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  AGENT_TOOL_BACKGROUND_FANOUT_CEILING,
  AGENT_TOOL_DEFAULT_MAX_TURNS,
  AGENT_TOOL_TURNS_CEILING,
  buildAgentTool,
  classifyBackgroundAdmissionPriority,
  countLiveBackgroundFanout,
  countSessionBackgroundFanout,
  dispatchAgent,
  resolveAgentToolMaxTurns,
  selectNextAdmissionIndex,
  stripAgentToolForOneLevelNesting,
  type AgentToolResult,
} from './agent.js';
import { globalAgentRegistry } from '../../agent/registry.js';
import { SessionCache } from '../../session/cache.js';
import type { AgentDefinition } from '../../agent/types.js';
import type { LLMMessage, LLMProvider, LLMStreamEvent, LLMToolSpec } from '../../llm.js';

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
 *  dispatches. `calls` counts real provider invocations — the spawn ruler.
 *  `prompts`, when supplied, records the child prompt each call received, in
 *  arrival order — the ruler for WHICH waiting spawn reached the provider. */
function gatedProvider(
  calls: { count: number },
  releases: Array<() => void>,
  prompts?: string[],
): LLMProvider {
  return {
    name: 'gated',
    defaultModel: 'gated-model',
    available: () => true,
    async *streamChat(messages: LLMMessage[]) {
      calls.count += 1;
      if (prompts) {
        const last = messages[messages.length - 1];
        prompts.push(typeof last?.content === 'string' ? last.content : JSON.stringify(last ?? null));
      }
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

  test('selectNextAdmissionIndex admits subagents first, then FIFO by arrival', () => {
    const general = (seq: number) => ({ priority: 'general' as const, seq });
    const subagent = (seq: number) => ({ priority: 'subagent' as const, seq });
    expect(selectNextAdmissionIndex([])).toBe(-1);
    expect(selectNextAdmissionIndex([general(0), general(1), subagent(2)])).toBe(2);
    expect(selectNextAdmissionIndex([subagent(5), subagent(3), general(1)])).toBe(1);
    expect(selectNextAdmissionIndex([general(7), general(2)])).toBe(1);
    expect(selectNextAdmissionIndex([subagent(4)])).toBe(0);
  });

  test('classifyBackgroundAdmissionPriority treats a named definition as a subagent', () => {
    expect(classifyBackgroundAdmissionPriority('general-purpose')).toBe('general');
    expect(classifyBackgroundAdmissionPriority('value-investor')).toBe('subagent');
  });

  test('buildAgentTool guides delegation without changing its execution API', () => {
    const description = buildAgentTool().description;
    expect(description).toContain('heavy multistep work that would overflow your context');
    expect(description).toContain('independent units in parallel');
    expect(description).toContain('long investigations');
    expect(description).toContain('run_in_background');
  });

  test('buildAgentTool advertises wait_for_slot without making it required', () => {
    const parameters = buildAgentTool().parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(parameters.properties).toHaveProperty('wait_for_slot');
    expect(parameters.required).not.toContain('wait_for_slot');
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

describe('dispatchAgent — shared admission queue on the production path', () => {
  test('a freed slot admits the waiting subagent before earlier general waits, then FIFO within a class', async () => {
    const providerCalls = { count: 0 };
    const releases: Array<() => void> = [];
    const prompts: string[] = [];
    const gated = gatedProvider(providerCalls, releases, prompts);
    const sessionCache = new SessionCache();
    const opts = { provider: gated, sessionCache, resolveAgentDef: () => stubDef };

    try {
      // ── fill every fan-out slot so later launches cannot spawn on arrival ──
      for (let i = 0; i < AGENT_TOOL_BACKGROUND_FANOUT_CEILING; i++) {
        await dispatchAgent(
          { description: `live worker ${i}`, prompt: `live work ${i}`, run_in_background: true },
          opts,
        );
      }
      await waitFor(
        () => providerCalls.count === AGENT_TOOL_BACKGROUND_FANOUT_CEILING,
        'all live workers reached the provider',
      );
      const promptsAtCeiling = prompts.length;

      // ── three launches wait for a slot: two general, one subagent ──
      let generalASettled = false;
      let generalBSettled = false;
      let subagentSettled = false;
      const generalA = dispatchAgent(
        { description: 'queued general A', prompt: 'queued general A work', run_in_background: true, wait_for_slot: true },
        opts,
      );
      void generalA.then(() => { generalASettled = true; });
      const generalB = dispatchAgent(
        { description: 'queued general B', prompt: 'queued general B work', run_in_background: true, wait_for_slot: true },
        opts,
      );
      void generalB.then(() => { generalBSettled = true; });
      const subagent = dispatchAgent(
        {
          description: 'queued subagent', prompt: 'queued subagent work',
          subagent_type: 'value-investor', run_in_background: true, wait_for_slot: true,
        },
        opts,
      );
      void subagent.then(() => { subagentSettled = true; });

      // Waiting means waiting: no refusal, no spawn, no extra provider call.
      await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
      expect(generalASettled).toBe(false);
      expect(generalBSettled).toBe(false);
      expect(subagentSettled).toBe(false);
      expect(providerCalls.count).toBe(AGENT_TOOL_BACKGROUND_FANOUT_CEILING);
      expect(prompts.length).toBe(promptsAtCeiling);

      // ── one live worker terminals → ONE waiter enters ──
      releases[0]!();
      await waitFor(() => subagentSettled, 'the waiting subagent was admitted first');
      const subagentResult = await subagent;
      expect(subagentResult.taskId).not.toBe('background-fanout-limit');
      expect(subagentResult.taskId).not.toBe('dedup');
      expect(subagentResult.background).toBe(true);
      await waitFor(
        () => providerCalls.count === AGENT_TOOL_BACKGROUND_FANOUT_CEILING + 1,
        'the admitted subagent reached the provider',
      );
      expect(prompts[prompts.length - 1]).toContain('queued subagent work');
      expect(generalASettled).toBe(false);
      expect(generalBSettled).toBe(false);

      // ── second freed slot → the earlier of the two equal-class waits ──
      releases[1]!();
      await waitFor(() => generalASettled, 'the earlier general wait was admitted next');
      await waitFor(
        () => providerCalls.count === AGENT_TOOL_BACKGROUND_FANOUT_CEILING + 2,
        'the admitted general A reached the provider',
      );
      expect(prompts[prompts.length - 1]).toContain('queued general A work');
      expect(generalBSettled).toBe(false);

      // ── third freed slot → the remaining wait ──
      releases[2]!();
      await waitFor(() => generalBSettled, 'the remaining general wait was admitted');
      await waitFor(
        () => providerCalls.count === AGENT_TOOL_BACKGROUND_FANOUT_CEILING + 3,
        'the admitted general B reached the provider',
      );
      expect(prompts[prompts.length - 1]).toContain('queued general B work');

      const admittedOrder = prompts
        .filter(p => p.includes('queued '))
        .map(p => (p.match(/queued (general [AB]|subagent) work/) ?? [])[1]);
      expect(admittedOrder).toEqual(['subagent', 'general A', 'general B']);
      // The ceiling itself never moved: admitting waiters refills the same slots.
      expect(countSessionBackgroundFanout(sessionCache)).toBe(AGENT_TOOL_BACKGROUND_FANOUT_CEILING);
      console.log(
        `[admission-queue] admitted_order=${admittedOrder.join(',')} ` +
        `provider_calls=${providerCalls.count} live=${countSessionBackgroundFanout(sessionCache)}`,
      );
    } finally {
      for (const release of releases) release();
      await waitFor(() => countLiveBackgroundFanout(globalAgentRegistry.list()) === 0, 'background workers drained');
    }
  });

  test('an aborted wait leaves the shared queue and is refused without spawning', async () => {
    const providerCalls = { count: 0 };
    const releases: Array<() => void> = [];
    const gated = gatedProvider(providerCalls, releases);
    const sessionCache = new SessionCache();
    const opts = { provider: gated, sessionCache, resolveAgentDef: () => stubDef };
    const abort = new AbortController();

    try {
      for (let i = 0; i < AGENT_TOOL_BACKGROUND_FANOUT_CEILING; i++) {
        await dispatchAgent(
          { description: `live worker ${i}`, prompt: `live work ${i}`, run_in_background: true },
          opts,
        );
      }
      await waitFor(
        () => providerCalls.count === AGENT_TOOL_BACKGROUND_FANOUT_CEILING,
        'all live workers reached the provider',
      );

      let settled = false;
      const waiting = dispatchAgent(
        { description: 'aborted waiter', prompt: 'aborted waiter work', run_in_background: true, wait_for_slot: true },
        { ...opts, signal: abort.signal },
      );
      void waiting.then(() => { settled = true; });
      await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
      expect(settled).toBe(false);

      abort.abort();
      const refused = await waiting;
      expect(refused.taskId).toBe('background-fanout-limit');
      expect(refused.output).toContain('NOT SPAWNED');
      expect(providerCalls.count).toBe(AGENT_TOOL_BACKGROUND_FANOUT_CEILING);

      // The abandoned waiter is gone from the queue: the freed slot stays free.
      releases[0]!();
      await waitFor(
        () => countLiveBackgroundFanout(globalAgentRegistry.list()) === AGENT_TOOL_BACKGROUND_FANOUT_CEILING - 1,
        'a live worker drained',
      );
      await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
      expect(providerCalls.count).toBe(AGENT_TOOL_BACKGROUND_FANOUT_CEILING);
      expect(countSessionBackgroundFanout(sessionCache)).toBe(AGENT_TOOL_BACKGROUND_FANOUT_CEILING - 1);
    } finally {
      for (const release of releases) release();
      await waitFor(() => countLiveBackgroundFanout(globalAgentRegistry.list()) === 0, 'background workers drained');
    }
  });

  test('an admitted waiter that throws before spawn hands the slot to the next waiter', async () => {
    const providerCalls = { count: 0 };
    const releases: Array<() => void> = [];
    const prompts: string[] = [];
    const gated = gatedProvider(providerCalls, releases, prompts);
    const sessionCache = new SessionCache();
    const opts = {
      provider: gated,
      sessionCache,
      resolveAgentDef: (name: string) => {
        if (name === 'value-investor') throw new Error('resolver failed');
        return stubDef;
      },
    };

    try {
      for (let i = 0; i < AGENT_TOOL_BACKGROUND_FANOUT_CEILING; i++) {
        await dispatchAgent(
          { description: `live worker ${i}`, prompt: `live work ${i}`, run_in_background: true },
          opts,
        );
      }
      await waitFor(
        () => providerCalls.count === AGENT_TOOL_BACKGROUND_FANOUT_CEILING,
        'all live workers reached the provider',
      );

      const throwingSubagent = dispatchAgent(
        {
          description: 'throwing subagent', prompt: 'throwing subagent work',
          subagent_type: 'value-investor', run_in_background: true, wait_for_slot: true,
        },
        opts,
      );
      let generalSettled = false;
      const general = dispatchAgent(
        { description: 'queued general', prompt: 'queued general work', run_in_background: true, wait_for_slot: true },
        opts,
      );
      void general.then(() => { generalSettled = true; });

      // The subagent is admitted first, then throws before registering — its
      // finally-released slot must feed the general waiter without another
      // worker finishing.
      releases[0]!();
      await expect(throwingSubagent).rejects.toThrow('resolver failed');
      await waitFor(() => generalSettled, 'the general waiter was admitted by the released slot');
      const generalResult = await general;
      expect(generalResult.background).toBe(true);
      await waitFor(
        () => providerCalls.count === AGENT_TOOL_BACKGROUND_FANOUT_CEILING + 1,
        'only the general waiter reached the provider',
      );
      expect(prompts[prompts.length - 1]).toContain('queued general work');
      expect(countSessionBackgroundFanout(sessionCache)).toBe(AGENT_TOOL_BACKGROUND_FANOUT_CEILING);
    } finally {
      for (const release of releases) release();
      await waitFor(() => countLiveBackgroundFanout(globalAgentRegistry.list()) === 0, 'background workers drained');
    }
  });
});
