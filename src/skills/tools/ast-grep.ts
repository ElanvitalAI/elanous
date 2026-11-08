import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── AstGrep tool ───────────────────────────────────────────
//
// Structural code search backed by ast-grep. This complements Grep:
// use Grep for fast text/regex search, use AstGrep when the query is
// about syntax shape such as "function calls", "imports", "await
// inside async functions", or "React components returning JSX".

import { spawnSync } from 'node:child_process';
import { getSessionCwd } from '../../session/working-dir.js';

import type { LLMToolDef } from '../../plugins/core/types.js';

const DEFAULT_MAX_RESULTS = 80;
const MAX_RESULTS = 1000;
const AST_GREP_TIMEOUT_MS = 30_000;
const AST_GREP_MAX_BUFFER = 20 * 1024 * 1024;

export interface AstGrepArgs {
  pattern?: string;
  rule?: string;
  lang?: string;
  path?: string;
  glob?: string;
  output_mode?: 'summary' | 'files_with_matches' | 'json';
  max_results?: number;
  context?: number;
  selector?: string;
  strictness?: 'cst' | 'smart' | 'ast' | 'relaxed' | 'signature' | 'template';
}

export interface AstGrepMatch {
  file: string;
  line: number;
  column: number;
  text: string;
  lines: string;
  language?: string;
}

export interface AstGrepResult {
  output: string;
  mode: 'summary' | 'files_with_matches' | 'json';
  matches: AstGrepMatch[];
  numMatches: number;
  numFiles: number;
  truncated: boolean;
  command: string[];
}

export function buildAstGrepTool(): LLMToolSpec {
  return {
    name: 'AstGrep',
    description:
      'Structural code search using ast-grep. Use when the query depends on syntax/AST shape rather than plain text. ' +
      'Provide either pattern+lang for quick searches, or an inline YAML rule for relational searches. ' +
      'For normal text search, use Grep first; for code constructs like function calls, imports, class methods, JSX, awaits, or nested rules, use AstGrep.',
    parameters: astGrepParametersSchema(),
  };
}

export function buildAstGrepHostTool(): LLMToolDef {
  return {
    name: 'ast_grep_search',
    description:
      'Run structural code search with ast-grep. Use for syntax-aware code search; supports pattern+lang or inline YAML rule. ' +
      'Returns bounded structured matches and a compact summary.',
    parameters: astGrepParametersSchema(),
    handler: async (args) => dispatchAstGrep(args),
  };
}

export async function dispatchAstGrep(
  args: Record<string, unknown>,
  opts: { cwd?: string } = {},
): Promise<AstGrepResult> {
  const parsed = parseArgs(args);
  const bin = astGrepBinary();
  if (!bin) {
    throw new Error('AstGrep: `ast-grep` is not installed. Install with `brew install ast-grep` or see https://ast-grep.github.io/.');
  }

  const command = buildCommand(bin, parsed);
  const proc = spawnSync(command[0]!, command.slice(1), {
    // WD6 — default spawn cwd to the session working directory.
    cwd: opts.cwd ?? getSessionCwd(),
    encoding: 'utf8',
    timeout: AST_GREP_TIMEOUT_MS,
    maxBuffer: AST_GREP_MAX_BUFFER,
  });

  if (proc.status === null) {
    throw new Error(`AstGrep: process exited abnormally or timed out after ${AST_GREP_TIMEOUT_MS}ms`);
  }
  // ast-grep exits 1 when no match is found. Treat that as an empty result.
  if (proc.status !== 0 && proc.status !== 1) {
    const err = (proc.stderr ?? '').trim() || (proc.stdout ?? '').trim() || `ast-grep exited ${proc.status}`;
    throw new Error(`AstGrep: ${err}`);
  }

  const matches = parseMatches(proc.stdout ?? '');
  const limited = matches.slice(0, parsed.maxResults);
  const truncated = matches.length > limited.length;
  const files = new Set(limited.map(match => match.file));
  const mode = parsed.outputMode;

  return {
    output: renderAstGrepOutput(limited, {
      mode,
      totalMatches: matches.length,
      truncated,
    }),
    mode,
    matches: limited,
    numMatches: limited.length,
    numFiles: files.size,
    truncated,
    command,
  };
}

export function hasAstGrep(): boolean {
  return astGrepBinary() !== null;
}

function astGrepParametersSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'AST pattern for quick search, for example `console.log($ARG)` or `function $NAME($$$ARGS) { $$$BODY }`.' },
      rule: { type: 'string', description: 'Inline ast-grep YAML rule. Use for relational rules with has/inside/all/any/not. Do not combine with pattern.' },
      lang: { type: 'string', description: 'Language for pattern mode, for example typescript, javascript, python, rust, go. Required with pattern.' },
      path: { type: 'string', description: 'File or directory to search. Default current workspace.' },
      glob: { type: 'string', description: 'Include/exclude glob passed to --globs, for example `**/*.ts` or `!**/*.test.ts`.' },
      output_mode: { type: 'string', enum: ['summary', 'files_with_matches', 'json'], description: 'Default summary. Use json when exact ranges/meta are needed.' },
      max_results: { type: 'number', description: `Maximum matches returned. Default ${DEFAULT_MAX_RESULTS}, max ${MAX_RESULTS}.` },
      context: { type: 'number', description: 'Context lines around matches. Passed to ast-grep -C.' },
      selector: { type: 'string', description: 'Optional ast-grep selector kind for pattern mode.' },
      strictness: { type: 'string', enum: ['cst', 'smart', 'ast', 'relaxed', 'signature', 'template'], description: 'Pattern matching strictness.' },
    },
    required: [],
  };
}

