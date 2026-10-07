'use client';

import { useEffect, useRef, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { decide, listOpenDecisions, type OpenDecision } from '@/lib/decisions-api';

type Outcome = { label: string; at?: string };
type BoardState = { items: OpenDecision[]; error: string | null; loading: boolean };

export function sortOpenDecisions(items: OpenDecision[]): OpenDecision[] {
  return [...items].sort((a, b) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity)
    || (a.raisedAt ?? '').localeCompare(b.raisedAt ?? '') || a.id.localeCompare(b.id));
}

const kst = (at: string) => new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(at));
const field = (value?: string) => value?.trim() || '(비움)';
const noteText = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 300);

export function DecisionBoard() {
  const { client } = useDaemon();
  const [board, setBoard] = useState<BoardState>({ items: [], error: null, loading: true });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<{ id: string; key: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const pending = useRef<string | null>(null);
  const readSequence = useRef(0);
  const activeClient = useRef(client);
  activeClient.current = client;

  useEffect(() => {
    let active = true;
    pending.current = null;
    const sequence = ++readSequence.current;
    setBoard({ items: [], error: null, loading: true });
    setNotes({}); setConfirm(null); setBusy(null); setOutcomes({}); setErrors({});
    void listOpenDecisions(client).then(items => {
      if (active && readSequence.current === sequence) setBoard({ items: sortOpenDecisions(items), error: null, loading: false });
    }).catch(error => {
      if (active && readSequence.current === sequence) setBoard({ items: [], error: error instanceof Error ? error.message : String(error), loading: false });
    });
    return () => { active = false; ++readSequence.current; };
  }, [client]);

  const choose = async (item: OpenDecision, key: string, confirmed = false) => {
    if (pending.current || outcomes[item.id]) return;
    if (item.irreversible && (!confirmed || confirm?.id !== item.id || confirm.key !== key)) {
      setConfirm({ id: item.id, key });
      return;
    }
    const sequence = readSequence.current;
    pending.current = item.id;
    setBusy(item.id);
    setConfirm(null);
    setErrors(previous => ({ ...previous, [item.id]: '' }));
    try {
      const result = await decide(client, item.id, key, noteText(notes[item.id] ?? '') || undefined);
      if (activeClient.current !== client || readSequence.current !== sequence) return;
      const label = item.options.find(option => option.id === key)?.label ?? key;
      setOutcomes(previous => ({ ...previous, [item.id]: { label, at: result.decidedAt } }));
    } catch (error) {
      if (activeClient.current !== client || readSequence.current !== sequence) return;
      const message = error instanceof Error ? error.message : String(error);
      setErrors(previous => ({ ...previous, [item.id]: message.includes('decision failed: 409') ? '이미 결정됨'
        : message.includes('decision failed: 404') ? '사라진 결정' : `결정 실패 · ${message}` }));
    } finally {
      if (activeClient.current === client && readSequence.current === sequence) {
        pending.current = null;
        setBusy(null);
      }
    }
  };

  return <main className="mx-auto w-full max-w-3xl px-3 py-5 text-foreground sm:px-6">
    <header className="mb-5"><p className="text-xs text-muted-foreground">운영 · 결정</p><h1 className="text-xl font-semibold">결정 대기 카드</h1></header>
    {board.loading ? <p role="status">읽는 중</p> : board.error ? <p role="alert">못 읽음 · {board.error}</p>
      : board.items.length === 0 ? <p>열린 결정이 없습니다.</p> : <ol className="space-y-4">
        {board.items.map(item => {
          const outcome = outcomes[item.id];
          const selected = confirm?.id === item.id ? item.options.find(option => option.id === confirm.key) : undefined;
          const recommendation = item.recommendation;
          return <li key={item.id} className="min-w-0 rounded-xl border border-border bg-card p-4">
            {outcome ? <details><summary className="cursor-pointer font-medium">결정됨: {outcome.label} · {outcome.at ? `${kst(outcome.at)} KST` : '시각 미상'}</summary>
              <p className="mt-2 text-sm">{item.title}</p></details> : <article aria-label={item.title} className="space-y-3 break-words">
              <div><h2 className="text-lg font-semibold">{item.title}</h2><p className="text-sm text-muted-foreground">올린 자리: {item.raisedBy?.agent ?? '(비움)'}{item.raisedBy?.track ? `(${item.raisedBy.track})` : ''}</p>
                {item.category && <p className="text-sm text-muted-foreground">분류: {item.category}</p>}
                {item.irreversible && <p className="font-medium text-amber-700">⚠️ 되돌릴 수 없음</p>}</div>
              <dl className="space-y-1 text-sm">{(['s', 'c', 'q', 'a'] as const).map(key => <div key={key} className="flex gap-2"><dt className="font-semibold">{key.toUpperCase()}:</dt><dd className="min-w-0 whitespace-pre-wrap">{field(item.scqa?.[key] ?? (key === 's' ? item.situation : undefined))}</dd></div>)}</dl>
              <p className="text-sm font-medium">{'skipped' in recommendation ? `권고 없음: ${recommendation.reason}`
                : `권고: ${item.options.find(option => option.id === recommendation.option)?.label ?? recommendation.option} — ${recommendation.why}`}</p>
              {item.alternative && <p className="text-sm">대안: {item.options.find(option => option.id === item.alternative)?.label ?? item.alternative}</p>}
              <ul className="space-y-2">{item.options.map(option => <li key={option.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-2 text-sm">
                <span>{option.id.toUpperCase()}) {option.label} — {field(option.consequence)}</span>
                <button type="button" disabled={busy !== null} onClick={() => { void choose(item, option.id); }} className="rounded-md border border-border px-3 py-1 font-medium hover:bg-muted disabled:opacity-50">{option.label} 선택</button>
              </li>)}</ul>
              <p className="text-sm">{item.crossCheck?.length ? `교차 확인: ${item.crossCheck.map(check => `${check.seat} ✓ ${check.note}${check.at ? ` · ${kst(check.at)} KST` : ''}`).join(' · ')}` : `교차 확인 없음(${item.crossCheckSkipped ?? '미기재'})`}</p>
              {item.dissent && <p className="text-sm">이견: {item.dissent}</p>}
              {item.dueAt && <p className="text-sm">기한: <time dateTime={item.dueAt}>{kst(item.dueAt)} KST</time></p>}
              {item.pendingQuestion && <details className="text-sm"><summary className="cursor-pointer">대기 질문 전문</summary><p className="mt-2 whitespace-pre-wrap">{item.pendingQuestion}</p></details>}
              <label className="block text-sm">한 줄 의견 (최대 300자)
                <input type="text" maxLength={300} value={notes[item.id] ?? ''} onChange={event => setNotes(previous => ({ ...previous, [item.id]: event.target.value.slice(0, 300) }))}
                  className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2" />
              </label>
              {selected && <div role="alert" className="rounded-md border border-amber-600 p-2 text-sm">
                <p>되돌릴 수 없습니다 — 이것으로 정할까요? ({selected.label})</p>
                <button type="button" disabled={busy !== null} onClick={() => { void choose(item, selected.id, true); }} className="mr-3 underline">예, 결정</button>
                <button type="button" onClick={() => setConfirm(null)} className="underline">취소</button>
              </div>}
              {busy === item.id && <p role="status">기록 중</p>}
              {errors[item.id] && <p role="alert">{errors[item.id]}</p>}
            </article>}
          </li>;
        })}
      </ol>}
  </main>;
}
