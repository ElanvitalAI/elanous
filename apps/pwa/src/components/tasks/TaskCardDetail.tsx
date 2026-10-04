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

export function TaskCardDetail({ card, placements }: { card: TaskCard; placements?: readonly WishPlacementWire[] }) {
  const gates = card.sections.gates?.data;
  return (
    <section aria-label="Task card detail" className="min-w-0 space-y-4 rounded-2xl border border-border bg-card p-4">
      <header>
        <h2 className="text-lg font-semibold">{cardTitle(card)}</h2>
        <p className="break-all text-xs text-muted-foreground">{card.taskId}</p>
      </header>
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
