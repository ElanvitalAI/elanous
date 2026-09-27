// ── Yazi-inspired TUI engine ──
// No external dependencies — raw ANSI + stdin for full control
// Colors use terminal attributes (dim/bold/inverse) for transparent-theme compat

import chalk from 'chalk';
import { StringDecoder } from 'node:string_decoder';
import { perf } from './perf-counters.js';
import { debug } from './debug/log.js';

// ── ANSI escape sequences ──
const CSI = '\x1b[';

export const ansi = {
  clear:       `${CSI}2J${CSI}H`,
  clearLine:   `${CSI}2K`,
  hideCursor:  `${CSI}?25l`,
  showCursor:  `${CSI}?25h`,
  altOn:       `${CSI}?1049h`,
  altOff:      `${CSI}?1049l`,
  eraseDown:   `${CSI}J`,
  moveTo:      (r: number, c: number) => `${CSI}${r};${c}H`,
  // SGR mouse enable. Modes activated:
  //   1000 — basic button press/release
  //   1002 — button-event (drag while button held)
  //   1003 — any-event (motion without button) — opt-in via env
  //          ELANOUS_MOUSE_HOVER=1. Required for IDX-5 hover-stable +
  //          Tooltip auto-show. Default off because 1003 floods the
  //          input pipe on every pixel of mouse motion; users who
  //          don't want hover can keep the light mode.
  //   1006 — SGR extended coordinate encoding (required for > 223 cols)
  get mouseOn() {
    const hover = process.env.ELANOUS_MOUSE_HOVER === '1';
    const motionMode = hover ? '1003' : '1002';
    return `${CSI}?1000h${CSI}?${motionMode}h${CSI}?1006h`;
  },
  get mouseOff() {
    const hover = process.env.ELANOUS_MOUSE_HOVER === '1';
    const motionMode = hover ? '1003' : '1002';
    return `${CSI}?${motionMode}l${CSI}?1000l${CSI}?1006l`;
  },
  // Kitty keyboard protocol: enables Shift+Enter as CSI 13;2 u
  kittyKbOn:   `${CSI}>1u`,
  kittyKbOff:  `${CSI}<u`,
  // PR-S1V.4 — Voice mode level upgrade. `>3u` enables release/repeat
  // events (bit 0x01 disambiguate + bit 0x02 report event types). Used
  // by voice-mode.ts only when entering voice mode; restored to `>1u`
  // on exit. Crash safety: on `'exit'`/'SIGINT'/'SIGTERM' we always
  // write `kittyKbOff` (`<u`) which pops the stack to baseline.
  kittyKbVoiceOn:  `${CSI}>3u`,
  kittyKbVoiceOff: `${CSI}>1u`,
  // xterm modifyOtherKeys v2: fallback for tmux/ssh
  modKeysOn:   `${CSI}>4;2m`,
  modKeysOff:  `${CSI}>4;0m`,
  // Bracketed paste: terminal wraps pastes with CSI 200~ ... CSI 201~ so
  // we can distinguish a paste from fast typing and tokenize file paths
  // in-place. See claude-code-fork's PromptInput for the reference UX.
  pasteOn:     `${CSI}?2004h`,
  pasteOff:    `${CSI}?2004l`,
};

// ── Color palette — Catppuccin Mocha (matching Yazi theme) ──
// Palette reference: https://catppuccin.com/palette
// Base tones
const ctp = {
  rosewater: '#f5e0dc',
  flamingo:  '#f2cdcd',
  pink:      '#f5c2e7',
  mauve:     '#cba6f7',
  red:       '#f38ba8',
  maroon:    '#eba0ac',
  peach:     '#fab387',
  yellow:    '#f9e2af',
  green:     '#a6e3a1',
  teal:      '#94e2d5',
  sky:       '#89dceb',
  sapphire:  '#74c7ec',
  blue:      '#89b4fa',
  lavender:  '#b4befe',
  text:      '#cdd6f4',
  subtext1:  '#bac2de',
  subtext0:  '#a6adc8',
  overlay2:  '#9399b2',
  overlay1:  '#7f849c',
  overlay0:  '#6c7086',
  surface2:  '#585b70',
  surface1:  '#45475a',
  surface0:  '#313244',
  base:      '#1e1e2e',
  mantle:    '#181825',
  crust:     '#11111b',
};

export const C = {
  accent:    chalk.hex(ctp.blue),               // keybinds, cursor — Yazi tabs/mode blue
  success:   chalk.hex(ctp.green),              // synced, selected ◉
  warning:   chalk.hex(ctp.yellow),             // never synced, caution
  error:     chalk.hex(ctp.red),                // failed, destructive
  info:      chalk.hex(ctp.teal),               // paths, links, cwd — Yazi cwd teal
  highlight: chalk.hex(ctp.pink),               // services, grok, desc — Yazi pink
  mauve:     chalk.hex(ctp.mauve),              // special emphasis (archives, purple)
  peach:     chalk.hex(ctp.peach),              // Claude orange equivalent
  sky:       chalk.hex(ctp.sky),                // lighter blue accent
  text:      chalk.hex(ctp.text),               // normal body text
  bold:      chalk.bold.hex(ctp.text),           // emphasized text
  muted:     chalk.hex(ctp.overlay1),           // secondary info — Yazi border/perm_sep
  dim:       chalk.hex(ctp.surface2),           // legacy very-faint decorations (prefer border for dividers)
  border:    chalk.hex(ctp.overlay1),           // pane dividers, input separators — medium brightness
  key:       chalk.bold.hex(ctp.teal),           // keybinding labels
  subtext:   chalk.hex(ctp.subtext0),           // less important text
  lavender:  chalk.hex(ctp.lavender),           // soft blue highlights
  // Yazi-style: cursor uses reversed (swap fg/bg), inactive pane uses dim
  cursor:    chalk.bold.inverse,                 // focused cursor row — reversed like Yazi
  cursorAlt: chalk.hex(ctp.overlay1).underline,  // cursor in inactive pane
};

export { ctp };

// Icons via explicit codepoints to avoid encoding loss during file save
export const ICONS = {
  sync:      '\u{F04E6}', // 󰓦
  check:     '\u{F00C0}', // nf-md-check  (fallback to ascii if needed)
  cross:     '\u{F00C1}', // nf-md-close
  warning:   '\u{F0026}', // nf-md-alert
  clock:     '\u{F0150}', // nf-md-clock
  arrow:     '\u{F0054}', // nf-md-arrow_right
  server:    '\u{F048B}', // 󰒋
  service:   '\u{F0868}', // 󰡨
  skill:     '\u{F0C7E}', // nf-md-file_code
  changed:   '\u{F03EB}', // 󰏫
  unchanged: '\u{F012C}', // 󰄬
  delta:     '\u{F0195}', // 󰆕
  lock:      '\u{F033E}', // nf-md-lock
  brain:     '\u{F09D1}', // 󰧑
  db:        '\u{F01BC}', // 󰆼
  hash:      '\u{F0565}', // 󰕥
  tree:      '\u{F0645}', // 󰙅
  diff:      '\u{F0410}', // nf-md-delta
  env:       '\u{F0F5E}', // nf-md-application_variable
  dot:       '\u25CF',    // ●
  folder:    '\u{F024B}', // nf-md-folder
  file:      '\u{F0214}', // nf-md-file
} as const;

// ── Key parsing ──
export interface Key {
  name: string;
  ctrl: boolean;
  shift: boolean;
  alt?: boolean;
  /** meta(⌘/super) 모디파이어 — alt 와 동형 optional. 일부 키 라우터(log-pane
   *  copy-action 등)가 modifier-free 판정에 참조. 미설정이면 undefined. */
  meta?: boolean;
  mouse?: { row: number; col: number; type: 'click' | 'double-click' | 'right-click' | 'scroll-up' | 'scroll-down' | 'drag' | 'release' | 'motion' };
  /** Original stdin bytes that produced this key. Set by splitKeys()
   *  so callers that need to forward the exact sequence (e.g. the
   *  preview terminal's PTY passthrough) can do so without losing
   *  modifier / Kitty-protocol information in the parse/reverse step. */
  raw?: string;
  /** Semantic body of one bracketed paste envelope, without its markers. */
  paste?: string;
  /** Kitty CSI u event type (PR-S1V.4): `1` press · `2` repeat · `3` release.
   *  Only emitted when kitty level `>3u` is active (voice mode). When the
   *  field is undefined it implies a press (legacy callers stay correct).
   *  Dispatchers that only care about presses should ignore non-`press`
   *  events with `if (key.kind && key.kind !== 'press') return;`. */
  kind?: 'press' | 'repeat' | 'release';
}

// ── MD1 — Double-click detector (AppCUI-rs 300ms threshold convention) ──
// SGR 1006 only reports press/release per-event; there is no native
// "double-click" variant in the protocol. We synthesize one by tracking
// the last same-cell primary press timestamp and emitting a
// `double-click` when a second press arrives within DOUBLE_CLICK_MS at
// the exact same (row, col). Widgets receive both the first `click` and
// the follow-up `double-click` — the first is never suppressed so
// select-then-decide UX stays predictable.

