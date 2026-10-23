import { debug } from '../debug/log.js';

const PTY_SPECIAL_KEYS = {
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  enter: '\r',
  esc: '\x1b',
  tab: '\t',
  backspace: '\x7f',
  delete: '\x1b[3~',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
} as const;

const PTY_SPECIAL_KEY_ALIASES = {
  escape: 'esc',
} as const;

/** `ctrl+a` through `ctrl+z` are ASCII control bytes 0x01 through 0x1a.
 *  Accept `control+c` and terminal-style `^c` as equivalent spellings. */
function resolveControlKey(normalized: string): string | undefined {
  const letter = /^(?:ctrl\+|control\+|\^)([a-z])$/.exec(normalized)?.[1];
  return letter ? String.fromCharCode(letter.charCodeAt(0) - 96) : undefined;
}

type PtySpecialKey = keyof typeof PTY_SPECIAL_KEYS;
type PtySpecialKeyAlias = keyof typeof PTY_SPECIAL_KEY_ALIASES;

// ── 조합 키 (PTY-KEY-MODIFIERS · 0.2.36 · 2026-10-22) ──────────────────────────────────────
// `shift+enter` · `alt+enter` · `ctrl+enter` · `ctrl+shift+tab` · `alt+up` … 를 TUI 가 켜 두는 두 프로토콜 중
// 하나로 보낸다 — 기본 xterm modifyOtherKeys `CSI 27;<mod>;<code>~` · `--kitty` 면 kitty `CSI <code>;<mod>u`.
// 화살표·home/end 는 `CSI 1;<mod><F>` · delete/pageup/pagedown 은 `CSI <n>;<mod>~`(두 프로토콜 공통).
// mod = 1 + shift(1) + alt(2) + ctrl(4) — src/tui.ts decodeModifier 와 같은 규약(받는 쪽이 이 값을 그대로 푼다).
// 수식자 없는 키·`ctrl+<글자>` 는 예전 바이트 그대로(호환).
export type PtyKeyEncoding = 'xterm' | 'kitty';
const MODIFIER_BITS: Record<string, number> = { shift: 1, alt: 2, option: 2, ctrl: 4, control: 4 };
const KEYCODES: Record<string, number> = { enter: 13, tab: 9, esc: 27, escape: 27, space: 32, backspace: 127 };
const CSI_FINAL: Record<string, string> = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' };
const CSI_TILDE: Record<string, number> = { delete: 3, pageup: 5, pagedown: 6 };

function resolveModifiedKey(normalized: string, encoding: PtyKeyEncoding): string | undefined {
  if (!normalized.includes('+') || /^(?:ctrl|control)\+[a-z]$/.test(normalized)) return undefined;
  const parts = normalized.split('+').map((p) => p.trim());
  // 조합은 «이름 있는 키» 에만 — 한 글자(ctrl+1 · meta+c)·빈 칸(ctrl++c)·모르는 이름은 예전처럼 거부한다.
  //   표 조회는 자기 속성만(Object.hasOwn) — «constructor+enter» 같은 프로토타입 이름이 새지 않게(r1 must-fix).
  const key = parts.at(-1) ?? '';
  const mods = parts.slice(0, -1);
  if (!key || mods.length === 0 || mods.some((m) => !m || !Object.hasOwn(MODIFIER_BITS, m))) {
    throw new Error(`unknown PTY special key: ${normalized}; modifiers: shift, alt, ctrl + a named key (enter, tab, esc, space, backspace, up, down, left, right, home, end, delete, pageup, pagedown)`);
  }
  let bits = 0;
  for (const m of mods) bits |= MODIFIER_BITS[m]!;
  const mod = 1 + bits;
  if (Object.hasOwn(CSI_FINAL, key)) return `\x1b[1;${mod}${CSI_FINAL[key]}`;
  if (Object.hasOwn(CSI_TILDE, key)) return `\x1b[${CSI_TILDE[key]};${mod}~`;
  if (Object.hasOwn(KEYCODES, key)) {
    const code = KEYCODES[key]!;
    return encoding === 'kitty' ? `\x1b[${code};${mod}u` : `\x1b[27;${mod};${code}~`;
  }
  throw new Error(`unknown PTY special key: ${normalized}; modifiers apply to named keys only (enter, tab, esc, space, backspace, up, down, left, right, home, end, delete, pageup, pagedown)`);
}

export function resolvePtySpecialKey(name: string, opts: { encoding?: PtyKeyEncoding } = {}): string {
  const normalized = name.trim().toLowerCase();
  const encoding = opts.encoding ?? 'xterm';
  const controlBytes = resolveControlKey(normalized);
  if (controlBytes) {
    debug.log('pty.special-key', 'resolved', { inputName: name, resolvedName: normalized, control: true });
    return controlBytes;
  }
  const modified = resolveModifiedKey(normalized, encoding);
  if (modified !== undefined) {
    debug.log('pty.special-key', 'resolved', { inputName: name, resolvedName: normalized, modified: true, encoding });
    return modified;
  }
  const alias = PTY_SPECIAL_KEY_ALIASES[normalized as PtySpecialKeyAlias];
  const resolvedName = alias ?? normalized;
  const bytes = PTY_SPECIAL_KEYS[resolvedName as PtySpecialKey];
  if (!bytes) {
    throw new Error(`unknown PTY special key: ${name}; available names: ${[...Object.keys(PTY_SPECIAL_KEYS), ...Object.keys(PTY_SPECIAL_KEY_ALIASES), 'ctrl+a..ctrl+z', 'shift|alt|ctrl+<key> (e.g. shift+enter)'].join(', ')}`);
  }
  debug.log('pty.special-key', 'resolved', { inputName: name, resolvedName, alias: alias !== undefined });
  return bytes;
}
