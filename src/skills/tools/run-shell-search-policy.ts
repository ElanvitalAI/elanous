// RUNSHELL-SEARCH-PARITY — read-only search argv grammar for RunShell (single argv and script mode).
//
// A model that searches through RunShell (`rg`, `git grep`, `ast-grep`/`sg`, `eln docs search`) used to fall
// outside the local-read table: script mode refused the executable and single argv needed the relaxed path.
// This file is the one grammar for those forms. It is pure (no fs, no config) so the spawn gateway and the
// script classifier can import it without pulling the knowledge resolver.
//
// Refused on purpose (they write, run helpers, or replace what the model reads):
//   rg        -r/--replace (output rewrite; models read it as «recursive») · --pre/--pre-glob (runs a program)
//   git grep  -O/--open-files-in-pager (runs a pager) · --textconv/--ext-grep (runs helpers)
//   ast-grep  -r/--rewrite · -U/--update-all · -i/--interactive · -c · subcommands other than run/scan
//   sg        always — on Linux `sg` is setgroup (`sg <group> <command>` runs a command); call `ast-grep` by name

export type SearchTool = 'docs' | 'rg' | 'git-grep' | 'ast-grep';

export interface ParsedSearchArgv {
  tool: SearchTool;
  /** Refusal reason when the argv carries a write/exec flag. */
  refused?: string;
  /** The model named where to search (path positional, --path/--source, `--` pathspec). */
  explicitPaths: boolean;
  /** Markdown-only filter (rg -t md / -g '*.md'). */
  docsIntent: boolean;
  /** Machine output (rg --json, ast-grep --json, docs --json) — never rewritten. */
  json: boolean;
  /** How result paths are printed — the only fields citations may rewrite.
   *  list = whole line is a path · match = `path:` prefix · json = rg --json path field · none = no filenames. */
  output: 'list' | 'match' | 'json' | 'none';
  /** The search text, when it can be read without guessing. */
  query?: string;
  /** docs search --scope value. */
  scope?: string;
}

// rg flags that take a value (short letters may carry it attached: -tmd, -g*.md).
const RG_SHORT_VALUE = new Set(['e', 'f', 'g', 't', 'T', 'm', 'A', 'B', 'C', 'E', 'j', 'M', 'd', 'r']);
const RG_LONG_VALUE = new Set(['--regexp', '--file', '--glob', '--iglob', '--type', '--type-not', '--type-add', '--type-clear',
  '--max-count', '--after-context', '--before-context', '--context', '--encoding', '--threads', '--max-columns', '--max-depth',
  '--max-filesize', '--colors', '--color', '--sort', '--sortr', '--path-separator', '--context-separator',
  '--field-match-separator', '--field-context-separator', '--dfa-size-limit', '--regex-size-limit', '--engine',
  '--ignore-file', '--replace', '--pre', '--pre-glob', '--hyperlink-format', '--generate', '--max-depth']);
const RG_REFUSED_LONG: Readonly<Record<string, string>> = {
  '--replace': 'rg --replace rewrites the output — search without it',
  '--pre': 'rg --pre runs a program on every file',
  '--pre-glob': 'rg --pre-glob runs a program on every file',
};

const GIT_GREP_SHORT_VALUE = new Set(['e', 'f', 'A', 'B', 'C', 'm']);
const GIT_GREP_LONG_VALUE = new Set(['--max-count', '--max-depth', '--threads', '--context', '--after-context', '--before-context']);

const AST_LONG_VALUE = new Set(['--pattern', '--lang', '--selector', '--strictness', '--globs', '--threads', '--after', '--before',
  '--context', '--color', '--heading', '--inspect', '--config', '--filter', '--rule', '--inline-rules', '--format',
  '--report-style', '--debug-query', '--max-results']);
const AST_SHORT_VALUE = new Set(['p', 'l', 'j', 'A', 'B', 'C']);
const AST_REFUSED: Readonly<Record<string, string>> = {
  '-r': 'ast-grep -r rewrites code — use the Edit tool',
  '--rewrite': 'ast-grep --rewrite rewrites code — use the Edit tool',
  '-U': 'ast-grep -U writes rewrites to disk — use the Edit tool',
  '--update-all': 'ast-grep --update-all writes rewrites to disk — use the Edit tool',
  '-i': 'ast-grep --interactive edits files',
  '--interactive': 'ast-grep --interactive edits files',
  '-c': 'use --config (sg -c runs a command on Linux)',
};

const DOCS_SCOPES = ['repo', 'ref', 'both', 'custom'];
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

function isDocsGlob(value: string): boolean { return /\.mdx?\b|\*\.md/iu.test(value); }
function isDocsType(value: string): boolean { return value === 'md' || value === 'markdown'; }

