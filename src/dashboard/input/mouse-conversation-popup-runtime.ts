import type { ConversationPopupHost } from '../../conv-dash/popup-host.js';
import type { DashboardMouseWiringDeps } from './mouse-wiring-types.js';

export interface MouseConversationPopupRuntimeDeps {
  conversationPopupHost: Pick<
    ConversationPopupHost,
    'snapshot' | 'restore' | 'focus' | 'remove'
  >;
  ensureConversationWidgetMounted: (sessionId: string) => Promise<boolean>;
  syncConversationPopupModals: () => void;
  redraw: () => void;
}

export interface MouseConversationPopupRuntime
  extends Pick<DashboardMouseWiringDeps, 'onConversationPopupPick'> {}

export function createMouseConversationPopupRuntime(
  deps: MouseConversationPopupRuntimeDeps,
): MouseConversationPopupRuntime {
  return {
    onConversationPopupPick: async (sessionId) => {
      const snapshot = deps.conversationPopupHost.snapshot();
      if (snapshot.minimized.some((entry) => entry.sessionId === sessionId)) {
        deps.conversationPopupHost.restore(sessionId);
      } else {
        deps.conversationPopupHost.focus(sessionId);
      }
      const mounted = await deps.ensureConversationWidgetMounted(sessionId);
      if (!mounted) {
        deps.conversationPopupHost.remove(sessionId);
      }
      deps.syncConversationPopupModals();
      deps.redraw();
    },
  };
}
