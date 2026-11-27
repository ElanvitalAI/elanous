// ELS-RUNTIME-ADAPTERS — helpers shared by the adapters (pure).

import type { AgentStatus, InputOp, ScreenRules } from './types.js';

// 출처: src/tui/chat/working-row.ts — eln's working row is `<spinner> <Verb> (<elapsed> • esc to interrupt)`, and codex and
// Claude Code show the same «esc to interrupt» hint while busy (moved here from pane-status.ts).
export const WORKING_HINT = /esc to interrupt/i;

const WRAPPERS = new Set(['bun', 'bunx', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'deno']);
const baseName = (part: string): string => (part.split('/').pop() ?? part).replace(/^-/, '');   // «-zsh» = a login shell
/** The executable a command line runs, past the runtime wrappers (bun · node · npx …); never an argument. */
export function executableOf(command: readonly string[] | undefined): string {
  const args = command ?? [];
  let at = 0;
  while (at + 1 < args.length && WRAPPERS.has(baseName(args[at]!))) at++;
  return baseName(args[at] ?? '');
}

/** The prompt row regex for these heads: `^(?:<head>|<head>)\s?(text)\s*│?\s*$`. */
export function promptRow(heads: readonly string[]): RegExp {
  return new RegExp(`^(?:${heads.join('|')})\\s?(.*?)\\s*│?\\s*$`);
}

/** The prompt text of the bottom-most prompt row (a past «❯» line in eln's transcript never stands in for it). */
export function lastPromptText(lines: readonly string[], row: RegExp): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = row.exec(lines[i]!.trimEnd());
    if (match) return match[1] ?? '';
  }
  return undefined;
}

/** A screen read with one runtime's rules: exited › asking › busy › idle (a prompt row, or nothing busy). */
export function statusFromScreen(rules: ScreenRules, screen: string | undefined, exited = false): AgentStatus {
  if (exited) return 'exited';
  if (screen === undefined) return 'idle';
  if (rules.asking?.(screen)) return 'asking';
  const lines = screen.split('\n');
  if (lines.some((line) => rules.busy.some((one) => one.test(line)))) return 'busy';
  return 'idle';
}

/** A path for an input line: «"…"» when it has a space, a quote-free non-ASCII char (Korean) or a shell-special char. */
export function quotePath(path: string): string {
  return /^[A-Za-z0-9._/~+-]+$/.test(path) ? path : `"${path.replace(/(["\\])/g, '\\$1')}"`;
}

// A path is inserted as text: control bytes (a newline would be Enter) become spaces — the server refuses such paths first.
const safe = (path: string): string => path.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

/** «@<path>» mentions (quoted when needed: @"/a/my file.md"), space-separated, with a trailing space — never Enter. */
export function mentionOps(files: readonly string[]): InputOp[] {
  return files.length ? [{ kind: 'paste', text: `${files.map((file) => `@${quotePath(safe(file))}`).join(' ')} ` }] : [];
}

/** Plain quoted paths (a shell, or a runtime without @-mentions), space-separated — never Enter. */
export function pathOps(files: readonly string[]): InputOp[] {
  return files.length ? [{ kind: 'paste', text: `${files.map((file) => shellQuote(safe(file))).join(' ')} ` }] : [];
}

/** POSIX single-quote form for a shell line ('it'\''s'). */
export function shellQuote(path: string): string {
  return /^[A-Za-z0-9._/~+-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/** Text for an input line: control bytes become spaces (a paste must not carry Enter). */
export function textOps(text: string): InputOp[] {
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  return clean ? [{ kind: 'paste', text: clean }] : [];
}
