import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import type { RunGh, ScannedStoppedPr, StoppedPrCategory } from './helper-scan.js';

export interface RepairGoalInput {
  pr: number;
  category: StoppedPrCategory;
  /** The original user's request, not the supervisor's stop report or a paraphrase. */
  originalRequest: string;
  /** Remaining reviewer must-fix items, in their original wording and order. */
  mustFix: readonly string[];
}

/** Author a single follow-up goal without changing the original ask or reviewer findings. */
export function authorRepairGoal({ pr, category, originalRequest, mustFix }: RepairGoalInput): string | null {
  if ((category !== 'review-budget' && category !== 'review-oscillation') || !originalRequest.trim() || !mustFix.length || mustFix.some((item) => !item.trim())) {
    return null;
  }

  const guidance = category === 'review-oscillation'
    ? '기존 시험 설계를 보존하고 리뷰 진동·설계 역행을 확인한 뒤 남은 must-fix를 수리하라.'
    : '남은 must-fix를 수리하라. 원래 요청의 범위와 기존 시험 설계를 보존하라.';
  return `${originalRequest}${originalRequest.endsWith('\n') ? '' : '\n'}\n## PR #${pr} 수리\n${guidance}\n\n## 남은 must-fix (원문)\n${mustFix.join('\n')}`;
}

/** PR 본문에서 원 요청(## 요청 절)과 남은 must-fix(## 마지막 리뷰 must-fix · ## Follow-up must-fix 의 «- » 항목)를 원문 그대로 뽑는다. */
export function repairInputsFromBody(body: string): { originalRequest: string; mustFix: string[] } {
  const section = (title: RegExp) => {
    const lines = body.split('\n');
    const start = lines.findIndex((line) => title.test(line));
    if (start < 0) return [] as string[];
    const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
    return lines.slice(start + 1, end < 0 ? undefined : end);
  };
  const requestLines = section(/^## 요청\s*$/);
  while (requestLines[0] === '') requestLines.shift();
  while (requestLines.length > 1 && requestLines.at(-1) === '' && requestLines.at(-2) === '') requestLines.pop();
  if (requestLines.length === 2 && requestLines[1] === '') requestLines.pop();
  const originalRequest = requestLines.join('\n');
  const mustFix: string[] = [];
  for (const lines of [section(/^## 마지막 리뷰 must-fix/), section(/^## Follow-up must-fix/)]) {
    let item: string[] = [];
    const flush = () => {
      while (item.at(-1) === '') item.pop();
      if (item.length) mustFix.push(item.join('\n'));
      item = [];
    };
    for (const line of lines) {
      if (/^- /.test(line)) {
        flush();
        item.push(line);
      } else if (item.length) {
        item.push(line);
      }
    }
    flush();
  }
  return { originalRequest, mustFix };
}

export type RepairShadowRow = { pr: number; category: StoppedPrCategory; goalHash: string; at: string };

/** 그림자: 수리 골을 저작해 헬퍼 원장에만 남긴다(발사·라벨 0) · 같은 PR 은 한 번만. */
export async function recordRepairShadows(rows: readonly ScannedStoppedPr[], deps: { runGh: RunGh; root: string; now?: Date }): Promise<RepairShadowRow[]> {
  const ledger = join(deps.root, 'helper', 'repairs.jsonl');
  const seen = new Set<number>();
  if (existsSync(ledger)) for (const line of readFileSync(ledger, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { seen.add((JSON.parse(line) as { pr: number }).pr); } catch { /* malformed line is skipped */ }
  }
  const written: RepairShadowRow[] = [];
  for (const row of rows) {
    if ((row.category !== 'review-budget' && row.category !== 'review-oscillation') || seen.has(row.pr)) continue;
    const view = JSON.parse(await deps.runGh(['pr', 'view', String(row.pr), '--json', 'body'])) as { body: string };
    const goal = authorRepairGoal({ pr: row.pr, category: row.category, ...repairInputsFromBody(view.body) });
    if (!goal) continue;
    const entry: RepairShadowRow = { pr: row.pr, category: row.category, goalHash: createHash('sha256').update(goal).digest('hex').slice(0, 16), at: (deps.now ?? new Date()).toISOString() };
    mkdirSync(dirname(ledger), { recursive: true });
    appendFileSync(ledger, JSON.stringify({ ...entry, mode: 'shadow', goal }) + '\n');
    debug.log('harness.helper', 'repair-authored', { pr: row.pr, category: row.category, mode: 'shadow' });
    seen.add(row.pr);
    written.push(entry);
  }
  return written;
}
