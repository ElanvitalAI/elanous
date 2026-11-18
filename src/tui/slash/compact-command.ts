/** Lightweight `/compact` command recognition for next TUI startup. */
export const COMPACT_BUSY_STATUS = '/compact is not accepted while a reply is running · retry when done (or Esc cancel)';
export const COMPACT_NO_SESSION_STATUS = 'No conversation to compact';

export function isCompactCommand(text: string): boolean {
  return text.trim() === '/compact';
}
