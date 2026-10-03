import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, sep } from 'node:path';

export type DriveInputJailVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'outside-jail'; readonly path: string };

/** Resolve each existing component before applying the next '..', including write targets. */
function canonicalPath(path: string): string {
  let current = isAbsolute(path) ? sep : realpathSync(process.cwd());
  for (const part of path.split(sep)) {
    if (!part || part === '.') continue;
    if (part === '..') {
      current = dirname(current);
      continue;
    }
    const next = `${current === sep ? '' : current}${sep}${part}`;
    try {
      current = realpathSync(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      current = next;
    }
  }
  return current;
}

function insideJail(boundary: string, candidate: string): boolean {
  const rel = relative(boundary, candidate);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Check path literals in brain-generated PTY text without executing or rewriting the text.
 * Absolute paths and home paths (~ and ~/) are checked against the canonical jail, including symlink
 * ancestors. This is a path-literal guard, not a shell interpreter or a sandbox for the child.
 */
export function checkDriveInputJail(input: string, boundary: string, home: string = homedir()): DriveInputJailVerdict {
  const jail = canonicalPath(boundary);
  // Quoted path arguments can contain spaces. Inspect those as one literal before scanning
  // unquoted tokens (which also covers option assignments such as --prefix=/opt/homebrew).
  const quotedRanges: Array<[number, number]> = [];
  const literals: string[] = [];
  for (const match of input.matchAll(/(["'])(.*?)\1/gs)) {
    const start = match.index ?? 0;
    if (match[2]?.startsWith('/') || match[2] === '~' || match[2]?.startsWith('~/')) {
      // A double-quoted string still runs $(…) and `…` — keep scanning inside it so a substituted
      // command's own paths (e.g. "/jail/$(cat /etc/passwd)") are checked too.
      const expands = match[1] === '"' && /\$\(|`/.test(match[2]);
      if (!expands) quotedRanges.push([start, start + match[0].length]);
      if (/\bPATH=$/.test(input.slice(0, start))) literals.push(...match[2].split(':').filter(Boolean));
      else literals.push(match[2]);
    }
  }
  const candidates = /(^|[\s"'`|&=:<>(\[,;])((?:~\/|\/)[^\s"'`|:;&<>()[\]{}]*|~(?=$|[\s"'`|:;&<>()[\]{},]))/gm;
  for (const match of input.matchAll(candidates)) {
    const literal = match[2]!;
    const start = (match.index ?? 0) + match[1]!.length;
    if (quotedRanges.some(([from, to]) => from < start && start < to)) continue;
    if (literal.startsWith('//') && /\w+:$/.test(input.slice(Math.max(0, start - 12), start))) continue;
    literals.push(literal);
  }
  for (const literal of literals) {
    const expanded = literal === '~' ? home : literal.startsWith('~/') ? `${home.replace(/\/$/, '')}/${literal.slice(2)}` : literal;
    if (!insideJail(jail, canonicalPath(expanded))) return { allowed: false, reason: 'outside-jail', path: literal };
  }
  return { allowed: true };
}

export interface DriveJailDeps {
  inject(text: string): boolean;
  observe(): string | Promise<string>;
}

/**
 * Put a drive's PTY input behind the jail. A blocked input is never sent to the PTY; the next screen the brain
 * reads carries one line saying why, so it can try another way inside the jail (returning false from inject
 * would end the loop as a human takeover). No jail → the deps come back unchanged.
 */
export function withDriveJail<T extends DriveJailDeps>(deps: T, jail: string | undefined, log?: (event: string, data: Record<string, unknown>) => void): T {
  if (!jail) return deps;
  let notice: string | null = null;
  return {
    ...deps,
    inject: (text: string) => {
      const verdict = checkDriveInputJail(text, jail);
      if (verdict.allowed) return deps.inject(text);
      notice = `⚠ elanous: input blocked — ${verdict.path} is outside the boundary ${jail} · try another way inside it`;
      log?.('jail-block', { path: verdict.path, input: text.slice(0, 80) });
      return true;
    },
    observe: async (): Promise<string> => {
      const frame = await deps.observe();
      if (notice === null) return frame;
      const line = notice;
      notice = null;
      return `${frame}\n${line}`;
    },
  };
}
