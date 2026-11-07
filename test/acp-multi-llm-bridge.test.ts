// CV-3 DM-1 — multi-llm-bridge unit tests.
//
// Focus: pure helpers (`readMultiLlmHint`) + the silent-skip behaviour
// of the bridge when the hint is absent. The full multi-target
// dispatch path runs `runCoreTurn` (external LLM API) and is covered
// by the higher-level integration smoke (DM-2 client wire round-trip
// + user dogfood) — exercising it here would require mocking the LLM
// stack with `mock.module()`, which CLAUDE.md memory explicitly
// disallows for new tests.

import { describe, expect, it, spyOn } from 'bun:test';
import {
  bridgeMultiLlmCoreTurnsToAcp,
  readMultiLlmHint,
  routeAgentSessionUpdate,
} from '../src/acp/multi-llm-bridge.js';
import type { AcpTurnContext } from '../src/acp/server.js';
import * as coreTurnModule from '../src/core-turn/run-core-turn.js';
import type { CoreTurnContext } from '../src/core-turn/types.js';

describe('readMultiLlmHint (DM-1)', () => {
  it('returns null when promptMeta is undefined', () => {
    expect(readMultiLlmHint(undefined)).toBeNull();
  });

  it('returns null when elanous namespace is missing', () => {
    expect(readMultiLlmHint({ source: 'pwa' })).toBeNull();
  });

  it('returns null when multiLlm key is missing', () => {
    expect(readMultiLlmHint({ elanous: { ui: {} } })).toBeNull();
  });

  it('returns null when targets array is empty', () => {
    expect(
      readMultiLlmHint({ elanous: { multiLlm: { targets: [] } } }),
    ).toBeNull();
  });

  it('parses a 2-target hint with id + provider', () => {
    const hint = readMultiLlmHint({
      elanous: {
        multiLlm: {
          targets: [
            { id: 'p1', provider: 'claude' },
            { id: 'p2', provider: 'gemini', model: 'gemini-3-pro' },
          ],
        },
      },
    });
    expect(hint).not.toBeNull();
    expect(hint!.targets).toHaveLength(2);
    expect(hint!.targets[0]!.id).toBe('p1');
    // RFC #2161 Phase 2 (2026-05-10) — wire's `provider: 'claude'` is
    // normalized to canonical 'anthropic' via Layer A alias map. The
    // PWA Showroom may keep the user-facing label 'claude' but every
    // downstream router sees 'anthropic'.
    expect(hint!.targets[0]!.provider).toBe('anthropic');
    expect(hint!.targets[0]!.model).toBeUndefined();
    expect(hint!.targets[1]!.model).toBe('gemini-3-pro');
  });

  it('drops malformed targets (missing id or provider)', () => {
    const hint = readMultiLlmHint({
      elanous: {
        multiLlm: {
          targets: [
            { id: 'p1', provider: 'claude' },
            { provider: 'gemini' }, // missing id
            { id: '' }, // empty id
            null,
            'bad',
            { id: 'p2', provider: 'gemini' },
          ],
        },
      },
    });
    expect(hint).not.toBeNull();
    expect(hint!.targets.map((t) => t.id)).toEqual(['p1', 'p2']);
  });

  it('parses historyMode "mixed"', () => {
    const hint = readMultiLlmHint({
      elanous: {
        multiLlm: {
          targets: [{ id: 'p1', provider: 'claude' }],
          historyMode: 'mixed',
        },
      },
    });
    expect(hint?.historyMode).toBe('mixed');
  });

  it('parses historyMode "isolated"', () => {
    const hint = readMultiLlmHint({
      elanous: {
        multiLlm: {
          targets: [{ id: 'p1', provider: 'claude' }],
          historyMode: 'isolated',
        },
      },
    });
    expect(hint?.historyMode).toBe('isolated');
  });

  it('drops invalid historyMode silently (defaults applied later)', () => {
    const hint = readMultiLlmHint({
      elanous: {
        multiLlm: {
          targets: [{ id: 'p1', provider: 'claude' }],
          historyMode: 'banana',
        },
      },
    });
    expect(hint?.historyMode).toBeUndefined();
  });

  // DM stage 2 (#1982 follow-up) — agent kind/backend sniffing.
  it('parses agent kind + backend (DM stage 2)', () => {
    const hint = readMultiLlmHint({
      elanous: {
        multiLlm: {
          targets: [
            { id: 'a1', provider: 'codex', kind: 'agent', backend: 'codex-app-server' },
            { id: 'a2', provider: 'claude', kind: 'agent', backend: 'claude' },
            { id: 'a3', provider: 'gemini', kind: 'agent', backend: 'gemini' },
            { id: 'c1', provider: 'claude' }, // chat (no kind)
          ],
        },
      },
    });
    expect(hint).not.toBeNull();
    expect(hint!.targets).toHaveLength(4);
    expect(hint!.targets[0]!.kind).toBe('agent');
    expect(hint!.targets[0]!.backend).toBe('codex-app-server');
    expect(hint!.targets[3]!.kind).toBeUndefined();
    expect(hint!.targets[3]!.backend).toBeUndefined();
  });

  it('drops agent kind with unknown backend (defensive)', () => {
    const hint = readMultiLlmHint({
      elanous: {
        multiLlm: {
          targets: [
            { id: 'a1', provider: 'codex', kind: 'agent', backend: 'fictional' },
            { id: 'a2', provider: 'claude', kind: 'agent' /* missing backend */ },
          ],
        },
      },
    });
    expect(hint).not.toBeNull();
    // Both targets land but with kind dropped (chat fallback).
    expect(hint!.targets).toHaveLength(2);
    expect(hint!.targets[0]!.kind).toBeUndefined();
    expect(hint!.targets[1]!.kind).toBeUndefined();
  });

  it('returns null when targets is not an array', () => {
    expect(
      readMultiLlmHint({ elanous: { multiLlm: { targets: 'p1' } } }),
    ).toBeNull();
  });
});

