import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { bunNativePtyAvailable, bunSpawnPty, type MinimalPty } from '../pty-shell/bun-native-pty.js';

export interface SeatPtyFrameSpec {
  /** Command must be a pinned local executable. Defaults to this Bun binary. */
  executable?: string;
  args?: string[];
  cwd?: string;
  runId?: string;
  rows?: number;
  cols?: number;
  now?: string;
  host?: string;
  /** Actual executable hash must match when supplied. For installed CLI checks, pass that executable explicitly. */
  expectedBinarySha256?: string;
  /** The first awaited output and one input/output transaction. */
  readyMarker?: string;
  key?: string;
  doneMarker?: string;
  timeoutMs?: number;
  artifactPath?: string;
}

export interface SeatPtyFrameEvidence {
  runId: string;
  executable: string;
  cwd: string;
  binarySha256: string;
  entrySha256: string | null;
  rows: number;
  cols: number;
  startedAt: string;
  actualHost: string;
  injectedNow: string;
  injectedHost: string;
  input: string;
  firstFrame: string;
  afterKeyFrame: string;
  exitCode: number;
  signal: number | null;
  artifactPath: string | null;
}

export interface SeatPtyFirstFrameSpec {
  /** Use the installed Bun binary and its installed JS entry, not the shell wrapper. */
  executable: string;
  entry: string;
  args?: string[];
  runId: string;
  cwd?: string;
  rows?: number;
  cols?: number;
  settleMs?: number;
  timeoutMs?: number;
  /** Wait for this visible first-screen text before considering a quiet frame complete. */
  requiredText?: string;
  expectedBinarySha256?: string;
  expectedEntrySha256?: string;
  artifactPath?: string;
}

