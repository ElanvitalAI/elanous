import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ChecklistItem } from './checklist.js';

/**
 * GREEN-TRIAGE (OP 11-24): one deterministic call that sorts every 🟡 cell into what to do next.
 *   judge    — a cited PR is merged on origin/main AND a receipt for that PR is on file → judge now
 *   evidence — a cited PR is merged, no receipt → produce evidence (sim/test/ops world + synthetic events)
 *   supply   — no cited PR is merged → supply (implement / land)
 * No LLM and no network: merged state = local `git log origin/main` squash subjects «… (#N)»;
 * receipts = a receipt path in the cell evidence bound to that PR, or a pregate GREEN lane directory `<PR>-<head12>-<host>`.
 */
export type GreenTriageBucket = 'judge' | 'evidence' | 'supply';
export interface GreenTriageRow { id: string; owner: string | null; bucket: GreenTriageBucket; prs: number[]; mergedPrs: number[]; receipt: string | null; reason: string }
export interface GreenTriageResult {
  version: string;
  counts: Record<GreenTriageBucket, number>;
  rows: Record<GreenTriageBucket, GreenTriageRow[]>;
  warnings: string[];
}
export interface GreenTriageSources {
  /** PR number → merge commit sha on origin/main. */
  merged: ReadonlyMap<number, string>;
  /** Pregate GREEN lane directory names (`<PR>-<head12>-<host>`). */
  greenLanes: readonly string[];
  /** Where the merge log came from; a shallow history can miss old merges (they then read as supply). */
  history?: { repo: string; shallow: boolean };
}

export const GREEN_TRIAGE_ROW_LIMIT = 20;
export const PREGATE_GREEN_DIR = join(homedir(), 'elanous-hq/seat-state/RES/evidence/PREGATE-GREEN');

const MERGE_SUBJECT = /\(#(\d{1,7})\)\s*$/u;
/** `git log --format=%H%x09%s` → PR number → merge sha. Only the trailing «(#N)» of the subject (squash-merge form) counts. */
export function parseMergeLog(text: string): Map<number, string> {
  const merged = new Map<number, string>();
  for (const line of text.split(/\r?\n/u)) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const sha = line.slice(0, tab), subject = line.slice(tab + 1);
    const match = MERGE_SUBJECT.exec(subject);
    if (match && /^[0-9a-f]{40}$/u.test(sha) && !merged.has(Number(match[1]))) merged.set(Number(match[1]), sha);
  }
  return merged;
}

