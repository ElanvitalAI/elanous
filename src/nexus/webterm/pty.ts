// NEXUS · webterm PTY backend — registry-backed (P0b·2026-07-23).
//
// Per-tab PTY factory + interface for the webterm surface (NEXUS TUI
// webterm tabs). The production wire now goes through the shared
// registry bus (L0 substrate 척추) instead of a private dup-fd stack:
//
//     NEXUS TUI webterm tab   ← detail view (key input · screen output)
//          ↓
//     nexus/webterm/session.ts   ← per-tab session (line-ring buffer)
//          ↓
//     PtyBackend interface       ← createWebtermSpawn result
//          ↓ startPty / onPtyEvent
//     pty-shell/registry.ts      ← shared bus (id·nickname·accessMode·
//                                   bun-native openpty) — 같은 척추를 TUI·
//                                   mission·watchdog·dashboard 가 구독.
//
// History (PLAN-nexus-shell-followup 2026-05-16 · U1+U2): originated as
//   `nexus/shell/mini-terminal*`; the TUI mini-terminal was removed in T4
//   → only the webterm caller remains. Renamed mini-terminal* → pty.
//
// ★ P0b absorption (2026-07-23·실행 substrate 통합): webterm 은 자체 node-pty +
//   dup-fd pump + 사설 subscriber Set 을 소유한 **별도 PTY 스택**이었다(3-스택
//   파편의 하나). registry 로 흡수 — spawn=startPty(kind='webterm'), 출력=onPtyEvent
//   ('output') 구독(TUI·mission 과 동일 패턴). bun 의 node-pty onData-死 문제는
//   registry 의 **bun-native openpty** 가 이미 해결하므로 dup-fd 우회가 불필요해짐.
//   → 3-스택 중 하나(nexus/webterm dup-fd) 제거·정체성(id/nickname/accessMode) 획득.
//   (PWA/iOS 라이브 셸은 별개 스택 PreviewTerminal+ACP — 후속 P0b-2.)

import { requirePosixShell } from '../../platform/default-shell.js';
import { startPty as realStartPty, onPtyEvent as realOnPtyEvent } from '../../pty-shell/registry.js';
import type { StartOpts, PtyHandle, PtyEvent } from '../../pty-shell/registry.js';

import { debug } from '../../debug/log.js';
import { resolveSessionProjectContext } from '../../project/session-context.js';

// ── PtyBackend interface ─────────────────────────────────────────────

/** Backend interface — abstracts the registry PTY / a test fake. The
 *  production factory (`createRegistryBackend`) lives in this file; tests
 *  inject a fake. Consumers: `NexusWebtermSession`. */
export interface PtyBackend {
  readonly pid?: number;
  /** Subscribe to stdout/stderr chunks. Returns an unsubscribe fn. */
  onData(cb: (chunk: string) => void): () => void;
  /** Subscribe to process exit. Fires once. Returns an unsubscribe fn. */
  /** ⛔ `exitCode: null` = exited with an unlearnable code (see PtyHandle) — not 0. */
  onExit(cb: (info: { exitCode: number | null; signal?: NodeJS.Signals }) => void): () => void;
  /** Forward keystrokes / pasted text to the child stdin. */
  write(input: string): void;
  /** Resize the PTY (rows × cols). No-op for non-PTY backends. */
  resize?(rows: number, cols: number): void;
  /** Send SIGTERM (default). Caller may escalate to SIGKILL. */
  kill(signal?: NodeJS.Signals): void;
}

export interface PtyTerminationOpts {
  /** Time allowed for a cooperative SIGTERM before escalation. */
  graceMs?: number;
  /** Time allowed for SIGKILL to produce an exit observation. */
  killWaitMs?: number;
}

export type PtyTerminationResult = 'exited' | 'timeout';

/**
 * Send a cooperative termination signal and resolve only after the PTY reports
 * exit, escalating once when it does not. The exit subscription is installed
 * before either signal so a synchronous exit cannot be missed. Signal failures
 * remain soft (the registry adapter already logs them); the bounded timeout is
 * the explicit failure result for a backend that cannot confirm its exit.
 */
