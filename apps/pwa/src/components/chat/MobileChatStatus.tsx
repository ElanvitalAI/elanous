'use client';

import type { ReactNode } from 'react';
import type { ShellActivitySnapshot } from '@/components/shell/activity-snapshot';

/** The sole always-visible top row on the standalone phone chat. */
export function MobileChatStatus({ activity, decisions, menu }: {
  activity: ShellActivitySnapshot;
  decisions: number | null;
  menu: ReactNode;
}) {
  const running = activity.kind === 'active'
    ? activity.run.progressLine || activity.run.runId
    : activity.kind === 'quiet' ? '없음' : activity.kind === 'loading' ? '확인 중' : '확인 불가';
  return (
    <div data-elanous-mobile-chat-status="" role="status" className="flex h-10 min-h-10 min-w-0 items-center gap-3 border-b border-border bg-background px-3 text-xs">
      <span className="min-w-0 flex-1 truncate" title={running}>지금 도는 일 · {running}</span>
      <span className="shrink-0">대기 결정 · {decisions ?? '—'}</span>
      {menu}
    </div>
  );
}
