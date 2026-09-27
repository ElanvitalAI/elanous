'use client';

// PR #2 / PR #4.5 — page-agnostic chat panel.
//
// 워크스페이스 (PR #3) 가 N 개의 ChatPanel 을 mount 하고 display:none
// 토글로 활성/비활성을 가른다. workspace 안일 때 SessionPill 의
// "다른 세션 attach" / "이 세션 잊기" dropdown 이 SessionPicker 를
// 연다 (props.tabId 가 attachToTab mode 의 target).

import { useEffect, useRef, useState } from 'react';
import { ChatLayout } from './ChatLayout';
import { useWorkspaceOptional } from '@/components/workspace/WorkspaceProvider';
import { getSessionsService } from '@/lib/sessions-service';
import { resolveChatSessionSync } from '@/lib/workspace/session-sync';
import { useDaemon } from '@/components/providers/DaemonProvider';

export interface ChatPanelProps {
  /** workspace 탭이 명시 attach 한 세션. 미지정 시 DaemonProvider 의
   *  default sessionId 를 그대로 쓴다 (single-tab `/chat` 동작 보존). */
  sessionId?: string;
  /** workspace tab id — SessionPill 의 attach 모달이 attachToTab 모드로
   *  들어갈 때 target. */
  tabId?: string;
}

export function ChatPanel(props: ChatPanelProps = {}) {
  const ws = useWorkspaceOptional();
  const { client, sessionId, setSessionId } = useDaemon();
  const [conversationKey, setConversationKey] = useState(sessionId || 'default');
  const adoptedSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (adoptedSessionRef.current === sessionId) {
      adoptedSessionRef.current = null;
      return;
    }
    adoptedSessionRef.current = null;
    setConversationKey(sessionId || 'default');
  }, [sessionId]);

  // 탭 ↔ 전역 세션 동기화 (2026-07-13) — attach(updateChatTab)·탭 활성
  // 전환이 실제 화면 세션(전역)으로 반영되고, ChatLayout 내부 전환(fork
  // 버튼·ACP adoption)은 탭에 역기록된다. 활성 탭만 개입(비활성 패널은
  // display:none 뒤에서 전역과 싸우면 안 됨). 방향 판별은 순수 함수
  // `resolveChatSessionSync` — 테스트 소관도 그쪽.
  const prevTabRef = useRef(props.sessionId);
  const prevDaemonRef = useRef(sessionId);
  const activeId = ws?.state.activeId ?? null;
  useEffect(() => {
    const tabSid = props.sessionId;
    if (ws && props.tabId && tabSid && sessionId) {
      const action = resolveChatSessionSync({
        isActive: activeId === props.tabId,
        tabSessionId: tabSid,
        daemonSessionId: sessionId,
        prevTabSessionId: prevTabRef.current ?? tabSid,
        prevDaemonSessionId: prevDaemonRef.current ?? sessionId,
      });
      if (action === 'adopt-tab') setSessionId(tabSid);
      else if (action === 'record-global') ws.updateChatTab(props.tabId, { sessionId });
    }
    prevTabRef.current = props.sessionId;
    prevDaemonRef.current = sessionId;
  }, [ws, activeId, props.tabId, props.sessionId, sessionId, setSessionId]);

  // workspace 안일 때만 SessionPill dropdown 콜백 wire.
  const onAttachRequest = ws && props.tabId
    ? () => ws.openPicker({ kind: 'attachToTab', tabId: props.tabId! })
    : undefined;
  const onForgetRequest = ws && props.sessionId
    ? async () => {
        const svc = getSessionsService(client);
        await svc.forget(props.sessionId!);
      }
    : undefined;

  return (
    <ChatLayout
      // Only a selected session remounts; daemon adoption keeps the live turn.
      key={conversationKey}
      onSessionAdopt={(issued) => { adoptedSessionRef.current = issued; }}
      {...(onAttachRequest ? { onAttachRequest } : {})}
      {...(onForgetRequest ? { onForgetRequest } : {})}
      {...(props.tabId ? { tabId: props.tabId } : {})}
    />
  );
}