export interface SeatPtyFirstFrameEvidence {
  runId: string;
  executable: string;
  entry: string;
  binarySha256: string;
  entrySha256: string;
  startedAt: string;
  actualHost: string;
  rows: number;
  cols: number;
  firstFrame: string;
  requiredText: string | null;
  requiredTextSeen: boolean | null;
  settleMs: number;
  quietMs: number | null;
  stopReason: 'settled' | 'timeout' | 'child-exit';
  elapsedMs: number;
  timedOut: boolean;
  stoppedByProbe: boolean;
  childExited: boolean;
  stopWaitMs: number;
  exitCode: number | null;
  signal: number | null;
  artifactPath: string | null;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Capture a markerless installed CLI's first PTY frame in an isolated HOME, then stop only that child. */
export async function observeSeatPtyFirstFrame(spec: SeatPtyFirstFrameSpec): Promise<SeatPtyFirstFrameEvidence> {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(spec.runId)) throw new Error('N03 runId must be a safe token');
  const rows = spec.rows ?? 24;
  const cols = spec.cols ?? 80;
  if (!Number.isInteger(rows) || rows < 8 || !Number.isInteger(cols) || cols < 20) throw new Error('N03 terminal size is invalid');
  const settleMs = spec.settleMs ?? 500;
  const timeoutMs = spec.timeoutMs ?? 20_000;
  if (spec.requiredText !== undefined && (spec.requiredText.length < 1 || spec.requiredText.length > 200))
    throw new Error('N03 required first-screen text is invalid');
  if (!Number.isInteger(settleMs) || settleMs < 50 || !Number.isInteger(timeoutMs) || timeoutMs < settleMs)
    throw new Error('N03 capture timing is invalid');
  const executable = resolve(spec.executable);
  const entry = resolve(spec.entry);
  const binaryPath = realpathSync(executable);
  const entryPath = realpathSync(entry);
  const binarySha256 = await sha256File(executable);
  const entrySha256 = await sha256File(entry);
  if (spec.expectedBinarySha256 && spec.expectedBinarySha256 !== binarySha256) throw new Error('N03 binary SHA mismatch');
  if (spec.expectedEntrySha256 && spec.expectedEntrySha256 !== entrySha256) throw new Error('N03 entry SHA mismatch');
  const root = mkdtempSync(join(tmpdir(), `elanous-n03-first-${spec.runId}-`));
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let pty: MinimalPty | undefined;
  let output = '';
  let lastDataAt = -1;
  let exitCode: number | null = null;
  let signal: number | null = null;
  let exited = false;
  let evidence!: SeatPtyFirstFrameEvidence;
  try {
    mkdirSync(join(root, '.elanous-test'), { recursive: true });
    writeFileSync(join(root, '.elanous-test', 'config.json'), '{"errorReports":{"enabled":false}}\n');
    const spawn = bunNativePtyAvailable() ? bunSpawnPty : (await import('node-pty')).spawn;
    const testEntry = entryPath === realpathSync(join(import.meta.dir, 'mock-seat-pty-frame-child.ts'));
    pty = spawn(executable, [entry, ...(spec.args ?? [])], {
      name: 'xterm-256color', cols, rows, cwd: spec.cwd ?? root,
      env: {
        PATH: process.env.PATH ?? '', LANG: process.env.LANG ?? 'C.UTF-8', TERM: 'xterm-256color',
        HOME: root, XDG_CONFIG_HOME: join(root, '.config'),
        XDG_DATA_HOME: join(root, '.local', 'share'), XDG_CACHE_HOME: join(root, '.cache'),
        ELANOUS_STATE_DIR: join(root, '.elanous-test'), ELANOUS_STATE_DIR_SOURCE: 'explicit',
        ...(testEntry ? { ELANOUS_UX_SIM_RUN_ID: spec.runId, ELANOUS_UX_SIM_MARKERLESS: '1' } : {}),
      },
    });
    const data = pty.onData((chunk) => { output += chunk; lastDataAt = performance.now(); });
    const exit = pty.onExit(({ exitCode: code, signal: observedSignal }) => {
      exited = true; exitCode = code; signal = observedSignal ?? null;
    });
    try {
      let stopReason: 'settled' | 'timeout' | 'child-exit' = 'timeout';
      let quietMs: number | null = null;
      while (!exited && performance.now() - started < timeoutMs) {
        quietMs = lastDataAt >= 0 ? Math.round(performance.now() - lastDataAt) : null;
        if (quietMs !== null && quietMs >= settleMs
          && (!spec.requiredText || output.includes(spec.requiredText))) {
          stopReason = 'settled';
          break;
        }
        await new Promise(resolveWait => setTimeout(resolveWait, 50));
      }
      if (exited) stopReason = 'child-exit';
      if (stopReason !== 'settled')
        quietMs = lastDataAt >= 0 ? Math.round(performance.now() - lastDataAt) : null;
      const elapsedMs = Math.round(performance.now() - started);
      evidence = {
        runId: spec.runId, executable, entry, binarySha256, entrySha256, startedAt,
        actualHost: hostname(), rows, cols, firstFrame: output,
        requiredText: spec.requiredText ?? null,
        requiredTextSeen: spec.requiredText ? output.includes(spec.requiredText) : null,
        settleMs, quietMs, stopReason, elapsedMs,
        timedOut: stopReason === 'timeout', stoppedByProbe: !exited,
        childExited: exited, stopWaitMs: 0, exitCode, signal, artifactPath: spec.artifactPath ?? null,
      };
    } finally {
      const stopStarted = performance.now();
      const probeStopped = !exited;
      if (probeStopped) pty.kill();
      const stopDeadline = performance.now() + 2_000;
      while (!exited && performance.now() < stopDeadline)
        await new Promise(resolveWait => setTimeout(resolveWait, 25));
      if (evidence) {
        evidence.stoppedByProbe = probeStopped;
        evidence.childExited = exited;
        evidence.stopWaitMs = Math.round(performance.now() - stopStarted);
        evidence.exitCode = exitCode;
        evidence.signal = signal;
      }
      data.dispose(); exit.dispose();
      if (!exited) throw new Error('N03 PTY child did not stop after probe');
    }
    if (realpathSync(executable) !== binaryPath || realpathSync(entry) !== entryPath
      || await sha256File(executable) !== binarySha256 || await sha256File(entry) !== entrySha256)
      throw new Error('N03 installed binary or entry changed during probe');
    if (spec.artifactPath) {
      mkdirSync(dirname(spec.artifactPath), { recursive: true });
      writeFileSync(spec.artifactPath, JSON.stringify(evidence, null, 2) + '\n');
    }
    return evidence;
  } finally {
    if (!exited) pty?.kill();
    rmSync(root, { recursive: true, force: true });
  }
}