export function terminatePty(
  backend: PtyBackend,
  { graceMs = 1_000, killWaitMs = 1_000 }: PtyTerminationOpts = {},
): Promise<PtyTerminationResult> {
  return new Promise((resolve) => {
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    let unsubscribeWhenAvailable = false;

    const finish = (result: PtyTerminationResult) => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      if (killTimer) clearTimeout(killTimer);
      if (unsubscribe) unsubscribe();
      else unsubscribeWhenAvailable = true;
      if (result === 'timeout') {
        debug.log('nexus.pty.terminate.timeout', 'PTY did not report exit after SIGKILL', {
          level: 'error',
          pid: backend.pid,
          graceMs,
          killWaitMs,
        });
      }
      resolve(result);
    };
    const send = (signal: NodeJS.Signals) => {
      try { backend.kill(signal); } catch (err) {
        debug.log('nexus.pty.kill.error', String((err as Error)?.message ?? err), { level: 'error' });
      }
    };

    const registeredUnsubscribe = backend.onExit(() => finish('exited'));
    if (settled || unsubscribeWhenAvailable) {
      registeredUnsubscribe();
      return;
    }
    unsubscribe = registeredUnsubscribe;
    send('SIGTERM');
    if (settled) return;
    graceTimer = setTimeout(() => {
      if (settled) return;
      send('SIGKILL');
      if (settled) return;
      killTimer = setTimeout(() => finish('timeout'), killWaitMs);
      if (settled && killTimer) clearTimeout(killTimer);
    }, graceMs);
    if (settled && graceTimer) clearTimeout(graceTimer);
  });
}

export interface NodePtyBackendOpts {
  /** Absolute path to the shell binary. Defaults to `$SHELL` then `/bin/bash`. */
  shell?: string;
  /** Args passed to the shell. Defaults to `['-l', '-i']` for POSIX user shells. */
  shellArgs?: readonly string[];
  /** Working directory. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Environment. Defaults to the captured login-shell env. */
  env?: Record<string, string>;
  /** Terminal name (TERM in the child). Default `xterm-256color`. */
  termName?: string;
  /** Initial PTY dimensions. Defaults 80×24. */
  cols?: number;
  rows?: number;
}

const USER_SHELL_RE = /(^|\/)(zsh|bash|fish|sh|dash|ksh)$/;

/** Default argv for spawning a user shell (login+interactive so `.zprofile`
 *  AND `.zshrc` source). Mirrors `defaultShellArgsFor` in preview/terminal.ts. */
export function defaultShellArgsFor(shell: string): string[] {
  if (process.platform === 'win32') return [];
  if (!USER_SHELL_RE.test(shell)) return [];
  return ['-l', '-i'];
}

/** node-pty/registry report exit signal as a number; the PtyBackend
 *  interface uses NodeJS.Signals strings. Translate the common ones;
 *  unknowns drop to undefined (caller treats as "exit without signal"). */
export function signalNumberToName(n: number | undefined): NodeJS.Signals | undefined {
  if (n === undefined) return undefined;
  switch (n) {
    case 1:  return 'SIGHUP';
    case 2:  return 'SIGINT';
    case 3:  return 'SIGQUIT';
    case 9:  return 'SIGKILL';
    case 13: return 'SIGPIPE';
    case 15: return 'SIGTERM';
    default: return undefined;
  }
}

/** 테스트 주입 seam — registry 진입점(기본=실제). 유닛은 fake 를 주입해 mock.module(프로세스 전역
 *  오염) 없이 어댑터 로직을 검증. */
export interface RegistryBackendDeps {
  startPty: (opts: StartOpts) => PtyHandle;
  onPtyEvent: (cb: (ev: PtyEvent) => void) => () => void;
}

/**
 * ★ registry-backed PtyBackend (P0b) — spawn via `startPty(kind='webterm')`
 *   and adapt the shared `onPtyEvent` bus to the PtyBackend interface.
 *   사설 dup-fd pump 없음 — registry 의 bun-native openpty 가 출력을 낸다.
 *   ⚠️ pid: registry PtyHandle 은 pid 를 노출 안 함 → optional·undefined(getPid 는 undefined-safe).
 *   ⚠️ resize 인자 순서: PtyBackend.resize(rows,cols) ↔ PtyHandle.resize(cols,rows) 반대(아래 swap).
 */