interface LastPress { row: number; col: number; at: number }
let lastPrimaryPress: LastPress | null = null;

function doubleClickThresholdMs(): number {
  const raw = process.env.ELANOUS_DOUBLE_CLICK_MS;
  if (!raw) return 300;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 300;
}

/** Test helper — wipe the detector's memory between scenarios. */
export function __resetDoubleClickState(): void {
  lastPrimaryPress = null;
}

// Map keycode → name (shared between CSI u and modifyOtherKeys)
function keycodeToName(code: number): string | undefined {
  switch (code) {
    case 9:  return 'tab';
    case 13: return 'enter';
    case 27: return 'escape';
    case 32: return 'space';
    case 127: return 'backspace';
    default: return undefined;
  }
}

// Decode modifier bitmask (xterm / kitty convention: modifier = bits + 1
// where bit0=shift, bit1=alt, bit2=ctrl). Previously this dropped the
// alt bit entirely, so Alt-modified keys arriving via kitty CSI-u or
// modifyOtherKeys ended up with `alt=undefined` on the Key — invisible
// to downstream routing and to the popup-terminal byte encoder.
function decodeModifier(mod: number): { shift: boolean; ctrl: boolean; alt: boolean } {
  const m = mod - 1;
  return { shift: !!(m & 1), alt: !!(m & 2), ctrl: !!(m & 4) };
}

