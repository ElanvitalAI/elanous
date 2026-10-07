'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { decide, listOpenDecisions, type OpenDecision } from '@/lib/decisions-api';
import type { DaemonClient } from '@/lib/daemon-client';

type DecisionState = { client: DaemonClient; items: OpenDecision[]; expanded: boolean; decided: Record<string, string>; busy: string | null };

export function ChatDecisionsChip({ mobileOpen, onCount }: { mobileOpen?: boolean; onCount?: (count: number) => void } = {}) {
  const { client } = useDaemon();
  const [state, setState] = useState<DecisionState>({ client, items: [], expanded: false, decided: {}, busy: null });
  const currentClient = useRef(client);
  currentClient.current = client;
  const active = useRef(false);
  const sequence = useRef(0);
  const deciding = useRef<string | null>(null);
  const visible = state.client === client ? state : null;

  const refresh = useCallback(async () => {
    if (!active.current || currentClient.current !== client || (typeof document !== 'undefined' && document.hidden)) return;
    const current = ++sequence.current;
    try {
      const items = await listOpenDecisions(client);
      if (!active.current || currentClient.current !== client || sequence.current !== current) return;
      setState(previous => previous.client === client ? {
        ...previous, items: [...items, ...previous.items.filter(item => previous.decided[item.id] && !items.some(open => open.id === item.id))],
        expanded: previous.expanded && (items.length > 0 || previous.items.some(item => previous.decided[item.id])),
      } : previous);
    } catch {
      if (!active.current || currentClient.current !== client || sequence.current !== current) return;
      setState(previous => previous.client === client ? { ...previous, items: [], expanded: false } : previous);
    }
  }, [client]);

  useEffect(() => {
    active.current = true;
    deciding.current = null;
    setState({ client, items: [], expanded: false, decided: {}, busy: null });
    void refresh();
    const timer = globalThis.setInterval(() => { void refresh(); }, 30_000);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    return () => {
      active.current = false;
      deciding.current = null;
      sequence.current += 1;
      globalThis.clearInterval(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    };
  }, [client, refresh]);

  const choose = async (item: OpenDecision, option: OpenDecision['options'][number]) => {
    if (deciding.current || state.busy || state.decided[item.id]) return;
    deciding.current = item.id;
    setState(previous => previous.client === client ? { ...previous, busy: item.id } : previous);
    try {
      await decide(client, item.id, option.id);
      if (!active.current || currentClient.current !== client) return;
      deciding.current = null;
      setState(previous => previous.client === client ? {
        ...previous, busy: null, decided: { ...previous.decided, [item.id]: option.label },
      } : previous);
      await refresh();
    } catch {
      if (active.current && currentClient.current === client) {
        deciding.current = null;
        setState(previous => previous.client === client ? { ...previous, busy: null } : previous);
      }
    }
  };

  const pending = visible?.items.filter(item => !visible.decided[item.id]).length ?? 0;
  useEffect(() => { onCount?.(pending); }, [onCount, pending]);
  if (!visible || (!pending && !(visible.expanded && visible.items.some(item => visible.decided[item.id])))) return null;
  if (onCount && !mobileOpen) return null;
  const decisions = <ul id="chat-decisions-panel" className="mt-2 max-h-[min(50vh,24rem)] space-y-2 overflow-y-auto rounded-lg border border-border p-3">
    {visible.items.map(item => <li key={item.id} className="rounded-lg border border-border p-3">
      <h3 className="font-semibold">{item.title}</h3>
      <p className="truncate text-muted-foreground" title={item.situation}>{item.situation}</p>
      {visible.decided[item.id] ? <p role="status">결정함 — {visible.decided[item.id]}</p> : <div className="mt-2 flex flex-wrap gap-2">
        {item.options.map(option => <button key={option.id} type="button" disabled={!!visible.busy} onClick={() => { void choose(item, option); }} className="rounded-md border border-border px-2 py-1 hover:bg-muted disabled:opacity-50">
          {option.label}{'option' in item.recommendation && item.recommendation.option === option.id && <span className="ml-1 text-primary">추천</span>}
        </button>)}
      </div>}
    </li>)}
  </ul>;
  if (onCount) return decisions;
  return <div className="shrink-0 border-b border-border bg-background px-3 py-1.5 text-sm">
    <button type="button" aria-expanded={visible.expanded} aria-controls="chat-decisions-panel" onClick={() => setState(previous => previous.client === client ? { ...previous, expanded: !previous.expanded } : previous)} className="rounded-full border border-border bg-muted px-3 py-1 font-medium text-foreground hover:bg-muted/70">
      대표 결정 {pending}
    </button>
    {visible.expanded && decisions}
  </div>;
}
