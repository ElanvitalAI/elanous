// PTY shell process registry.
//
// Inspired by codex's unified_exec model (codex-rs/core/src/
// unified_exec/mod.rs): one process manager holding live PTY handles
// keyed by an opaque process_id, with a head+tail buffer per process
// to keep model context bounded across long-lived runs.
//
// Differences from codex:
//   • Max 8 concurrent (codex: 64) — elanous runs single-user with
//     tighter context budgets.
//   • 256 KB head+tail (codex: ~500 KB) — same reasoning.
//   • Auto-kill on skill-runner return UNLESS the start args set
//     detach: true. Prevents zombie processes from a skill that
//     forgets to clean up.

import { existsSync } from 'node:fs';
import { requirePosixShell } from '../platform/default-shell.js';
import { randomBytes } from 'node:crypto';
import { Terminal as XtermHeadless } from '@xterm/headless';
import { trackPtyMouseOutput, forgetPtyMouseMode } from './pty-mouse.js';
import { getGlobalElementRegistry, publishElementEvent } from '../element-registry/index.js';
import { getSessionCwd } from '../session/working-dir.js';
import { buildPtyEnv } from '../agent/identity-env.js';
import { getCurrentPtyId } from '../agent/pty-identity.js';
import { bunNativePtyAvailable, bunSpawnPty } from './bun-native-pty.js';
import { resolvePtyRef, canTransitionAccessMode, ptyIdSeparatorIndex, type PtyAccessMode, type PtyTransitionPolicy } from './pty-ref.js';
import { resolveWriteDecision, resolveTakeover, type PtyWriteActor } from './pty-write-arbiter.js';
import { addPtyManifestOutputBytes, upsertPtyManifest, updatePtyManifestSnapshot, updatePtyManifestNickname, markPtyManifestClosed, removePtyManifest, touchLivePtyManifest } from './pty-manifest.js';
import { processPtyControlRequests } from './pty-control-ipc.js';
import { tapPtyOutput, autoStopPtyRecording } from './pty-recording.js';
import { forgetExternalWriteProvenance, noteExternalWrite } from './pty-write-provenance.js';
import { resolveRunIdentity } from '../harness/harness-space.js';
import { addSelfDevRunParticipant, selfDevRunsDir } from '../self-dev/run-store.js';
import { debug } from '../debug/log.js';

/**
 * ⭐⭐ 「어디서 떴나」 ⊕ 「그 값이 «어디서» 왔나」 — 둘을 «같이» 낸다(`OBS-T103`).
 *
 * 🚨 종전엔 둘 다 «없어서» 자식 PTY 가 세션 트리와 다른 자리에서 떴는지를 ***원리상 셀 수 없었다***
 *   (`pty.spawn` 100건 전수에 cwd 칸 «0개» · 2026-08-19 실측).
 * ⛔ `workdir` 만 남기면 부족하다 — 「호출자가 준 값」과 「세션 기본값으로 채운 값」이
 *   ***같은 문자열일 수 있어*** 그것으로는 fallback 여부를 못 가른다.
 */
export function spawnWorkdirObservation(opts: { workdir?: string }): { workdir: string | null; workdirSource: 'caller' | 'session-default' } {
  return {
    workdir: opts.workdir ?? null,
    workdirSource: opts.workdir === undefined ? 'session-default' : 'caller',
  };
}

export type { PtyAccessMode, PtyTransitionPolicy } from './pty-ref.js';
export type { PtyWriteActor } from './pty-write-arbiter.js';

const MAX_CONCURRENT = 8;
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 256 * 1024;
const ELIDED_MARKER = '\n[... elided middle ...]\n';
/**
 * Default PTY termination follows the same one-second grace window as
 * `terminatePty` in pty-control-ipc.ts. Only `kill()` (no caller-supplied
 * signal) escalates: an explicit signal is a caller's deliberate policy and
 * is sent once unchanged. The exit callback cancels the timer, so a normal
 * exit does not wait for escalation and a dead handle cannot be signalled.
 */
const DEFAULT_KILL_ESCALATION_TIMEOUT_MS = 1_000;

export interface PtyScreenRenderOptions {
  /** Reconstruct each xterm cell's SGR attributes for terminal-native screen inspection. */
  readonly ansi?: boolean;
}

type XtermCell = {
  getChars(): string;
  getWidth(): number;
  isAttributeDefault(): boolean;
  isFgRGB(): boolean;
  isBgRGB(): boolean;
  isFgPalette(): boolean;
  isBgPalette(): boolean;
  getFgColor(): number;
  getBgColor(): number;
  isBold(): number;
  isDim(): number;
  isItalic(): number;
  isUnderline(): number;
  isBlink(): number;
  isInverse(): number;
  isInvisible(): number;
  isStrikethrough(): number;
  isOverline(): number;
  /** Available on the xterm cell runtime; absent from the installed v5 public declaration. */
  getUnderlineStyle?: () => number;
  getUnderlineColor?: () => number;
  isUnderlineColorRGB?: () => boolean;
  isUnderlineColorPalette?: () => boolean;
  isUnderlineColorDefault?: () => boolean;
};

type XtermInternals = { _core?: { coreService?: { isCursorHidden?: boolean } } };

/** 팔레트 색을 SGR 로 낸다.
 *
 *  ⚠️⛔ **무인 리뷰 must-fix 를 반려한 자리다**(2026-08-01). 리뷰는 *"`38;5;0..15` 를 `30-37/90-97` 로
 *  축약해 P256 과 P16 을 구분하지 못한다"* 고 지적했다. ***지적 자체는 맞다*** — 그러나
 *  **xterm 셀 API 가 그 구분을 노출하지 않는다**: `31`(P16) 로 들어온 셀과 `38;5;1`(P256) 로 들어온 셀이
 *  **둘 다 `isFgPalette() === true` · `color === 1`** 로 보인다. 원본 모드를 알 수 없으므로
 *  **어느 쪽으로 내든 한쪽은 틀린다.**
 *  ⇒ 실측: 축약을 제거하니 **기존 테스트 5개가 깨졌다**(`\u001b[31m` 입력이 `38;5;1` 로 나온다).
 *  ⇒ **결정**: 저인덱스는 **P16 표기를 유지**한다(더 흔한 입력이고 기존 계약과 정합). 근본 수리는
 *  셀에 원본 모드를 싣는 것이고 **xterm 쪽 변경이라 이 층에서 못 한다** — 결손으로 남긴다. */
function addPaletteColor(codes: string[], foreground: boolean, color: number): void {
  if (color < 8) codes.push(String((foreground ? 30 : 40) + color));
  else if (color < 16) codes.push(String((foreground ? 90 : 100) + color - 8));
  else codes.push(String(foreground ? 38 : 48), '5', String(color));
}

/** 테스트 전용 노출 — 위 결정(저인덱스는 P16 표기)을 회귀로 고정한다. */
export const addPaletteColorForTest = addPaletteColor;

function addColor(codes: string[], foreground: boolean, rgb: boolean, palette: boolean, color: number): void {
  if (rgb) codes.push(String(foreground ? 38 : 48), '2', String((color >>> 16) & 255), String((color >>> 8) & 255), String(color & 255));
  else if (palette) addPaletteColor(codes, foreground, color);
}

