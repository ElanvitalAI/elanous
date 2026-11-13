'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MemberMiniBoardApi } from '@/lib/member-mini-board-api';
import { rowsForVerifiedMember, rowsFromApi, type MemberBoardCard } from '@/components/member-board/member-board-model';

/** The verified member's pending app proposal is the chat surface's explicit OK action. */
export function MemberProposalCard({ api }: { api: MemberMiniBoardApi | null }) {
  const currentApi = useRef(api);
  currentApi.current = api;
  const lastOwnerId = useRef<string | null>(null);
  const refreshSequence = useRef(0);
  const [sourceApi, setSourceApi] = useState<MemberMiniBoardApi | null>(null);
  const [proposal, setProposal] = useState<MemberBoardCard | null>(null);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acceptances, setAcceptances] = useState<Array<{ cardId: string; title: string; acceptanceId: string; state?: MemberBoardCard['state']; runId?: string }>>([]);
  const refresh = useCallback(async () => {
    if (!api) return;
    const sequence = ++refreshSequence.current;
    const owner = await api.getVerifiedOwner();
    if (currentApi.current !== api || sequence !== refreshSequence.current) return;
    const sameOwner = lastOwnerId.current === owner.memberId;
    if (!sameOwner) {
      lastOwnerId.current = owner.memberId;
      setProposal(null);
      setAcceptances([]);
      setError(null);
    }
    const board = await api.getBoard();
    if (currentApi.current !== api || sequence !== refreshSequence.current) return;
    setSourceApi(api);
    setMemberId(owner.memberId);
    const cards = rowsForVerifiedMember(rowsFromApi<MemberBoardCard & { acceptanceId?: string }>(board, 'cards'), owner.memberId);
    setProposal(cards.find(card => card.state === 'proposed' || card.retryable === true) ?? null);
    const durable = cards.filter(card => card.acceptanceId && card.state !== 'proposed')
      .map(card => ({ cardId: card.id, title: card.title, acceptanceId: card.acceptanceId!, state: card.state, runId: card.runId }));
    setAcceptances(previous => sameOwner ? [...durable, ...previous.filter(item =>
      !durable.some(card => card.cardId === item.cardId && card.acceptanceId === item.acceptanceId))] : durable);
  }, [api]);

  useEffect(() => {
    let active = true;
    lastOwnerId.current = null;
    refreshSequence.current++;
    setSourceApi(null);
    setMemberId(null);
    setProposal(null);
    setAcceptances([]);
    setError(null);
    if (!api) return;
    void refresh().catch(() => { if (active) setProposal(null); });
    return () => { active = false; };
  }, [api, refresh]);

  useEffect(() => {
    if (!api || !memberId) return;
    return api.subscribe(memberId, () => { void refresh().catch(() => undefined); });
  }, [api, memberId, refresh]);

  if (!api || sourceApi !== api || (!proposal && acceptances.length === 0 && !error)) return null;
  const approve = async () => {
    if (!proposal || !api.approveCard || pending) return;
    const approvingOwnerId = memberId;
    setPending(true);
    setError(null);
    try {
      const result = await api.approveCard(proposal.id);
      if (currentApi.current !== api || lastOwnerId.current !== approvingOwnerId) return;
      if (result.dispatch?.acceptanceId) setAcceptances(previous => [...previous, { cardId: proposal.id, title: proposal.title, acceptanceId: result.dispatch!.acceptanceId }]);
      await refresh();
    } catch (cause) {
      if (currentApi.current !== api || lastOwnerId.current !== approvingOwnerId) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      try { await refresh(); } catch { /* Keep the approval error visible. */ }
    } finally { setPending(false); }
  };
  return <section aria-label="앱 제안 승인" className="mx-4 mb-3 rounded-lg border border-border bg-card p-3 text-sm">
    {acceptances.length > 0 && <ul aria-label="하니스 접수 내역" className="mb-2 space-y-1">
      {acceptances.map(item => <li key={`${item.cardId}:${item.acceptanceId}`} role="status">
        {item.title} · 하니스 요청 접수 {item.acceptanceId}
        {item.state && <> · {item.state === 'deployed' ? '배포됨' : item.state === 'failed' ? '실패' : item.state === 'testing' ? '시험' : item.state === 'developing' ? '개발 중' : '승인됨'}</>}
        {item.runId && <> · run {item.runId}</>}
        {' · '}<a href="/board" className="text-primary underline">미니 보드 보기</a>
      </li>)}
    </ul>}
    {proposal ? <>
      <p className="font-semibold">앱 제안 · {proposal.title}</p>
      {proposal.summary && <p className="mt-1 text-muted-foreground">{proposal.summary}</p>}
      <button type="button" disabled={pending || !api.approveCard} onClick={() => void approve()}
        className="mt-2 rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground disabled:opacity-60">
        {pending ? '접수 중…' : proposal.retryable ? '다시 접수' : 'OK · 개발 시작'}
      </button>
    </> : acceptances.length === 0 && <p role="status">제안 진행 상태 확인 · <a href="/board" className="text-primary underline">미니 보드 보기</a></p>}
    {error && <p role="alert" className="mt-2 text-destructive">{error}</p>}
  </section>;
}
