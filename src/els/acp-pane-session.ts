// ACP session ownership only. The caller must authorize pane creation and input at the control door.
import type { ContentBlock, SessionUpdate, StopReason } from '@agentclientprotocol/sdk';

export interface AcpPanePeer {
  start(): Promise<void>;
  newSession(): Promise<string>;
  prompt(session: string, blocks: ContentBlock[], update: (value: SessionUpdate) => void): Promise<{ stopReason: StopReason }>;
  stop(): Promise<void>;
}

export function createAcpPaneSessions(createPeer: (pane: string) => AcpPanePeer) {
  const panes = new Map<string, { ready: Promise<{ peer: AcpPanePeer; session: string }>; closing?: Promise<void> }>();
  return {
    async open(pane: string): Promise<void> {
      if (panes.has(pane)) throw new Error('pane already open');
      const peer = createPeer(pane);
      const ready = (async () => {
        try {
          await peer.start();
          return { peer, session: await peer.newSession() };
        } catch (error) {
          await peer.stop().catch(() => {});
          throw error;
        }
      })();
      const entry = { ready, closing: undefined as Promise<void> | undefined };
      panes.set(pane, entry);
      try { await ready; } catch (error) {
        if (panes.get(pane) === entry && !entry.closing) panes.delete(pane);
        throw error;
      }
    },
    async prompt(pane: string, text: string, update: (value: SessionUpdate) => void) {
      const entry = panes.get(pane);
      if (!entry || entry.closing) throw new Error('pane is not open');
      const { peer, session } = await entry.ready;
      if (entry.closing) throw new Error('pane is not open');
      return peer.prompt(session, [{ type: 'text', text }], value => {
        if (!entry.closing && panes.get(pane) === entry) update(value);
      });
    },
    async close(pane: string): Promise<void> {
      const entry = panes.get(pane);
      if (!entry) return;
      if (!entry.closing) {
        entry.closing = (async () => {
          try {
            const opened = await entry.ready.catch(() => null);
            if (opened) await opened.peer.stop();
          } finally {
            if (panes.get(pane) === entry) panes.delete(pane);
          }
        })();
      }
      await entry.closing;
    },
  };
}
