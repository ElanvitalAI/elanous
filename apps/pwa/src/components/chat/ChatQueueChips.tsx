import type { ChatQueueEntry } from '@/lib/chat-queue';

export function ChatQueueChips({ queue, onRemove, onClear }: {
  queue: readonly ChatQueueEntry[];
  onRemove: (id: number) => void;
  onClear: () => void;
}) {
  if (queue.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border bg-background px-3 py-2" aria-label="보낼 차례">
      {queue.map((entry, index) => (
        <span key={entry.id} className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted px-2 py-1 text-xs">
          <span className="max-w-[160px] truncate" title={entry.text}>{index + 1} · {Array.from(entry.text).slice(0, 20).join('')}</span>
          <button type="button" onClick={() => onRemove(entry.id)} aria-label={`${index + 1}번 지우기`} className="rounded-full px-1 hover:bg-background">×</button>
        </span>
      ))}
      <button type="button" onClick={onClear} className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted">모두 지우기</button>
    </div>
  );
}
