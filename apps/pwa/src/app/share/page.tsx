'use client';

// WT-N-6 + Service Worker Phase 2 — Share Target receiver page.
//
// Two flows:
//
// **Level 1 (GET ?title= ?text= ?url=)**: original behaviour for
// unmodified browsers (Chrome desktop, Safari without PWA install).
// We forward the combined text to /chat as a prefill so the user
// confirms + sends with one tap. No SW needed.
//
// **Level 2 (POST multipart, intercepted by SW into Cache Storage)**:
// when the user shares files (photo, PDF, etc.) the OS POSTs
// /app/share/ with the binary payload. The SW (apps/pwa/public/sw.js)
// stashes the payload under a Cache Storage bucket and 303-redirects
// the user to /app/share/?shared=<id>. This page reads the payload
// back, uploads each file to the daemon's `/v1/attachments`, and
// hands the resulting AttachmentMeta[] to /chat via sessionStorage
// so ChatLayout can promote them into its attachment queue on mount.
//
// Why sessionStorage hand-off (vs deeper SW integration): keeps the
// existing ChatLayout consumption pattern intact (it already reads
// sessionStorage for prefill text) and avoids a long /chat?...
// query string with serialized file paths.

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { debugLog } from '@/lib/debug';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { takeSharedPayload } from '@/lib/share-target-store';
import { writeSharePrefill } from '@/lib/share-prefill';
import { uploadAttachment, type AttachmentMeta } from '@/lib/upload-attachment';

function buildShareText(title: string | null, text: string | null, url: string | null): string {
  const parts: string[] = [];
  if (title && title.trim()) parts.push(title.trim());
  if (text && text.trim()) parts.push(text.trim());
  if (url && url.trim()) parts.push(url.trim());
  return parts.join('\n\n');
}

const SHARE_ATTACHMENTS_KEY = 'elanous.pwa.shareAttachments';

type Phase =
  | 'idle'
  | 'level1-handing-off'
  | 'level2-loading'
  | 'level2-uploading'
  | 'level2-handing-off'
  | 'level2-empty'
  | 'level2-error';

interface PhaseState {
  phase: Phase;
  total?: number;
  done?: number;
  error?: string;
  preview?: string;
}

function ShareInner(): React.ReactElement {
  const router = useRouter();
  const params = useSearchParams();
  const { config } = useDaemon();
  const [state, setState] = useState<PhaseState>({ phase: 'idle' });

  useEffect(() => {
    const sharedId = params?.get('shared');

    // ── Level 2: SW redirected with `?shared=<id>` ────────────────
    if (sharedId) {
      let cancelled = false;
      void (async () => {
        setState({ phase: 'level2-loading' });
        const payload = await takeSharedPayload(sharedId);
        if (cancelled) return;
        if (!payload || payload.files.length === 0) {
          // Manifest was empty (text-only share that took the L2 path
          // somehow) or the cache was already drained. Fall back to
          // the L1 prefill path with whatever text we have.
          if (payload && payload.combinedText) {
            writeSharePrefill(payload.combinedText);
          }
          debugLog('pwa.share.l2.empty', { sharedId, hasPayload: !!payload });
          setState({ phase: 'level2-empty' });
          const t = setTimeout(() => router.replace('/chat'), 600);
          return () => clearTimeout(t);
        }
        if (!config.baseUrl) {
          setState({ phase: 'level2-error', error: 'daemon baseUrl not configured' });
          return;
        }
        // Upload each file sequentially — most shares are 1-2 files
        // so concurrency overhead isn't worth the complexity. Keeps
        // memory bounded too.
        setState({ phase: 'level2-uploading', total: payload.files.length, done: 0 });
        const metas: AttachmentMeta[] = [];
        for (let i = 0; i < payload.files.length; i += 1) {
          const file = payload.files[i]!;
          const r = await uploadAttachment({
            baseUrl: config.baseUrl,
            ...(config.token ? { token: config.token } : {}),
            file,
            filename: file.name,
          });
          if (cancelled) return;
          if (r.ok) {
            metas.push(r.meta);
          } else {
            debugLog('pwa.share.l2.upload-failed', { i, reason: r.reason });
          }
          setState((s) => ({ ...s, done: i + 1 }));
        }
        if (metas.length === 0) {
          setState({ phase: 'level2-error', error: 'all uploads failed' });
          return;
        }
        // Stash the AttachmentMeta[] for ChatLayout to consume.
        try {
          window.sessionStorage.setItem(SHARE_ATTACHMENTS_KEY, JSON.stringify(metas));
        } catch { /* swallow */ }
        if (payload.combinedText) writeSharePrefill(payload.combinedText);
        setState({ phase: 'level2-handing-off', total: payload.files.length, done: payload.files.length });
        const t = setTimeout(() => router.replace('/chat?shared=1'), 400);
        return () => clearTimeout(t);
      })();
      return () => { cancelled = true; };
    }

    // ── Level 1: GET with ?title/?text/?url ───────────────────────
    const title = params?.get('title') ?? null;
    const text = params?.get('text') ?? null;
    const url = params?.get('url') ?? null;
    const c = buildShareText(title, text, url);
    debugLog('pwa.share.l1.received', { hasTitle: !!title, hasText: !!text, hasUrl: !!url, len: c.length });
    if (typeof window !== 'undefined' && c.length > 0) {
      writeSharePrefill(c);
    }
    setState({ phase: 'level1-handing-off', preview: c });
    const t = setTimeout(() => router.replace('/chat'), 400);
    return () => clearTimeout(t);
  }, [params, router, config.baseUrl, config.token]);

  return (
    <main className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <h1 className="text-base font-semibold">📥 공유 받음</h1>
      {state.phase === 'level1-handing-off' && (
        <>
          <p className="text-xs text-muted-foreground">곧 /chat 으로 이동합니다…</p>
          {state.preview && (
            <pre className="max-h-[60vh] max-w-full overflow-auto rounded-md border border-border bg-card p-3 text-left text-[11px] whitespace-pre-wrap break-words">
              {state.preview.slice(0, 800)}
              {state.preview.length > 800 ? '…' : ''}
            </pre>
          )}
        </>
      )}
      {state.phase === 'level2-loading' && (
        <p className="text-xs text-muted-foreground">파일 읽는 중…</p>
      )}
      {state.phase === 'level2-uploading' && (
        <p className="text-xs text-muted-foreground">
          업로드 중… {state.done ?? 0} / {state.total ?? 0}
        </p>
      )}
      {state.phase === 'level2-handing-off' && (
        <p className="text-xs text-muted-foreground">
          {state.done ?? 0} 개 첨부 완료 · /chat 이동…
        </p>
      )}
      {state.phase === 'level2-empty' && (
        <p className="text-xs text-muted-foreground">파일이 없어요. /chat 으로 이동합니다…</p>
      )}
      {state.phase === 'level2-error' && (
        <>
          <p className="text-xs text-rose-500">업로드 실패: {state.error}</p>
          <a href="/app/chat" className="text-xs text-primary underline">
            /chat 으로 이동
          </a>
        </>
      )}
    </main>
  );
}

export default function SharePage(): React.ReactElement {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">loading…</div>}>
      <ShareInner />
    </Suspense>
  );
}
