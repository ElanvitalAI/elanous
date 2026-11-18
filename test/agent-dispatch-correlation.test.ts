// ── RFC #7333 `A0` (장치) — the agent axis must be pairable from the call site ──
//
// Why this file exists (measured 2026-08-23, all universes, no truncation):
//
//   agent.spawn/dispatch   15
//   ├─ agent.done/finish   10
//   ├─ agent.spawn/background 4   → terminal state landed on a DIFFERENT
//   │                               category (agent.task-routing), so the
//   │                               obvious ruler `dispatch − finish` scored
//   │                               every one of them as "unaccounted"
//   └─ genuinely unpaired   1
//
// So 4 of the 5 apparent gaps were an instrumentation hole, not lost work.
// Two invariants close it, and this file pins both:
//
//   ① `dispatchAgent` RETURNS the correlation id it stamps on its own log
//      records. Before this, `cid` lived only inside payloads, so a caller
//      could not pair its dispatch without guessing.
//   ② A backgrounded spawn emits a terminal `agent.done` record on the SAME
//      axis as a foreground one.
//
// ⛔ Note what these tests deliberately do NOT claim: that the CLI entrance
//    (`elanous agent dispatch`) reaches this code. That is a live question and
//    is answered by running the binary, not by an in-process import.

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { dispatchAgent } from '../src/skills/tools/agent';
import { globalAgentRegistry } from '../src/agent/registry';
import type { AgentDefinition } from '../src/agent/types';
import type { LLMProvider, LLMStreamEvent } from '../src/llm';
import { debug } from '../src/debug/log';
import { enterWorktreeRuntime } from '../src/tool-runtime/git-worktree-runtimes';

let worktreeRun: (req: { name: string }) => Promise<{ path: string; branch: string }>;
let restoreWorktreeRunSpy = () => {};

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
  } as LLMProvider;
  return p;
}

const stubDef: AgentDefinition = {
  name: 'value-investor',
  systemPrompt: 'You are Margaret Chen.',
  tools: ['Bash'],
};

beforeEach(() => {
  const worktreeRunSpy = spyOn(enterWorktreeRuntime, 'run').mockImplementation(req => (
    worktreeRun({ name: String(req.name ?? '') }) as ReturnType<typeof enterWorktreeRuntime.run>
  ));
  restoreWorktreeRunSpy = () => worktreeRunSpy.mockRestore();
  globalAgentRegistry.clear();
  debug.disable();
});
afterEach(() => {
  restoreWorktreeRunSpy();
  globalAgentRegistry.clear();
  debug.disable();
});

/** Pull every `cid=…` / `"cid":"…"` token out of the debug tail. The debug
 *  sink renders payloads as text, so we match on the literal id rather than
 *  reaching into a structured record that the sink does not expose. */
function tailText(lines: number): string {
  return debug.tail(lines).join('\n');
}

