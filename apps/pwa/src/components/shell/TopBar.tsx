'use client';

// Mobile-first top bar — single-row icon strip (h-9).
//
// Per user UX spec (iPad/iPhone narrow space):
//   - 사이드탭 접기 → ☰ hamburger (essential)
//   - 상단 숨기기 → h-9 thin strip, no brand text, no labels
//   - 셋팅 아이콘으로 기능 다 흡수 → ⚙️ popover holds theme + session
//   - 보이스 아이콘도 첫줄에 → 🎙 always visible
//   - 필수 표현외 모두 숨김 → no provider chip in main strip (in
//     settings popover instead)
//
// Layout (left → right):
//   [☰]                          [🎙] [⚙️]
//
// Voice icon stays visible per user request even though the WT-V-1
// quick-pass is parked (Tailscale magic-DNS WS handshake doesn't reach
// daemon — re-enabled when HTTPS path is wired).

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Copy, Menu, Mic, Settings as SettingsIcon, Sun, X } from 'lucide-react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { useTheme, THEMES, type ThemeName } from '@/components/providers/ThemeProvider';
import { toast } from 'sonner';
import { debugLog } from '@/lib/debug';
import { useWakeLock } from '@/lib/use-wake-lock';
import { cn } from '@/lib/utils';
// 2026-05-07 — Workspace tab strip 을 TopBar 안 inline 으로 mount.
// useWorkspaceOptional 은 provider 미mount 환경 (예: pre-AppShell 테스트)
// 에서 null 반환 → 안전한 graceful no-op.
import { TopBarWorkspaceStrip } from './TopBarWorkspaceStrip';
import { TopBarActivityIndicator } from './TopBarActivityIndicator';
import { ShareCaptureButton } from './ShareCaptureButton';
import type { ShellActivitySnapshot } from './activity-snapshot';

const WAKE_LOCK_KEY = 'elanous.pwa.wakeLockOn';

interface Props {
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
  activity?: ShellActivitySnapshot;
}

