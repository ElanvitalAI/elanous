/** Lightweight `/resume` and `/session` command parsing for Next TUI startup. */
export const RESUME_BUSY_STATUS = '응답 중에는 /resume 을 받지 않습니다 · 완료(또는 Esc 취소) 뒤 다시';
/** Rows shown by `/resume` and `/session list`. */
export const RESUME_LIST_LIMIT = 12;

export type ResumeCommand =
  | { readonly kind: 'list' }
  | { readonly kind: 'load'; readonly prefix: string };

/** `/resume` · `/session` · `/session list|ls` → list; `/resume <id>` · `/session load|resume <id>` → load. */
export function parseResumeCommand(text: string): ResumeCommand | null {
  const [cmd, sub, arg, ...rest] = text.trim().split(/\s+/);
  if (rest.length > 0) return null;
  if (cmd === '/resume') {
    if (arg !== undefined) return null;
    return sub === undefined ? { kind: 'list' } : { kind: 'load', prefix: sub };
  }
  if (cmd === '/session' || cmd === '/sessions') {
    if (sub === undefined || ((sub === 'list' || sub === 'ls') && arg === undefined)) return { kind: 'list' };
    if ((sub === 'load' || sub === 'resume') && arg !== undefined) return { kind: 'load', prefix: arg };
  }
  return null;
}