export function createRegistryBackend(
  opts: NodePtyBackendOpts = {},
  deps: RegistryBackendDeps = { startPty: realStartPty, onPtyEvent: realOnPtyEvent },
): PtyBackend {
  const shell = opts.shell ?? requirePosixShell('/bin/bash');
  const args = opts.shellArgs ? [...opts.shellArgs] : defaultShellArgsFor(shell);
  const cwd = opts.cwd ?? process.cwd();
  const term = opts.termName ?? 'xterm-256color';
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;
  // env 합성은 **registry(startPty→resolveSpawnShape)가 단독 책임**진다 — captured 로그인 셸 ⊕
  // 프로세스 정체성(identityEnv) ⊕ caller overlay. 여기서 또 합성하면 이중 호출이 되고 관측
  // (`instance.identity pty-env-propagated`)도 중복된다. 그래서 **overlay 만** 넘긴다.
  // ⚠️ 전체 env dict 를 넘기면 registry 에서 caller overlay 로 취급돼 **정체성을 덮어 지운다**.
  const env = opts.env ?? { TERM: term, COLORTERM: 'truecolor' };

  const handle = deps.startPty({ cmd: shell, args, workdir: cwd, env, cols, rows, term, kind: 'webterm', accessMode: 'write' });
  const id = handle.id;

  return {
    onData(cb) {
      return deps.onPtyEvent((ev) => { if (ev.type === 'output' && ev.id === id) cb(ev.chunk); });
    },
    onExit(cb) {
      return deps.onPtyEvent((ev) => {
        if (ev.type !== 'exit' || ev.id !== id) return;
        const info: { exitCode: number | null; signal?: NodeJS.Signals } = { exitCode: ev.exitCode };
        const s = signalNumberToName(ev.signal);
        if (s) info.signal = s;
        cb(info);
      });
    },
    write(input) {
      try { handle.write(input); } catch (err) {
        debug.log('nexus.pty.write.error', String((err as Error)?.message ?? err), { level: 'error' });
      }
    },
    resize(rows, cols) {
      // ⚠️ PtyBackend.resize(rows,cols) → PtyHandle.resize(cols,rows) — 순서 반대.
      try { handle.resize(cols, rows); } catch (err) {
        debug.log('nexus.pty.resize.error', String((err as Error)?.message ?? err), { level: 'error' });
      }
    },
    kill(signal) {
      try { handle.kill(signal); } catch (err) {
        debug.log('nexus.pty.kill.error', String((err as Error)?.message ?? err), { level: 'error' });
      }
    },
  };
}

/** 웹 터미널 셸이 열릴 작업 디렉토리를 정한다(실행 맥락 SSOT: 맥락은 «한 번» 정해지고 인자로 내려간다).
 *  순서: 탭이 명시한 cwd → 대화 프로젝트 폴더 → 데몬 tool cwd → (격리 우주면) 우주 뿌리 → 프로세스 cwd.
 *  ⛔ 격리(test) 우주에서 `process.cwd()` 로 떨어지면 셸이 «사람 작업 트리»에서 열린다(🅕 실측 2026-09-26). */
export function resolveWebtermCwd(input: {
  tabCwd?: string;
  sessionId?: string;
  toolCwd?: string;
  instance: { kind: 'prod' | 'test'; root: string };
  processCwd: string;
}): { cwd: string; source: 'tab' | 'project' | 'tool-cwd' | 'isolated-root' | 'process-cwd' } {
  if (input.tabCwd) return { cwd: input.tabCwd, source: 'tab' };
  const projectCwd = resolveSessionProjectContext(input.sessionId)?.cwd;
  if (projectCwd) return { cwd: projectCwd, source: 'project' };
  if (input.toolCwd) return { cwd: input.toolCwd, source: 'tool-cwd' };
  if (input.instance.kind === 'test') return { cwd: input.instance.root, source: 'isolated-root' };
  return { cwd: input.processCwd, source: 'process-cwd' };
}

/** Build the per-tab spawn factory used by `runNexus({webtermSpawn})`.
 *  The runtime calls this once per webterm tab with `{id, cwd}` so the
 *  factory can apply per-tab overrides (e.g. tab-specific cwd). P0b:
 *  registry-backed(공유 버스). */
export function createWebtermSpawn(
  baseOpts: NodePtyBackendOpts = {},
): (perTab: { id: string; cwd?: string }) => PtyBackend {
  return (perTab) => {
    const merged: NodePtyBackendOpts = {
      ...baseOpts,
      ...(perTab.cwd ? { cwd: perTab.cwd } : {}),
    };
    return createRegistryBackend(merged);
  };
}
