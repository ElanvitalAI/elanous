/** Bound named-key expansion before allocating its repeated PTY escape sequence. */
export const MAX_PTY_KEY_REPEAT = 100;

export interface PtyMouseInput {
  readonly x: number;
  readonly y: number;
  readonly button?: 'left' | 'middle' | 'right';
  readonly kind: 'click' | 'scroll-up' | 'scroll-down';
}

export function encodeSgrMouse(input: PtyMouseInput): string {
  const { x, y, kind, button = 'left' } = input;
  if (!Number.isSafeInteger(x) || x < 1 || !Number.isSafeInteger(y) || y < 1) {
    throw new Error('mouse coordinates must be positive 1-based integers');
  }
  if (!['left', 'middle', 'right'].includes(button) || !['click', 'scroll-up', 'scroll-down'].includes(kind)) {
    throw new Error('invalid mouse button or kind');
  }
  const code = kind === 'scroll-up' ? 64 : kind === 'scroll-down' ? 65 : ['left', 'middle', 'right'].indexOf(button);
  const press = `\x1b[<${code};${x};${y}M`;
  return kind === 'click' ? `${press}\x1b[<${code};${x};${y}m` : press;
}

/** DEC private modes are independent; SGR coordinates require ?1006 as well as an event mode. */
export function detectMouseMode(outputChunk: string): { readonly enabled: boolean; feed: (chunk: string) => boolean } {
  const modes = new Set<number>();
  let pending = '';
  const isEnabled = (): boolean => modes.has(1006) && (modes.has(1000) || modes.has(1002) || modes.has(1003));

  const feed = (chunk: string): boolean => {
    const combined = pending + chunk;
    // eslint-disable-next-line no-control-regex
    const sequence = /\x1b\[\?([0-9;]+)([hl])/g;
    for (const match of combined.matchAll(sequence)) {
      for (const token of match[1]!.split(';')) {
        const mode = Number(token);
        if (mode === 1000 || mode === 1002 || mode === 1003 || mode === 1006) {
          if (match[2] === 'h') modes.add(mode);
          else modes.delete(mode);
        }
      }
    }
    // Retain only an incomplete CSI suffix; never replay completed transitions.
    // eslint-disable-next-line no-control-regex
    const start = combined.lastIndexOf('\x1b');
    const suffix = start >= 0 ? combined.slice(start) : '';
    pending = /^\x1b(?:\[(?:\?(?:[0-9;]*)?)?)?$/.test(suffix) && suffix.length < 64 ? suffix : '';
    return isEnabled();
  };
  feed(outputChunk);
  return {
    get enabled() { return isEnabled(); },
    feed,
  };
}

const trackers = new Map<string, ReturnType<typeof detectMouseMode>>();
export const MOUSE_MODE_OFF_REASON = 'PTY mouse mode is off or SGR ?1006 is not enabled';

/** Called by the existing registry output/exit path, before screen rendering strips DEC mode sequences. */
export function trackPtyMouseOutput(id: string, chunk: string): void {
  const tracker = trackers.get(id) ?? detectMouseMode('');
  tracker.feed(chunk);
  trackers.set(id, tracker);
}

export function forgetPtyMouseMode(id: string): void { trackers.delete(id); }

export function mouseModeForPty(handle: { readonly id: string }): boolean {
  return trackers.get(handle.id)?.enabled ?? false;
}

export function mouseModeOffReason(handle: { readonly id: string }): string | undefined {
  return mouseModeForPty(handle) ? undefined : MOUSE_MODE_OFF_REASON;
}
