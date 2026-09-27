'use client';

// ChatRoutingCard — dogfood polish (2026-05-14 EoD #8).
//
// Automatic routing preference (default OFF).
//
// Source of truth: localStorage via `chat-routing-storage`. Subscribes
// on mount so flips from another tab take effect without a refresh.

import { useEffect, useState } from 'react';

import {
  DEFAULT_CHAT_ROUTING,
  getChatRouting,
  setAutoRouting,
  subscribeChatRouting,
  type ChatRoutingState,
} from '@/lib/chat-routing-storage';

export function ChatRoutingCard() {
  const [state, setState] = useState<ChatRoutingState>(DEFAULT_CHAT_ROUTING);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    setState(getChatRouting());
    return subscribeChatRouting(setState);
  }, []);

  const toggleAuto = (next: boolean): void => {
    setAutoRouting(next);
    setState((s) => ({ ...s, autoRouting: next }));
  };

  return (
    <section
      data-testid="chat-routing-settings"
      className="rounded-lg border bg-card p-4 shadow-sm"
    >
      <header className="space-y-1">
        <h2 className="text-sm font-medium">Chat input classification</h2>
        <p className="text-xs text-muted-foreground">
          입력 중 자동 분류를 켜거나 끕니다. 전송은 기존 ACP 경로를 유지합니다.
        </p>
      </header>
      <div className="mt-3 space-y-2">
        <label
          data-testid="chat-routing-auto"
          className="flex cursor-pointer items-start gap-3 rounded-md border border-border/60 p-3 hover:border-border"
          data-active={mounted && state.autoRouting ? 'true' : 'false'}
        >
          <input
            type="checkbox"
            checked={mounted ? state.autoRouting : DEFAULT_CHAT_ROUTING.autoRouting}
            onChange={(e) => toggleAuto(e.target.checked)}
            className="mt-0.5 h-4 w-4"
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">Automatic routing</span>
            <span className="text-xs text-muted-foreground">
              입력 중 mission router 가 plan / build / review / research / quick / vision 으로 자동 분류합니다. OFF (default) 시 분류 요청을 보내지 않습니다.
            </span>
          </span>
        </label>
      </div>
    </section>
  );
}