function sgrForCell(cell: XtermCell): string {
  if (cell.isAttributeDefault()) return '';
  const codes: string[] = [];
  if (cell.isBold()) codes.push('1');
  if (cell.isDim()) codes.push('2');
  if (cell.isItalic()) codes.push('3');
  const underlineStyle = cell.getUnderlineStyle?.() ?? (cell.isUnderline() ? 1 : 0);
  if (underlineStyle) codes.push(`4:${underlineStyle}`);
  if (cell.isBlink()) codes.push('5');
  if (cell.isInverse()) codes.push('7');
  if (cell.isInvisible()) codes.push('8');
  if (cell.isStrikethrough()) codes.push('9');
  if (cell.isOverline()) codes.push('53');
  addColor(codes, true, cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor());
  addColor(codes, false, cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor());
  if (underlineStyle && cell.getUnderlineColor && cell.isUnderlineColorRGB && cell.isUnderlineColorPalette && !cell.isUnderlineColorDefault?.()) {
    const color = cell.getUnderlineColor();
    if (cell.isUnderlineColorRGB()) codes.push('58', '2', String((color >>> 16) & 255), String((color >>> 8) & 255), String(color & 255));
    else if (cell.isUnderlineColorPalette()) codes.push('58', '5', String(color));
  }
  return codes.length === 0 ? '' : `\u001b[${codes.join(';')}m`;
}

function renderAnsiLine(line: { length: number; getCell(x: number): XtermCell | undefined }): string {
  let last = -1;
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (cell && cell.getWidth() !== 0 && (cell.getChars() || !cell.isAttributeDefault())) last = x;
  }
  if (last < 0) return '';
  let current = '';
  let output = '';
  for (let x = 0; x <= last; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    const sgr = sgrForCell(cell);
    if (sgr !== current) {
      output += current ? '\u001b[0m' : '';
      output += sgr;
      current = sgr;
    }
    output += cell.getChars() || ' ';
  }
  return current ? `${output}\u001b[0m` : output;
}

export interface PtyControlTarget {
  readonly id: string;
  readonly cols?: number;
  readonly rows?: number;
  accessMode: PtyAccessMode;
  transitionPolicy: PtyTransitionPolicy;
  setAccessMode(mode: PtyAccessMode): boolean;
  isAlive(): boolean;
  /** Registry-backed PTY targets expose termination; non-PTY control targets omit it. */
  kill?(signal?: NodeJS.Signals): void;
  canWrite(actor?: PtyWriteActor): boolean;
  write(chars: string, actor?: PtyWriteActor): void;
  resize(cols: number, rows: number): void;
  /** Read-only current terminal grid. Control targets without a screen renderer omit it. */
  renderScreen?(options?: PtyScreenRenderOptions): Promise<string>;
}

export interface PtyHandle extends PtyControlTarget {
  /** 고유 id — `<kind>_<hex>`. 같은 PTY 객체를 부르는 캐논 이름. */
  readonly id: string;
  /**
   * 접근 모드(관찰 read / 인터랙션 write / 자율 auto). ⭐정책 매트릭스(§ 입력 중재):
   *  - auto+locked = 보호된 자율(brain 소유·사람 write 불가). 위험 미션 무간섭.
   *  - auto+open   = 자율이나 takeover 요청 가능(arbiter 가 brain 양보→사람 write→반환).
   *  - read+locked = 관찰 전용 영구(write 불가).
   *  - read+open   = 관찰 now·write 승격 가능.
   *  - write       = 사람 인터랙티브.
   * (지금은 필드+정책 예약 · arbiter 실장은 후속.)
   */
  accessMode: PtyAccessMode;
  /** 전환 정책(전환불가/전환허용). */
  transitionPolicy: PtyTransitionPolicy;
  /** 접근 모드 변경. transitionPolicy==='locked' 이고 다른 모드면 거부(false). 같은 모드/open 이면 true. */
  setAccessMode(mode: PtyAccessMode): boolean;
  /** 전환 정책 변경(잠금/해제). */
  setTransitionPolicy(policy: PtyTransitionPolicy): void;
  /** PTY 종류(목적) — 고유 id 접두. 예: codex·mission·self·shell·pty(기본). */
  readonly kind: string;
  /** 휴먼 리더블 닉네임 — 고유 id 와 **같은 PTY 를 부르는 다른 이름**(alias·goto 로 나중에 기억·접근). */
  nickname?: string;
  /** 닉네임 부여/변경(나중에 기억·접근 쉽게). */
  setNickname(name: string): void;
  readonly cmd: string;
  /** OS process identifier for liveness verification and process-aware callers. */
  readonly pid: number;
  readonly workdir: string | undefined;
  readonly startedAt: number;
  readonly cols: number;
  readonly rows: number;
  /** Last time the PTY produced output OR was driven (write/drain). Used
   *  for LRU eviction when the concurrency cap is hit — recently-driven
   *  PTYs (a session the user may still resume) are protected; only the
   *  oldest-untouched one is evicted. */
  readonly lastActivityAt: number;
  readonly detach: boolean;
  exitCode: number | null;
  exitSignal: number | undefined;
  isAlive(): boolean;
  /** Append captured output. Trims via head/tail strategy. */
  appendOutput(chunk: string): void;
  /** Read accumulated output since last read; clears the delta
   *  buffer. Full buffer is preserved (and trimmed) for a final
   *  read on kill. */
  drainDelta(maxBytes?: number): string;
  /** Snapshot the full head+tail buffer. */
  snapshot(): string;
  /** Send chars to the process stdin via PTY. ⭐P2 arbiter: gated by the access
   *  matrix (accessMode × actor) — a denied write is a NO-OP + observation, not
   *  a throw. Adapter errors retain their normal propagation; `actor` defaults
   *  to 'human' and autonomous drivers pass 'agent'. */
  write(chars: string, actor?: PtyWriteActor): void;
  /** ⭐P2 arbiter pre-check — would a write by `actor` be allowed under the
   *  current accessMode? Autonomous callers check this before driving. */
  canWrite(actor?: PtyWriteActor): boolean;
  /** Send a signal. Default SIGTERM, escalate to SIGKILL on timeout. */
  kill(signal?: NodeJS.Signals): void;
  /** Render the CURRENT terminal screen (the emulator's visible grid) as
   *  trailing-trimmed text, for full-screen TUIs (vim/htop) where the raw
   *  byte delta is unreadable. Async: flushes the xterm write queue first.
   *  Returns a note when the emulator is unavailable. */
  renderScreen(options?: PtyScreenRenderOptions): Promise<string>;
  /** Render the current screen as a PNG (xterm grid → SVG → PNG). Returns
   *  null when the emulator or the SVG→PNG renderer is unavailable. For
   *  VISUAL delivery — e.g. a Telegram photo attachment when the user asks
   *  to "show" the screen or the model judges an image conveys it best. */
  renderScreenPng(): Promise<Buffer | null>;
  /** Resize the PTY (cols × rows) — sends SIGWINCH so full-screen apps
   *  re-layout — and resizes the screen emulator to match. */
  resize(cols: number, rows: number): void;
}

interface PtyAdapter {
  // Subset of node-pty's IPty we need.
  pid: number;
  write(input: string): void;
  kill(signal?: string): void;
  /** Optional — node-pty IPty and bun-native MinimalPty both provide it;
   *  test-seam mocks may omit it, so callers guard with `?.`. */
  resize?(cols: number, rows: number): void;
  onData(cb: (data: string) => void): { dispose(): void };
  /** ⛔ `exitCode: null` = "exited, code unknown" — not "still running" and
   *  not 0. Read liveness from `PtyHandle.isAlive()`, never from this field. */
  onExit(cb: (e: { exitCode: number | null; signal?: number }) => void): { dispose(): void };
}

