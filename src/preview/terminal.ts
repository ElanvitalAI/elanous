// ── PreviewTerminal — embedded shell inside wd-preview ──
//
// Phase T (session 18). Owns a PTY running the user's $SHELL plus an
// @xterm/headless Terminal that converts the PTY byte stream into a
// grid of cells. The dashboard's draw() loop asks this class for an
// ANSI-preformatted snapshot of that grid each frame and pipes it into
// the preview widget's markdown state (preformatted=true).
//
// Bun + node-pty quirk: node-pty's master-fd Socket doesn't emit
// 'data' under Bun, and fs.readSync on the wrapped fd returns EBADF.
// Workaround: dup the master fd via fs.openSync('/dev/fd/<n>','r+')
// — the duplicate is independent of node-pty's Socket and reads
// cleanly via fs.read callback form. Writes go through the dup too
// (avoids touching node-pty's Socket.write which has the same issue).
//
// Reference: ~/source/ref/ghostty/src/terminal/ —
// @xterm/headless already implements an xterm-compatible VT/ANSI
// parser + grid buffer, so we don't port ghostty's Zig emulator,
// just its mental model (active vs alternate buffer, viewport,
// cursor, cell attrs).

import type { IPty } from 'node-pty';
import * as fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { Terminal } from '@xterm/headless';
import type { IBufferCell } from '@xterm/headless';
import { requirePosixShell } from '../platform/default-shell.js';
import { buildPtyEnv } from '../agent/identity-env.js';
import { getCapturedEnv } from '../shell-env-bootstrap.js';
import { debug } from '../debug/log.js';
import { visibleWidth as hostVisibleWidth } from '../tui.js';
import { startPty as realStartPty, onPtyEvent as realOnPtyEvent, unregisterPty } from '../pty-shell/registry.js';
import type { PtyHandle, PtyEvent, StartOpts } from '../pty-shell/registry.js';

/** NT-E1 — OSC 9/99/777 event payload. Shared between the
 *  construction-time `onOscNotify` callback and the runtime
 *  `addRawOscTap` subscribers. */
export interface OscNotifyEvent {
  code: 9 | 99 | 777;
  title: string;
  body: string;
  raw: string;
}

export type OscTapCallback = (ev: OscNotifyEvent) => void;

/** W3-ext — lifecycle events forwarded from the xterm-headless emulator.
 *  Subscribed via `addEventTap()`. Payloads are deliberately minimal so
 *  downstream consumers (pane-substrate event tap, capture engine, LLM
 *  tools) don't depend on xterm-specific shapes. */
export type TerminalEvent =
  | { kind: 'cursor'; row: number; col: number }
  | { kind: 'resize'; cols: number; rows: number }
  | { kind: 'title'; title: string };

export type TerminalEventTapCallback = (ev: TerminalEvent) => void;

export interface PreviewTerminalOpts {
  cols: number;
  rows: number;
  cwd: string;
  /** Defaults to $SHELL, then /bin/bash. */
  shell?: string;
  /** Positional args handed to `spawn()` as the second parameter.
   *  Defaults to []. Used by matrix transports to launch remote
   *  shells via `tailscale ssh <host> -- …` or `ssh -t user@host -- …`
   *  without mutating the `shell` string itself (keeps quoting + arg
   *  splitting honest). */
  shellArgs?: readonly string[];
  env?: Record<string, string>;
  /** Defaults to `xterm-256color` (universal). Override with
   *  `xterm-ghostty` to match a ghostty host, or another terminfo
   *  name for testing. The chosen name lands in $TERM of the child
   *  process AND in node-pty's `name` option. */
  termName?: string;
  /** Fired shortly after PTY data was written into the emulator. The
   *  dashboard wires this to draw(). Debounced to ~16 ms. */
  onUpdate?: () => void;
  /** Fired once when the child exits (normal or signalled). */
  /** ⛔ `code` is `number | null` — null means the child exited but its code
   *  was unlearnable (unmapped signal / racing wait). Render it as unknown;
   *  do NOT fall back to 0, which reads as a clean finish. */
  onExit?: (code: number | null) => void;
  /** ★ P0b-2 (2026-07-23·기본 off) — 진짜 PWA/iOS 라이브 셸을 공유 registry 버스로 흡수(3-스택 통합).
   *  true 면 자체 node-pty+dup-fd 대신 `startPty(kind='preview')` 로 spawn 하고 출력을 `onPtyEvent('output')`
   *  로 받아 같은 에뮬레이터/탭에 먹인다(정체성·크로스서피스 goto 획득). bun onData-死는 registry bun-native
   *  openpty 가 해결. ⚠️ 라이브 렌더(yazi DA2·마우스·커서·alt-screen) 검증은 기기 세션 필요(대표) → 기본 off. */
  useRegistry?: boolean;
  /** P13 — OSC 9/99/777 notification hook. Fires when the child
   *  emits one of:
   *    ESC ] 9 ; <title> BEL                  (iTerm2 growl)
   *    ESC ] 777 ; notify ; <title> ; <body> BEL (urxvt/xterm)
   *    ESC ] 99 ; <key=value list> ; <body> BEL  (Kitty/Konsole-ish)
   *  Payloads are parsed best-effort; title always set, body may
   *  be empty string. No throttling applied here — the registry
   *  upstream can rate-limit per session. */
  onOscNotify?: (ev: OscNotifyEvent) => void;
  /** T7c1 — fires once per PTY read with the raw utf8 chunk. Gives
   *  subscribers access to stdout BEFORE xterm-headless processes
   *  ANSI/CSI sequences, so terminal-to-terminal pipelines work
   *  without needing to decode the emulator grid. Multiple taps
   *  install via `addRawOutputTap()` — this option is the legacy
   *  single-subscriber path. */
  onRawOutput?: (chunk: string) => void;
}

/** Shared so tests can override (fake pty) — the default is node-pty. */
export type SpawnFn = (shell: string, args: string[], opts: {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}) => IPty;

// ⛔⭐ `node-pty` 를 «최상위»에서 싣지 않는다 — 이 모듈은 dashboard·shell-runner 등 다섯 곳이
//   정적으로 끌어오므로, 최상위 import 면 ***PTY 를 안 쓰는 명령(`--version`)까지*** 네이티브 바인딩을
//   요구하게 된다. 📏 실측(2026-08-31 · grokb1 x86_64): node-pty 는 linux-x64 prebuild 가 «없고»
//   소스 빌드본을 bun 이 못 읽어 `panic: unsupported uv function` 으로 죽는다 ⇒ `--version` 조차 못 낸다.
//   ⇒ 그러면 이 저장소의 `B-1` 관문(*"버전이 산출을 내는가"*)이 그 플랫폼에서 «원리상» 통과 불가다.
//   ✅ 그래서 «부를 때» 싣는다. 같은 저장소의 `src/pty-shell/registry.ts` 가 이미 쓰는 패턴이다.
//   ⚠️ 이것은 PTY 를 «고치는» 것이 아니다 — PTY 가 필요한 경로는 여전히 여기서 실패한다.
//      바뀌는 것은 ***「PTY 가 필요 없는 경로까지 같이 죽던 것」*** 하나다.
const defaultSpawn: SpawnFn = (shell, args, o) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
  const pty: any = require('node-pty');
  return pty.spawn(shell, args, o as any) as IPty;
};

