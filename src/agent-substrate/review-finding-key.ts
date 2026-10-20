import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const REVIEW_FINDING_KEY_VERSION = 'reviewFindingKey-v1';
export const MAX_CITED_REVIEW_SYMBOL_CHARS = 256;
const CITED_REVIEW_SYMBOL_HASH_CHARS = 16;
const CITED_PATH_EXTENSION = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yaml|yml|sh|py|toml|css|go|sql|rs|rb|java|kt|swift|c|h|cpp|hpp|graphql|proto)$/;

export interface CitedReviewSymbol {
  hash: string;
  symbol: string;
}

export interface ReviewFindingKeyOverlap {
  comparable: boolean;
  sharedSymbolCount: number;
  leftSymbolCount: number;
  rightSymbolCount: number;
  /** Shared comparison identities divided by the smaller normalized symbol set; undefined when either finding has no citations. */
  overlapRatio: number | undefined;
}

export type CitedReviewPathStatus = 'present' | 'missing' | 'unreadable';

export interface ReviewFindingPathHeadCheck {
  head: string;
  status: 'verified' | 'path-missing' | 'unreadable' | 'no-cited-path';
  paths: Array<{ path: string; status: CitedReviewPathStatus }>;
}

/** Only file-shaped citations are checked; symbols such as `terminal.id` are not paths. */
export function citedReviewPaths(finding: string): string[] {
  return [...new Set(fullCitedReviewSymbols(finding)
    .map((symbol) => symbol.replace(/^\.\//, '').replace(/:\d+(?::\d+)?$/, ''))
    .filter((symbol) => !symbol.startsWith('/')
      && !symbol.includes('\\')
      && !symbol.includes('://')
      && /^[A-Za-z0-9_.@+/-]+$/.test(symbol)
      && !symbol.split('/').some((part) => part === '..' || part === '')
      && (symbol.includes('/') || CITED_PATH_EXTENSION.test(symbol))))];
}

/** Check cited paths against the supplied exact commit, never the worktree's current HEAD. */
export function checkCitedReviewPathsAtHead(finding: string, repo: string, head: string): ReviewFindingPathHeadCheck {
  const paths = citedReviewPaths(finding);
  if (paths.length === 0) return { head, status: 'no-cited-path', paths: [] };
  if (!/^[0-9a-f]{40}$/i.test(head)) {
    return { head, status: 'unreadable', paths: paths.map((path) => ({ path, status: 'unreadable' })) };
  }
  const commitType = spawnSync('git', ['-C', repo, 'cat-file', '-t', head], { encoding: 'utf8' });
  if (commitType.error || commitType.status !== 0 || commitType.stdout?.trim() !== 'commit') {
    return { head, status: 'unreadable', paths: paths.map((path) => ({ path, status: 'unreadable' })) };
  }
  const checked = paths.map((path): { path: string; status: CitedReviewPathStatus } => {
    const result = spawnSync('git', ['--literal-pathspecs', '-C', repo, 'ls-tree', '-r', '-z', '--full-tree', head, '--', path], {
      encoding: 'utf8', maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) return { path, status: 'unreadable' };
    const output = typeof result.stdout === 'string' ? result.stdout : '';
    const present = output.split('\0').some((entry) => {
      const separator = entry.indexOf('\t');
      return separator >= 0 && entry.slice(separator + 1) === path;
    });
    return { path, status: present ? 'present' : 'missing' };
  });
  return {
    head,
    status: checked.some(({ status }) => status === 'unreadable') ? 'unreadable'
      : checked.some(({ status }) => status === 'missing') ? 'path-missing' : 'verified',
    paths: checked,
  };
}

interface ReviewFindingKey {
  key: string;
  source: 'symbol' | 'prose';
}

export function normalizeReviewFindingKey(finding: string): string {
  return finding
    .toLowerCase()
    .replace(/`[^`]*`/g, '')
    .replace(/\d/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeCitedReviewSymbolForComparison(symbol: string): string {
  const comparisonSymbol = symbol.replace(/\.id$/, 'Id');
  return createHash('sha256').update(comparisonSymbol).digest('hex').slice(0, CITED_REVIEW_SYMBOL_HASH_CHARS);
}

function fullCitedReviewSymbols(finding: string): string[] {
  const symbols = new Map<string, string>();
  for (const match of finding.matchAll(/`([^`]*)`/g)) {
    const symbol = match[1]!.trim();
    if (!symbol) continue;
    const hash = createHash('sha256').update(symbol).digest('hex').slice(0, CITED_REVIEW_SYMBOL_HASH_CHARS);
    symbols.set(hash, symbol);
  }
  return [...symbols.values()];
}

export function citedReviewSymbols(finding: string): CitedReviewSymbol[] {
  return fullCitedReviewSymbols(finding).map((symbol) => ({
    hash: createHash('sha256').update(symbol).digest('hex').slice(0, CITED_REVIEW_SYMBOL_HASH_CHARS),
    symbol: symbol.slice(0, MAX_CITED_REVIEW_SYMBOL_CHARS),
  }));
}

export function measureReviewFindingKeyOverlap(leftFinding: string, rightFinding: string): ReviewFindingKeyOverlap {
  const leftSymbols = fullCitedReviewSymbols(leftFinding);
  const rightSymbols = fullCitedReviewSymbols(rightFinding);
  if (leftSymbols.length === 0 || rightSymbols.length === 0) {
    return {
      comparable: false,
      sharedSymbolCount: 0,
      leftSymbolCount: leftSymbols.length,
      rightSymbolCount: rightSymbols.length,
      overlapRatio: undefined,
    };
  }

  const leftComparisonHashes = new Set(leftSymbols.map(normalizeCitedReviewSymbolForComparison));
  const rightComparisonHashes = new Set(rightSymbols.map(normalizeCitedReviewSymbolForComparison));
  const sharedSymbolCount = [...leftComparisonHashes].filter((hash) => rightComparisonHashes.has(hash)).length;
  return {
    comparable: true,
    sharedSymbolCount,
    leftSymbolCount: leftSymbols.length,
    rightSymbolCount: rightSymbols.length,
    overlapRatio: sharedSymbolCount / Math.min(leftComparisonHashes.size, rightComparisonHashes.size),
  };
}

export function reviewFindingKey(finding: string): ReviewFindingKey {
  const symbols = citedReviewSymbols(finding);
  if (symbols.length > 0) {
    const symbolSet = [...new Set(symbols.map(({ symbol }) => symbol.trim()))].sort();
    return { key: `symbol:${JSON.stringify(symbolSet)}`, source: 'symbol' };
  }
  return { key: normalizeReviewFindingKey(finding), source: 'prose' };
}

export function shortNormalizedReviewFindingHash(normalizedFinding: string): string {
  return createHash('sha256').update(normalizedFinding).digest('hex').slice(0, 8);
}