const processes = new Map<string, PtyHandle>();
interface PendingManifestOutputFlush {
  flush(now: number): boolean;
  /** throttle 이 막아 즉시 flush 하지 못한 바이트를 뒤늦게 싣기 위한 예약(멱등). */
  scheduleTrailingFlush(): void;
  close(now: number): void;
  cancel(): void;
}
const pendingManifestOutputFlushers = new Map<string, PendingManifestOutputFlush>();
const controlTargets = new Map<string, PtyControlTarget>();

// ─── Event bus (V4) ──────────────────────────────────────────────
//
// Tiny per-module observer so subscribers (pty-tail pane, watchdog,
// dashboard PTY count) can react to lifecycle + output without a
// 250ms polling timer. Not a generic bus — PTY-specific by design so
// we don't couple to the wider display/events.ts stack.
//
// Event shapes:
//   spawned  — { id } right after startPty registers the handle
//   output   — { id, chunk } every appendOutput; chunk is the delta
//   exit     — { id, exitCode, signal? } when the PTY terminates
//   stalled  — { id, silentMs } from the V5 watchdog (separate module)
//   unregistered — { id } after unregisterPty / killNonDetached
//
// Subscribers register via onPtyEvent(cb); returned disposer removes
// them. Throwing handlers are swallowed so one bad subscriber can't
// take the whole loop down.

export type PtyEvent =
  | { type: 'spawned'; id: string }
  | { type: 'output';  id: string; chunk: string }
  | { type: 'exit';    id: string; exitCode: number | null; signal?: number }
  | { type: 'stalled'; id: string; silentMs: number }
  | { type: 'write-denied'; id: string; actor: PtyWriteActor; reason: string; bytes: number }
  | { type: 'unregistered'; id: string };

type PtyEventListener = (ev: PtyEvent) => void;
const ptyListeners = new Set<PtyEventListener>();

/** Subscribe to registry events. Returns an unsubscribe function. */
export function onPtyEvent(cb: PtyEventListener): () => void {
  ptyListeners.add(cb);
  return () => { ptyListeners.delete(cb); };
}

/** Emit to all listeners; swallows throws. Exported so V5 watchdog can
 *  fire `stalled` events without owning the listener map.
 *  Also fans out into the cross-kind ElementEventBus so context.*
 *  pull tools and the state-store see PTY lifecycle transitions. */
export function emitPtyEvent(ev: PtyEvent): void {
  for (const cb of ptyListeners) {
    try { cb(ev); } catch { /* swallow */ }
  }
  switch (ev.type) {
    case 'spawned':
      publishElementEvent('pty', ev.id, 'create');
      break;
    case 'output':
      publishElementEvent('pty', ev.id, 'output', { bytes: ev.chunk.length });
      break;
    case 'exit':
      forgetPtyMouseMode(ev.id);
      publishElementEvent('pty', ev.id, 'exit', { exitCode: ev.exitCode, signal: ev.signal });
      break;
    case 'stalled':
      publishElementEvent('pty', ev.id, 'stall', { silentMs: ev.silentMs });
      break;
    case 'write-denied':
      break;
    case 'unregistered':
      forgetPtyMouseMode(ev.id);
      publishElementEvent('pty', ev.id, 'delete');
      break;
  }
  // ⭐ 외부 쓰기 출처는 «살아 있는 PTY» 에만 뜻이 있다 — 사라지면 버린다(리뷰 must-fix: 누수).
  //   ⛔ `exit` 만으로는 부족하다(detach 된 PTY 는 종료 없이 등록만 해제될 수 있다) ⇒ 둘 다 문다.
  if (ev.type === 'exit' || ev.type === 'unregistered') forgetExternalWriteProvenance(ev.id);
}

export interface StartOpts {
  /** Optional caller-minted canonical PTY id. Must match `<kind>_<8 lowercase hex>` exactly. */
  id?: string;
  cmd: string;
  args?: string[];
  workdir?: string;
  env?: Record<string, string>;
  /** 합성 «뒤»에 지울 키 — `env` 에서 뺀 키가 로그인 셸 캡처본에서 되살아나지 않게(과금 경로 스크럽 · `buildPtyEnv`). */
  unsetEnv?: readonly string[];
  shell?: string;
  cols?: number;
  rows?: number;
  detach?: boolean;
  /** PTY 종류(목적) — 고유 id 접두가 됨: `<kind>_<hex>`. 예: 'codex'·'mission'·'self'·'shell'. 기본 'pty'.
   *  [a-z0-9-]{1,16} 만 허용(그 외 'pty' 폴백). */
  kind?: string;
  /** 휴먼 리더블 닉네임 — 고유 id 와 함께 같은 PTY 를 부르는 다른 이름(나중에 goto 로 기억·접근). */
  nickname?: string;
  /** 접근 모드 초기값(관찰 read/인터랙션 write/자율 auto). 기본 'write'(미션 등 헤드리스 자율은 'auto' 지정). */
  accessMode?: PtyAccessMode;
  /** 전환 정책 초기값(전환불가 locked/전환허용 open). 기본 'open'. */
  transitionPolicy?: PtyTransitionPolicy;
  /** terminfo name passed to node-pty `name` + child `$TERM`.
   *  Defaults to `xterm-256color`. Allowlist validated via
   *  `ALLOWED_TERM_NAMES` to keep the surface conservative. */
  term?: string;
}

/** Terminfo names we consider safe to forward into node-pty +
 *  child env. If a tool caller requests something else, registry
 *  rejects rather than silently defaulting (so typos surface). */
export const ALLOWED_TERM_NAMES: ReadonlySet<string> = new Set([
  'xterm-256color',
  'xterm-ghostty',
  'xterm-kitty',
  'screen-256color',
  'tmux-256color',
]);

export const DEFAULT_TERM_NAME = 'xterm-256color';

