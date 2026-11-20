'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  loadDaemonConfig,
  saveDaemonConfig,
  type DaemonConfig,
} from '@/lib/daemon-config';
import { DaemonHealthController } from '@/lib/daemon-health';
import { ensureSessionId } from '@/lib/daemon-session';
import { DaemonClient } from '@/lib/daemon-client';
import { debugLog } from '@/lib/debug';

/** r2 mustFix — 데몬 부재·복구를 버튼 상태에 반영하는 가용성 재탐침 주기. */
const DAEMON_HEALTH_POLL_MS = 15000;

interface DaemonContextValue {
  config: DaemonConfig;
  setConfig: (next: Partial<DaemonConfig>) => void;
  client: DaemonClient;
  sessionId: string;
  setSessionId: (id: string) => void;
  /** [PWA-INTAKE-N1-N5A-N6A] self-review must3 — 데몬 가용성.
   *  /v1/health 성공=true · 실패/미연결=false. token 변경도 재검사 ·
   *  15초 재탐침 · 구성 변경 시 핸들러에서 «동기» false 리셋(r3 mustFix —
   *  설정 변경 첫 렌더에 이전 true 가 남지 않는다. 겹친 탐침의 늦은
   *  응답은 세대 가드로 폐기). 선택형(optional)이라
   *  이 필드를 모르는 기존 소비자는 그대로 동작한다. */
  daemonAvailable?: boolean;
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
  // [PWA-INTAKE-N1-N5A-N6A] self-review must3 — 데몬 가용성.
  // 미확인(false)으로 시작해 health 탐침 결과로 갱신한다(15초 간격 재탐침).
  const [daemonAvailable, setDaemonAvailable] = useState(false);
  // r3 mustFix — 탐침 세대 가드 컨트롤러(설정 변경 동기 무효화 · 겹친 탐침의
  // 늦은 응답 폐기). 순수 로직 원문·시험: lib/daemon-health(.test).ts
  const health = useMemo(
    () => new DaemonHealthController(client, setDaemonAvailable),
    [client],
  );

  useEffect(() => {
    // Mount: read localStorage, push into state + DaemonClient. Storage
    // events further down keep this in sync with cross-tab edits.
    const cfg = loadDaemonConfig();
    setConfigState(cfg);
    client.updateConfig(cfg);
    setSessionIdState(ensureSessionId());
    debugLog('webterm.provider.daemon.init', { baseUrl: cfg.baseUrl, hasToken: !!cfg.token });
  }, [client]);

  // [PWA-INTAKE-N1-N5A-N6A] self-review must3 — 데몬 가용성 탐침(r2 mustFix 강화).
  // baseUrl 이 없으면 미연결(false). 있으면 /v1/health 로 즉시 1회 + 15초 간격
  // 재탐침한다(성공=true · 실패=false). baseUrl·token 이 바뀌면 다시 잰다 —
  // 새 탐침이 끝나기 전까지 이전 true 를 유지하지 않는다(false 리셋).
  // SSR·첫 렌더는 false 로 고정이라 hydration 에도 안전.
  useEffect(() => {
    if (!config.baseUrl) {
      setDaemonAvailable(false);
      return;
    }
    // r2 mustFix — 구성(baseUrl·token)이 바뀌면 새 탐침이 끝나기 전까지 이전 true 를 유지하지 않는다.
    // r3 mustFix — «설정 변경 순간»의 동기 리셋은 setConfig·storage 핸들러의
    // health.invalidateSync() 가 담당한다(첫 렌더부터 false). 이 effect 의 리셋은
    // baseUrl·token 의존성 재실행분을 담고, health.probe() 는 세대 가드로
    // 겹친 탐침의 늦은 응답이 최신 결과를 덮지 않게 한다.
    setDaemonAvailable(false);
    health.probe();
    const poll = setInterval(() => health.probe(), DAEMON_HEALTH_POLL_MS);
    return () => clearInterval(poll);
  }, [client, health, config.baseUrl, config.token]);

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
        // r3 mustFix — 다른 탭에서 설정이 바뀌어도 같은 규칙: 동기 무효화 후 재탐침.
        health.invalidateSync();
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
  }, [client, health]);

  const setConfig = (next: Partial<DaemonConfig>): void => {
    // r3 mustFix — 설정이 바뀌면 «첫 렌더»부터 이전 가용성(true)을 안 남긴다:
    // useEffect 까지 미루지 않고 이 핸들러 안에서 동기로 무효화한다
    // (진행 중 탐침도 세대 가드로 파기 — token 만 바뀐 경우도 같은 길).
    if (
      (next.baseUrl !== undefined && next.baseUrl !== config.baseUrl) ||
      (next.token !== undefined && next.token !== config.token)
    ) {
      health.invalidateSync();
    }
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
    () => ({ config, setConfig, client, sessionId, setSessionId, daemonAvailable }),
    [config, client, sessionId, daemonAvailable],
  );

  return <DaemonContext.Provider value={value}>{children}</DaemonContext.Provider>;
}

export function useDaemon(): DaemonContextValue {
  const ctx = useContext(DaemonContext);
  if (!ctx) throw new Error('useDaemon must be used inside <DaemonProvider>');
  return ctx;
}
