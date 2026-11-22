/** Turn-local scheduling signal. The text stays in pending-input; listeners receive no body. */
const listeners = new Map<string, Set<() => void>>();
const versions = new Map<string, number>();

export function urgentSteerVersion(sessionId: string): number { return versions.get(sessionId) ?? 0; }

export function onUrgentSteer(sessionId: string, listener: () => void): () => void {
  const group = listeners.get(sessionId) ?? new Set<() => void>();
  group.add(listener);
  listeners.set(sessionId, group);
  return () => {
    group.delete(listener);
    if (group.size === 0) listeners.delete(sessionId);
  };
}

export function signalUrgentSteer(sessionId: string): void {
  versions.set(sessionId, (versions.get(sessionId) ?? 0) + 1);
  for (const listener of [...(listeners.get(sessionId) ?? [])]) listener();
}
