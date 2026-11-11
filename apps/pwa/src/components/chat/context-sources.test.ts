import { expect, test } from 'bun:test';
import { contextSources } from './context-sources';
import { runChatTurnObserver, runChatTurnStreaming, type ChatBlock } from '../../lib/chat-runtime';
import type { DaemonClient, PromptStreamHandlers } from '../../lib/daemon-client';

const now = Date.parse('2026-10-03T05:30:00Z');
const fiveMinutesAgo = new Date(now - 5 * 60_000).toISOString();
const thirtySecondsAgo = new Date(now - 30_000).toISOString();
const raw = {
  at: new Date(now).toISOString(), topic: null, guide: [],
  facts: [
    { kind: 'version', version: '0.2.12', source: 'elanous://release/0.2.12/checklist' },
    { kind: 'decision', id: 'D-1', title: '결정', status: 'open', dueAt: null, source: 'elanous://decisions/D-1' },
    { kind: 'cell', version: '0.2.12', id: 'CTX2p', title: '맥락 출처', status: 'yellow', owner: 'UX', source: 'elanous://release/0.2.12/checklist#CTX2p' },
    { kind: 'seat', seat: 'TC', at: fiveMinutesAgo, status: 'now', id: 'CTX2p', title: '출처 카드 구현', source: 'elanous://seat-loop/TC/2026-10-03#3' },
  ],
  events: [{ at: thirtySecondsAgo, kind: 'update', summary: '카드 준비', source: 'elanous://context/event/e1' }],
};

const expected = [
  { label: 'CTO 자리 루프 · 출처 카드 구현', ago: '5분 전', source: 'elanous://seat-loop/TC/2026-10-03#3' },
  { label: '조율 채널 · 카드 준비', ago: '방금', source: 'elanous://context/event/e1' },
  { label: '0.2.12 체크리스트 CTX2p', ago: null, source: 'elanous://release/0.2.12/checklist#CTX2p' },
  { label: '결정 대기 D-1', ago: null, source: 'elanous://decisions/D-1' },
];

test('seat → event → cell → decision, public labels and shared age buckets', () => {
  expect(contextSources(raw, now)).toEqual(expected);
  expect(contextSources({ ...raw, facts: [
    ...raw.facts.filter((row) => row.kind !== 'seat'),
    ...(['OP', 'MK', 'UX'] as const).map((seat) => ({ kind: 'seat', seat, at: fiveMinutesAgo, status: 'now', id: null, title: null, source: `elanous://seat-loop/${seat}/2026-10-03#1` })),
  ] }, now)?.slice(0, 3).map((row) => row.label)).toEqual(['COO 자리 루프', 'CMO 자리 루프', 'CXO 자리 루프']);
});

test('sorts dated rows newest first within their group and caps over seven candidates at six', () => {
  const result = contextSources({ ...raw, facts: [
    ...raw.facts,
    { ...raw.facts[3], at: thirtySecondsAgo, title: '새 자리', source: 'elanous://seat-loop/TC/2026-10-03#4' },
    ...Array.from({ length: 5 }, (_, index) => ({ ...raw.facts[2], id: `CTX-${index}`, source: `elanous://release/0.2.12/checklist#CTX-${index}` })),
  ] }, now);
  expect(result).toHaveLength(6);
  expect(result?.slice(0, 2).map((row) => row.label)).toEqual(['CTO 자리 루프 · 새 자리', 'CTO 자리 루프 · 출처 카드 구현']);
});

test('only open decisions are labelled pending; closed decisions do not appear as sources', () => {
  const result = contextSources({ ...raw, facts: [
    ...raw.facts,
    { kind: 'decision', id: 'D-closed', title: '완료', status: 'closed', dueAt: null, source: 'elanous://decisions/D-closed' },
  ] }, now);
  expect(result).toEqual(expected);
  expect(contextSources({ ...raw, facts: [
    { kind: 'decision', id: 'D-closed', title: '완료', status: 'closed', dueAt: null, source: 'elanous://decisions/D-closed' },
  ], events: [] }, now)).toEqual([]);
});

test('truncates public text to 30 characters and masks private text before display', () => {
  const result = contextSources({ ...raw, facts: [{ ...raw.facts[3], title: `/home/ubuntu/private ${'가'.repeat(34)}` }], events: [] }, now);
  expect(result?.[0]?.label).toBe(`CTO 자리 루프 · ${'가'.repeat(30)}`);
  expect(result?.[0]?.label).not.toContain('/home/ubuntu');
});