/** node-pty 네이티브 `resize(fd, cols, rows)` 를 임의의 master fd(우리 dup)에 부른다. 'ok' 또는 실패 사유. */
export function resizeMasterFd(fd: number, cols: number, rows: number): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
    const native: any = require('node-pty/lib/utils').loadNativeModule('pty').module;
    native.resize(fd, cols, rows);
    return 'ok';
  } catch (e) {
    return String(e);
  }
}

/** Known POSIX-y user login shells. We only inject `-l -i` defaults for
 *  these; arbitrary `shell` strings (matrix `tailscale`/`ssh` wrappers)
 *  fall through with `[]`. */
const USER_SHELL_RE = /(^|\/)(zsh|bash|fish|sh|dash|ksh)$/;

/** Default argv for spawning the user shell as a PTY. Returns `-l -i`
 *  on POSIX so the child sources `.zprofile` (login) AND `.zshrc`
 *  (interactive) — matches VSCode/Zed/Warp. Returns `[]` on Windows
 *  (cmd.exe / powershell flag semantics differ) and for non-shell
 *  binaries. Exported for tests. */
export function defaultShellArgsFor(shell: string): string[] {
  if (process.platform === 'win32') return [];
  if (!USER_SHELL_RE.test(shell)) return [];
  return ['-l', '-i'];
}

/** ★ P0b-2 registry 주입 seam(테스트) — 기본=실제 registry. mock.module(전역오염) 대신 DI. */
export interface PreviewRegistryDeps {
  startPty: (opts: StartOpts) => PtyHandle;
  onPtyEvent: (cb: (ev: PtyEvent) => void) => () => void;
  unregisterPty: (id: string) => boolean;
}

export class PreviewTerminal {
  private pty: IPty | null = null;
  private dupFd: number = -1;
  /** ★ P0b-2 — useRegistry 모드일 때 공유 버스 핸들(dup-fd 대신). null=dup-fd 경로(기본). */
  private registryHandle: PtyHandle | null = null;
  private registryUnsub: Array<() => void> = [];
  private term: Terminal;
  private updatePending = false;
  private alive = false;
  private readBuf = Buffer.alloc(8192);
  /** UTF-8 decoder that buffers incomplete multi-byte sequences across
   *  fs.read boundaries. Without this, a wide char (한글, emoji,
   *  NerdFont PUA, box-drawing) split across two chunks decodes as
   *  REPLACEMENT CHARACTER (U+FFFD) on each side — the emulator stores
   *  `���` in the cell and the host paints a black diamond. Symptom
   *  scaled with cols × wide-char density (worse on wide screens with
   *  claude code's status bar). `string_decoder` handles the same
   *  case Node.js streams do internally. */
  private readonly utf8Decoder = new StringDecoder('utf8');
  /** T7c1 — raw stdout taps. Each subscriber gets every chunk as a
   *  utf8 string, pre-emulator. Used by matrix.pipeToChannel to
   *  publish PTY stdout onto the ChannelBus. Tap callbacks are
   *  isolated per-subscriber so one throwing tap doesn't poison
   *  the others. */
  private readonly rawOutputTaps = new Set<(chunk: string) => void>();
  /** NT-E1 — OSC 9/99/777 runtime taps. Construction-time
   *  `onOscNotify` stays for backwards compat (the session registry
   *  uses it to raise attention). Runtime subscribers come online
   *  later — e.g. NotificationStore wiring in dashboard.ts — without
   *  needing to reconstruct the terminal. Same per-tap isolation. */
  private readonly rawOscTaps = new Set<OscTapCallback>();
  /** W3-ext — lifecycle event taps (cursor / resize / title). Driven
   *  by xterm-headless emitters wired in start(); the IDisposable
   *  handles returned from those emitters are tracked below so stop()
   *  can release them. Per-tap isolation matches rawOutputTaps. */
  private readonly eventTaps = new Set<TerminalEventTapCallback>();
  private xtermDisposables: Array<{ dispose: () => void }> = [];
  /** NT-A2 — cumulative byte count of raw PTY output ever fed into
   *  the emulator. Monotonic. Used by `markBufferPosition()` so a
   *  caller can later ask "what arrived after the mark?" even if
   *  scrollback is large or line counts are ambiguous. */
  private totalRawBytes = 0;

  /** Diagnostic — last render() state signature. We only emit a
   *  `preview.terminal.render` log when something changes (alt-buffer
   *  toggle, viewport/cursor/baseY/buffer length) so a 60 Hz redraw
   *  loop doesn't flood the file. Empty string until the first call. */
  private lastRenderSig: string = '';
  /** Diagnostic — last `preview.terminal.widthMismatch` payload
   *  signature. Suppresses identical re-emits while the prompt /
   *  visible content stays the same. */
  private lastWidthMismatchSig: string = '';

  /** Rows scrolled back from the live tail. 0 = live tail (default);
   *  positive = that many rows above. Clamped at render() time
   *  against the buffer's actual scrollback depth so it never goes
   *  out of range. */
  private scrollOffset = 0;
  /** Mouse-reporting state set via DECSET 1000/1002/1003. When 0 the
   *  child isn't tracking mouse events at all — we keep the wheel
   *  mapped to scrollback. When >0 we forward SGR mouse bytes to
   *  the PTY so tmux / htop / neovim / fzf see them. */
  private mouseMode: 0 | 1000 | 1002 | 1003 = 0;
  /** SGR encoding is active (DECSET 1006). Modern apps universally
   *  turn this on alongside 1000/1002/1003. Our encoder follows the
   *  SGR form unconditionally since it's what every tracked app
   *  actually expects. */
  private mouseSgr = false;

  constructor(
    private opts: PreviewTerminalOpts,
    private spawn: SpawnFn = defaultSpawn,
    private registryDeps: PreviewRegistryDeps = { startPty: realStartPty, onPtyEvent: realOnPtyEvent, unregisterPty },
  ) {
    this.term = new Terminal({
      cols: Math.max(2, opts.cols),
      rows: Math.max(2, opts.rows),
      allowProposedApi: true,
      scrollback: 1000,
      convertEol: false,
    });
  }

