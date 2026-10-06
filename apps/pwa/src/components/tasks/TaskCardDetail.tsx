'use client';

import { useState, type FormEvent } from 'react';
import { cardTitle, type TaskCard, type TaskCardEntry, type TaskCardSection } from '@/lib/task-card-model';
import type { WishPlacementWire } from '@/nexus/client';

const PROGRESS_LABEL: Record<WishPlacementWire['status'], string> = {
  green: '순항', yellow: '진행 중', red: '막힘', done: '완료',
};

const SECTION_ORDER: Exclude<TaskCardSection, 'incidents'>[] = [
  'intake', 'triage', 'gates', 'relations', 'memory', 'workspace', 'run', 'landing', 'release',
];

function timestamp(ts: number) {
  return new Date(ts).toISOString();
}

function decision(value: unknown): string {
  if (value === undefined || value === null) return '—';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function EntryData({ entry }: { entry: TaskCardEntry }) {
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-muted-foreground">JSON</summary>
      <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-muted p-2 text-xs whitespace-pre-wrap break-all">
        {JSON.stringify(entry.data, null, 2)}
      </pre>
    </details>
  );
}

function EntryMeta({ entry }: { entry: TaskCardEntry }) {
  const date = timestamp(entry.ts);
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span>Owner: {entry.owner}</span>
      <time dateTime={date}>{date}</time>
    </div>
  );
}

export function TaskCardDetail({ card, placements, onClose, publicCapture = false }: {
  card: TaskCard; placements?: readonly WishPlacementWire[];
  onClose?: (reason: string) => Promise<void>; publicCapture?: boolean;
}) {
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitClose = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!onClose || !reason.trim() || /[\r\n]/.test(reason) || pending) return;
    setPending(true);
    setError(null);
    try { await onClose(reason.trim()); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setPending(false); }
  };
  const gates = card.sections.gates?.data;
  return (
    <section aria-label="Task card detail" className="min-w-0 space-y-4 rounded-2xl border border-border bg-card p-4">
      <header>
        <h2 className="text-lg font-semibold">{cardTitle(card)}</h2>
        <p className="break-all text-xs text-muted-foreground">{card.taskId}</p>
        {card.status === 'closed' ? <p role="status">닫힘 · {card.closedReason ?? '사유 없음'}</p> :
          !publicCapture && onClose ? (
            <form onSubmit={submitClose} className="mt-3 flex flex-wrap items-end gap-2">
              <label className="text-sm">닫기 사유 (한 줄)
                <input type="text" required value={reason} onChange={(event) => setReason(event.target.value)}
                  className="block rounded-md border border-border bg-background px-2 py-1" />
              </label>
              <button type="submit" disabled={pending || !reason.trim() || /[\r\n]/.test(reason)} className="rounded-md border border-border px-3 py-1 text-sm">{pending ? '닫는 중…' : '닫기'}</button>
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            </form>
          ) : null}
      </header>
      {card.wishReply !== undefined && (
        <section aria-label="Wish reply destination" className="rounded-xl border border-border p-3 text-sm">
          <h3 className="mb-1 font-semibold">어디로 회신하나</h3>
          <p className="break-all">{card.wishReply
            ? `${{ telegram: '텔레그램 대화', pwa: 'PWA', tui: 'TUI', linear: 'Linear' }[card.wishReply.surface as 'telegram' | 'pwa' | 'tui' | 'linear'] ?? card.wishReply.surface}${card.wishReply.address ? ` · ${card.wishReply.address}` : ''}`
            : '회신 주소 없음'}</p>
        </section>
      )}
      {card.wishReply !== undefined && (
        <section aria-label="Wish reply history" className="rounded-xl border border-border p-3 text-sm">
          <h3 className="mb-1 font-semibold">회신 이력</h3>
          <p className="text-muted-foreground">카드 원장에는 회신 발송 이력이 기록되지 않습니다</p>
        </section>
      )}
      {placements && (
        <p className="overflow-x-auto whitespace-nowrap text-sm" aria-label="Wish placement and progress">
          배치 · {placements.length ? placements.map(({ cellId, cellTitle, version, status }) =>
            `${cellId} ${cellTitle} · ${version}판 · ${PROGRESS_LABEL[status]}`).join(' / ') : '아직 배치되지 않음'}
        </p>
      )}
      {gates && (
        <p className="overflow-x-auto whitespace-nowrap text-sm" aria-label="Gate decisions">
          Gate · budget: {decision(gates.budget)} · location: {decision(gates.location)}
        </p>
      )}
      {SECTION_ORDER.map((name) => {
        const entry = card.sections[name];
        if (!entry) return null;
        return (
          <section key={name} aria-label={`${name} section`} className="rounded-xl border border-border p-3">
            <h3 className="mb-1 text-sm font-semibold capitalize">{name}</h3>
            <EntryMeta entry={entry} />
            <EntryData entry={entry} />
          </section>
        );
      })}
      <section aria-label="Incidents" className="space-y-2">
        <h3 className="text-sm font-semibold">Incidents ({card.incidents.length})</h3>
        {card.incidents.length ? (
          <ol className="space-y-2">
            {card.incidents.map((incident) => (
              <li key={incident.key} className="rounded-xl border border-border p-3">
                <EntryMeta entry={incident} />
                <EntryData entry={incident} />
              </li>
            ))}
          </ol>
        ) : <p className="text-xs text-muted-foreground">No incidents.</p>}
      </section>
    </section>
  );
}
