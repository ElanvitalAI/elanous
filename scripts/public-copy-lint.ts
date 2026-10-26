#!/usr/bin/env bun
/** Warning-only public-copy shadow scan. It never edits source or exposes private candidate text. */
import { existsSync, readFileSync } from 'node:fs';
import { extname, normalize, relative, resolve, sep } from 'node:path';
import { PatentLedger } from '../src/patents/ledger.js';
import { checkBrandText } from './brand/check.js';

export type PublicCopyInput = { label: string; text: string };
export type PublicCopyFinding = { source: string; line: number; rule: string };
export type PatentLineMatcher = (text: string) => number[];
export type PublicCopyScan = {
  findings: PublicCopyFinding[];
  excludedSources: Array<{ source: string; reason: 'internal-goal-document' }>;
  brandRulesAvailable: boolean;
  patentLedgerAvailable: boolean;
};

function normalizedLabel(label: string): string | undefined {
  const slashed = label.replaceAll('\\', '/');
  if (slashed.startsWith('/')) return undefined;
  const normalized = normalize(slashed).replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized === '..' || normalized.startsWith('../')) return undefined;
  return normalized;
}

function allowedNormalizedLabel(normalized: string | undefined): boolean {
  if (!normalized) return false;
  if (normalized === 'PR-BODY') return true;
  if (normalized.split('/').some((part) => part === '..' || part === '')) return false;
  if (!['.md', '.mdx', '.txt', '.html', '.htm'].includes(extname(normalized).toLowerCase())) return false;
  return ['docs/', 'release/public/docs/', 'blog/', 'posts/', 'content/blog/', 'content/posts/']
    .some((root) => normalized.startsWith(root));
}

/** Brand rule messages intentionally omit matched text; patent matches are private too. */
export function scanPublicCopy(inputs: readonly PublicCopyInput[], matchPrivateCandidate: PatentLineMatcher, rulesPath?: string): PublicCopyScan {
  const findings: PublicCopyFinding[] = [];
  const excludedSources: PublicCopyScan['excludedSources'] = [];
  let brandRulesAvailable = true;
  let patentLedgerAvailable = true;
  for (const input of inputs) {
    const label = normalizedLabel(input.label);
    if (!allowedNormalizedLabel(label)) throw new Error(`공개 문면 입력 경로가 허용 목록 밖입니다: ${input.label}`);
    // Goal specs are internal execution artifacts, not customer-facing copy.
    // Counting their acceptance criteria as marketing measurements created a
    // high false-positive rate in the 30-PR audit.
    if (label?.startsWith('docs/goals/')) {
      excludedSources.push({ source: input.label, reason: 'internal-goal-document' });
      continue;
    }
    try {
      const brandFindings = checkBrandText(input.text, input.label, 'public-docs', rulesPath);
      // Publication-specific promise/measurement rules apply to this explicit
      // shadow scan without changing the existing generic brand-check scopes.
      const publicationFindings = checkBrandText(input.text, input.label, 'release-notes', rulesPath)
        .filter((hit) => hit.id === 'BRAND-SOON' || hit.id === 'B4-NUMBER-SOURCE');
      for (const hit of [...brandFindings, ...publicationFindings]) {
        findings.push({ source: input.label, line: hit.line, rule: hit.id });
      }
    } catch { brandRulesAvailable = false; }
    try { for (const line of matchPrivateCandidate(input.text)) findings.push({ source: input.label, line, rule: 'PRIVATE-PATENT-CANDIDATE' }); }
    catch { patentLedgerAvailable = false; }
  }
  if (inputs.length === 0 || excludedSources.length === inputs.length) {
    // No scanner ran, so availability must not claim a successful measurement.
    brandRulesAvailable = false;
    patentLedgerAvailable = false;
  }
  return {
    findings: findings.sort((a, b) => a.source.localeCompare(b.source) || a.line - b.line || a.rule.localeCompare(b.rule)),
    excludedSources,
    brandRulesAvailable, patentLedgerAvailable,
  };
}

export function lintPublicCopy(inputs: readonly PublicCopyInput[], matchPrivateCandidate: PatentLineMatcher): PublicCopyFinding[] {
  return scanPublicCopy(inputs, matchPrivateCandidate).findings;
}

export function run(argv: readonly string[], root = process.cwd(), ledger = new PatentLedger()): number {
  const files: string[] = [];
  let bodyFile: string | undefined;
  let bodyLabel = 'PR-BODY';
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--files') {
      while (argv[i + 1] && !argv[i + 1]!.startsWith('--')) files.push(argv[++i]!);
      if (!files.length) throw new Error('--files 에 문면 경로가 필요합니다');
    } else if (arg === '--pr-body-file') {
      bodyFile = argv[++i];
      if (!bodyFile || bodyFile.startsWith('--')) throw new Error('--pr-body-file 에 본문 파일이 필요합니다');
    } else if (arg === '--pr-body-label') {
      bodyLabel = argv[++i] ?? '';
      if (!bodyLabel || bodyLabel.startsWith('--')) throw new Error('--pr-body-label 에 라벨이 필요합니다');
    } else throw new Error(`알 수 없는 옵션: ${arg}`);
  }
  if (!files.length && !bodyFile) throw new Error('usage: bun scripts/public-copy-lint.ts [--files <docs...>] [--pr-body-file <file> [--pr-body-label <repo-relative-label>]] [--json]');
  const inputs: PublicCopyInput[] = files.map((file) => ({
    label: relative(root, resolve(root, file)).split(sep).join('/'), text: readFileSync(resolve(root, file), 'utf8'),
  }));
  if (bodyFile) inputs.push({ label: bodyLabel, text: readFileSync(resolve(root, bodyFile), 'utf8') });
  const matchPrivateCandidate: PatentLineMatcher = (text) => {
    return ledger.unapprovedCandidateLineNumbers(text);
  };
  const scan = scanPublicCopy(inputs, matchPrivateCandidate);
  if (json) console.log(JSON.stringify({ mode: 'warning-only', ...scan }));
  else {
    for (const finding of scan.findings) console.log(`${finding.source}:${finding.line}:WARN:${finding.rule}`);
    for (const excluded of scan.excludedSources) console.log(`${excluded.source}:SKIP:${excluded.reason}`);
    if (!scan.brandRulesAvailable) console.log('WARN:BRAND-RULES-UNMEASURED');
    if (!scan.patentLedgerAvailable) console.log('WARN:PRIVATE-PATENT-LEDGER-UNMEASURED');
    console.log(`public-copy-lint warning-only documents=${inputs.length - scan.excludedSources.length} excluded=${scan.excludedSources.length} findings=${scan.findings.length} brand-rules=${scan.brandRulesAvailable ? 'measured' : 'unmeasured'} patent-ledger=${scan.patentLedgerAvailable ? 'measured' : 'unmeasured'}`);
  }
  return 0;
}

if (import.meta.main) {
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
}