function parseKey(data: string | Buffer): Key {
  const s = typeof data === 'string' ? data : data.toString();
  const K = (name: string, ctrl = false, shift = false, alt = false): Key => ({ name, ctrl, shift, alt });

  // ── Bracketed paste markers (enabled via ansi.pasteOn / CSI ?2004h) ──
  // Terminal emits CSI 200~ before a paste and CSI 201~ after. textInput
  // catches these to collect the paste as a single unit and tokenize it.
  if (s === '\x1b[200~') return K('paste-start');
  if (s === '\x1b[201~') return K('paste-end');

  // ── Kitty keyboard protocol: CSI codepoint[;modifier[:event_type]] u ──
  // Level 1 (`>1u`): only disambiguate — no `:event_type` segment.
  // Level 3 (`>3u`): adds press/repeat/release events. PR-S1V.4 enters
  // level 3 on voice-mode entry and restores level 1 on exit; the
  // `:event_type` segment is only present for releases/repeats since
  // level-3 terminals omit it for the implicit `1` (press).
  const csiU = s.match(/^\x1b\[(\d+)(?:;(\d+)(?::(\d+))?)?u/);
  if (csiU) {
    const code = parseInt(csiU[1]!);
    const mod = csiU[2] ? parseInt(csiU[2]!) : 1;
    const eventType = csiU[3] ? parseInt(csiU[3]!) : 1;
    const { shift, alt, ctrl } = decodeModifier(mod);
    const name = keycodeToName(code);
    const kind: 'press' | 'repeat' | 'release' =
      eventType === 3 ? 'release' : eventType === 2 ? 'repeat' : 'press';
    const out: Key = name
      ? K(name, ctrl, shift, alt)
      : code >= 32
        ? K(String.fromCodePoint(code), ctrl, shift, alt)
        : K('', ctrl, shift, alt);
    // Only annotate non-press events so legacy paths see `kind === undefined`
    // and stay correct (the key is still treated as a press via fall-through).
    if (kind !== 'press') out.kind = kind;
    return out;
  }

  // ── xterm modifyOtherKeys: CSI 27;modifier;keycode ~ ──
  const modKeys = s.match(/^\x1b\[27;(\d+);(\d+)~/);
  if (modKeys) {
    const mod = parseInt(modKeys[1]!);
    const code = parseInt(modKeys[2]!);
    const { shift, alt, ctrl } = decodeModifier(mod);
    const name = keycodeToName(code);
    if (name) return K(name, ctrl, shift, alt);
    if (code >= 32) return K(String.fromCodePoint(code), ctrl, shift, alt);
    return K('', ctrl, shift, alt);
  }

  // xterm modified arrows (including legacy Shift+arrow)
  const arrowMod = s.match(/^\x1b\[1;(\d+)([ABCD])$/);
  if (arrowMod) {
    const { shift, alt, ctrl } = decodeModifier(parseInt(arrowMod[1]!, 10));
    const name = { A: 'up', B: 'down', C: 'right', D: 'left' }[arrowMod[2]! as 'A' | 'B' | 'C' | 'D'];
    return K(name, ctrl, shift, alt);
  }
  if (s === '\x1bOM')     return K('enter', false, true); // legacy Shift+Enter (SS3)
  if (s === '\x1b\r' || s === '\x1b\n') return K('enter', false, true); // ESC+CR = Shift/Alt+Enter
  if (s === '\x1b[Z')     return K('tab', false, true);   // Shift+Tab (backtab)

  // Modified function keys: CSI <code>;<modifier>~
  // modifier bitmask per xterm: mod-1 bits → 1=shift 2=alt 4=ctrl.
  // Codes: 1,7=Home  2=Insert  3=Delete  4,8=End  5=PgUp  6=PgDn.
  const funcMod = s.match(/^\x1b\[(\d+);(\d+)~$/);
  if (funcMod) {
    const code = parseInt(funcMod[1]!, 10);
    const { shift, alt, ctrl } = decodeModifier(parseInt(funcMod[2]!, 10));
    const map: Record<number, string> = {
      1: 'home', 7: 'home',
      4: 'end',  8: 'end',
      5: 'pageup',
      6: 'pagedown',
      2: 'insert',
      3: 'delete',
    };
    const name = map[code];
    if (name) return K(name, ctrl, shift, alt);
  }

  // ── Alt-as-ESC-prefix (legacy / ghostty `macos-option-as-alt`) ──
  // ghostty in alt-esc-prefix mode (default macOS layout, or with
  // `macos-option-as-alt = left|right|true`) emits Alt+<char> as a
  // 2-byte ESC+<char> sequence (see ghostty src/input/key_encode.zig
  // legacyAltPrefix). splitKeys() above bundles ESC + next-char into
  // one slice when the next byte isn't `[` or `O`, so by the time we
  // reach here a 2-char `\x1b<printable>` is guaranteed to be Alt+char.
  // Reject control bytes (\x1b\x01 etc — would be Ctrl+Alt+letter
  // which ghostty encodes via CSI-u, not legacy prefix), and the
  // already-handled \x1b\r / \x1b\n / \x1b[ / \x1bO cases.
  if (s.length === 2 && s[0] === '\x1b') {
    const ch = s[1]!;
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f) {
      if (ch === ' ') return K('space', false, false, true);
      // Uppercase letter → name is lowercased, shift bit set.
      if (code >= 0x41 && code <= 0x5a) {
        return K(ch.toLowerCase(), false, true, true);
      }
      // Lowercase letter / digit / symbol — literal name, no shift.
      return K(ch, false, false, true);
    }
  }

  // Arrow / nav keys
  if (s === '\x1b[A' || s === '\x1bOA') return K('up');
  if (s === '\x1b[B' || s === '\x1bOB') return K('down');
  if (s === '\x1b[C' || s === '\x1bOC') return K('right');
  if (s === '\x1b[D' || s === '\x1bOD') return K('left');
  if (s === '\x1b[H' || s === '\x1b[1~') return K('home');
  if (s === '\x1b[F' || s === '\x1b[4~') return K('end');
  if (s === '\x1b[5~') return K('pageup');
  if (s === '\x1b[6~') return K('pagedown');
  if (s === '\x1b[3~') return K('delete');

  // Special keys
  if (s === '\r' || s === '\n')   return K('enter');
  if (s === ' ')                  return K('space');
  if (s === '\x1b')               return K('escape');
  if (s === '\t')                 return K('tab');
  if (s === '\x7f' || s === '\b') return K('backspace');

  // Ctrl+key
  if (s.length === 1 && s.charCodeAt(0) === 3) return K('c', true);
  if (s.length === 1 && s.charCodeAt(0) === 0x1f) return K('/', true); // Ctrl+/ → \x1f
  // Ctrl+digit normalization for the few digits that yield clean
  // control chars on a bare xterm. Kitty / modifyOtherKeys paths
  // already produce `K('<digit>', ctrl=true)` higher up; this is the
  // fallback for plain terminals. Ctrl+1 has no distinct wire form;
  // Ctrl+3 collides with Escape — so those must come via modKeys.
  if (s === '\x00')  return K('2', true); // Ctrl+2 → NUL
  if (s === '\x1c')  return K('4', true); // Ctrl+4 → FS
  if (s === '\x1d')  return K('5', true); // Ctrl+5 → GS
  if (s.length === 1 && s.charCodeAt(0) < 32) {
    return K(String.fromCharCode(s.charCodeAt(0) + 96), true);
  }

  // SGR mouse: \x1b[<button;col;rowM (press) or \x1b[<button;col;rowm (release)
  const mouseMatch = s.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
  if (mouseMatch) {
    const btn = parseInt(mouseMatch[1]!);
    const col = parseInt(mouseMatch[2]!);
    const row = parseInt(mouseMatch[3]!);
    const pressed = mouseMatch[4] === 'M';
    // SGR button encoding: bits 0-1 = button, bit 2 = shift, bit 3 = meta, bit 4 = ctrl, bit 5 = motion
    const hasShift = !!(btn & 4);
    const hasAlt = !!(btn & 8);
    const hasCtrl = !!(btn & 16);
    const baseBtn = btn & ~(4 | 8 | 16); // strip modifier bits
    if (baseBtn === 0 && pressed) {
      const now = Date.now();
      const thr = doubleClickThresholdMs();
      const isDbl =
        lastPrimaryPress !== null
        && now - lastPrimaryPress.at <= thr
        && lastPrimaryPress.row === row
        && lastPrimaryPress.col === col;
      if (isDbl) {
        // Consume the pair so a third quick press does NOT cascade into
        // another double. Triple-click is explicitly out of scope.
        lastPrimaryPress = null;
        return { name: 'mouse', ctrl: hasCtrl, shift: hasShift, alt: hasAlt, mouse: { row, col, type: 'double-click' } };
      }
      lastPrimaryPress = { row, col, at: now };
      return { name: 'mouse', ctrl: hasCtrl, shift: hasShift, alt: hasAlt, mouse: { row, col, type: 'click' } };
    }
    if (baseBtn === 0 && !pressed) return { name: 'mouse', ctrl: hasCtrl, shift: hasShift, alt: hasAlt, mouse: { row, col, type: 'release' } };
    if (baseBtn === 2 && pressed)  return { name: 'mouse', ctrl: hasCtrl, shift: hasShift, alt: hasAlt, mouse: { row, col, type: 'right-click' } };
    if (baseBtn === 32 && pressed) return { name: 'mouse', ctrl: hasCtrl, shift: hasShift, alt: hasAlt, mouse: { row, col, type: 'drag' } };
    // IDX-5 — SGR any-event motion (1003 mode). btn 35 = motion bit (32) |
    // button-3 (no-button) = 35. Requires ELANOUS_MOUSE_HOVER=1; terminals
    // that don't know 1003 never emit this code so the branch is a no-op
    // for the default 1002 pipeline.
    if (baseBtn === 35 && pressed) return { name: 'mouse', ctrl: hasCtrl, shift: hasShift, alt: hasAlt, mouse: { row, col, type: 'motion' } };
    if (baseBtn === 64 && pressed) return { name: 'mouse', ctrl: hasCtrl, shift: hasShift, alt: hasAlt, mouse: { row, col, type: 'scroll-up' } };
    if (baseBtn === 65 && pressed) return { name: 'mouse', ctrl: hasCtrl, shift: hasShift, alt: hasAlt, mouse: { row, col, type: 'scroll-down' } };
    // Ignore other events
    return K('');
  }

  // ── Korean jamo → English key mapping ──
  // When Korean IME is active in raw mode, keystrokes arrive as
  // Hangul Compatibility Jamo (U+3131–U+3163). Map them to the
  // English key on the same physical position so hotkeys work
  // regardless of IME state.
  const KOREAN_TO_EN: Record<string, string> = {
    'ㅂ': 'q', 'ㅈ': 'w', 'ㄷ': 'e', 'ㄱ': 'r', 'ㅅ': 't',
    'ㅛ': 'y', 'ㅕ': 'u', 'ㅑ': 'i', 'ㅐ': 'o', 'ㅔ': 'p',
    'ㅁ': 'a', 'ㄴ': 's', 'ㅇ': 'd', 'ㄹ': 'f', 'ㅎ': 'g',
    'ㅗ': 'h', 'ㅓ': 'j', 'ㅏ': 'k', 'ㅣ': 'l',
    'ㅋ': 'z', 'ㅌ': 'x', 'ㅊ': 'c', 'ㅍ': 'v', 'ㅠ': 'b',
    'ㅜ': 'n', 'ㅡ': 'm',
    // Shifted
    'ㅃ': 'Q', 'ㅉ': 'W', 'ㄸ': 'E', 'ㄲ': 'R', 'ㅆ': 'T',
  };
  if (s.length === 1 || (s.length <= 3 && [...s].length === 1)) {
    const ch = [...s][0]!;
    const mapped = KOREAN_TO_EN[ch];
    if (mapped) {
      const isUpper = mapped !== mapped.toLowerCase();
      return K(isUpper ? mapped.toLowerCase() : mapped, false, isUpper);
    }
  }

  // Regular text (including multi-byte: Korean, CJK, emoji)
  return K(s);
}

function trailingUtf8Carry(data: Buffer): Buffer {
  let continuations = 0;
  for (let index = data.length - 1; index >= 0 && continuations < 3; index -= 1) {
    const byte = data[index]!;
    if ((byte & 0xC0) === 0x80) {
      continuations += 1;
      continue;
    }
    const width = byte >= 0xC0 && byte <= 0xDF ? 2
      : byte >= 0xE0 && byte <= 0xEF ? 3
        : byte >= 0xF0 && byte <= 0xF7 ? 4
          : 0;
    return width > continuations + 1 ? data.subarray(index) : Buffer.alloc(0);
  }
  return Buffer.alloc(0);
}

// ── TUI lifecycle ──
let _raw = false;
let _alt = false;
let _cancelReadKey: (() => void) | undefined;

function cleanup(): void {
  resetRenderCache();
  _cancelReadKey?.();
  resetInputState();
  if (_raw || _alt) process.stdout.write(ansi.mouseOff + ansi.kittyKbOff + ansi.modKeysOff + ansi.pasteOff);
  if (_alt) { process.stdout.write(ansi.showCursor + ansi.altOff); _alt = false; }
  if (_raw && process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    _raw = false;
  }
}

/**
 * ⭐⭐⭐ 종료 «알림» 훅 (2026-08-19 · 대표 지시 · 로드맵 `N1`).
 *
 * 🚨 왜 훅인가 — 실측: 나가는 길이 «일곱»인데 ***`Ctrl+C` 와 `SIGINT`/`SIGTERM` 은
 *   세션 안내를 «못 받았다»***(다섯만 받았다). 그 둘이 여기 있다.
 * ⛔ 그런데 이 모듈은 «저수준»이라 대시보드(`graceful-quit`)를 import 하면 «순환»한다.
 *   ⇒ 그래서 대시보드가 «등록»하고 여기서는 «부르기만» 한다.
 * ⛔ 알림이 실패해도 종료를 막지 않는다 — 종료는 언제나 끝까지 간다.
 * ⚠️ `cleanup()` «뒤»에 부른다: alt-screen 이 복원돼야 그 안내가 사용자 터미널에 «남는다».
 */
let _exitNotice: (() => void) | null = null;
export function setExitNotice(fn: (() => void) | null): void { _exitNotice = fn; }
function runExitNotice(): void {
  const fn = _exitNotice;
  _exitNotice = null;   // 두 번 찍지 않는다(SIGINT → exit 로 핸들러가 두 번 돈다)
  try { fn?.(); } catch { /* 알림 실패가 종료를 막지 않는다 */ }
}

let _exitHandlersRegistered = false;
function registerExitHandlers(): void {
  if (_exitHandlersRegistered) return;
  _exitHandlersRegistered = true;
  process.on('exit', cleanup);
  process.on('SIGINT',  () => { cleanup(); runExitNotice(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); runExitNotice(); process.exit(143); });
}

export function initTui(altScreen = true): void {
  if (!process.stdin.isTTY) return;
  registerExitHandlers();
  resetRenderCache();
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8'); // decode UTF-8 for CJK/IME support
  process.stdin.resume();
  _raw = true;
  // Enable mouse + paste globally. Kitty keyboard protocol + xterm
  // modifyOtherKeys are ALSO enabled dashboard-wide so Ctrl+M / Ctrl+J /
  // Ctrl+I / Ctrl+H can be distinguished from Enter / Tab / Backspace
  // (which share byte values with them: 0x0D / 0x0A / 0x09 / 0x08).
  // Without these protocols, `Ctrl+M` collides with Enter on every
  // terminal — pane-toggle chord silently fails. Protocol enablement
  // is additive: unsupported terminals ignore the CSI sequence, so
  // this is safe to turn on globally. Cleanup in `cleanup()` writes
  // the matching "off" sequences.
  process.stdout.write(ansi.mouseOn + ansi.pasteOn + ansi.kittyKbOn + ansi.modKeysOn);
  if (altScreen) {
    process.stdout.write(ansi.altOn + ansi.hideCursor);
    _alt = true;
  } else {
    process.stdout.write(ansi.hideCursor);
  }
}

export function closeTui(): void {
  cleanup();
}

// Buffer for keys that arrived in the same stdin chunk
const _keyQueue: Key[] = [];

/**
 * Origin label for a traced key — lets the dashboard distinguish keys
 * delivered through the main readKey loop, the streaming-window listener,
 * and the input-mode readKey loop. `source` is selected by the owning
 * entry point so log analysis can filter the three lifecycles.
 */
export type KeyTraceSource = 'main' | 'stream' | 'input';

let _keyTracer: ((key: Key, source: KeyTraceSource) => void) | null = null;

/** Install a tracer invoked with every dispatched Key. Set to null to
 *  detach. Exceptions thrown by the tracer are swallowed so a broken
 *  tracer never blocks the input pipeline. */
export function setKeyTracer(fn: ((key: Key, source: KeyTraceSource) => void) | null): void {
  _keyTracer = fn;
}

/** Call the installed tracer, if any. Safe to invoke unconditionally —
 *  becomes a noop when no tracer is registered. */
export function traceKey(key: Key, source: KeyTraceSource): void {
  if (!_keyTracer) return;
  try { _keyTracer(key, source); } catch { /* swallow — never break input */ }
}

/** Trace an input-listener lifecycle transition through the existing key
 * tracer. The synthetic key keeps the established key.press category and
 * source labels while exposing whether stdin was flowing at the transition. */
export function traceKeyListener(event: 'attach' | 'detach', source: KeyTraceSource): void {
  if (!_keyTracer || !debug.isKeyTraceEnabled()) return;
  const flow = process.stdin.readableFlowing === true ? 'flowing' : 'paused';
  traceKey({ name: `listener-${event}-${flow}`, ctrl: false, shift: false }, source);
}

// ── Frame observer (self-observation capture · PLAN P1b) ──
// The lowest-layer seam for self-report: render() feeds every composed
// full-screen frame here. Off by default (null); the TUI self-report
// wiring registers it. Mirrors setKeyTracer — one optional callback,
// try/catch guarded so a buggy observer can NEVER break rendering.
type FrameObserver = (lines: readonly string[], dims: { rows: number; cols: number }) => void;
let _frameObserver: FrameObserver | null = null;
export function setFrameObserver(fn: FrameObserver | null): void {
  _frameObserver = fn;
}

/**
 * Split a raw stdin chunk into discrete parsed Key events. Shared
 * between readKey() and attachStreamingKeys() so both entry points
 * agree on multi-event boundaries (e.g. ESC [ A, UTF-8 surrogate
 * pairs, bracketed paste markers).
 */
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
/** 한 붙여넣기 봉투의 최대 크기. ⛔ 이 상한이 없으면 **끝 표식이 안 오는 스트림**(터미널 버그·
 *  잘린 연결·악의)에서 `pasteBody` 가 무한히 자라고, 그 동안 TUI 는 **모든 입력을 삼킨 채** 응답하지
 *  않는다(붙여넣기 모드에서 영영 못 나온다). ⇒ 상한을 넘으면 **모은 것을 그대로 내보내고 모드를 빠져나간다**
 *  — 잘라서 버리는 것보다 사용자가 본 것을 주는 쪽이 낫고, 입력이 다시 흐른다.
 *  ⭐ 값의 출처: `#5865`(같은 결함을 다른 구현으로 다룬 PR)가 정한 1MiB 를 그대로 쓴다(재발명 0). */
const PASTE_MAX_BYTES = 1024 * 1024;

export class KeyStreamParser {
  private pending = '';
  private pasting = false;
  private pasteBody = '';
  /** `pasteBody` 의 **누적 바이트 수**. ⛔ 매 청크마다 `Buffer.byteLength(pasteBody)` 를 다시 재면
   *  작은 청크가 많이 올 때 **O(n²)** 가 되어 CPU 를 태운다(리뷰 must-fix). ⇒ 더할 때만 누적한다. */
  private pasteBodyBytes = 0;
  private readonly decoder = new StringDecoder('utf8');
  private decoderCarry: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private decoderHasPendingBytes = false;

  /** 붙여넣기 본문에 이어 붙인다. **상한을 넘으면 상한까지만 담고 봉투를 닫은 뒤 `true`** 를 준다.
   *  ⛔⭐ 세 가지를 한 곳에서 지킨다(리뷰 must-fix ×3) —
   *   ① **두 경로 모두**(끝 표식이 같은 청크에 있든 없든) 같은 상한을 거친다.
   *   ② **바이트로 자른다** — `Buffer` 로 재고 잘라 다중바이트 본문이 상한을 넘지 않게 한다
   *      (UTF-16 `slice` 로 자르면 한글·이모지 본문이 상한을 크게 넘는다).
   *   ③ **남는 것은 버리지 않고 `pending` 으로 되돌린다** — 그래야 *"모드를 빠져나가 입력이
   *      다시 흐른다"* 가 실제로 성립한다(버리면 그 입력은 영영 사라진다). */
  private appendPasteBody(chunk: string, keys: Key[]): boolean {
    const room = PASTE_MAX_BYTES - this.pasteBodyBytes;
    const chunkBytes = Buffer.byteLength(chunk);
    if (chunkBytes <= room) {
      this.pasteBody += chunk;
      this.pasteBodyBytes += chunkBytes;
      return false;
    }
    const buf = Buffer.from(chunk, 'utf8');
    // ⚠️ 바이트 경계가 문자 중간을 자를 수 있다 ⇒ **유효 UTF-8 경계를 직접 계산**한다.
    //    ⛔ 잘라서 디코드한 뒤 `\uFFFD` 를 지우는 방식은 쓰지 않는다(리뷰 must-fix) —
    //      **본문에 원래 있던 U+FFFD** 까지 지워 그 문자를 붙여넣기 밖으로 밀어낸다.
    //    ⭐ UTF-8 연속 바이트는 `10xxxxxx`(0x80~0xBF)다. 그 바이트에서 시작하면 문자 중간이므로
    //      선두 바이트를 만날 때까지 뒤로 물러난다(최대 3바이트).
    let cut = Math.max(room, 0);
    while (cut > 0 && (buf[cut]! & 0xC0) === 0x80) cut -= 1;
    const head = buf.subarray(0, cut).toString('utf8');
    this.pasteBody += head;
    this.pasteBodyBytes += cut;
    this.pending = chunk.slice(head.length) + this.pending;
    keys.push(this.closePaste(this.pasteBody));
    return true;
  }

  /** 붙여넣기 봉투를 닫고 키 하나로 만든다 — **정상 종료와 상한 초과가 같은 형태**로 나가야
   *  소비자가 두 경로를 다르게 다루지 않는다(상한 초과도 사용자에겐 "붙여넣기"다). */
  private closePaste(paste: string): Key {
    this.pasteBody = '';
    this.pasteBodyBytes = 0;
    this.pasting = false;
    return {
      name: 'paste',
      ctrl: false,
      shift: false,
      raw: BRACKETED_PASTE_START + paste + BRACKETED_PASTE_END,
      paste: paste.replace(/\r\n?|\n/g, '\n'),
    };
  }

  push(data: string | Buffer): Key[] {
    const keys: Key[] = [];
    if (typeof data === 'string') {
      this.pending += data;
    } else {
      const decoded = this.decoder.write(data);
      if (data.length > 0) {
        const input = Buffer.concat([this.decoderCarry, data]);
        this.decoderCarry = trailingUtf8Carry(input);
        this.decoderHasPendingBytes = this.decoderCarry.length > 0;
      }
      this.pending += decoded;
    }

    while (this.pending.length > 0) {
      if (this.pasting) {
        const end = this.pending.indexOf(BRACKETED_PASTE_END);
        if (end < 0) {
          let suffixLength = 0;
          for (let length = Math.min(BRACKETED_PASTE_END.length - 1, this.pending.length); length > 0; length--) {
            if (this.pending.endsWith(BRACKETED_PASTE_END.slice(0, length))) {
              suffixLength = length;
              break;
            }
          }
          const carried = this.pending.slice(0, this.pending.length - suffixLength);
          this.pending = this.pending.slice(this.pending.length - suffixLength);
          if (this.appendPasteBody(carried, keys)) continue;   // 상한 초과 ⇒ 봉투를 닫고 나머지는 pending 에 남는다
          break;
        }
        const carried = this.pending.slice(0, end);
        this.pending = this.pending.slice(end + BRACKETED_PASTE_END.length);
        if (this.appendPasteBody(carried, keys)) continue;     // 상한 초과면 여기서 이미 닫혔다
        keys.push(this.closePaste(this.pasteBody));
        continue;
      }

      if (this.pending.startsWith(BRACKETED_PASTE_START)) {
        this.pending = this.pending.slice(BRACKETED_PASTE_START.length);
        this.pasting = true;
        continue;
      }

      const slice = this.nextSlice();
      if (slice === null) break;
      this.pending = this.pending.slice(slice.length);
      const key = parseKey(slice);
      key.raw = slice;
      keys.push(key);
    }

    return keys;
  }

  flush(): Key[] {
    this.pending += this.decoder.end();
    this.decoderCarry = Buffer.alloc(0);
    this.decoderHasPendingBytes = false;
    if (this.pasting || !this.pending) return [];
    if (this.pending === '\x1b') {
      this.pending = '';
      return [{ name: 'escape', ctrl: false, shift: false, raw: '\x1b' }];
    }
    return this.push('');
  }

  flushEscape(): Key[] {
    // ⛔⭐ **붙여넣기 중에는 절대 방출하지 않는다**(리뷰 must-fix · 2026-07-30) —
    //    봉투 안에서 청크가 `…\x1b` 로 끝나면 그 ESC 는 **끝 표식 `\x1b[201~` 의 앞 한 글자**다.
    //    25ms 조용창 flush 가 그것을 Escape 키로 **소비**하면 종료 표식이 깨지고 붙여넣기가
    //    영영 안 닫힌다(그 뒤 입력이 전부 본문으로 삼켜진다). `flush()` 는 이미 이 가드를 갖고 있었다.
    if (this.pasting) return [];
    if (this.pending !== '\x1b') return [];
    this.pending = '';
    return [{ name: 'escape', ctrl: false, shift: false, raw: '\x1b' }];
  }

  /** True while the parser holds an incomplete escape sequence — a lone
   *  ESC awaiting either a quiet-window flush (→ Escape) or a following
   *  byte (→ Alt combo / CSI), or a CSI/SS3 split across stdin chunks.
   *  `readKey` uses this to decide whether to keep waiting instead of
   *  resolving with an empty key (which would swallow the ESC and let the
   *  next byte mis-combine into a phantom Alt chord). */
  hasPendingEscape(): boolean {
    return this.pending.length > 0 && this.pending[0] === '\x1b';
  }

  /** True while a bracketed-paste envelope is open — body bytes have arrived
   *  but the end marker has not. ⛔ Callers that detach on "no keys yet" MUST
   *  check this: a paste body produces **zero keys per chunk**, so a reader that
   *  resolves empty and re-attaches can lose the next chunk in the gap
   *  (리뷰 must-fix · 2026-07-30). `hasPendingEscape()` does not cover this —
   *  mid-body `pending` is usually empty, and the envelope state lives in
   *  `pasting`, not in `pending`. */
  hasPendingPaste(): boolean {
    return this.pasting;
  }

  /** True while StringDecoder has retained an incomplete UTF-8 sequence. */
  hasPendingDecoderBytes(): boolean {
    return this.decoderHasPendingBytes;
  }

  /** Discard incomplete stream state when its owner is torn down. */
  reset(): void {
    this.pending = '';
    this.pasting = false;
    this.pasteBody = '';
    this.pasteBodyBytes = 0;
    this.decoder.end();
    this.decoderCarry = Buffer.alloc(0);
    this.decoderHasPendingBytes = false;
  }

  private nextSlice(): string | null {
    if (this.pending[0] !== '\x1b') {
      const cp = this.pending.codePointAt(0)!;
      return this.pending.slice(0, cp > 0xFFFF ? 2 : 1);
    }
    if (this.pending.length === 1) return null;
    if (this.pending[1] === '\x1b') return '\x1b';
    if (this.pending[1] === '[') {
      for (let end = 2; end < this.pending.length; end++) {
        const code = this.pending.charCodeAt(end);
        if (code >= 0x40 && code <= 0x7E) return this.pending.slice(0, end + 1);
      }
      return null;
    }
    if (this.pending[1] === 'O') return this.pending.length >= 3 ? this.pending.slice(0, 3) : null;
    return this.pending.slice(0, 2);
  }
}

/** The stdin key stream owns ONE parser instance. It is deliberately not
 *  shared with `splitKeys`: that export is a stateless slicer used by other
 *  streams (streaming-key listener, self-report capture, injected test
 *  doubles), and giving them a common pending buffer would let one stream's
 *  half-finished escape sequence surface in another's output. */
const _stdinParser = new KeyStreamParser();

/** Release state owned by the stdin lifecycle; `splitKeys` is intentionally
 *  not involved because it is a stateless export. */
function resetInputState(): void {
  _stdinParser.reset();
  _keyQueue.length = 0;
}

export function splitKeys(data: string | Buffer): Key[] {
  const s = typeof data === 'string' ? data : data.toString();
  const keys: Key[] = [];
  let i = 0;
  while (i < s.length) {
    let slice: string;
    if (s[i] === '\x1b' && i + 1 < s.length) {
      // Find end of escape sequence
      let end = i + 1;
      if (s[end] === '\x1b') {
        slice = '\x1b';
        i++;
        const key = parseKey(slice);
        key.raw = slice;
        keys.push(key);
        continue;
      }
      // CSI sequence: ESC [ ... letter
      if (s[end] === '[') {
        end++;
        while (end < s.length && !(s.charCodeAt(end) >= 0x40 && s.charCodeAt(end) <= 0x7E)) end++;
        if (end < s.length) end++; // include terminator
      } else if (s[end] === 'O') {
        end += 2; // SS3 sequence: ESC O letter
      } else {
        end++; // alt+key: ESC + char
      }
      slice = s.slice(i, end);
      i = end;
    } else {
      // Single character (including multi-byte UTF-8 — already decoded as string)
      const cp = s.codePointAt(i)!;
      const len = cp > 0xFFFF ? 2 : 1;
      slice = s.slice(i, i + len);
      i += len;
    }
    const key = parseKey(slice);
    // Attach the original bytes so forwarders (preview terminal PTY
    // passthrough) can write them verbatim without reverse-encoding
    // from the parsed struct. Safe even for Key fields we fabricate
    // (paste-start/paste-end) — the slice is still what the terminal
    // emitted, which is what downstream consumers expect.
    key.raw = slice;
    keys.push(key);
  }
  return keys;
}

/** Raised when a caller attempts to read terminal input outside raw TUI mode. */
export class InputUnavailableError extends Error {
  constructor() {
    super('Terminal input is unavailable');
    this.name = 'InputUnavailableError';
  }
}

export function readKey(source: KeyTraceSource = 'main'): Promise<Key> {
  return new Promise((resolve, reject) => {
    if (!_raw) { reject(new InputUnavailableError()); return; }

    // Drain buffered keys first (from multi-key stdin chunks OR
    // external `injectKey` pushes — see below).
    if (_keyQueue.length > 0) {
      const k = _keyQueue.shift()!;
      traceKey(k, source);
      resolve(k);
      return;
    }

    let escapeTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const clearEscapeTimer = () => {
      if (escapeTimer) {
        clearTimeout(escapeTimer);
        escapeTimer = undefined;
      }
    };

    const settle = (key: Key) => {
      if (settled) return;
      settled = true;
      if (_cancelReadKey === cancel) _cancelReadKey = undefined;
      clearEscapeTimer();
      process.stdin.removeListener('data', h);
      traceKeyListener('detach', source);
      // Removing a data listener keeps stdin flowing; pause separately so
      // bytes arriving before the next readKey resumes stay buffered.
      process.stdin.pause();
      traceKey(key, source);
      resolve(key);
    };

    const cancel = () => settle({ name: '', ctrl: false, shift: false });
    _cancelReadKey = cancel;

    // Arm a short quiet-window timer that flushes a lone ESC as an
    // Escape key. A single ESC byte cannot be classified on arrival —
    // it is either a standalone Escape or the lead byte of an Alt combo
    // / CSI sequence whose remainder is still in flight. We wait one
    // quiet window; if no further byte lands, the ESC is a real Escape.
    // The parser holds the ESC in `pending` until then, so we must keep
    // the stdin listener attached (never resolve empty) meanwhile —
    // otherwise the ESC is swallowed and the next byte mis-combines into
    // a phantom Alt chord (2026-07-29 regression).
    const armEscapeTimer = () => {
      clearEscapeTimer();
      escapeTimer = setTimeout(() => {
        escapeTimer = undefined;
        if (settled) return;
        const keys = _stdinParser.flushEscape();
        if (keys.length === 0) return;
        const first = keys.shift()!;
        if (keys.length > 0) _keyQueue.push(...keys);
        settle(first);
      }, 25);
    };

    const h = (data: Buffer) => {
      if (settled) return;
      clearEscapeTimer();
      // ⭐ The stdin path feeds the OWNED parser, not the stateless
      // `splitKeys` export — bracketed-paste bodies and CSI sequences
      // split across chunk boundaries need a pending buffer that belongs
      // to this stream alone.
      const keys = _stdinParser.push(data);

      // 2026-04-30 — also drain `_keyQueue` here so an `injectKey`
      // call that happened while `readKey` was already awaiting on
      // stdin gets serviced on this wakeup. The injector emits a
      // dummy `'data'` event with an empty buffer to wake stdin;
      // the parser returns 0 keys for that, but the queued real key
      // is what we want to resolve with.
      if (_keyQueue.length > 0 || keys.length > 0) {
        if (keys.length > 0) _keyQueue.push(...keys);
        settle(_keyQueue.shift()!);
        return;
      }

      // No complete key yet. If the parser is holding an incomplete
      // escape sequence (lone ESC, or a CSI/SS3 split across chunks),
      // stay attached and re-arm the flush timer so a standalone ESC
      // still resolves and a late byte can still complete the sequence.
      // Only resolve empty for a genuine no-op wakeup (e.g. injectKey's
      // dummy empty chunk with nothing queued).
      if (_stdinParser.hasPendingEscape()) {
        armEscapeTimer();
        return;
      }
      // ⛔⭐ 붙여넣기 봉투가 열려 있으면 **떨어지지 않는다**(리뷰 must-fix · 2026-07-30) —
      //    본문 청크는 **키를 0개** 낳으므로, 여기서 빈 키로 resolve 하고 리스너를 떼면
      //    재부착 전에 도착한 **다음 본문 청크를 통째로 잃는다**(붙여넣기가 잘린다).
      //    ⚠️ `hasPendingEscape()` 로는 안 걸린다 — 본문 중간엔 `pending` 이 대개 비어 있고
      //      봉투 상태는 `pasting` 에 있다.
      if (_stdinParser.hasPendingPaste() || _stdinParser.hasPendingDecoderBytes()) return;
      settle({ name: '', ctrl: false, shift: false });
    };
    process.stdin.on('data', h);
    traceKeyListener('attach', source);
    process.stdin.resume();
    armEscapeTimer();
  });
}

/** External key injection — push a synthetic key into the readKey
 *  queue. Wakes any in-flight `readKey` by emitting a dummy stdin
 *  `'data'` event so the awaiting handler drains the queue. Used
 *  by voice-chat's multi-turn auto-submit path to simulate the
 *  user pressing Enter after a transcript lands in the input buffer
 *  (mirrors what a typed Enter would do without coupling voice to
 *  textInput's internal closure).
 *
 *  No-op outside raw TUI mode (`_raw === false`).
 *
 *  Reference: BACKLOG-voice-chat-multi-turn-plain-dispatch-extract
 *  §8.6 — "(A) auto-Enter via injectKey" approach. */
export function injectKey(key: Key): boolean {
  if (!_raw) return false;
  _keyQueue.push(key);
  // Wake any in-flight readKey awaiting on stdin by emitting an empty
  // chunk. The handler's queue-drain branch picks up the injected key
  // immediately.
  if (process.stdin.listenerCount('data') > 0) {
    process.stdin.emit('data', Buffer.from(''));
  }
  return true;
}

export function termSize(): { rows: number; cols: number } {
  return { rows: process.stdout.rows || 24, cols: process.stdout.columns || 80 };
}

export interface RenderOptions {
  /** Absolute-positioned draw commands emitted after changed base rows.
  *  Used for modal overlays so the whole frame flushes as one write. */
  overlay?: string;
  /** Drop the cached frame and repaint every row. Use after resize or
  *  when an overlay closes and the covered rows must be restored. */
  force?: boolean;
  /** Physical cursor ANSI emitted after overlays as the last bytes of the frame. */
  cursor?: string;
}

let _lastFrameLines: string[] = [];
let _lastFrameRows = 0;
let _lastFrameCols = 0;

export function resetRenderCache(): void {
  _lastFrameLines = [];
  _lastFrameRows = 0;
  _lastFrameCols = 0;
}

/** Invalidate a specific row in the frame cache without nuking the
 *  whole thing. Callers that do direct stdout writes to a narrow
 *  band (input prompt, cursor moves) use this instead of
 *  resetRenderCache — the next render() pass re-emits only the
 *  touched rows plus whatever genuinely changed elsewhere, so we
 *  avoid re-painting the entire screen just because the input line
 *  redrew itself.
 *  `row` is 0-based. Out-of-range values no-op. */
export function invalidateRenderCacheRow(row: number): void {
  if (row < 0 || row >= _lastFrameLines.length) return;
  // Stash a sentinel that can NEVER match a real rendered row (ANSI
  // strings never contain a raw 0x00). The render-loop diff then
  // treats this row as dirty on the next tick.
  _lastFrameLines[row] = '\x00dirty';
}

/** Invalidate every row at or below the given 0-based row. For
 *  callers that paint the input zone + anything under it. Same
 *  sentinel semantics as invalidateRenderCacheRow. */
export function invalidateRenderCacheFromRow(row: number): void {
  for (let i = Math.max(0, row); i < _lastFrameLines.length; i++) {
    _lastFrameLines[i] = '\x00dirty';
  }
}

export function render(lines: string[], opts: RenderOptions = {}): void {
  perf.markDrawStart();
  const { rows, cols } = termSize();
  const resized = rows !== _lastFrameRows || cols !== _lastFrameCols;
  const force = opts.force || resized || _lastFrameLines.length === 0;
  const maxRows = Math.max(0, rows);
  const lineCount = Math.min(lines.length, maxRows);
  const dirtyRows = Math.max(lineCount, Math.min(_lastFrameLines.length, maxRows));

  let buf = force ? (ansi.hideCursor + ansi.moveTo(1, 1) + ansi.eraseDown) : ansi.hideCursor;
  for (let i = 0; i < dirtyRows; i++) {
    const next = i < lineCount ? lines[i]! : '';
    const prev = _lastFrameLines[i] ?? '';
    if (force || next !== prev) {
      // Clear only rows that changed. tmux shows full-screen erase/repaint
      // as visible flicker, so keep unchanged rows resident.
      buf += ansi.moveTo(i + 1, 1) + ansi.clearLine + next;
    }
  }
  if (opts.overlay) buf += opts.overlay;
  if (opts.cursor) buf += opts.cursor;
  process.stdout.write(buf);
  perf.recordStdoutWrite(buf.length, true);
  perf.markDrawEnd();

  _lastFrameLines = lines.slice(0, lineCount);
  _lastFrameRows = rows;
  _lastFrameCols = cols;

  // Self-observation seam (P1b) — feed the full composed frame to the
  // observer (if any). Guarded: observation must never break the draw.
  // `_lastFrameLines` is mutable + replaced (not mutated in place) on the
  // next render, so a synchronous consumer (the current self-report just
  // join()s it) is safe. An async consumer MUST copy — it receives
  // `readonly string[]` as a reminder, but must not retain the reference.
  if (_frameObserver) {
    try { _frameObserver(_lastFrameLines, { rows, cols }); } catch { /* swallow */ }
  }
}

// ── Utility ──

/** Strip ANSI escape codes from a string */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Calculate visible terminal width of a string.
 * Handles ANSI codes (0 width), CJK / fullwidth chars (2 width),
 * Nerd Font PUA glyphs (2 width), and — via `Bun.stringWidth` when
 * available — emoji ZWJ sequences, combining marks, and flag
 * sequences (all grapheme-aware).
 *
 * Port notes: claude-code-fork's `ink/stringWidth.ts` uses
 * `Bun.stringWidth` as the preferred path and falls back to a
 * grapheme segmenter + east-asian-width table. We use the same
 * preference but the fallback keeps our existing Nerd-Font PUA
 * handling since codex / claude-code don't need it.
 */
export function visibleWidth(s: string): number {
  const plain = stripAnsi(s);

  // Bun runtime — Unicode-correct grapheme width including emoji
  // ZWJ, combining marks, and flag sequences. This is the hot path
  // under monad-agent's normal runtime.
  if (typeof Bun !== 'undefined' && typeof Bun.stringWidth === 'function') {
    const w = Bun.stringWidth(plain);
    // Bun.stringWidth does not know about Nerd Font PUA (E000-F8FF
    // etc.) which our theme assumes are double-width. Add the PUA
    // correction on top.
    return w + nerdFontPuaExtra(plain);
  }

  // Legacy fallback (non-Bun runtime — tests, sandboxed embedding):
  // original monad-agent behaviour, code-point oriented. Misses emoji
  // ZWJ and combining marks but matches what pre-Phase 3 did.
  let w = 0;
  for (let i = 0; i < plain.length; i++) {
    const cp = plain.codePointAt(i)!;
    if (cp > 0xFFFF) { i++; } // skip surrogate pair low half
    if (isWide(cp)) { w += 2; }
    else { w += 1; }
  }
  return w;
}

/** Count the extra columns Nerd Font PUA glyphs add on top of what
 *  `Bun.stringWidth` reports (it reports them as 1 — correct per
 *  Unicode, but our Nerd Font theme actually renders them double-
 *  wide). */
function nerdFontPuaExtra(s: string): number {
  let extra = 0;
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i)!;
    if (cp > 0xFFFF) { i++; }
    if (isNerdFontPua(cp)) extra++;
  }
  return extra;
}

function isNerdFontPua(cp: number): boolean {
  if (cp >= 0xE000  && cp <= 0xF8FF)  return true;   // BMP PUA
  if (cp >= 0xF0000 && cp <= 0xFFFFF) return true;   // Supplementary PUA-A (Nerd Font v3)
  if (cp >= 0x100000 && cp <= 0x10FFFF) return true;  // Supplementary PUA-B
  return false;
}

/** Check if a codepoint renders as double-width in terminal */
function isWide(cp: number): boolean {
  // Nerd Font PUA ranges (most are double-width in patched fonts)
  if (cp >= 0xE000  && cp <= 0xF8FF)  return true;   // BMP PUA
  if (cp >= 0xF0000 && cp <= 0xFFFFF) return true;   // Supplementary PUA-A (Nerd Font v3)
  if (cp >= 0x100000 && cp <= 0x10FFFF) return true;  // Supplementary PUA-B
  // CJK / fullwidth
  if (cp >= 0x1100 && cp <= 0x115F) return true;
  if (cp >= 0x2E80 && cp <= 0xA4CF && cp !== 0x303F) return true;
  if (cp >= 0xAC00 && cp <= 0xD7AF) return true;
  if (cp >= 0xF900 && cp <= 0xFAFF) return true;
  if (cp >= 0xFE10 && cp <= 0xFE6F) return true;
  if (cp >= 0xFF01 && cp <= 0xFF60) return true;
  if (cp >= 0xFFE0 && cp <= 0xFFE6) return true;
  if (cp >= 0x20000 && cp <= 0x2FFFD) return true;
  if (cp >= 0x30000 && cp <= 0x3FFFD) return true;
  return false;
}

/** Pad string to exact visible width with spaces */
export function pad(s: string, len: number): string {
  const vw = visibleWidth(s);
  return s + ' '.repeat(Math.max(0, len - vw));
}

/** Truncate string to max visible width. Always appends a full ANSI
 *  reset (`\x1b[0m`) so a cut that lands inside a styled region can't
 *  leak attributes (color, dim, bold) into the rest of the frame. */
export function truncate(s: string, max: number): string {
  if (visibleWidth(s) <= max) return s + '\x1b[0m';
  let w = 0;
  let cutIdx = 0;
  let inEsc = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\x1b') { inEsc = true; continue; }
    if (inEsc) { if (s[i] === 'm') inEsc = false; continue; }
    const cp = s.codePointAt(i)!;
    const cw = isWide(cp) ? 2 : 1;
    if (cp > 0xFFFF) i++; // surrogate pair
    if (w + cw >= max) { cutIdx = i; break; }
    w += cw;
    cutIdx = i + 1;
  }
  return s.slice(0, cutIdx) + '…' + '\x1b[0m';
}

