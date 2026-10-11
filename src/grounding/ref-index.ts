// Reference card builder — L0 card + L1 listing for one local-repo / local-docs source.
//
// Pure value out: nothing is written. File access goes through the injected
// `RefIndexFs`, and every read is capped (file count, bytes per file), so a
// full file body is never loaded. Persistence (`grounding index` → jsonl) and
// BM25 are deliberately not here — they are the next slice.

import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { GroundingSourceError, type GroundingSource } from './sources.js';

export interface RefIndexDirEntry {
  name: string;
  isDirectory: boolean;
}

export interface RefIndexFs {
  /** Names directly under `dir`. Unreadable dir → empty list. */
  readDir(dir: string): RefIndexDirEntry[];
  /** At most `maxBytes` from the start of the file. `truncated` when the file is longer. */
  readHead(file: string, maxBytes: number): { text: string; truncated: boolean } | undefined;
  /** Modified time of a path, ms since epoch. */
  mtimeMs(path: string): number | undefined;
  /** Last commit time (ISO) of a git repo, when it has one. */
  lastCommitAt(repoDir: string): string | undefined;
}

export interface RefIndexLimits {
  /** Max markdown/readme/package files opened for one source. */
  maxFiles: number;
  /** Max bytes read from the head of any one file. */
  maxBytesPerFile: number;
}

export const DEFAULT_REF_INDEX_LIMITS: RefIndexLimits = { maxFiles: 200, maxBytesPerFile: 16 * 1024 };

const ONE_LINE_MAX = 200;
const SKIP_DIRS = new Set(['node_modules']);

export interface ReferenceTitle {
  /** Path relative to the source root. */
  file: string;
  title: string;
}

export interface ReferenceCard {
  /** L0 — `name` is the repository's own name (package.json `name`, else its directory name), not the registry `id`. */
  id: string;
  kind: GroundingSource['kind'];
  name: string;
  oneLine: string;
  directories: string[];
  receivedAt?: string;
  /** L1 */
  titles: ReferenceTitle[];
  commands: string[];
  /** A file-count or byte limit cut the read short — the lists may be incomplete. */
  truncated: boolean;
}

export function buildReferenceCard(
  source: GroundingSource,
  fs: RefIndexFs,
  limits: Partial<RefIndexLimits> = {},
): ReferenceCard {
  if ((source.kind !== 'local-repo' && source.kind !== 'local-docs') || !source.path) {
    throw new GroundingSourceError(`reference card needs a local-repo/local-docs path: ${source.id}`);
  }
  const root = source.path;
  // A missing root would otherwise yield an empty, untruncated card indistinguishable from an empty repo.
  if (fs.mtimeMs(root) === undefined) {
    throw new GroundingSourceError(`reference card source path is not readable: ${source.id} (${root})`);
  }
  const { maxFiles, maxBytesPerFile } = { ...DEFAULT_REF_INDEX_LIMITS, ...limits };
  let opened = 0;
  let truncated = false;

  const open = (file: string): string | undefined => {
    if (opened >= maxFiles) {
      truncated = true;
      return undefined;
    }
    opened += 1;
    const head = fs.readHead(file, maxBytesPerFile);
    if (!head) return undefined;
    if (head.truncated) truncated = true;

    return head.text;
  };

  const top = fs.readDir(root).sort((a, b) => a.name.localeCompare(b.name));
  const directories = top
    .filter((e) => e.isDirectory && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
    .map((e) => e.name);

  const titles: ReferenceTitle[] = [];
  const readme = top.find((e) => !e.isDirectory && /^readme(\.[a-z]+)?$/i.test(e.name));
  let oneLine = '';
  if (readme) {
    const text = open(join(root, readme.name));
    if (text !== undefined) {
      oneLine = firstParagraphLine(text);
      for (const title of headingTitles(text)) titles.push({ file: readme.name, title });
    }
  }

  const docRoots = source.kind === 'local-docs' ? [''] : directories.includes('docs') ? ['docs'] : [];
  for (const rel of docRoots) {
    for (const file of markdownFiles(fs, root, rel, maxFiles + 2)) {
      if (file === readme?.name) continue;
      const text = open(join(root, file));
      if (text === undefined) continue;
      for (const title of headingTitles(text)) titles.push({ file, title });
    }
  }

  const commands: string[] = [];
  let packageName: string | undefined;
  if (top.some((e) => !e.isDirectory && e.name === 'package.json')) {
    const raw = open(join(root, 'package.json'));
    if (raw !== undefined) {
      const pkg = parsePackage(raw);
      packageName = pkg.name;
      commands.push(...pkg.commands);
    }
  }

  const receivedAt = receivedAtOf(source, fs, root);
  return {
    id: source.id,
    kind: source.kind,
    name: packageName ?? basename(root),
    oneLine,
    directories,
    ...(receivedAt ? { receivedAt } : {}),
    titles,
    commands,
    truncated,
  };
}

function receivedAtOf(source: GroundingSource, fs: RefIndexFs, root: string): string | undefined {
  if (source.kind === 'local-repo') {
    const commit = fs.lastCommitAt(root);
    if (commit) return commit;
  }
  const mtime = fs.mtimeMs(root);
  return mtime === undefined ? undefined : new Date(mtime).toISOString();
}

/**
 * Markdown paths (relative to `root`) under `rel`, sorted. Directory listing only — no bodies.
 * The walk stops once `cap` paths are found: past the file budget the caller only needs to know
 * «there was more» (→ truncated), not the whole tree.
 */
function markdownFiles(fs: RefIndexFs, root: string, rel: string, cap: number): string[] {
  const found: string[] = [];
  const walk = (dirRel: string): void => {
    if (found.length >= cap) return;
    const entries = fs.readDir(dirRel ? join(root, dirRel) : root).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const childRel = dirRel ? join(dirRel, e.name) : e.name;
      if (found.length >= cap) return;
      if (e.isDirectory) {
        if (!e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) walk(childRel);
      } else if (/\.md$/i.test(e.name)) {
        found.push(childRel);
      }
    }
  };
  walk(rel);
  return found;
}