interface ParsedArgs {
  pattern?: string;
  rule?: string;
  lang?: string;
  path: string;
  glob?: string;
  outputMode: AstGrepResult['mode'];
  maxResults: number;
  context: number;
  selector?: string;
  strictness?: AstGrepArgs['strictness'];
}

function parseArgs(args: Record<string, unknown>): ParsedArgs {
  const pattern = str(args.pattern);
  const rule = str(args.rule);
  if (!pattern && !rule) throw new Error('AstGrep: provide either pattern+lang or rule');
  if (pattern && rule) throw new Error('AstGrep: pattern and rule are mutually exclusive');
  const lang = str(args.lang);
  if (pattern && !lang) throw new Error('AstGrep: lang is required when using pattern');
  const outputMode = parseOutputMode(args.output_mode);
  return {
    ...(pattern ? { pattern } : {}),
    ...(rule ? { rule } : {}),
    ...(lang ? { lang } : {}),
    path: str(args.path) ?? '.',
    ...(str(args.glob) ? { glob: str(args.glob)! } : {}),
    outputMode,
    maxResults: clampInt(args.max_results, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS),
    context: clampInt(args.context, 0, 0, 20),
    ...(str(args.selector) ? { selector: str(args.selector)! } : {}),
    ...(isStrictness(args.strictness) ? { strictness: args.strictness } : {}),
  };
}

function buildCommand(bin: string, args: ParsedArgs): string[] {
  const cmd = args.pattern
    ? [bin, 'run', '--pattern', args.pattern, '--lang', args.lang!, '--json=compact', '--color', 'never']
    : [bin, 'scan', '--inline-rules', args.rule!, '--json=compact', '--color', 'never'];
  if (args.glob) cmd.push('--globs', args.glob);
  if (args.context > 0) cmd.push('-C', String(args.context));
  if (args.pattern && args.selector) cmd.push('--selector', args.selector);
  if (args.pattern && args.strictness) cmd.push('--strictness', args.strictness);
  cmd.push('--', args.path);
  return cmd;
}

function parseMatches(stdout: string): AstGrepMatch[] {
  const raw = stdout.trim();
  if (!raw) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return [];
  }
  const arr = Array.isArray(decoded) ? decoded : [decoded];
  return arr.flatMap(normalizeMatch);
}

function normalizeMatch(item: unknown): AstGrepMatch[] {
  if (!item || typeof item !== 'object') return [];
  const obj = item as Record<string, unknown>;
  if (Array.isArray(obj.matches)) return obj.matches.flatMap(normalizeMatch);
  const range = obj.range && typeof obj.range === 'object' ? obj.range as Record<string, unknown> : {};
  const start = range.start && typeof range.start === 'object' ? range.start as Record<string, unknown> : {};
  const file = typeof obj.file === 'string'
    ? obj.file
    : typeof obj.filePath === 'string'
      ? obj.filePath
      : '';
  if (!file) return [];
  const text = typeof obj.text === 'string' ? obj.text : '';
  const lines = typeof obj.lines === 'string' ? obj.lines : text;
  return [{
    file,
    line: number(start.line, 0),
    column: number(start.column, 0),
    text,
    lines,
    ...(typeof obj.language === 'string' ? { language: obj.language } : {}),
  }];
}

function renderAstGrepOutput(
  matches: AstGrepMatch[],
  opts: { mode: AstGrepResult['mode']; totalMatches: number; truncated: boolean },
): string {
  if (opts.mode === 'json') {
    return JSON.stringify({
      matches,
      totalMatches: opts.totalMatches,
      truncated: opts.truncated,
    }, null, 2);
  }
  if (opts.mode === 'files_with_matches') {
    const files = [...new Set(matches.map(match => match.file))];
    const header = files.length === 0
      ? 'No files matched'
      : `Found ${files.length} file${files.length === 1 ? '' : 's'}${opts.truncated ? ' (partial)' : ''}`;
    return `${header}${files.length ? '\n' + files.join('\n') : ''}`;
  }
  const rows = matches.map(match => {
    const snippet = oneLine(match.lines || match.text);
    return `${match.file}:${match.line + 1}:${match.column + 1}: ${snippet}`;
  });
  const footer = opts.truncated
    ? `\n\n[... ${opts.totalMatches - matches.length} more matches omitted; raise max_results to inspect more ...]`
    : '';
  return rows.length === 0
    ? 'No AST matches'
    : `Found ${matches.length}${opts.truncated ? '+' : ''} AST match${matches.length === 1 ? '' : 'es'}\n${rows.join('\n')}${footer}`;
}

function astGrepBinary(): string | null {
  for (const name of ['ast-grep', 'sg']) {
    const proc = spawnSync(name, ['--version'], { encoding: 'utf8' });
    if (proc.status === 0) return name;
  }
  return null;
}

function parseOutputMode(v: unknown): AstGrepResult['mode'] {
  if (v === undefined || v === null || v === '') return 'summary';
  if (v === 'summary' || v === 'files_with_matches' || v === 'json') return v;
  throw new Error('AstGrep: output_mode must be summary, files_with_matches, or json');
}

function isStrictness(v: unknown): v is AstGrepArgs['strictness'] {
  return v === 'cst' || v === 'smart' || v === 'ast' || v === 'relaxed' || v === 'signature' || v === 'template';
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function number(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const raw = typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v.trim() !== ''
      ? Number(v)
      : fallback;
  const n = Number.isFinite(raw) ? Math.trunc(raw) : fallback;
  return Math.max(min, Math.min(max, n));
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 180 ? collapsed.slice(0, 177) + '...' : collapsed;
}
