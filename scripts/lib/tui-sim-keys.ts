// Named tui-sim keys and raw PTY input bytes.
const KEYS: Record<string, string> = {
  enter: '\r', return: '\r', tab: '\t', 'shift-tab': '\x1b[Z', esc: '\x1b', escape: '\x1b',
  space: ' ', backspace: '\x7f', delete: '\x1b[3~',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  pageup: '\x1b[5~', pagedown: '\x1b[6~', home: '\x1b[H', end: '\x1b[F',
  'shift-enter': '\x1b[13;2u',
};

export function resolveKeyBytes(name: string): string | null {
  const key = name.toLowerCase();
  if (Object.hasOwn(KEYS, key)) return KEYS[key]!;
  if (/^ctrl-[a-z]$/.test(key)) return String.fromCharCode(key.charCodeAt(5) - 96);
  if (key === 'ctrl-\\') return '\x1c';
  if (key === 'ctrl-]') return '\x1d';
  if (key.startsWith('hex:')) {
    const hex = key.slice(4);
    return hex.length > 0 && hex.length % 2 === 0 && /^[0-9a-f]+$/.test(hex)
      ? Buffer.from(hex, 'hex').toString('latin1')
      : null;
  }
  if (key.startsWith('alt-')) {
    const suffix = name.slice(4);
    const bytes = Object.hasOwn(KEYS, suffix.toLowerCase()) ? KEYS[suffix.toLowerCase()]!
      : suffix.toLowerCase().startsWith('ctrl-') ? resolveKeyBytes(suffix)
      : [...suffix].length === 1 ? suffix : null;
    return bytes === null ? null : `\x1b${bytes}`;
  }
  return null;
}

/** Keep raw hex as a Buffer: passing a latin1 string to the PTY would UTF-8 encode bytes >= 0x80. */
export function resolveKeyInput(name: string): string | Buffer | null {
  const bytes = resolveKeyBytes(name);
  if (bytes === null) return null;
  return name.toLowerCase().startsWith('hex:') ? Buffer.from(name.slice(4), 'hex') : bytes;
}

/** Bun's native PTY passes Buffer bytes through unchanged; its typed registry API only declares strings. */
export function writeKeyInput(handle: { write(chars: string): void }, input: string | Buffer): void {
  handle.write(input as string);
}
