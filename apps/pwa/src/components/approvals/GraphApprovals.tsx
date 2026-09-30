'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { createGraphApprovalsApi, graphApprovalErrorText, type GraphApproval, type GraphApprovalDecision } from '@/lib/graph-approvals-api';
import { createLatestRequestGate, graphApprovalCard } from './graph-approval-card';

export function GraphApprovals() {
  const { client } = useDaemon();
  const api = useMemo(() => createGraphApprovalsApi({ client }), [client]);
  const [items, setItems] = useState<GraphApproval[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const gate = useRef(createLatestRequestGate()).current;
  const refresh = useCallback(async () => {
    const token = gate.begin();
    try {
      const result = await api.list();
      if (!gate.isLatest(token)) return;
      setItems(result.items);
      setError('');
    } catch (err) { if (gate.isLatest(token)) setError(graphApprovalErrorText(err)); }
  }, [api, gate]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function decide(item: GraphApproval, decision: GraphApprovalDecision) {
    if (decision === 'rejected' && !window.confirm(`${graphApprovalCard(item).title} 실행을 거절할까요?`)) return;
    setBusy(true);
    setError('');
    gate.begin(); // any list request already in flight is now stale
    try {
      await api.decide(item.graphId, item.runId, decision);
      await refresh();
    } catch (err) { setError(graphApprovalErrorText(err)); }
    finally { setBusy(false); }
  }

  if (!items.length && !error) return null;
  return <section aria-label="실행 승인" className="mx-auto max-w-3xl space-y-4 px-4 pt-6 text-foreground sm:px-8">
    <h2 className="text-xl font-semibold">실행 승인</h2>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    {items.map((item) => {
      const card = graphApprovalCard(item);
      return <article key={`${item.graphId}/${item.runId}`} className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <h3 className="font-semibold">{card.title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">멈춘 단계: {card.nodeId} · {card.waiting}부터 대기 중</p>
        <p className="mt-3 whitespace-pre-wrap break-words text-sm">{card.message}</p>
        {card.recent.length > 0 && <div className="mt-3 text-sm"><p className="font-medium">최근 단계</p><ul className="mt-1 space-y-1">{card.recent.map((line, index) => <li key={index} className="break-words">{line}</li>)}</ul></div>}
        <div className="mt-4 flex gap-2">
          <button type="button" disabled={busy} onClick={() => { void decide(item, 'approved'); }} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">승인</button>
          <button type="button" disabled={busy} onClick={() => { void decide(item, 'rejected'); }} className="rounded-lg border px-4 py-2 text-sm disabled:opacity-50">거절</button>
        </div>
      </article>;
    })}
  </section>;
}
