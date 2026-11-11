import { expect, test } from 'bun:test';
import { createMessageBlockSessionStore, type MessageBlockSessionState, upsertMessageBlock } from './message-block-session.js';

test('MessageBlock presentation and L3 cache stay isolated when TUI sessions switch', () => {
  const store = createMessageBlockSessionStore();
  const first: MessageBlockSessionState = { blocks: [], levels: new Map(), rawTexts: new Map(), afterMessageIndexes: new Map() };
  first.blocks.push({ id: 'a:tool:call', ts: 1, source: 'tool', body: { kind: 'tool-call', toolCallId: 'call', title: 'Read' } });
  first.levels.set('a:tool:call', 3);
  first.rawTexts.set('a:tool:call', 'session A raw');
  first.afterMessageIndexes.set('a:tool:call', 4);
  store.save('session-a', first);

  const second = store.restore('session-b');
  expect(second).toEqual({ blocks: [], levels: new Map(), rawTexts: new Map(), afterMessageIndexes: new Map() });
  second.blocks.push({ id: 'b:tool:call', ts: 2, source: 'tool', body: { kind: 'tool-call', toolCallId: 'call', title: 'Read' } });
  store.save('session-b', second);

  const restored = store.restore('session-a');
  expect(restored.blocks.map((block) => block.id)).toEqual(['a:tool:call']);
  expect(restored.levels.get('a:tool:call')).toBe(3);
  expect(restored.rawTexts.get('a:tool:call')).toBe('session A raw');
  expect(restored.afterMessageIndexes.get('a:tool:call')).toBe(4);
});

test('long sessions retain every MessageBlock and its detail state past 120 events', () => {
  const state: MessageBlockSessionState = { blocks: [], levels: new Map(), rawTexts: new Map(), afterMessageIndexes: new Map() };
  for (let index = 0; index < 125; index++) {
    const id = `event-${index}`;
    upsertMessageBlock(state, { id, ts: index, source: 'agent', body: { kind: 'thought', text: id } }, 7);
    state.levels.set(id, 2);
    state.rawTexts.set(id, `raw-${id}`);
  }
  expect(state.blocks).toHaveLength(125);
  expect(state.blocks[0]?.id).toBe('event-0');
  expect(state.levels.get('event-0')).toBe(2);
  expect(state.rawTexts.get('event-0')).toBe('raw-event-0');
  expect(state.afterMessageIndexes.get('event-0')).toBe(7);
});
