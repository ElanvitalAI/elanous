import { readdir } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

/** Candidate contract matches the classic chat `onAtCandidates` shape. */
export interface AtFileCandidate {
  readonly label: string;
  readonly absPath: string;
  readonly isDir: false;
}

export interface AtQuery {
  readonly prefix: string;
  readonly start: number;
  readonly end: number;
}

export function parseAtQuery(text: string, cursor: number): AtQuery | null {
  const head = text.slice(0, cursor);
  const match = head.match(/(?:^|\s)@([\p{L}\p{N}_./~\\-]*)$/u);
  if (!match) return null;
  const prefix = match[1] ?? '';
  return { prefix, start: head.length - prefix.length - 1, end: cursor };
}

/** List local files under root only; directories are traversal prefixes, never candidates. */
export async function listAtFiles(prefix: string, root: string): Promise<AtFileCandidate[]> {
  const slash = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\'));
  const typedDir = slash < 0 ? '' : prefix.slice(0, slash + 1);
  const partial = slash < 0 ? prefix : prefix.slice(slash + 1);
  const dirPart = typedDir.replaceAll('\\', sep).replace(/^~(?=\/)/, '');
  const base = resolve(root, dirPart || '.');
  const inside = relative(resolve(root), base);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return [];
  try {
    const entries = await readdir(base, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLocaleLowerCase().startsWith(partial.toLocaleLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 15)
      .map((entry) => ({ label: `${typedDir}${entry.name}`, absPath: resolve(base, entry.name), isDir: false as const }));
  } catch {
    return [];
  }
}

export function acceptAtFile(text: string, query: AtQuery, candidate: AtFileCandidate, ordinal: number): { text: string; cursor: number; token: string } {
  const token = `[attached ${ordinal}: ${basename(candidate.absPath)}]`;
  const insertion = `${token} `;
  const next = text.slice(0, query.start) + insertion + text.slice(query.end);
  return { text: next, cursor: query.start + insertion.length, token };
}

export function attachmentsForMessage(text: string, selected: ReadonlyMap<string, string>): string[] {
  return [...selected].filter(([token]) => text.includes(token)).map(([, path]) => path);
}