function parseRg(args: readonly string[]): ParsedSearchArgv {
  const out: ParsedSearchArgv = { tool: 'rg', explicitPaths: false, docsIntent: false, json: false, output: 'match' };
  let patternFromFlag = false;
  let filesMode = false;
  let list = false; let noName = false;
  const positionals: string[] = [];
  const takeValue = (flag: string, value: string | undefined): void => {
    if (value === undefined) return;
    if (flag === 'e' || flag === '--regexp') { patternFromFlag = true; out.query ??= value; }
    if (flag === 'f' || flag === '--file') patternFromFlag = true;
    if ((flag === 'g' || flag === '--glob' || flag === '--iglob') && isDocsGlob(value)) out.docsIntent = true;
    if ((flag === 't' || flag === '--type') && isDocsType(value)) out.docsIntent = true;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') { positionals.push(...args.slice(i + 1)); break; }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq >= 0 ? arg.slice(0, eq) : arg;
      if (RG_REFUSED_LONG[name]) return { ...out, refused: RG_REFUSED_LONG[name] };
      if (name === '--json') out.json = true;
      if (name === '--files') { filesMode = true; list = true; }
      if (name === '--files-with-matches' || name === '--files-without-match') list = true;
      if (name === '--no-filename') noName = true;
      if (RG_LONG_VALUE.has(name)) takeValue(name, eq >= 0 ? arg.slice(eq + 1) : args[++i]);
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (let c = 1; c < arg.length; c++) {
        const letter = arg[c]!;
        if (letter === 'r') return { ...out, refused: 'rg -r is --replace (it rewrites the output), not recursive — rg is recursive already' };
        if (letter === 'l') list = true;
        if (letter === 'I') noName = true;
        if (RG_SHORT_VALUE.has(letter)) {
          takeValue(letter, c + 1 < arg.length ? arg.slice(c + 1) : args[++i]);
          break;
        }
      }
      continue;
    }
    positionals.push(arg);
  }
  out.output = out.json ? 'json' : list ? 'list' : noName ? 'none' : 'match';
  const pathStart = patternFromFlag || filesMode ? 0 : 1;
  if (!patternFromFlag && !filesMode && positionals[0] !== undefined) out.query = positionals[0];
  out.explicitPaths = positionals.length > pathStart;
  return out;
}

function parseGitGrep(args: readonly string[]): ParsedSearchArgv {
  const out: ParsedSearchArgv = { tool: 'git-grep', explicitPaths: false, docsIntent: false, json: false, output: 'match' };
  let patternFromFlag = false;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') { if (args.length > i + 1) out.explicitPaths = true; break; }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq >= 0 ? arg.slice(0, eq) : arg;
      if (name === '--open-files-in-pager') return { ...out, refused: 'git grep --open-files-in-pager runs a pager' };
      if (name === '--textconv' || name === '--ext-grep') return { ...out, refused: `git grep ${name} runs helpers` };
      if (['--files-with-matches', '--name-only', '--files-without-match', '-l'].includes(name)) out.output = 'list';
      if (name === '--no-filename' && out.output !== 'list') out.output = 'none';
      if (GIT_GREP_LONG_VALUE.has(name) && eq < 0) i++;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (let c = 1; c < arg.length; c++) {
        const letter = arg[c]!;
        if (letter === 'O') return { ...out, refused: 'git grep -O runs a pager' };
        if (letter === 'l' || letter === 'L') out.output = 'list';
        if (letter === 'h' && out.output !== 'list') out.output = 'none';
        if (GIT_GREP_SHORT_VALUE.has(letter)) {
          const value = c + 1 < arg.length ? arg.slice(c + 1) : args[++i];
          if (letter === 'e' || letter === 'f') { patternFromFlag = true; if (letter === 'e' && value !== undefined) out.query ??= value; }
          break;
        }
      }
      continue;
    }
    positionals.push(arg);
  }
  if (!patternFromFlag && positionals[0] !== undefined) out.query = positionals[0];
  if (positionals.length > (patternFromFlag ? 0 : 1)) out.explicitPaths = true;
  return out;
}

