// ACP session ownership only. The caller must authorize pane creation and input at the control door.
import type { ContentBlock, SessionUpdate, StopReason } from '@agentclientprotocol/sdk';

export interface AcpPanePeer {
  start(): Promise<void>;
  newSession(): Promise<string>;
  prompt(session: string, blocks: ContentBlock[], update: (value: SessionUpdate) => void): Promise<{ stopReason: StopReason }>;
  stop(): Promise<void>;
}

export function createAcpPaneSessions(createPeer: (pane: string) => AcpPanePeer) {
  const panes = new Map<string, { ready: Promise<{ peer: AcpPanePeer; session: string }>; closing?: Promise<void>; closeFailed?: boolean; state: { peer: AcpPanePeer; needsCleanupRetry: boolean } }>();
  return {
    async open(pane: string): Promise<void> {
      if (panes.has(pane)) throw new Error('pane already open');
      const peer = createPeer(pane);
      const state = { peer, needsCleanupRetry: false };
      const ready = (async () => {
        try {
          await peer.start();
          return { peer, session: await peer.newSession() };
        } catch (error) {
          try { await peer.stop(); } catch { state.needsCleanupRetry = true; }
          throw error;
        }
      })();
      const entry = { ready, closing: undefined as Promise<void> | undefined, closeFailed: false, state };
      panes.set(pane, entry);
      try { await ready; } catch (error) {
        if (panes.get(pane) === entry) {
          if (state.needsCleanupRetry) entry.closeFailed = true;
          else if (!entry.closing) panes.delete(pane);
        }
        throw error;
      }
    },
    async prompt(pane: string, text: string, update: (value: SessionUpdate) => void) {
      const entry = panes.get(pane);
      if (!entry || entry.closing || entry.closeFailed) throw new Error('pane is not open');
      const { peer, session } = await entry.ready;
      if (entry.closing || entry.closeFailed) throw new Error('pane is not open');
      return peer.prompt(session, [{ type: 'text', text }], value => {
        if (!entry.closing && !entry.closeFailed && panes.get(pane) === entry) update(value);
      });
    },
    async close(pane: string): Promise<void> {
      const entry = panes.get(pane);
      if (!entry) return;
      if (!entry.closing) {
        entry.closing = (async () => {
          const opened = await entry.ready.catch(() => null);
          if (opened) await opened.peer.stop();
          else if (entry.state.needsCleanupRetry) { await entry.state.peer.stop(); entry.state.needsCleanupRetry = false; }
          if (panes.get(pane) === entry) panes.delete(pane);
        })();
      }
      try { await entry.closing; } catch (error) {
        entry.closeFailed = true;
        entry.closing = undefined;
        throw error;
      }
    },
  };
}