export interface WrapSegment {
  text: string;
  kind?: string;
}

export interface WrapOpts {
  cols: number;
  mode?: 'soft' | 'block-aware';
  tablePolicy?: 'overflow' | 'wrap';
  segments?: ReadonlyArray<WrapSegment>;
}

function ansiSgrIsReset(seq: string): boolean {
  return seq === '\x1b[m' || seq === '\x1b[0m';
}

function graphemeSegments(s: string): string[] {
  const SegmenterCtor = globalThis.Intl?.Segmenter;
  if (typeof SegmenterCtor === 'function') {
    const seg = new SegmenterCtor(undefined, { granularity: 'grapheme' });
    return Array.from(seg.segment(s), (part) => part.segment);
  }
  return Array.from(s);
}

/** Soft-wrap text by visible terminal columns while preserving ANSI
 *  SGR sequences and grapheme boundaries. Each returned line is at
 *  most `cols` cells wide. Active SGR state is reset at the end of a
 *  wrapped line and re-opened on the next line so styles survive
 *  across wraps without leaking into adjacent frame content. */
export function wrapAnsiByWidth(text: string, opts: WrapOpts | number): string[] {
  const resolved: WrapOpts = typeof opts === 'number'
    ? { cols: opts }
    : opts;
  const width = Math.max(1, resolved.cols);
  if (resolved.segments && resolved.segments.length > 0) {
    const lines: string[] = [];
    for (const segment of resolved.segments) {
      const atomic = segment.kind === 'gfm-table' || segment.kind === 'code';
      if (resolved.mode === 'block-aware' && atomic && (resolved.tablePolicy ?? 'overflow') === 'overflow') {
        lines.push(...overflowAnsiBlock(segment.text, width));
        continue;
      }
      lines.push(...softWrapAnsiByWidth(segment.text, width));
    }
    return lines;
  }
  return softWrapAnsiByWidth(text, width);
}

