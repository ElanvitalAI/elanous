import { safeStatusText } from './log-view.js';

export interface PublicToolCall { id: string; name: string; target?: string }
export type PublicToolActivity =
  | ({ phase: 'start' | 'finish' } & PublicToolCall)
  | { phase: 'snapshot'; calls: PublicToolCall[] };
export interface ToolActivityRow extends PublicToolCall {
  startedAt: number;
  finishedAt?: number;
}
// Source: OP47767 detailed TUI keeps the latest twelve calls in start order.
const RECENT_CALL_LIMIT = 12;
function publicToolName(name: string): string {
  return /^[a-zA-Z][a-zA-Z0-9_.@-]{0,79}$/.test(name)
    && !/(?:private|internal|diagnostic|debug|credential|secret|token)/i.test(name) ? name : '도구';
}
function fileTool(name: string): boolean {
  return ['Read', 'Write', 'Edit', 'MultiEdit', 'read_file', 'write_file', 'edit_file'].includes(name);
}
function shellTool(name: string): boolean {
  return ['Bash', 'RunShell', 'bash', 'run_shell', 'shell', 'exec_argv'].includes(name);
}

/** Show command structure, never arbitrary argument values or command bodies. */
export function safeCommandSummary(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const command = safeStatusText(value).trim();
  if (!command) return undefined;
  if (/(?:private|secret|token|password|passwd|authorization|cookie|api[_-]?key|sk-|aps_)/i.test(command))
    return '(비공개 명령)';
  if (command === '(비공개 명령)') return command;
  const first = command.split(/[|;&<>]/, 1)[0] ?? '';
  const tokens = first.replace(/"[^"]*"|'[^']*'/g, '[인자]').split(/\s+/).filter(Boolean);
  const safeWords = new Set(['test', 'run', 'build', 'install', 'status', 'diff', 'log', 'show', 'check', 'typecheck', 'lint']);
  return tokens.map((word, index) => {
    if (word === '[인자]') return word;
    if (word.includes('=')) return '[인자]';
    if (index === 0) return safeToolTarget(word) ?? '명령';
    if (safeWords.has(word) || /^--?[a-zA-Z][a-zA-Z-]*$/.test(word)) return word;
    if (/[\/\\]/.test(word) || /\.[a-zA-Z0-9]{1,5}$/.test(word))
      return safeToolTarget(word) ?? '[인자]';
    return '[인자]';
  }).join(' ').slice(0, 40);
}
export function safeToolActivityTarget(name: string, value: unknown): string | undefined {
  if (publicToolName(name) === '도구') return undefined;
  return shellTool(name) ? safeCommandSummary(value) : safeToolTarget(value);
}

/** Only a file basename crosses the progress boundary, never arguments or file contents. */
export function safeToolTarget(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = safeStatusText(value).replaceAll(String.fromCharCode(92), '/')
    .replace(/(?:^|[a-zA-Z]:)\/(?:Users|home)\/[^/\s]+/g, '~');
  const name = normalized.split('/').at(-1)?.trim();
  if (!name) return undefined;
  if (/(?:auth|secret|credential|token|member-session|^\.env|^id_rsa|^id_ed25519|sk-|aps_)/i.test(name)) return '(비공개 파일)';
  return name.slice(0, 80);
}
export function toolActivityTarget(name: string, args: Record<string, unknown>): string | undefined {
  if (shellTool(name)) return safeCommandSummary(args.command ?? args.cmd
    ?? (Array.isArray(args.argv) ? args.argv.join(' ') : undefined));
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
  const row: ToolActivityRow = {
    id: event.id, name: event.name, target: safeToolActivityTarget(event.name, event.target ?? previous?.target),
    startedAt: previous?.startedAt ?? now,
    ...(event.phase === 'finish' ? { finishedAt: now } : {}),
  };
  // Completion updates its existing line; it never reorders earlier starts.
  return (previous ? rows.map(item => item.id === event.id ? row : item) : [...rows, row]).slice(-RECENT_CALL_LIMIT);
}

export function toolActivityLines(rows: readonly ToolActivityRow[], now: number): string[] {
  return rows.map(row => {
    const name = publicToolName(row.name);
    const target = safeToolActivityTarget(row.name, row.target);
    const seconds = Math.max(0, Math.floor(((row.finishedAt ?? now) - row.startedAt) / 1000));
    return ['활동', name, target, row.finishedAt === undefined ? '실행 중' : '완료', seconds + '초'].filter(Boolean).join(' · ');
  });
}
