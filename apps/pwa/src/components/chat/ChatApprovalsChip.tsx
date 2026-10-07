'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { ExecApprovals } from '@/components/exec/ExecApprovals';
import { debugLog } from '@/lib/debug';
import type { DaemonClient } from '@/lib/daemon-client';
import { createGraphApprovalsApi, type GraphApproval } from '@/lib/graph-approvals-api';

type ApprovalState = { client: DaemonClient; items: GraphApproval[]; pending: number; expanded: boolean };

export function ChatApprovalsChip({ mobileOpen, onCount }: { mobileOpen?: boolean; onCount?: (count: number) => void } = {}) {
  const { client } = useDaemon();
  const api = useMemo(() => createGraphApprovalsApi({ client }), [client]);
  const [state, setState] = useState<ApprovalState>({ client, items: [], pending: 0, expanded: false });
  const currentClient = useRef(client);
  currentClient.current = client;
  const active = useRef(false);
  const sequence = useRef(0);
  const visible = state.client === client ? state : null;

  const refresh = useCallback(async () => {
    if (!active.current || currentClient.current !== client || (typeof document !== 'undefined' && document.hidden)) return;
    const current = ++sequence.current;
    try {
      const response = await api.list();
      if (!active.current || currentClient.current !== client || sequence.current !== current) return;
      setState(previous => currentClient.current === client && sequence.current === current ? {
        client,
        items: response.items,
        pending: response.items.length,
        expanded: response.items.length > 0 && previous.client === client && previous.expanded,
      } : previous);
    } catch {
      if (!active.current || currentClient.current !== client || sequence.current !== current) return;
      setState(previous => currentClient.current === client && sequence.current === current
        ? { client, items: [], pending: 0, expanded: false } : previous);
    }
  }, [api, client]);

  useEffect(() => {
    active.current = true;
    setState({ client, items: [], pending: 0, expanded: false });
    void refresh();
    const timer = globalThis.setInterval(() => { void refresh(); }, 30_000);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    return () => {
      active.current = false;
      sequence.current += 1;
      globalThis.clearInterval(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    };
  }, [client, refresh]);

  useEffect(() => { debugLog('chat.approvals', { pending: visible?.pending ?? 0, expanded: visible?.expanded ?? false }); }, [visible?.pending, visible?.expanded]);
  useEffect(() => { onCount?.(visible?.pending ?? 0); }, [onCount, visible?.pending]);

  if (!visible?.pending) return null;
  if (onCount && !mobileOpen) return null;
  const approvals = <ExecApprovals client={client} approvals={visible.items} onDecided={() => { void refresh(); }} onPendingChange={n => {
    if (currentClient.current !== client) return;
    setState(previous => previous.client === client ? {
      ...previous, pending: n, ...(n === 0 ? { items: [], expanded: false } : {}),
    } : previous);
  }} />;
  if (onCount) return <div id="chat-approvals-panel" className="max-h-[min(50vh,24rem)] overflow-y-auto border-b border-border p-3">{approvals}</div>;
  return <div className="shrink-0 border-b border-border bg-background px-3 py-1.5 text-sm">
    <button type="button" aria-expanded={visible.expanded} aria-controls="chat-approvals-panel" onClick={() => setState(previous => previous.client === client ? { ...previous, expanded: !previous.expanded } : previous)} className="rounded-full border border-border bg-muted px-3 py-1 font-medium text-foreground hover:bg-muted/70">
      승인 대기 {visible.pending}
    </button>
    {visible.expanded && <div id="chat-approvals-panel" className="mt-2 max-h-[min(50vh,24rem)] overflow-y-auto rounded-lg border border-border p-3">{approvals}</div>}
  </div>;
}