// #38772: an Agent call without run_in_background runs in the background. The tests
// below check a completed run, so they ask for the blocking call explicitly.
describe('#7333 A0 — dispatch is pairable from the call site', () => {
  test('the returned cid is the SAME id stamped on the spawn record', async () => {
    const provider = fakeProvider([[{ type: 'text', delta: 'ok' }]]);
    debug.enable();
    debug.clear();

    const r = await dispatchAgent(
      { description: 'pairing probe', prompt: 'p', run_in_background: false },
      { provider, resolveAgentDef: () => stubDef },
    );

    // ① the caller gets an id at all. `cid` is declared optional purely for a
    //    gate reason (see its declaration); this asserts the runtime promise
    //    that it is always populated, so the type's weakness cannot rot into
    //    an actually-absent field without a red test.
    expect(typeof r.cid).toBe('string');
    expect(r.cid!.length).toBeGreaterThan(0);

    // ② and it is not a fresh id — it is the one in the log stream. This is
    //    the whole contract: a returned id that did not match would be worse
    //    than no id, because it would look like a working pairing key.
    const text = tailText(40);
    expect(text).toContain('[agent.spawn]');
    expect(text).toContain(r.cid!);

    // ③ the terminal record carries it too, so `spawn` and `done` join.
    expect(text).toContain('[agent.done]');
    const doneLine = debug.tail(40).find(l => l.includes('[agent.done]'));
    expect(doneLine).toBeDefined();
    expect(doneLine!).toContain(r.cid!);
  });

  test('a no-tool dispatch warns the child and marks its spawn without marking a tool-bearing dispatch', async () => {
    debug.enable();
    debug.clear();

    const noTool = await dispatchAgent(
      { description: 'no-tool probe', prompt: 'inspect the repository' },
      { provider: fakeProvider([[{ type: 'text', delta: 'unavailable' }]]), resolveAgentDef: () => stubDef },
    );
    const noToolTask = globalAgentRegistry.get(noTool.taskId);
    expect(noToolTask?.prompt).toContain(
      'No tools are available; if a request requires reading files or executing commands, report that as unavailable rather than guessing.',
    );
    const noToolLine = debug.tail(40).find(line => line.includes('[agent.spawn]') && line.includes(noTool.cid!));
    expect(noToolLine).toContain('"noTools":true');

    debug.clear();
    const toolBearing = await dispatchAgent(
      { description: 'tool-bearing probe', prompt: 'inspect the repository' },
      {
        provider: fakeProvider([[{ type: 'text', delta: 'ok' }]]),
        resolveAgentDef: () => stubDef,
        hostTools: [{ name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: {} } }],
      },
    );
    const toolBearingTask = globalAgentRegistry.get(toolBearing.taskId);
    expect(toolBearingTask?.prompt).not.toContain('No tools are available;');
    const toolBearingLine = debug.tail(40).find(line => line.includes('[agent.spawn]') && line.includes(toolBearing.cid!));
    expect(toolBearingLine).toContain('"noTools":false');
  });

  test('two dispatches get DIFFERENT cids — the key actually discriminates', async () => {
    const mk = () => fakeProvider([[{ type: 'text', delta: 'ok' }]]);
    const a = await dispatchAgent(
      { description: 'first', prompt: 'p1' },
      { provider: mk(), resolveAgentDef: () => stubDef },
    );
    const b = await dispatchAgent(
      { description: 'second', prompt: 'p2' },
      { provider: mk(), resolveAgentDef: () => stubDef },
    );
    expect(a.cid).not.toBe(b.cid);
  });

  test('records distinct worktree catalog mismatch reasons and binds the available catalog to its assigned cwd', async () => {
    worktreeRun = async ({ name }) => ({ path: `/tmp/${name}`, branch: `agent/${name}` });
    debug.enable();
    debug.clear();

    const catalogCwds: string[] = [];
    const catalogBound = await dispatchAgent(
      { description: 'catalog-bound worker', prompt: 'p', isolation: 'worktree' },
      {
        provider: fakeProvider([[{ type: 'text', delta: 'ok' }]]),
        resolveAgentDef: () => stubDef,
        buildChildToolCatalog: (cwd) => {
          catalogCwds.push(cwd);
          return {
            specs: [],
            dispatch: async () => 'unused',
            workingDirectory: '/parent-tool-cwd',
          };
        },
      },
    );
    const inheritedTools = await dispatchAgent(
      { description: 'catalog-missing worker', prompt: 'p', isolation: 'worktree' },
      { provider: fakeProvider([[{ type: 'text', delta: 'ok' }]]), resolveAgentDef: () => stubDef },
    );

    expect(catalogBound.cwd).toBeDefined();
    expect(catalogCwds).toEqual([catalogBound.cwd!]);
    const mismatchLines = debug.tail(80).filter(line => line.includes('[agent.spawn] tool-cwd-mismatch'));
    expect(mismatchLines).toHaveLength(2);
    const catalogMismatch = mismatchLines.find(line => line.includes(catalogBound.cid!));
    const unavailableCatalog = mismatchLines.find(line => line.includes(inheritedTools.cid!));
    expect(catalogMismatch).toContain('"reason":"catalog-working-directory-mismatch"');
    expect(unavailableCatalog).toContain('"reason":"catalog-unavailable-parent-tools-inherited"');
    expect(unavailableCatalog).toContain(inheritedTools.cwd!);
  });

  test('records a catalog factory failure and rethrows the original error without inheriting parent tools', async () => {
    worktreeRun = async ({ name }) => ({ path: `/tmp/${name}`, branch: `agent/${name}` });
    debug.enable();
    debug.clear();
    const factoryError = new Error('catalog factory exploded');

    let receivedError: unknown;
    try {
      await dispatchAgent(
        { description: 'catalog-failure worker', prompt: 'p', isolation: 'worktree' },
        {
          provider: fakeProvider([[{ type: 'text', delta: 'must not run' }]]),
          resolveAgentDef: () => stubDef,
          hostTools: [{ name: 'ParentTool', description: 'must not be inherited', parameters: {} }],
          buildChildToolCatalog: () => { throw factoryError; },
        },
      );
    } catch (error) {
      receivedError = error;
    }

    expect(receivedError).toBe(factoryError);
    const failureLine = debug.tail(80).find(line => line.includes('[agent.spawn] tool-cwd-mismatch'));
    expect(failureLine).toContain('"reason":"catalog-factory-failed"');
    expect(failureLine).toContain('"error":"catalog factory exploded"');
  });

  test('pairs sequential isolated default and explicit names with their cids', async () => {
    const names: string[] = [];
    worktreeRun = async ({ name }) => {
      names.push(name);
      return { path: `/tmp/${name}`, branch: `agent/${name}` };
    };
    debug.enable();
    debug.clear();

    const launch = (name?: string) => dispatchAgent(
      {
        description: `isolated ${name ?? 'default'} worker`,
        prompt: `inspect ${names.length}`,
        subagent_type: 'value-investor',
        isolation: 'worktree',
        ...(name ? { name } : {}),
        run_in_background: false,
      },
      { provider: fakeProvider([[{ type: 'text', delta: 'ok' }]]), resolveAgentDef: () => stubDef },
    );
    const defaultFirst = await launch();
    const defaultSecond = await launch();
    const explicitFirst = await launch('research/name!');
    const explicitSecond = await launch('research/name!');

    for (const result of [defaultFirst, defaultSecond, explicitFirst, explicitSecond]) {
      expect(result.isolation).toBe('worktree');
      expect(typeof result.cid).toBe('string');
    }
    expect(names).toEqual([
      `value-investor-${defaultFirst.cid}`,
      `value-investor-${defaultSecond.cid}`,
      `research/name--${explicitFirst.cid}`,
      `research/name--${explicitSecond.cid}`,
    ]);
    expect(new Set(names).size).toBe(names.length);

    const worktreeLines = debug.tail(80).filter(line => line.includes('[agent.spawn] worktree'));
    expect(worktreeLines).toHaveLength(4);
    for (const result of [defaultFirst, defaultSecond, explicitFirst, explicitSecond]) {
      expect(worktreeLines.some(line => line.includes(result.cid!))).toBe(true);
    }
  });
});

