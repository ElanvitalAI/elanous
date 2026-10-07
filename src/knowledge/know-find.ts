import { createRequire } from 'node:module';
import { LessonLedger, type LessonRow } from '../lessons/lesson-ledger.js';
import { DecisionLedger, type DecisionEntry, type SeatDecisionRecord } from '../decisions/decision-ledger.js';
import { devVersion, listChecklist, type Checklist } from '../release-loop/checklist.js';
import { debug } from '../debug/log.js';

/** Directive row fields this search reads — kept local because `src/directives/directive-index` is excluded from the public export. */
export interface DirectiveRow { ts: string; text: string; source_file: string; line_no: number }

/** Loads the private directive index at run time only, so public builds bundle cleanly and report the directive source as unreadable. */
function openDirectiveIndex(): { search(q: string): DirectiveRow[]; close(): void } {
  const spec = ['..', 'directives', 'directive-index.js'].join('/');
  const mod = createRequire(import.meta.url)(spec) as { DirectiveIndex: new () => ReturnType<typeof openDirectiveIndex> };
  return new mod.DirectiveIndex();
}

export type KnowSource = 'directive' | 'decision' | 'checklist' | 'lesson';
export interface KnowHit {
  source: KnowSource;
  id: string;
  title: string;
  status: string;
  at: string;
  current: boolean;
  ref: string;
}
export interface KnowResult {
  rows: KnowHit[];
  unavailable: Array<{ source: KnowSource; reason: string }>;
}
export interface KnowFindDeps {
  directives: (query: string) => DirectiveRow[];
  decisions: () => DecisionEntry[];
  seatDecisions: () => SeatDecisionRecord[];
  checklist: (version: string) => Checklist;
  lessons: (query: string) => LessonRow[];
  versions: () => string[];
  now: () => Date;
}

function versions(): string[] {
  const current = devVersion().replace(/-dev\.\d+$/, '');
  const parts = current.split('.').map(Number);
  return [current, `${parts[0]}.${parts[1]}.${parts[2]! + 1}`];
}

const defaults: KnowFindDeps = {
  directives: (query) => {
    const index = openDirectiveIndex();
    try { return index.search(query); } finally { index.close(); }
  },
  decisions: () => new DecisionLedger().list({ status: 'all' }),
  seatDecisions: () => new DecisionLedger().seatReport(),
  checklist: (version) => listChecklist(version),
  lessons: (query) => new LessonLedger().find(query),
  versions,
  now: () => new Date(),
};

function matches(text: string, words: string[]): boolean {
  const normalized = text.toLocaleLowerCase();
  return words.every((word) => normalized.includes(word));
}

export function knowFind(query: string, deps: Partial<KnowFindDeps> = {}): KnowResult {
  const read = { ...defaults, ...deps };
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error('know: 질문이 필요합니다');
  const rows: KnowHit[] = [];
  const unavailable: KnowResult['unavailable'] = [];
  const attempt = (source: KnowSource, work: () => void): void => {
    try { work(); }
    catch (error) { unavailable.push({ source, reason: error instanceof Error ? error.message : String(error) }); }
  };
  const cutoff = read.now().getTime() - 30 * 86400000;
  attempt('directive', () => {
    for (const row of read.directives(query)) rows.push({ source: 'directive', id: `${row.source_file}:${row.line_no}`,
      title: row.text.replace(/\s+/g, ' ').slice(0, 160), status: 'recorded', at: row.ts,
      current: Number.isFinite(Date.parse(row.ts)) && Date.parse(row.ts) >= cutoff, ref: `${row.source_file}:${row.line_no}` });
  });
  attempt('decision', () => {
    for (const row of read.decisions()) {
      if (!matches([row.title, row.scqa.s, row.scqa.c, row.scqa.q, row.scqa.a].filter(Boolean).join(' '), words)) continue;
      rows.push({ source: 'decision', id: row.id, title: row.title, status: row.status,
        at: row.decidedAt ?? row.withdrawnAt ?? row.raisedAt ?? row.importedAt ?? '', current: row.status === 'open',
        ref: row.refs?.[0] ?? `decisions show ${row.id}` });
    }
  });
  attempt('decision', () => {
    for (const row of read.seatDecisions()) {
      if (!matches([row.title, row.decision, row.delegation].join(' '), words)) continue;
      rows.push({ source: 'decision', id: row.id, title: row.title, status: 'seat-posthoc',
        at: row.decidedAt ?? row.recordedAt, current: false, ref: `decisions seat-report --seat ${row.seat}` });
    }
  });
  attempt('checklist', () => {
    for (const version of new Set(read.versions())) {
      for (const row of read.checklist(version).items) {
        if (!matches(`${row.id} ${row.title}`, words)) continue;
        rows.push({ source: 'checklist', id: row.id, title: row.title, status: row.status,
          at: row.updatedAt, current: row.status === 'yellow', ref: `release checklist status --version ${version}` });
      }
    }
  });
  attempt('lesson', () => {
    for (const row of read.lessons(query)) rows.push({ source: 'lesson', id: row.id, title: row.incident,
      status: row.status, at: row.updated_at, current: row.occurrence_count > 1, ref: `lesson show ${row.id}` });
  });
  rows.sort((a, b) => Number(b.current) - Number(a.current) || (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)
    || a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
  debug.log('knowledge.know', 'query', { query, counts: Object.fromEntries((['directive', 'decision', 'checklist', 'lesson'] as const)
    .map(source => [source, rows.filter(row => row.source === source).length])), unavailable });
  return { rows, unavailable };
}
