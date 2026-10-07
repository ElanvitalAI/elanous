// TD2 — a daily look at the test suite, one cost-weighted slice at a time (shadow: it measures and drafts, it
// never deletes or moves a test). Design: 내부 문서 `TD1-v2-gate-content-review-2026-10-01`.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_COST_SECS = 10;
export const SLOW_SECS = 60;
export const HEAVY_MB = 2048;

export interface Effectiveness { flake: 'stable' | 'flaky' | 'failing'; mutation: 'caught' | 'survived' | 'n/a'; fixedCounts?: number; unreachable?: number }
export interface Measurement { file: string; secs: number; rssMb: number | null; rc: number | null; pass: number | null; fail: number | null; reason?: string; effectiveness?: Effectiveness }
export type Verdict = 'keep' | 'failing' | 'review';
export type Proposal = 'delete' | 'shrink' | 'rewrite-cheap' | 'move-out-of-gate' | 'investigate';
export interface Td1Disposition { disposition: string; alternative: string; guards: string; why_slow: string }
export interface Judged extends Measurement { caught90: number; flags: string[]; verdict: Verdict; effectiveness?: Effectiveness; proposal?: Proposal | null; basis?: string | null }
export interface LedgerLine { at: string; range: string; start: number; end: number; next: number; total: number; commit: string; budgetSecs: number; results: Judged[]; sweepVisited?: number; sweepCostSecs?: number; sweepSlices?: number }

/** `file\tsecs\t…` (TD1 whole-gate TSV) → seconds per file. */
export function costTable(tsv: string): Map<string, number> {
  const costs = new Map<string, number>();
  for (const line of tsv.split('\n').slice(1)) {
    const [file, secs] = line.split('\t');
    const n = Number(secs);
    if (file && Number.isFinite(n) && n > 0) costs.set(file, n);
  }
  return costs;
}

/** TD1's human-reviewed dispositions, resolved by column name rather than TSV position. */
export function td1Dispositions(tsv: string): Map<string, Td1Disposition> {
  const [header, ...rows] = tsv.trimEnd().split('\n');
  const columns = header?.replace(/\r$/, '').split('\t') ?? [];
  const index = (name: string) => columns.indexOf(name);
  const result = new Map<string, Td1Disposition>();
  for (const row of rows) {
    const cells = row.replace(/\r$/, '').split('\t');
    const get = (name: string) => cells[index(name)] ?? '';
    if (get('file') && get('disposition')) result.set(get('file'), {
      disposition: get('disposition'), alternative: get('alternative'), guards: get('guards'), why_slow: get('why_slow'),
    });
  }
  return result;
}

export function propose(judged: Judged, td1: ReadonlyMap<string, Td1Disposition>): Judged {
  const reviewed = td1.get(judged.file);
  if (reviewed) {
    const proposal = reviewed.disposition === 'keep' ? null : reviewed.disposition as Proposal;
    return { ...judged, proposal, basis: proposal ? [reviewed.alternative, reviewed.why_slow, reviewed.guards && `guards: ${reviewed.guards}`].filter(Boolean).join(' · ') : null };
  }
  if (judged.effectiveness?.flake === 'flaky') return { ...judged, proposal: 'investigate', basis: '3회 중 갈림' };
  if (judged.effectiveness?.flake === 'stable' && judged.effectiveness.mutation === 'survived' && judged.caught90 === 0)
    return { ...judged, proposal: 'rewrite-cheap', basis: '돌연변이를 못 잡음' };
  if (judged.verdict === 'failing') return { ...judged, proposal: 'investigate', basis: `failing (rc=${judged.rc}) · caught90=${judged.caught90}` };
  if (judged.verdict === 'review') return { ...judged, proposal: 'shrink', basis: `${judged.flags.join(', ')} · caught90=${judged.caught90}` };
  if (judged.effectiveness?.fixedCounts && judged.effectiveness.fixedCounts > 0)
    return { ...judged, proposal: 'investigate', basis: `저장소 전수 개수 고정 단언 ${judged.effectiveness.fixedCounts}줄 — 관련 시험 묶음 후보` };
  return { ...judged, proposal: null, basis: null };
}