test('private paths and non-elanous URIs never reach the provenance title', () => {
  const result = contextSources({ ...raw,
    facts: [
      { ...raw.facts[3], source: '/home/ubuntu/private' },
      { ...raw.facts[2], source: 'https://example.com/private' },
      { ...raw.facts[1], source: 'elanous://decisions/%2Fhome%2Fubuntu%2Fprivate' },
    ],
    events: [{ ...raw.events[0], source: 'elanous://context/event/../../private' }],
  }, now);
  expect(result).toEqual([]);
  expect(JSON.stringify(result)).not.toContain('/home/ubuntu/private');
});

test('a safe source remains visible beside an unsafe source', () => {
  const result = contextSources({ ...raw, facts: [
    { ...raw.facts[3], source: '/home/ubuntu/private' },
    raw.facts[2],
  ], events: [] }, now);
  expect(result).toEqual([expected[2]]);
});

test('non-ContextNowAnswer and malformed rows are null; valid empty result is []', () => {
  expect(contextSources(undefined, now)).toBeNull();
  expect(contextSources({ ...raw, facts: 'not facts' }, now)).toBeNull();
  expect(contextSources({ ...raw, events: [{ kind: 'update' }] }, now)).toBeNull();
  expect(contextSources({ ...raw, facts: [{ ...raw.facts[3], source: null }] }, now)).toBeNull();
  expect(contextSources({ ...raw, facts: [], events: [] }, now)).toEqual([]);
});

const contextTool = { id: 'c1', name: 'context_now', ok: true, summary: '현황', rawOutput: raw };
const ordinaryTool = { ...contextTool, name: 'Read' };

test('streaming result carries sources only for valid context_now, including orphan result', async () => {
  for (const tool of [contextTool, ordinaryTool, { ...contextTool, rawOutput: { resultOmittedReason: 'too_large' } }]) {
    const client = {
      promptStream: async (_request: unknown, handlers: PromptStreamHandlers) => {
        handlers.onToolCall?.({ id: 'c1', name: tool.name, args: {} });
        handlers.onToolResult?.(tool);
        return { sessionId: 's', text: '', stopReason: 'end_turn' };
      },
    } as unknown as DaemonClient;
    const result = await runChatTurnStreaming('맥락', { client, sessionId: 's', provider: 'test', setSessionId: () => {} });
    const block = result.message.blocks?.find((row) => row.kind === 'tool_use') as Extract<ChatBlock, { kind: 'tool_use' }>;
    if (tool.name === 'context_now' && tool.rawOutput === raw) {
      expect(block.sources?.map((source) => source.label)).toEqual(expected.map((source) => source.label));
    } else {
      expect(block.sources).toBeUndefined();
      expect(Object.hasOwn(block, 'sources')).toBe(false);
      if (tool.name === 'Read') expect(block).toEqual({
        kind: 'tool_use', id: 'c1', name: 'Read', status: 'done', args: {}, summary: '현황',
        startedAt: expect.any(Number), endedAt: expect.any(Number),
      });
    }
  }
  const client = { promptStream: async (_request: unknown, handlers: PromptStreamHandlers) => {
    handlers.onToolResult?.(contextTool);
    return { sessionId: 's', text: '', stopReason: 'end_turn' };
  } } as unknown as DaemonClient;
  const result = await runChatTurnStreaming('맥락', { client, sessionId: 's', provider: 'test', setSessionId: () => {} });
  expect((result.message.blocks?.[0] as Extract<ChatBlock, { kind: 'tool_use' }>).sources).toHaveLength(4);
});

