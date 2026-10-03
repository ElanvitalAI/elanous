import type { ContextNowAnswer, ContextFact, ContextEvent } from '../../../../../src/context-bus/context-now';
import { toPublicText } from '../inside/public-text';
import { seatsNowLine } from './seats-now-line';

export type ContextSource = { label: string; ago: string | null; source: string };

const SEAT_NAMES: Record<string, string> = { OP: 'COO', MK: 'CMO', TC: 'CTO', UX: 'CXO' };
const SOURCE_ID = '[A-Za-z0-9_-]{1,39}';
const SOURCE_PATTERNS = {
  seat: new RegExp(`^elanous://seat-loop/(?:OP|MK|TC|UX)/\\d{4}-\\d{2}-\\d{2}#\\d+$`),
  event: new RegExp(`^elanous://context/event/${SOURCE_ID}$`),
  cell: new RegExp(`^elanous://release/\\d+\\.\\d+\\.\\d+/checklist#${SOURCE_ID}$`),
  decision: new RegExp(`^elanous://decisions/${SOURCE_ID}$`),
} as const;

function safeSource(kind: keyof typeof SOURCE_PATTERNS, source: string): boolean {
  if (!SOURCE_PATTERNS[kind].test(source)) return false;
  // Seat IDs in the URI are intentional provenance, not public-facing seat labels.
  const checked = kind === 'seat' ? source.replace(/\/seat-loop\/(?:OP|MK|TC|UX)\//, '/seat-loop/seat/') : source;
  return toPublicText(checked) === checked;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fact(value: unknown): value is ContextFact {
  if (!record(value) || typeof value.source !== 'string') return false;
  switch (value.kind) {
    case 'version': return typeof value.version === 'string';
    case 'cell': return typeof value.version === 'string' && typeof value.id === 'string'
      && typeof value.title === 'string' && typeof value.status === 'string'
      && (value.owner === null || typeof value.owner === 'string');
    case 'decision': return typeof value.id === 'string' && typeof value.title === 'string'
      && typeof value.status === 'string' && (value.dueAt === null || typeof value.dueAt === 'string');
    case 'seat': return typeof value.seat === 'string' && typeof value.at === 'string'
      && typeof value.status === 'string' && (value.id === null || typeof value.id === 'string')
      && (value.title === null || typeof value.title === 'string');
    default: return false;
  }
}

function event(value: unknown): value is ContextEvent {
  return record(value) && typeof value.at === 'string' && typeof value.kind === 'string'
    && typeof value.summary === 'string' && typeof value.source === 'string';
}

function answer(value: unknown): value is ContextNowAnswer {
  return record(value) && typeof value.at === 'string'
    && (value.topic === null || typeof value.topic === 'string')
    && Array.isArray(value.facts) && value.facts.every(fact)
    && Array.isArray(value.events) && value.events.every(event)
    && Array.isArray(value.guide) && value.guide.every((line: unknown) => typeof line === 'string');
}

function preview(text: string): string {
  return Array.from(toPublicText(text).trim()).slice(0, 30).join('');
}

function ago(at: string, now: number): string | null {
  if (!Number.isFinite(Date.parse(at))) return null;
  return seatsNowLine({
    date: '',
    seats: [{ seat: 'TC', now: { text: '출처', at }, landed: null, blocked: null, pendingDecisions: null, checklist: null }],
  }, now)[0]?.ago ?? null;
}

/** Project a context_now result into a bounded, public-facing provenance list. */
export function contextSources(raw: unknown, now: number): ContextSource[] | null {
  if (!answer(raw)) return null;
  const seats = raw.facts.filter((row): row is Extract<ContextFact, { kind: 'seat' }> => row.kind === 'seat')
    .sort((a, b) => b.at.localeCompare(a.at))
    .filter((row) => Object.hasOwn(SEAT_NAMES, row.seat) && safeSource('seat', row.source))
    .map((row) => ({
      label: toPublicText(`${SEAT_NAMES[row.seat]} 자리 루프${row.title ? ` · ${preview(row.title)}` : ''}`),
      ago: ago(row.at, now), source: row.source,
    }));
  const events = raw.events.filter((row) => safeSource('event', row.source))
    .sort((a, b) => b.at.localeCompare(a.at)).map((row) => ({
    label: toPublicText(`조율 채널 · ${preview(row.summary)}`),
    ago: ago(row.at, now), source: row.source,
  }));
  const cells = raw.facts.filter((row): row is Extract<ContextFact, { kind: 'cell' }> => row.kind === 'cell' && safeSource('cell', row.source))
    .map((row) => ({ label: toPublicText(`${row.version} 체크리스트 ${row.id}`), ago: null, source: row.source }));
  const decisions = raw.facts.filter((row): row is Extract<ContextFact, { kind: 'decision' }> => row.kind === 'decision' && row.status === 'open' && safeSource('decision', row.source))
    .map((row) => ({ label: toPublicText(`결정 대기 ${row.id}`), ago: null, source: row.source }));
  return [...seats, ...events, ...cells, ...decisions].slice(0, 6);
}
