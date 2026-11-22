import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INTERJECTION_NOTE, INTERRUPTED_ON_PURPOSE_NOTE, stripInterruptedOnPurposeContext, withInterruptedOnPurposeContext } from '../chat/interjection.js';
import { streamLLMWithTools, type LLMProvider } from '../llm.js';
import { runTurn } from '../session/chat.js';
import { createSession } from '../session/index.js';
import { clearPendingUserInput, drainPendingUserInput } from '../session/pending-input.js';
import { nextTuiPublicHistory } from '../tui/core/public-history.js';
import { createNextTuiSteerInbox, createNextTuiSteerRouter, NEXT_TUI_STEER_RETRACT_TYPE, NEXT_TUI_STEER_TYPE } from './next-tui-steer.js';

const READ_TOOL = [{ name: 'Read', description: 'Read', parameters: { type: 'object', properties: {} } }];
const sessions: string[] = [];
afterEach(() => { for (const sid of sessions.splice(0)) clearPendingUserInput(sid); });

function session(name: string): string {
  const sid = `a200-steer-${name}`;
  sessions.push(sid);
  return sid;
}

describe('A200 mid-turn steer — tool loop boundary (fake provider)', () => {
  test('a steer pushed during a tool joins the next model request after that tool result', async () => {
    const sid = session('boundary');
    const applied: string[][] = [];
    const inbox = createNextTuiSteerInbox(sid, (ids) => applied.push(ids));
    const steer = 'unique-a200-steer-use-plan-b';
    const toolResult = 'unique-a200-read-result';
    const requests: string[] = [];
    const provider: LLMProvider = {
      name: 'a200-steer-test', defaultModel: 'a200-steer-test', available: () => true,
      async *chat() { yield 'unused'; },
      async *streamChat(messages) {
        requests.push(JSON.stringify(messages));
        if (requests.length === 1) yield { type: 'tool_call', id: 'read-1', name: 'Read', args: {} };
        else yield { type: 'text', delta: 'done' };
      },
    };
    await streamLLMWithTools(
      [{ role: 'user', content: 'original prompt' }],
      {
        onText() {},
        // The person types while the tool runs; the tool itself is not cut.
        dispatchTool: async () => { inbox.push('steer-1', steer); return toolResult; },
      },
      { provider, tools: READ_TOOL, drainPendingUserInput: () => drainPendingUserInput(sid) },
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]).not.toContain(steer);
    const second = requests[1]!;
    // Order: original prompt → tool result → steer (as a user interjection), once.
    expect(second.indexOf('original prompt')).toBeLessThan(second.indexOf(toolResult));
    expect(second.indexOf(toolResult)).toBeLessThan(second.indexOf(INTERJECTION_NOTE));
    expect(second.indexOf(INTERJECTION_NOTE)).toBeLessThan(second.indexOf(steer));
    expect(second.split(steer)).toHaveLength(2);
    expect(applied).toEqual([['steer-1']]);
    expect(inbox.finish()).toEqual([]);
  });

  test('a steer with no further model request is carried to the next turn, not dropped or doubled', async () => {
    const sid = session('carry');
    const applied: string[][] = [];
    const inbox = createNextTuiSteerInbox(sid, (ids) => applied.push(ids));
    const steer = 'unique-a200-steer-too-late';
    const requests: string[] = [];
    const provider: LLMProvider = {
      name: 'a200-steer-test', defaultModel: 'a200-steer-test', available: () => true,
      async *chat() { yield 'unused'; },
      async *streamChat(messages) {
        requests.push(JSON.stringify(messages));
        inbox.push('steer-late', steer);
        yield { type: 'text', delta: 'final answer' };
      },
    };
    await streamLLMWithTools(
      [{ role: 'user', content: 'original prompt' }],
      { onText() {}, dispatchTool: async () => 'unused' },
      { provider, tools: READ_TOOL, drainPendingUserInput: () => drainPendingUserInput(sid) },
    );
    expect(requests.join('')).not.toContain(steer);
    expect(applied).toEqual([]);
    // The parent still holds it and submits it as the next turn; the child keeps no ghost copy.
    expect(inbox.finish()).toEqual(['steer-late']);
    expect(drainPendingUserInput(sid)).toEqual([]);
  });
});

