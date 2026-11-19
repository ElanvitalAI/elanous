import { maskEnvAssignments, simpleArgv } from '../../security/shell-argv-policy.js';
import { safeStatusText } from './log-view.js';

export interface PublicToolCall { id: string; name: string; target?: string; /** A finished sub-agent's one-line result (Agent rows only). */ summary?: string }
export type PublicToolActivity =
  | ({ phase: 'start' | 'finish' } & PublicToolCall)
  | { phase: 'snapshot'; calls: PublicToolCall[] };
export interface ToolActivityRow extends PublicToolCall {
  startedAt: number;
  finishedAt?: number;
}
// Source: OP47767 detailed TUI keeps the latest twelve calls in start order.
const RECENT_CALL_LIMIT = 12;
/** Placeholder shown instead of a tool name that must not be public. */
const HIDDEN_TOOL_LABEL = 'Tool';
function publicToolName(name: string): string {
  return /^[a-zA-Z][a-zA-Z0-9_.@-]{0,79}$/.test(name)
    && !/(?:private|internal|diagnostic|debug|credential|secret|token)/i.test(name) ? name : HIDDEN_TOOL_LABEL;
}
function fileTool(name: string): boolean {
  return ['Read', 'Write', 'Edit', 'MultiEdit', 'read_file', 'write_file', 'edit_file'].includes(name);
}
function agentTool(name: string): boolean {
  return name === 'Agent' || name === 'spawn_agent';
}
function shellTool(name: string): boolean {
  return ['Bash', 'RunShell', 'bash', 'run_shell', 'shell', 'exec_argv'].includes(name);
}

/** What replaces a suspected secret (English, short, stable under repeated projection). */
export const REDACTED = '…';
const PRIVATE_COMMAND = '(private command)';
const PRIVATE_FILE = '(private file)';
const SUMMARY_MAX = 60;

function opaqueSecret(word: string): boolean {
  return /^[A-Za-z0-9+/=_-]{32,}$/.test(word) && /[A-Za-z]/.test(word) && /\d/.test(word);
}

/** The first simple command: cut at `| ; & < >` only outside quotes, so `-H "Cookie: a=1; b=2"` stays one (hidden) word. */
function firstShellSegment(command: string): string {
  let quote = '';
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if ('|;&<>'.includes(ch)) return command.slice(0, i);
  }
  return command;
}

/** Sub-commands that are safe to show after a known command name. Anything else after the name is hidden. */
const SAFE_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = Object.fromEntries(Object.entries({
  git: 'status log diff show branch checkout switch add commit push pull fetch rebase merge stash worktree remote tag reset restore blame clone init',
  bun: 'test run install add remove x build pm',
  npm: 'test run install ci build start', pnpm: 'test run install build start', yarn: 'test run install build start',
  cargo: 'build test run check fmt clippy', go: 'build test run vet',
  docker: 'ps images build run exec logs compose pull stop start', kubectl: 'get describe logs apply',
  gh: 'pr issue run repo', eln: 'msg logs pty release doctor', elanous: 'msg logs pty release doctor',
  herdr: 'pane tab workspace',
}).map(([name, words]) => [name, new Set(words.split(' '))]));

/** Script names that are safe to show after `bun|npm|pnpm|yarn run`. */
const SAFE_RUN_SCRIPTS: ReadonlySet<string> = new Set('build test lint dev start typecheck check format fmt clean watch'.split(' '));
const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(['bun', 'npm', 'pnpm', 'yarn']);

const FILE_EXTENSIONS = 'ts|tsx|js|mjs|cjs|json|md|txt|py|sh|ya?ml|toml|lock|log|css|html|rs|go';
/** A path is only what STARTS like one — `/` · `./` · `../` · `~/` — in safe characters (no scheme, host, query, `@`, `=`, `:`).
 *  A word that merely contains a slash (`abc/bPxRf…`, base64 tails) is not a path. */
