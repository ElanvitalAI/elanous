'use client';

import { useEffect, useRef, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { decide, listOpenDecisions, listBoardNotices, replyToBoardNotice, type BoardNotice, type OpenDecision } from '@/lib/decisions-api';

type Outcome = { label: string; at?: string };

type BoardState = { items: OpenDecision[]; error: string | null; loading: boolean };

const LEDGER_CELLS = [
  { key: 'what', label: '무엇' },
  { key: 'history', label: '지금까지' },
  { key: 'precedent', label: '이전 같은 갈래 결정' },
  { key: 'remeasure', label: '지금 상태 재측' },
  { key: 'options', label: '선택지별 결과' },
  { key: 'recommendation', label: '권고와 근거' },
  { key: 'doNothing', label: '그냥 두면' },
] as const;
type LedgerCellKey = (typeof LEDGER_CELLS)[number]['key'];

export function sortOpenDecisions(items: OpenDecision[]): OpenDecision[] {
  return [...items].sort((a, b) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity)
    || (a.raisedAt ?? '').localeCompare(b.raisedAt ?? '') || a.id.localeCompare(b.id));
}

const kst = (at: string) => new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(at));
const field = (value?: string) => value?.trim() || '(비움)';
const noteText = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 300);

const stamp = (at?: string) => (at ? `${kst(at)} KST` : '시각 미상');

const HISTORY_LABELS: Record<string, string> = { raised: '올림', 'options-added': '선택지 추가', decided: '결정', withdrawn: '철회' };

function ledgerCellText(card: OpenDecision, key: LedgerCellKey): string {
  switch (key) {
    case 'what': return card.title?.trim() || '미기재';
    case 'history': {
      const events = card.history ?? [];
      if (events.length === 0) return `원장 기록 없음 · 제기 ${stamp(card.raisedAt)}`;
      return events.map(event => [
        stamp(event.at),
        event.by,
        HISTORY_LABELS[event.type] ?? event.type,
        ...(event.choice ? [`→ ${event.choice}`] : []),
        ...(event.reason?.trim() ? [`· ${event.reason.trim()}`] : []),
      ].join(' ')).join('\n');
    }
    case 'precedent': {
      const precedent = card.precedent;
      if (!precedent) return '이전 같은 갈래 결정 없음';
      const who = precedent.decidedBy === 'human' ? '대표 결정'
        : precedent.decidedBy === 'auto' ? '자율 결정'
        : '결정 주체 미상';
      return [`${precedent.title} → ${precedent.choice}`, stamp(precedent.decidedAt), who].join(' · ');
    }
    case 'remeasure': {
      const checks = card.crossCheck ?? [];
      const latest = checks.length > 0 ? checks[checks.length - 1] : undefined;
      if (!latest) return `교차 확인 없음 · ${card.crossCheckSkipped?.trim() || '사유 미기재'}`;
      return [`${latest.seat} 교차 확인`, stamp(latest.at), latest.note?.trim() || '메모 미기재'].join(' · ');
    }
    case 'options': return card.options.map(option => `${option.id.toUpperCase()}) ${option.label} — ${field(option.consequence)}`).join('\n');
    case 'recommendation': {
      const recommendation = card.recommendation;
      if ('skipped' in recommendation) return `권고 없음: ${recommendation.reason}`;
      const label = card.options.find(option => option.id === recommendation.option)?.label ?? recommendation.option;
      return `${label} — ${recommendation.why}`;
    }
    case 'doNothing': {
      const window = card.dueAt ? `기한 ${stamp(card.dueAt)} 이 지나면 열린 채로 남습니다` : '기한 없음 — 그대로 두면 계속 열린 채로 남습니다';
      return card.irreversible ? `${window} · 되돌릴 수 없는 결정입니다` : window;
    }
  }
}

