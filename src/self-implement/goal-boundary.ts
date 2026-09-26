const BOUNDARY_LINE = /(?:^|\n)[ \t]*(?:[-*+][ \t]+|>[ \t]*)*경계:[ \t]*([^\n]*)/g;
const BACKTICK_PATH = /`([^`\n]+)`/g;

function isPathOrGlob(token: string): boolean {
  const value = token.trim().replace(/^\.\//, '');
  if (!value || /\s/.test(value) || value === '.') return false;
  if (value.startsWith('/') || value.includes('..')) return false;
  return /^(?:[A-Za-z0-9._@~+-]+\/)*[A-Za-z0-9._@~*+-]+$/.test(value);
}

/** Backtick-wrapped paths and globs on `경계:` lines, in document order. */
export function boundaryGlobs(goalDocument: string): string[] {
  const found: string[] = [];
  for (const line of goalDocument.matchAll(BOUNDARY_LINE)) {
    const body = line[1] ?? '';
    for (const wrapped of body.matchAll(BACKTICK_PATH)) {
      const value = (wrapped[1] ?? '').trim();
      if (isPathOrGlob(value)) found.push(value);
    }
  }
  return found;
}

function normalizeBoundaryPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function escapeBoundaryAtom(atom: string): string {
  return atom.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** `*` stays in one segment. `**` crosses segments. A pattern with no wildcard also matches descendants. */
function boundaryGlobMatches(pattern: string, file: string): boolean {
  const glob = normalizeBoundaryPath(pattern);
  const target = normalizeBoundaryPath(file);
  if (!glob || !target) return false;
  const doubled = glob.replace(/\/?\*\*(?:\/|$)/g, '\u0000');
  const expression = doubled
    .split('\u0000')
    .map((part) => part.split('/').filter(Boolean).map((segment) => (
      segment.split('*').map(escapeBoundaryAtom).join('[^/]*')
    )).join('/'))
    .join('(?:/[^/]+)*');
  const anchored = glob.includes('*') ? `^${expression}$` : `^${expression}(?:/.*)?$`;
  return new RegExp(anchored).test(target);
}

/**
 * Changed files that land on a declared `경계:` glob.
 * Does not decide the run — the caller only reports the names.
 */
export function boundaryViolations(globs: readonly string[], changedFiles: readonly string[]): string[] {
  const patterns = [...new Set(globs.map(normalizeBoundaryPath).filter(Boolean))];
  if (patterns.length === 0) return [];
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const file of changedFiles) {
    const normalized = normalizeBoundaryPath(file);
    if (!normalized || seen.has(normalized)) continue;
    if (!patterns.some((pattern) => boundaryGlobMatches(pattern, normalized))) continue;
    seen.add(normalized);
    hits.push(normalized);
  }
  return hits;
}