const ANCHORED_PATH = /^(?:\/|\.{1,2}\/|~\/)[A-Za-z0-9_.+~-]+(?:\/[A-Za-z0-9_.+~-]+)*\/?$/;
/** …or a relative file path whose last part is a file name with a known extension (`src/tui/x.test.ts`, `README.md`). */
const FILE_PATH = new RegExp(`^(?:[A-Za-z0-9_.+~-]+/)*[A-Za-z0-9_+-]+(?:\\.[A-Za-z0-9_+-]+)*\\.(?:${FILE_EXTENSIONS})$`);
/** Flags whose next word is a credential, and words that introduce one (`Authorization:`, `Bearer`): a path-shaped word after them is still «…». */
const CREDENTIAL_FLAG = /^(?:--[A-Za-z-]*(?:token|secret|pass|pwd|key|auth|cred|cookie|bearer|body|header|data|user)[A-Za-z-]*|-[HuUpPaAdD])$/i;
const CREDENTIAL_INTRO = /^(?:bearer|basic|digest|negotiate|token)$|:$/i;
/** A flag NAME (never its value): `--lines`, `-n`. Glued or assigned values (`-pPW`, `--user=a:b`) are not flag names. */
const FLAG_WORD = /^(?:--[A-Za-z][A-Za-z-]{1,24}|-[A-Za-z])$/;

/**
 * Allow-list summary of a shell command (#38033 — hiding only what LOOKS secret lost three review rounds, so only what is KNOWN safe shows):
 * the command name, a known safe sub-command, flag names, and path-shaped arguments reduced to a safe basename.
 * Every other word — quoted strings, headers, positional values, `name=value`, URLs, numbers, user:password — is «…».
 */
export function safeCommandSummary(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const command = safeStatusText(value).trim();
  if (!command) return undefined;
  if (command === PRIVATE_COMMAND) return command;
  // The literal word «private» marks a command the producer already withheld; our own placeholders do not count.
  const withoutPlaceholders = command.replaceAll(PRIVATE_FILE, '');
  if (/private/i.test(withoutPlaceholders) && !/(?:private[_-]?key)/i.test(withoutPlaceholders)) return PRIVATE_COMMAND;
  const atomicFile = '__ELANOUS_FILE_MARK__';
  const words = [...firstShellSegment(command).replaceAll(PRIVATE_FILE, atomicFile).matchAll(/"([^"]*)"|'([^']*)'|\S+/g)];
  const out: string[] = [];
  let name: string | undefined;
  let subcommandOpen = false;
  let scriptOpen = false;
  let afterCredentialWord = false;
  for (const match of words) {
    const word = match[0];
    const quoted = match[1] !== undefined || match[2] !== undefined;
    if (word === atomicFile || word === './' + atomicFile) { out.push(PRIVATE_FILE); continue; }
    if (quoted) { out.push(REDACTED); continue; }
    if (name === undefined) {
      // `FOO=bar cmd`: leading assignments are values (and stay «…» when this summary is projected again), the first plain word is the command.
      if (word === REDACTED || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) { out.push(REDACTED); continue; }
      const target = /^[a-zA-Z0-9_./~\\-]+$/.test(word) ? safeToolTarget(word) : undefined;
      name = (target ?? 'command').toLowerCase();
      out.push(target ?? 'command');
      subcommandOpen = true;
      continue;
    }
    if (subcommandOpen) {
      subcommandOpen = false;
      if (SAFE_SUBCOMMANDS[name]?.has(word)) { out.push(word); scriptOpen = word === 'run' && PACKAGE_RUNNERS.has(name); continue; }
    }
    if (scriptOpen) {
      scriptOpen = false;
      if (SAFE_RUN_SCRIPTS.has(word)) { out.push(word); continue; }
    }
    const credentialContext = afterCredentialWord;
    afterCredentialWord = CREDENTIAL_FLAG.test(word) || CREDENTIAL_INTRO.test(word);
    if (FLAG_WORD.test(word)) { out.push(word); continue; }
    if (!credentialContext && (ANCHORED_PATH.test(word) || FILE_PATH.test(word))) {
      const target = safeToolTarget(word);
      out.push(target === PRIVATE_FILE ? PRIVATE_FILE : target && target !== '~' && !opaqueSecret(target) ? './' + target : REDACTED);
      continue;
    }
    out.push(REDACTED);
  }
  return out.join(' ').slice(0, SUMMARY_MAX);
}
const AGENT_DESCRIPTION_MAX = 40;
const AGENT_SUMMARY_MAX = 60;
/** Vendor-style credential prefixes — a word starting like one is never shown, whatever its length. */
const CREDENTIAL_PREFIX = /^(?:sk|pk|rk|gh[pousr]|github_pat|xox[abprs]|aps|emt|akia|eyj)[-_A-Za-z0-9]/i;
/** A word that looks like a secret: a vendor prefix, or a long run mixing letters and digits. */
function secretLikeWord(word: string): boolean {
  return CREDENTIAL_PREFIX.test(word) || (word.length >= 12 && /[A-Za-z]/.test(word) && /\d/.test(word));
}

