'use client';

import { useEffect, useMemo, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { createMergeApprovalsApi, type MergeApproval } from '@/lib/merge-approvals-api';

type Card = MergeApproval & { merged?: boolean };

export function MergeApprovals() {
  const { client } = useDaemon();
  const api = useMemo(() => createMergeApprovalsApi({ client }), [client]);
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const [cardError, setCardError] = useState<Record<number, string>>({});
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    const selected = Number(new URLSearchParams(window.location.search).get('pr'));
    const target = Number.isSafeInteger(selected) && selected > 0 ? selected : null;
    setLoading(true);
    setError('');
    setExpanded(target);
    api.list().then(async ({ items }) => {
      if (!active) return;
      const present = items.find((item) => item.number === target);
      if (target && !present) {
        try {
          const detail = await api.get(target);
          if (active) setCards([detail, ...items]);
        } catch (err) {
          if (active) setError(err instanceof Error ? err.message : 'PR 을 불러오지 못했습니다.');
          if (active) setCards(items);
        }
      } else setCards(target ? [...items].sort((a, b) => Number(b.number === target) - Number(a.number === target)) : items);
    }).catch((err: unknown) => {
      if (active) setError(err instanceof Error ? err.message : '목록을 불러오지 못했습니다.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api]);

  async function approve(card: Card) {
    if (!window.confirm(`#${card.number} ${card.title}\n현재 확인한 변경을 승인하고 머지할까요?`)) return;
    setBusy(card.number);
    setCardError((previous) => ({ ...previous, [card.number]: '' }));
    try {
      await api.merge(card.number, card.headSha);
      setCards((previous) => previous.map((item) => item.number === card.number ? { ...item, merged: true, state: 'MERGED' } : item));
    } catch (err) {
      setCardError((previous) => ({ ...previous, [card.number]: err instanceof Error ? err.message : '머지하지 못했습니다.' }));
    } finally { setBusy(null); }
  }

  return <main className="mx-auto max-w-3xl space-y-5 p-4 pb-20 text-foreground sm:p-8">
    <header><h1 className="text-2xl font-semibold">Approvals</h1><p className="text-sm text-muted-foreground">아이디어 PR 변경 사항을 확인하고 승인합니다.</p></header>
    {loading && <p role="status">승인 목록을 불러오는 중…</p>}
    {error && <p role="alert" className="text-red-600">{error}</p>}
    {!loading && !cards.length && !error && <p>승인할 PR 이 없다</p>}
    {cards.map((card) => {
      const merged = card.merged || card.state === 'MERGED';
      const closed = card.state !== 'OPEN' && !merged;
      const blocked = card.draft ? '초안 PR 은 머지할 수 없습니다. GitHub에서 초안을 해제한 뒤 다시 확인하세요.' : card.checks.failure > 0 ? '실패한 검사가 있습니다.' : card.checks.pending > 0 ? '검사가 아직 끝나지 않았습니다.' : card.mergeable === 'CONFLICTING' ? '머지 충돌이 있습니다.' : card.mergeable !== 'MERGEABLE' ? '머지 가능 여부가 아직 확인되지 않았습니다.' : card.base !== 'main' ? '대상 브랜치가 main 이 아닙니다.' : '';
      const open = expanded === card.number;
      return <article key={card.number} className={`rounded-xl border bg-card p-5 shadow-sm ${open ? 'border-blue-500 ring-2 ring-blue-500/30' : 'border-border'}`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 className="font-semibold">#{card.number} · {card.title}</h2>
          <span className="rounded bg-muted px-2 py-1 text-xs">{merged ? '머지됨' : closed ? '닫힘' : card.draft ? '초안' : '열림'}</span>
        </div>
        <p className="mt-3 whitespace-pre-wrap text-sm">{card.summary}</p>
        <p className="mt-3 text-sm text-muted-foreground">+{card.additions} 추가 / −{card.deletions} 삭제 · 파일 {card.changedFiles}</p>
        <div className="mt-2 flex flex-wrap gap-2 text-xs" aria-label="검사 상태">
          <span className="rounded bg-green-500/15 px-2 py-1">성공 {card.checks.success}</span>
          <span className="rounded bg-red-500/15 px-2 py-1">실패 {card.checks.failure}</span>
          <span className="rounded bg-yellow-500/15 px-2 py-1">대기 {card.checks.pending}</span>
          {card.checks.success + card.checks.failure + card.checks.pending === 0 && <span className="rounded bg-slate-500/15 px-2 py-1">GitHub 검사 없음 — 하니스 게이트 결과는 PR 본문</span>}
        </div>
        <details open={open} className="mt-3 text-sm"><summary className="cursor-pointer">바뀐 파일 보기</summary>
          <ul className="mt-2 list-inside list-disc break-all">{card.files.map((file) => <li key={file}>{file}</li>)}</ul>
        </details>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <a className="text-sm text-blue-600 underline" href={card.url} target="_blank" rel="noopener noreferrer">GitHub 에서 보기</a>
          {!merged && !closed && <button type="button" onClick={() => approve(card)} disabled={!!blocked || busy !== null} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">{busy === card.number ? '머지 중…' : '승인하고 머지'}</button>}
        </div>
        {blocked && !merged && !closed && <p className="mt-2 text-sm text-amber-600">{blocked}</p>}
        {cardError[card.number] && <p role="alert" className="mt-2 text-sm text-red-600">{cardError[card.number]}</p>}
      </article>;
    })}
  </main>;
}
