import { describe, expect, test } from 'bun:test';
import { streamLLMWithTools, type LLMProvider, type LLMToolSpec } from '../../llm.js';
import {
  answerNextSidetabCall, createNextSidetabHostHandler, registerNextSidetabReplTool,
  isNextSidetabCall, nextSidetabToolSpec, type NextSidetabCall,
} from './nl-tool.js';

const sampleRows = [
  { id: 'tui:one', label: 'one', kind: 'tui', badge: 'idle' as const, sessionId: 'one' },
  { id: 'pty:shell', label: 'shell · Next TUI', kind: 'shell', badge: 'busy' as const },
];

describe('Next TUI side-tab NL tool', () => {
  test('does not register outside the Next TUI IPC host', () => {
    const specs: LLMToolSpec[] = [];
    const dispatchByName = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    registerNextSidetabReplTool(specs, dispatchByName, {
      send: () => {}, on: () => {},
    }, { ELANOUS_NEXT_TUI_SIDETAB_IPC: '0' });
    expect(specs).toEqual([]);
    expect(dispatchByName.size).toBe(0);
  });

  test('NL-A lists and reuses the host session-switch and attach operations', async () => {
    const calls: string[] = [];
    const handler = createNextSidetabHostHandler({
      rows: () => sampleRows, selected: () => 1,
      switchSession: async (row) => { calls.push(`switch:${row.id}`); return { ok: true }; },
      attach: async (row) => { calls.push(`attach:${row.id}`); return { ok: true }; },
      detach: () => { calls.push('detach'); return { ok: true }; },
      spawn: () => ({ ok: true }), kill: () => ({ ok: true }),
    });
    expect(await handler({ action: 'list' })).toEqual(sampleRows);
    await handler({ action: 'switch', target: 'tui:one' });
    await handler({ action: 'attach', target: 'shell' });
    await handler({ action: 'detach' });
    expect(calls).toEqual(['switch:tui:one', 'attach:pty:shell', 'detach']);
  });

  test('NL-B restricts new sessions to shell/elanous and requires explicit kill confirmation', async () => {
    const killed: string[] = [];
    const handler = createNextSidetabHostHandler({
      rows: () => sampleRows, selected: () => 1,
      switchSession: async () => ({ ok: true }), attach: async () => ({ ok: true }),
      detach: () => ({ ok: true }), spawn: (character) => ({ character }),
      kill: (row) => { killed.push(row.id); return { ok: true }; },
    });
    expect(await handler({ action: 'new', character: 'codex' as never })).toHaveProperty('error');
    expect(await handler({ action: 'takeover' as never, target: 'shell' })).toEqual({ error: '지원하지 않는 사이드탭 동작입니다' });
    expect(await handler({ action: 'new', character: 'elanous' })).toEqual({ character: 'elanous' });
    expect(await handler({ action: 'kill', target: 'pty:shell' })).toMatchObject({ needsConfirmation: true });
    expect(killed).toEqual([]);
    expect(await handler({ action: 'kill', target: 'pty:shell', confirm: true })).toEqual({ ok: true });
    expect(killed).toEqual(['pty:shell']);
  });

  test('NL-B refuses killing the current TUI even with confirmation', async () => {
    let killCalls = 0;
    const handler = createNextSidetabHostHandler({
      rows: () => [{ id: 'tui:current', label: 'current TUI', kind: 'tui', badge: 'busy', currentProcess: true }],
      selected: () => 0,
      switchSession: async () => ({ ok: true }), attach: async () => ({ ok: true }),
      detach: () => ({ ok: true }), spawn: () => ({ ok: true }),
      kill: () => { killCalls += 1; return { ok: true }; },
    });
    expect(await handler({ action: 'kill', target: 'tui:current', confirm: true })).toEqual({
      error: '현재 TUI 세션은 사이드탭에서 종료할 수 없습니다',
    });
    expect(killCalls).toBe(0);
  });

  test('a fake local provider tool-call snapshot crosses IPC and returns the host result', async () => {
    const listeners = new Set<(message: unknown) => void>();
    const host = createNextSidetabHostHandler({
      rows: () => sampleRows, selected: () => 0,
      switchSession: async (row) => ({ switched: row.sessionId }),
      attach: async (row) => ({ attached: row.id }), detach: () => ({ detached: true }),
      spawn: (character) => ({ spawned: character }),
      kill: () => ({ killed: true }),
    });
    const specs: LLMToolSpec[] = [];
    const dispatchByName = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    registerNextSidetabReplTool(specs, dispatchByName, {
      on: (_event, listener) => { listeners.add(listener); },
      send: (message) => {
        if (!isNextSidetabCall(message)) throw new Error('unexpected IPC message');
        void answerNextSidetabCall(host, message).then((reply) => { for (const listener of listeners) listener(reply); });
      },
    }, { ELANOUS_NEXT_TUI_SIDETAB_IPC: '1' });
    const tool = { spec: specs[0]!, dispatch: dispatchByName.get(nextSidetabToolSpec.name)! };
    expect(tool.spec).toEqual(nextSidetabToolSpec);
    const snapshot: NextSidetabCall = {
      type: 'elanous.sidetab.call', callId: 'snapshot-1',
      request: { action: 'switch', target: 'tui:one' },
    };
    let turn = 0;
    let sawToolSchema = false;
    const provider: LLMProvider = {
      name: 'local-test', defaultModel: 'local-test', available: () => true,
      async *chat() { yield 'unused'; },
      async *streamChat(_messages, options) {
        sawToolSchema ||= (options?.tools ?? []).some(({ name }) => name === nextSidetabToolSpec.name);
        if (turn++ === 0) yield { type: 'tool_call', id: 'provider-call-1', name: nextSidetabToolSpec.name, args: snapshot.request };
        else yield { type: 'text', delta: 'switched' };
      },
    };
    const results: unknown[] = [];
    const answer = await streamLLMWithTools([{ role: 'user', content: 'switch to one' }], {
      onText: () => {}, onToolResult: (call) => results.push(call.result),
      dispatchTool: (name, args) => name === tool.spec.name ? tool.dispatch(args) : Promise.resolve({ error: 'unknown' }),
    }, { provider, tools: [tool.spec], maxTurns: 2 });
    expect(sawToolSchema).toBe(true);
    expect(answer).toBe('switched');
    expect(results).toEqual([{ switched: 'one' }]);
  });
});
