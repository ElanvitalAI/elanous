// PWA · Nexus state queries (Phase N-4 PR ξ)

'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNexusClient, useOptionalNexusClient } from './use-nexus-context';
import { nexusKeys } from './query-keys';
import type { NexusHealth, NexusTabKind } from '../types';

export function useNexusHealth() {
  const client = useNexusClient();
  return useQuery({
    queryKey: nexusKeys.health(),
    queryFn: () => client.getHealth(),
  });
}

/** Same read as `useNexusHealth`, but stays disabled when no Nexus client
 *  is mounted (SSG, static markup, daemon baseUrl not yet known). `data`
 *  then stays unset and callers keep the current render. */
/** 데몬 연결이 없을 수도 있는 자리(AppShell · 첫 화면)용.
 *  ⛔ useQuery 를 쓰지 않는다 — 클라이언트가 없으면 NexusClientProvider 가 QueryClientProvider 를
 *  안 깔아서, 정적 prerender 에서 «No QueryClient set» 으로 PWA 빌드 전체가 깨졌다(2026-09-27 · #20786 뒤). */
export function useNexusHealthIfMounted(): {
  data: NexusHealth | undefined;
  isError: boolean;
  isLoading: boolean;
  isPending: boolean;
} {
  const client = useOptionalNexusClient();
  const [state, setState] = useState<{ data: NexusHealth | undefined; isError: boolean; isPending: boolean }>(
    { data: undefined, isError: false, isPending: true },
  );
  useEffect(() => {
    if (!client) {
      setState({ data: undefined, isError: false, isPending: true });
      return;
    }
    let alive = true;
    const load = () => {
      client.getHealth()
        .then((data) => { if (alive) setState({ data, isError: false, isPending: false }); })
        .catch(() => { if (alive) setState((prev) => ({ ...prev, isError: true, isPending: false })); });
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(timer); };
  }, [client]);
  return { ...state, isLoading: state.isPending && client !== null };
}

export function useNexusSnapshot() {
  const client = useNexusClient();
  return useQuery({
    queryKey: nexusKeys.snapshot(),
    queryFn: () => client.getNexus(),
  });
}

export function useNexusTabs(opts: { kind?: NexusTabKind } = {}) {
  const client = useNexusClient();
  return useQuery({
    queryKey: nexusKeys.tabs(opts.kind),
    queryFn: () => client.getTabs(opts),
  });
}

export function useNexusTab(id: string, opts: { enabled?: boolean } = {}) {
  const client = useNexusClient();
  return useQuery({
    queryKey: nexusKeys.tab(id),
    queryFn: () => client.getTab(id),
    enabled: opts.enabled ?? id.length > 0,
  });
}