function softWrapAnsiByWidth(text: string, width: number): string[] {
  const lines: string[] = [];
  const ansiRe = /\x1b\[[0-9;]*m/g;

  const pushLine = (line: string, activeSgr: string): void => {
    lines.push(activeSgr ? line + '\x1b[0m' : line);
  };

  for (const rawLine of text.split('\n')) {
    if (rawLine.length === 0) {
      lines.push('');
      continue;
    }
    let current = '';
    let currentWidth = 0;
    let activeSgr = '';
    let idx = 0;
    let match: RegExpExecArray | null;
    ansiRe.lastIndex = 0;

    const appendPlain = (plain: string): void => {
      for (const seg of graphemeSegments(plain)) {
        const segWidth = Math.max(0, visibleWidth(seg));
        if (currentWidth > 0 && currentWidth + segWidth > width) {
          pushLine(current, activeSgr);
          current = activeSgr;
          currentWidth = 0;
        }
        current += seg;
        currentWidth += segWidth;
      }
    };

    while ((match = ansiRe.exec(rawLine)) !== null) {
      if (match.index > idx) appendPlain(rawLine.slice(idx, match.index));
      const seq = match[0];
      current += seq;
      if (ansiSgrIsReset(seq)) activeSgr = '';
      else activeSgr += seq;
      idx = match.index + seq.length;
    }
    if (idx < rawLine.length) appendPlain(rawLine.slice(idx));
    pushLine(current, activeSgr);
  }

  return lines;
}

function overflowAnsiBlock(text: string, width: number): string[] {
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    if (rawLine.length === 0) {
      out.push('');
      continue;
    }
    out.push(visibleWidth(rawLine) <= width ? rawLine : truncate(rawLine, width));
  }
  return out;
}

