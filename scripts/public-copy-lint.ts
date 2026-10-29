#!/usr/bin/env bun
/** Warning-only public-copy shadow scan. It never edits source or exposes private candidate text. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import { PatentLedger } from '../src/patents/ledger.js';
import { checkBrandText } from './brand/check.js';

export type PublicCopyInput = { label: string; text: string };
export type PublicCopyFinding = { source: string; line: number; rule: string };
export type PatentLineMatcher = (text: string) => number[];
export type PublicCopyScan = {
  findings: PublicCopyFinding[];
  excludedSources: Array<{ source: string; reason: 'internal-goal-document' | 'internal-marketing-source' | 'asset-manifest' }>;
  documents: Array<{ source: string; findings: number; companyNameMentions: number; placeholderMentions: number }>;
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

function publicCopyExclusion(normalized: string): PublicCopyScan['excludedSources'][number]['reason'] | undefined {
  if (normalized.startsWith('docs/goals/')) return 'internal-goal-document';
  if (!normalized.startsWith('docs/marketing/')) return undefined;
  const relativePath = normalized.slice('docs/marketing/'.length);
  const basename = relativePath.split('/').at(-1) ?? '';
  // These files are published records or release-specific source notes, not
  // current copy candidates. Preserve their exact product names and evidence.
  if (/^(?:BLOG-02-the-agent-drives-the-agent-|BLOG-03-it-drives-the-terminal-itself-|DRAFT-0\.2\.(?:7|8)-announcement-|DRAFT-0\.2\.7-known-issues-public-wording-|DRAFT-0\.2\.10-announcement-|PRFAQ-release-0\.2\.4-|SCRIPT-ax-demo-1008-|VO-teaser-v2-)/i.test(basename)
    || /^docs\/marketing\/launch\/(?:0\.2\.8-loop-final\/|0\.2\.8-rehearsal\/PRFAQ-generated\.md$|0\.2\.11-cut-)/i.test(normalized)) {
    return 'internal-marketing-source';
  }
  if (normalized.startsWith('docs/marketing/') && /^(?:BRIEF-|DOCS-|EVENT-|GUIDE-|MANUAL-|MAP-|MATURITY-|PLAN-|RESEARCH-|RFC-|SCENARIO-|STORYBOARD-|STORYLINE-|STRATEGY-|SOURCES-)/i.test(basename)) {
    return 'internal-marketing-source';
  }
  if (normalized.startsWith('docs/marketing/') && /^DRAFT-persona-/i.test(basename)) return 'internal-marketing-source';
  if (/^docs\/marketing\/teaser-v\d+\/MANIFEST\.md$/i.test(normalized) || normalized === 'docs/marketing/decks/media/README.md') {
    return 'asset-manifest';
  }
  return undefined;
}

function isRequestedPublicCopyPath(normalized: string): boolean {
  return normalized === 'README.md' || normalized.startsWith('docs/marketing/');
}

function maskSpan(text: string, start: number, end: number): string {
  return text.slice(start, end).replace(/[^\r\n]/g, ' ');
}

/** Keep line offsets while limiting brand checks to visible prose, not code, comments, metadata, or link targets. */
function visibleMarkdownProse(text: string): string {
  let visible = text;
  const masks: RegExp[] = [
    /^---\r?\n[\s\S]*?\r?\n---\s*$/gm,
    /<!--[\s\S]*?-->/g,
    /^\s*(```|~~~)[^\r\n]*\r?\n[\s\S]*?^\s*\1\s*$/gm,
    /`[^`\r\n]*`/g,
    /\]\((?:\\.|[^)])*\)/g,
    /^>\s*🧾\s*\*\*공개 전 할 일\*\*[\s\S]*?(?=^[^>\r\n]|$(?![\s\S]))/gm,
    /^##\s*(?:\d+\.\s*)?(?:칸|출처 목록|sources|evidence|게시 직전 다시 잴 것|기준선|올리기 전 확인)(?:\s|$)[\s\S]*?(?=^##\s|$(?![\s\S]))/gim,
    /^>\s*✏️\s*\*\*착지·실측된 것만\.[^\r\n]*$/gm,
    /https?:\/\/[^\s)>]+/gi,
    /\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?:\/[^\s)>]*)?/g,
  ];
  for (const pattern of masks) {
    const matches = [...visible.matchAll(pattern)].map((match) => ({ start: match.index!, end: match.index! + match[0].length }));
    for (const match of matches.reverse()) visible = visible.slice(0, match.start) + maskSpan(visible, match.start, match.end) + visible.slice(match.end);
  }
  return visible;
}

