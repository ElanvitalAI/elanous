import type { EmbodiedAgentSession } from './embodiment.js';

/** Session lookup shape retained for showroom, voice and capture consumers. */
interface LiveSessionEntry {
  readonly session: EmbodiedAgentSession;
  readonly paneId: string;
  readonly windowId: number;
  readonly ptyId: string;
}

const _liveSessions = new Map<string, LiveSessionEntry>();

export function listLiveEmbodiedSessions(): readonly LiveSessionEntry[] {
  return [..._liveSessions.values()];
}

export function findLiveSessionById(id: string): LiveSessionEntry | undefined {
  return _liveSessions.get(id);
}

export function findLiveSessionByPaneId(paneId: string): LiveSessionEntry | undefined {
  for (const entry of _liveSessions.values()) {
    if (entry.paneId === paneId) return entry;
  }
  return undefined;
}
