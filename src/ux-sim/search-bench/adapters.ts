// SEARCH-BENCH tool adapters — one per tool family. A strategy = adapter × pipeline options (plan.ts).
//   product  : the seat's Glob/Grep dispatchers (Track N)
//   runshell : an engine argv through the seat RunShell contract (Track E): rg · BSD grep · git grep · fd · ast-grep
//   external : other agents' documented search tool semantics over rg/fd (Track X) — sources cited per adapter
import { escapeRegex, pathsFromLines, type ToolAdapter } from './plan.js';
import type { Fold, SearchKit } from './kit.js';
import { astGrepCallRules, astGrepDefRules } from '../../skills/tools/search-structural.js';

const alt = (alternatives: readonly string[]) => alternatives.map(escapeRegex).join('|');
const sortedLines = (text: string) => text.split('\n').filter(Boolean).sort();

// ── Track N · product tools ─────────────────────────────────────────────────────────────────────────────────────
export function productAdapter(o: { grepI?: boolean; globCi?: boolean; cap?: number } = {}): ToolAdapter {
  return {
    name: async (kit, f) => {
      if (!o.globCi) return kit.glob(`**/*${f}*`);
      // Proposed: a case-insensitive Glob (rg --iglob) — the product Glob has no -i today.
      const r = kit.exec('Glob(ci)', ['rg', '--files', '--sort', 'path', '--iglob', `*${f}*`], { kind: 'lines', lines: 200 });
      return pathsFromLines(kit, r.visible);
    },
    content: (kit, a) => kit.grep(alt(a), { ...(o.grepI ? { i: true } : {}), ...(o.cap ? { head_limit: o.cap } : {}) }),
    definition: (kit, id) => kit.grep(`(function|class|interface|type|const|let|var|def|fn|func|struct|enum|trait)\\s+${escapeRegex(id)}\\b`),
    callers: (kit, id) => kit.grep(`\\b${escapeRegex(id)}\\s*\\(`),
  };
}

// ── Track E · engines through RunShell ─────────────────────────────────────────────────────────────────────────
export type Engine = 'rg' | 'bsd-grep' | 'git-grep';
const RUNSHELL: Fold = { kind: 'runshell' };

export function engineContent(engine: Engine, i: boolean): ToolAdapter['content'] {
  return async (kit, a) => {
    const pat = alt(a);
    const argv = engine === 'rg' ? ['rg', '-l', '--sort', 'path', ...(i ? ['-i'] : []), '-e', pat, '.']
      : engine === 'git-grep' ? ['git', 'grep', '-l', '-I', '-E', ...(i ? ['-i'] : []), '-e', pat]
      // macOS /usr/bin/grep (BSD): recursive, no ignore files (walks .git and node_modules), binary skipped by -I.
      : ['/usr/bin/grep', '-rlIE', ...(i ? ['-i'] : []), '-e', pat, '.'];
    return pathsFromLines(kit, kit.exec(`RunShell:${engine}`, argv, RUNSHELL).visible);
  };
}
export function engineName(engine: Engine | 'fd' | 'find' | 'rg-ci'): NonNullable<ToolAdapter['name']> {
  return async (kit, f) => {
    if (engine === 'rg-ci') return pathsFromLines(kit, kit.exec('RunShell:rg-files', ['rg', '--files', '--sort', 'path', '--iglob', `*${f}*`], RUNSHELL).visible);
    if (engine === 'rg') return pathsFromLines(kit, kit.exec('RunShell:rg-files', ['rg', '--files', '--sort', 'path', '-g', `*${f}*`], RUNSHELL).visible);
    if (engine === 'git-grep') return pathsFromLines(kit, kit.exec('RunShell:git-ls-files', ['git', 'ls-files', `*${f}*`], RUNSHELL).visible);
    if (engine === 'fd') {
      // fd walks in parallel (unordered); sorted here so the bench stays deterministic.
      const r = kit.exec('RunShell:fd', ['fd', '--type', 'f', '--glob', `*${f}*`], RUNSHELL);
      return pathsFromLines(kit, sortedLines(r.visible).join('\n'));
    }
    const r = kit.exec('RunShell:find', ['find', '.', '-type', 'f', '-name', `*${f}*`], RUNSHELL);
    return pathsFromLines(kit, sortedLines(r.visible).join('\n'));
  };
}

// ast-grep — structural definitions / call sites, polyglot (TS·TSX·JS·Python·Rust·Go·Swift). The rules are the
// product's (src/skills/tools/search-structural.ts — product Grep lists defining files first with them).
export { astGrepCallRules, astGrepDefRules };
export const astGrepDefinition: NonNullable<ToolAdapter['definition']> = async (kit, id) =>
  pathsFromLines(kit, sortedLines(kit.exec('RunShell:ast-grep', ['ast-grep', 'scan', '--inline-rules', astGrepDefRules(id), '--files-with-matches', '.'], RUNSHELL).visible).join('\n'));
export const astGrepCallers: NonNullable<ToolAdapter['callers']> = async (kit, id) =>
  pathsFromLines(kit, sortedLines(kit.exec('RunShell:ast-grep', ['ast-grep', 'scan', '--inline-rules', astGrepCallRules(id), '--files-with-matches', '.'], RUNSHELL).visible).join('\n'));

export function engineAdapter(o: { content: Engine; name: Engine | 'fd' | 'find' | 'rg-ci'; i?: boolean; astGrep?: boolean }): ToolAdapter {
  return { name: engineName(o.name), content: engineContent(o.content, o.i === true), ...(o.astGrep ? { definition: astGrepDefinition, callers: astGrepCallers } : {}) };
}