/**
 * The short label a person gave a sub-agent («probe A», «check the auth flow») — allow-list, like the shell summaries:
 * letters, digits, spaces and a few separators only, at most 40 characters, no secret-looking word. Anything else shows no label.
 */
export function safeAgentDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length === 0 || text.length > AGENT_DESCRIPTION_MAX) return undefined;
  if (!/^[\p{L}\p{N} ._#-]+$/u.test(text)) return undefined;
  return text.split(' ').some(secretLikeWord) ? undefined : text;
}

/**
 * One line of a finished sub-agent's answer for its row: the first non-empty line, plain words only, secret-looking words and
 * anything but letters, digits and common punctuation replaced by «…», at most 60 characters. The child's tool output never gets here —
 * only its final text (what the parent itself receives as the tool result).
 */
export function safeAgentSummary(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value
    : value !== null && typeof value === 'object' && typeof (value as { output?: unknown }).output === 'string' ? (value as { output: string }).output : undefined;
  if (raw === undefined) return undefined;
  const line = raw.split(/\r?\n/).map(part => safeStatusText(part).trim()).find(part => part.length > 0);
  if (!line) return undefined;
  const words = line.split(/\s+/).map(word => (secretLikeWord(word) || /[@=:\/\\]/.test(word) && word.length > 3 ? REDACTED : word.replace(/[^\p{L}\p{N}.,;!?()'"%+\-_…]/gu, '')));
  const text = words.filter(word => word.length > 0).join(' ');
  if (!text) return undefined;
  return text.length > AGENT_SUMMARY_MAX ? `${text.slice(0, AGENT_SUMMARY_MAX - 1)}…` : text;
}

export function safeToolActivityTarget(name: string, value: unknown): string | undefined {
  if (publicToolName(name) === HIDDEN_TOOL_LABEL) return undefined;
  if (agentTool(name)) return safeAgentDescription(value);
  return shellTool(name) ? safeCommandSummary(value) : safeToolTarget(value);
}

/**
 * SECRET-REDACT r3 (#38553, «union · fail-closed»): the argv-policy token layer runs AFTER the existing masking
 * and can only hide more — no projection may show more than the pre-r3 verdict did. simpleArgv refuses an
 * unterminated quote and that refusal hides the whole line (fail-closed, never a plaintext fragment);
 * maskEnvAssignments keeps only what precedes a token's first «=» (NAME=value → NAME=****). Each surviving
 * token is judged on structure only: one shaped like a URL authority — userinfo (u:pass@host · user@host) or
 * a query (?key=value) — becomes the mark. Tokens that pass cross unchanged, so re-projection (snapshot,
 * transport) is a fixed point.
 */
function tokenLayerGate(existing: string): string {
  const argv = simpleArgv(existing);
  if (argv === null) return REDACTED;
  const envMasked = maskEnvAssignments(argv);
  let masked = envMasked.some((word, index) => word !== argv[index]);
  const words = envMasked.map((word) => {
    if (!word.includes('@') && !word.includes('?')) return word;
    masked = true;
    return REDACTED;
  });
  return masked ? words.join(' ') : existing;
}

/** Only a file basename crosses the progress boundary, never arguments or file contents. */

export function safeToolTarget(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = safeStatusText(value).replaceAll(String.fromCharCode(92), '/')
    .replace(/(?:^|[a-zA-Z]:)\/(?:Users|home)\/[^/\s]+/g, '~');
  const name = normalized.split('/').at(-1)?.trim();
  if (!name) return undefined;
  // OP50183 / postland #37764 MF1: credential filenames are private even without sensitive contents.
  if (/(?:auth|secret|credential|token|member-session|^\.env|^id_rsa|^id_ed25519|sk-|aps_)/i.test(name)
    || /^(?:\.netrc|\.npmrc|\.pypirc)(?:$|[._~-])/i.test(name)
    || /\.(?:pem|key)(?:$|[._~-])/i.test(name)) return PRIVATE_FILE;
  return tokenLayerGate(name).slice(0, 80);
}
export function toolActivityTarget(name: string, args: Record<string, unknown>): string | undefined {
  if (agentTool(name)) return safeAgentDescription(args.description);
  if (shellTool(name)) return safeCommandSummary(args.command ?? args.cmd
    ?? (Array.isArray(args.argv) ? args.argv.map(arg => (typeof arg === 'string' && /\s/.test(arg) && !/["']/.test(arg) ? `"${arg}"` : String(arg))).join(' ') : undefined));
  if (!fileTool(name)) return undefined;
  return safeToolTarget(args.file_path ?? args.filePath ?? args.path);
}

export function updateToolActivity(rows: readonly ToolActivityRow[], event: PublicToolActivity, now: number): ToolActivityRow[] {
  if (event.phase === 'snapshot') {
    let result = rows.filter(row => row.finishedAt !== undefined || event.calls.some(call => call.id === row.id));
    for (const call of event.calls) {
      if (!result.some(row => row.id === call.id))
        result = updateToolActivity(result, { phase: 'start', ...call }, now);
    }
    return result;
  }
  const previous = rows.find(row => row.id === event.id);
  // An evicted/unknown completion must not reinsert an old call and displace newer starts.
  if (event.phase === 'finish' && !previous) return [...rows];
  const row: ToolActivityRow = {
    id: event.id, name: event.name, target: safeToolActivityTarget(event.name, event.target ?? previous?.target),
    startedAt: previous?.startedAt ?? now,
    ...(event.phase === 'finish' ? { finishedAt: now } : {}),
    ...(agentTool(event.name) && (event.summary ?? previous?.summary) !== undefined ? { summary: safeAgentSummary(event.summary ?? previous?.summary) } : {}),
  };
  // Completion updates its existing line; it never reorders earlier starts.
  return (previous ? rows.map(item => item.id === event.id ? row : item) : [...rows, row]).slice(-RECENT_CALL_LIMIT);
}

/** Classic-style tool rows (src/render.ts toolHeader): a glyph, the tool name, its short target, and the time only
 *  when it is a second or more. `⏺` while running, `✓` once finished; plain text so the row can be dimmed after
 *  fitting (fitLogLine strips SGR). English on purpose — these are tool names, not prose. */
export const TOOL_RUNNING_GLYPH = process.platform === 'darwin' ? '\u23FA' : '\u25CF';
export const TOOL_DONE_GLYPH = '\u2713';
/** A run of this many consecutive finished calls of one tool folds into a single «Read ×N» row. */
export const TOOL_FOLD_MIN_RUN = 3;

export function isToolActivityLine(line: string): boolean {
  return line.startsWith(`${TOOL_RUNNING_GLYPH} `) || line.startsWith(`${TOOL_DONE_GLYPH} `);
}

function projectedTarget(row: ToolActivityRow): string | undefined {
  const target = safeToolActivityTarget(row.name, row.target);
  return shellTool(row.name) ? target?.replace(/(^| )\.\//g, '$1') : target;
}

function elapsed(row: ToolActivityRow, now: number): string {
  const seconds = Math.max(0, Math.floor(((row.finishedAt ?? now) - row.startedAt) / 1000));
  return seconds > 0 ? ` ${seconds}s` : '';
}

/** The newest still-running call, labelled exactly as its row is (public name, projected target). */
export function runningToolLabel(rows: readonly ToolActivityRow[]): { name: string; target?: string } | undefined {
  const running = [...rows].reverse().find((row) => row.finishedAt === undefined);
  if (!running) return undefined;
  const target = projectedTarget(running);
  return { name: publicToolName(running.name), ...(target ? { target } : {}) };
}

export function toolActivityLines(rows: readonly ToolActivityRow[], now: number): string[] {
  const lines: string[] = [];
  for (let index = 0; index < rows.length;) {
    const row = rows[index]!;
    const name = publicToolName(row.name);
    let end = index + 1;
    if (row.finishedAt !== undefined && !agentTool(row.name)) {
      while (end < rows.length && rows[end]!.finishedAt !== undefined && publicToolName(rows[end]!.name) === name) end++;
    }
    if (end - index >= TOOL_FOLD_MIN_RUN) {
      const last = projectedTarget(rows[end - 1]!);
      const total = rows.slice(index, end).reduce((sum, item) => sum + Math.max(0, Math.floor(((item.finishedAt ?? now) - item.startedAt) / 1000)), 0);
      lines.push(`${TOOL_DONE_GLYPH} ${name} ×${end - index}${last ? ` · last ${last}` : ''}${total > 0 ? ` ${total}s` : ''}`);
      index = end;
      continue;
    }
    const target = projectedTarget(row);
    const call = target ? `${name}(${target})` : name;
    lines.push(row.finishedAt === undefined
      ? `${TOOL_RUNNING_GLYPH} ${call}${elapsed(row, now)}`
      : `${TOOL_DONE_GLYPH} ${call}${elapsed(row, now)}${agentTool(row.name) && row.summary ? ` · ${safeAgentSummary(row.summary) ?? ''}`.replace(/ · $/, '') : ''}`);
    index++;
  }
  return lines;
}

/**
 * NEXT-TUI-TOOL-LOG-NOT-PINNED (OP79969): one chronological turn flow like classic's
 * turn-stream formatter (closeRound on each tool call). Each tool row sits at the reply-text
 * offset where it started; text before it renders above, text after it below. `text` is the
 * already-redacted preview (a prefix of the raw stream), so offsets are clamped to it.
 */
export function interleavedTurnLines(
  rows: readonly ToolActivityRow[], offsets: ReadonlyMap<string, number>, text: string,
  now: number, textLines: (chunk: string) => string[],
): string[] {
  const anchored = rows.map((row, index) => ({ row, index,
    at: Math.min(text.length, Math.max(0, offsets.get(row.id) ?? text.length)) }))
    .sort((left, right) => left.at - right.at || left.index - right.index);
  const lines: string[] = [];
  let cursor = 0;
  let pending: ToolActivityRow[] = [];
  const flush = (): void => { if (pending.length) { lines.push(...toolActivityLines(pending, now)); pending = []; } };
  for (const { row, at } of anchored) {
    if (at > cursor) {
      const chunk = text.slice(cursor, at);
      if (chunk.trim()) { flush(); lines.push(...textLines(chunk)); }
      cursor = at;
    }
    pending.push(row);
  }
  flush();
  const rest = text.slice(cursor);
  if (rest.trim()) lines.push(...textLines(rest));
  return lines;
}
