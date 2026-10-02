'use client';

// BACKLOG #21 — bottom drawer banner that nudges the user to install
// the PWA. Mounted in AppShell so every PWA route surfaces the prompt
// once. Supports two flows:
//
// 1. Android / desktop Chrome / Edge — capture `beforeinstallprompt`
//    and call `prompt()` on click.
// 2. iOS Safari — no programmatic install; render manual instructions
//    ("공유 → 홈 화면에 추가") with a Share icon hint.
//
// Dismiss is sticky for 7 days (install-banner-state.ts) and the banner
// stays hidden when the app is already running standalone.

import { useEffect, useState } from 'react';
import { Download, Share, X } from 'lucide-react';
import { debugLog } from '@/lib/debug';
import {
  detectPlatform,
  isStandalone,
  readDismissAt,
  recordDismiss,
  shouldShow,
  type InstallPlatform,
} from '@/lib/install-banner-state';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function InstallBanner() {
  const [visible, setVisible] = useState(false);
  const [platform, setPlatform] = useState<InstallPlatform>('unsupported');
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    let captured: BeforeInstallPromptEvent | null = null;
    const onPrompt = (ev: Event): void => {
      ev.preventDefault();
      captured = ev as BeforeInstallPromptEvent;
      setInstallEvent(captured);
      setPlatform('beforeInstallPromptCapable');
      const decision = shouldShow({
        now: Date.now(),
        standalone: isStandalone(),
        platform: 'beforeInstallPromptCapable',
        dismissedAt: readDismissAt(),
      });
      if (decision.show) setVisible(true);
      debugLog('pwa.install-banner.beforeinstallprompt', { decision });
    };

    window.addEventListener('beforeinstallprompt', onPrompt as EventListener);

    // Initial decision for iOS Safari (no event to wait for).
    const initialPlatform = detectPlatform(navigator.userAgent, false);
    setPlatform(initialPlatform);
    const initialDecision = shouldShow({
      now: Date.now(),
      standalone: isStandalone(),
      platform: initialPlatform,
      dismissedAt: readDismissAt(),
    });
    if (initialDecision.show) setVisible(true);
    debugLog('pwa.install-banner.mount', {
      platform: initialPlatform,
      decision: initialDecision,
    });

    const onAppInstalled = (): void => {
      setVisible(false);
      debugLog('pwa.install-banner.appinstalled');
    };
    window.addEventListener('appinstalled', onAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt as EventListener);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  const dismiss = (): void => {
    setVisible(false);
    recordDismiss(Date.now());
    debugLog('pwa.install-banner.dismiss');
  };

  const triggerInstall = async (): Promise<void> => {
    if (!installEvent) return;
    try {
      await installEvent.prompt();
      const choice = await installEvent.userChoice;
      debugLog('pwa.install-banner.userChoice', { outcome: choice.outcome });
      // accepted: appinstalled handler hides; dismissed: respect 7d.
      if (choice.outcome === 'dismissed') {
        recordDismiss(Date.now());
        setVisible(false);
      }
    } catch (e) {
      debugLog('pwa.install-banner.prompt-error', { reason: String(e) });
    } finally {
      setInstallEvent(null);
    }
  };

  if (!visible) return null;

  // ⛔ 고정 층(`fixed bottom-0`)으로 띄우지 않는다 — AppShell 세로 띠(`h-screen flex-col`)의 마지막 칸으로
  //  자리를 차지해, 본문이 그만큼 줄고 채팅 입력칸이 띠 «위»에 남는다(10-02 0.2.9 릴리스 게이트 C2a·C2b 실측:
  //  1280×800 에서 입력칸 가운데를 누르면 띠의 글이 클릭을 받아 입력이 안 됐다).

  return (
    <div
      role="dialog"
      aria-label="Install elanous to home screen"
      data-testid="install-banner"
      className="shrink-0 border-t border-border bg-card/95 px-4 py-3 shadow-lg backdrop-blur"
    >
      <div className="mx-auto flex max-w-2xl items-start gap-3">
        <div className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-primary/30 bg-primary/10 text-primary">
          <Download className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">elanous 를 홈 화면에 추가하세요</p>
          {platform === 'iosSafari' ? (
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              <Share className="inline-block h-3.5 w-3.5 align-text-bottom" /> 공유 버튼 →
              <span className="mx-1 rounded bg-muted px-1 font-mono text-[11px]">홈 화면에 추가</span>
              로 PWA 로 사용. 알림 · 카메라 · 백그라운드 모두 활성화.
            </p>
          ) : (
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              한 번의 클릭으로 PWA 설치 — 알림 · 백그라운드 turn 보장.
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {platform === 'beforeInstallPromptCapable' && installEvent && (
            <button
              type="button"
              onClick={() => { void triggerInstall(); }}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              data-testid="install-banner-install"
            >
              설치
            </button>
          )}
          <button
            type="button"
            onClick={dismiss}
            aria-label="dismiss install banner"
            data-testid="install-banner-dismiss"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
