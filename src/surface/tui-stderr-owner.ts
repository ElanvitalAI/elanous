import { debug } from '../debug/log.js';

export type TuiStderrNotice = (line: string) => void;

/** Take ownership of writes made through the TUI process' stderr stream.
 *  Raw bytes go to the normal debug log; the presentation surface receives
 *  bounded one-line notices. Child processes must still use piped stderr:
 *  an OS-level fd 2 inherited by a child bypasses this JavaScript stream. */
export function installTuiStderrOwner(notice: TuiStderrNotice): () => void {
  const stderr = process.stderr;
  const originalWrite = stderr.write;
  let pending = '';
  let active = true;

  const emit = (raw: string): void => {
    if (!raw) return;
    try {
      debug.log('tui.stderr', 'captured', { text: raw, byteLength: Buffer.byteLength(raw, 'utf8') });
    } catch { /* capture must not re-open the physical stderr path */ }
    const compact = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\s+/g, ' ').trim();
    if (compact) {
      try { notice(compact.length > 240 ? `${compact.slice(0, 239)}…` : compact); }
      catch { /* renderer failure must not overwrite the prompt */ }
    }
  };

  const write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
    const text = typeof chunk === 'string'
      ? chunk
      : Buffer.from(chunk).toString(typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8');
    pending += text;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) emit(line);
    if (typeof encodingOrCallback === 'function') encodingOrCallback();
    else callback?.();
    return true;
  }) as typeof stderr.write;

  stderr.write = write;
  return () => {
    if (!active) return;
    active = false;
    if (stderr.write === write) stderr.write = originalWrite;
    emit(pending);
    pending = '';
  };
}
