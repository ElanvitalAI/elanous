// NEXUS N-1.5 PR i — PWA NexusProvider mount.
//
// Bridges the daemon-config baseUrl (post PR a #1743 cutover —
// `elanous.nexus.baseUrl` localStorage key) into the
// `apps/pwa/src/nexus/hooks/use-nexus-context.tsx` provider so every
// nexus hook (use-nexus-state, use-bindings, use-events, …) gains
// a live `NexusClient` instance.
//
// Client-only — `localStorage` is read lazily on mount (no SSR
// surface). Re-creates the client when baseUrl/token changes via the
// existing daemon-config storage events.

'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { createNexusClient } from '@/nexus/client';
import { NexusProvider } from '@/nexus/hooks/use-nexus-context';
import { loadDaemonConfig } from '@/lib/daemon-config';

interface BaseConfigSnapshot {
  baseUrl: string;
  token: string;
}

function readSnapshot(): BaseConfigSnapshot {
  const cfg = loadDaemonConfig();
  return { baseUrl: cfg.baseUrl, token: cfg.token };
}

export function NexusClientProvider({ children }: { children: ReactNode }) {
  // SSR + first client render must agree on the snapshot. The lazy-init
  // form `() => typeof window === 'undefined' ? empty : readSnapshot()`
  // produced an empty snapshot during SSR but a populated one (from
  // localStorage) during the first client render — every consumer of
  // `useOptionalNexusClient()` then saw `null` server-side and a live
  // client client-side, fanning React #418 hydration mismatches across
  // every card that early-returns on `!client`. Always start empty;
  // populate from localStorage post-mount via useEffect so the first
  // hydration step compares identical trees.
  const [snap, setSnap] = useState<BaseConfigSnapshot>({ baseUrl: '', token: '' });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Initial post-mount sync from localStorage. Subsequent updates
    // come via the storage / `elanous.daemon.changed` events below.
    setSnap(readSnapshot());
    // Storage events fire on cross-tab updates. The DaemonProvider
    // also writes via `saveDaemonConfig`, but that's same-tab and the
    // DOM 'storage' event doesn't fire — DaemonProvider can call
    // `dispatchEvent(new Event('elanous.daemon.changed'))` to nudge. We
    // listen to both so a settings save propagates.
    const onAny = (): void => setSnap(readSnapshot());
    window.addEventListener('storage', onAny);
    window.addEventListener('elanous.daemon.changed', onAny);
    return () => {
      window.removeEventListener('storage', onAny);
      window.removeEventListener('elanous.daemon.changed', onAny);
    };
  }, []);

  const client = useMemo(() => {
    if (!snap.baseUrl) return null;
    return createNexusClient({ baseUrl: snap.baseUrl, ...(snap.token ? { token: snap.token } : {}) });
  }, [snap.baseUrl, snap.token]);

  if (!client) return <>{children}</>;
  return <NexusProvider client={client}>{children}</NexusProvider>;
}
