import { redactSecretText } from '../debug/log.js';
import { DecisionLedger, type DecisionEntry } from '../decisions/decision-ledger.js';
import { listCoordEvents, type CoordEvent } from './coord-events.js';

export interface MemoryItem {
  project: string;
  seat: string;
  topic: string;
  summary: string;
  source: string;
  updatedAt: string;
  status: 'active' | 'retired';
  /** A normalized, comparable assertion supplied by the summarizer; absent means no conflict judgment. */
  claim?: { key: string; value: string };
  conflict?: { owner: 'OP'; sources: [string, string] };
}

export type MemorySource =
  | { kind: 'event'; at: string; seat: string; text: string; source: string }
  | { kind: 'decision'; at: string; seat: string; text: string; source: string };

export interface MemorySummary {
  project: string;
  topic: string;
  summary: string;
  /** Only supply this when the two strings identify the same fact and mutually exclusive values. */
  claim?: { key: string; value: string };
}

export interface MemoryDeps {
  summarize: (source: MemorySource) => Promise<MemorySummary>;
  events?: (since: string) => CoordEvent[];
  decisions?: () => DecisionEntry[];
}

const DAY_MS = 86_400_000;
const oneLine = (text: string) => redactSecretText(text.split(/\r?\n/, 1)[0] ?? '').trim();

/** Condense one UTC day; callers persist the returned snapshot, not raw transcripts. Read-only ledger access. */
export async function condenseContextDay(
  day: string, previous: readonly MemoryItem[], deps: MemoryDeps, now: Date = new Date(),
): Promise<MemoryItem[]> {
  if (!/^\d{4}-\d\d-\d\d$/.test(day) || new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day) {
    throw new Error('day must be a valid UTC YYYY-MM-DD');
  }
  const since = `${day}T00:00:00.000Z`;
  const start = Date.parse(since);
  const until = start + DAY_MS;
  // The store compares timestamp text, so fetch the previous local day too before UTC filtering.
  const events = (deps.events ?? (from => listCoordEvents({ since: from })))(new Date(start - DAY_MS).toISOString());
  const decisions = (deps.decisions ?? (() => new DecisionLedger().list({ status: 'all' })))();
  const sources: MemorySource[] = [
    ...events.map(event => ({ kind: 'event' as const, at: event.at, seat: event.refs.seat,
      text: event.summary, source: event.refs.source ?? event.refs.url ?? `elanous://context/event/${encodeURIComponent(event.id)}` })),
    ...decisions.map(decision => ({ kind: 'decision' as const,
      at: decision.decidedAt ?? decision.raisedAt ?? decision.importedAt ?? '',
      seat: decision.raisedBy.track ?? 'OP',
      text: decision.status === 'decided' ? `${decision.title}: ${decision.options.find(o => o.key === decision.choice)?.label ?? decision.note ?? decision.scqa.a ?? '결정됨'}` : `${decision.title}: ${decision.status}`,
      source: `elanous://decisions/${encodeURIComponent(decision.id)}` })),
  ].filter(source => {
    const at = Date.parse(source.at);
    return Number.isFinite(at) && at >= start && at < until;
  }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.source.localeCompare(b.source));

  const items = new Map<string, MemoryItem>();
  const keyFor = (item: Pick<MemoryItem, 'project' | 'seat' | 'topic'>) => JSON.stringify([item.project, item.seat, item.topic]);
  for (const item of previous) items.set(keyFor(item), { ...item });
  for (const source of sources) {
    const summary = await deps.summarize(source);
    const project = oneLine(summary.project);
    const seat = oneLine(source.seat);
    const topic = oneLine(summary.topic);
    const text = oneLine(summary.summary);
    const link = oneLine(source.source);
    if (!project || !seat || !topic || !text || !/^(?:https?:\/\/|elanous:\/\/)[^\s]+$/.test(link)) {
      throw new Error('memory summary needs a project, seat, topic, one-line summary and source link');
    }
    const claim = summary.claim && { key: oneLine(summary.claim.key), value: oneLine(summary.claim.value) };
    if (claim && (!claim.key || !claim.value)) throw new Error('memory claim needs key and value');
    const key = keyFor({ project, seat, topic });
    const old = items.get(key);
    // Equal timestamps are resolved by the source link, so shuffled input does not change the winner.
    if (old && (Date.parse(old.updatedAt) > Date.parse(source.at)
      || (Date.parse(old.updatedAt) === Date.parse(source.at) && old.source >= link))) continue;
    items.set(key, { project, seat, topic, summary: text, source: link, updatedAt: source.at,
      status: 'active', ...(claim ? { claim } : {}) });
  }
  const cutoff = now.getTime() - 30 * DAY_MS;
  // Compare only the winning, non-retired assertions; a superseded claim cannot keep a decision candidate alive.
  const finalItems: MemoryItem[] = [...items.values()].map(({ conflict: _conflict, ...item }) => ({ ...item,
    status: Date.parse(item.updatedAt) < cutoff ? 'retired' as const : 'active' as const,
  }));
  finalItems.sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.source.localeCompare(b.source)
    || a.seat.localeCompare(b.seat));
  for (let index = 0; index < finalItems.length; index++) {
    const item = finalItems[index]!;
    if (item.status !== 'active' || !item.claim) continue;
    const { key, value } = item.claim;
    const conflicting = finalItems.slice(0, index).find(other => other.status === 'active'
      && other.project === item.project
      && other.claim?.key === key && other.claim.value !== value);
    if (conflicting) {
      finalItems[index] = { ...item, conflict: { owner: 'OP', sources: [conflicting.source, item.source] } };
    }
  }
  return finalItems.sort((a, b) => a.project.localeCompare(b.project) || a.seat.localeCompare(b.seat)
    || a.topic.localeCompare(b.topic));
}