  start(): void {
    if (this.alive) return;
    const shell = this.opts.shell || requirePosixShell('/bin/bash');
    // Inherit host's $TERM by default. claude code (and many other
    // modern TUIs) gate alt-screen / fullscreen UI on terminfo
    // capabilities — when we hardcoded `xterm-256color`, claude in
    // a popup terminal fell back to inline mode (DECSC/DECRC + CUF)
    // and rendered visibly broken (cursor drift, duplicate prompt,
    // border re-draw, NerdFont fallback diamonds) compared to running
    // claude directly in the host. xterm-headless silently ignores
    // host-only sequences (kitty kbd protocol etc.) so inheriting
    // the wider terminfo is safe — the standard alt-screen / cursor /
    // SGR / OSC paths it does implement are exactly what claude needs
    // for its fullscreen UI.
    const term = this.opts.termName || process.env.TERM || 'xterm-256color';
    // F3 (2026-04-21) — default to the captured login-shell env so
    // env 합성 = **경로마다 정확히 한 곳**(SSOT). 여기서는 overlay 만 만든다:
    //   · direct spawn(기본)      → 아래에서 buildPtyEnv(overlay) 로 합성(유일 합성자)
    //   · useRegistry:true(옵트인) → registry(resolveSpawnShape)가 합성(유일 합성자)
    // 두 경로가 동일하게 `captured ⊕ identityEnv ⊕ overlay` 를 얻는다.
    //
    // ⚠️ 의미론 정정(self review #5472) — 종전 `this.opts.env ?? captured` 는 명시 env 를
    //    **통째 대체**로 취급했다. 그런데 실제 호출자(terminal-matrix transport)가 넘기는 것은
    //    `{ELANOUS_REMOTE_HOST,…}` 같은 **소형 overlay** 라, 대체 의미론에서는 자식이 PATH·HOME
    //    조차 없는 env 로 뜬다(잠복 결함). registry 경로는 이미 merge 였어서 **경로별로 결과가
    //    갈리기도 했다**. merge 로 통일 — 호출자가 같은 키를 명시하면 여전히 호출자가 이긴다.
    const overlay: Record<string, string> = { ...(this.opts.env ?? {}) };
    // COLORTERM=truecolor — captured env strips COLORTERM in the seed
    // phase (shell-env-bootstrap.ts), and SSH does not forward it by
    // default, so prompt themes (powerlevel10k, starship) fall back to
    // a dim 16-color rendering. elanous's xterm.js renderer accepts
    // 24-bit RGB, so claiming truecolor is safe regardless of how
    // elanous itself was launched.
    // Force claude code into fullscreen (alt-screen) UI inside the
    // popup terminal. claude code v2.1.119+ for an external user
    // defaults to inline mode (DECSC/DECRC + cursor forward) when
    // `CLAUDE_CODE_NO_FLICKER` is unset. xterm-headless renders that
    // inline path with visible cell drift, duplicate prompt, divider
    // re-draw, and NerdFont fallback diamonds in the popup; ghostty
    // running it directly via the same default also paints inline but
    // single-buffer hides the artifacts. Setting `CLAUDE_CODE_NO_FLICKER=1`
    // (env name reads "no flicker → wanted" → fullscreen) flips claude
    // into alt-screen (`\x1b[?1049h`) and the embedded emulator handles
    // that cleanly. Ref: claude-code-fork src/utils/fullscreen.ts:114-128
    // — `isEnvDefinedFalsy` short-circuits to fullscreen-OFF, so `=0`
    // would force it off; `=1` (truthy) returns fullscreen-ON. The
    // captured env's value still wins so a user who explicitly set
    // `CLAUDE_CODE_NO_FLICKER=0` to opt out keeps inline mode.
    // captured 는 CLAUDE_CODE_NO_FLICKER 기본값 판정에만 참조한다(합성은 아래 각 경로에서).
    const capturedForDefaults = getCapturedEnv();
    const childEnv: Record<string, string> = {
      ...overlay,
      TERM: term,
      COLORTERM: 'truecolor',
      CLAUDE_CODE_NO_FLICKER:
        overlay.CLAUDE_CODE_NO_FLICKER ?? capturedForDefaults.CLAUDE_CODE_NO_FLICKER ?? '1',
    };
    // F4 (2026-04-25) — when the caller didn't pass shellArgs and the
    // shell looks like a known user login shell, default to `-l -i` so
    // the child sources `.zprofile` AND `.zshrc`. Without `-l` the
    // standard Homebrew bootstrap (`eval "$(/opt/homebrew/bin/brew
    // shellenv)"`) — which Brew installs into `~/.zprofile` by default —
    // never runs, leaving the child's PATH missing `/opt/homebrew/bin`
    // and causing every PATH-dependent line in `.zshrc` (starship /
    // atuin / fzf / pyenv / zoxide / brew / codex / claude binaries) to
    // fail with `command not found`. Matches VSCode + Zed behavior.
    // Explicit `shellArgs: []` from a caller (matrix transport spawning
    // ssh/tailscale wrapper) is preserved verbatim — only undefined
    // triggers the default. Windows skips this since cmd.exe /
    // powershell login semantics differ. Unknown `shell` names (custom
    // shims, remote-shell binaries) also keep `[]` so we don't pass
    // `-l -i` to something that doesn't understand it.
    const args = this.opts.shellArgs
      ? [...this.opts.shellArgs]
      : defaultShellArgsFor(shell);
    if (this.opts.useRegistry) {
      // ★ P0b-2 (기본 off) — 공유 registry 버스로 spawn(자체 dup-fd 없음). term(terminfo name)은 childEnv.TERM
      //   으로 자식에 전달되고, registry startPty 의 term 은 allowlist 제약이 있어 생략(기본 xterm-256color·
      //   PreviewTerminal 자체 에뮬레이터가 렌더 담당이라 무관). 출력 구독/exit 배선은 아래 pump 분기에서.
      this.registryHandle = this.registryDeps.startPty({
        // 합성자 = registry(resolveSpawnShape) — 여기서는 overlay 만 넘긴다.
        cmd: shell, args, workdir: this.opts.cwd, env: childEnv,
        cols: this.term.cols, rows: this.term.rows, kind: 'preview', accessMode: 'write',
      });
      this.alive = true;
    } else {
      // 합성자 = 여기(직접 spawn 은 registry 를 안 타므로 유일 합성 지점).
      this.pty = this.spawn(shell, args, {
        name: term,
        cols: this.term.cols,
        rows: this.term.rows,
        cwd: this.opts.cwd,
        env: buildPtyEnv(childEnv),
      });
      const masterFd = this.resolveMasterFd(this.pty);
      if (masterFd === null) throw new Error('PreviewTerminal: could not resolve PTY master fd');
      this.dupFd = fs.openSync(`/dev/fd/${masterFd}`, 'r+');
      this.alive = true;
    }

    // ── Response channel (yazi / fzf / anything with a DA / cursor
    // position / bg-color query) ──
    // xterm-headless fires onData for two distinct reasons:
    //   1. Synthetic user input (.input(), mouse tracking) — we don't
    //      use either path.
    //   2. Responses the emulator owes the running program, e.g.
    //      DA (ESC[?64;...c), cursor position (ESC[row;colR),
    //      color queries (OSC 11 ; rgb:…), CSI 14/16/18 t (window
    //      pixel / cell-size / text-area queries).
    // Writing those bytes back to the master fd hands them to the
    // child as if they arrived on stdin — exactly what the child
    // expects. Without this, yazi reports
    //   `Terminal response timeout: … Yazi didn't receive a correct response`
    // because its DA2 probe times out.
    this.term.onData((data: string) => { this.writeToChild(data); });

    // ── Mouse-reporting mode tracking (T9) ────────────────────
    // DECSET 1000/1002/1003/1006 enable different flavors of mouse
    // reporting. We just need to know IF mouse events are being
    // consumed by the child — so we can forward scroll/click from
    // our absolute-coord dispatch into pane-relative SGR bytes.
    const parser = this.term.parser;
    const mousePrivateSet = (params: (number | number[])[]): boolean => {
      for (const raw of params) {
        const p = typeof raw === 'number' ? raw : raw[0] ?? 0;
        if (p === 1000) this.mouseMode = 1000;
        else if (p === 1002) this.mouseMode = 1002;
        else if (p === 1003) this.mouseMode = 1003;
        else if (p === 1006) this.mouseSgr = true;
      }
      return false; // keep propagating so xterm's own handling runs
    };
    const mousePrivateReset = (params: (number | number[])[]): boolean => {
      for (const raw of params) {
        const p = typeof raw === 'number' ? raw : raw[0] ?? 0;
        if (p === 1000 || p === 1002 || p === 1003) this.mouseMode = 0;
        else if (p === 1006) this.mouseSgr = false;
      }
      return false;
    };
    parser.registerCsiHandler({ prefix: '?', final: 'h' }, mousePrivateSet);
    parser.registerCsiHandler({ prefix: '?', final: 'l' }, mousePrivateReset);

    // ── P13 + NT-E1: OSC 9 / 99 / 777 notification hooks ──
    // Handlers return false so xterm's default handling continues
    // (e.g. OSC 9 may also update the window title in some stacks).
    // Registered unconditionally so runtime taps (addRawOscTap) work
    // even when no construction-time onOscNotify was supplied.
    const dispatchOsc = (ev: OscNotifyEvent): void => {
      try { this.opts.onOscNotify?.(ev); } catch { /* ignore */ }
      for (const tap of this.rawOscTaps) {
        try { tap(ev); } catch { /* isolate per-tap */ }
      }
    };
    this.term.parser.registerOscHandler(9, (data: string) => {
      try { dispatchOsc(parseOscNotify(9, data)); } catch { /* ignore */ }
      return false;
    });
    this.term.parser.registerOscHandler(99, (data: string) => {
      try { dispatchOsc(parseOscNotify(99, data)); } catch { /* ignore */ }
      return false;
    });
    this.term.parser.registerOscHandler(777, (data: string) => {
      try { dispatchOsc(parseOscNotify(777, data)); } catch { /* ignore */ }
      return false;
    });

    // ── W3-ext · cursor/resize/title event forwarding ────────────
    // xterm-headless emits disposable events; we fan them out into
    // runtime taps so the pane substrate (TerminalPane event tap) and
    // capture engine can observe lifecycle transitions without directly
    // depending on @xterm/headless types. Handles are stashed in
    // xtermDisposables so stop() can release them deterministically.
    this.xtermDisposables.push(this.term.onCursorMove(() => {
      if (this.eventTaps.size === 0) return;
      const active = this.term.buffer.active;
      const ev: TerminalEvent = {
        kind: 'cursor',
        row: active.cursorY,
        col: active.cursorX,
      };
      for (const tap of this.eventTaps) {
        try { tap(ev); } catch { /* isolate per-tap */ }
      }
    }));
    this.xtermDisposables.push(this.term.onResize((size: { cols: number; rows: number }) => {
      if (this.eventTaps.size === 0) return;
      const ev: TerminalEvent = { kind: 'resize', cols: size.cols, rows: size.rows };
      for (const tap of this.eventTaps) {
        try { tap(ev); } catch { /* isolate per-tap */ }
      }
    }));
    this.xtermDisposables.push(this.term.onTitleChange((title: string) => {
      if (this.eventTaps.size === 0) return;
      const ev: TerminalEvent = { kind: 'title', title };
      for (const tap of this.eventTaps) {
        try { tap(ev); } catch { /* isolate per-tap */ }
      }
    }));

    // ── stdout-of-child → emulator ──
    // 리스너(onData, exit)를 마지막에 배선해 첫 바이트 전에 모두 준비되게 한다.
    if (this.registryHandle) {
      // ★ P0b-2 — 공유 버스 구독. onPtyEvent('output') 을 dup-fd pump 와 동일한 feedChunk 로 먹인다.
      const rid = this.registryHandle.id;
      this.registryUnsub.push(this.registryDeps.onPtyEvent((ev) => {
        if (ev.id !== rid) return;
        if (ev.type === 'output') this.feedChunk(ev.chunk, Buffer.byteLength(ev.chunk, 'utf8'));
        else if (ev.type === 'exit') {
          this.alive = false;
          try { this.opts.onExit?.(ev.exitCode); } catch { /* swallow */ }
        }
      }));
    } else {
      this.pty!.onExit((e: { exitCode: number | null }) => {
        this.alive = false;
        try { this.opts.onExit?.(e.exitCode); } catch { /* swallow */ }
      });
      this.pump();
    }
  }

