'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { approvalErrorText, createMergeApprovalsApi, type ApprovalGate, type MergeApproval } from '@/lib/merge-approvals-api';
import { mergeabilityButtonLabel, pollMergeabilityUntilKnown } from './approval-brief';
import { ApprovalsLoading } from './ApprovalsLoading';

type Card = MergeApproval & { merged?: boolean };
type ApprovalsApi = ReturnType<typeof createMergeApprovalsApi>;
export type ApprovalView = 'open' | 'merged';

export function updatedApprovalCard(card: Card, detail: MergeApproval, expectedHead: string): Card {
  if (card.number !== detail.number || card.headSha !== expectedHead) return card;
  return { ...detail, gate: detail.headSha === expectedHead ? detail.gate : { status: 'none', failures: [] }, merged: card.merged };
}

export function mergedBadge(mergedAt: string | null | undefined): string {
  if (!mergedAt) return '머지됨';
  const at = new Date(mergedAt);
  if (Number.isNaN(at.getTime())) return '머지됨';
  const kst = new Date(at.getTime() + 9 * 3_600_000).toISOString();
  return `머지됨 ${kst.slice(5, 10)} ${kst.slice(11, 16)} KST`;
}

export function ApprovalViewTabs({ view, onChange }: { view: ApprovalView; onChange: (view: ApprovalView) => void }) {
  const tab = (value: ApprovalView, label: string) => (
    <button type="button" role="tab" aria-selected={view === value} onClick={() => onChange(value)}
      className={`rounded-md px-3 py-1 text-sm ${view === value ? 'bg-foreground text-background' : 'bg-muted text-foreground'}`}>{label}</button>
  );
  return <div role="tablist" aria-label="승인 목록 보기" className="flex gap-2">{tab('open', '승인 대기')}{tab('merged', '완료')}</div>;
}

export function ApprovalNarrative({ brief, lineage, summary }: Pick<MergeApproval, 'brief' | 'lineage' | 'summary'>) {
  return <>
    {brief !== null ? <section aria-label="승인 요약" className="mt-3 break-words text-sm leading-relaxed [&_a]:text-blue-600 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_h3]:mt-3 [&_h3]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_p]:my-2 [&_table]:block [&_table]:overflow-x-auto">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{brief}</ReactMarkdown>
    </section> : <>
      <p className="mt-3 rounded border border-amber-500/40 bg-amber-500/15 p-3 text-sm text-amber-800 dark:text-amber-300">승인 요약 내용이 없습니다 — GitHub 본문을 보거나 발사자에게 요청하세요</p>
      <p className="mt-3 whitespace-pre-wrap text-sm">{summary}</p>
    </>}
    {lineage && <p className="mt-3 text-sm text-muted-foreground">아이디어 원장: {lineage}</p>}
  </>;
}