describe('bridgeMultiLlmCoreTurnsToAcp · silent skip (DM-1)', () => {
  function makeStubTurnCtx(promptMeta?: Record<string, unknown>): AcpTurnContext & {
    pushed: Array<[string, Readonly<Record<string, unknown>> | undefined]>;
    pushedUpdates: Array<[Readonly<Record<string, unknown>>, Readonly<Record<string, unknown>> | undefined]>;
  } {
    const pushed: Array<[string, Readonly<Record<string, unknown>> | undefined]> = [];
    const pushedUpdates: Array<[Readonly<Record<string, unknown>>, Readonly<Record<string, unknown>> | undefined]> = [];
    return {
      sessionId: 'sess-test',
      cwd: '/tmp',
      codexArgs: [],
      userText: 'hi',
      promptBlocks: [],
      promptMeta,
      isAborted: () => false,
      push: async () => {},
      pushWithMeta: async (chunk, meta) => { pushed.push([chunk, meta]); },
      pushToolCall: async () => {},
      pushToolResult: async () => {},
      pushSessionUpdate: async (update, meta) => { pushedUpdates.push([update, meta]); },
      pushUsage: async () => {},
      requestApproval: async () => 'allow-once',
      pushed,
      pushedUpdates,
    };
  }

  it('returns silently when promptMeta has no multi-LLM hint', async () => {
    const runTurn = bridgeMultiLlmCoreTurnsToAcp({
      getMessages: () => [],
      getTools: () => [],
      dispatchTool: async () => ({ ok: true, content: [] }),
    });
    const ctx = makeStubTurnCtx({ source: 'pwa' });
    await runTurn(ctx);
    expect(ctx.pushed).toEqual([]);
  });

  it('returns silently when promptMeta is undefined', async () => {
    const runTurn = bridgeMultiLlmCoreTurnsToAcp({
      getMessages: () => [],
      getTools: () => [],
      dispatchTool: async () => ({ ok: true, content: [] }),
    });
    const ctx = makeStubTurnCtx(undefined);
    await runTurn(ctx);
    expect(ctx.pushed).toEqual([]);
  });

  it('forwards the current human utterance as userText to each core turn', async () => {
    const calls: CoreTurnContext[] = [];
    const runCoreTurn = spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      calls.push(ctx);
      return { stopReason: 'end_turn', finalText: '' };
    });
    try {
      const runTurn = bridgeMultiLlmCoreTurnsToAcp({
        getMessages: ({ userText }) => [{ role: 'user', content: `seed:${userText}` }],
        getTools: () => [],
        dispatchTool: async () => ({ ok: true, content: [] }),
      });
      const ctx = makeStubTurnCtx({
        elanous: { multiLlm: { targets: [{ id: 'panel-1', provider: 'claude' }] } },
      });
      ctx.userText = 'current human utterance';

      await runTurn(ctx);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.userText).toBe('current human utterance');
    } finally {
      runCoreTurn.mockRestore();
    }
  });
});