describe('#7333 A0 — a backgrounded spawn terminates on the agent.done axis', () => {
  test('emits agent.done/background-finish carrying the returned cid', async () => {
    const provider = fakeProvider([[{ type: 'text', delta: 'bg ok' }]]);
    debug.enable();
    debug.clear();

    const r = await dispatchAgent(
      { description: 'background probe', prompt: 'p', run_in_background: true },
      { provider, resolveAgentDef: () => stubDef },
    );

    expect(r.background).toBe(true);
    expect(typeof r.cid).toBe('string');

    // The drain runs detached, so poll rather than assert immediately. A
    // fixed sleep would either flake or slow the suite; this bounds both.
    // ⛔ If this ever times out, read it as "the terminal event is missing",
    //    not "the machine was slow" — the drain has no I/O to wait on.
    const deadline = Date.now() + 5_000;
    let text = '';
    while (Date.now() < deadline) {
      text = tailText(80);
      if (text.includes('background-finish')) break;
      await new Promise(res => setTimeout(res, 25));
    }

    expect(text).toContain('background-finish');
    const line = debug.tail(80).find(l => l.includes('background-finish'));
    expect(line).toBeDefined();
    // Same axis as the foreground terminal record — this is what makes
    // `dispatch − (finish + background-finish)` the correct ruler.
    expect(line!).toContain('[agent.done]');
    expect(line!).toContain(r.cid!);
  });
});
