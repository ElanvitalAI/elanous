import { debug, redactSecretText } from '../debug/log.js';
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

export type CondenseSkipReason = 'no-seat' | 'no-project' | 'no-topic' | 'no-summary' | 'bad-link' | 'bad-claim' | 'summarize-failed';
export type CondenseSkipped = Partial<Record<CondenseSkipReason, number>>;
export interface CondenseWindowReport {
  cards: MemoryItem[];
  skipped: CondenseSkipped;
  folded: number;
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
  return condenseContextWindow(`${day}T00:00:00.000Z`, new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS).toISOString(), previous, deps, now);
}

/** Read-only condensation over an exact rolling UTC window; the caller owns any persistence. */
export async function condenseContextWindow(
  since: string, until: string, previous: readonly MemoryItem[], deps: MemoryDeps, now: Date = new Date(),
): Promise<MemoryItem[]> {
  return (await condenseContextWindowWithReport(since, until, previous, deps, now)).cards;
}

export async function condenseContextWindowWithReport(
  since: string, until: string, previous: readonly MemoryItem[], deps: MemoryDeps, now: Date = new Date(),
): Promise<CondenseWindowReport> {
  const start = Date.parse(since);
  const end = Date.parse(until);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('invalid context window');
  // Fetch the previous local day as well: the store compares timestamp text rather than instants.
  const events = (deps.events ?? (from => listCoordEvents({ since: from })))(new Date(start - DAY_MS).toISOString());
  const decisions = (deps.decisions ?? (() => new DecisionLedger().list({ status: 'all' })))();
  const inWindow = (at: string) => {
    const time = Date.parse(at);
    return Number.isFinite(time) && time >= start && time < end;
  };
  const harnessRuns: Array<{ events: CoordEvent[]; locators: Set<string> }> = [];
  const earlierStarts: CoordEvent[] = [];
  const otherEvents: CoordEvent[] = [];
  let harnessEvents = 0;
  for (const event of events) {
    if (!inWindow(event.at)) {
      const time = Date.parse(event.at);
      if (event.kind === 'started' && Number.isFinite(time) && time >= start - DAY_MS && time < start) {
        earlierStarts.push(event);
      }
      continue;
    }
    // Harness lifecycle = started/finished, or any harness-child event that is not a report (review round 3).
    const isLifecycle = event.kind === 'started' || event.kind === 'finished'
      || (event.refs.seat === 'harness-child' && event.kind !== '보고');
    if (!isLifecycle) {
      otherEvents.push(event);
      continue;
    }
    harnessEvents++;
    const locators = new Set([event.refs.source, event.refs.url].filter((ref): ref is string => !!ref));
    const group = { events: [event], locators };
    // Either locator can identify the run, including a bridge through a third event.
    for (let i = 0; i < harnessRuns.length;) {
      const prior = harnessRuns[i]!;
      if (locators.size && [...prior.locators].some(ref => locators.has(ref))) {
        group.events.push(...prior.events);
        for (const ref of prior.locators) locators.add(ref);
        harnessRuns.splice(i, 1);
        i = 0;
      } else i++;
    }
    harnessRuns.push(group);
  }
  const eventSource = (event: CoordEvent): MemorySource => ({ kind: 'event', at: event.at, seat: event.refs.seat,
    text: event.summary, source: event.refs.source ?? event.refs.url ?? `elanous://context/event/${encodeURIComponent(event.id)}` });
  const foldedSources: MemorySource[] = [];
  for (const group of harnessRuns) {
    group.events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
    const finish = group.events.filter(event => event.kind === 'finished').at(-1);
    const inWindowStart = group.events.find(event => event.kind === 'started');
    const begin = inWindowStart ?? (finish ? earlierStarts.filter(event =>
      (group.locators.has(event.refs.source ?? '') || group.locators.has(event.refs.url ?? '')))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).at(0) : undefined);
    const winner = finish ?? inWindowStart ?? group.events.at(-1)!;
    const frequency = (ref: string) => group.events.filter(event => event.refs.source === ref || event.refs.url === ref).length;
    const run = [...group.locators].sort((a, b) => frequency(b) - frequency(a))[0] ?? eventSource(winner).source;
    const duration = finish && begin && Date.parse(finish.at) >= Date.parse(begin.at)
      ? `${Math.floor((Date.parse(finish.at) - Date.parse(begin.at)) / 60_000)}m ${Math.floor(((Date.parse(finish.at) - Date.parse(begin.at)) % 60_000) / 1_000)}s`
      : '알 수 없음';
    const result = finish ? oneLine(finish.summary).replace(/^Harness child finished:\s*/i, '') || '종료'
      : '진행 중';
    foldedSources.push({ ...eventSource(winner), seat: winner.refs.seat || begin?.refs.seat || '',
      source: run, text: `${run} ${result} · ${duration}` });
  }
  const folded = harnessEvents - foldedSources.length;
  try { debug.log('context.condense', 'folded', { harnessEvents, kept: foldedSources.length }); }
  catch { /* Observation must not stop condensation. */ }
  const sources: MemorySource[] = [
    ...otherEvents.map(eventSource), ...foldedSources,
    ...decisions.map(decision => ({ kind: 'decision' as const,
      at: decision.decidedAt ?? decision.raisedAt ?? decision.importedAt ?? '',
      seat: decision.raisedBy.track ?? 'OP',
      text: decision.status === 'decided' ? `${decision.title}: ${decision.options.find(o => o.key === decision.choice)?.label ?? decision.note ?? decision.scqa.a ?? '결정됨'}` : `${decision.title}: ${decision.status}`,
      source: `elanous://decisions/${encodeURIComponent(decision.id)}` })),
  ].filter(source => inWindow(source.at))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.source.localeCompare(b.source));

  const items = new Map<string, MemoryItem>();
  const skipped: CondenseSkipped = {};
  let kept = 0;
  const skip = (reason: CondenseSkipReason, source: MemorySource) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
    try { debug.log('context.condense', 'source-skipped', { reason, kind: source.kind, at: source.at }); }
    catch { /* Observation must not stop condensation. */ }
  };
  const safeLine = (value: unknown) => typeof value === 'string' ? oneLine(value) : '';
  const keyFor = (item: Pick<MemoryItem, 'project' | 'seat' | 'topic'>) => JSON.stringify([item.project, item.seat, item.topic]);
  for (const item of previous) items.set(keyFor(item), { ...item });
  for (const source of sources) {
    const seat = safeLine(source.seat);
    if (!seat) { skip('no-seat', source); continue; }
    let summary: MemorySummary;
    try { summary = await deps.summarize(source); }
    catch { skip('summarize-failed', source); continue; }
    const project = safeLine(summary?.project);
    const topic = safeLine(summary?.topic);
    const text = safeLine(summary?.summary);
    const link = safeLine(source.source);
    if (!project) { skip('no-project', source); continue; }
    if (!topic) { skip('no-topic', source); continue; }
    if (!text) { skip('no-summary', source); continue; }
    if (!/^(?:https?:\/\/|elanous:\/\/)[^\s]+$/.test(link)) { skip('bad-link', source); continue; }
    const claim = summary.claim && { key: safeLine(summary.claim.key), value: safeLine(summary.claim.value) };
    if (claim && (!claim.key || !claim.value)) { skip('bad-claim', source); continue; }
    kept++;
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
  const cards = finalItems.sort((a, b) => a.project.localeCompare(b.project) || a.seat.localeCompare(b.seat)
    || a.topic.localeCompare(b.topic));
  try { debug.log('context.condense', 'window', { sources: sources.length, kept, skipped }); }
  catch { /* Observation must not stop condensation. */ }
  return { cards, skipped, folded };
}
