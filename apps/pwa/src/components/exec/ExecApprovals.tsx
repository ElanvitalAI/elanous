'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { DaemonClient, ExecRequestDetail } from '@/lib/daemon-client';
import { createGraphApprovalsApi, graphApprovalErrorText, type GraphApproval, type GraphApprovalDecision } from '@/lib/graph-approvals-api';

type Approval = ExecRequestDetail['approvals'][number];
const approvalKey = (approval: Pick<Approval, 'graphId' | 'runId'>) => JSON.stringify([approval.graphId, approval.runId]);

export function ExecApprovals({ client, approvals, onDecided, onPendingChange }: { client: DaemonClient; approvals: Approval[]; onDecided: () => void; onPendingChange: (n: number) => void }) {
  const api = useMemo(() => createGraphApprovalsApi({ client }), [client]);
  const [pending, setPending] = useState<GraphApproval[]>([]);
  const [decided, setDecided] = useState<Record<string, GraphApprovalDecision>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const keys = approvals.map(approvalKey).join('|');

  function reportPending(items: GraphApproval[], decisions = decided) {
    setPending(items);
    onPendingChange(approvals.filter(approval => !decisions[approvalKey(approval)] && items.some(item => approvalKey(item) === approvalKey(approval))).length);
  }

  useEffect(() => {
    const current = ++sequence.current;
    setPending([]);
    setError('');
    if (!keys) {
      onPendingChange(0);
      return () => { sequence.current += 1; };
    }
    void api.list().then(response => {
      if (sequence.current === current) reportPending(response.items);
    }).catch(err => { if (sequence.current === current) setError(graphApprovalErrorText(err, 'list')); });
    return () => { sequence.current += 1; };
  }, [api, keys]);

  async function decide(approval: Approval, decision: GraphApprovalDecision) {
    const key = approvalKey(approval);
    if (busy || decided[key] || !approvals.some(item => approvalKey(item) === key) || !pending.some(item => approvalKey(item) === key)) return;
    const current = sequence.current;
    setBusy(key);
    setError('');
    try {
      await api.decide(approval.graphId, approval.runId, decision);
      if (sequence.current !== current) return;
      const nextDecisions = { ...decided, [key]: decision };
      setDecided(nextDecisions);
      reportPending(pending, nextDecisions);
      onDecided();
      const response = await api.list();
      if (sequence.current === current) reportPending(response.items, nextDecisions);
    } catch (err) {
      if (sequence.current === current) setError(graphApprovalErrorText(err, 'decide'));
    } finally {
      if (sequence.current === current) setBusy(null);
    }
  }

  if (approvals.length === 0) return null;
  return <div className="space-y-2">
    <h3 className="font-semibold">게시 승인</h3>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <ul className="space-y-2">{approvals.map(approval => {
      const key = approvalKey(approval);
      const isPending = pending.some(item => approvalKey(item) === key);
      return <li key={key} className="rounded-lg border border-border bg-background px-4 py-3 text-sm">
        <p>{approval.message}</p>
        {decided[key] ? <p className="mt-2 text-muted-foreground">{decided[key] === 'approved' ? '승인됨' : '보류됨'}</p>
          : isPending ? <div className="mt-2 flex gap-2">
            <button type="button" disabled={busy !== null} onClick={() => void decide(approval, 'approved')} className="rounded-lg bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50">승인</button>
            <button type="button" disabled={busy !== null} onClick={() => void decide(approval, 'rejected')} className="rounded-lg border border-border px-3 py-1 disabled:opacity-50">보류</button>
          </div> : <p className="mt-2 text-muted-foreground">대기 중인 승인이 아닙니다.</p>}
      </li>;
    })}</ul>
  </div>;
}
