/** A remote ELS owner or transport may return arbitrary text. Only fixed, bounded categories enter the TUI. */
export function safeElsErrorStatus(error: unknown): 'timeout' | 'unavailable' {
  let message: string;
  try { message = error instanceof Error ? error.message : String(error); }
  catch { return 'unavailable'; }
  return /\b(?:timeout|timed out|deadline|aborted?)\b/i.test(message.slice(0, 256)) ? 'timeout' : 'unavailable';
}
