// ── Yazi-inspired TUI engine ──
// No external dependencies — raw ANSI + stdin for full control
// Colors use terminal attributes (dim/bold/inverse) for transparent-theme compat

import chalk from 'chalk';
import { KeyStreamParser, splitKeys } from './tui-key.js';
import type { Key } from './tui-key.js';
import { invalidateRenderCacheFromRow, invalidateRenderCacheRow, render, renderCacheRowIs, resetRenderCache, setFrameObserver } from './tui-render-cache.js';
import type { RenderOptions } from './tui-render-cache.js';
import { pad, repeatToWidth, sliceAnsiByColumns, stripAnsi, truncate, visibleWidth, wrapAnsiByWidth } from './tui-string-width.js';
import type { WrapOpts, WrapSegment } from './tui-string-width.js';

export { __resetDoubleClickState, KeyStreamParser, splitKeys } from './tui-key.js';
export type { Key } from './tui-key.js';
export { invalidateRenderCacheFromRow, invalidateRenderCacheRow, render, renderCacheRowIs, resetRenderCache, setFrameObserver } from './tui-render-cache.js';
export type { RenderOptions } from './tui-render-cache.js';
export { pad, repeatToWidth, sliceAnsiByColumns, stripAnsi, truncate, visibleWidth, wrapAnsiByWidth } from './tui-string-width.js';
export type { WrapOpts, WrapSegment } from './tui-string-width.js';
import { noteInputLagKey } from './tui/input-lag-probe.js';
import { debug } from './debug/log.js';
import { startForegroundGuard } from './tty-foreground.js';

// ── ANSI escape sequences ──
const CSI = '\x1b[';

let _raw = false;
let _alt = false;
let _cancelReadKey: (() => void) | undefined;
let _stopForegroundGuard: (() => void) | undefined;
let _restoreConsole: (() => void) | undefined;

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

export function muteConsoleWhileTui(target: Pick<Console, 'error' | 'warn'> = console): () => void {
  const origError = target.error;
  const origWarn = target.warn;
  const route = (kind: 'error' | 'warn') => (...args: unknown[]): void => {
    try {
      debug.log('tui.console', kind, { text: args.map(a => (a instanceof Error ? a.message : String(a))).join(' ').slice(0, 2000) });
    } catch { /* 로그 실패가 화면을 깨지 않는다 */ }
  };
  target.error = route('error') as typeof console.error;
  target.warn = route('warn') as typeof console.warn;
  return () => { target.error = origError; target.warn = origWarn; };
}

