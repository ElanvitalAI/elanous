'use client';

// PR #3 + PR #4 — 모든 탭을 mount 하고 active 만 display:block.
// 비활성은 display:none 으로 hide. unmount 금지 (HANDOFF §5.1 #1) —
// chat 입력 buffer · xterm scrollback · voice connection 모두 보존.
//
// PR #4 모바일: 좌우 swipe 로 인접 탭 전환 (탭 1개 미만이면 비활성).

import { useEffect, useRef } from 'react';
import { useWorkspace } from './WorkspaceProvider';
import { TabPanel } from './TabPanel';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { TerminalPanel } from '@/components/terminal/TerminalPanel';
// Phase 2 (PWA chat ↔ voice 일원화 · 2026-05-07) — VoicePanel deleted.
// Voice now folds into ChatLayout via the header mic toggle (Phase 1).
import { IntakeFrontDoor } from '@/components/intake/IntakeFrontDoor';
import { TaskManagerPanel } from '@/components/tasks/TaskManagerPanel';
// Surface-unification v2.2 V2.2-6 (2026-05-11) — SchedulerPanel removed.
// Scheduling is now a workflow scheduleTrigger node; the dedicated panel
// (and the `'scheduler'` workspace tab kind) were dropped together.
import { ControlPanel } from '@/components/control/ControlPanel';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import type { WorkspaceTab } from '@/lib/workspace/types';
import { tabsInOrder } from '@/lib/workspace/store';
import { attachSwipe } from '@/lib/swipe-gesture';

function PanelForTab({ tab }: { tab: WorkspaceTab }) {
  switch (tab.kind) {
    case 'chat':
      return <ChatPanel sessionId={tab.sessionId} tabId={tab.id} />;
    case 'term':
      return <TerminalPanel />;
    case 'intake':
      return <IntakeFrontDoor />;
    case 'tasks':
      return <TaskManagerPanel />;
    case 'control':
      return <ControlPanel />;
    case 'settings':
      return <SettingsPanel />;
  }
}

/** PR #5 — frozen 탭 placeholder. 활성화 시 reducer 가 auto-unfreeze
 *  (PR #1) 하므로 다음 render 에서 실제 PanelForTab 으로 교체. snapshot
 *  복원은 컴포넌트 자체의 localStorage 사용 (chat-runtime 입력 보존
 *  hook 등) — 본 PR 은 LRU 정책 발동만 처리하고 explicit snapshot/
 *  restore 는 follow-up. */
function FrozenPlaceholder() {
  return (
    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
      <span>(이 탭은 절약 모드 — 클릭 시 복원)</span>
    </div>
  );
}

export function WorkspaceCanvas() {
  const { state, addTab, activateTab } = useWorkspace();
  const ordered = tabsInOrder(state);
  const ref = useRef<HTMLDivElement>(null);

  // 모바일 swipe — 인접 탭 전환. 탭 ≤ 1개면 비활성.
  useEffect(() => {
    if (!ref.current) return;
    if (ordered.length <= 1) return;
    return attachSwipe(ref.current, {
      shouldIgnore: (target) => {
        // input/textarea/xterm 안의 swipe 는 무시 — 텍스트 선택 충돌.
        if (!(target instanceof HTMLElement)) return false;
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (target.closest('.xterm')) return true;
        if (target.isContentEditable) return true;
        return false;
      },
      onSwipe: (dir) => {
        const idx = state.activeId
          ? ordered.findIndex((t) => t.id === state.activeId)
          : -1;
        if (idx < 0) return;
        const nextIdx = dir === 'left'
          ? Math.min(ordered.length - 1, idx + 1)
          : Math.max(0, idx - 1);
        if (nextIdx === idx) return;
        activateTab(ordered[nextIdx].id);
      },
    });
  }, [ordered, state.activeId, activateTab]);

  if (ordered.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="rounded-lg border border-dashed border-border bg-card px-6 py-8 max-w-md">
          <h2 className="text-base font-semibold tracking-tight">워크스페이스 시작</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            상단 strip 의{' '}
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">+</span>
            {' '}또는 아래 버튼으로 첫 탭을 추가하세요. 비활성 탭은 닫기 전까지 unmount 되지 않아 입력 중 텍스트가 보존됩니다.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={() => addTab({ kind: 'chat' })}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-secondary"
            >
              + chat
            </button>
            <button
              type="button"
              onClick={() => addTab({ kind: 'term' })}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-secondary"
            >
              + terminal
            </button>
          </div>
        </div>
      </div>
    );
  }

  const frozenSet = new Set(state.frozenIds);

  return (
    <div ref={ref} className="relative h-full min-h-0 touch-pan-y">
      {ordered.map((tab) => (
        <TabPanel key={tab.id} id={tab.id} active={state.activeId === tab.id}>
          {frozenSet.has(tab.id) ? <FrozenPlaceholder /> : <PanelForTab tab={tab} />}
        </TabPanel>
      ))}
    </div>
  );
}
