'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Menu, MoreHorizontal, X } from 'lucide-react';
import { useWorkspaceOptional } from '@/components/workspace/WorkspaceProvider';
import { tabsInOrder } from '@/lib/workspace/store';
import type { ShellActivitySnapshot } from './activity-snapshot';
import { SIDEBAR_NAV_ITEMS, navItemActive } from './sidebar-nav-items';
import { NavSearchProbe } from './NavSearchProbe';
import { TopBar, useTopBarWakeLock, type TopBarWakeLock } from './TopBar';

interface Props {
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
  activity?: ShellActivitySnapshot;
  setWide: (wide: boolean) => void;
  wakeControl?: TopBarWakeLock;
}

export function CompactTopBar({ onToggleSidebar, sidebarOpen, activity, setWide, wakeControl }: Props) {
  const [open, setOpen] = useState(false);
  const localWakeControl = useTopBarWakeLock(!wakeControl);
  const moreRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const workspace = useWorkspaceOptional();
  const active = workspace && tabsInOrder(workspace.state).find((tab) => tab.id === workspace.state.activeId);
  const path = (pathname ?? '/').replace(/\/+$/, '') || '/';
  const activeScreen = active?.kind === 'chat' ? active.title ?? '채팅'
    : active?.kind === 'term' ? '터미널' : active?.kind;
  const [search, setSearch] = useState('');
  const routeScreen = SIDEBAR_NAV_ITEMS.find((item) => navItemActive(item, path, search, SIDEBAR_NAV_ITEMS))?.label;
  const screen = path === '/workspace' && activeScreen ? activeScreen : routeScreen ?? 'elanous';

  useEffect(() => {
    if (!open) return;
    const sheet = sheetRef.current;
    if (!sheet) return;
    const focusables = () => Array.from(sheet.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'))
      .filter((element) => element.getClientRects().length > 0);
    sheet.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return; }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) { event.preventDefault(); sheet.focus(); return; }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === sheet || !sheet.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !sheet.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (!sheet.contains(event.target as Node)) (focusables()[0] ?? sheet).focus();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocus);
      moreRef.current?.focus();
    };
  }, [open]);

  return (
    <>
      <header className="flex h-10 max-h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-2 text-sm">
        <button type="button" onClick={onToggleSidebar} aria-label={sidebarOpen ? 'close menu' : 'open menu'} className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground">
          {sidebarOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
        </button>
        <span className="min-w-0 flex-1 truncate font-medium">{screen}</span>
        <button ref={moreRef} type="button" onClick={() => setOpen(true)} aria-label="더 보기" aria-expanded={open} aria-controls="compact-topbar-sheet" className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground">
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </header>
      {open && (
        <div className="fixed inset-0 z-50">
          <button type="button" aria-label="시트 닫기" className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div ref={sheetRef} id="compact-topbar-sheet" role="dialog" aria-modal="true" aria-label="더 보기" tabIndex={-1} className="absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-xl border border-border bg-background p-4 shadow-lg">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-medium">더 보기</span>
              <button type="button" aria-label="시트 닫기" onClick={() => setOpen(false)} className="rounded p-2"><X className="h-4 w-4" /></button>
            </div>
            <TopBar sheetMode onToggleSidebar={onToggleSidebar} sidebarOpen={sidebarOpen} activity={activity} wakeControl={wakeControl ?? localWakeControl} />
            <button type="button" className="mt-3 w-full rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-accent" onClick={() => { setOpen(false); setWide(true); }}>
              넓게 보기
            </button>
          </div>
        </div>
      )}
    </>
  );
}