const PUBLIC_COMPANY_NAMES = /\b(?:OpenAI|ChatGPT|Codex|Claude(?:\s+Code)?|Anthropic|Gemini|Google|Grok|xAI|Devin|Cognition|OpenHands|Replit(?:\s+Agent(?:\s+\d+)?)?|Factory(?:\s+AI)?|Hermes|OpenClaw|Manus)\b/gi;
const PUBLIC_PLACEHOLDER = /\b(?:another coding agent|another agent platform)\b/gi;
const PUBLIC_PLACEHOLDER_LIST = /\ba coding tool\s*[,·]\s*the coding CLI\s*[,·]\s*an AI model\s*[,·]\s*a model provider\b/gi;
const UNSUPPORTED_COMPARISON = /\b(?:better|faster|cheaper|safer|worse|superior|inferior)\s+than\b|\b(?:vs\.?|versus|compared\s+(?:with|to))\b|(?:보다\s*(?:낫|빠르|저렴|좋|강력|안전|우수))/i;

function companyNameMentions(text: string): number {
  return [...text.matchAll(PUBLIC_COMPANY_NAMES)].length;
}

function placeholderMentions(text: string): number {
  return [...text.matchAll(PUBLIC_PLACEHOLDER)].length + [...text.matchAll(PUBLIC_PLACEHOLDER_LIST)].length;
}

function hasSupportedComparisonEvidence(text: string): boolean {
  const hasSource = /\b(?:source|citation)\b|출처/i.test(text);
  const hasMeasurement = /\b(?:measur|benchmark|tested|test conditions?)\w*\b|실측|측정|측정 조건/i.test(text);
  return hasSource && hasMeasurement;
}

function measuredScopeMatchesClaim(claim: string): boolean {
  const quantity = String.raw`(\d+(?:\.\d+)?)`;
  const unit = String.raw`(jobs?|tasks?|workflows?|items?|건|개|작업)`;
  const claimScope = new RegExp(String.raw`(?:completes?|processes?|handles?|완료|처리)\s*${quantity}\s*${unit}`, 'i').exec(claim);
  const measuredScope = new RegExp(String.raw`(?:measured|measurement|실측|측정).*?(?:scope|range|범위).*?(?:limited to|only|한정|범위 내)\s*${quantity}\s*${unit}`, 'i').exec(claim);
  if (!claimScope || !measuredScope) return false;
  const normalizeUnit = (value: string): string => {
    const normalized = value.toLowerCase();
    if (normalized === 'job' || normalized === 'jobs' || normalized === 'task' || normalized === 'tasks' || normalized === 'workflow' || normalized === 'workflows' || normalized === 'item' || normalized === 'items') return normalized.replace(/s$/, '');
    return normalized;
  };
  return claimScope[1] === measuredScope[1] && normalizeUnit(claimScope[2]!) === normalizeUnit(measuredScope[2]!);
}

function oneClickFindings(text: string, source: string): PublicCopyFinding[] {
  const lines = text.split(/\r?\n/);
  const findings: PublicCopyFinding[] = [];
  for (let index = 0; index < lines.length; index++) {
    const claims = lines[index]!.split(/(?<=[.!?。！？;；])\s*/).filter((segment) => /\bone[ -]click\b|원\s*클릭/i.test(segment));
    for (const claim of claims) {
      const hasLimitedClaimScope = !/(?:every|all|entire|unlimited|모든|전체|무제한)/i.test(claim)
        && /(?:completes?|processes?|handles?|완료|처리)/i.test(claim)
        && /\b\d+(?:\.\d+)?\s+(?:jobs?|tasks?|workflows?|items?)\b|\d+(?:\.\d+)?\s*(?:건|개|작업)/i.test(claim);
      const hasMeasuredScope = hasLimitedClaimScope
        && measuredScopeMatchesClaim(claim)
        && !/(?:no|not|without|unmeasured|측정되지 않|범위 없음|범위가 없|한정되지 않)/i.test(claim);
      if (!hasMeasuredScope) findings.push({ source, line: index + 1, rule: 'ONE-CLICK-MEASURED-SCOPE' });
      const hasPublicationApprovalStatus = /(?:approved for publication|publication approved|publication approval pending|publication not approved|not approved for publication|unapproved|pending|게시\s*승인(?:됨|완료)?|게시\s*미승인|게시\s*승인\s*보류|게시\s*승인\s*상태\s*:\s*(?:승인|미승인|보류)|승인되지 않)/i.test(claim);
      if (!hasPublicationApprovalStatus) findings.push({ source, line: index + 1, rule: 'ONE-CLICK-APPROVAL-STATUS' });
    }
  }
  return findings;
}

function allowedNormalizedLabel(normalized: string | undefined): boolean {
  if (!normalized) return false;
  if (normalized === 'PR-BODY' || normalized === 'README.md') return true;
  if (normalized.split('/').some((part) => part === '..' || part === '')) return false;
  if (!['.md', '.mdx', '.txt', '.html', '.htm'].includes(extname(normalized).toLowerCase())) return false;
  return ['docs/', 'release/public/docs/', 'blog/', 'posts/', 'content/blog/', 'content/posts/']
    .some((root) => normalized.startsWith(root));
}