export function TopBar({ onToggleSidebar, sidebarOpen, activity }: Props) {
  const { sessionId, config } = useDaemon();
  const { theme, setTheme } = useTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [wakeLockOn, setWakeLockOn] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const wakeLock = useWakeLock(wakeLockOn);

  // Restore wake-lock preference on mount.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.localStorage.getItem(WAKE_LOCK_KEY) === '1') setWakeLockOn(true);
  }, []);

  const toggleWakeLock = (): void => {
    setWakeLockOn((prev) => {
      const next = !prev;
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(WAKE_LOCK_KEY, next ? '1' : '0');
      }
      debugLog('pwa.topbar.wake-lock.toggle', { next });
      return next;
    });
  };

  // Click-outside dismissal for the settings popover.
  useEffect(() => {
    if (!settingsOpen) return undefined;
    const onDocClick = (ev: MouseEvent): void => {
      if (!popoverRef.current) return;
      if (popoverRef.current.contains(ev.target as Node)) return;
      setSettingsOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [settingsOpen]);

  const copySession = async (): Promise<void> => {
    if (!sessionId) return;
    try {
      await navigator.clipboard.writeText(sessionId);
      toast.success('Session id copied');
      debugLog('pwa.topbar.session-copy', { sessionId });
    } catch (err) {
      toast.error('Copy failed');
      debugLog('pwa.topbar.session-copy-error', { err: String(err) });
    }
  };

  return (
    <header className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-background px-2 text-xs">
      {/* ☰ sidebar toggle — discoverability: p-2 hit target + visible
          label so first-time users find it. Stays inside h-9 strip. */}
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label={sidebarOpen ? 'close menu' : 'open menu'}
        title={sidebarOpen ? 'close menu' : 'open menu'}
        className="flex shrink-0 items-center gap-1.5 rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {sidebarOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
        <span className="hidden text-[11px] font-medium leading-none sm:inline">
          {sidebarOpen ? '닫기' : '메뉴'}
        </span>
      </button>

      {/* 2026-05-07 dogfood feedback — workspace 탭 strip 을 TopBar
          안 inline 으로 mount. provider 가 AppShell 위에 있어 모든 route
          에서 동일 state. 빈 워크스페이스 (탭 0개) 일 때는 자체 hidden
          → 첫 진입 사용자가 메뉴 + 아이콘만 보게 정리. */}
      <TopBarWorkspaceStrip />
      {activity && <TopBarActivityIndicator snapshot={activity} />}

      <div className="ml-auto flex items-center gap-1">
        {/* 📷 SC1 공유용 캡처(beta) — 가린 화면을 데몬에 저장 */}
        <ShareCaptureButton />
        {/* 🎙 voice — icon-only link to root voice page (essential) */}
        <Link
          href="/"
          aria-label="voice"
          title="voice (HTTPS Tailscale Serve 필요)"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => debugLog('pwa.topbar.voice-link')}
        >
          <Mic className="h-4 w-4" />
        </Link>

        {/* ⚙️ settings popover — absorbs theme + session + provider */}
        <div ref={popoverRef} className="relative">
          <button
            type="button"
            onClick={() => setSettingsOpen((v) => !v)}
            aria-label="settings"
            title={`session ${sessionId ? sessionId.slice(0, 8) : '—'} · theme ${theme}`}
            className={cn(
              'rounded-md p-1.5 hover:bg-accent',
              settingsOpen ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <SettingsIcon className="h-4 w-4" />
          </button>
          {settingsOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 min-w-[240px] rounded-md border border-border bg-popover p-2 shadow-md">
              {/* Session row */}
              <div className="mb-2 border-b border-border pb-2">
                <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  session
                </div>
                <button
                  type="button"
                  onClick={copySession}
                  className="flex w-full items-center justify-between rounded border border-border bg-card px-2 py-1 font-mono text-[11px] hover:bg-secondary"
                  title="click to copy"
                >
                  <span className="truncate">{sessionId || '— (not connected)'}</span>
                  <Copy className="ml-2 h-3 w-3 shrink-0" />
                </button>
                {config.provider && (
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    provider: <span className="font-medium text-foreground">{config.provider}</span>
                  </div>
                )}
              </div>

              {/* Wake-lock toggle (WT-N-6) — phone/iPad keeps screen on
                  during long-running terminal commands. Hidden when the
                  browser doesn't expose the API or HTTP context blocks it. */}
              {wakeLock.supported && (
                <div className="mb-2 border-b border-border pb-2">
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    screen
                  </div>
                  <button
                    type="button"
                    onClick={toggleWakeLock}
                    className={cn(
                      'flex w-full items-center justify-between rounded-sm px-2 py-1 text-xs hover:bg-accent',
                      wakeLockOn && 'bg-accent text-accent-foreground',
                    )}
                    title={wakeLockOn ? '화면 깨움 해제' : '화면 깨움 유지'}
                  >
                    <span className="flex items-center gap-1.5">
                      <Sun className={cn('h-3.5 w-3.5', wakeLockOn && 'text-amber-500')} aria-hidden />
                      Wake Lock
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {wakeLock.held ? 'held' : wakeLockOn ? 'requested' : 'off'}
                    </span>
                  </button>
                  {wakeLock.error && (
                    <p className="mt-1 truncate text-[10px] text-rose-500" title={wakeLock.error}>
                      {wakeLock.error}
                    </p>
                  )}
                </div>
              )}

              {/* Theme picker */}
              <div className="mb-1">
                <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  theme
                </div>
                <ul className="max-h-56 overflow-auto">
                  {THEMES.map((t: ThemeName) => (
                    <li key={t}>
                      <button
                        type="button"
                        className={cn(
                          'flex w-full items-center justify-between rounded-sm px-2 py-1 text-xs hover:bg-accent',
                          t === theme && 'bg-accent text-accent-foreground',
                        )}
                        onClick={() => {
                          setTheme(t);
                          debugLog('pwa.topbar.theme', { theme: t });
                        }}
                      >
                        <span className="truncate">{t}</span>
                        {t === theme && <span className="ml-2 text-[10px]">✓</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Link to full /settings page */}
              <div className="mt-2 border-t border-border pt-2">
                <Link
                  href="/settings"
                  className="block rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => setSettingsOpen(false)}
                >
                  full settings →
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