  /** node-pty doesn't publish its master fd as a stable field; dig
   *  through the plausible private slots in order of most-to-least
   *  likely so a minor library revision doesn't bite us. */
  private resolveMasterFd(p: IPty): number | null {
    const any = p as any;
    const fd = any._fd
      ?? any._socket?._handle?.fd
      ?? any._socket?.fd
      ?? any._pty;  // 0.10.x fallback
    return typeof fd === 'number' ? fd : null;
  }

  private pump(): void {
    const loop = () => {
      if (!this.alive || this.dupFd < 0) return;
      fs.read(this.dupFd, this.readBuf, 0, this.readBuf.length, null, (err, n) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'EAGAIN') {
            setTimeout(loop, 10);
            return;
          }
          // EBADF / EIO = pty closed
          this.alive = false;
          return;
        }
        if (n > 0) {
          const chunk = this.utf8Decoder.write(this.readBuf.subarray(0, n));
          if (chunk.length === 0) {
            // Decoder buffered an incomplete multi-byte sequence — wait
            // for the rest. The bytes are still counted below so
            // `bytesSinceMark` stays accurate.
            this.totalRawBytes += n;
            if (!this.alive) return;
            setImmediate(loop);
            return;
          }
          this.feedChunk(chunk, n);
        }
        // Bun + /dev/fd-backed PTY reads can report "no bytes right now"
        // as a successful read with n===0 instead of EAGAIN. Re-entering
        // immediately in that state spins a hot busy loop and can pin a
        // whole core at 100% while the child is idle.
        if (!this.alive) return;
        if (n > 0) setImmediate(loop);
        else setTimeout(loop, 10);
      });
    };
    loop();
  }

  /** 디코드된 청크를 에뮬레이터+raw 탭에 먹인다. dup-fd pump 와 registry onPtyEvent 경로가 공유(P0b-2). */
  private feedChunk(chunk: string, rawBytes: number): void {
    this.totalRawBytes += rawBytes;
    this.term.write(chunk);
    // T7c1 — notify taps with the raw chunk BEFORE the emulator processes it.
    if (this.opts.onRawOutput) {
      try { this.opts.onRawOutput(chunk); } catch { /* swallow */ }
    }
    for (const tap of this.rawOutputTaps) {
      try { tap(chunk); } catch { /* isolate per-tap */ }
    }
    this.scheduleUpdate();
  }

  /** 자식 stdin 으로 바이트 전송(응답 채널·public write·마우스 공유). registry 모드면 handle.write,
   *  아니면 dup-fd(기본 경로 무접촉). */
  private writeToChild(data: string): void {
    if (this.registryHandle) { try { this.registryHandle.write(data); } catch { /* pty closing */ } return; }
    if (!this.alive || this.dupFd < 0) return;
    try { fs.writeSync(this.dupFd, data); } catch { /* pty closing */ }
  }

  private scheduleUpdate(): void {
    if (this.updatePending) return;
    this.updatePending = true;
    setTimeout(() => {
      this.updatePending = false;
      if (!this.alive) return;
      try { this.opts.onUpdate?.(); } catch { /* swallow */ }
    }, 16);
  }

  /** T7c1 — subscribe to raw PTY output chunks. Returns an
   *  unsubscribe handle. Chunks arrive as utf8 strings, one per
   *  `fs.read` callback (at most 8 KB each). No line framing —
   *  subscribers that need lines should accumulate until '\n'. */
  addRawOutputTap(cb: (chunk: string) => void): () => void {
    this.rawOutputTaps.add(cb);
    return () => { this.rawOutputTaps.delete(cb); };
  }

  /** W3-ext — subscribe to emulator lifecycle events (cursor move /
   *  resize / title change). Returns an unsubscribe handle. Taps fire
   *  only when the emulator itself emits — cursor moves are batched
   *  per-write rather than per-cell, so expect bursts on large writes.
   *  Subscribers must not assume monotonic cursor coordinates across
   *  resize events. Safe to subscribe before start(); events only
   *  start flowing once the PTY is alive. */
  addEventTap(cb: TerminalEventTapCallback): () => void {
    this.eventTaps.add(cb);
    return () => { this.eventTaps.delete(cb); };
  }

  /** NT-E1 — subscribe to parsed OSC 9/99/777 notify events at
   *  runtime. Complements construction-time `onOscNotify` (used by
   *  the session registry for attention raising); runtime taps let
   *  the dashboard wire OSC → NotificationStore after adoption.
   *  Returns an unsubscribe handle. */
  addRawOscTap(cb: OscTapCallback): () => void {
    this.rawOscTaps.add(cb);
    return () => { this.rawOscTaps.delete(cb); };
  }

  /** Send raw bytes to the PTY (stdin from the child's perspective). */
  write(bytes: string): void {
    this.writeToChild(bytes);
  }

  /** Notify the PTY + emulator of new pane dimensions. Called on
   *  layout changes. No-op if cols/rows unchanged. */
  resize(cols: number, rows: number): void {
    if (!this.alive) return;
    cols = Math.max(2, cols);
    rows = Math.max(2, rows);
    if (cols === this.term.cols && rows === this.term.rows) return;
    try { this.term.resize(cols, rows); } catch { /* ignore */ }
    if (this.registryHandle) { try { this.registryHandle.resize(cols, rows); } catch { /* ignore */ } }
    else if (this.pty) {
      // Bun + node-pty quirk(머리말) — node-pty 가 쥔 master fd 는 Bun 에서 EBADF 라 `pty.resize` 가
      // ioctl 에서 던진다. 종전엔 그 오류를 삼켜서 ***웹 터미널 PTY 가 영영 80×24*** 였다(2026-09-28 실측:
      // xterm 172칸 ↔ `stty size` 24 80 — 셸이 80칸에서 접어 프롬프트·긴 명령이 깨졌다).
      // ⇒ 우리가 dup 해 둔 fd 로 같은 네이티브 resize(TIOCSWINSZ)를 부른다. 커널이 SIGWINCH 를 보낸다.
      try {
        this.pty.resize(cols, rows);
      } catch (e) {
        const viaDup = this.dupFd >= 0 ? resizeMasterFd(this.dupFd, cols, rows) : 'no-dup-fd';
        debug.log('preview.terminal', 'resize.fallback', { cols, rows, reason: String(e), viaDup });
      }
    }
  }

  /** Kill the shell, close the master fd, dispose the emulator. Safe
   *  to call twice. */
  stop(): void {
    if (!this.alive && this.dupFd < 0 && !this.pty && !this.registryHandle) return;
    this.alive = false;
    if (this.dupFd >= 0) {
      try { fs.closeSync(this.dupFd); } catch { /* ignore */ }
      this.dupFd = -1;
    }
    // W3-ext — release xterm-headless event subscriptions before
    // disposing the emulator so late-fired events don't reach taps
    // after stop().
    for (const d of this.xtermDisposables) {
      try { d.dispose(); } catch { /* ignore */ }
    }
    this.xtermDisposables = [];
    // ★ P0b-2 — registry 모드면 버스 구독 해제 + 핸들 kill + 등록해제(척추에서 제거).
    for (const u of this.registryUnsub) { try { u(); } catch { /* ignore */ } }
    this.registryUnsub = [];
    if (this.registryHandle) {
      try { this.registryHandle.kill('SIGHUP'); } catch { /* ignore */ }
      try { this.registryDeps.unregisterPty(this.registryHandle.id); } catch { /* ignore */ }
      this.registryHandle = null;
    }
    try { this.pty?.kill('SIGHUP'); } catch { /* ignore */ }
    try { this.term.dispose(); } catch { /* ignore */ }
    this.pty = null;
  }

  /** Snapshot the visible viewport as an ANSI-preformatted string.
   *  One line per row, cells concatenated with SGR prefixes emitted
   *  only on change. Each line ends with SGR reset when it carried
   *  attributes. Trailing spaces are preserved so alignment matches
   *  the emulator's grid.
   *
   *  `focused` renders an inverse-video block at the emulator's
   *  cursor position — essential for p10k / vim / any program where
   *  the user needs to see where the next keystroke lands. When the
   *  preview pane is unfocused we hide the cursor so the visible
   *  "I am ready for input" cue only shows on the active pane. */
  render(focused: boolean = false): string {
    const lines: string[] = [];
    const active = this.term.buffer.active;
    const cols = this.term.cols;
    const rows = this.term.rows;
    const cellRef = active.getNullCell();
    // Clamp each render — the buffer shrinks when the emulator is
    // resized smaller, which can leave scrollOffset pointing past the
    // top. maxScrollOffset() always reflects current buffer state.
    const max = this.maxScrollOffset();
    if (this.scrollOffset > max) this.scrollOffset = max;
    const topRow = Math.max(0, active.viewportY - this.scrollOffset);
    // Hide the cursor while in scrollback — it lives at the REAL
    // cursor position in the live tail, not where we're scrolled to.
    const cursorVisible = focused && this.scrollOffset === 0;
    const curX = cursorVisible ? active.cursorX : -1;
    const curY = cursorVisible ? active.cursorY : -1;

    if (debug.enabled) {
      // Diagnostic — emit once per state change so a 60 Hz redraw loop
      // doesn't flood. Lets us see alt-buffer entry, viewport drift,
      // cursor position vs grid bounds in `log/latest` without ever
      // re-running with extra instrumentation.
      const altActive = active === this.term.buffer.alternate;
      const sig =
        `${altActive ? 'alt' : 'main'}|vp=${active.viewportY}|base=${active.baseY}` +
        `|cx=${active.cursorX}|cy=${active.cursorY}|len=${active.length}` +
        `|so=${this.scrollOffset}|focused=${focused ? 1 : 0}`;
      if (sig !== this.lastRenderSig) {
        this.lastRenderSig = sig;
        debug.log('preview.terminal.render', altActive ? 'alt' : 'main', {
          rows, cols, focused,
          altActive,
          viewportY: active.viewportY,
          baseY: active.baseY,
          cursorX: active.cursorX,
          cursorY: active.cursorY,
          bufLength: active.length,
          topRow,
          scrollOffset: this.scrollOffset,
        });
      }
    }

    // Diagnostic — collect cells whose emulator-advertised width
    // disagrees with the host's visible-width measurement. These are
    // exactly the cells that cause `paint.row` to over/undershoot
    // innerWidth and leak into / under-fill the modal interior.
    type MismatchCell = { y: number; x: number; ch: string; cp: number; advW: number; vw: number };
    const widthMismatches: MismatchCell[] = [];
    for (let y = 0; y < rows; y++) {
      const line = active.getLine(topRow + y);
      if (!line) { lines.push(''); continue; }
      let out = '';
      let prevSgr = '';
      // Track the host-measured visible width of `out` as we go. The
      // emulator's `cell.getWidth()` is unreliable when host-rendered
      // glyph width disagrees — most commonly Nerd Font PUA icons
      // (U+E000–U+F8FF) which xterm-headless calls narrow(1) but
      // ghostty + JetBrainsMono Nerd Font draw wide(2). Trusting only
      // emulator width lets such cells overflow the modal interior
      // (visW > innerWidth in `window.modal.paint.row`), painting on
      // top of dashboard cells outside the modal frame. We instead
      // use max(emulator width, host visibleWidth) as authoritative
      // and stop short of `cols` if the next cell would overflow.
      let emittedW = 0;
      for (let x = 0; x < cols; x++) {
        const c = line.getCell(x, cellRef);
        if (!c) {
          if (emittedW + 1 > cols) break;
          out += ' ';
          emittedW += 1;
          continue;
        }
        const w = c.getWidth();
        // Width-0 cells trail a wide character — skip (the wide cell
        // already emitted the full glyph on the previous x).
        if (w === 0) continue;
        const ch = c.getChars() || ' ';
        const realW = Math.max(w, hostVisibleWidth(ch));
        // Diagnostic — tracked even when the cell ends up dropped, so
        // `preview.terminal.widthMismatch` still shows the offending
        // codepoints during development.
        if (debug.enabled && ch !== ' ') {
          const vw = hostVisibleWidth(ch);
          if (vw !== w) {
            widthMismatches.push({
              y, x, ch,
              cp: ch.codePointAt(0) ?? 0,
              advW: w, vw,
            });
          }
        }
        if (emittedW + realW > cols) break;
        const isCursor = y === curY && x === curX;
        let sgr = cellSgr(c);
        if (isCursor) {
          // Inject inverse video onto the cursor cell while preserving
          // its other attrs. `\x1b[7m` adds the inverse bit; reset at
          // the following cell via the normal sgr-change path.
          sgr = sgr ? `${sgr.slice(0, -1)};7m` : '\x1b[7m';
        }
        if (sgr !== prevSgr) {
          if (prevSgr !== '') out += '\x1b[0m';
          out += sgr;
          prevSgr = sgr;
        }
        out += ch;
        emittedW += realW;
      }
      if (prevSgr !== '') out += '\x1b[0m';
      // Pad to cols so the modal's right border `│` lands on a clean
      // cell. Without this, a host-narrow line (e.g. emulator wide(2)
      // but host narrow(1)) would leave a gap that lets a previous
      // dashboard frame leak through inside the modal interior.
      while (emittedW < cols) {
        out += ' ';
        emittedW += 1;
      }
      lines.push(out);
    }

    if (debug.enabled && widthMismatches.length > 0) {
      // Throttle: only re-emit when the set of mismatched codepoints
      // changes. Same prompt + same input → silent after the first hit.
      const sig = widthMismatches
        .map(m => `${m.y}:${m.x}:${m.cp.toString(16)}:${m.advW}:${m.vw}`)
        .join(',');
      if (sig !== this.lastWidthMismatchSig) {
        this.lastWidthMismatchSig = sig;
        debug.log('preview.terminal.widthMismatch', String(widthMismatches.length), {
          total: widthMismatches.length,
          cells: widthMismatches.slice(0, 24).map(m => ({
            y: m.y, x: m.x,
            ch: m.ch,
            cp: 'U+' + m.cp.toString(16).toUpperCase().padStart(4, '0'),
            advW: m.advW,
            vw: m.vw,
          })),
        });
      }
    }

    return lines.join('\n');
  }

  /** Scroll the viewport up by `rows` lines (towards older output).
   *  Caps at the top of the scrollback buffer. Returns the new
   *  offset so callers can decide whether to announce "at top". */
  scrollUp(rows: number = 1): number {
    const max = this.maxScrollOffset();
    this.scrollOffset = Math.min(max, this.scrollOffset + Math.max(0, rows));
    return this.scrollOffset;
  }

  /** Scroll the viewport down by `rows` lines (towards live tail).
   *  Reaching 0 = back on live tail. */
  scrollDown(rows: number = 1): number {
    this.scrollOffset = Math.max(0, this.scrollOffset - Math.max(0, rows));
    return this.scrollOffset;
  }

  /** Jump to the very top of the scrollback buffer. */
  scrollToTop(): void {
    this.scrollOffset = this.maxScrollOffset();
  }

  /** Snap back to the live tail — equivalent of tmux's `q` in copy
   *  mode. Callers usually pair this with a draw() to reflect. */
  scrollToTail(): void {
    this.scrollOffset = 0;
  }

  /** Max rows the user can scroll up. = total buffer length minus the
   *  visible viewport. 0 when there's nothing above the viewport. */
  private maxScrollOffset(): number {
    const active = this.term.buffer.active;
    return Math.max(0, active.length - this.term.rows);
  }

  /** True while the user is browsing scrollback (not at tail). */
  get isScrolledBack(): boolean { return this.scrollOffset > 0; }
  get scrollbackOffset(): number { return this.scrollOffset; }

  /** True when the child enabled any of the DECSET 1000/1002/1003
   *  mouse-tracking modes. While true, mouse events (click / wheel)
   *  should be forwarded via forwardMouse instead of being
   *  redirected to scrollback. */
  get wantsMouse(): boolean { return this.mouseMode !== 0; }

  /** Encode an absolute mouse event as SGR 1006 bytes and write to
   *  the PTY. `col` and `row` are 1-based within the emulator cell
   *  grid (caller translates absolute-terminal coords to pane-local
   *  coords first via originRow/originCol from the widget state).
   *  Wheel events only forward when buttonEvent (1002) OR
   *  anyEvent (1003) tracking is active — mode 1000 alone covers
   *  only press/release. Drag events need 1002+. */
  forwardMouse(opts: {
    type: 'click' | 'right-click' | 'scroll-up' | 'scroll-down' | 'drag' | 'release';
    col: number;
    row: number;
    shift?: boolean;
    ctrl?: boolean;
  }): void {
    if (!this.alive || this.mouseMode === 0) return;
    const seq = encodeSgrMouse(opts, this.mouseMode, this.term.cols, this.term.rows);
    if (seq === null) return;
    this.writeToChild(seq);
  }

  get isAlive(): boolean { return this.alive; }
  get cols(): number { return this.term.cols; }
  get rows(): number { return this.term.rows; }
  get pid(): number { return this.pty?.pid ?? 0; }   // registry 모드는 pid 미노출(0)

  /** Current cursor position in emulator-grid coordinates
   *  (0-indexed). Returns null while the user is scrolled back
   *  (cursor lives at the live tail, not the viewed rows) or when
   *  the PTY isn't alive. Used by interactive-terminal-modal to
   *  claim the host-OS caret so typing looks responsive. */
  cursorPosition(): { row: number; col: number } | null {
    if (!this.alive) return null;
    if (this.scrollOffset !== 0) return null;
    const active = this.term.buffer.active;
    return { row: active.cursorY, col: active.cursorX };
  }

  // ── NT-A2 — bookmark + slice (ShellRunner PTY engine support) ──
  //
  // The runner flow is: markBufferPosition() → write(command+'\n') →
  // wait for boundary → sliceFromMark(mark) → LLM result. The mark is
  // an opaque snapshot of "everything that has arrived so far"; the
  // slice gives us just the lines that showed up after. User scroll
  // history stays untouched.
  //
  // Two mark fields do the heavy lifting:
  //   • row   = active.length at mark time. Since the buffer is
  //             append-only for scrollback lines, a row recorded now
  //             stays pointing at the same historical line later.
  //   • bytes = cumulative raw utf-8 bytes read from the PTY. Lets
  //             callers detect "did anything arrive since the mark?"
  //             without scanning the grid — important for the
  //             quiet-idle boundary strategy.
  // `col` + `ts` are included for completeness and future uses
  // (e.g. slicing mid-line prompt echoes).

  /** Return a mark pinning the current buffer tail. Use immediately
   *  before injecting a command so the later slice captures only the
   *  new output.
   *
   *  `row` is the absolute line index `baseY + cursorY`. We use
   *  absolute rather than `active.length` so the mark stays valid
   *  while the viewport cursor moves around inside already-allocated
   *  rows (xterm keeps a rows-sized viewport preallocated, so
   *  `active.length` only grows once the scrollback spills). */
  markBufferPosition(): BufferMark {
    const active = this.term.buffer.active;
    return {
      row: active.baseY + active.cursorY,
      col: active.cursorX,
      ts: Date.now(),
      bytes: this.totalRawBytes,
    };
  }

  /** Number of raw bytes that have arrived since `mark`. Zero when
   *  the mark is current / nothing has been written. */
  bytesSinceMark(mark: BufferMark): number {
    return Math.max(0, this.totalRawBytes - mark.bytes);
  }

  /** Extract the text lines that were written to the buffer after
   *  `mark`. Each line is the joined cell contents of one row in the
   *  underlying xterm grid, with trailing whitespace preserved.
   *  ANSI/SGR data is stripped — callers that want SGR-preserved
   *  output should use `render()` (viewport-only) or
   *  `renderForLLM({ mark, stripSGR:false })` (slice-aware). */
  sliceFromMark(mark: BufferMark): string[] {
    const active = this.term.buffer.active;
    // End is the row *after* the current cursor row so the cursor's
    // own line is included (xterm cursorY is 0-based).
    const endAbs = active.baseY + active.cursorY + 1;
    const start = Math.min(Math.max(0, mark.row), endAbs);
    const out: string[] = [];
    const cellRef = active.getNullCell();
    for (let y = start; y < endAbs; y++) {
      const line = active.getLine(y);
      if (!line) { out.push(''); continue; }
      const text = this.rowToPlainText(line, cellRef).trimEnd();
      if (text === '' && y < endAbs - 1) continue; // drop blank interior rows
      out.push(text);
    }
    return out;
  }

  /** LLM-facing snapshot. Returns plain text — always stripped of
   *  SGR, cursor motion, line-erase CSI, and OSC title-set. Cell-
   *  level text is already plain (xterm stored color as cell attrs,
   *  not inline escapes), so the SGR strip is belt-and-braces for
   *  anything motion-strip missed. Callers that need SGR-preserved
   *  output should use `render()` (viewport-only) — re-emitting SGR
   *  from cell attrs is a `render()` concern, not an LLM-input one. */
  renderForLLM(opts: { mark?: BufferMark } = {}): string {
    const lines = opts.mark
      ? this.sliceFromMark(opts.mark)
      : this.fullBufferLines();
    const text = stripMotionSequences(lines.join('\n'));
    return stripSgrSequences(text);
  }

  /** Emit `\x1b[2J\x1b[H` to the emulator so the visible viewport
   *  clears while preserving scrollback history. Does NOT kill the
   *  running process. Callers should only use this for explicit
   *  "give me a clean slate" requests (e.g. /term clear slash);
   *  the slicing APIs above make a blanket clear unnecessary for
   *  latest-result capture. */
  clearViewport(): void {
    if (!this.alive) return;
    this.term.write('\x1b[2J\x1b[H');
    this.scheduleUpdate();
  }

  /** Convert one grid row to plain text. Shared by sliceFromMark
   *  and fullBufferLines. */
  private rowToPlainText(
    line: import('@xterm/headless').IBufferLine,
    cellRef: IBufferCell,
  ): string {
    let s = '';
    const cols = this.term.cols;
    for (let x = 0; x < cols; x++) {
      const c = line.getCell(x, cellRef);
      if (!c) { s += ' '; continue; }
      const w = c.getWidth();
      if (w === 0) continue;
      s += c.getChars() || ' ';
    }
    // Preserve trailing spaces — many tool outputs are column-
    // aligned and stripping here breaks downstream formatting. The
    // LLM prompt-level trim is the caller's concern.
    return s;
  }

  private fullBufferLines(): string[] {
    const active = this.term.buffer.active;
    const out: string[] = [];
    const cellRef = active.getNullCell();
    for (let y = 0; y < active.length; y++) {
      const line = active.getLine(y);
      if (!line) { out.push(''); continue; }
      out.push(this.rowToPlainText(line, cellRef));
    }
    return out;
  }
}