/** Run a real TUI child across a real PTY with an isolated HOME/state root. A supplied cwd is recorded and may be outside that root. */
export async function mockSeatPtyFrame(spec: SeatPtyFrameSpec = {}): Promise<SeatPtyFrameEvidence> {
  const runId = spec.runId ?? randomUUID();
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(runId)) throw new Error('N03 runId must be a safe token');
  const rows = spec.rows ?? 24;
  const cols = spec.cols ?? 80;
  if (!Number.isInteger(rows) || rows < 8 || !Number.isInteger(cols) || cols < 20) throw new Error('N03 terminal size is invalid');
  const now = spec.now ?? '2026-10-22T00:00:00.000Z';
  if (!Number.isFinite(Date.parse(now))) throw new Error('N03 now must be an ISO date');
  const host = spec.host ?? 'ux-sim-host';
  if (!/^[a-zA-Z0-9.-]{1,100}$/.test(host)) throw new Error('N03 host must be a safe name');
  if (spec.executable && !spec.args) throw new Error('N03 custom executable requires explicit args');
  const executable = resolve(spec.executable ?? process.execPath);
  const args = spec.args ?? [join(import.meta.dir, 'mock-seat-pty-frame-child.ts')];
  const binarySha256 = await sha256File(executable);
  if (spec.expectedBinarySha256 && binarySha256 !== spec.expectedBinarySha256) throw new Error('N03 binary SHA mismatch');
  const entrySha256 = args[0] && /\.(?:[cm]?js|[cm]?ts)$/.test(args[0]) ? await sha256File(resolve(args[0])) : null;
  const root = mkdtempSync(join(tmpdir(), `elanous-n03-${runId}-`));
  const readyMarker = spec.readyMarker ?? `N03:READY:${runId}`;
  const doneMarker = spec.doneMarker ?? `N03:DONE:${runId}`;
  const input = spec.key ?? 'x';
  const timeoutMs = spec.timeoutMs ?? 30_000;
  const cwd = spec.cwd ?? root;
  const startedAt = new Date().toISOString();
  const actualHost = hostname();
  let pty: MinimalPty | undefined;
  let exitCode: number | null | undefined;
  let signal: number | null = null;
  try {
    // The production Bun daemon uses the native adapter: node-pty's onData is dark under Bun.
    const spawn = bunNativePtyAvailable()
      ? bunSpawnPty
      : (await import('node-pty')).spawn;
    pty = spawn(executable, args, {
      name: 'xterm-256color', cols, rows, cwd,
      env: {
        // Do not pass the operator's token-bearing environment into a mock child.
        PATH: process.env.PATH ?? '',
        LANG: process.env.LANG ?? 'C.UTF-8',
        HOME: root,
        XDG_CONFIG_HOME: join(root, '.config'),
        XDG_DATA_HOME: join(root, '.local', 'share'),
        XDG_CACHE_HOME: join(root, '.cache'),
        ELANOUS_STATE_DIR: join(root, '.elanous-test'),
        ELANOUS_STATE_DIR_SOURCE: 'explicit',
        ELANOUS_UX_SIM_RUN_ID: runId,
        ELANOUS_UX_SIM_NOW: now,
        ELANOUS_UX_SIM_HOST: host,
        HOSTNAME: host,
        TERM: 'xterm-256color',
      },
    });
    let output = '';
    let wake = () => {};
    const data = pty.onData((chunk) => { output += chunk; wake(); });
    const exit = pty.onExit(({ exitCode: code, signal: observedSignal }) => { exitCode = code; signal = observedSignal ?? null; wake(); });
    const waitUntil = async (predicate: () => boolean): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (exitCode !== undefined) throw new Error(`N03 child exited ${exitCode} before marker: ${output.slice(-500)}`);
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`N03 PTY timeout: ${output.slice(-500)}`);
        await new Promise<void>((resolveWait) => {
          const timer = setTimeout(() => { wake = () => {}; resolveWait(); }, remaining);
          wake = () => { clearTimeout(timer); wake = () => {}; resolveWait(); };
        });
      }
    };
    try {
      await waitUntil(() => output.includes(readyMarker));
      const firstFrame = output.slice(0, output.indexOf(readyMarker));
      const afterStart = output.length;
      pty.write(input);
      await waitUntil(() => output.includes(doneMarker, afterStart));
      const afterKeyFrame = output.slice(afterStart, output.indexOf(doneMarker, afterStart));
      await waitUntil(() => exitCode !== undefined);
      if (exitCode === null) throw new Error('N03 child exit code is unknown');
      const evidence: SeatPtyFrameEvidence = {
        runId, executable, cwd, binarySha256, entrySha256, rows, cols,
        startedAt, actualHost, injectedNow: now, injectedHost: host, input,
        firstFrame, afterKeyFrame, exitCode: exitCode!, signal, artifactPath: spec.artifactPath ?? null,
      };
      if (spec.artifactPath) {
        mkdirSync(dirname(spec.artifactPath), { recursive: true });
        writeFileSync(spec.artifactPath, JSON.stringify(evidence, null, 2) + '\n');
      }
      return evidence;
    } finally {
      data.dispose();
      exit.dispose();
    }
  } finally {
    if (exitCode === undefined) pty?.kill();
    rmSync(root, { recursive: true, force: true });
  }
}
