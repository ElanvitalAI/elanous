import type { Command } from 'commander';
import { Database } from 'bun:sqlite';
import { redactSecretText } from '../debug/log.js';
import { classifySurfaceUtteranceOrigin, countSurfaceUtterancesByOrigin, openSurfaceEventsDb, querySurfaceUtterances, surfaceEventsDbPath, type SurfaceEventRow } from '../domains/surface-events.js';
import { injectUtterance, type UtteranceInput } from '../domains/self-awareness.js';
import { writeStdoutJson } from './stdout-json.js';

const PAGE_SIZE = 50;
type UtteranceOrigin = 'human' | 'agent' | 'test-fixture' | 'unknown';

function refsOf(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

function redact(value: string): string {
  return redactSecretText(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, '$1?[REDACTED_QUERY]');
}

function isAutomatic(row: SurfaceEventRow): boolean {
  const refs = refsOf(row.refs);
  if (row.surface === 'coord:channel' || row.surface === 'coord:seat' || refs.origin === 'coord:channel') return true;
  const seatSource = typeof refs.origin === 'string' && /^(?:seat|seat-notice|notification|wake|coord:seat)$/i.test(refs.origin);
  if (seatSource) return true;
  if (refs.origin === 'observer' || refs.origin === 'observer-generated' || /observer-generated/i.test(row.tags ?? '')) return true;
  if (row.kind === 'qna' && /^(?:telegram|discord)$/i.test(row.surface)) return false;
  if (refs.origin === 'human' || refs.origin === 'user') return false;
  return false;
}

/** 도메인 원천 분류(사람/시험 fixture/외부 CLI agent/elanous 자기)를 CLI 표기로 접는다.
 *  시험 fixture 는 사람과 같은 서피스에 기록되지만 사람 표본이 아니다 — 별도 값으로 노출한다. */
function originOf(row: SurfaceEventRow): UtteranceOrigin {
  switch (classifySurfaceUtteranceOrigin(row)) {
    case 'human': return 'human';
    case 'test-fixture': return 'test-fixture';
    case 'external-cli-agent': case 'elanous-self': return 'agent';
    default: return 'unknown';
  }
}

function utteranceText(row: SurfaceEventRow): { text: string; extract: 'direct' | 'qna' | 'ambiguous' | 'summary'; truncated: boolean; truncationEvidence: 'cap-reached' | 'over-cap' | null; possibleLoss: boolean } {
  if (row.kind !== 'qna') return { text: row.text, extract: 'direct', truncated: false, truncationEvidence: null, possibleLoss: false };
  const firstAnswer = row.text.startsWith('Q: ') ? row.text.indexOf('\nA: ', 3) : -1;
  if (firstAnswer >= 0) {
    const ambiguous = row.text.indexOf('\nQ: ', 3) >= 0 || row.text.indexOf('\nA: ', firstAnswer + 4) >= 0;
    return { text: row.text.slice(3, firstAnswer), extract: ambiguous ? 'ambiguous' : 'qna', truncated: false, truncationEvidence: null, possibleLoss: ambiguous };
  }
  const summary = row.summary ?? '';
  return { text: summary.slice(0, 150), extract: 'summary', truncated: summary.length > 150, truncationEvidence: summary.length > 150 ? 'over-cap' : summary.length === 150 ? 'cap-reached' : null, possibleLoss: false };
}

function validDate(value: string, name: string): string {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime()) || !/^\d{4}-\d\d-\d\d(?:T.*)?$/.test(value)) throw new Error(`--${name} must be a valid ISO date/time`);
  return date.toISOString();
}

interface SelfUtterancesOptions {
  from: string; to: string; surface?: string; origin?: UtteranceOrigin; page?: string; json?: boolean;
}

