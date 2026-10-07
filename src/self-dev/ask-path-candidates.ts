import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export interface AskPathCandidateOptions {
  readonly cwd: string;
  readonly run?: (command: string, args: readonly string[], options: { cwd: string; encoding: 'utf8' }) => string;
}

export type AskPathCandidates =
  | { readonly tokens: string[]; readonly paths: string[]; readonly error?: undefined }
  | { readonly tokens: string[]; readonly paths: string[]; readonly error: string };

const STOP_WORDS = new Set(['the', 'and', 'test', 'src', 'scripts', 'file', 'path', 'paths', 'code', 'with', 'from', 'this', 'that', 'into', 'for', 'then', 'when', 'have', 'does', 'should', 'will', 'please', 'target', 'change']);
const WORD = /[-/]?[A-Za-z][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)*/g;

function existingFile(fragment: string, cwd: string): string | null {
  const path = fragment.replace(/^\.\//, '');
  if (!path.includes('/') && !/\.[A-Za-z][A-Za-z0-9]*$/.test(path)) return null;
  const absolute = resolve(cwd, path);
  const rel = relative(cwd, absolute);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  try { return statSync(absolute).isFile() ? rel.split('\\').join('/') : null; }
  catch { return null; }
}

/** Find existing code paths by lexical evidence from an unmodified ask. */
export function findAskPathCandidates(askText: string, { cwd, run = execFileSync }: AskPathCandidateOptions): AskPathCandidates {
  const scores = new Map<string, Set<string>>();
  const tokens: string[] = [];
  const seen = new Set<string>();
  const chunks = [...askText.matchAll(/`([^`]+)`/g)].map((match) => match[1]!).concat([askText]);
  for (const chunk of chunks) {
    for (const match of chunk.matchAll(WORD)) {
      const raw = match[0];
      const token = raw.replace(/^\//, '');
      const file = existingFile(token, cwd);
      if (file) {
        const hits = scores.get(file) ?? new Set<string>();
        hits.add(token);
        scores.set(file, hits);
      }
      if (STOP_WORDS.has(token.toLowerCase()) || seen.has(token)) continue;
      if (!file && !token.includes('/') && !token.includes('.') && !token.includes('-') && !token.includes('_')
        && !/[a-z][A-Z]/.test(token) && token.length < 4) continue;
      seen.add(token);
      tokens.push(token);
    }
  }
  for (const token of tokens) {
    let matches: string;
    try {
      matches = run('rg', ['-l', '-F', '--glob', '!*.test.ts', '--', token, 'src', 'scripts'], { cwd, encoding: 'utf8' });
    } catch (error) {
      if ((error as { status?: number }).status === 1) continue; // rg: no matches
      return { tokens, paths: [], error: error instanceof Error ? error.message : String(error) };
    }
    for (const path of matches.split(/\r?\n/).filter(Boolean)) {
      const hits = scores.get(path) ?? new Set<string>();
      hits.add(token);
      scores.set(path, hits);
    }
  }
  return {
    tokens,
    paths: [...scores].sort(([a, aHits], [b, bHits]) => bHits.size - aHits.size || a.localeCompare(b, 'en')).slice(0, 5).map(([path]) => path),
  };
}