/** Next slice from the cursor until the known cost reaches the budget (at least one file; wraps at the end). */
export function pickRange(files: readonly string[], start: number, costs: ReadonlyMap<string, number>, budgetSecs: number): { start: number; end: number; next: number; files: string[]; estimatedSecs: number } {
  if (files.length === 0) return { start: 0, end: -1, next: 0, files: [], estimatedSecs: 0 };
  const from = ((start % files.length) + files.length) % files.length;
  const picked: string[] = [];
  let spent = 0;
  let i = from;
  while (picked.length < files.length) {
    const file = files[i]!;
    const cost = costs.get(file) ?? DEFAULT_COST_SECS;
    if (picked.length > 0 && spent + cost > budgetSecs) break;
    picked.push(file);
    spent += cost;
    i = (i + 1) % files.length;
  }
  return { start: from, end: (from + picked.length - 1) % files.length, next: i, files: picked, estimatedSecs: spent };
}

/** Mechanical verdict: failing, or slow/heavy with nothing caught in 90 days → review (a draft card, never an action). */
export function judge(m: Measurement, caught90: number): Judged {
  const flags: string[] = [];
  if (m.secs >= SLOW_SECS) flags.push('slow');
  if (m.rssMb !== null && m.rssMb >= HEAVY_MB) flags.push('heavy');
  const verdict: Verdict = m.effectiveness?.flake === 'flaky' ? 'review'
    : (m.effectiveness?.flake === 'failing' || (m.effectiveness === undefined && m.rc !== 0)) ? 'failing'
      : flags.length > 0 && caught90 === 0 ? 'review' : 'keep';
  return { ...m, caught90, flags, verdict };
}

export function ledgerPath(root: string): string { return join(root, 'test-diet', 'ledger.jsonl'); }
export function nightlyAuditLedgerPath(root: string): string { return join(root, 'test-diet', 'nightly-audit.jsonl'); }

export function lastLedgerLine(root: string): LedgerLine | null {
  const path = ledgerPath(root);
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  try { return lines.length ? JSON.parse(lines.at(-1)!) as LedgerLine : null; } catch { return null; }
}

export function appendLedger(root: string, line: LedgerLine): void {
  mkdirSync(join(root, 'test-diet'), { recursive: true });
  appendFileSync(ledgerPath(root), `${JSON.stringify(line)}\n`);
}

/** Draft approval card — written as a file for a person to read; nothing is acted on. */
export function writeCardDraft(root: string, line: LedgerLine): string | null {
  const items = line.results.filter((r) => r.verdict !== 'keep' || r.proposal != null);
  if (items.length === 0) return null;
  const dir = join(root, 'test-diet', 'cards');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${line.at.slice(0, 10)}-${line.range.replace(/[^0-9a-z~#-]/gi, '')}.md`);
  const rows = items.map((r) => `| \`${r.file}\` | ${r.verdict} | ${r.secs}s | ${r.rssMb ?? '?'} MB | ${r.caught90} | ${r.flags.join(', ') || '—'} | ${(r.reason ?? '').replace(/\|/g, '/')} | ${r.proposal ?? '—'} | ${(r.basis ?? '—').replace(/\|/g, '/')} |`);
  writeFileSync(path, [
    `# 시험 리뷰 초안 — ${line.range} (${line.at.slice(0, 10)})`,
    '',
    '> 초안이다. 아무것도 지우거나 옮기지 않았다. 사람이 읽고 정한다.',
    '',
    '| 파일 | 판정 | 단독 시간 | 피크 메모리 | 90일 fix 커밋 | 표지 | 실패 사유(첫 줄) | 제안 | 근거 |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    `원장: ${line.results.length}개 중 ${items.length}개 · 측정 판 ${line.commit}`,
    '',
  ].join('\n'));
  return path;
}