test('streaming same-ID context_now retransmission removes stale sources when result is invalid', async () => {
  const client = {
    promptStream: async (_request: unknown, handlers: PromptStreamHandlers) => {
      handlers.onToolCall?.({ id: 'c1', name: 'context_now', args: {} });
      handlers.onToolResult?.(contextTool);
      handlers.onToolResult?.({ ...contextTool, rawOutput: { resultOmittedReason: 'too_large' } });
      handlers.onToolResult?.(contextTool);
      handlers.onToolResult?.(ordinaryTool);
      return { sessionId: 's', text: '', stopReason: 'end_turn' };
    },
  } as unknown as DaemonClient;
  const snapshots: ChatBlock[][] = [];
  const result = await runChatTurnStreaming('맥락', { client, sessionId: 's', provider: 'test', setSessionId: () => {} }, {
    onPartialBlocks: (blocks) => { snapshots.push(blocks); },
  });
  expect((snapshots[1]?.[0] as Extract<ChatBlock, { kind: 'tool_use' }>).sources).toHaveLength(4);
  expect(Object.hasOwn(snapshots[2]![0]!, 'sources')).toBe(false);
  expect((snapshots[3]![0] as Extract<ChatBlock, { kind: 'tool_use' }>).sources).toHaveLength(4);
  expect(Object.hasOwn(snapshots[4]![0]!, 'sources')).toBe(false);
  expect(result.message.blocks![0]).toEqual({
    kind: 'tool_use', id: 'c1', name: 'context_now', status: 'done', args: {}, summary: '현황',
    startedAt: expect.any(Number), endedAt: expect.any(Number),
  });
});

test('observer result carries sources for context_now only, including orphan result', () => {
  type Events = NonNullable<Parameters<DaemonClient['subscribeChatEvents']>[1]>;
  let events!: Events;
  const client = { subscribeChatEvents: (_session: string, hooks: Events) => { events = hooks; return () => {}; } } as unknown as DaemonClient;
  let blocks: ChatBlock[] = [];
  runChatTurnObserver(client, 's', {
    onPlaceholder: () => 'p', onPartialBlocks: (_id, value) => { blocks = value; }, onFinalize: () => {},
  });
  events.onTurnBegin?.({ sessionId: 's' });
  events.onToolCall?.({ id: 'c1', name: 'context_now', args: {} });
  events.onToolResult?.(contextTool);
  expect((blocks[0] as Extract<ChatBlock, { kind: 'tool_use' }>).sources).toHaveLength(4);
  events.onToolResult?.({ ...ordinaryTool, id: 'orphan' });
  expect(Object.hasOwn(blocks[1]!, 'sources')).toBe(false);
  expect(blocks[1]).toEqual({
    kind: 'tool_use', id: 'orphan', name: 'Read', status: 'done', summary: '현황',
    startedAt: expect.any(Number), endedAt: expect.any(Number),
  });
  events.onToolResult?.({ ...contextTool, id: 'orphan-context' });
  expect((blocks[2] as Extract<ChatBlock, { kind: 'tool_use' }>).sources).toHaveLength(4);
  events.onToolResult?.({ ...contextTool, id: 'omitted', rawOutput: undefined });
  expect(Object.hasOwn(blocks[3]!, 'sources')).toBe(false);
});

test('observer same-ID context_now retransmission removes stale sources when result is invalid', () => {
  type Events = NonNullable<Parameters<DaemonClient['subscribeChatEvents']>[1]>;
  let events!: Events;
  const client = { subscribeChatEvents: (_session: string, hooks: Events) => { events = hooks; return () => {}; } } as unknown as DaemonClient;
  const snapshots: ChatBlock[][] = [];
  runChatTurnObserver(client, 's', {
    onPlaceholder: () => 'p', onPartialBlocks: (_id, value) => { snapshots.push(value); }, onFinalize: () => {},
  });
  events.onTurnBegin?.({ sessionId: 's' });
  events.onToolCall?.({ id: 'c1', name: 'context_now', args: {} });
  events.onToolResult?.(contextTool);
  events.onToolResult?.({ ...contextTool, rawOutput: undefined });
  events.onToolResult?.(contextTool);
  events.onToolResult?.(ordinaryTool);
  expect((snapshots[1]?.[0] as Extract<ChatBlock, { kind: 'tool_use' }>).sources).toHaveLength(4);
  expect(Object.hasOwn(snapshots[2]![0]!, 'sources')).toBe(false);
  expect((snapshots[3]![0] as Extract<ChatBlock, { kind: 'tool_use' }>).sources).toHaveLength(4);
  expect(Object.hasOwn(snapshots[4]![0]!, 'sources')).toBe(false);
  expect(snapshots[4]![0]).toEqual({
    kind: 'tool_use', id: 'c1', name: 'context_now', status: 'done', args: {}, summary: '현황',
    startedAt: expect.any(Number), endedAt: expect.any(Number),
  });
});