// ── Track X · external agents' search tool semantics ───────────────────────────────────────────────────────────
/** mtime-desc then path (the corpus freezes every mtime, so this is path order — the same tie every tool hits). */
const mtimeSorted = (paths: string[]) => [...paths].sort();

/** Claude Code — Grep (ripgrep, files_with_matches default, mtime-sorted, case-sensitive, .gitignore respected) and Glob
 *  (mtime-sorted, 100 results). Source: Claude Code tool docs; eln's port src/skills/tools/grep.ts · glob.ts header. */
export const claudeCodeAdapter: ToolAdapter = {
  name: async (kit, f) => mtimeSorted(pathsFromLines(kit, kit.exec('X:claude-code:Glob', ['rg', '--files', '--sort', 'path', '-g', `*${f}*`], { kind: 'lines', lines: 100 }).visible)),
  content: async (kit, a) => mtimeSorted(pathsFromLines(kit, kit.exec('X:claude-code:Grep', ['rg', '-l', '--sort', 'path', '-e', alt(a), '.'], { kind: 'lines', lines: 250 }).visible)),
};

/** Codex CLI — no native grep/glob tool: the model runs `rg` / `rg --files` through exec_command (prompt
 *  codex-rs/core/gpt_5_codex_prompt.md:5); output budget 10 000 tokens ≈ 40 000 bytes, middle truncated
 *  (codex-rs/core/src/tools/handlers/shell_spec.rs:52-59). Typical call shape `rg -n PATTERN`. */
export const codexAdapter: ToolAdapter = {
  name: async (kit, f) => pathsFromLines(kit, sortedLines(kit.exec('X:codex:exec', ['bash', '-c', 'rg --files | rg -F -e "$1"', '_', f], { kind: 'headtail', bytes: 40_000 }).visible).join('\n')),
  content: async (kit, a) => pathsFromLines(kit, kit.exec('X:codex:exec', ['rg', '-n', '--sort', 'path', '-e', alt(a), '.'], { kind: 'headtail', bytes: 40_000 }).visible),
};

/** grok-cli — grep: `rg --json --hidden --glob=!.git/*`, mtime-desc, first 100 matches shown, lines cut at 2 000
 *  chars (grok-cli src/tools/grep.ts:6,26-42,139-175); no glob tool confirmed → bash `find` for names. */
export const grokCliAdapter: ToolAdapter = {
  name: engineName('find'),
  content: async (kit, a) => pathsFromLines(kit, kit.exec('X:grok-cli:grep', ['rg', '-n', '--hidden', '--glob=!.git/*', '--no-messages', '--sort', 'path', '-e', alt(a), '.'], { kind: 'lines', lines: 100, lineChars: 2000 }).visible),
};

/** grok-build — native grep: rg `-n --heading`-style content mode default, head 200 lines, `--max-filesize 5M
 *  --max-columns 1000` (grep/mod.rs:52-128 · rg_runner.rs:29-115); glob schema auto-prefixes `**\/` (xai-tool-types glob.rs). */
export const grokBuildAdapter: ToolAdapter = {
  name: async (kit, f) => pathsFromLines(kit, kit.exec('X:grok-build:glob', ['rg', '--files', '--sort', 'path', '-g', `**/*${f}*`], { kind: 'lines', lines: 500 }).visible),
  content: async (kit, a) => pathsFromLines(kit, kit.exec('X:grok-build:grep', ['rg', '-n', '--no-heading', '--max-filesize', '5M', '--max-columns', '1000', '--max-columns-preview', '--sort', 'path', '-e', alt(a), '.'], { kind: 'lines', lines: 200 }).visible),
};

/** hermes-agent — search_files: target=files rg --files glob (mtime-sorted), target=content
 *  `rg --line-number --no-heading --with-filename`, limit 50, preview 500 chars (tools/file_tools.py:2804-2819 ·
 *  tools/file_operations.py:3137-3143,3228-3279,3339-3363). */
export const hermesAdapter: ToolAdapter = {
  name: async (kit, f) => mtimeSorted(pathsFromLines(kit, kit.exec('X:hermes:search_files(files)', ['rg', '--files', '--sort', 'path', '-g', `*${f}*`], { kind: 'lines', lines: 50 }).visible)),
  content: async (kit, a) => pathsFromLines(kit, kit.exec('X:hermes:search_files(content)', ['rg', '--line-number', '--no-heading', '--with-filename', '--sort', 'path', '-e', alt(a), '.'], { kind: 'lines', lines: 50, lineChars: 500 }).visible),
};

/** OpenClaw — embedded pi coding-agent tools `grep`/`find` (src/agents/embedded-agent-runner/tool-name-allowlist.ts:9);
 *  pi grep = rg --json --hidden, limit 100 matches, case-sensitive by default; find = fd --glob --hidden, limit 1000
 *  (upstream pi-mono packages/coding-agent/src/core/tools/{grep,find}.ts — not vendored locally, unverified here). */
export const openclawAdapter: ToolAdapter = {
  name: async (kit, f) => pathsFromLines(kit, sortedLines(kit.exec('X:openclaw:find', ['fd', '--type', 'f', '--hidden', '--glob', `*${f}*`], { kind: 'lines', lines: 1000 }).visible).join('\n')),
  content: async (kit, a) => pathsFromLines(kit, kit.exec('X:openclaw:grep', ['rg', '-n', '--hidden', '--sort', 'path', '-e', alt(a), '.'], { kind: 'lines', lines: 100 }).visible),
};