const PR_TOKEN = /(?<![A-Za-z0-9_&#/])#(\d{3,7})(?![0-9])|\bpull\/(\d{1,7})\b/gu;
/** Every PR-shaped ref in the evidence (`#N`, `PR #N`, `(#N)`, `pull/N`). A ref that is not a merged PR (e.g. a mail id) simply never matches the merge log. */
export function evidencePrRefs(evidence: string): number[] {
  return [...new Set([...evidence.matchAll(PR_TOKEN)].map((match) => Number(match[1] ?? match[2])))];
}

const RECEIPT_PATH = /[\w~./-]*(?:PREGATE-GREEN\/\d+-[0-9a-f]{12}-[\w.-]+|receipt[\w.-]*\.json|headTestRun[\w.-]*\.json)/giu;
function refOnLine(line: string, pr: number): boolean {
  return new RegExp(`(?<![A-Za-z0-9_&/])#${pr}(?![0-9])|\\bpull/${pr}\\b|PREGATE-GREEN/${pr}-`, 'u').test(line);
}
/** A receipt for `pr`: an evidence receipt path on a line that cites the PR, else the newest-named pregate GREEN lane of that PR. */
export function receiptFor(pr: number, evidence: string, greenLanes: readonly string[]): string | null {
  for (const line of evidence.split(/\r?\n|⏎/u)) {
    if (!refOnLine(line, pr)) continue;
    const path = [...line.matchAll(RECEIPT_PATH)].map((match) => match[0]).find((token) => !token.includes('PREGATE-GREEN/') || token.includes(`PREGATE-GREEN/${pr}-`));
    if (path) return path;
  }
  const lane = greenLanes.filter((name) => name.startsWith(`${pr}-`) && /^\d+-[0-9a-f]{12}-/u.test(name)).sort().at(-1);
  return lane ? `PREGATE-GREEN/${lane}` : null;
}

export function triageGreen(version: string, items: readonly ChecklistItem[], sources: GreenTriageSources): GreenTriageResult {
  const rows: Record<GreenTriageBucket, GreenTriageRow[]> = { judge: [], evidence: [], supply: [] };
  for (const item of items) {
    if (item.status !== 'yellow') continue;
    const evidence = item.evidence ?? '';
    const prs = evidencePrRefs(evidence);
    const mergedPrs = prs.filter((pr) => sources.merged.has(pr));
    const base = { id: item.id, owner: item.owner ?? null, prs, mergedPrs };
    if (!mergedPrs.length) {
      rows.supply.push({ ...base, bucket: 'supply', receipt: null, reason: prs.length ? `no merged PR (cited ${prs.map((pr) => `#${pr}`).join(' ')})` : 'no PR in evidence' });
      continue;
    }
    const withReceipt = mergedPrs.map((pr) => ({ pr, receipt: receiptFor(pr, evidence, sources.greenLanes) })).find((entry) => entry.receipt);
    if (withReceipt) rows.judge.push({ ...base, bucket: 'judge', receipt: withReceipt.receipt, reason: `#${withReceipt.pr} merged ${sources.merged.get(withReceipt.pr)!.slice(0, 12)} · receipt ${withReceipt.receipt}` });
    else rows.evidence.push({ ...base, bucket: 'evidence', receipt: null, reason: `${mergedPrs.map((pr) => `#${pr}`).join(' ')} merged · no receipt — produce evidence (sim/test/ops world + synthetic events)` });
  }
  const warnings = sources.history?.shallow ? [`shallow git history (${sources.history.repo}) — merges older than its first commit read as supply`] : [];
  return { version, counts: { judge: rows.judge.length, evidence: rows.evidence.length, supply: rows.supply.length }, rows, warnings };
}

const BUCKET_TITLE: Record<GreenTriageBucket, string> = {
  judge: '(a) judge now — merged + receipt',
  evidence: '(b) produce evidence — merged, no receipt',
  supply: '(c) supply — no merged PR',
};
export function renderGreenTriage(result: GreenTriageResult, limit = GREEN_TRIAGE_ROW_LIMIT): string {
  const lines = [`${result.version} green-triage · judge ${result.counts.judge} · evidence ${result.counts.evidence} · supply ${result.counts.supply}`,
    ...result.warnings.map((warning) => `⚠ ${warning}`)];
  for (const bucket of ['judge', 'evidence', 'supply'] as const) {
    const rows = result.rows[bucket];
    lines.push(`${BUCKET_TITLE[bucket]}: ${rows.length}`);
    for (const row of rows.slice(0, limit)) lines.push(`  ${row.id} · ${row.mergedPrs.length ? row.mergedPrs.map((pr) => `#${pr}`).join(' ') : '-'} · ${row.reason}${row.owner ? ` · ${row.owner}` : ''}`);
    if (rows.length > limit) lines.push(`  … ${rows.length - limit} more (--json for all)`);
  }
  return lines.join('\n');
}

export interface GreenTriageReadDeps { gitLog?: () => string; greenLanes?: () => string[] }
/** HQ canonical checkout — used when the current directory is not a full-history clone (a seat cwd, a shallow worker). */
export const HQ_REPO_DIR = join(homedir(), 'elanous-hq/repo.git');

function gitIn(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: (result.stderr || result.error?.message || '').trim() };
}

/** First full-history checkout among cwd and the HQ repo; a shallow one is used only when nothing better exists (and is flagged). */
export function defaultGreenTriageGitLog(candidates: readonly string[] = [process.cwd(), HQ_REPO_DIR]): { log: string; repo: string; shallow: boolean } {
  let fallback: { log: string; repo: string; shallow: boolean } | undefined;
  const errors: string[] = [];
  for (const repo of candidates) {
    if (!existsSync(repo)) continue;
    const log = gitIn(repo, ['log', 'origin/main', '--first-parent', '--format=%H%x09%s']);
    if (!log.ok) { errors.push(`${repo}: ${log.stderr.slice(0, 160)}`); continue; }
    const shallow = gitIn(repo, ['rev-parse', '--is-shallow-repository']).stdout.trim() === 'true';
    if (!shallow) return { log: log.stdout, repo, shallow };
    fallback ??= { log: log.stdout, repo, shallow };
  }
  if (fallback) return fallback;
  throw new Error(`git log origin/main 을 읽을 저장소가 없다 — ${errors.join(' · ') || candidates.join(' · ')}`);
}

/** Local, read-only sources: `git log origin/main` (full-history checkout) and the pregate GREEN lane directory. */
export function readGreenTriageSources(deps: GreenTriageReadDeps = {}): GreenTriageSources {
  let history: GreenTriageSources['history'];
  const log = deps.gitLog ? deps.gitLog() : (() => { const read = defaultGreenTriageGitLog(); history = { repo: read.repo, shallow: read.shallow }; return read.log; })();
  const greenLanes = deps.greenLanes ?? (() => existsSync(PREGATE_GREEN_DIR) ? readdirSync(PREGATE_GREEN_DIR) : []);
  return { merged: parseMergeLog(log), greenLanes: greenLanes(), ...(history ? { history } : {}) };
}