function firstParagraphLine(text: string): string {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (lines.length > 0) break;
      continue;
    }
    if (line.startsWith('#') || line.startsWith('![') || line.startsWith('[![') || line.startsWith('<') || line.startsWith('```')) {
      if (lines.length > 0) break;
      continue;
    }
    lines.push(line);
  }
  const joined = lines.join(' ');
  return joined.length > ONE_LINE_MAX ? `${joined.slice(0, ONE_LINE_MAX - 1)}…` : joined;
}

function headingTitles(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = /^#{1,6}\s+(.+?)(?:\s+#+)?\s*$/.exec(raw);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

function parsePackage(packageJson: string): { name?: string; commands: string[] } {
  let pkg: unknown;
  try { pkg = JSON.parse(packageJson); } catch { return { commands: [] }; }
  if (!pkg || typeof pkg !== 'object') return { commands: [] };
  const { bin, name } = pkg as { bin?: unknown; name?: unknown };
  const pkgName = typeof name === 'string' && name.trim() ? name.trim() : undefined;
  const base = pkgName ? { name: pkgName } : {};
  if (typeof bin === 'string') return { ...base, commands: pkgName ? [pkgName.replace(/^@[^/]+\//, '')] : [] };
  if (bin && typeof bin === 'object' && !Array.isArray(bin)) return { ...base, commands: Object.keys(bin).sort() };
  return { ...base, commands: [] };
}

/** Real filesystem + local git. `git log` reads local refs only. */
export const nodeRefIndexFs: RefIndexFs = {
  readDir(dir) {
    try {
      return readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
    } catch {
      return [];
    }
  },
  readHead(file, maxBytes) {
    let fd: number | undefined;
    try {
      const size = statSync(file).size;
      const length = Math.min(size, maxBytes);
      const buf = Buffer.alloc(length);
      fd = openSync(file, 'r');
      readSync(fd, buf, 0, length, 0);
      return { text: buf.toString('utf8'), truncated: size > maxBytes };
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  },
  mtimeMs(path) {
    try { return statSync(path).mtimeMs; } catch { return undefined; }
  },
  lastCommitAt(repoDir) {
    const result = spawnSync('git', ['-C', repoDir, 'log', '-1', '--format=%cI'], { encoding: 'utf8', timeout: 10_000 });
    const out = result.status === 0 ? (result.stdout ?? '').trim() : '';
    return out || undefined;
  },
};
