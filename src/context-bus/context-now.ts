import { existsSync, readFileSync } from 'node:fs';
import { debug, redactSecretText } from '../debug/log.js';
import { DecisionLedger, type DecisionEntry } from '../decisions/decision-ledger.js';
import { listChecklist, devVersion, type Checklist } from '../release-loop/checklist.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { seatDay, seatLedgerPath, type SeatEntry } from '../seat-loop/seat-loop.js';
import { listCoordEvents, type CoordEvent } from './coord-events.js';

export type ContextFact =
  | { kind: 'version'; version: string; source: string }
  | { kind: 'cell'; version: string; id: string; title: string; status: string; owner: string | null; source: string }
  | { kind: 'decision'; id: string; title: string; status: string; dueAt: string | null; source: string }
  | { kind: 'seat'; seat: string; at: string; status: string; id: string | null; title: string | null; source: string };
export type ContextEvent = { at: string; kind: string; summary: string; source: string };
export type ContextNowAnswer = { at: string; topic: string | null; facts: ContextFact[]; events: ContextEvent[]; guide: string[] };

export interface ContextNowDeps {
  now?: () => Date;
  version?: () => string;
  checklist?: (version: string) => Checklist;
  decisions?: () => DecisionEntry[];
  seatEntries?: (now: Date) => Array<{ entry: SeatEntry; source: string }>;
  events?: (since: string) => CoordEvent[];
}

function todaySeatEntries(now: Date): Array<{ entry: SeatEntry; source: string }> {
  const root = effectiveInstanceRoot();
  const day = seatDay(now);
  return ['OP', 'TC', 'MK', 'UX'].flatMap(seat => {
    const path = seatLedgerPath(seat, root, now);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').flatMap((line, index) => line.trim() ? [{
      entry: JSON.parse(line) as SeatEntry,
      source: `elanous://seat-loop/${seat}/${day}#${index + 1}`,
    }] : []);
  });
}

/** Read a bounded, source-labelled view of current ledgers, never a transcript or decision body. */
export function contextNow(options: { topic?: string; limit?: number } = {}, deps: ContextNowDeps = {}): ContextNowAnswer {
  const now = (deps.now ?? (() => new Date()))();
  const at = `${now.toISOString().slice(0, 16)}:00.000Z`;
  const topic = options.topic?.trim() || null;
  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit)
    ? Math.max(1, Math.min(100, Math.floor(options.limit))) : 20;
  const version = (deps.version ?? devVersion)().replace(/-.*$/, '');
  const next = version.replace(/^(\d+)\.(\d+)\.(\d+)$/, (_, major: string, minor: string, patch: string) => `${major}.${minor}.${Number(patch) + 1}`);
  const facts: ContextFact[] = [];
  for (const v of [...new Set([version, next])]) {
    const checklist = (deps.checklist ?? listChecklist)(v);
    if (v === version) facts.push({ kind: 'version', version: v, source: `elanous://release/${v}/checklist` });
    for (const item of checklist.items) {
      if (item.status === 'done') continue;
      facts.push({ kind: 'cell', version: v, id: item.id, title: redactSecretText(item.title.split(/\r?\n/, 1)[0] ?? '').slice(0, 120),
        status: item.status, owner: item.owner ?? null, source: `elanous://release/${v}/checklist#${encodeURIComponent(item.id)}` });
    }
  }
  for (const item of (deps.decisions ?? (() => new DecisionLedger().list({ status: 'open' })))()) {
    if (item.status !== 'open') continue;
    facts.push({ kind: 'decision', id: item.id, title: redactSecretText(item.title.split(/\r?\n/, 1)[0] ?? '').slice(0, 120),
      status: item.status, dueAt: item.dueAt ?? null, source: `elanous://decisions/${encodeURIComponent(item.id)}` });
  }
  for (const { entry, source } of (deps.seatEntries ?? todaySeatEntries)(now)) {
    facts.push({ kind: 'seat', seat: entry.seat, at: entry.at, status: entry.status,
      id: entry.item?.id ?? null, title: entry.item?.source === 'checklist'
        ? redactSecretText(entry.item.title.split(/\r?\n/, 1)[0] ?? '').slice(0, 120) : null, source });
  }
  const rawEvents = (deps.events ?? (since => listCoordEvents({ since })))(new Date(now.getTime() - 7 * 86_400_000).toISOString());
  const chronologicalEvents = rawEvents.slice().sort((a, b) => a.at.localeCompare(b.at));
  const matches = (text: string) => !topic || text.toLocaleLowerCase().includes(topic.toLocaleLowerCase());
  const selectedFacts = facts.filter(f => !topic || (f.kind === 'cell' && matches(`${f.id} ${f.title}`))
    || (f.kind === 'seat' && matches(`${f.id ?? ''} ${f.title ?? ''}`)));
  const groups = (['version', 'cell', 'decision', 'seat'] as const).map(kind => selectedFacts.filter(f => f.kind === kind));
  groups[3]!.sort((a, b) => (a.kind === 'seat' && b.kind === 'seat' ? b.at.localeCompare(a.at) : 0));
  const nonEmpty = groups.filter(group => group.length > 0);
  const perKind = Math.floor(limit / nonEmpty.length);
  const chosen = groups.map(group => group.splice(0, perKind));
  let remaining = limit - chosen.reduce((total, group) => total + group.length, 0);
  for (const index of [2, 3, 0, 1]) {
    if (remaining <= 0) break;
    if (chosen[index]!.length === 0 && groups[index]!.length > 0) {
      chosen[index]!.push(...groups[index]!.splice(0, 1));
      remaining--;
    }
  }
  for (const index of [1, 2, 3, 0]) {
    if (remaining <= 0) break;
    const extra = groups[index]!.splice(0, remaining);
    chosen[index]!.push(...extra);
    remaining -= extra.length;
  }
  const boundedFacts = chosen.flat();
  const summaries = chronologicalEvents.map(event => ({
    at: event.at, kind: event.kind, summary: redactSecretText(event.summary.split(/\r?\n/, 1)[0] ?? '').slice(0, 120),
    source: event.refs.source ?? event.refs.url ?? `elanous://context/event/${encodeURIComponent(event.id)}`,
  }));
  const selectedEvents = summaries.filter(event => matches(event.summary)).reverse().slice(0, limit);
  const guide = summaries.filter(event => event.kind === 'guide-changed' || event.kind === 'guidance-changed' || event.summary.startsWith('📌안내'))
    .filter(event => matches(event.summary)).reverse().slice(0, limit)
    .map(event => `📌 ${event.summary} — ${event.source}`);
  const answer = { at, topic, facts: boundedFacts, events: selectedEvents, guide };
  debug.log('context.now', 'answer', { topic, facts: answer.facts, events: answer.events });
  return answer;
}
