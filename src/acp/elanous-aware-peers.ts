import type { ClientCapabilities } from '@agentclientprotocol/sdk';

/** The server's sessionPeers registry remains the source of truth for which
 * connections are attached to a session. Awareness belongs to the connection,
 * not the session: a plain client can load an aware client's session. */
export class ElanousAwarePeers<Peer extends object> {
  private readonly aware = new WeakSet<Peer>();

  constructor(private readonly sessionPeers: ReadonlyMap<string, ReadonlySet<Peer>>) {}

  markPeer(connectionOrSessionId: Peer, clientCapabilities: ClientCapabilities | undefined | null): void {
    const elanous = (clientCapabilities?._meta as Record<string, unknown> | undefined)?.elanous;
    if (elanous !== null && typeof elanous === 'object' && !Array.isArray(elanous)) {
      this.aware.add(connectionOrSessionId);
    } else {
      this.aware.delete(connectionOrSessionId);
    }
  }

  isPeerAware(peer: Peer): boolean {
    return this.aware.has(peer);
  }

  isElanousAware(sessionId: string): boolean {
    for (const peer of this.sessionPeers.get(sessionId) ?? []) {
      if (this.isPeerAware(peer)) return true;
    }
    return false;
  }
}
