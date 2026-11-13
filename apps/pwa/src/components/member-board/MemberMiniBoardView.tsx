'use client';

import { useCallback, useEffect, useState } from 'react';
import type { MiniBoardCard } from '@/lib/mini-board-projection';
import type { MemberMiniBoardApi, VerifiedMemberOwner } from '@/lib/member-mini-board-api';
import {
  MINI_BOARD_COLUMNS, msUntilNextSeoulMidnight, projectMemberBoardCards, recheckedBriefing, rowsForVerifiedMember, rowsFromApi, todayInSeoul,
  type BriefingCard, type MemberBoardCard, type MemberBoardAttachment,
} from './member-board-model';

export function MemberMiniBoardView({
  briefings, cards, refreshedAt, loading, error, onRefresh,
}: {
  briefings: readonly BriefingCard[];
  cards: readonly MemberBoardCard[];
  refreshedAt: string | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const columns = projectMemberBoardCards(cards);
  const attachmentsById = new Map(cards.map(card => [card.id, card.attachments]));
  return <main className="mx-auto w-full max-w-7xl space-y-8 px-5 py-8 sm:px-8">
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-primary">내 작업</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">내 미니 보드 · 브리핑</h1>
        <p className="mt-2 text-sm text-muted-foreground">내 제안부터 배포까지의 상태와 오늘의 브리핑</p>
      </div>
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <a href="/app/member/invite/" className="rounded-lg border border-border bg-card px-3 py-2 font-medium text-foreground">내 초대 링크</a>
        {refreshedAt && <span>갱신 {refreshedAt}</span>}
        <button type="button" onClick={onRefresh} disabled={loading}
          className="rounded-lg border border-border bg-card px-3 py-2 font-medium text-foreground disabled:opacity-60">
          {loading ? '불러오는 중…' : '새로고침'}
        </button>
      </div>
    </header>

    {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">{error}</p>}

    <section aria-labelledby="briefings-heading" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="briefings-heading" className="text-lg font-semibold">오늘의 브리핑</h2>
        <span className="text-xs text-muted-foreground">{todayInSeoul()}</span>
      </div>
      {briefings.length === 0 ? <p className="rounded-xl border border-dashed border-border p-5 text-sm text-muted-foreground">오늘 등록된 브리핑이 없습니다.</p> :
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {briefings.map((briefing, index) => <li key={briefing.id ?? `${briefing.day ?? 'briefing'}-${index}`}>
            <article className="h-full space-y-3 rounded-xl border border-border bg-card p-4">
              <h3 className="font-semibold">{briefing.day ?? '브리핑'}</h3>
              {briefing.sourceScrapIds && <p className="break-all text-xs text-muted-foreground">브리핑 ID · {briefing.id}</p>}
              {!!briefing.sourceScrapIds?.length && <p className="break-all text-xs text-muted-foreground">출처 스크랩 · {briefing.sourceScrapIds.join(', ')}</p>}
              {briefing.sourceScrapIds && briefing.runId && <p className="break-all text-xs text-muted-foreground">run · {briefing.runId}</p>}
              {briefing.topics?.map((topic, topicIndex) => <div key={`${topic.title ?? 'topic'}-${topicIndex}`}>
                <p className="text-sm font-medium">{topic.title ?? '주제'}</p>
                {topic.summary && <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{topic.summary}</p>}
              </div>)}
              {!!briefing.todos?.length && <ul className="space-y-1 border-t border-border pt-2 text-sm">
                {briefing.todos.map((todo, todoIndex) => <li key={todoIndex} className="text-muted-foreground">할 일 · {typeof todo === 'string' ? todo : todo.text ?? '미정'}</li>)}
              </ul>}
            </article>
          </li>)}
        </ul>}
    </section>

    <section aria-labelledby="mini-board-heading" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="mini-board-heading" className="text-lg font-semibold">내 미니 보드</h2>
        <span className="text-xs text-muted-foreground">{cards.length}개 카드 · 읽기 전용</span>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {MINI_BOARD_COLUMNS.map((column) => {
          const rows = columns[column.id];
          return <section key={column.id} aria-label={`${column.label} 열`} className="min-w-0 space-y-2 rounded-xl border border-border bg-muted/20 p-3">
            <h3 className="flex items-center justify-between text-sm font-semibold">{column.label}<span className="text-xs text-muted-foreground">{rows.length}</span></h3>
            {rows.length === 0 && <p className="py-2 text-xs text-muted-foreground">카드 없음</p>}
            {rows.map((card) => <MemberMiniBoardCard key={card.taskId} card={card} attachments={attachmentsById.get(card.taskId)} />)}
          </section>;
        })}
      </div>
    </section>
  </main>;
}

function MemberMiniBoardCard({ card, attachments }: { card: MiniBoardCard; attachments?: MemberBoardAttachment[] }) {
  return <article className="space-y-2 rounded-lg border border-border bg-card p-3 text-sm">
    <h4 className="font-medium">{card.title}</h4>
    {card.summary && <p className="text-xs text-muted-foreground">{card.summary}</p>}
    {!!attachments?.length && <ul aria-label="카드 첨부" className="space-y-1 text-xs">
      {attachments.filter(item => /^https:\/\//.test(item.url)).map((item, index) =>
        <li key={`${item.sha256}-${index}`}><a href={item.url} target="_blank" rel="noreferrer"
          className="break-all font-medium text-primary underline-offset-4 hover:underline">{item.title} · {item.kind} ↗</a></li>)}
    </ul>}
    {card.runId && <p className="text-xs text-muted-foreground">run {card.runId.slice(0, 8)}</p>}
    {card.resultUrl && <a href={card.resultUrl} target="_blank" rel="noreferrer" className="block break-all text-xs font-medium text-primary underline-offset-4 hover:underline">
      {card.resultUrl} ↗
    </a>}
  </article>;
}

export function MemberMiniBoardScreen({ api }: { api: MemberMiniBoardApi | null }) {
  const [owner, setOwner] = useState<VerifiedMemberOwner | null>(null);
  const [briefings, setBriefings] = useState<BriefingCard[]>([]);
  const [cards, setCards] = useState<MemberBoardCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let active = true;
    const scheduleMidnightRefresh = () => {
      timer = setTimeout(() => {
        if (!active) return;
        refresh();
        scheduleMidnightRefresh();
      }, msUntilNextSeoulMidnight());
    };
    scheduleMidnightRefresh();
    return () => { active = false; clearTimeout(timer); };
  }, [refresh]);


  useEffect(() => {
    if (!api) { setLoading(false); return; }
    let active = true;
    setLoading(true);
    setError(null);
    setOwner(null);
    setCards([]);
    setBriefings([]);
    setRefreshedAt(null);
    void api.getVerifiedOwner().then(async (verifiedOwner) => {
      const [board, briefingRows] = await Promise.all([api.getBoard(), api.getBriefings(todayInSeoul(), verifiedOwner.appSlug)]);
      if (!active) return;
      setOwner(verifiedOwner);
      setCards(rowsForVerifiedMember(rowsFromApi<MemberBoardCard>(board, 'cards'), verifiedOwner.memberId));
      const listed = rowsForVerifiedMember(rowsFromApi<BriefingCard>(briefingRows, 'briefings'), verifiedOwner.memberId);
      const checked = await Promise.all(listed.map(async (briefing) => {
        if (!briefing.id || !api.getBriefing) return briefing;
        try { return recheckedBriefing(briefing, await api.getBriefing(briefing.id, verifiedOwner.appSlug), verifiedOwner.memberId); }
        catch { return briefing; }
      }));
      if (!active) return;
      setBriefings(checked);
      setRefreshedAt(new Date().toLocaleTimeString());
    }).catch((cause: unknown) => {
      if (active) {
        setOwner(null);
        setCards([]);
        setBriefings([]);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, refreshKey]);

  useEffect(() => {
    if (!api || !owner) return;
    try { return api.subscribe(owner.memberId, refresh); } catch { return; }
  }, [api, owner, refresh]);

  if (!api) return <main className="mx-auto max-w-3xl p-8"><p role="status">회원 보드 연결 설정을 확인해 주세요.</p></main>;
  if (!owner && loading) return <main className="mx-auto max-w-3xl p-8"><p role="status">회원 세션과 본인 앱 소유권을 확인하고 있습니다…</p></main>;
  if (!owner) return <main className="mx-auto max-w-3xl p-8">
    {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">{error}</p>}
    <p className="mt-4 text-sm text-muted-foreground">로그인한 회원 본인만 보드를 확인할 수 있습니다.</p>
  </main>;
  return <MemberMiniBoardView briefings={briefings} cards={cards} refreshedAt={refreshedAt} loading={loading} error={error} onRefresh={refresh} />;
}
