'use client';

// Mobile-first shell — iPad / iPhone 좁은 공간 우선.
//
// Layout:
//   ┌─────────────────────────────────────────────┐
//   │ TopBar (h-9) — single-row icon strip         │
//   │ [☰] [session] [theme] [voice]                │
//   ├─────────────────────────────────────────────┤
//   │           main content                       │
//   │                                              │
//   └─────────────────────────────────────────────┘
//
// Sidebar:
//   - default COLLAPSED on every viewport (saves vertical space on
//     iPad, horizontal on phone). User toggles via the ☰ hamburger.
//   - md+: collapsed = w-10 icon-only narrow rail · expanded = inline
//     aside (w-56). The narrow rail keeps Voice/Chat/Intake/Control/
//     Terminal/Settings reachable without re-opening the drawer (U-6b).
//   - <md (phone): collapsed = no sidebar (max content area on phone)
//     · expanded = drawer overlay with backdrop, click backdrop to close.
//   - State persists to localStorage so the user's preference survives
//     reload.

import { useEffect, useState } from 'react';
import { SidebarNav } from './SidebarNav';
import { TopBar } from './TopBar';
import type { ShellActivitySnapshot } from './activity-snapshot';
import { useShellActivity } from './use-shell-activity';
import { InstallBanner } from '@/components/install-banner';
import { WorkspaceProvider } from '@/components/workspace/WorkspaceProvider';
import { SetupModeBanner } from './SetupModeBanner';
import { AuthRequiredBanner } from './AuthRequiredBanner';

const SIDEBAR_KEY = 'elanous.pwa.sidebarOpen';

export function AppShell({
  children,
  activity: activityOverride,
}: {
  children: React.ReactNode;
  activity?: ShellActivitySnapshot;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const polled = useShellActivity();
  const activity = activityOverride ?? polled;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(SIDEBAR_KEY);
    if (stored === '1') setSidebarOpen(true);
  }, []);

  const toggleSidebar = (): void => {
    setSidebarOpen((prev) => {
      const next = !prev;
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0');
      }
      return next;
    });
  };

  const closeSidebar = (): void => {
    setSidebarOpen(false);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SIDEBAR_KEY, '0');
    }
  };

  return (
    // 2026-05-07 dogfood feedback — WorkspaceProvider lifted to AppShell
    // so the TopBar 의 inline tab strip 이 모든 route 에서 같은 워크스페이스
    // state 를 공유. workspace/page.tsx 가 자체 Provider 를 mount 했던
    // 것은 nested provider 가 되어 새 빈 state 를 만들지 않도록 제거됨.
    // useWorkspaceOptional() 호출자는 영향 없음 (provider 가 항상 mount).
    <WorkspaceProvider>
      <div className="flex h-screen w-full flex-col bg-background text-foreground">
        <AuthRequiredBanner />
        <SetupModeBanner />
        <TopBar onToggleSidebar={toggleSidebar} sidebarOpen={sidebarOpen} activity={activity} />
        <div className="flex flex-1 min-h-0">
          {/* md+ inline sidebar — expanded: w-56 with labels, collapsed:
              w-10 icon-only rail (U-6b) so navigation stays one tap away
              without re-opening the drawer. */}
          {sidebarOpen ? (
            <aside className="hidden md:flex md:w-56 md:flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
              <SidebarNav onNavigate={closeSidebar} onClose={closeSidebar} />
            </aside>
          ) : (
            <aside className="hidden md:flex md:w-10 md:flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
              <SidebarNav onNavigate={closeSidebar} compact />
            </aside>
          )}

          {/* mobile drawer overlay — collapsed = nothing (max content
              area on phone); expanded = full-width drawer with backdrop. */}
          {sidebarOpen && (
            <>
              <button
                type="button"
                aria-label="close menu"
                className="fixed inset-0 z-30 bg-black/40 md:hidden"
                onClick={closeSidebar}
              />
              <aside className="fixed left-0 top-9 z-40 h-[calc(100vh-2.25rem)] w-56 border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:hidden">
                <SidebarNav onNavigate={closeSidebar} onClose={closeSidebar} />
              </aside>
            </>
          )}

          <main className="flex-1 overflow-auto min-w-0">{children}</main>
        </div>
        <InstallBanner />
      </div>
    </WorkspaceProvider>
  );
}
