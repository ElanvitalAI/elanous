/** In-process prompt streams that must stop before a member session is removed. */
const activeTurns = new Map<string, Set<AbortController>>();

export function registerActiveChatTurn(sessionId: string, controller: AbortController): () => void {
  let turns = activeTurns.get(sessionId);
  if (!turns) {
    turns = new Set();
    activeTurns.set(sessionId, turns);
  }
  turns.add(controller);
  return () => {
    const current = activeTurns.get(sessionId);
    current?.delete(controller);
    if (current?.size === 0) activeTurns.delete(sessionId);
  };
}

export function abortActiveChatTurns(sessionId: string): void {
  const turns = activeTurns.get(sessionId);
  if (!turns) return;
  activeTurns.delete(sessionId);
  for (const controller of turns) controller.abort();
}