// Why the two tests above did not catch the PTY failure: they hand `drainPendingUserInput` to
// `streamLLMWithTools` themselves. The REPL child never calls the tool loop directly — it calls
// `runTurn` (session/chat.ts), whose plain tool path did not wire the drain (only `runCoreTurn` did),
// so the steer sat in the registry until the turn ended and left again as a separate turn.
describe('A200 mid-turn steer — through runTurn (the REPL child path)', () => {
  test('runTurn drains a steer pushed during a tool into the next model request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'a200-steer-run-turn-'));
    const oldRoot = process.env.ELANOUS_SESSION_ROOT;
    process.env.ELANOUS_SESSION_ROOT = root;
    try {
      const steer = 'unique-a200-run-turn-steer';
      const toolResult = 'unique-a200-run-turn-read-result';
      const requests: string[] = [];
      const provider: LLMProvider = {
        name: 'a200-steer-run-turn', defaultModel: 'a200-steer-run-turn', available: () => true,
        async *chat() { yield 'unused'; },
        async *streamChat(messages) {
          requests.push(JSON.stringify(messages));
          if (requests.length === 1) yield { type: 'tool_call', id: 'read-run-turn', name: 'Read', args: {} };
          else yield { type: 'text', delta: 'done' };
        },
      };
      const meta = createSession({ source: 'cli', provider: provider.name, model: provider.defaultModel });
      sessions.push(meta.id);
      const applied: string[][] = [];
      const inbox = createNextTuiSteerInbox(meta.id, (ids) => applied.push(ids));
      await runTurn({
        userConfig: { chat: {}, llm: { provider: provider.name, model: provider.defaultModel,
          memoryJudge: { enabled: false, crossRecall: false } } } as never,
        sessionId: meta.id,
        userText: 'original run-turn prompt',
        systemPrompt: 'base prompt',
        skipMemoryInjection: true,
        tools: READ_TOOL,
        provider,
        // The person types while the tool runs (same moment as the Next TUI PTY stage).
        dispatchTool: async () => { inbox.push('steer-run-turn', steer); return toolResult; },
      });
      expect(requests).toHaveLength(2);
      expect(requests[0]).not.toContain(steer);
      const second = requests[1]!;
      expect(second.indexOf(toolResult)).toBeLessThan(second.indexOf(steer));
      expect(second.split(steer)).toHaveLength(2);
      expect(applied).toEqual([['steer-run-turn']]);
      // Applied, so nothing is carried back to the parent as a separate next turn.
      expect(inbox.finish()).toEqual([]);
    } finally {
      if (oldRoot === undefined) delete process.env.ELANOUS_SESSION_ROOT; else process.env.ELANOUS_SESSION_ROOT = oldRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('A200 steer IPC router', () => {
  test('buffers a steer that arrives before the turn listens, and routes a retract', () => {
    const sid = session('router');
    const router = createNextTuiSteerRouter();
    expect(router.receive({ type: NEXT_TUI_STEER_TYPE, turnId: 'tui-1', steerId: 'steer-1', text: 'early' })).toBe(true);
    expect(router.receive({ type: 'elanous.next-tui.push-now', turnId: 'tui-1', requestId: 'r' })).toBe(false);
    const inbox = createNextTuiSteerInbox(sid, () => {});
    const stop = router.listen('tui-1', (request) => {
      if (request.kind === 'steer') inbox.push(request.steerId, request.text);
      else inbox.retract(request.steerIds);
    });
    expect(router.receive({ type: NEXT_TUI_STEER_RETRACT_TYPE, turnId: 'tui-1', steerIds: ['steer-1'] })).toBe(true);
    stop();
    // Recalled to the prompt: nothing is left for the model or for the next turn.
    expect(drainPendingUserInput(sid)).toEqual([]);
    expect(inbox.finish()).toEqual([]);
  });
});

describe('A200 interrupted-on-purpose context line', () => {
  test('the model gets one context line; the chat bubble shows only the person words', () => {
    const sent = withInterruptedOnPurposeContext('queued after cancel');
    expect(sent.startsWith(INTERRUPTED_ON_PURPOSE_NOTE)).toBe(true);
    expect(sent.split(INTERRUPTED_ON_PURPOSE_NOTE)).toHaveLength(2);
    expect(stripInterruptedOnPurposeContext(sent)).toBe('queued after cancel');
    const shown = nextTuiPublicHistory([{ role: 'user', content: sent, ts: new Date(0).toISOString() }]);
    expect(shown[0]!.content).toBe('queued after cancel');
  });
});