function cleanup(): void {
  _restoreConsole?.();
  _restoreConsole = undefined;
  _stopForegroundGuard?.();
  _stopForegroundGuard = undefined;
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

/**
 * TUI-SIGCONT-RESTORE-TERM (0.2.36 · 2026-10-22) — 멈췄다(SIGTSTP·SIGTTIN · 상태 T) `fg` 로 돌아오면 셸의 작업 제어가
 * 터미널을 cooked 로 돌려놓았다. raw 모드·kitty/modifyOtherKeys·마우스·붙여넣기·alt 화면을 다시 세우지 않으면
 * Enter 가 «^M», Ctrl+C 가 «^[[99;5u» 로 입력창에 박혀 먹통이 된다(10-22 OPT 실물).
 * 지금 켜 둔 것만 다시 켜고, 렌더 캐시를 비운 뒤 `resize` 를 내 화면 전체를 다시 그리게 한다.
 */
export interface TerminalRestoreIo {
  stdin: { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown; resume?: () => unknown };
  stdout: { write: (chunk: string) => unknown; emit?: (event: string) => unknown };
}
export function restoreTerminalAfterContinue(state: { raw: boolean; alt: boolean }, io: TerminalRestoreIo): boolean {
  if (!state.raw && !state.alt) return false;
  if (state.raw && io.stdin.isTTY) {
    io.stdin.setRawMode?.(true);
    io.stdin.resume?.();
  }
  io.stdout.write(ansi.mouseOn + ansi.pasteOn + ansi.kittyKbOn + ansi.modKeysOn);
  io.stdout.write(state.alt ? ansi.altOn + ansi.hideCursor : ansi.hideCursor);
  resetRenderCache();
  debug.log('tui.lifecycle', 'sigcont-restored', { raw: state.raw, alt: state.alt });
  // 화면 주인(대시보드·next)은 resize 에서 전체를 다시 그린다.
  io.stdout.emit?.('resize');
  return true;
}

let _exitHandlersRegistered = false;
function registerExitHandlers(): void {
  if (_exitHandlersRegistered) return;
  _exitHandlersRegistered = true;
  process.on('exit', cleanup);
  process.on('SIGCONT', () => {
    try { restoreTerminalAfterContinue({ raw: _raw, alt: _alt }, { stdin: process.stdin, stdout: process.stdout }); }
    catch { /* fail-soft: 복구 실패가 프로세스를 죽이지 않는다 */ }
  });
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
  // TUI-SIGTTIN-SUSPEND (10-23 n8n): a child that steals the terminal's foreground group would leave
  // us to be stopped by SIGTTIN on the next keystroke. The guard takes it back from our own children.
  _stopForegroundGuard ??= startForegroundGuard();
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
  _restoreConsole ??= muteConsoleWhileTui();
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
let _lastHumanKeyAt = 0;

/** 마지막으로 배달된 사람 키 시각(ms · 0 = 아직 없음) — 내부 턴 문(H2)의 조용창 판정에 쓴다. */
export function lastHumanKeyAt(): number {
  return _lastHumanKeyAt;
}

/** Install a tracer invoked with every dispatched Key. Set to null to
 *  detach. Exceptions thrown by the tracer are swallowed so a broken
 *  tracer never blocks the input pipeline. */
export function setKeyTracer(fn: ((key: Key, source: KeyTraceSource) => void) | null): void {
  _keyTracer = fn;
}

/** Call the installed tracer, if any. Safe to invoke unconditionally —
 *  becomes a noop when no tracer is registered. */
export function traceKey(key: Key, source: KeyTraceSource): void {
  // H2 내부 턴 문 — «마지막 사람 키» 시각. 빈 이름(readKey 취소·빈 깨움)·리스너 표지는 사람 키가 아니다.
  if (key.name && !key.name.startsWith('listener-')) _lastHumanKeyAt = Date.now();
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
      if (keys.length > 0) noteInputLagKey(keys.length);

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
  noteInputLagKey();
  _keyQueue.push(key);
  _injectedKeys.add(key);
  // Wake any in-flight readKey awaiting on stdin by emitting an empty
  // chunk. The handler's queue-drain branch picks up the injected key
  // immediately.
  if (process.stdin.listenerCount('data') > 0) {
    process.stdin.emit('data', Buffer.from(''));
  }
  return true;
}

// A foreground dashboard may own an interactive child terminal modal. External
// control-IPC input must be routed to that modal before it enters the dashboard
// readKey queue; while the parent loop is busy there may be no readKey consumer.
let _externalTuiKeyRoutes: Array<{ token: symbol; route: (key: Key) => boolean }> = [];

export function setExternalTuiKeyRoute(route: ((key: Key) => boolean) | null): () => void {
  if (!route) return () => {};
  const entry = { token: Symbol('external-tui-key-route'), route };
  _externalTuiKeyRoutes.push(entry);
  return () => {
    _externalTuiKeyRoutes = _externalTuiKeyRoutes.filter((candidate) => candidate.token !== entry.token);
  };
}

export function routeExternalTuiKey(key: Key): boolean {
  const routes = [..._externalTuiKeyRoutes];
  for (let index = routes.length - 1; index >= 0; index -= 1) {
    if (routes[index]!.route(key)) return true;
  }
  return false;
}

/** `injectKey` 로 들어온 키 표지 — `takeInjectedKeys` 가 stdin 잔여 키(readKey 몫)는 두고 주입 키만 꺼낸다. */
const _injectedKeys = new WeakSet<Key>();

/** ⭐ TUI-ESC-ABORT-TOOLS (2026-10-15) — 턴 중 스트리밍 리스너(`attachStreamingKeys`)가
 *  바깥에서 주입된 키(`pty key` · 제어 IPC input-key → `injectKey`)를 받게 큐에서 꺼낸다.
 *  ⛔ readKey 가 걸려 있으면(`_cancelReadKey`) 큐는 그 readKey 의 몫이다 — 빈 배열을 돌려준다.
 *  ⛔ stdin 청크 잔여 키(readKey 가 넣은 것)는 건드리지 않는다. readKey 의 drain 동작은 그대로다. */
export function takeInjectedKeys(): Key[] {
  if (_cancelReadKey || _keyQueue.length === 0) return [];
  const taken: Key[] = [];
  for (let i = 0; i < _keyQueue.length; ) {
    const k = _keyQueue[i]!;
    if (_injectedKeys.has(k)) {
      taken.push(k);
      _keyQueue.splice(i, 1);
    } else {
      i += 1;
    }
  }
  // 같은 Key 객체가 두 번 주입될 수 있으므로 표지는 다 꺼낸 «뒤에» 지운다.
  for (const k of taken) _injectedKeys.delete(k);
  return taken;
}

/** ⭐ H2 내부 턴 문 — 걸려 있는 readKey 를 «빈 키»로 깨운다(키를 만들지도 큐에 넣지도 않는다).
 *  stdin 에 남은 바이트는 그대로 다음 readKey 몫이다. 걸린 readKey 가 없으면 false. */
export function cancelPendingReadKey(): boolean {
  if (!_cancelReadKey) return false;
  _cancelReadKey();
  return true;
}

/** 아직 readKey 가 소비하지 않은 키 수 — 외부 입력 대기열이 «사용자 키보다 앞서» 끼어들지 않게 본다. */
export function pendingKeyCount(): number {
  return _keyQueue.length;
}

export function termSize(): { rows: number; cols: number } {
  return { rows: process.stdout.rows || 24, cols: process.stdout.columns || 80 };
}

// ── Utility ──

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
