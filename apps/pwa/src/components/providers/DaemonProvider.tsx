'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  loadDaemonConfig,
  saveDaemonConfig,
  type DaemonConfig,
} from '@/lib/daemon-config';
import { ensureSessionId } from '@/lib/daemon-session';
import { DaemonClient } from '@/lib/daemon-client';
import { debugLog } from '@/lib/debug';

interface DaemonContextValue {
  config: DaemonConfig;
  setConfig: (next: Partial<DaemonConfig>) => void;
  client: DaemonClient;
  sessionId: string;
  setSessionId: (id: string) => void;
}

/** Internal context handle. Exported so opt-in consumers (e.g.
 *  sidebar widgets that mount even when the provider is absent on a
 *  particular route) can read the value without the throwing
 *  `useDaemon` contract. Most callers should use `useDaemon()` so a
 *  missing provider surfaces as a loud error instead of a silent
 *  no-op. */
export const DaemonContext = createContext<DaemonContextValue | null>(null);

export function DaemonProvider({ children }: { children: React.ReactNode }) {
  // Hydration safety — start every render path (SSR + first CSR) with
  // the SSR-shaped empty config, then sync from localStorage in the
  // mount effect. The previous lazy init `() => loadDaemonConfig()`
  // returned empty during SSR but the populated localStorage value on
  // the first CSR render, so any descendant reading
  // `config.baseUrl` (e.g. `disabled={!config.baseUrl}`) saw a
  // different value on the two passes → React #418 fanout (cf.
  // NexusClientProvider · 2026-05-07 cascade).
  //
  // Cost is a one-tick render delay before any baseUrl-dependent UI
  // becomes interactive — invisible in practice and identical to the
  // post-#1866/#1867/#1868 mount-flag pattern in the descendant
  // cards, which stays in place as defence-in-depth.
  const EMPTY_CONFIG: DaemonConfig = { baseUrl: '', token: '', provider: '' };
  const [config, setConfigState] = useState<DaemonConfig>(EMPTY_CONFIG);
  const [sessionId, setSessionIdState] = useState<string>('');
  const [client] = useState(() => new DaemonClient(EMPTY_CONFIG));

  useEffect(() => {
    // Mount: read localStorage, push into state + DaemonClient. Storage
    // events further down keep this in sync with cross-tab edits.
    const cfg = loadDaemonConfig();
    setConfigState(cfg);
    client.updateConfig(cfg);
    setSessionIdState(ensureSessionId());
    debugLog('webterm.provider.daemon.init', { baseUrl: cfg.baseUrl, hasToken: !!cfg.token });
  }, [client]);

  // Image-pipeline followup #2 (2026-05-05) — cross-tab sessionId sync.
  // localStorage is shared across same-origin tabs, but mutating it in
  // one tab does NOT update React state in another. The `storage`
  // DOM event fires in OTHER tabs (not the originating one), so when
  // chat in tab A forks (via SessionPill or :fork), settings in tab B
  // can pick up the new id and refetch session-keyed data
  // (LastScreenshot / TabsBar) instead of silently 404-ing on the old
  // id. Single-tab / mobile PWA users get a no-op listener — never
  // fires for in-tab mutations.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (e: StorageEvent): void => {
      // 다른 탭(설정)에서 토큰·주소를 바꾸면 이 탭도 바로 따른다 — 종전엔 열린 터미널 탭이 새로고침 전까지
      // 옛(만료된) 토큰으로 붙으려다 auth_failed 를 냈다(2026-09-28 운영 · 실 브라우저).
      if (e.key === 'elanous.daemon.token' || e.key === 'elanous.nexus.baseUrl') {
        const cfg = loadDaemonConfig();
        client.updateConfig(cfg);
        setConfigState(cfg);
        debugLog('webterm.provider.daemon.config-cross-tab', { key: e.key, hasToken: !!cfg.token });
        return;
      }
      if (e.key !== 'elanous.daemon.sessionId') return;
      // newValue is null on removeItem; don't clobber active state
      // when another tab clears their session.
      if (!e.newValue) return;
      setSessionIdState((prev) => {
        if (prev === e.newValue) return prev;
        debugLog('webterm.provider.daemon.session-cross-tab', {
          previous: prev || '(empty)',
          next: e.newValue,
        });
        return e.newValue!;
      });
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [client]);

  const setConfig = (next: Partial<DaemonConfig>): void => {
    setConfigState((prev) => {
      const merged = { ...prev, ...next };
      saveDaemonConfig(next);
      client.updateConfig(merged);
      debugLog('webterm.provider.daemon.config-update', { keys: Object.keys(next) });
      return merged;
    });
  };

  const setSessionId = (id: string): void => {
    setSessionIdState(id);
    if (typeof window !== 'undefined') {
      localStorage.setItem('elanous.daemon.sessionId', id);
    }
    debugLog('webterm.provider.daemon.session-set', { sessionId: id });
  };

  const value = useMemo<DaemonContextValue>(
    () => ({ config, setConfig, client, sessionId, setSessionId }),
    [config, client, sessionId],
  );

  return <DaemonContext.Provider value={value}>{children}</DaemonContext.Provider>;
}

export function useDaemon(): DaemonContextValue {
  const ctx = useContext(DaemonContext);
  if (!ctx) throw new Error('useDaemon must be used inside <DaemonProvider>');
  return ctx;
}
