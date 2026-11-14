import { safeStatusText } from './log-view.js';

export interface PublicToolCall { id: string; name: string; target?: string }
export type PublicToolActivity =
  | ({ phase: 'start' | 'finish' } & PublicToolCall)
  | { phase: 'snapshot'; calls: PublicToolCall[] };
export interface ToolActivityRow extends PublicToolCall {
  startedAt: number;
  finishedAt?: number;
}
const PUBLIC_TOOL_NAMES = new Set([
  'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Bash', 'RunShell',
  'WebFetch', 'WebSearch', 'ToolSearch', 'Agent', 'AgentOutput',
]);

/** Only a file basename crosses the progress boundary, never arguments or file contents. */
export function safeToolTarget(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = safeStatusText(value).replaceAll(String.fromCharCode(92), '/').split('/').at(-1)?.trim();
  if (!name) return undefined;
  if (/(?:auth|secret|credential|token|member-session|^\.env|^id_rsa|^id_ed25519|sk-|aps_)/i.test(name)) return '(비공개 파일)';
  return name.slice(0, 80);
}
export function toolActivityTarget(name: string, args: Record<string, unknown>): string | undefined {
  if (!['Read', 'Write', 'Edit', 'MultiEdit'].includes(name)) return undefined;
  return safeToolTarget(args.file_path ?? args.filePath ?? args.path);
}

export function updateToolActivity(rows: readonly ToolActivityRow[], event: PublicToolActivity, now: number): ToolActivityRow[] {
  if (event.phase === 'snapshot') return event.calls.map(call => ({
    id: call.id, name: call.name, target: safeToolTarget(call.target),
    startedAt: rows.find(row => row.id === call.id)?.startedAt ?? now,
  }));
  const previous = rows.find(row => row.id === event.id);
  const row: ToolActivityRow = {
    id: event.id, name: event.name, target: safeToolTarget(event.target ?? previous?.target),
    startedAt: previous?.startedAt ?? now,
    ...(event.phase === 'finish' ? { finishedAt: now } : {}),
  };
  // 출처: #47304 narrow display hotfix: preserve the four latest call summaries.
  return [...rows.filter(item => item.id !== event.id), row].slice(-4);
}

export function toolActivityLines(rows: readonly ToolActivityRow[], now: number): string[] {
  return rows.map(row => {
    const name = PUBLIC_TOOL_NAMES.has(row.name) ? row.name : '도구';
    const target = PUBLIC_TOOL_NAMES.has(row.name) ? safeToolTarget(row.target) : undefined;
    const seconds = Math.max(0, Math.floor(((row.finishedAt ?? now) - row.startedAt) / 1000));
    return ['활동', name, target, row.finishedAt === undefined ? '실행 중' : '완료', seconds + '초'].filter(Boolean).join(' · ');
  });
}
