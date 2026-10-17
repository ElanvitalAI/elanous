// ── list_dir tool (structured directory listing) ──
//
// Ports claude-code-fork's LS / Codex's list_dir tool. Use when the
// LLM wants to know "what's in this directory?" — names + kinds +
// sizes + mtimes, rather than a content scan (Grep) or a full-tree
// walk (Glob). Cheaper + more semantic than `Bash ls -la`:
//   • no shell — no quoting issues, no ANSI junk to parse
//   • structured output the model can reason over without regex
//   • consistent across macOS / Linux / WSL
//
// Non-recursive by default. Callers who need deep discovery should
// use Glob instead — it was designed for that.
//
// Output shape (as a single formatted string the model reads):
//   /path/to/dir
//   ------------------------------
//     d  4.0K  2026-04-16 17:20  subdir/
//     f   120  2026-04-16 17:19  README.md
//     f   2.3K 2026-04-16 17:18  index.ts
//     l     -  2026-04-16 17:17  link -> target
//   (+ 14 more hidden items; pass show_hidden=true to reveal)

import { readdirSync, statSync, lstatSync, readlinkSync } from 'node:fs';
import { isAbsolute, resolve, join } from 'node:path';
import type { LLMToolSpec } from '../../llm.js';
import { getSessionCwd } from '../../session/working-dir.js';
import { debug } from '../../debug/log.js';
import { noteBroadSearch } from './search-loop-guard.js';

const DEFAULT_HEAD_LIMIT = 200;
const MAX_HEAD_LIMIT = 2_000;

export interface ListDirArgs {
  path: string;
  show_hidden?: boolean;
  sort?: 'name' | 'size' | 'mtime';
  head_limit?: number;
}

export interface ListDirEntry {
  name: string;
  /** 'f' file, 'd' directory, 'l' symlink, 'o' other (socket, device,
   *  FIFO, …). Never an empty string. */
  kind: 'f' | 'd' | 'l' | 'o';
  size: number;
  mtimeMs: number;
  /** Set when kind === 'l'. Absent otherwise. */
  linkTarget?: string;
}

export interface ListDirResult {
  output: string;
  path: string;
  entries: ListDirEntry[];
  /** Count of entries BEFORE applying head_limit (but after the
   *  hidden-file filter). */
  totalVisible: number;
  /** Count of hidden entries (starts with .) that were filtered. 0
   *  when show_hidden=true. */
  hiddenFiltered: number;
  truncated: boolean;
}

export function buildListDirTool(): LLMToolSpec {
  return {
    name: 'ListDir',
    description:
      'List one directory — names, kinds (file/dir/symlink), sizes, and mtimes. ' +
      'Non-recursive; use Glob for deep discovery. Hidden entries filtered ' +
      'by default (show_hidden=true to include). Sort: name (default) | size | mtime.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative directory path. Required.' },
        show_hidden: { type: 'boolean', description: 'Include entries beginning with a dot. Default false.' },
        sort: { type: 'string', enum: ['name', 'size', 'mtime'], description: 'Sort order. Default "name". "mtime" is newest-first.' },
        head_limit: { type: 'number', description: `Cap on returned entries (default ${DEFAULT_HEAD_LIMIT}, max ${MAX_HEAD_LIMIT}).` },
      },
      required: ['path'],
    },
  };
}