// ── NT-A2 — public types + ANSI strip helpers ─────────────────────

/** Opaque bookmark. Mirrors `BufferMark` in src/shell-runner/types
 *  so either module can describe a position. Kept here too to avoid
 *  a dependency from preview-terminal → shell-runner (outbound
 *  coupling only: shell-runner imports PreviewTerminal, not vice-
 *  versa). */
export interface BufferMark {
  row: number;
  col: number;
  ts: number;
  bytes: number;
}

/** Strip SGR (color/bold/etc) escapes. Matches a broader class than
 *  the old `stripAnsi()` in tui.ts: any CSI ending in `m`, plus the
 *  specific `\x1b[0m` reset. Exported for test + reuse. */
export function stripSgrSequences(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Strip cursor-motion + line-erase + screen-erase + save/restore
 *  + show/hide-cursor + OSC title sequences. What stays: printable
 *  text, \n, SGR. The goal is a form safe to paste into an LLM
 *  prompt without fooling the model with invisible control codes. */
export function stripMotionSequences(s: string): string {
  // CSI (single-char) — cursor motion (ABCDEFGH), ED/EL (JK), etc.
  s = s.replace(/\x1b\[[0-9;?]*[ABCDEFGHJKSTfhl]/g, '');
  // Single \r without a \n that follows — progress bars overwrite
  // with \r; we keep pairs (\r\n) intact as line terminators.
  s = s.replace(/\r(?!\n)/g, '');
  // OSC — ESC]…BEL or ESC]…ST. Title set (0/2), hyperlink (8), etc.
  s = s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  // DEC private modes not covered by CSI single-char above (e.g.
  // `\x1b[?25h`/`l` handled by [h/l] class above — redundant safety).
  return s;
}

/** Parse an OSC notification payload into {title, body}. Exported
 *  for direct unit testing; the runtime handlers call it inside a
 *  try/catch so the PTY never breaks on a malformed sequence.
 *
 *  Formats:
 *    OSC 9   — title alone (body empty)
 *              e.g. `ESC]9;Build succeeded` → title='Build succeeded'
 *    OSC 777 — `notify;<title>;<body>` (urxvt/xterm/cmux convention)
 *              e.g. `ESC]777;notify;CI;Green` → title='CI', body='Green'
 *              Fall back: if it doesn't start with `notify;`, treat
 *              the whole payload as title.
 *    OSC 99  — `key=value,key=value;body` (Kitty)
 *              Best-effort: pull d=<id> or n=<name> as title, rest
 *              as body. Falls back to whole payload as title. */
export function parseOscNotify(
  code: 9 | 99 | 777,
  raw: string,
): { code: 9 | 99 | 777; title: string; body: string; raw: string } {
  if (code === 9) {
    return { code, title: raw, body: '', raw };
  }
  if (code === 777) {
    const parts = raw.split(';');
    if (parts[0] === 'notify') {
      const title = parts[1] ?? '';
      const body = parts.slice(2).join(';');
      return { code, title, body, raw };
    }
    return { code, title: raw, body: '', raw };
  }
  // code === 99 — parse key=value list, prefer n/name/title over d.
  const semi = raw.indexOf(';');
  const meta = semi >= 0 ? raw.slice(0, semi) : raw;
  const body = semi >= 0 ? raw.slice(semi + 1) : '';
  const pairs: Record<string, string> = {};
  for (const kv of meta.split(',')) {
    const eq = kv.indexOf('=');
    if (eq < 0) continue;
    pairs[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  const title = pairs.n ?? pairs.name ?? pairs.title ?? pairs.d ?? '';
  if (title) return { code, title, body, raw };
  return { code, title: body || raw, body: body ? '' : '', raw };
}

/** Pure SGR-1006 encoder for a mouse event. Returns the escape
 *  sequence to write to the PTY, or null when the event kind isn't
 *  supported by the currently-active tracking mode (e.g. drags
 *  under DECSET 1000 only). Exported so the encoding can be unit-
 *  tested independently of the live PTY / fs plumbing. */
export function encodeSgrMouse(
  ev: {
    type: 'click' | 'right-click' | 'scroll-up' | 'scroll-down' | 'drag' | 'release';
    col: number;
    row: number;
    shift?: boolean;
    ctrl?: boolean;
  },
  mode: 0 | 1000 | 1002 | 1003,
  maxCols: number,
  maxRows: number,
): string | null {
  if (mode === 0) return null;
  let btn: number;
  switch (ev.type) {
    case 'click':        btn = 0; break;
    case 'right-click':  btn = 2; break;
    case 'drag':
      if (mode < 1002) return null; // DECSET 1000 alone doesn't ship drags
      btn = 32; break;
    case 'release':      btn = 0; break; // SGR uses lower-case suffix
    case 'scroll-up':    btn = 64; break;
    case 'scroll-down':  btn = 65; break;
    default: return null;
  }
  if (ev.shift) btn |= 4;
  if (ev.ctrl)  btn |= 16;
  const col = Math.max(1, Math.min(maxCols, Math.floor(ev.col)));
  const row = Math.max(1, Math.min(maxRows, Math.floor(ev.row)));
  const suffix = ev.type === 'release' ? 'm' : 'M';
  return `\x1b[<${btn};${col};${row}${suffix}`;
}

/** Convert one @xterm/headless cell's attributes into a leading SGR
 *  escape (`\x1b[…m`). Returns '' when the cell matches the default
 *  text attribute so render() can suppress redundant resets. */
export function cellSgr(cell: IBufferCell): string {
  if (cell.isAttributeDefault()) return '';
  const parts: string[] = [];
  if (cell.isBold()) parts.push('1');
  if (cell.isDim()) parts.push('2');
  if (cell.isItalic()) parts.push('3');
  if (cell.isUnderline()) parts.push('4');
  if (cell.isBlink()) parts.push('5');
  if (cell.isInverse()) parts.push('7');
  if (cell.isInvisible()) parts.push('8');
  if (cell.isStrikethrough()) parts.push('9');

  if (cell.isFgRGB()) {
    const c = cell.getFgColor();
    parts.push(`38;2;${(c >> 16) & 0xff};${(c >> 8) & 0xff};${c & 0xff}`);
  } else if (cell.isFgPalette()) {
    const c = cell.getFgColor();
    if (c < 16) parts.push(String(c < 8 ? 30 + c : 90 + (c - 8)));
    else parts.push(`38;5;${c}`);
  }

  if (cell.isBgRGB()) {
    const c = cell.getBgColor();
    parts.push(`48;2;${(c >> 16) & 0xff};${(c >> 8) & 0xff};${c & 0xff}`);
  } else if (cell.isBgPalette()) {
    const c = cell.getBgColor();
    if (c < 16) parts.push(String(c < 8 ? 40 + c : 100 + (c - 8)));
    else parts.push(`48;5;${c}`);
  }

  return parts.length ? `\x1b[${parts.join(';')}m` : '';
}
