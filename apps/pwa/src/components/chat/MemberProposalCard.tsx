'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MemberMiniBoardApi } from '@/lib/member-mini-board-api';
import { rowsForVerifiedMember, rowsFromApi, type MemberBoardCard } from '@/components/member-board/member-board-model';

/** The verified member's pending app proposal is the chat surface's explicit OK action. */
export function MemberProposalCard({ api }: { api: MemberMiniBoardApi | null }) {
  const currentApi = useRef(api);
  currentApi.current = api;
  const [sourceApi, setSourceApi] = useState<MemberMiniBoardApi | null>(null);
  const [proposal, setProposal] = useState<MemberBoardCard | null>(null);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acceptances, setAcceptances] = useState<Array<{ cardId: string; title: string; acceptanceId: string }>>([]);
  const refresh = useCallback(async () => {
    if (!api) return;
    const owner = await api.getVerifiedOwner();
    const board = await api.getBoard();
    if (currentApi.current !== api) return;
    setSourceApi(api);
    setMemberId(owner.memberId);
    setProposal(rowsForVerifiedMember(rowsFromApi<MemberBoardCard>(board, 'cards'), owner.memberId)
      .find(card => card.state === 'proposed' || card.retryable === true) ?? null);
  }, [api]);

  useEffect(() => {
    let active = true;
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
    setPending(true);
    setError(null);
    try {
      const result = await api.approveCard(proposal.id);
      if (result.dispatch?.acceptanceId) setAcceptances(previous => [...previous, { cardId: proposal.id, title: proposal.title, acceptanceId: result.dispatch!.acceptanceId }]);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      try { await refresh(); } catch { /* Keep the approval error visible. */ }
    } finally { setPending(false); }
  };
  return <section aria-label="앱 제안 승인" className="mx-4 mb-3 rounded-lg border border-border bg-card p-3 text-sm">
    {acceptances.length > 0 && <ul aria-label="하니스 접수 내역" className="mb-2 space-y-1">
      {acceptances.map(item => <li key={`${item.cardId}:${item.acceptanceId}`} role="status">
        {item.title} · 하니스 요청 접수 {item.acceptanceId} · <a href="/board" className="text-primary underline">미니 보드 보기</a>
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
