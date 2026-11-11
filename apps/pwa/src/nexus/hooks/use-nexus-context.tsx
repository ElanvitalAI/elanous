// PWA · Nexus React Query context (Phase N-4 PR ξ)
//
// Wraps QueryClientProvider + injects a NexusClient instance. Apps mount
// <NexusProvider client={createNexusClient(...)}>...</NexusProvider> at
// the top of the React tree. All hooks below pull both via
// useNexusClient() / useQueryClient().

'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import {
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import type { NexusClient } from '../client';

const NexusClientContext = createContext<NexusClient | null>(null);

export interface NexusProviderProps {
  client: NexusClient | null;
  /** Optional QueryClient override (tests + parallel apps share). */
  queryClient?: QueryClient;
  /** Default staleTime for nexus queries (ms). Default 2000 — SSE
   *  invalidates faster than this most of the time. */
  defaultStaleTimeMs?: number;
  children: ReactNode;
}

export function NexusProvider({ client, queryClient, defaultStaleTimeMs, children }: NexusProviderProps) {
  const qc = useMemo(() => queryClient ?? new QueryClient({
    defaultOptions: { queries: { staleTime: defaultStaleTimeMs ?? 2000, refetchOnWindowFocus: false } },
  }), [queryClient, defaultStaleTimeMs]);
  return (
    <NexusClientContext.Provider value={client}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </NexusClientContext.Provider>
  );
}

export function useNexusClient(): NexusClient {
  const c = useContext(NexusClientContext);
  if (!c) throw new Error('useNexusClient must be used within <NexusProvider>');
  return c;
}

/** SSG-safe variant — returns `null` when no provider is mounted (e.g.
 *  during Next.js static export prerender, where `localStorage` is
 *  absent so `NexusClientProvider` falls through to children passthrough).
 *
 *  Cards that mount inside SettingsPanel should prefer this hook +
 *  early-return when null, otherwise `next build` aborts on prerender.
 *  Live (browser) runs always have a Provider (assuming baseUrl set), so
 *  this is purely a prerender-safety hatch. */
export function useOptionalNexusClient(): NexusClient | null {
  return useContext(NexusClientContext);
}
