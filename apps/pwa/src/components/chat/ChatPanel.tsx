'use client';

// Single-screen chat panel shared by the standalone page and compact shell.

import { useEffect, useRef, useState } from 'react';
import { ChatLayout } from './ChatLayout';
import { ChatConversationList } from './ChatConversationList';
import { Menu, X } from 'lucide-react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { useCompactMode } from '@/lib/compact-mode';
import { useShellActivity } from '@/components/shell/use-shell-activity';
import { userIntentLogger } from '@/lib/user-intent-logger';

export interface ChatPanelProps {
  /** Only the standalone /chat page shows its conversation navigation. */
  showConversationList?: boolean;
  /** /chat uses the phone-density header in compact mode. */
  mobileSimple?: boolean;
}

export function ChatPanel(props: ChatPanelProps = {}) {
  useEffect(() => {
    if (!props.showConversationList) return;
    void userIntentLogger.emit({
      surface: 'pwa',
      intent: { layer: 'navigation', kind: 'pwa.navigation.chat_opened', target: { kind: 'route', id: '/chat' } },
      surface_state: { route: '/chat' },
    });
  }, [props.showConversationList]);
  const { compact } = useCompactMode();
  const mobileSimple = !!props.mobileSimple && compact;
  const mobileActivity = useShellActivity();
  const sessionId = useDaemon().sessionId;
  const [conversationKey, setConversationKey] = useState(sessionId || 'default');
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => {
    if (!drawerOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [drawerOpen]);
  const adoptedSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (adoptedSessionRef.current === sessionId) {
      adoptedSessionRef.current = null;
      return;
    }
    adoptedSessionRef.current = null;
    setConversationKey(sessionId || 'default');
  }, [sessionId]);

  const conversationButton = (
    <button type="button" onClick={() => setDrawerOpen(true)} aria-label="대화 목록" aria-expanded={drawerOpen} aria-controls="chat-conversation-drawer" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-muted">
      <Menu className="h-4 w-4" aria-hidden="true" />
    </button>
  );
  const chat = (
    <ChatLayout
      // Only a selected session remounts; daemon adoption keeps the live turn.
      key={conversationKey}
      onSessionAdopt={(issued) => { adoptedSessionRef.current = issued; }}
      {...(props.showConversationList && compact && !mobileSimple ? { leading: conversationButton } : {})}
      {...(mobileSimple ? { mobileSimple, mobileActivity, conversationButton } : {})}
    />
  );
  if (!props.showConversationList) return chat;

  return (
    <div className="flex h-full min-h-0 min-w-0">
      <aside className={compact ? 'hidden' : 'hidden h-full w-[260px] shrink-0 border-r border-border md:block'}>
        <ChatConversationList />
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!compact && (
          <div className="shrink-0 border-b border-border bg-background px-3 py-2 md:hidden">
            <button type="button" onClick={() => setDrawerOpen(true)} aria-label="대화 목록" aria-expanded={drawerOpen} aria-controls="chat-conversation-drawer" className="inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium hover:bg-muted">
              <Menu className="h-4 w-4" aria-hidden="true" /> 대화 목록
            </button>
          </div>
        )}
        <div className="min-h-0 min-w-0 flex-1">{chat}</div>
      </div>
      {drawerOpen && (
        <div className={compact ? 'fixed inset-0 z-50' : 'fixed inset-0 z-50 md:hidden'}>
          <button type="button" aria-label="대화 목록 닫기" onClick={() => setDrawerOpen(false)} className="absolute inset-0 bg-black/50" />
          <aside id="chat-conversation-drawer" role="dialog" aria-modal="true" aria-label="대화 목록" className="relative h-full w-[min(260px,85vw)] bg-background shadow-xl">
            <button type="button" aria-label="대화 목록 닫기" onClick={() => setDrawerOpen(false)} className="absolute right-2 top-2 z-10 rounded p-1 hover:bg-muted"><X className="h-4 w-4" /></button>
            <ChatConversationList onSelect={() => setDrawerOpen(false)} />
          </aside>
        </div>
      )}
    </div>
  );
}