export function startPty(opts: StartOpts): PtyHandle {
  if (!ptyAvailable()) {
    throw new Error('node-pty not installed — run `bun add node-pty`');
  }
  if (processes.size >= MAX_CONCURRENT) {
    // Lifecycle policy (2026-07-12) — NO time-based idle kill (so an idle
    // session survives indefinitely for a late resume). Bound accumulation
    // only when the cap is actually hit:
    //   1. Reap EXITED PTYs first — a finished command has no live context.
    //   2. If still full, LRU-evict the oldest-UNTOUCHED live NON-detached
    //      PTY. Recently-driven ones (resume candidates) and detached ones
    //      (explicitly persistent) are protected.
    reapExited();
    if (processes.size >= MAX_CONCURRENT) {
      const victim = evictLruCandidate();
      if (victim) {
        try { victim.kill('SIGKILL'); } catch { /* ignore */ }
        unregisterPty(victim.id);
      }
    }
    if (processes.size >= MAX_CONCURRENT) {
      throw new Error(`max ${MAX_CONCURRENT} concurrent PTY shells reached (all detached or actively driven — kill one with PtyShellKill)`);
    }
  }
  if (opts.term !== undefined && !ALLOWED_TERM_NAMES.has(opts.term)) {
    throw new Error(
      `unsupported term "${opts.term}" — allowed: ${[...ALLOWED_TERM_NAMES].join(', ')}`,
    );
  }
  const cwd = opts.workdir;
  if (cwd && !existsSync(cwd)) {
    throw new Error(`workdir does not exist: ${cwd}`);
  }
  const id = opts.id ?? mintPtyId(opts.kind);
  if (opts.id !== undefined) {
    const expectedKind = opts.kind && /^[a-z0-9-]{1,16}$/i.test(opts.kind) ? opts.kind.toLowerCase() : 'pty';
    if (!isCanonicalPtyIdForKind(id, expectedKind)) {
      throw new Error(`invalid preallocated PTY id "${id}" — expected ${expectedKind}_<8 lowercase hex>`);
    }
    if (processes.has(id)) {
      throw new Error(`PTY id already registered: ${id}`);
    }
  }
  // ⭐ Observe WHAT WE ACTUALLY EXECUTED. The 2026-07-29 exit-code hunt cost
  //    two tracks hours because the resolved argv was invisible: callers saw
  //    `{cmd:'bash', args:['-c','exit 7']}` while the child received the shell
  //    line `bash -c exit 7`. Requested vs resolved must both be on the record.
  {
    const shape = resolveSpawnShape(opts);
    debug.log('pty.spawn', 'resolved-argv', {
      requestedCmd: opts.cmd,
      requestedArgs: opts.args ?? [],
      resolvedFile: shape.file,
      resolvedArgs: shape.args,
      viaShell: shape.file !== opts.cmd,
      // ⭐⭐ 「어디서 떴나」 ⊕ 「그 값이 «어디서» 왔나」 — 둘을 «같이» 남긴다(`OBS-T103`).
      //   🚨 종전엔 둘 다 «없어서», 자식 PTY 가 세션 트리와 다른 자리에서 떴는지를
      //     ***원리상 셀 수 없었다***(pty.spawn 100건 전수에 cwd 칸 «0개» · 2026-08-19 실측).
      //   ⛔ `workdir` 만 남기면 부족하다 — 「호출자가 준 값」과 「세션 기본값으로 채운 값」이
      //     ***같은 문자열일 수 있어*** 그것으로는 fallback 여부를 못 가른다.
      ...spawnWorkdirObservation(opts),
    });
  }
  const adapter = spawnPty(opts);

  const head: string[] = [];
  let headBytes = 0;
  const tail: string[] = [];
  let tailBytes = 0;
  let delta = '';
  let exitCode: number | null = null;
  let exitSignal: number | undefined = undefined;
  let pendingManifestOutputBytes = 0;
  let manifestOutputClosed = false;
  let manifestOutputFlushCancelled = false;
  let manifestOutputRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let killEscalationTimer: ReturnType<typeof setTimeout> | null = null;
  /** ⭐ Liveness is its OWN fact, not an inference from `exitCode`.
   *  `exitCode === null` used to mean "still running", which forced the
   *  adapter to fabricate a 0 whenever a child died with no learnable code —
   *  the alternative was a dead PTY reporting itself alive forever. Splitting
   *  the two lets `exitCode: null` honestly mean "죽었지만 모름". */
  let exited = false;
  let currentCols = opts.cols ?? 80;
  let currentRows = opts.rows ?? 24;
  let lastActivityAt = Date.now();

  // Screen emulator (@xterm/headless) — parses the same byte stream the
  // head/tail buffer captures, so `renderScreen()` can return the CURRENT
  // visible grid (what a human sees) for full-screen TUIs (vim/htop) whose
  // redraws are unreadable as concatenated ANSI. Optional: if construction
  // fails the PtyShell still works, just without snapshot. Bounded to
  // MAX_CONCURRENT (8) instances.
  let term: XtermHeadless | null = null;
  try {
    term = new XtermHeadless({
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      scrollback: 1000,
      allowProposedApi: true,
    });
  } catch { term = null; }

  let nickname = opts.nickname;
  let accessMode: PtyAccessMode = opts.accessMode ?? 'write';
  let transitionPolicy: PtyTransitionPolicy = opts.transitionPolicy ?? 'open';
  const handle: PtyHandle = {
    id,
    kind: ptyKindOf(id),
    get nickname() { return nickname; },
    set nickname(v: string | undefined) { nickname = v; },
    setNickname(name: string): void {
      nickname = name.trim() || undefined;
      if (PTY_MANIFEST_ENABLED) updatePtyManifestNickname(id, nickname, Date.now());
    },
    get accessMode() { return accessMode; },
    set accessMode(v: PtyAccessMode) { accessMode = v; },
    get transitionPolicy() { return transitionPolicy; },
    set transitionPolicy(v: PtyTransitionPolicy) { transitionPolicy = v; },
    setAccessMode(mode: PtyAccessMode): boolean {
      // 정책 SSOT(canTransitionAccessMode): locked 면 다른 모드로 못 감(read+locked→write = write 불가).
      if (!canTransitionAccessMode(accessMode, mode, transitionPolicy)) return false;
      accessMode = mode;
      return true;
    },
    setTransitionPolicy(policy: PtyTransitionPolicy): void { transitionPolicy = policy; },
    cmd: opts.cmd,
    pid: adapter.pid,
    workdir: opts.workdir,
    startedAt: Date.now(),
    get cols() { return currentCols; },
    get rows() { return currentRows; },
    get lastActivityAt() { return lastActivityAt; },
    detach: opts.detach ?? false,
    get exitCode() { return exitCode; },
    set exitCode(v) { exitCode = v; },
    get exitSignal() { return exitSignal; },
    set exitSignal(v) { exitSignal = v; },
    isAlive(): boolean {
      return !exited;
    },
    appendOutput(chunk: string): void {
      lastActivityAt = Date.now();
      delta += chunk;
      trackPtyMouseOutput(id, chunk);
      // Feed the screen emulator so renderScreen() reflects live state.
      if (term) { try { term.write(chunk); } catch { /* parser hiccup — buffer still ok */ } }
      // Head: fill until cap.
      if (headBytes < HEAD_BYTES) {
        const room = HEAD_BYTES - headBytes;
        if (chunk.length <= room) {
          head.push(chunk); headBytes += chunk.length;
        } else {
          head.push(chunk.slice(0, room)); headBytes = HEAD_BYTES;
          // Overflow goes to tail.
          tail.push(chunk.slice(room));
          tailBytes += chunk.length - room;
        }
      } else {
        tail.push(chunk); tailBytes += chunk.length;
      }
      // Trim tail by dropping oldest entries.
      while (tailBytes > TAIL_BYTES && tail.length > 0) {
        const dropped = tail.shift()!;
        tailBytes -= dropped.length;
      }
    },
    drainDelta(maxBytes?: number): string {
      lastActivityAt = Date.now(); // a poll counts as driving the session
      const out = maxBytes !== undefined && delta.length > maxBytes
        ? delta.slice(0, maxBytes)
        : delta;
      delta = maxBytes !== undefined && delta.length > maxBytes
        ? delta.slice(maxBytes)
        : '';
      return out;
    },
    snapshot(): string {
      const headStr = head.join('');
      const tailStr = tail.join('');
      if (tailStr.length === 0) return headStr;
      return headStr + ELIDED_MARKER + tailStr;
    },
    canWrite(actor: PtyWriteActor = 'human'): boolean {
      return resolveWriteDecision(accessMode, actor).allow;
    },
    write(chars: string, actor: PtyWriteActor = 'human'): void {
      const decision = resolveWriteDecision(accessMode, actor);
      if (!decision.allow) {
        debug.log('pty.arbiter', 'write-denied', { id, mode: accessMode, actor, reason: decision.reason, bytes: chars.length });
        emitPtyEvent({ type: 'write-denied', id, actor, reason: decision.reason, bytes: chars.length });
        return;
      }
      adapter.write(chars);
      debug.log('pty.control', 'write', { ptyId: id, actor, mode: accessMode, bytes: chars.length });
      // ⭐⭐ 여기가 진짜 초크포인트다 — 허용 판정 뒤·바이트가 «실제로» 들어간 뒤. 모든 쓰기가
      //   이 자리로 모인다(크로스-프로세스 IPC · 같은 프로세스 감독 autoAssist · PtyShellSend).
      //   ⛔ 종전 판은 계기가 IPC 층에만 있어 ***감독의 쓰기가 계기 밖***이었다(`[S]` 리뷰가 잡았다).
      noteExternalWrite(id, actor);
      lastActivityAt = Date.now();
    },
    kill(signal?: NodeJS.Signals): void {
      if (exited) return;
      try { adapter.kill(signal ?? 'SIGTERM'); } catch { /* ignore */ }
      if (signal !== undefined || exited || killEscalationTimer) return;
      killEscalationTimer = setTimeout(() => {
        killEscalationTimer = null;
        if (exited) return;
        try { adapter.kill('SIGKILL'); } catch { /* ignore */ }
      }, DEFAULT_KILL_ESCALATION_TIMEOUT_MS);
      killEscalationTimer.unref?.();
    },
    async renderScreen(options: PtyScreenRenderOptions = {}): Promise<string> {
      if (!term) return '(screen emulator unavailable — use PtyShellPoll for raw output)';
      const t = term;
      // Flush the xterm write queue so the grid reflects every prior chunk
      // (write callbacks fire in order after the parser drains).
      await new Promise<void>(resolve => t.write('', () => resolve()));
      const active = t.buffer.active;
      const lines: string[] = [];
      for (let y = 0; y < t.rows; y++) {
        const line = active.getLine(active.viewportY + y);
        lines.push(line ? options.ansi ? renderAnsiLine(line) : line.translateToString(true) : '');
      }
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      const cursorVisible = !(t as unknown as XtermInternals)._core?.coreService?.isCursorHidden;
      const header = `[screen ${t.cols}x${t.rows} cursor=(row ${active.cursorY}, col ${active.cursorX}, visible ${cursorVisible})]`;
      return `${header}\n${lines.join('\n')}`;
    },
    async renderScreenPng(): Promise<Buffer | null> {
      if (!term) return null;
      const t = term;
      await new Promise<void>(resolve => t.write('', () => resolve()));
      try {
        // Dynamic import — keeps the (heavy · sharp-loading) screenshot
        // renderer out of registry's static graph and sidesteps any cycle.
        const { renderTerminalSvg } = await import(
          '../tool-runtime/web-terminal-screenshot.js'
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { svg } = renderTerminalSvg(t as any, { scale: 2 });
        // ★ Pango crash-safety(2026-07-26) — sharp 래스터화를 서브프로세스로 격리. 이모지 폰트 부재로 Pango 가
        //   프로세스를 하드 abort(SIGABRT·JS catch 불가) 해도 자식만 죽고 부모(데몬·self-dev)는 null(fail-soft).
        //   [[svg-png-isolated]]. renderTerminalSvg 는 순수 JS(안전)라 in-process 유지.
        const { renderSvgToPngIsolated } = await import('../capture/svg-png-isolated.js');
        return await renderSvgToPngIsolated(svg);
      } catch {
        return null;
      }
    },
    resize(cols: number, rows: number): void {
      const c = Math.max(2, Math.floor(cols));
      const r = Math.max(2, Math.floor(rows));
      // The reported size (recording headers) follows the PTY only once the adapter took it.
      try {
        if (adapter.resize) { adapter.resize(c, r); currentCols = c; currentRows = r; }
      } catch { /* ignore */ }
      if (term) { try { term.resize(c, r); } catch { /* ignore */ } }
    },
  };

  const clearManifestOutputRetry = (): void => {
    if (manifestOutputRetryTimer) clearTimeout(manifestOutputRetryTimer);
    manifestOutputRetryTimer = null;
  };
  const finishManifestOutputFlush = (): void => {
    if (!manifestOutputClosed || pendingManifestOutputBytes > 0) return;
    clearManifestOutputRetry();
    pendingManifestOutputFlushers.delete(id);
  };
  const scheduleManifestOutputRetry = (): void => {
    if (manifestOutputFlushCancelled || manifestOutputRetryTimer || pendingManifestOutputBytes <= 0) return;
    manifestOutputRetryTimer = setTimeout(() => {
      manifestOutputRetryTimer = null;
      flushManifestOutputBytes(Date.now());
    }, PTY_MANIFEST_OUTPUT_RETRY_MS);
    manifestOutputRetryTimer.unref?.();
  };
  /** Commit the pending output captured before this call. New output is retained if it arrives while the DB write runs. */
  const flushManifestOutputBytes = (now: number): boolean => {
    if (manifestOutputFlushCancelled) return true;
    const bytesToFlush = pendingManifestOutputBytes;
    if (bytesToFlush <= 0) {
      finishManifestOutputFlush();
      return true;
    }
    if (!addPtyManifestOutputBytes(id, bytesToFlush, now)) {
      debug.log('pty.manifest', 'output-bytes-flush-retry', { id, pendingBytes: pendingManifestOutputBytes, closed: manifestOutputClosed });
      scheduleManifestOutputRetry();
      return false;
    }
    pendingManifestOutputBytes -= bytesToFlush;
    debug.log('pty.manifest', 'output-bytes-flushed', { id, bytes: bytesToFlush, pendingBytes: pendingManifestOutputBytes, closed: manifestOutputClosed });
    finishManifestOutputFlush();
    return true;
  };
  const manifestOutputFlush: PendingManifestOutputFlush = {
    flush: flushManifestOutputBytes,
    scheduleTrailingFlush: scheduleManifestOutputRetry,
    close(now: number): void {
      manifestOutputClosed = true;
      if (!flushManifestOutputBytes(now)) scheduleManifestOutputRetry();
    },
    cancel(): void {
      manifestOutputFlushCancelled = true;
      clearManifestOutputRetry();
      pendingManifestOutputBytes = 0;
    },
  };

  pendingManifestOutputFlushers.set(id, manifestOutputFlush);

  adapter.onData(chunk => {
    handle.appendOutput(chunk);
    try { tapPtyOutput(id, chunk); }
    catch (error) { debug.log('pty.record', 'tap-error', { ptyId: id, error: String(error) }); }
    emitPtyEvent({ type: 'output', id, chunk });
    // ★ 크로스-프로세스 관측(2026-07-23) — throttled 스냅샷을 공유 매니페스트에(데몬 PWA 유니온). getter 라 throttle 통과 시에만 snapshot().
    if (PTY_MANIFEST_ENABLED) {
      pendingManifestOutputBytes += Buffer.byteLength(chunk, 'utf8');
      const now = Date.now();
      // ⛔⭐ throttle 이 막은 출력도 «반드시» 실린다 — 안 그러면 마지막 버스트 뒤 조용해진 PTY 의
      //   바이트가 영영 안 실려 총합이 «영구 과소»가 된다(리뷰 must-fix). 그리고 그 조용해진 PTY 가
      //   바로 이 카운터가 재려던 대상이라, 그 결손은 이 값의 «존재 이유»를 무너뜨린다.
      //   ⇒ throttle 통과면 즉시 flush, 막히면 trailing flush 를 «예약»한다(새 주기 타이머가 아니라
      //     이미 있는 재시도 예약을 재사용 — 예약은 pendingBytes>0 일 때만 서고 flush 되면 스스로 걷힌다).
      if (updatePtyManifestSnapshot(id, () => handle.snapshot(), now)) manifestOutputFlush.flush(now);
      else manifestOutputFlush.scheduleTrailingFlush();
    }
  });
  adapter.onExit(({ exitCode: code, signal }) => {
    // ⭐ Mark death from the FACT that the adapter fired, never from the code
    //    (which may legitimately be null — "죽었지만 모름").
    exited = true;
    if (killEscalationTimer) clearTimeout(killEscalationTimer);
    killEscalationTimer = null;
    exitCode = code;
    exitSignal = signal;
    try { autoStopPtyRecording(id); }
    catch (error) { debug.log('pty.record', 'auto-stop-error', { ptyId: id, error: String(error) }); }
    emitPtyEvent({ type: 'exit', id, exitCode: code, signal });
    if (PTY_MANIFEST_ENABLED) {
      const now = Date.now();
      // Manifest closure and output durability are separate: a closed row keeps retrying trailing bytes until committed.
      manifestOutputFlush.close(now);
      markPtyManifestClosed(id, code, now);
    }
  });

  processes.set(id, handle);
  getGlobalElementRegistry().register('pty', id, { kind: 'pty', id });
  // ★ 크로스-프로세스 관측 — startPty 를 공유 매니페스트에 등록(다른 프로세스 데몬이 /v1/terminals 로 봄). fail-soft.
  //   ⚠️ 테스트 런(NODE_ENV=test·bun test)은 skip — 테스트가 띄우는 임시 셸(self-implement gate·CI·수동 bun test)이
  //   운영 매니페스트(~/.elanous/pty)로 새어들어 관측소를 오염시키던 근본 차단(격리). 실 세션(NODE_ENV≠test)만 등록.
  if (PTY_MANIFEST_ENABLED) {
    const childSpaceId = opts.env?.ELANOUS_HARNESS_SPACE_ID;
    const childParentPtyId = opts.env?.ELANOUS_PARENT_PTY_ID ?? getCurrentPtyId();
    const childController = opts.env?.ELANOUS_CONTROLLER?.trim();
    const childNestDepth = opts.env?.ELANOUS_NEST_DEPTH;
    const parsedChildNestDepth = childNestDepth !== undefined && /^\d+$/.test(childNestDepth)
      ? Number(childNestDepth)
      : undefined;
    const childIdentityNestDepth = parsedChildNestDepth !== undefined
      && Number.isFinite(parsedChildNestDepth)
      && Number.isInteger(parsedChildNestDepth)
      && BigInt(parsedChildNestDepth) === BigInt(childNestDepth!)
      ? parsedChildNestDepth
      : undefined;
    upsertPtyManifest({
      id, kind: handle.kind, cmd: handle.cmd, ptyPid: adapter.pid,
      ...(handle.nickname ? { nickname: handle.nickname } : {}),
      ...(handle.workdir ? { workdir: handle.workdir } : {}),
      startedAt: handle.startedAt, now: Date.now(),
      identity: {
        ...(childSpaceId === undefined ? {} : { spaceId: childSpaceId }),
        ...(childParentPtyId === undefined ? {} : { parentPtyId: childParentPtyId }),
        ...(childController ? { controller: childController } : {}),
        ...(childIdentityNestDepth === undefined ? {} : { nestDepth: childIdentityNestDepth }),
        parentPid: process.pid,
      },
    });
    const { runId, source: runIdSource } = resolveRunIdentity();
    if (runIdSource === 'inherited') {
      const participant = { id, kind: 'pty' as const, transports: [{ kind: 'pty' as const, id }], registeredAt: Date.now(), runIdSource };
      const localDir = selfDevRunsDir();
      addSelfDevRunParticipant(runId, participant, localDir);
      const parentDir = process.env.ELANOUS_PARENT_SELF_DEV_RUNS_DIR;
      const parentRegistered = parentDir !== undefined && parentDir !== localDir;
      if (parentRegistered) addSelfDevRunParticipant(runId, participant, parentDir);
      debug.log('pty-shell.registry', 'run-participant-registered', { runId, ptyId: id, directories: parentRegistered ? [localDir, parentDir] : [localDir] });
    }
    ensurePtyManifestHeartbeat();   // ★ 라이브 하트비트 시작(유휴 라이브 셸이 stale reap 에 오제거되지 않게)
  }
  emitPtyEvent({ type: 'spawned', id });
  return handle;
}

/** 공유 PTY 매니페스트 등록 활성 여부 — 테스트 런(bun test=NODE_ENV=test)은 운영 매니페스트 오염 방지 위해 off. */
const PTY_MANIFEST_ENABLED = process.env.NODE_ENV !== 'test';

// ★ 라이브 PTY 하트비트(2026-07-23) — 소유 프로세스가 자기 라이브 PTY 의 updated_at 을 주기 갱신해
//   "살아있음"을 증명한다. 데몬의 stale reap 이 하트비트 끊긴 유령만 제거하도록(pid 재활용 견고). unref 로 프로세스 종료 방해 X.
const PTY_MANIFEST_HEARTBEAT_MS = 15_000;
const PTY_MANIFEST_OUTPUT_RETRY_MS = 100;
const PTY_CONTROL_POLL_MS = 25;
let _ptyHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let _ptyControlTimer: ReturnType<typeof setInterval> | null = null;
function ensurePtyManifestHeartbeat(): void {
  // ⚠️두 타이머를 **독립 ensure** — 하나가 alive=0 로 자기정지해도 새 PTY spawn 시 그것만 재시작한다.
  //   맨 앞 공통 guard(if _ptyHeartbeatTimer return)로 묶으면, control 이 먼저 정지하고 heartbeat 만
  //   남은 순간 재호출 시 조기반환하여 control 폴러가 **영구 미배선**된다(review must-fix). 각 개별 가드.
  if (!_ptyHeartbeatTimer) {
    _ptyHeartbeatTimer = setInterval(() => {
      try {
        const liveIds = new Set([...processes.values()].filter((h) => h.isAlive()).map((h) => h.id));
        if (liveIds.size === 0) { if (_ptyHeartbeatTimer) { clearInterval(_ptyHeartbeatTimer); _ptyHeartbeatTimer = null; } return; }
        touchLivePtyManifest(liveIds, Date.now());
      } catch { /* fail-soft */ }
    }, PTY_MANIFEST_HEARTBEAT_MS);
    _ptyHeartbeatTimer.unref?.();
  }
  if ([...processes.values()].some((h) => h.isAlive())) startPtyControlPoller();
}

/** Register a non-child process terminal as a control target. The target is
 * deliberately separate from spawned PTYs: it has no child lifecycle. */
export function registerPtyControlTarget(handle: PtyControlTarget): () => void {
  controlTargets.set(handle.id, handle);
  // The self-reporting foreground TUI owns its stdout. The mirror installed later
  // delegates through this tap, preserving its existing output and overlay path.
  const stream = process.stdout;
  const previousWrite = stream.write;
  let tappedWrite: typeof stream.write | undefined;
  if (handle.id.startsWith('tui:')) {
    // Streaming decode: a multibyte character split across two Buffer writes stays intact.
    const decoder = new TextDecoder('utf-8');
    tappedWrite = function (this: typeof stream, ...args: Parameters<typeof stream.write>) {
      const chunk = args[0];
      if (chunk !== undefined) {
        try { tapPtyOutput(handle.id, typeof chunk === 'string' ? chunk : decoder.decode(chunk as Uint8Array, { stream: true })); }
        catch (error) { debug.log('pty.record', 'tap-error', { ptyId: handle.id, error: String(error) }); }
      }
      return previousWrite.apply(this, args);
    } as typeof stream.write;
    stream.write = tappedWrite;
  }
  return () => {
    if (controlTargets.get(handle.id) !== handle) return;
    try { autoStopPtyRecording(handle.id); }
    catch (error) { debug.log('pty.record', 'auto-stop-error', { ptyId: handle.id, error: String(error) }); }
    controlTargets.delete(handle.id);
    if (tappedWrite && stream.write === tappedWrite) stream.write = previousWrite;
  };
}

/** Run the existing cross-process control protocol for live targets. This
 * shared poller is usable by self-reporting TUIs as well as spawned PTYs. */
export function startPtyControlPoller(): () => void {
  if (!_ptyControlTimer) {
    _ptyControlTimer = setInterval(() => {
      try {
        if (![...processes.values(), ...controlTargets.values()].some((h) => h.isAlive())) {
          if (_ptyControlTimer) { clearInterval(_ptyControlTimer); _ptyControlTimer = null; }
          return;
        }
        processPtyControlRequests(getPtyControlTarget, requestPtyTakeover);
      } catch (e) { debug.log('pty.takeover', 'poller-error', { error: (e as Error).message }); }
    }, PTY_CONTROL_POLL_MS);
    _ptyControlTimer.unref?.();
  }
  return () => {
    if (![...processes.values(), ...controlTargets.values()].some((h) => h.isAlive()) && _ptyControlTimer) {
      clearInterval(_ptyControlTimer);
      _ptyControlTimer = null;
    }
  };
}

export function getPtyControlTarget(id: string): PtyControlTarget | undefined {
  return processes.get(id) ?? controlTargets.get(id);
}

export function getPty(id: string): PtyHandle | undefined {
  return processes.get(id);
}

export function listPty(): PtyHandle[] {
  return [...processes.values()];
}

/** 닉네임 부여/변경 — 나중에 goto 로 기억·접근 쉽게. 없는 id 면 false. */
export function renamePty(id: string, nickname: string): boolean {
  const h = getPty(id);
  if (!h) return false;
  h.setNickname(nickname);
  return true;
}

/** ref(고유 id 또는 닉네임 = 같은 객체의 다른 이름)를 라이브 PTY 로 해석. 유일 매치만 반환(없음/모호=null). */
export function resolvePtyLive(ref: string): PtyHandle | null {
  const items = listPty().map((h) => ({ id: h.id, kind: h.kind, ...(h.nickname ? { nickname: h.nickname } : {}) }));
  const res = resolvePtyRef(ref, items);
  return res.match ? getPty(res.match.id) ?? null : null;
}

/**
 * 접근 모드 변경(관찰 read ↔ 인터랙션 write ↔ 자율 auto). 정책(§ 입력 중재):
 * - `auto`  = 컨트롤러/brain 이 write 소유(헤드리스 자율 미션). 사람 attach 는 read.
 * - `read`  = 관찰 전용(입력 주입 없음).
 * - `write` = 사람 인터랙티브 소유(입력 허용).
 * takeover(read→write)는 요청 — auto 소유 중이면 arbiter 가 auto 를 양보/일시정지시킨 뒤 사람에게 write.
 * ⭐P2: write 경로가 이 매트릭스를 집행한다(pty-write-arbiter). takeover 는 requestPtyTakeover.
 */
export function setPtyAccessMode(id: string, mode: PtyAccessMode): boolean {
  const h = getPty(id);
  if (!h) return false;
  h.setAccessMode(mode);
  return true;
}

/**
 * ⭐P2 소유권 takeover — `actor`(human/agent)가 write 제어를 요청한다. 정책 SSOT
 * (canTransitionAccessMode via resolveTakeover): auto+locked(보호된 자율)·read+locked(관찰 영구)는
 * 거부, open 이면 소유 모드로 전환(human→write · agent→auto)한다. 반환=허용됐나. 관측 동봉.
 * = herdr `--takeover`(배타 writable owner 교체)의 access-matrix 판.
 */
export function requestPtyTakeover(id: string, actor: PtyWriteActor): boolean {
  const h = getPtyControlTarget(id);
  if (!h) return false;
  const d = resolveTakeover(h.accessMode, h.transitionPolicy, actor);
  if (!d.allow || !d.newMode) {
    // 항상-활성 관측 — 소유권 이양은 드물고 안전-핵심이라 게이트 없이 남긴다.
    debug.log('pty.arbiter', 'takeover-denied', { id, from: h.accessMode, policy: h.transitionPolicy, actor, reason: d.reason });
    return false;
  }
  const from = h.accessMode;
  const ok = h.setAccessMode(d.newMode);
  if (ok) debug.log('pty.arbiter', 'takeover', { id, from, to: d.newMode, actor, reason: d.reason });
  return ok;
}

/** Remove a process from the registry. Does NOT kill it — the caller
 *  may want to leave the PTY running (detach mode). */
export function unregisterPty(id: string): boolean {
  const existed = processes.delete(id);
  if (existed) {
    try { autoStopPtyRecording(id); }
    catch (error) { debug.log('pty.record', 'auto-stop-error', { ptyId: id, error: String(error) }); }
    const outputFlush = pendingManifestOutputFlushers.get(id);
    outputFlush?.flush(Date.now());
    outputFlush?.cancel();
    pendingManifestOutputFlushers.delete(id);
    getGlobalElementRegistry().unregister('pty', id);
    emitPtyEvent({ type: 'unregistered', id });
    removePtyManifest(id);   // ★ 공유 매니페스트에서 제거(크로스-프로세스 관측 정리)
  }
  return existed;
}

/** Reap EXITED PTYs (a finished command holds no live context) — unregister
 *  every handle whose process is no longer alive. Returns the count reaped.
 *  Called when the concurrency cap is hit (lazy reclaim, no timer) and
 *  exposed for the watchdog to purge proactively. */
export function reapExited(): number {
  const dead: string[] = [];
  for (const [id, h] of processes) if (!h.isAlive()) dead.push(id);
  for (const id of dead) unregisterPty(id);
  return dead.length;
}

/** Pick the LRU eviction victim: the live, NON-detached PTY with the oldest
 *  `lastActivityAt`. Detached PTYs (explicitly persistent) are never chosen.
 *  Returns undefined when every live handle is detached. */
function evictLruCandidate(): PtyHandle | undefined {
  let victim: PtyHandle | undefined;
  for (const h of processes.values()) {
    if (h.detach || !h.isAlive()) continue;
    if (!victim || h.lastActivityAt < victim.lastActivityAt) victim = h;
  }
  return victim;
}

/** Auto-kill non-detached PTYs. Called by skill-runner at end of
 *  executeSkill so a forgotten REPL doesn't leak. */
export function killNonDetached(): number {
  let killed = 0;
  for (const [id, handle] of [...processes.entries()]) {
    if (handle.detach) continue;
    if (handle.isAlive()) {
      try { handle.kill('SIGTERM'); killed++; } catch { /* ignore */ }
    }
    // The adapter's later onExit owns recording closure (including trailing bytes).
    // Keep a failed trailing-output flush retryable until then.
    pendingManifestOutputFlushers.get(id)?.flush(Date.now());
    processes.delete(id);
    getGlobalElementRegistry().unregister('pty', id);
    emitPtyEvent({ type: 'unregistered', id });
  }
  return killed;
}

/** Probe-compatible. Under Bun the native PTY (Bun.spawn terminal) is
 *  used instead of node-pty, so PTY is available even if node-pty can't
 *  resolve. Under node we still require node-pty. */
export function ptyAvailable(): boolean {
  if (bunNativePtyAvailable()) return true;
  try { require.resolve('node-pty'); return true; } catch { return false; }
}

// ─── Adapter wiring ──────────────────────────────────────────────

let cachedSpawn: ((opts: StartOpts) => PtyAdapter) | null | undefined = undefined;

/** Resolve the (file, args, env, term, cwd) tuple shared by both PTY
 *  backends. `direct` = single executable path with no shell
 *  metacharacters → spawn it directly; otherwise wrap in `sh -c`. */
/** ★ 테스트 노출(P0.5) — spawn 직전 최종 env 합성 결과를 검증하기 위해 export.
 *  `buildPtyEnv` 배선을 되돌리면 여기 반환 env 에서 정체성이 사라지므로 회귀가 잡힌다. */
/** Single-quote a literal argument for a `sh -c` line. Embedded quotes are
 *  closed, escaped, and reopened — the POSIX-safe form. Used only on the
 *  shell fallback path; the direct-spawn path needs no quoting at all. */
function shQuoteArg(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

export function resolveSpawnShape(o: StartOpts): {
  file: string;
  args: string[];
  term: string;
  env: Record<string, string>;
  cwd: string;
  cols: number;
  rows: number;
} {
  // ⭐⭐ Tokenized `args` mean the caller ALREADY decided the argument
  // boundaries. Joining them back into a shell line destroys those
  // boundaries — 2026-07-29 实測: `{cmd:'bash', args:['-c','exit 7']}`
  // became the shell line `bash -c exit 7`, i.e. `exit` with `$0=7`, and
  // an argument-less `exit` returns the PREVIOUS command's status (0).
  // The child then reported a truthful `exitCode 0` for a command we never
  // meant to run, and two tracks read that 0 as "completed cleanly".
  // ⇒ When args are present, spawn the program directly.
  // ⭐⭐ ONE contract, THREE cases — stated exactly, because an earlier
  //    two-line summary of it ("`{cmd}` alone → a shell line") read as a
  //    promise that EVERY bare cmd goes through a shell, and a reviewer
  //    correctly called that out as contradicted by the code (4R).
  //   ① `{cmd, args:[…]}`      → TOKENS. Spawn directly. Never re-join.
  //   ② `{cmd}` with shell syntax → a shell LINE. `sh -c <line>`.
  //   ③ `{cmd}` bare and plain   → spawn directly (no shell to pay for).
  // ⚠️ ③ is NOT new — it is what this function always did, and it is why a
  //    shell BUILTIN passed as a bare cmd (`{cmd:'cd'}`) has never worked
  //    here. Changing that is a separate decision, not part of this fix.
  // ⛔ Callers must NOT pre-quote tokens: quoting is a shell concern and the
  //    token path has no shell. (Pre-quoting used to be required here and is
  //    now removed from every caller — see headless-elanous-driver / spawn-
  //    coding-agent-headless.)
  const hasArgs = (o.args?.length ?? 0) > 0;
  const cmdHasShellSyntax = /[ \t|&;<>$`(){}[\]"'\\*?]/.test(o.cmd);
  const direct = hasArgs || !cmdHasShellSyntax;
  const file = direct ? o.cmd : (o.shell ?? requirePosixShell());
  // Shell path: `o.cmd` is intentionally a shell LINE (keep it raw), but any
  // extra args are literal values — quote them so their boundaries survive.
  const args = direct
    ? (o.args ?? [])
    : ['-c', [o.cmd, ...(o.args ?? []).map(shQuoteArg)].join(' ')];
  const term = o.term ?? DEFAULT_TERM_NAME;
  // F3 (2026-04-21) — use the login-shell env captured at startup instead
  // of `process.env`, so `.zprofile`-only PATH extensions (e.g.
  // `/opt/homebrew/bin` via `brew shellenv`) are present before the
  // child's `.zshrc` runs. Falls back to `process.env` if capture failed.

  // COLORTERM=truecolor — captured env strips COLORTERM in the seed phase,
  // and SSH does not forward it by default, so prompt themes fall back to
  // 16-color. xterm.js accepts 24-bit, so claiming truecolor is safe.
  // Caller's explicit `o.env.COLORTERM` still wins.
  const env = buildPtyEnv({
    COLORTERM: 'truecolor',
    ...(o.env ?? {}),
    TERM: term,
  }, process.env, { unset: o.unsetEnv });
  return {
    file,
    args,
    term,
    env,
    // WD5 — new PTY spawns pick up the current session working directory.
    cwd: o.workdir ?? getSessionCwd(),
    cols: o.cols ?? 80,
    rows: o.rows ?? 24,
  };
}

function spawnPty(opts: StartOpts): PtyAdapter {
  if (cachedSpawn === null) throw new Error('node-pty unavailable');
  if (cachedSpawn === undefined) {
    // Bun runtime: node-pty's napi bindings deliver no PTY data under Bun
    // (onData never fires — oven-sh/bun#7362 · node-pty#632, both WONTFIX).
    // Use Bun's native PTY (Bun.spawn terminal, POSIX openpty). See
    // ./bun-native-pty.ts.
    if (bunNativePtyAvailable()) {
      cachedSpawn = (o: StartOpts) => {
        const s = resolveSpawnShape(o);
        return bunSpawnPty(s.file, s.args, {
          name: s.term, cols: s.cols, rows: s.rows, cwd: s.cwd, env: s.env,
        }) as PtyAdapter;
      };
      return cachedSpawn(opts);
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
      const pty: any = require('node-pty');
      cachedSpawn = (o: StartOpts) => {
        const s = resolveSpawnShape(o);
        return pty.spawn(s.file, s.args, {
          name: s.term,
          cols: s.cols,
          rows: s.rows,
          cwd: s.cwd,
          env: s.env,
        }) as PtyAdapter;
      };
    } catch {
      cachedSpawn = null;
      throw new Error('node-pty unavailable');
    }
  }
  return cachedSpawn(opts);
}

/** Mint a canonical PTY id before spawn so the child can receive its identity in env. */
export function mintPtyId(kind?: string): string {
  const k = kind && /^[a-z0-9-]{1,16}$/i.test(kind) ? kind.toLowerCase() : 'pty';
  return `${k}_${randomBytes(4).toString('hex')}`;
}

/** Canonical PTY ids accept historical underscores and future hyphens with the same kind and random-byte format. */
function isCanonicalPtyIdForKind(id: string, kind: string): boolean {
  const separator = id[kind.length];
  const suffix = id.slice(kind.length + 1);
  return id.startsWith(kind)
    && (separator === '_' || separator === '-')
    && /^[0-9a-f]{8}$/.test(suffix);
}

/** 고유 id 에서 kind 접두 파싱(`codex_a3f2`·`codex-a3f2`→'codex'). 구분자 없으면 'pty'. */
export function ptyKindOf(id: string): string {
  const i = ptyIdSeparatorIndex(id);
  return i > 0 ? id.slice(0, i) : 'pty';
}

// ─── Test seam ──────────────────────────────────────────────────

/** Override the spawn adapter so tests can inject a synthetic PTY
 *  without requiring the native node-pty build. Pass null to restore. */
export function setPtyAdapterForTesting(spawnFn: ((opts: StartOpts) => PtyAdapter) | null): void {
  cachedSpawn = spawnFn ?? undefined;
}

/** Reset registry (for tests). Sends SIGKILL to anything still running.
 *  Also clears event listeners so cross-test subscriptions don't leak. */
export function resetForTesting(): void {
  const registry = getGlobalElementRegistry();
  for (const handle of processes.values()) {
    if (handle.isAlive()) try { handle.kill('SIGKILL'); } catch { /* ignore */ }
    try { autoStopPtyRecording(handle.id); }
    catch (error) { debug.log('pty.record', 'auto-stop-error', { ptyId: handle.id, error: String(error) }); }
    forgetPtyMouseMode(handle.id);
    const outputFlush = pendingManifestOutputFlushers.get(handle.id);
    outputFlush?.flush(Date.now());
    outputFlush?.cancel();
    registry.unregister('pty', handle.id);
  }
  processes.clear();
  pendingManifestOutputFlushers.clear();
  controlTargets.clear();
  if (_ptyControlTimer) clearInterval(_ptyControlTimer);
  _ptyControlTimer = null;
  ptyListeners.clear();
}
