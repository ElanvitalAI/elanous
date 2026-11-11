import type { MessageBlock } from '../../conv-substrate/message-block.js';

export interface MessageBlockSessionState {
  blocks: MessageBlock[];
  levels: Map<string, 0 | 1 | 2 | 3>;
  rawTexts: Map<string, string>;
  afterMessageIndexes: Map<string, number>;
}

/** Keep every event in the session transcript; long sessions must not lose old detail refs. */
export function upsertMessageBlock(
  state: MessageBlockSessionState,
  block: MessageBlock,
  afterMessageIndex: number,
): void {
  const index = state.blocks.findIndex((candidate) => candidate.id === block.id);
  if (index >= 0) state.blocks[index] = block;
  else state.blocks.push(block);
  if (!state.afterMessageIndexes.has(block.id)) state.afterMessageIndexes.set(block.id, afterMessageIndex);
}

/** Ephemeral MessageBlock presentation state, isolated by persisted chat session id. */
export function createMessageBlockSessionStore() {
  const sessions = new Map<string, MessageBlockSessionState>();
  const clone = (state: MessageBlockSessionState): MessageBlockSessionState => ({
    blocks: [...state.blocks], levels: new Map(state.levels), rawTexts: new Map(state.rawTexts),
    afterMessageIndexes: new Map(state.afterMessageIndexes),
  });
  return {
    save(sessionId: string, state: MessageBlockSessionState): void { sessions.set(sessionId, clone(state)); },
    restore(sessionId: string): MessageBlockSessionState { return clone(sessions.get(sessionId) ?? { blocks: [], levels: new Map(), rawTexts: new Map(), afterMessageIndexes: new Map() }); },
  };
}
