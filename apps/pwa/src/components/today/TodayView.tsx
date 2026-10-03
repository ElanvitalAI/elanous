'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useDaemon } from '@/components/providers/DaemonProvider';
import type { ExecRequestItem } from '@/lib/daemon-client';
import { createGraphApprovalsApi, type GraphApproval } from '@/lib/graph-approvals-api';
import { createMergeApprovalsApi, type MergeApproval } from '@/lib/merge-approvals-api';
import { usePwaRole } from '@/lib/pwa-role';
import { visibleForRole } from '@/lib/route-maturity';
import { SessionsStoreApi, type SessionStoreCard } from '@/lib/sessions-store-api';

type SectionState<T> = { items: T[]; loading: boolean; error: boolean };
const initial = <T,>(): SectionState<T> => ({ items: [], loading: true, error: false });

function Section({ title, href, loading, error, empty, retry, children }: {
  title: string; href?: string; loading: boolean; error: boolean; empty: string;
  retry: () => void; children: ReactNode;
}) {
  return <section aria-label={title} className="rounded-xl border border-border bg-card p-5 shadow-sm">
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      {href && <a href={href} className="text-sm font-medium text-primary underline underline-offset-4">모두 보기</a>}
    </div>
    {loading ? <p role="status" className="mt-4 text-sm text-muted-foreground">불러오는 중…</p>
      : error ? <div className="mt-4 text-sm" role="alert">목록을 읽지 못했습니다. <button type="button" onClick={retry} className="font-medium text-primary underline underline-offset-4">다시 시도</button></div>
        : children || <p className="mt-4 text-sm text-muted-foreground">{empty}</p>}
  </section>;
}

export function TodayView() {
  const { client, setSessionId } = useDaemon();
  const role = usePwaRole();
  const canViewApprovals = visibleForRole(role, '/approvals');
  const router = useRouter();
  const graphApi = useMemo(() => createGraphApprovalsApi({ client }), [client]);
  const mergeApi = useMemo(() => createMergeApprovalsApi({ client }), [client]);
  const sessionsApi = useMemo(() => new SessionsStoreApi(client), [client]);
  const [approvals, setApprovals] = useState<SectionState<{ graph: GraphApproval[]; merge: MergeApproval[] }>>(() => ({ items: [], loading: true, error: false }));
  const [requests, setRequests] = useState<SectionState<ExecRequestItem>>(initial);
  const [conversations, setConversations] = useState<SectionState<SessionStoreCard>>(initial);

  const loadApprovals = useCallback(async () => {
    setApprovals(previous => ({ ...previous, loading: true, error: false }));
    try {
      const [graph, merge] = await Promise.all([graphApi.list(), mergeApi.list()]);
      setApprovals({ items: [{ graph: graph.items, merge: merge.items }], loading: false, error: false });
    } catch { setApprovals({ items: [], loading: false, error: true }); }
  }, [graphApi, mergeApi]);
  const loadRequests = useCallback(async () => {
    setRequests(previous => ({ ...previous, loading: true, error: false }));
    try {
      const result = await client.listExecRequests();
      setRequests({ items: [...result.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5), loading: false, error: false });
    } catch { setRequests({ items: [], loading: false, error: true }); }
  }, [client]);
  const loadConversations = useCallback(async () => {
    setConversations(previous => ({ ...previous, loading: true, error: false }));
    try {
      const result = await sessionsApi.list();
      setConversations({ items: [...result.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5), loading: false, error: false });
    } catch { setConversations({ items: [], loading: false, error: true }); }
  }, [sessionsApi]);

  useEffect(() => { if (canViewApprovals) void loadApprovals(); }, [canViewApprovals, loadApprovals]);
  useEffect(() => { void loadRequests(); }, [loadRequests]);
  useEffect(() => { void loadConversations(); }, [loadConversations]);

  const pending = approvals.items[0];
  return <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 text-foreground sm:px-8">
    <header><h1 className="text-2xl font-semibold tracking-tight">오늘</h1><p className="mt-1 text-sm text-muted-foreground">기다리는 결정과 최근 활동을 한눈에 확인하세요.</p></header>
    <Section title="승인 대기" href={canViewApprovals ? '/approvals' : undefined} loading={canViewApprovals && approvals.loading} error={canViewApprovals && approvals.error} empty="지금 결정 대기 중인 일이 없습니다." retry={() => void loadApprovals()}>
      {canViewApprovals && pending && (pending.graph.length > 0 || pending.merge.length > 0) ? <ul className="mt-4 space-y-2 text-sm">
        {pending.graph.map(item => <li key={`${item.graphId}/${item.runId}`} className="rounded-lg border border-border p-3">{item.message || item.graphId}</li>)}
        {pending.merge.map(item => <li key={item.number} className="rounded-lg border border-border p-3">{item.title}</li>)}
      </ul> : null}
    </Section>
    <Section title="최근 맡긴 일" href="/exec" loading={requests.loading} error={requests.error} empty="아직 맡긴 일이 없습니다." retry={() => void loadRequests()}>
      {requests.items.length > 0 ? <ul className="mt-4 space-y-2">{requests.items.map(item => <li key={item.id}>
        <a className="block rounded-lg border border-border p-3 text-sm hover:border-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" href={`/exec?request=${encodeURIComponent(item.id)}`}>{item.text.trim().split(/\r?\n/, 1)[0] || '제목 없는 일'}</a>
      </li>)}</ul> : null}
    </Section>
    <Section title="최근 대화" href="/chat" loading={conversations.loading} error={conversations.error} empty="아직 대화가 없습니다." retry={() => void loadConversations()}>
      {conversations.items.length > 0 ? <ul className="mt-4 space-y-2">{conversations.items.map(item => <li key={item.id}>
        <button type="button" onClick={() => { setSessionId(item.id); router.push('/chat'); }} className="w-full rounded-lg border border-border p-3 text-left text-sm hover:border-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">{item.title || item.preview || '대화'}</button>
      </li>)}</ul> : null}
    </Section>
  </main>;
}
