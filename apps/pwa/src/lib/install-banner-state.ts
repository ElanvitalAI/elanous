/**
 * BACKLOG #21 — install banner UX state helpers.
 *
 * SW arc (PR #1716/#1718/#1719/#1720) made the PWA installable but the
 * user has no surface telling them they can add it to the home screen.
 * This helper module owns the policy decisions (when to show / when to
 * stay quiet) so the banner UI stays simple and the rules stay tested.
 *
 * Defaults (chosen for autopilot · sensible-fallback values):
 * - **Position**: bottom drawer — mobile-friendly, doesn't compete with
 *   the TopBar.
 * - **Frequency**: dismiss persists for 7 days. After that the banner
 *   resurfaces; users in installed mode (`display-mode: standalone`)
 *   never see it.
 * - **Audience**: every PWA route (mounted at AppShell). Settings link
 *   to a re-show toggle is a follow-up.
 */

const DISMISS_KEY = 'elanous.pwa.installBanner.dismissedAt';
const RESHOW_DAYS = 7;
const RESHOW_MS = RESHOW_DAYS * 24 * 60 * 60 * 1000;

export type InstallPlatform = 'iosSafari' | 'beforeInstallPromptCapable' | 'unsupported';

export function detectPlatform(ua: string | undefined, hasBeforeInstallPrompt: boolean): InstallPlatform {
  if (hasBeforeInstallPrompt) return 'beforeInstallPromptCapable';
  if (typeof ua !== 'string' || ua.length === 0) return 'unsupported';
  // iPhone / iPad / iPod Safari (not Chrome iOS — UA contains "CriOS")
  const isIOS = /iPad|iPhone|iPod/.test(ua);
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  if (isIOS && isSafari) return 'iosSafari';
  return 'unsupported';
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  // iOS Safari: navigator.standalone — non-standard but the only signal.
  // Other browsers: matchMedia('(display-mode: standalone)').
  const navStandalone = (window.navigator as { standalone?: boolean }).standalone === true;
  let mediaStandalone = false;
  try {
    mediaStandalone = window.matchMedia?.('(display-mode: standalone)')?.matches === true;
  } catch { /* ignore — old engines */ }
  return navStandalone || mediaStandalone;
}

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage; } catch { return null; }
}

export function readDismissAt(): number | null {
  const ls = getStorage();
  if (!ls) return null;
  const raw = ls.getItem(DISMISS_KEY);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function recordDismiss(at: number): void {
  const ls = getStorage();
  if (!ls) return;
  try { ls.setItem(DISMISS_KEY, String(at)); } catch { /* quota — drop */ }
}

export function clearDismiss(): void {
  const ls = getStorage();
  if (!ls) return;
  try { ls.removeItem(DISMISS_KEY); } catch { /* ignore */ }
}

export function quietFor(url: string, stored: string | null): boolean {
  const location = new URL(url);
  if (location.searchParams.get('capture') === 'public') return true;
  const path = location.pathname.replace(/\/+$/, '');
  if (path !== '/inside' && path !== '/app/inside') return false;
  const demo = location.searchParams.get('demo');
  return demo !== null ? demo === '1' : stored === '1';
}

export interface ShouldShowDecision {
  show: boolean;
  /** Why we suppressed (when show=false). Useful for debug.log + tests. */
  reason: 'show' | 'quiet' | 'standalone' | 'recently-dismissed' | 'unsupported';
}

export function shouldShow(opts: {
  now: number;
  standalone: boolean;
  platform: InstallPlatform;
  dismissedAt: number | null;
  quiet?: boolean;
}): ShouldShowDecision {
  if (opts.quiet) return { show: false, reason: 'quiet' };
  if (opts.standalone) return { show: false, reason: 'standalone' };
  if (opts.platform === 'unsupported') return { show: false, reason: 'unsupported' };
  if (opts.dismissedAt !== null && opts.now - opts.dismissedAt < RESHOW_MS) {
    return { show: false, reason: 'recently-dismissed' };
  }
  return { show: true, reason: 'show' };
}

/** Test seam — exposed for assertions. */
export const __INTERNAL_RESHOW_MS = RESHOW_MS;
export const __INTERNAL_DISMISS_KEY = DISMISS_KEY;