export async function dispatchListDir(args: Record<string, unknown>): Promise<ListDirResult> {
  const raw = String(args.path ?? '').trim();
  if (!raw) throw new Error('path is required');
  // WD6 — relative path resolves against the session working dir.
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(getSessionCwd(), raw);
  const showHidden = !!args.show_hidden;
  const sort = (args.sort === 'size' || args.sort === 'mtime') ? args.sort : 'name';
  const head = Math.min(
    MAX_HEAD_LIMIT,
    Math.max(1, Number(args.head_limit) || DEFAULT_HEAD_LIMIT),
  );
  const searchLoop = noteBroadSearch([
    'listdir',
    abs,
    String(showHidden),
    sort,
    String(head),
  ]);
  if (searchLoop.blocked) {
    // 관측(TUI-OPS-TURN-GUARD 공백 ①): Grep(grep.ts) 과 «같은» 범주·이벤트로 차단을 남긴다 —
    //   종전엔 throw 만 해서 ListDir 차단은 조회하면 0 이었고, 그 0 은 「안 막혔다」가 아니라 「안 쟀다」였다.
    //   경로 원문·내용은 싣지 않는다(깊이·옵션 축만). 동작·문구는 그대로.
    debug.log('tools.search', 'broad-search-blocked', {
      tool: 'ListDir',
      consecutive: searchLoop.consecutive,
      pathDepth: abs.split(/[\\/]+/).filter(Boolean).length,
      showHidden,
      sort,
    }, { level: 'warn' });
    throw new Error(
      `RUNTIME BLOCKED — repeated broad search loop detected (${searchLoop.consecutive} consecutive broad-search calls). ` +
      `You already listed ${abs}. Stop re-listing the same tree. Pick concrete files or directories from prior results ` +
      `and continue with Read, Grep(content), Glob, or Lsp.`,
    );
  }

  let dirents;
  try {
    dirents = readdirSync(abs, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code === 'ENOENT') throw new Error(`path not found: ${abs}`);
    if (err?.code === 'ENOTDIR') throw new Error(`not a directory: ${abs}`);
    if (err?.code === 'EACCES') throw new Error(`permission denied: ${abs}`);
    throw new Error(`readdir failed: ${err?.message ?? err}`);
  }

  let hiddenFiltered = 0;
  const entries: ListDirEntry[] = [];
  for (const d of dirents) {
    if (!showHidden && d.name.startsWith('.')) {
      hiddenFiltered++;
      continue;
    }
    const entryPath = join(abs, d.name);
    let kind: ListDirEntry['kind'];
    let size = 0;
    let mtimeMs = 0;
    let linkTarget: string | undefined;
    try {
      // lstat so symlinks are reported as 'l' instead of transparently
      // resolved. Callers who want the target can follow linkTarget.
      const ls = lstatSync(entryPath);
      mtimeMs = ls.mtimeMs;
      size = ls.size;
      if (ls.isSymbolicLink()) {
        kind = 'l';
        try { linkTarget = readlinkSync(entryPath); } catch { /* broken link */ }
      } else if (ls.isDirectory()) kind = 'd';
      else if (ls.isFile()) kind = 'f';
      else kind = 'o';
    } catch {
      // Stale / permission-denied entries still show up in the
      // listing — just with missing metadata. Avoids the whole
      // call failing because of one bad inode.
      kind = 'o';
    }
    entries.push({ name: d.name, kind, size, mtimeMs, ...(linkTarget ? { linkTarget } : {}) });
  }

  const totalVisible = entries.length;

  // Sort. mtime defaults to newest-first; name/size ascending (size
  // descending is probably less useful since small files dominate).
  if (sort === 'name') {
    entries.sort((a, b) => a.name.localeCompare(b.name));
  } else if (sort === 'size') {
    entries.sort((a, b) => b.size - a.size);
  } else {
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  const truncated = entries.length > head;
  const shown = entries.slice(0, head);

  // Format. Columns: kind (1), size (right-aligned ~5 chars with
  // human suffix), mtime (YYYY-MM-DD HH:MM), name (+ '/' for dirs,
  // '-> target' for symlinks).
  const header = `${abs}\n${'\u2500'.repeat(Math.min(60, abs.length + 6))}`;
  const rows = shown.map(e => {
    const k = e.kind;
    const sz = k === 'd' || k === 'l' ? '  -' : humanSize(e.size);
    const mt = formatMtime(e.mtimeMs);
    const name = k === 'd' ? `${e.name}/`
               : k === 'l' ? `${e.name} -> ${e.linkTarget ?? '(broken)'}`
               : e.name;
    return `  ${k}  ${sz.padStart(5)}  ${mt}  ${name}`;
  });
  const footer: string[] = [];
  if (truncated) {
    footer.push(`  … ${entries.length - head} more entries hidden (head_limit=${head}).`);
  }
  if (hiddenFiltered > 0) {
    footer.push(`  (+ ${hiddenFiltered} dot-prefixed hidden; pass show_hidden=true to reveal)`);
  }
  const output = [header, '', ...rows, ...footer].join('\n');

  return {
    output,
    path: abs,
    entries: shown,
    totalVisible,
    hiddenFiltered,
    truncated,
  };
}

function humanSize(n: number): string {
  if (n < 1024) return `${n}`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}M`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

function formatMtime(ms: number): string {
  if (!ms) return '     -          -';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
