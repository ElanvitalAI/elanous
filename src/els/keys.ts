// els send-keys — logical key names → terminal bytes (herdr `pane send-keys` words: enter, esc, ctrl+c, up …).
// All keys are validated before any byte is written, so a typo never sends half a sequence.

const NAMED: Record<string, string> = {
  enter: '\r', return: '\r', tab: '\t', esc: '\x1b', escape: '\x1b', space: ' ', backspace: '\x7f', delete: '\x1b[3~',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', home: '\x1b[H', end: '\x1b[F',
  pageup: '\x1b[5~', pagedown: '\x1b[6~', 'shift+tab': '\x1b[Z',
};

/** The bytes of one key name, or undefined when it is not a known key. */
export function keyBytes(name: string): string | undefined {
  const key = name.trim().toLowerCase();
  const named = NAMED[key];
  if (named !== undefined) return named;
  const ctrl = /^ctrl\+([a-z])$/.exec(key);
  // 출처: Ctrl+<letter> is the control character 0x01–0x1a (letter − 0x60).
  if (ctrl) return String.fromCharCode(ctrl[1]!.charCodeAt(0) - 0x60);
  const alt = /^alt\+(.)$/.exec(key);
  if (alt) return `\x1b${alt[1]}`;
  return Array.from(name).length === 1 && name >= ' ' && name !== '\x7f' ? name : undefined;
}

/** All keys as one byte string, or the first name that is not a key. */
export function keysToBytes(names: readonly string[]): { bytes: string } | { unknown: string } {
  let bytes = '';
  for (const name of names) {
    const one = keyBytes(name);
    if (one === undefined) return { unknown: name };
    bytes += one;
  }
  return { bytes };
}
