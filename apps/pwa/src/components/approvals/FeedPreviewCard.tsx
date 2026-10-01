'use client';

// EV10d «게시 대기» — 피드 초안 미리보기 ⊕ 사람 편집 ⊕ «최종 게시»(확인 뒤에만 승인).
// 일반 «피드 미리보기» 레이아웃이다 — 특정 서비스의 로고·상표·고유 UI 는 쓰지 않는다.
// ⛔ 최종 게시 «전»에는 데몬 API(`/v1/graph-approvals/…`) 말고는 아무 데도 보내지 않는다.
import { useEffect, useMemo, useRef, useState } from 'react';
import { feedEditOf, graphApprovalErrorText, type FeedDraft, type FeedEdit, type GraphApproval } from '@/lib/graph-approvals-api';

export const FINAL_POST_CONFIRM = '게시할까요? 승인하면 이 초안으로 게시 준비 묶음이 텔레그램으로 갑니다.';

export interface FeedPreviewApi {
  saveFeedDraft: (graphId: string, runId: string, edit: FeedEdit) => Promise<{ feed: FeedDraft }>;
  feedMedia: (graphId: string, runId: string, path: string) => Promise<Blob>;
  decide: (graphId: string, runId: string, decision: 'approved' | 'rejected') => Promise<unknown>;
}

interface Props {
  item: GraphApproval & { feed: FeedDraft };
  api: FeedPreviewApi;
  onDecided: () => void;
  confirm?: (text: string) => boolean;
}

type Frame = { image?: string; cover?: { text: string; sub: string }; caption?: string };

function framesOf(draft: FeedDraft, edit: FeedEdit): Frame[] {
  const frames: Frame[] = [];
  if (draft.cover.image) frames.push({ image: draft.cover.image, cover: edit.cover });
  for (const slide of edit.slides) if (slide.include) frames.push({ image: slide.image, caption: slide.caption });
  return frames;
}

function same(a: FeedEdit, b: FeedEdit): boolean { return JSON.stringify(a) === JSON.stringify(b); }

