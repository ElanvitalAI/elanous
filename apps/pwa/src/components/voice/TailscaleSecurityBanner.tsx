'use client';

// Phase 2 (webterm voice control · PLAN v1.1) — surface a guidance
// banner when the current origin can't host mic capture (HTTP CGNAT
// over Tailscale, generic HTTP, etc). Mounted by TerminalPanel above
// the toolbar so all 3 mic entry points (dock header / ChatInput /
// TerminalControls) share one banner.

import { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { checkSecureContext, type SecureContextStatus } from '@/lib/secure-context-guard';

const DISMISS_SESSION_KEY = 'elanous.webterm.voiceBanner.dismissed';
const INITIAL_STATUS: SecureContextStatus = {
  isSecure: false,
  reason: 'unknown',
  hostname: '',
  protocol: '',
};

function readDismissed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(DISMISS_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

function persistDismissed(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(DISMISS_SESSION_KEY, '1');
  } catch {
    /* sessionStorage may be disabled — banner reverts to default visible */
  }
}

interface Props {
  /** Test seam — supply a fixed status instead of reading window. */
  statusOverride?: SecureContextStatus;
}

export function TailscaleSecurityBanner({ statusOverride }: Props = {}): React.ReactElement | null {
  // A lazy browser initializer would make SSR render this insecure default while
  // the first client render reads storage/context and diverges (React #418).
  // Keep that hydration pass fixed; this effect's later render is outside hydration.
  const [dismissed, setDismissed] = useState(false);
  const [status, setStatus] = useState<SecureContextStatus>(statusOverride ?? INITIAL_STATUS);

  useEffect(() => {
    setDismissed(readDismissed());
    setStatus(statusOverride ?? checkSecureContext());
  }, [statusOverride]);

  if (status.isSecure || dismissed) return null;

  const headline =
    status.reason === 'http-tailscale'
      ? '🎙 Tailscale HTTP 에서 마이크가 차단됩니다'
      : '🎙 마이크 사용을 위해 HTTPS 가 필요합니다';

  const onDismiss = (): void => {
    persistDismissed();
    setDismissed(true);
  };

  return (
    <div
      role="alert"
      aria-live="polite"
      data-testid="webterm-voice-banner"
      data-reason={status.reason}
      className="flex items-start gap-2 border-b border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <AlertTriangle className="mt-[1px] h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <div className="flex-1">
        <div className="font-medium">{headline}</div>
        <div className="mt-0.5 text-amber-800/90 dark:text-amber-200/80">
          {status.guidance ?? '브라우저는 secure context (HTTPS · localhost) 에서만 마이크를 허용합니다.'}
        </div>
        {status.reason === 'http-tailscale' && (
          <div className="mt-1 font-mono text-[11px] text-amber-700 dark:text-amber-200/90">
            <code>tailscale serve --bg --https=443 31415</code>
            {' '}or{' '}
            <a
              href="https://tailscale.com/kb/1242/tailscale-serve"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-amber-900 dark:hover:text-amber-50"
            >
              ts.net HTTPS 가이드
            </a>
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="dismiss banner"
        title="이 창을 닫을 때까지 숨기기"
        className="rounded p-0.5 text-amber-700 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-900/40"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
