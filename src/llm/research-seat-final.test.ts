import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamLLMWithTools, type LLMMessage, type LLMProvider } from '../llm.js';
import { MsgStore } from '../msg/msg-store.js';
import { dispatchMsgPost } from '../skills/tools/ops-ledger.js';
import { deliverFinalResearchMail } from './research-seat-final.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const tool = (name: string) => ({ name, description: name, parameters: { type: 'object', properties: {} } });

test('after the research budget a seat can send one reply and no research tools are offered', async () => {
  const root = mkdtempSync(join(tmpdir(), 'research-final-mail-')); roots.push(root);
  const db = join(root, 'messages.db');
  const initial = new MsgStore(db); const request = initial.post({ from: 'MK', to: 'SIMSEAT', body: 'Research this' }); initial.close();
  let ordinaryCalls = 0, finalCalls = 0;
  const offered: string[][] = [];
  const provider: LLMProvider = { name: 'fake-research-provider', defaultModel: 'gemini-3-pro', available: () => true,
    async *chat() { yield 'Research is complete and the requesting seat received the results by mail.'; },
    async *streamChat(_messages, opts) {
      const names = (opts?.tools ?? []).map(t => t.name); offered.push(names);
      if (names.includes('WebSearch')) {
        ordinaryCalls++; yield { type: 'tool_call', id: `s${ordinaryCalls}`, name: 'WebSearch', args: { query: `topic-${ordinaryCalls}` } }; return;
      }
      finalCalls++; yield { type: 'tool_call', id: 'reply', name: 'MsgPost', args: { from: 'SIMSEAT', to: 'MK', body: 'Results', replyTo: request.id } };
    },
  };
  const sent: string[] = [];
  await streamLLMWithTools([{ role: 'user', content: 'Research and reply to MK.' }], {
    onText() {},
    async dispatchTool(name, args) {
      sent.push(name);
      return name === 'MsgPost' ? dispatchMsgPost(args, { openStore: () => new MsgStore(db) }) : { output: 'Research result' };
    },
  }, { provider, model: 'gemini-3-pro', researchTurn: true, maxTurns: 20, tools: [tool('WebSearch'), tool('MsgPost'), tool('MsgAck')] });
  const store = new MsgStore(db);
  try {
    const replies = store.list('MK');
    expect(ordinaryCalls).toBe(20); expect(finalCalls).toBe(1);
    expect(offered.at(-1)).toEqual(['MsgPost', 'MsgAck']);
    expect(sent.filter(name => name === 'MsgPost')).toHaveLength(1);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ from: 'SIMSEAT', to: 'MK', replyTo: request.id, body: 'Results' });
  } finally { store.close(); }
});

test('final round refuses unknown tools, duplicate mail actions and calls when no mail tools are available', async () => {
  const dispatched: string[] = [];
  let calls = 0;
  const provider: LLMProvider = { name: 'fake', defaultModel: 'fake', available: () => true, async *chat() {},
    async *streamChat() { calls++; yield { type: 'tool_call', id: 'bad', name: 'Bash', args: {} }; yield { type: 'tool_call', id: 'a', name: 'MsgPost', args: {}, providerMeta: { thoughtSignature: 'signature' } }; yield { type: 'tool_call', id: 'b', name: 'MsgPost', args: {} }; },
  };
  const history: LLMMessage[] = [];
  const handlers = { onText() {}, async dispatchTool(name: string) { dispatched.push(name); return 'ok'; } };
  await deliverFinalResearchMail({ provider, model: 'fake', history, tools: [tool('MsgPost')], handlers, turn: 20 });
  expect(dispatched).toEqual(['MsgPost']); expect(history).toHaveLength(3);
  expect(JSON.stringify(history)).toContain('signature');
  await deliverFinalResearchMail({ provider, model: 'fake', history: [], tools: [tool('WebSearch')], handlers, turn: 20 });
  expect(calls).toBe(1);
});

test('seat mail can be delivered in the ordinary research loop before the budget', async () => {
  let calls = 0;
  const dispatched: string[] = [];
  const provider: LLMProvider = { name: 'fake', defaultModel: 'gemini-3-pro', available: () => true, async *chat() {},
    async *streamChat() { calls++; if (calls === 1) yield { type: 'tool_call', id: 'early', name: 'MsgPost', args: { from: 'SIMSEAT', to: 'MK', body: 'Done' } }; else yield { type: 'text', delta: 'Replied.' }; },
  };
  await streamLLMWithTools([{ role: 'user', content: 'Research and reply.' }], {
    onText() {}, async dispatchTool(name) { dispatched.push(name); return { ok: true }; },
  }, { provider, model: 'gemini-3-pro', researchTurn: true, maxTurns: 20, tools: [tool('WebSearch'), tool('MsgPost'), tool('MsgAck')] });
  expect(calls).toBe(2); expect(dispatched).toEqual(['MsgPost']);
});