export function FeedPreviewCard({ item, api, onDecided, confirm }: Props) {
  const [saved, setSaved] = useState<FeedDraft>(item.feed);
  const [edit, setEdit] = useState<FeedEdit>(() => feedEditOf(item.feed));
  const [editing, setEditing] = useState(false);
  const [index, setIndex] = useState(0);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [media, setMedia] = useState<Record<string, string>>({});
  const touchX = useRef<number | null>(null);
  const ask = confirm ?? ((text: string) => window.confirm(text));

  const dirty = !same(edit, feedEditOf(saved));
  const frames = useMemo(() => framesOf(saved, edit), [saved, edit]);
  const current = frames[Math.min(index, Math.max(0, frames.length - 1))];

  const paths = useMemo(() => [saved.cover.image, ...saved.slides.map((slide) => slide.image)].filter((p): p is string => !!p), [saved]);
  useEffect(() => {
    let alive = true;
    const urls: string[] = [];
    const canUrl = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
    void Promise.all(paths.map(async (path) => {
      try {
        const blob = await api.feedMedia(item.graphId, item.runId, path);
        if (!alive || !canUrl) return null;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        return [path, url] as const;
      } catch { return null; }
    })).then((pairs) => { if (alive) setMedia(Object.fromEntries(pairs.filter((pair): pair is readonly [string, string] => !!pair))); });
    return () => { alive = false; if (canUrl && typeof URL.revokeObjectURL === 'function') urls.forEach((url) => URL.revokeObjectURL(url)); };
  }, [api, item.graphId, item.runId, paths]);

  function go(step: number) { setIndex((i) => Math.max(0, Math.min(frames.length - 1, i + step))); }
  function patchSlide(position: number, patch: Partial<FeedEdit['slides'][number]>) {
    setEdit((e) => ({ ...e, slides: e.slides.map((slide, i) => (i === position ? { ...slide, ...patch } : slide)) }));
  }
  function move(position: number, step: number) {
    setEdit((e) => {
      const target = position + step;
      if (target < 0 || target >= e.slides.length) return e;
      const slides = [...e.slides];
      [slides[position], slides[target]] = [slides[target]!, slides[position]!];
      return { ...e, slides };
    });
  }

  async function save(): Promise<boolean> {
    setBusy(true); setError(''); setNote('');
    try {
      const result = await api.saveFeedDraft(item.graphId, item.runId, edit);
      setSaved(result.feed);
      setEdit(feedEditOf(result.feed));
      setNote(`저장했어요 · 수정 ${result.feed.revision} · 아직 게시 전입니다`);
      return true;
    } catch (err) { setError(graphApprovalErrorText(err)); return false; }
    finally { setBusy(false); }
  }

  async function publish() {
    if (!ask(FINAL_POST_CONFIRM)) return;
    if (dirty && !(await save())) return;
    setBusy(true); setError('');
    try { await api.decide(item.graphId, item.runId, 'approved'); onDecided(); }
    catch (err) { setError(graphApprovalErrorText(err)); }
    finally { setBusy(false); }
  }

  async function reject() {
    if (!ask('이 게시 초안을 거절할까요?')) return;
    setBusy(true); setError('');
    try { await api.decide(item.graphId, item.runId, 'rejected'); onDecided(); }
    catch (err) { setError(graphApprovalErrorText(err)); }
    finally { setBusy(false); }
  }

  const brand = saved.brand?.name || '브랜드';
  const initial = brand.trim().charAt(0).toUpperCase() || '·';
  const hashtags = edit.hashtags.join(' ');

  return (
    <article aria-label="피드 미리보기" data-feed-revision={saved.revision} className="mx-auto w-full max-w-md overflow-hidden rounded-xl border border-border bg-card text-foreground shadow-sm">
      <header className="flex items-center gap-3 px-3 py-2">
        <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold">{initial}</span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{brand}</p>
          {saved.brand?.handle && <p className="truncate text-xs text-muted-foreground">{saved.brand.handle}</p>}
        </div>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">수정 {saved.revision}{dirty ? ' · 저장 안 됨' : ''}</span>
      </header>

      <div
        className="relative aspect-[4/5] w-full touch-pan-y select-none overflow-hidden bg-muted"
        onTouchStart={(e) => { touchX.current = e.touches[0]?.clientX ?? null; }}
        onTouchEnd={(e) => {
          const start = touchX.current; touchX.current = null;
          const end = e.changedTouches[0]?.clientX;
          if (start == null || end == null || Math.abs(end - start) < 40) return;
          go(end < start ? 1 : -1);
        }}
      >
        {current?.image && media[current.image]
          ? <img src={media[current.image]} alt={current.caption ?? current.cover?.text ?? ''} className="h-full w-full object-cover" />
          : <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">이미지 불러오는 중</div>}
        {current?.cover && (current.cover.text || current.cover.sub) && (
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-4 text-white">
            <p className="break-words text-lg font-semibold">{current.cover.text}</p>
            {current.cover.sub && <p className="break-words text-sm opacity-90">{current.cover.sub}</p>}
          </div>
        )}
        {frames.length > 1 && <>
          <button type="button" aria-label="이전 장" disabled={index === 0} onClick={() => go(-1)} className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 px-2 py-1 text-white disabled:opacity-0">‹</button>
          <button type="button" aria-label="다음 장" disabled={index >= frames.length - 1} onClick={() => go(1)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 px-2 py-1 text-white disabled:opacity-0">›</button>
        </>}
      </div>
      {frames.length > 1 && (
        <div aria-label="장 표시" className="flex justify-center gap-1.5 py-2">
          {frames.map((_, i) => <span key={i} data-dot={i === index ? 'on' : 'off'} className={`h-1.5 w-1.5 rounded-full ${i === index ? 'bg-primary' : 'bg-muted-foreground/40'}`} />)}
        </div>
      )}

      <div className="space-y-2 px-3 pb-3 text-sm">
        <p className="break-words"><span className="font-semibold">{brand}</span> {edit.caption.hook}</p>
        {edit.caption.body && (more
          ? <p className="whitespace-pre-wrap break-words">{edit.caption.body}</p>
          : <button type="button" onClick={() => setMore(true)} className="text-muted-foreground">더 보기</button>)}
        {hashtags && <p className="break-words text-primary">{hashtags}</p>}
        {edit.location && <p className="text-xs text-muted-foreground">📍 {edit.location}</p>}
      </div>

      {editing && (
        <section aria-label="초안 편집" className="space-y-3 border-t border-border px-3 py-3 text-sm">
          <label className="block">커버 문구
            <input value={edit.cover.text} onChange={(e) => setEdit({ ...edit, cover: { ...edit.cover, text: e.target.value } })} className="mt-1 w-full rounded border border-border bg-background px-2 py-1" />
          </label>
          <label className="block">커버 부제
            <input value={edit.cover.sub} onChange={(e) => setEdit({ ...edit, cover: { ...edit.cover, sub: e.target.value } })} className="mt-1 w-full rounded border border-border bg-background px-2 py-1" />
          </label>
          <label className="block">첫 줄
            <input value={edit.caption.hook} onChange={(e) => setEdit({ ...edit, caption: { ...edit.caption, hook: e.target.value } })} className="mt-1 w-full rounded border border-border bg-background px-2 py-1" />
          </label>
          <label className="block">본문
            <textarea value={edit.caption.body} rows={4} onChange={(e) => setEdit({ ...edit, caption: { ...edit.caption, body: e.target.value } })} className="mt-1 w-full rounded border border-border bg-background px-2 py-1" />
          </label>
          <label className="block">해시태그(띄어쓰기로 구분)
            <input value={hashtags} onChange={(e) => setEdit({ ...edit, hashtags: e.target.value.split(/\s+/).filter(Boolean) })} className="mt-1 w-full rounded border border-border bg-background px-2 py-1" />
          </label>
          <label className="block">위치(비우면 없음)
            <input value={edit.location ?? ''} onChange={(e) => setEdit({ ...edit, location: e.target.value.trim() ? e.target.value : null })} className="mt-1 w-full rounded border border-border bg-background px-2 py-1" />
          </label>
          <ol aria-label="사진 순서" className="space-y-2">
            {edit.slides.map((slide, i) => (
              <li key={slide.image} data-slide={slide.image} className={`rounded border border-border p-2 ${slide.include ? '' : 'opacity-50'}`}>
                <div className="flex items-center gap-2">
                  <span className="w-6 shrink-0 text-xs text-muted-foreground">{i + 1}</span>
                  <input aria-label={`${i + 1}번 사진 설명`} value={slide.caption} onChange={(e) => patchSlide(i, { caption: e.target.value })} className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1" />
                </div>
                <div className="mt-2 flex gap-2">
                  <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className="rounded border px-2 py-0.5 disabled:opacity-40">앞으로</button>
                  <button type="button" disabled={i === edit.slides.length - 1} onClick={() => move(i, 1)} className="rounded border px-2 py-0.5 disabled:opacity-40">뒤로</button>
                  <button type="button" onClick={() => patchSlide(i, { include: !slide.include })} className="rounded border px-2 py-0.5">{slide.include ? '빼기' : '되살리기'}</button>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {(note || error) && <p role={error ? 'alert' : 'status'} className={`px-3 pb-2 text-sm ${error ? 'text-red-600' : 'text-muted-foreground'}`}>{error || note}</p>}
      <footer className="flex flex-wrap gap-2 border-t border-border px-3 py-3">
        <button type="button" disabled={busy} onClick={() => setEditing((v) => !v)} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50">{editing ? '편집 닫기' : '편집'}</button>
        <button type="button" disabled={busy || !dirty} onClick={() => { void save(); }} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50">수정 저장</button>
        <button type="button" disabled={busy} onClick={() => { void publish(); }} className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">최종 게시</button>
        <button type="button" disabled={busy} onClick={() => { void reject(); }} className="ml-auto rounded-lg px-3 py-2 text-sm text-muted-foreground disabled:opacity-50">거절</button>
      </footer>
    </article>
  );
}
