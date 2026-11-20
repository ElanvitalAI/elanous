// els send-keys — logical key names → terminal bytes (herdr `pane send-keys` words: enter, up, left …).
// All keys are validated before any byte is written, so a typo never sends half a sequence.
// #90792 P0 ② — this vocabulary IS the send-keys allowlist, separate from the person path on purpose: a person
// typing in an attached view presses raw keys (`input`), while a script may only name harmless editing keys.
// esc, every ctrl+<key> (ctrl+c, the interrupt, among them) and every alt+<key> (an ESC-prefixed chord) could
// cancel, stop or hijack the pane, so they are refused here; enter, the arrows and the other line-editing keys
// are all a script may press.

const NAMED: Record<string, string> = {
  enter: '\r', return: '\r', tab: '\t', space: ' ', backspace: '\x7f', delete: '\x1b[3~',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', home: '\x1b[H', end: '\x1b[F',
  pageup: '\x1b[5~', pagedown: '\x1b[6~', 'shift+tab': '\x1b[Z',
};

/** The bytes of one key name, or undefined when it is not a key send-keys may press. */
export function keyBytes(name: string): string | undefined {
  const key = name.trim().toLowerCase();
  // #90792 P0 ② — destructive control keys are refused, not mapped: no esc, no ctrl+<key>, no alt+<key>.
  // The named editing keys above and one printable character are the whole allowlist (fail closed).
  if (key === 'esc' || key === 'escape' || key.startsWith('ctrl+') || key.startsWith('alt+')) return undefined;
  const named = NAMED[key];
  if (named !== undefined) return named;
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