export function ApprovalGateControls({ gate, busy, blocked, mergeLabel, onCheck, onMerge }: { gate: ApprovalGate; busy: boolean; blocked?: boolean; mergeLabel?: string; onCheck: () => void; onMerge: () => void }) {
  return <div className="mt-3 space-y-2" aria-label="머지 전 검사">
    {gate.status === 'none' && <button type="button" onClick={onCheck} disabled={busy} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50">머지 전 검사 시작</button>}
    {gate.status === 'running' && <p role="status" className="text-sm">검사 중…</p>}
    {gate.status === 'passed' && <p className="text-sm text-green-700 dark:text-green-400">검사 통과 ({gate.os ?? 'unknown'}){gate.baseDrifted ? ' · 검사 뒤 main 이 움직였다 — 머지 때 겹치는 파일이 있으면 다시 검사를 요구한다' : ''}</p>}
    {(gate.status === 'failed' || gate.status === 'unmeasured') && <div role="alert" className="text-sm text-red-600">
      <p>{gate.status === 'failed' ? '검사 실패' : '검사 측정 불가'}</p>
      <ul className="list-inside list-disc">{gate.failures.map((failure, index) => <li key={index}>{failure}</li>)}</ul>
      <button type="button" onClick={onCheck} disabled={busy} className="mt-2 rounded-lg border px-3 py-2 disabled:opacity-50">머지 전 검사 다시 시작</button>
    </div>}
    <button type="button" onClick={onMerge} disabled={busy || blocked || gate.status !== 'passed'} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">{mergeLabel ?? '승인하고 머지'}</button>
  </div>;
}

function MergeabilityPoller({ card, api, attempt, onAttempt, onUpdate }: { card: Card; api: ApprovalsApi; attempt: number; onAttempt: (number: number) => void; onUpdate: (detail: MergeApproval, expectedHead: string) => void }) {
  const unknown = card.mergeable === 'UNKNOWN' && !card.merged && card.state === 'OPEN';
  useEffect(() => {
    if (!unknown || attempt > 0) return;
    let active = true;
    const timers: number[] = [];
    void pollMergeabilityUntilKnown(() => api.get(card.number), {
      sleep: (ms) => new Promise((resolve) => { timers.push(window.setTimeout(resolve, ms)); }),
      isActive: () => active,
      onDetail: (detail) => { if (active) onUpdate(detail, card.headSha); },
      onAttempt: () => { if (active) onAttempt(card.number); },
    });
    return () => { active = false; for (const timer of timers) window.clearTimeout(timer); };
  }, [api, card.number, unknown, attempt, onAttempt, onUpdate]);
  return null;
}

export function MergeApprovals() {
  const { client } = useDaemon();
  const api = useMemo(() => createMergeApprovalsApi({ client }), [client]);
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ text: string; href?: string } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [cardError, setCardError] = useState<Record<number, string>>({});
  const [pollAttempts, setPollAttempts] = useState<Record<number, number>>({});
  const [expanded, setExpanded] = useState<number | null>(null);
  const [view, setView] = useState<ApprovalView>('open');
  const countPoll = useCallback((number: number) => {
    setPollAttempts((previous) => ({ ...previous, [number]: (previous[number] ?? 0) + 1 }));
  }, []);
  const updateCard = useCallback((detail: MergeApproval, expectedHead: string) => {
    setCards((previous) => previous.map((card) => updatedApprovalCard(card, detail, expectedHead)));
  }, []);
  useEffect(() => {
    const observed = cards.filter((card) => card.state === 'OPEN' && (card.gate.status === 'running' || card.gate.status === 'passed'));
    if (view !== 'open' || !observed.length) return;
    let active = true;
    const timer = window.setInterval(() => {
      for (const card of observed) {
        void api.get(card.number).then((detail) => { if (active) updateCard(detail, card.headSha); })
          .catch((err: unknown) => { if (active) setCardError((previous) => ({ ...previous, [card.number]: approvalErrorText(err, '검사 상태를 불러오지 못했습니다.').text })); });
      }
    }, 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [api, cards, updateCard, view]);

  useEffect(() => {
    let active = true;
    const selected = Number(new URLSearchParams(window.location.search).get('pr'));
    const target = Number.isSafeInteger(selected) && selected > 0 ? selected : null;
    setLoading(true);
    setError(null);
    setExpanded(target);
    if (view === 'merged') {
      api.list('merged').then(({ items }) => { if (active) setCards(items); })
        .catch((err: unknown) => { if (active) setError(approvalErrorText(err, '목록을 불러오지 못했습니다.')); })
        .finally(() => { if (active) setLoading(false); });
      return () => { active = false; };
    }
    api.list().then(async ({ items }) => {
      if (!active) return;
      const present = items.find((item) => item.number === target);
      if (target && !present) {
        try {
          const detail = await api.get(target);
          if (active) setCards([detail, ...items]);
        } catch (err) {
          if (active) setError(approvalErrorText(err, 'PR 을 불러오지 못했습니다.'));
          if (active) setCards(items);
        }
      } else setCards(target ? [...items].sort((a, b) => Number(b.number === target) - Number(a.number === target)) : items);
    }).catch((err: unknown) => {
      if (active) setError(approvalErrorText(err, '목록을 불러오지 못했습니다.'));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, view]);

  async function check(card: Card) {
    setBusy(card.number);
    setCardError((previous) => ({ ...previous, [card.number]: '' }));
    try {
      const { gate } = await api.check(card.number, card.headSha);
      setCards((previous) => previous.map((item) => item.number === card.number && item.headSha === card.headSha ? { ...item, gate } : item));
    } catch (err) {
      setCardError((previous) => ({ ...previous, [card.number]: approvalErrorText(err, '검사를 시작하지 못했습니다.').text }));
    } finally { setBusy(null); }
  }

  async function approve(card: Card) {
    if (!window.confirm(`#${card.number} ${card.title}\n현재 확인한 변경을 승인하고 머지할까요?`)) return;
    setBusy(card.number);
    setCardError((previous) => ({ ...previous, [card.number]: '' }));
    try {
      await api.merge(card.number, card.headSha);
      setCards((previous) => previous.map((item) => item.number === card.number ? { ...item, merged: true, state: 'MERGED' } : item));
    } catch (err) {
      setCardError((previous) => ({ ...previous, [card.number]: approvalErrorText(err, '머지하지 못했습니다.').text }));
    } finally { setBusy(null); }
  }

  return <main className="mx-auto max-w-3xl space-y-5 p-4 pb-20 text-foreground sm:p-8">
    <header><h1 className="text-2xl font-semibold">Approvals</h1><p className="text-sm text-muted-foreground">아이디어 PR 변경 사항을 확인하고 승인합니다.</p></header>
    <ApprovalViewTabs view={view} onChange={(next) => { setCards([]); setView(next); }} />
    {loading && <ApprovalsLoading view={view} target={expanded} />}
    {error && <p role="alert" className="text-red-600" data-approvals-error>{error.text}{error.href && <> <a href={error.href} className="font-semibold underline underline-offset-2" data-approvals-settings>설정 열기 →</a></>}</p>}
    {!loading && !cards.length && !error && <p>{view === 'merged' ? '승인해 머지된 아이디어 PR 이 아직 없습니다.' : '승인을 기다리는 PR 이 없습니다.'}</p>}
    {cards.map((card) => {
      const merged = card.merged || card.state === 'MERGED';
      const closed = card.state !== 'OPEN' && !merged;
      const blocked = card.draft ? '초안 PR 은 머지할 수 없습니다. GitHub에서 초안을 해제한 뒤 다시 확인하세요.' : card.checks.failure > 0 ? '실패한 검사가 있습니다.' : card.checks.pending > 0 ? '검사가 아직 끝나지 않았습니다.' : card.mergeable === 'CONFLICTING' ? '머지 충돌이 있습니다.' : card.mergeable !== 'MERGEABLE' ? '머지 가능 여부가 아직 확인되지 않았습니다.' : card.base !== 'main' ? '대상 브랜치가 main 이 아닙니다.' : '';
      const open = expanded === card.number;
      const attempt = pollAttempts[card.number] ?? 0;
      return <article key={card.number} className={`rounded-xl border bg-card p-5 shadow-sm ${open ? 'border-blue-500 ring-2 ring-blue-500/30' : 'border-border'}`}>
        <MergeabilityPoller card={card} api={api} attempt={attempt} onAttempt={countPoll} onUpdate={updateCard} />
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 className="font-semibold">#{card.number} · {card.title}</h2>
          <span className="rounded bg-muted px-2 py-1 text-xs">{merged ? mergedBadge(card.mergedAt) : closed ? '닫힘' : card.draft ? '초안' : '열림'}</span>
        </div>
        <ApprovalNarrative brief={card.brief} lineage={card.lineage} summary={card.summary} />
        <p className="mt-3 text-sm text-muted-foreground">+{card.additions} 추가 / −{card.deletions} 삭제 · 파일 {card.changedFiles}</p>
        <div className="mt-2 flex flex-wrap gap-2 text-xs" aria-label="검사 상태">
          <span className="rounded bg-green-500/15 px-2 py-1">성공 {card.checks.success}</span>
          <span className="rounded bg-red-500/15 px-2 py-1">실패 {card.checks.failure}</span>
          <span className="rounded bg-yellow-500/15 px-2 py-1">대기 {card.checks.pending}</span>
          {card.checks.success + card.checks.failure + card.checks.pending === 0 && <span className="rounded bg-slate-500/15 px-2 py-1">GitHub 검사 없음 — 머지 전 검사는 아래에서 별도로 실행</span>}
        </div>
        <details open={open} className="mt-3 text-sm"><summary className="cursor-pointer">바뀐 파일 보기</summary>
          <ul className="mt-2 list-inside list-disc break-all">{card.files.map((file) => <li key={file}>{file}</li>)}</ul>
        </details>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <a className="text-sm text-blue-600 underline" href={card.url} target="_blank" rel="noopener noreferrer">GitHub 에서 보기</a>
          {!merged && !closed && <ApprovalGateControls gate={card.gate} busy={busy !== null} blocked={!!blocked} mergeLabel={busy === card.number ? '머지 중…' : mergeabilityButtonLabel(attempt, card.mergeable)} onCheck={() => check(card)} onMerge={() => approve(card)} />}
        </div>
        {blocked && !merged && !closed && <p className="mt-2 text-sm text-amber-600">{blocked}{card.mergeable === 'UNKNOWN' && attempt >= 3 ? ' 자동 확인이 끝났습니다. 최신 상태는 페이지를 새로고침하세요.' : ''}</p>}
        {cardError[card.number] && <p role="alert" className="mt-2 text-sm text-red-600">{cardError[card.number]}</p>}
      </article>;
    })}
  </main>;
}