export function DecisionBoard() {
  const { client } = useDaemon();
  const [board, setBoard] = useState<BoardState>({ items: [], error: null, loading: true });
  const [tab, setTab] = useState<'decisions' | 'notices'>('decisions');
  const [noticeRefresh, setNoticeRefresh] = useState(0);
  const [notices, setNotices] = useState<{ items: BoardNotice[]; loading: boolean; error: string | null }>({ items: [], loading: false, error: null });
  const [replyDrafts, setReplyDrafts] = useState<Record<number, string>>({});
  const [replyBusy, setReplyBusy] = useState<number | null>(null);
  const [replyStatus, setReplyStatus] = useState<Record<number, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<{ id: string; key: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [opOnly, setOpOnly] = useState(false);
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [cellFolded, setCellFolded] = useState<Record<string, boolean>>({});
  const [bulkArm, setBulkArm] = useState(false);
  const [bulkStatus, setBulkStatus] = useState('');
  const pending = useRef<string | null>(null);
  const readSequence = useRef(0);
  const activeClient = useRef(client);
  activeClient.current = client;

  useEffect(() => {
    if (tab !== 'notices') return;
    let active = true;
    setNotices({ items: [], loading: true, error: null });
    void listBoardNotices(client).then(items => {
      if (active) setNotices({ items, loading: false, error: null });
    }).catch(error => {
      if (active) setNotices({ items: [], loading: false, error: error instanceof Error ? error.message : String(error) });
    });
    return () => { active = false; };
  }, [client, tab, noticeRefresh]);

  const replyPending = useRef(false);
  const sendReply = async (notice: BoardNotice) => {
    const body = (replyDrafts[notice.id] ?? '').trim();
    if (!body || replyPending.current) return;
    replyPending.current = true;
    setReplyBusy(notice.id);
    setReplyStatus(previous => ({ ...previous, [notice.id]: '' }));
    try {
      await replyToBoardNotice(client, notice.id, body);
      if (activeClient.current !== client) return;
      setReplyDrafts(previous => ({ ...previous, [notice.id]: '' }));
      setReplyStatus(previous => ({ ...previous, [notice.id]: `${notice.from} 수신함으로 보냄` }));
    } catch (error) {
      if (activeClient.current === client) setReplyStatus(previous => ({ ...previous, [notice.id]: `전송 실패 · ${error instanceof Error ? error.message : String(error)}` }));
    } finally {
      replyPending.current = false;
      if (activeClient.current === client) setReplyBusy(null);
    }
  };

  useEffect(() => {
    let active = true;
    pending.current = null;
    const sequence = ++readSequence.current;
    setBoard({ items: [], error: null, loading: true });
    setNotes({}); setConfirm(null); setBusy(null); setOutcomes({}); setErrors({});
    setOpOnly(false); setBulkArm(false); setBulkStatus(''); setFolded({}); setCellFolded({});
    setReplyDrafts({}); setReplyBusy(null); setReplyStatus({});
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
      setBulkArm(false);
      setBulkStatus('');
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

  const visibleItems = opOnly ? board.items.filter(item => item.raisedBy?.agent === 'OP') : board.items;

  const decideAllRecommended = async () => {
    if (pending.current) return;
    const targets = visibleItems.filter((item): item is OpenDecision & { recommendation: { option: string; why: string } } =>
      !('skipped' in item.recommendation) && !outcomes[item.id]);
    if (targets.length === 0) { setBulkArm(false); setBulkStatus('권고가 있는 대기 결정이 없습니다'); return; }
    const irreversibleCount = targets.filter(item => item.irreversible).length;
    if (irreversibleCount > 0 && !bulkArm) {
      setBulkArm(true);
      setBulkStatus(`되돌릴 수 없는 결정 ${irreversibleCount}건 포함 — 다시 누르면 권고대로 일괄 결정합니다`);
      return;
    }
    setBulkArm(false);
    setBulkStatus('');
    const sequence = readSequence.current;
    pending.current = 'bulk';
    setBusy('bulk');
    let done = 0;
    try {
      for (const target of targets) {
        try {
          const result = await decide(client, target.id, target.recommendation.option, noteText(notes[target.id] ?? '') || undefined);
          if (activeClient.current !== client || readSequence.current !== sequence) return;
          const label = target.options.find(option => option.id === target.recommendation.option)?.label ?? target.recommendation.option;
          setOutcomes(previous => ({ ...previous, [target.id]: { label, at: result.decidedAt } }));
          done += 1;
        } catch (error) {
          if (activeClient.current !== client || readSequence.current !== sequence) return;
          const message = error instanceof Error ? error.message : String(error);
          setErrors(previous => ({ ...previous, [target.id]: message.includes('decision failed: 409') ? '이미 결정됨'
            : message.includes('decision failed: 404') ? '사라진 결정' : `결정 실패 · ${message}` }));
        }
      }
      if (activeClient.current !== client || readSequence.current !== sequence) return;
      setBulkStatus(`권고대로 ${done}건을 일괄 결정했습니다`);
    } finally {
      if (activeClient.current === client && readSequence.current === sequence) {
        pending.current = null;
        setBusy(null);
      }
    }
  };

  return <main className="mx-auto w-full max-w-3xl px-3 py-5 text-foreground sm:px-6">
    <header className="mb-5"><p className="text-xs text-muted-foreground">운영 · 결정</p><h1 className="text-xl font-semibold">결정 대기 카드</h1></header>
    <nav aria-label="운영 게시판" className="mb-4 flex gap-2">
      <button type="button" aria-current={tab === 'decisions' ? 'page' : undefined} onClick={() => setTab('decisions')} className="rounded-md border border-border px-3 py-2">결정</button>
      <button type="button" aria-current={tab === 'notices' ? 'page' : undefined} onClick={() => setTab('notices')} className="rounded-md border border-border px-3 py-2">공지 · 의견</button>
      {tab === 'notices' && <button type="button" onClick={() => setNoticeRefresh(value => value + 1)} className="rounded-md border border-border px-3 py-2">공지 새로고침</button>}
    </nav>
    {tab === 'notices' ? <section aria-label="공지 · 의견">
      {notices.loading ? <p role="status">공지 읽는 중</p> : notices.error ? <p role="alert">공지 못 읽음 · {notices.error}</p>
        : notices.items.length === 0 ? <p>도착한 공지가 없습니다.</p> : <ol className="space-y-4">{notices.items.map(notice => <li key={notice.id} className="rounded-xl border border-border bg-card p-4">
          <p className="text-sm text-muted-foreground">{notice.from} → 대표 · {notice.kind ?? '공지'} · <time dateTime={notice.createdAt}>{kst(notice.createdAt)} KST</time></p>
          <p className="my-3 whitespace-pre-wrap break-words">{notice.body}</p>
          <label className="block text-sm">{notice.from} 자리에게 답글
            <textarea maxLength={3000} value={replyDrafts[notice.id] ?? ''} onChange={event => setReplyDrafts(previous => ({ ...previous, [notice.id]: event.target.value }))} className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2" />
          </label>
          <button type="button" disabled={replyBusy !== null || !(replyDrafts[notice.id] ?? '').trim()} onClick={() => { void sendReply(notice); }} className="mt-2 rounded-md border border-border px-3 py-1 disabled:opacity-50">답글 보내기</button>
          {replyStatus[notice.id] && <p role="status">{replyStatus[notice.id]}</p>}
        </li>)}</ol>}
    </section> : board.loading ? <p role="status">읽는 중</p> : board.error ? <p role="alert">못 읽음 · {board.error}</p>
      : <div>
        <div className="mb-3 flex flex-wrap gap-2">
          <button type="button" aria-pressed={opOnly} onClick={() => { setOpOnly(value => !value); setBulkArm(false); setBulkStatus(''); }} className={`rounded-md border border-border px-3 py-1${opOnly ? ' bg-muted' : ''}`}>OP 거르기</button>
          <button type="button" disabled={busy !== null || visibleItems.length === 0} onClick={() => { void decideAllRecommended(); }} className="rounded-md border border-border px-3 py-1 disabled:opacity-50">권고대로 일괄 결정</button>
        </div>
        {bulkStatus && <p role="status">{bulkStatus}</p>}
        {visibleItems.length === 0 ? <p>{board.items.length === 0 ? '열린 결정이 없습니다.' : 'OP가 올린 열린 결정이 없습니다.'}</p> : <ol className="space-y-4">
        {visibleItems.map(item => {
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
              <div className="rounded-lg border border-border p-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold">판단 칸</h3>
                  <button type="button" aria-expanded={folded[item.id] !== true} aria-controls={`ledger-${item.id}`}
                    onClick={() => setFolded(previous => ({ ...previous, [item.id]: previous[item.id] !== true }))}
                    className="rounded-md border border-border px-3 py-1">{folded[item.id] === true ? '판단 칸 펼치기' : '판단 칸 접기'}</button>
                </div>
                {folded[item.id] !== true && <dl id={`ledger-${item.id}`} className="mt-2 space-y-1">
                  {LEDGER_CELLS.map(cell => {
                    const closed = cellFolded[`${item.id}:${cell.key}`] === true;
                    return <div key={cell.key} className="grid gap-1 border-b border-border/60 pb-1 last:border-b-0">
                      <dt className="flex flex-wrap items-center justify-between gap-2 font-semibold">
                        <span>{cell.label}:</span>
                        <button type="button" aria-expanded={!closed} aria-controls={`cell-${item.id}-${cell.key}`}
                          onClick={() => setCellFolded(previous => ({ ...previous, [`${item.id}:${cell.key}`]: previous[`${item.id}:${cell.key}`] !== true }))}
                          className="rounded-md border border-border px-2 py-0.5 text-xs font-normal">{`${cell.label} ${closed ? '펼치기' : '접기'}`}</button>
                      </dt>
                      <dd id={`cell-${item.id}-${cell.key}`} hidden={closed} className="min-w-0 whitespace-pre-wrap">{ledgerCellText(item, cell.key)}</dd>
                    </div>;
                  })}
                </dl>}
              </div>
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
      </div>}
  </main>;
}