/** Brand rule messages intentionally omit matched text; patent matches are private too. */
export function scanPublicCopy(inputs: readonly PublicCopyInput[], matchPrivateCandidate: PatentLineMatcher, rulesPath?: string): PublicCopyScan {
  const findings: PublicCopyFinding[] = [];
  const excludedSources: PublicCopyScan['excludedSources'] = [];
  const documents: PublicCopyScan['documents'] = [];
  let brandRulesAvailable = true;
  let patentLedgerAvailable = true;
  for (const input of inputs) {
    const label = normalizedLabel(input.label);
    if (!allowedNormalizedLabel(label)) throw new Error(`공개 문면 입력 경로가 허용 목록 밖입니다: ${input.label}`);
    const excludedReason = label ? publicCopyExclusion(label) : undefined;
    if (excludedReason) {
      excludedSources.push({ source: input.label, reason: excludedReason });
      continue;
    }
    const before = findings.length;
    const prose = visibleMarkdownProse(input.text);
    if (label && isRequestedPublicCopyPath(label)) findings.push(...oneClickFindings(prose, input.label));
    try {
      const brandFindings = checkBrandText(prose, input.label, 'public-docs', rulesPath)
        .filter((hit) => hit.id !== 'BRAND-COMPETITOR-NAME');
      // Publication-specific promise/measurement rules apply to this explicit
      // shadow scan without changing the existing generic brand-check scopes.
      const publicationFindings = checkBrandText(prose, input.label, 'release-notes', rulesPath)
        .filter((hit) => hit.id === 'BRAND-SOON' || hit.id === 'B4-NUMBER-SOURCE');
      const brandLines = new Set([...brandFindings, ...publicationFindings].map((hit) => `${hit.line}:${hit.id}`));
      for (const line of prose.split(/\r?\n/).map((text, index) => ({ text, line: index + 1 }))) {
        if (UNSUPPORTED_COMPARISON.test(line.text) && PUBLIC_COMPANY_NAMES.test(line.text)
          && !hasSupportedComparisonEvidence(line.text)) {
          brandLines.add(`${line.line}:BRAND-UNSUPPORTED-COMPARISON`);
        }
        PUBLIC_COMPANY_NAMES.lastIndex = 0;
        UNSUPPORTED_COMPARISON.lastIndex = 0;
        if (PUBLIC_PLACEHOLDER.test(line.text) || PUBLIC_PLACEHOLDER_LIST.test(line.text)) {
          brandLines.add(`${line.line}:PUBLIC-COPY-PLACEHOLDER`);
        }
        PUBLIC_PLACEHOLDER.lastIndex = 0;
        PUBLIC_PLACEHOLDER_LIST.lastIndex = 0;
      }
      for (const key of brandLines) {
        const [line, rule] = key.split(':');
        findings.push({ source: input.label, line: Number(line), rule: rule! });
      }
    } catch { brandRulesAvailable = false; }
    try { for (const line of matchPrivateCandidate(input.text)) findings.push({ source: input.label, line, rule: 'PRIVATE-PATENT-CANDIDATE' }); }
    catch { patentLedgerAvailable = false; }
    documents.push({ source: input.label, findings: findings.length - before, companyNameMentions: companyNameMentions(prose), placeholderMentions: placeholderMentions(prose) });
  }
  if (inputs.length === 0 || excludedSources.length === inputs.length) {
    // No scanner ran, so availability must not claim a successful measurement.
    brandRulesAvailable = false;
    patentLedgerAvailable = false;
  }
  return {
    findings: findings.sort((a, b) => a.source.localeCompare(b.source) || a.line - b.line || a.rule.localeCompare(b.rule)),
    excludedSources,
    documents,
    brandRulesAvailable, patentLedgerAvailable,
  };
}

export function lintPublicCopy(inputs: readonly PublicCopyInput[], matchPrivateCandidate: PatentLineMatcher): PublicCopyFinding[] {
  return scanPublicCopy(inputs, matchPrivateCandidate).findings;
}

function collectPublicCopyFiles(paths: readonly string[], root: string): string[] {
  const collected = new Set<string>();
  const visit = (path: string): void => {
    const absolute = resolve(root, path);
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory()) visit(relative(root, join(absolute, entry.name)));
        else if (entry.isFile() && ['.md', '.mdx', '.txt', '.html', '.htm'].includes(extname(entry.name).toLowerCase())) {
          collected.add(relative(root, join(absolute, entry.name)));
        }
      }
      return;
    }
    collected.add(relative(root, absolute));
  };
  for (const path of paths) visit(path);
  return [...collected].sort();
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
  const inputs: PublicCopyInput[] = collectPublicCopyFiles(files, root).map((file) => ({
    label: file.split(sep).join('/'), text: readFileSync(resolve(root, file), 'utf8'),
  }));
  if (bodyFile) inputs.push({ label: bodyLabel, text: readFileSync(resolve(root, bodyFile), 'utf8') });
  const matchPrivateCandidate: PatentLineMatcher = (text) => ledger.unapprovedCandidateLineNumbers(text);
  // The CLI caller uses the same scope-aware production scanner covered by focused tests.
  const scan = scanPublicCopy(inputs, matchPrivateCandidate);
  if (json) console.log(JSON.stringify({ mode: 'warning-only', documentsScanned: scan.documents.length, ...scan }));
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