/** Repeat char to exact width (accounts for wide chars) */
export function repeatToWidth(ch: string, w: number): string {
  const cw = visibleWidth(ch);
  if (cw === 0) return '';
  return ch.repeat(Math.max(0, Math.floor(w / cw)));
}

export function timeSince(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function hLine(w: number, style: 'heavy' | 'light' = 'light'): string {
  const ch = style === 'heavy' ? '━' : '─';
  return C.border(ch.repeat(w));
}

// ── Help overlay ──
export function renderHelp(context: 'dashboard' | 'select-multi' | 'select-single'): string[] {
  const { cols } = termSize();
  const w = Math.min(cols - 4, 64);
  const lines: string[] = [];
  const b = (s: string) => C.dim('\u2502') + '  ' + s;
  const key = (k: string, desc: string) => `  ${C.key(pad(k, 16))} ${C.text(desc)}`;
  const section = (title: string) => {
    lines.push(b(C.dim('\u2500'.repeat(w - 2))));
    lines.push(b(C.bold(title)));
  };

  lines.push('');
  lines.push(C.dim(`  \u256D${'\u2500'.repeat(w)}\u256E`));
  lines.push(b(C.bold('ElanousAgent Keybindings')));

  // ── Browse mode ──
  if (context === 'dashboard') {
    section('Browse \u2014 Navigation');
    lines.push(b(key('j / \u2193',        'Move cursor down')));
    lines.push(b(key('k / \u2191',        'Move cursor up')));
    lines.push(b(key('h / \u2190',        'Focus left pane')));
    lines.push(b(key('l / \u2192 / Enter','Focus right pane')));
    lines.push(b(key('g / Home',          'Jump to top')));
    lines.push(b(key('G / End',           'Jump to bottom')));
    lines.push(b(key('PgUp / PgDn',       'Scroll page')));

    section('Browse \u2014 Focus');
    lines.push(b(key('Tab',               'Next: skills\u2192files\u2192preview\u2192log')));
    lines.push(b(key('Shift+Tab',         'Prev: skills\u2190log\u2190preview\u2190files')));
    lines.push(b(key('`  (backtick)',     'Toggle log pane focus')));
    lines.push(b(key('Esc',               'Back to previous pane')));

    section('Browse \u2014 Preview / Log scroll');
    lines.push(b(key('j/k \u2191\u2193',  'Scroll 1 line (when focused)')));
    lines.push(b(key('Ctrl+D',            'Half page down')));
    lines.push(b(key('Ctrl+U',            'Half page up')));
    lines.push(b(key('Ctrl+L',            'Clear log pane (log focus)')));
    lines.push(b(key('Ctrl+Shift+L',      'Copy entire log pane (global)')));
    lines.push(b(key('Ctrl+O (log focus)','Copy last message to clipboard')));
    lines.push(b(key('Ctrl+Shift+P (log focus)','Open last assistant media preview')));
    lines.push(b(key('y  (log focus)',    'Copy last block to clipboard')));
    lines.push(b(key('Y  (log focus)',    'Copy entire log to clipboard')));
    lines.push(b(key('right-click',       'Copy block under mouse cursor (log)')));

    section('Terminal modal (global)');
    lines.push(b(key('Ctrl+Shift+T',      'Spawn modal terminal (any focus)')));
    lines.push(b(key('Esc / Ctrl+G',      'Close/detach active terminal modal')));
    lines.push(b(key('(shell) exit',      'Auto-closes modal when PTY exits')));
    lines.push(b(key('/term spawn <cmd>', 'Spawn modal terminal running cmd')));
    lines.push(b(key('/term list|attach|detach|kill', 'Session lifecycle')));
    lines.push(b(key('/fullscreen',       'Toggle fullscreen for active modal')));

    section('Views (global)');
    lines.push(b(key('Ctrl+1',            'View 1 — Normal')));
    lines.push(b(key('Ctrl+2',            'View 2 — Obsidian')));
    lines.push(b(key('Ctrl+3',            'View 3 — Skill')));
    lines.push(b(key('Ctrl+4',            'View 4 — Agents')));
    lines.push(b(key('Ctrl+5',            'View 5 — Debug')));
    lines.push(b(key('Ctrl+6',            'View 6 — Scheduler')));
    lines.push(b(key('Ctrl+7 / Ctrl+/ / /view 7',  'View 7 — Widget Playground')));

    section('Browse \u2014 Middle pane modes');
    lines.push(b(key('f',                 'Files (file tree)')));
    lines.push(b(key('i',                 'Inspect (remote check)')));
    lines.push(b(key('H',                 'History (sync log)')));
    lines.push(b(key('t',                 'Status (sync status)')));

    section('Browse \u2014 Actions');
    lines.push(b(key('s',                 'Enter sync mode')));
    lines.push(b(key('/ (slash)',          'Open input (type /cmd or Q&A chat)')));
    lines.push(b(key('  /run-skill NAME',   'Execute a SKILL.md via the selected LLM')));
    lines.push(b(key('  /provider',         'List LLM providers + availability')));
    lines.push(b(key('  /summarize-skill',  'AI summary of the focused skill')));
    lines.push(b(key('  /context',          'List attached files (id/kind/size)')));
    lines.push(b(key('  /context clear',    'Drop all attachments')));
    lines.push(b(key('  /context clear big','Drop attachments over 100KB')));
    lines.push(b(key('  /context drop N',   'Drop attachment #N')));
    lines.push(b(key('  /paste',            'Attach clipboard image (macOS)')));
    lines.push(b(key('  /sync',             'Enter sync mode')));
    lines.push(b(key('  /clear',            'Clear log pane')));
    lines.push(b(key('  /help',             'Show this help')));
    lines.push(b(key('  /quit /q',          'Exit application')));
    lines.push(b(key('  (text)',            'Send to selected LLM')));
    lines.push(b(key('  /path.ext + text',  'Inline attachments (pdf/docx/xlsx/')));
    lines.push(b(key('                 ',   '  md/txt/png/jpg/gif/webp)')));
    lines.push(b(key('q / \u3142',        'Quit (q or \uD55C\uAE00 \u3142)')));

    section('Sync mode \u2014 Selection');
    lines.push(b(key('Space / *',         'Toggle item selection')));
    lines.push(b(key('a',                 'Select / deselect all')));
    lines.push(b(key('Tab',               'Next pane (skills\u2192servers\u2192services)')));
    lines.push(b(key('h / l',             'Move between panes')));

    section('Sync mode \u2014 Mode switch');
    lines.push(b(key('Shift+Tab',         'Cycle mode (Clean\u2192Merge\u2192Smart\u2192Diff)')));
    lines.push(b(key('1 / 2 / 3 / 4',    'Direct mode: Clean/Merge/Smart/Diff')));

    section('Sync mode \u2014 Execute');
    lines.push(b(key('Enter',             'Run sync or diff (based on mode)')));
    lines.push(b(key('Esc',               'Cancel, return to browse')));

    section('Q&A chat input');
    lines.push(b(key('Enter',             'Submit question')));
    lines.push(b(key('Shift+Enter',       'New line')));
    lines.push(b(key('Ctrl+J',            'New line (always works)')));
    lines.push(b(key('\\+Enter',          'New line (backslash escape)')));
    lines.push(b(key('Ctrl+Shift+V',      'Attach clipboard image (macOS) at cursor')));
    lines.push(b(key('Esc',               'Cancel input / abort stream')));

    section('Mouse');
    lines.push(b(key('Click',             'Focus clicked pane')));
    lines.push(b(key('Scroll',            'Scroll focused pane')));
    lines.push(b(key('Shift+drag',        'Native terminal text selection (copy)')));
  } else if (context === 'select-multi') {
    section('Multi-select');
    lines.push(b(key('j/k \u2191\u2193',  'Navigate')));
    lines.push(b(key('Space / *',         'Toggle selection')));
    lines.push(b(key('a',                 'Select / deselect all')));
    lines.push(b(key('Tab / h / l',       'Switch pane')));
    lines.push(b(key('Enter',             'Confirm')));
    lines.push(b(key('q / Esc',           'Cancel')));
  } else {
    section('Single-select');
    lines.push(b(key('j/k \u2191\u2193',  'Navigate')));
    lines.push(b(key('Enter',             'Select item')));
    lines.push(b(key('q / Esc',           'Cancel')));
  }

  lines.push(b(''));
  lines.push(b(C.muted('Press any key to close')));
  lines.push(C.dim(`  \u2570${'\u2500'.repeat(w)}\u256F`));

  return lines;
}

/** Show help overlay and wait for any key */
export async function showHelp(context: 'dashboard' | 'select-multi' | 'select-single'): Promise<void> {
  const helpLines = renderHelp(context);
  render(helpLines);
  await readKey(); // any key dismisses
}

// ── List select component ──
export interface ListItem {
  id: string;
  label: string;
  hint?: string;
  badge?: string;
  badgeStyle?: 'success' | 'warning' | 'error' | 'info' | 'muted' | 'highlight';
}

export interface SelectResult {
  ids: string[];
  cancelled: boolean;
}

/**
 * Yazi-style multi/single select list.
 * Caller must have called initTui() first.
 *
 *   j/k or ↑/↓  navigate       Space  toggle (multi)
 *   a            toggle all     Enter  confirm
 *   g/G          top/bottom     q/Esc  cancel
 *   ?            show help
 */
export async function selectList(opts: {
  title: string;
  items: ListItem[];
  multi?: boolean;
  preSelected?: Set<string>;
  hint?: string;
}): Promise<SelectResult> {
  const { title, items, multi = true, hint } = opts;
  if (!items.length) return { ids: [], cancelled: true };

  const selected = new Set(opts.preSelected || []);
  let cursor = 0;
  let offset = 0;

  const draw = () => {
    const { rows, cols } = termSize();
    const w = Math.min(cols - 2, 90);
    const listH = Math.max(1, rows - 7);
    const lines: string[] = [];

    // ── Header ──
    lines.push(hLine(w, 'heavy'));
    lines.push(`  ${ICONS.sync} ${C.bold(title)}  ${C.muted(hint || '')}`);
    const help = multi
      ? `  ${C.muted('j/k')} move  ${C.muted('space')} toggle  ${C.muted('a')} all  ${C.muted('enter')} confirm  ${C.muted('?')} help`
      : `  ${C.muted('j/k')} move  ${C.muted('enter')} select  ${C.muted('?')} help`;
    lines.push(help);
    lines.push(hLine(w));

    // ── Scroll ──
    if (cursor < offset) offset = cursor;
    if (cursor >= offset + listH) offset = cursor - listH + 1;
    const visible = items.slice(offset, offset + listH);

    for (let i = 0; i < listH; i++) {
      const item = visible[i];
      if (!item) { lines.push(''); continue; }
      const idx = offset + i;
      const isCur = idx === cursor;
      const isSel = selected.has(item.id);

      const ptr = isCur ? C.accent('▸') : ' ';
      const mark = multi
        ? (isSel ? C.success('◉') : C.muted('○'))
        : '';
      const label = isCur ? C.bold(item.label)
        : isSel ? C.success(item.label)
        : C.text(item.label);
      const badge = item.badge
        ? (C[item.badgeStyle || 'muted'] as any)(item.badge)
        : '';
      const hintTxt = item.hint ? C.muted(item.hint) : '';

      lines.push(`  ${ptr} ${mark}${mark ? ' ' : ''}${pad(label, 28)} ${pad(badge, 14)} ${hintTxt}`);
    }

    // ── Footer ──
    const scrollInd = (offset > 0 ? '↑' : ' ') + (offset + listH < items.length ? '↓' : ' ');
    lines.push(hLine(w));
    const count = multi ? `${selected.size}/${items.length} selected` : `${cursor + 1}/${items.length}`;
    lines.push(`  ${C.muted(count)}  ${C.muted(scrollInd)}`);

    render(lines);
  };

  while (true) {
    draw();
    const key = await readKey();

    switch (key.name) {
      case 'j': case 'down':
        cursor = Math.min(cursor + 1, items.length - 1); break;
      case 'k': case 'up':
        cursor = Math.max(cursor - 1, 0); break;
      case 'g': case 'home':
        cursor = 0; offset = 0; break;
      case 'G': case 'end':
        cursor = items.length - 1; break;
      case 'pagedown':
        cursor = Math.min(cursor + 10, items.length - 1); break;
      case 'pageup':
        cursor = Math.max(cursor - 10, 0); break;
      case 'space':
        if (multi) {
          const id = items[cursor]!.id;
          selected.has(id) ? selected.delete(id) : selected.add(id);
          cursor = Math.min(cursor + 1, items.length - 1);
        }
        break;
      case 'a':
        if (multi) {
          if (selected.size === items.length) selected.clear();
          else items.forEach(i => selected.add(i.id));
        }
        break;
      case 'enter':
        return multi
          ? { ids: items.filter(i => selected.has(i.id)).map(i => i.id), cancelled: false }
          : { ids: [items[cursor]!.id], cancelled: false };
      case '?': case '~':
        await showHelp(multi ? 'select-multi' : 'select-single');
        break;
      case 'q': case 'escape':
        return { ids: [], cancelled: true };
      case 'c':
        // ⭐ `N1` — Ctrl+C 도 세션 안내를 받는다(종전엔 못 받았다).
        if (key.ctrl) { closeTui(); runExitNotice(); process.exit(130); }
        break;
    }
  }
}
