'use client';

import { useEffect, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';

type FolderListing = {
  event: string;
  count: number;
  reel?: { status: string; url?: string };
};

type FolderView = FolderListing & {
  refreshKey: number;
  reelError?: string;
  videoUrl?: string;
  error?: string;
};

const FIELD_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export default function FieldFolderStatus({ event, refreshKey = 0 }: { event: string; refreshKey?: number }) {
  const { client } = useDaemon();
  const [view, setView] = useState<FolderView | null>(null);
  const [loadError, setLoadError] = useState<{ event: string; refreshKey: number; message: string } | null>(null);
  const current = view?.event === event && view.refreshKey === refreshKey ? view : null;
  const error = loadError?.event === event && loadError.refreshKey === refreshKey ? loadError.message : '';

  useEffect(() => {
    if (!FIELD_SLUG.test(event)) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let objectUrl = '';
    setView(null);
    setLoadError(null);

    const update = (change: Partial<FolderView>) => {
      if (active) setView((previous) => previous?.event === event && previous.refreshKey === refreshKey
        ? { ...previous, ...change } : previous);
    };

    async function openVideo(url: string) {
      try {
        const response = await client.fetchResponse(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        update({ videoUrl: objectUrl });
      } catch (cause) {
        update({ error: `영상을 열지 못했습니다: ${String(cause)}` });
      }
    }

    async function pollReel() {
      try {
        const status = await client.fieldReelStatus(event) as { state: string; url?: string; error?: string };
        if (!active) return;
        update({ reel: { status: status.state, url: status.url }, reelError: status.state === 'failed' ? status.error : undefined, error: undefined });
        if (status.state === 'done' && status.url) {
          await openVideo(status.url);
        } else if (status.state !== 'done' && status.state !== 'failed') {
          timer = setTimeout(pollReel, 5000);
        }
      } catch (cause) {
        update({ error: `영상 상태를 읽지 못했습니다: ${String(cause)}` });
        if (active) timer = setTimeout(pollReel, 5000);
      }
    }

    client.fetchJson<FolderListing>(`/v1/field/uploads?event=${encodeURIComponent(event)}`)
      .then((listing) => {
        if (!active) return;
        setView({ ...listing, event, refreshKey });
        if (listing.reel) {
          if (listing.reel.status === 'done' && listing.reel.url) void openVideo(listing.reel.url);
          else void pollReel();
        }
      })
      .catch((cause: unknown) => {
        if (active) setLoadError({ event, refreshKey, message: `폴더 상태를 읽지 못했습니다: ${String(cause)}` });
      });

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, event, refreshKey]);

  if (!FIELD_SLUG.test(event)) return null;
  return (
    <section aria-label="행사 폴더 상태" className="space-y-3 rounded-xl border border-border bg-card p-5">
      <h2 className="text-lg font-semibold">{event}</h2>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!current && !error && <p role="status" className="text-sm text-muted-foreground">폴더 상태를 읽는 중…</p>}
      {current && <>
        <p className="text-sm">폴더에 {current.count}개 · 영상 {current.reel?.status === 'done' ? '완료' : current.reel?.status === 'failed' ? '만들지 못함' : current.reel ? '만드는 중' : '없음'}</p>
        {current.reel?.status === 'failed' && current.reelError && <p role="alert" className="text-sm text-destructive">{current.reelError}</p>}
        {current.error && <p role="alert" className="text-sm text-destructive">{current.error}</p>}
        {current.videoUrl && <video controls playsInline src={current.videoUrl} className="mx-auto aspect-[9/16] max-h-[70vh] w-full max-w-xs rounded-lg bg-black" aria-label="현장 세로 영상" />}
      </>}
    </section>
  );
}