// §6.4 — personaId field sniffing in readMultiLlmHint.
describe('readMultiLlmHint · §6.4 personaId sniff', () => {
  it('valid personaId string survives sniff', () => {
    const hint = readMultiLlmHint({
      elanous: {
        multiLlm: {
          targets: [
            { id: 'p1', provider: 'claude', personaId: 'skeptic-claude' },
          ],
        },
      },
    });
    expect(hint).not.toBeNull();
    expect(hint!.targets[0]?.personaId).toBe('skeptic-claude');
  });

  it('omitted personaId leaves field undefined', () => {
    const hint = readMultiLlmHint({
      elanous: { multiLlm: { targets: [{ id: 'p1', provider: 'claude' }] } },
    });
    expect(hint).not.toBeNull();
    expect(hint!.targets[0]?.personaId).toBeUndefined();
  });

  it('non-string personaId rejected (defensive)', () => {
    const hint = readMultiLlmHint({
      elanous: { multiLlm: { targets: [{ id: 'p1', provider: 'claude', personaId: 42 }] } },
    });
    expect(hint).not.toBeNull();
    expect(hint!.targets[0]?.personaId).toBeUndefined();
  });

  it('empty/whitespace personaId rejected (trim → length 0)', () => {
    const hint = readMultiLlmHint({
      elanous: { multiLlm: { targets: [{ id: 'p1', provider: 'claude', personaId: '   ' }] } },
    });
    expect(hint).not.toBeNull();
    expect(hint!.targets[0]?.personaId).toBeUndefined();
  });

  it('overlong personaId rejected (length cap defensive)', () => {
    const long = 'x'.repeat(300);
    const hint = readMultiLlmHint({
      elanous: { multiLlm: { targets: [{ id: 'p1', provider: 'claude', personaId: long }] } },
    });
    expect(hint).not.toBeNull();
    expect(hint!.targets[0]?.personaId).toBeUndefined();
  });

  it('personaId trimmed before storing', () => {
    const hint = readMultiLlmHint({
      elanous: { multiLlm: { targets: [{ id: 'p1', provider: 'claude', personaId: '  alpha  ' }] } },
    });
    expect(hint!.targets[0]?.personaId).toBe('alpha');
  });
});

// DM stage 3 FU (HANDOFF §3.2 · 2026-05-09) — agent CLI sub-process
// SessionUpdate routing. Forwards text + tool_call lifecycle into the
// parent's annotate paths so ShowroomPanel can re-add the activity
// pill + expandable tool list.
describe('routeAgentSessionUpdate (DM stage 3 FU)', () => {
  function makeRecorder(): {
    text: string[];
    tools: Array<Readonly<Record<string, unknown>>>;
    cb: { onText: (s: string) => void; onToolCall: (u: Readonly<Record<string, unknown>>) => void };
  } {
    const text: string[] = [];
    const tools: Array<Readonly<Record<string, unknown>>> = [];
    return {
      text,
      tools,
      cb: { onText: (s) => text.push(s), onToolCall: (u) => tools.push(u) },
    };
  }

  it('forwards agent_message_chunk text via onText', () => {
    const r = makeRecorder();
    routeAgentSessionUpdate(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
      r.cb,
    );
    expect(r.text).toEqual(['hello']);
    expect(r.tools).toEqual([]);
  });

  it('forwards tool_call (initial pending) via onToolCall verbatim', () => {
    const r = makeRecorder();
    const update = {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'read_file',
      rawInput: { path: 'src/foo.ts' },
      status: 'pending',
    };
    routeAgentSessionUpdate(update, r.cb);
    expect(r.tools).toHaveLength(1);
    expect(r.tools[0]).toEqual(update);
    expect(r.text).toEqual([]);
  });

  it('forwards tool_call_update (status flip) via onToolCall verbatim', () => {
    const r = makeRecorder();
    const update = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'completed',
      rawOutput: 'file body…',
    };
    routeAgentSessionUpdate(update, r.cb);
    expect(r.tools).toHaveLength(1);
    expect(r.tools[0]).toEqual(update);
  });

  it('drops agent_message_chunk with empty text (no spurious onText fire)', () => {
    const r = makeRecorder();
    routeAgentSessionUpdate(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } },
      r.cb,
    );
    expect(r.text).toEqual([]);
    expect(r.tools).toEqual([]);
  });

  it('drops agent_message_chunk with non-text content type', () => {
    const r = makeRecorder();
    routeAgentSessionUpdate(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: '…' } },
      r.cb,
    );
    expect(r.text).toEqual([]);
    expect(r.tools).toEqual([]);
  });

  it('drops tool_call without toolCallId (defensive)', () => {
    const r = makeRecorder();
    routeAgentSessionUpdate(
      { sessionUpdate: 'tool_call', title: 'orphan' },
      r.cb,
    );
    expect(r.tools).toEqual([]);
  });

  it('drops tool_call_update without toolCallId (defensive)', () => {
    const r = makeRecorder();
    routeAgentSessionUpdate(
      { sessionUpdate: 'tool_call_update', status: 'completed' },
      r.cb,
    );
    expect(r.tools).toEqual([]);
  });

  it('drops noise variants (agent_thought_chunk, plan, …)', () => {
    const r = makeRecorder();
    routeAgentSessionUpdate(
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
      r.cb,
    );
    routeAgentSessionUpdate({ sessionUpdate: 'plan', steps: [] }, r.cb);
    routeAgentSessionUpdate({ sessionUpdate: 'unknown_kind' }, r.cb);
    expect(r.text).toEqual([]);
    expect(r.tools).toEqual([]);
  });

  it('handles malformed update objects without throwing', () => {
    const r = makeRecorder();
    expect(() => routeAgentSessionUpdate({}, r.cb)).not.toThrow();
    expect(() => routeAgentSessionUpdate(null, r.cb)).not.toThrow();
    expect(() => routeAgentSessionUpdate('not-an-object', r.cb)).not.toThrow();
    expect(r.text).toEqual([]);
    expect(r.tools).toEqual([]);
  });
});