export function collectSelfUtterances(opts: SelfUtterancesOptions, db: ReturnType<typeof openSurfaceEventsDb>) {
  const from = validDate(opts.from, 'from');
  const to = validDate(opts.to, 'to');
  if (from >= to) throw new Error('--from must be earlier than --to');
  const page = opts.page === undefined ? 1 : Number(opts.page);
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('--page must be a positive integer');
  const rows = querySurfaceUtterances(db, { from, to, ...(opts.surface ? { surface: opts.surface } : {}) });
  let excludedAutomatic = 0;
  let excludedByOrigin = 0;
  let ambiguous = 0;
  let truncated = 0;
  let capReached = 0;
  let possibleLoss = 0;
  let excludedUnextractable = 0;
  const utterances = rows.flatMap((row) => {
    if (isAutomatic(row)) { excludedAutomatic += 1; return []; }
    const origin = originOf(row);
    if (opts.origin && origin !== opts.origin) { excludedByOrigin += 1; return []; }
    const refs = refsOf(row.refs);
    const cwd = typeof refs.cwd === 'string' && refs.cwd.length > 0 && !/[\u0000-\u001f\u007f]/.test(refs.cwd) ? redact(refs.cwd) : null;
    const extracted = utteranceText(row);
    if (row.kind === 'qna' && extracted.text.trim() === '') { excludedUnextractable += 1; return []; }
    if (extracted.extract === 'ambiguous') ambiguous += 1;
    if (extracted.truncated) truncated += 1;
    if (extracted.truncationEvidence === 'cap-reached') capReached += 1;
    if (extracted.possibleLoss) possibleLoss += 1;
    return [{ id: redact(row.id), ts: redact(row.ts), surface: redact(row.surface), session: row.session_id ? redact(row.session_id) : null, cwd, origin, source: typeof refs.origin === 'string' ? redact(refs.origin) : 'unrecorded', text: redact(extracted.text), extract: extracted.extract, truncated: extracted.truncated, truncationEvidence: extracted.truncationEvidence, possibleLoss: extracted.possibleLoss }];
  });
  const total = utterances.length;
  const start = (page - 1) * PAGE_SIZE;
  // ⭐ 원천별 수를 «명시»한다 — 사람 원천 0 을 사람 표본으로 오인하지 않게(시험 fixture·외부 CLI agent 분리).
  const originCounts = countSurfaceUtterancesByOrigin(db, { from, to, ...(opts.surface ? { surface: opts.surface } : {}) });
  return { source: 'surface_events.events (read-only)', filters: { from, to, surface: opts.surface ?? null, origin: opts.origin ?? null, automatic: 'excluded' }, originCounts, humanSample: originCounts.human === 0 ? 'absent' : 'present', counts: { matched: total, excludedAutomatic, excludedByOrigin, excludedUnextractable, ambiguous, truncated, capReached, possibleLoss }, page: { number: page, size: PAGE_SIZE, total, hasNext: start + PAGE_SIZE < total }, utterances: utterances.slice(start, start + PAGE_SIZE) };
}

export function recordSelfUtterance(input: UtteranceInput & { utteranceOrigin?: 'human' | 'agent' }, db?: Database): { eventId: string } {
  const store = db ?? openSurfaceEventsDb();
  try {
    const result = injectUtterance(input, store);
    if (input.utteranceOrigin === 'human') {
      store.prepare("UPDATE events SET refs = json_set(refs, '$.utteranceOrigin', 'human') WHERE id = ?").run(result.eventId);
    }
    return result;
  } finally { if (!db) store.close(); }
}

export function registerSelfUtterancesCommand(selfCmd: Command): void {
  selfCmd.command('utterances').description('Read paginated original utterances from surface_events (read-only)')
    .requiredOption('--from <ISO>', 'Inclusive ISO date/time')
    .requiredOption('--to <ISO>', 'Exclusive ISO date/time')
    .option('--surface <surface>', 'Filter by surface')
    .option('--origin <origin>', 'Filter by known origin: human|agent')
    .option('--page <page>', 'One-based page number', '1')
    .option('--json', 'Emit JSON')
    .action(async (opts: SelfUtterancesOptions) => {
      if (opts.origin && opts.origin !== 'human' && opts.origin !== 'agent') throw new Error('--origin must be human or agent');
      const db = new Database(surfaceEventsDbPath(), { readonly: true });
      try {
        const result = collectSelfUtterances(opts, db);
        if (opts.json) { await writeStdoutJson(JSON.stringify(result, null, 2) + '\n'); return; }
        console.log(`source=${result.source} matched=${result.counts.matched} excludedAutomatic=${result.counts.excludedAutomatic} excludedByOrigin=${result.counts.excludedByOrigin} excludedUnextractable=${result.counts.excludedUnextractable} page=${result.page.number} size=${result.page.size} hasNext=${result.page.hasNext}`);
        console.log(`filters=${JSON.stringify(result.filters)}`);
        console.log(`origin-counts human=${result.originCounts.human} test-fixture=${result.originCounts.testFixture} external-cli-agent=${result.originCounts.externalCliAgent} elanous-self=${result.originCounts.elanousSelf} unknown=${result.originCounts.unknown} human-sample=${result.humanSample}`);
        for (const item of result.utterances) console.log(JSON.stringify(item));
        console.log(`ambiguous=${result.counts.ambiguous} truncated=${result.counts.truncated} cap-reached=${result.counts.capReached} possibleLoss=${result.counts.possibleLoss}`);
      } finally { db.close(); }
    });
}

export { PAGE_SIZE };
