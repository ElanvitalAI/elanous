'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { decide, listOpenDecisions, type OpenDecision } from '@/lib/decisions-api';
import type { DaemonClient } from '@/lib/daemon-client';
import { DecisionCard } from '@/components/missions/DecisionCard';

type DecisionState = { client: DaemonClient; item: OpenDecision | null; busy: boolean };

export function ChatPendingDecision() {
  const { client } = useDaemon();
  const [state, setState] = useState<DecisionState>({ client, item: null, busy: false });
  const active = useRef(false);
  const currentClient = useRef(client);
  currentClient.current = client;
  const request = useRef(0);
  const choosing = useRef(false);
  const visible = state.client === client ? state : null;

  const refresh = useCallback(async () => {
    if (!active.current || currentClient.current !== client || (typeof document !== 'undefined' && document.hidden)) return;
    const sequence = ++request.current;
    try {
      const items = await listOpenDecisions(client);
      if (active.current && currentClient.current === client && sequence === request.current) {
        setState(previous => previous.client === client ? { ...previous, item: items[0] ?? null } : previous);
      }
    } catch {
      if (active.current && currentClient.current === client && sequence === request.current) {
        setState(previous => previous.client === client ? { ...previous, item: null } : previous);
      }
    }
  }, [client]);

  useEffect(() => {
    active.current = true;
    choosing.current = false;
    setState({ client, item: null, busy: false });
    void refresh();
    const timer = globalThis.setInterval(() => { void refresh(); }, 30_000);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    return () => {
      active.current = false;
      choosing.current = false;
      request.current++;
      globalThis.clearInterval(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    };
  }, [client, refresh]);

  const choose = async (option: OpenDecision['options'][number]) => {
    if (!visible?.item || choosing.current) return;
    choosing.current = true;
    const id = visible.item.id;
    setState(previous => previous.client === client ? { ...previous, busy: true } : previous);
    try {
      await decide(client, id, option.id);
      if (active.current && currentClient.current === client) {
        setState(previous => previous.client === client && previous.item?.id === id
          ? { ...previous, item: null, busy: false } : previous);
        await refresh();
      }
    } catch {
      if (active.current && currentClient.current === client) setState(previous => previous.client === client ? { ...previous, busy: false } : previous);
    } finally {
      choosing.current = false;
    }
  };

  if (!visible?.item) return null;
  return <div className="px-4 py-3" data-chat-pending-decision="">
    <DecisionCard decision={visible.item} onChoose={option => { void choose(option); }} busy={visible.busy} />
  </div>;
}