describe('readMultiLlmHint · DM stage 4 lastAssistant sniff', () => {
  it('parses lastAssistant string when present', () => {
    const hint = readMultiLlmHint({
      elanous: {
        multiLlm: {
          historyMode: 'mixed',
          targets: [
            { id: 'p1', provider: 'claude', lastAssistant: 'previous claude reply' },
            { id: 'p2', provider: 'gemini', lastAssistant: 'previous gemini reply' },
          ],
        },
      },
    });
    expect(hint?.targets[0]?.lastAssistant).toBe('previous claude reply');
    expect(hint?.targets[1]?.lastAssistant).toBe('previous gemini reply');
  });
  it('omitted lastAssistant leaves field undefined (first turn)', () => {
    const hint = readMultiLlmHint({
      elanous: {
        multiLlm: {
          historyMode: 'mixed',
          targets: [{ id: 'p1', provider: 'claude' }],
        },
      },
    });
    expect(hint?.targets[0]?.lastAssistant).toBeUndefined();
  });
  it('rejects non-string lastAssistant (defensive)', () => {
    const hint = readMultiLlmHint({
      elanous: {
        multiLlm: {
          targets: [{ id: 'p1', provider: 'claude', lastAssistant: 12345 }],
        },
      },
    });
    expect(hint?.targets[0]?.lastAssistant).toBeUndefined();
  });
  it('rejects empty string lastAssistant (no point in injecting nothing)', () => {
    const hint = readMultiLlmHint({
      elanous: {
        multiLlm: {
          targets: [{ id: 'p1', provider: 'claude', lastAssistant: '' }],
        },
      },
    });
    expect(hint?.targets[0]?.lastAssistant).toBeUndefined();
  });
  it('caps lastAssistant at 32KB (token-bloat protection)', () => {
    const huge = 'x'.repeat(33 * 1024);
    const hint = readMultiLlmHint({
      elanous: {
        multiLlm: {
          targets: [{ id: 'p1', provider: 'claude', lastAssistant: huge }],
        },
      },
    });
    expect(hint?.targets[0]?.lastAssistant).toBeUndefined();
  });
  it('accepts exactly 32KB (boundary)', () => {
    const at32k = 'x'.repeat(32 * 1024);
    const hint = readMultiLlmHint({
      elanous: {
        multiLlm: {
          targets: [{ id: 'p1', provider: 'claude', lastAssistant: at32k }],
        },
      },
    });
    expect(hint?.targets[0]?.lastAssistant?.length).toBe(32 * 1024);
  });
});