function parseAstGrep(args: readonly string[]): ParsedSearchArgv {
  const out: ParsedSearchArgv = { tool: 'ast-grep', explicitPaths: false, docsIntent: false, json: false, output: 'match' };
  let start = 0;
  if (args[0] !== undefined && !args[0].startsWith('-')) {
    if (args[0] !== 'run' && args[0] !== 'scan') return { ...out, refused: `ast-grep ${args[0]} is not a read-only search (use run or scan)` };
    start = 1;
  } else if (!args.some((a) => a === '-p' || a === '--pattern' || a.startsWith('--pattern=') || (a.startsWith('-p') && a.length > 2))) {
    // Bare `sg -x …` without a pattern is not an ast-grep search (Linux sg is setgroups).
    return { ...out, refused: 'ast-grep without run/scan needs -p/--pattern' };
  }
  const positionals: string[] = [];
  for (let i = start; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') { positionals.push(...args.slice(i + 1)); break; }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq >= 0 ? arg.slice(0, eq) : arg;
      if (AST_REFUSED[name]) return { ...out, refused: AST_REFUSED[name] };
      if (name === '--json') { out.json = true; out.output = 'none'; }
      if (name === '--files-with-matches' && !out.json) out.output = 'list';
      if (AST_LONG_VALUE.has(name)) {
        const value = eq >= 0 ? arg.slice(eq + 1) : args[++i];
        if (name === '--pattern' && value !== undefined) out.query ??= value;
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const head = arg.slice(0, 2);
      if (AST_REFUSED[head]) return { ...out, refused: AST_REFUSED[head] };
      const letter = arg[1]!;
      if (AST_SHORT_VALUE.has(letter)) {
        const value = arg.length > 2 ? arg.slice(2) : args[++i];
        if (letter === 'p' && value !== undefined) out.query ??= value;
      }
      continue;
    }
    positionals.push(arg);
  }
  out.explicitPaths = positionals.length > 0;
  return out;
}

function parseDocsSearch(args: readonly string[]): ParsedSearchArgv {
  const out: ParsedSearchArgv = { tool: 'docs', explicitPaths: false, docsIntent: true, json: false, output: 'none' };
  const positionals: string[] = [];
  const valueFlags = new Set(['--scope', '--source', '--path', '--limit', '--domain', '--kind']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq >= 0 ? arg.slice(0, eq) : arg;
      if (name === '--json') { out.json = true; continue; }
      if (!valueFlags.has(name)) return { ...out, refused: `eln docs search does not take ${name}` };
      const value = eq >= 0 ? arg.slice(eq + 1) : args[++i];
      if (value === undefined || value === '') return { ...out, refused: `eln docs search ${name} needs a value` };
      if (name === '--scope') {
        if (!DOCS_SCOPES.includes(value)) return { ...out, refused: `--scope must be one of ${DOCS_SCOPES.join('|')}` };
        out.scope = value;
        if (value === 'custom') out.explicitPaths = true;
      }
      if (name === '--source') {
        if (!SOURCE_ID.test(value)) return { ...out, refused: '--source takes a configured source id' };
        out.explicitPaths = true;
      }
      if (name === '--path') out.explicitPaths = true;
      if (name === '--limit' && !/^[1-9][0-9]?$/u.test(value)) return { ...out, refused: '--limit takes 1-99' };
      continue;
    }
    if (arg.startsWith('-')) return { ...out, refused: `eln docs search does not take ${arg}` };
    positionals.push(arg);
  }
  if (positionals.length !== 1 || !positionals[0]!.trim()) return { ...out, refused: 'eln docs search takes exactly one query' };
  out.query = positionals[0];
  return out;
}

/** The search shape of an argv, or null when it is not one of the RunShell search commands. */
export function parseRunShellSearch(argv: readonly string[]): ParsedSearchArgv | null {
  const exe = (argv[0] ?? '').split('/').pop() ?? '';
  if (exe === 'rg') return parseRg(argv.slice(1));
  if (exe === 'git' && argv[1] === 'grep') return parseGitGrep(argv.slice(2));
  if (exe === 'ast-grep') return parseAstGrep(argv.slice(1));
  // `sg` is ambiguous: ast-grep's alias on macOS/Homebrew, setgroup on Linux (`sg run 'touch x'` runs a command).
  if (exe === 'sg') return { tool: 'ast-grep', refused: 'sg may be setgroup on this host — call ast-grep by name',
    explicitPaths: false, docsIntent: false, json: false, output: 'none' };
  if ((exe === 'eln' || exe === 'elanous') && argv[1] === 'docs' && argv[2] === 'search') return parseDocsSearch(argv.slice(3));
  return null;
}

/** 'read-local' for an accepted search, 'deny' for a refused flag, null when the argv is not a search. */
export function searchCommandPolicy(argv: readonly string[]): 'read-local' | 'deny' | null {
  const parsed = parseRunShellSearch(argv);
  if (!parsed) return null;
  return parsed.refused ? 'deny' : 'read-local';
}

/** Executables the script mode accepts for search steps (eln and git are already script executables). */
export const SEARCH_SCRIPT_EXECUTABLES = ['rg', 'ast-grep'] as const;
