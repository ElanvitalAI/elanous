'use client';

// PR #4.5 — 세션 잊기 confirmation. picker hover 의 🗑 또는 SessionPill
// dropdown 의 "이 세션 잊기" 가 호출. 단순 modal — backdrop 클릭 / Esc
// 로 cancel.

import { useEffect } from 'react';
import { Trash2 } from 'lucide-react';
import type { SessionSummary } from '@/lib/sessions-service';

export interface SessionDeleteConfirmProps {
  open: boolean;
  session: SessionSummary | null;
  onCancel: () => void;
  onConfirm: () => void;
  busy?: boolean;
}

export function SessionDeleteConfirm({
  open,
  session,
  onCancel,
  onConfirm,
  busy,
}: SessionDeleteConfirmProps) {
  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [open, onCancel]);

  if (!open || !session) return null;

  const preview = session.lastMsgPreview ?? `(빈 대화)`;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[min(420px,calc(100vw-2rem))] rounded-lg border border-border bg-card p-5 shadow-lg"
      >
        <div className="flex items-start gap-3">
          <Trash2 className="mt-0.5 h-5 w-5 shrink-0 text-rose-500" aria-hidden />
          <div className="min-w-0 space-y-2">
            <h2 className="text-base font-semibold">대화 지우기</h2>
            <p className="truncate font-mono text-xs text-muted-foreground">
              "{preview}"
            </p>
            <p className="text-xs text-muted-foreground">
              {session.origin && (
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono uppercase mr-1.5">
                  {session.origin}
                </span>
              )}
              {session.msgCount} 메시지
            </p>
            <p className="text-sm">
              이 대화를 영구히 지웁니다. 복구할 수 없습니다. 다른 기기에서 이 대화를 보고 있다면 더 이상 이어갈 수 없습니다.
            </p>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-secondary disabled:opacity-50"
          >
            취소
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="rounded-md bg-rose-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-600 disabled:opacity-50"
          >
            {busy ? '지우는 중…' : '지우기'}
          </button>
        </div>
      </div>
    </div>
  );
}
