// N03 key sequence — the N03 seat PTY frame widened from «one key → one frame» to
// «a key sequence → one screen per step». Same boundaries as N03 (real PTY · isolated
// HOME/state root · scrubbed env · executable SHA), plus a headless xterm screen per step
// so a multi-turn TUI flow (`/new`, `/compact`) can be read as the user saw it.
// ⛔ Device only: it drives whatever executable it is given; it never reimplements the TUI.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Terminal } from '@xterm/headless';
import { bunNativePtyAvailable, bunSpawnPty, type MinimalPty } from '../pty-shell/bun-native-pty.js';

/** `until` matches the rendered screen text (string = substring, RegExp = test). */
export type ScreenUntil = string | RegExp | ((screen: string) => boolean);

export interface SeatPtyStep {
  label: string;
  /** Raw bytes written to the PTY (already a key: '\x1b', '\x11' …). */
  keys?: string;
  /** Typed text; with `enter` (default true) a separate '\r' follows after a short gap, like a person. */
  text?: string;
  enter?: boolean;
  /** Raw chunks written in order with `gapMs` between them (for «type while busy»). */
  chunks?: string[];
  gapMs?: number;
  until: ScreenUntil;
  timeoutMs?: number;
}

export interface SeatPtySequenceSpec {
  executable?: string;
  /** `{root}` in any arg is replaced by the isolated state root. */
  args?: string[];
  runId?: string;
  rows?: number;
  cols?: number;
  expectedBinarySha256?: string;
  /** Caller-owned root that is kept after the run (for logs/store reads). Omitted → temp, removed. */
  root?: string;
  /** Extra child env. Credential-shaped names are refused — the mock child must not bill. */
  env?: Record<string, string>;
  ready: { label: string; until: ScreenUntil; timeoutMs?: number };
  steps: SeatPtyStep[];
  /** Sent after the last step; the child must exit within `exitTimeoutMs`. Default Ctrl+Q. */
  quitKeys?: string;
  exitTimeoutMs?: number;
  artifactPath?: string;
}

export interface SeatPtySequenceFrame {
  label: string;
  input: string;
  screen: string;
  cursor: { row: number; col: number };
  at: string;
}

export interface SeatPtySequenceEvidence {
  runId: string;
  executable: string;
  args: string[];
  root: string;
  rootKept: boolean;
  binarySha256: string;
  entrySha256: string | null;
  rows: number;
  cols: number;
  startedAt: string;
  actualHost: string;
  frames: SeatPtySequenceFrame[];
  exitCode: number | null;
  signal: number | null;
  artifactPath: string | null;
}

const CREDENTIAL_ENV = /(_API_KEY|_TOKEN|_AUTH|_BASE_URL|_SECRET)$|^(ANTHROPIC|OPENAI|OPENROUTER|XAI|GROK|GEMINI|GOOGLE|CODEX|CLAUDE|AWS|BEDROCK|ELANOUS_CODEX)/i;

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function matches(until: ScreenUntil, screen: string): boolean {
  if (typeof until === 'string') return screen.includes(until);
  if (until instanceof RegExp) return until.test(screen);
  return until(screen);
}

function describeUntil(until: ScreenUntil): string {
  return typeof until === 'function' ? 'predicate' : String(until);
}

export async function mockSeatPtySequence(spec: SeatPtySequenceSpec): Promise<SeatPtySequenceEvidence> {
  const runId = spec.runId ?? randomUUID();
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(runId)) throw new Error('N03 runId must be a safe token');
  const rows = spec.rows ?? 24;
  const cols = spec.cols ?? 80;
  if (!Number.isInteger(rows) || rows < 8 || !Number.isInteger(cols) || cols < 20) throw new Error('N03 terminal size is invalid');
  if (spec.executable && !spec.args) throw new Error('N03 custom executable requires explicit args');
  if (spec.steps.length === 0) throw new Error('N03 sequence needs at least one step');
  for (const name of Object.keys(spec.env ?? {})) {
    if (CREDENTIAL_ENV.test(name)) throw new Error(`N03 refuses credential-shaped env: ${name}`);
  }
  const executable = resolve(spec.executable ?? process.execPath);
  const binarySha256 = await sha256File(executable);
  if (spec.expectedBinarySha256 && binarySha256 !== spec.expectedBinarySha256) throw new Error('N03 binary SHA mismatch');
  const rootKept = Boolean(spec.root);
  const root = spec.root ? resolve(spec.root) : mkdtempSync(join(tmpdir(), `elanous-n03-seq-${runId}-`));
  mkdirSync(root, { recursive: true });
  const args = (spec.args ?? []).map((a) => a.split('{root}').join(root));
  const entrySha256 = args[0] && /\.(?:[cm]?js|[cm]?ts)$/.test(args[0]) ? await sha256File(resolve(args[0])) : null;
  const startedAt = new Date().toISOString();
  const actualHost = hostname();
  const terminal = new Terminal({ rows, cols, scrollback: 0, allowProposedApi: true });
  let pty: MinimalPty | undefined;
  let exitCode: number | null | undefined;
  let signal: number | null = null;
  let pending = Promise.resolve();
  const frames: SeatPtySequenceFrame[] = [];
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const readScreen = async () => {
    await pending;
    const buffer = terminal.buffer.active;
    const lines = Array.from({ length: rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '');
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return { screen: lines.join('\n'), cursor: { row: buffer.cursorY + 1, col: buffer.cursorX + 1 } };
  };
  try {
    const spawn = bunNativePtyAvailable() ? bunSpawnPty : (await import('node-pty')).spawn;
    const childEnv: Record<string, string> = {
        PATH: process.env.PATH ?? '',
        LANG: process.env.LANG ?? 'C.UTF-8',
        HOME: root,
        XDG_CONFIG_HOME: join(root, '.config'),
        XDG_DATA_HOME: join(root, '.local', 'share'),
        XDG_CACHE_HOME: join(root, '.cache'),
        ELANOUS_STATE_DIR: root,
        ELANOUS_STATE_DIR_SOURCE: 'explicit',
        // Without this an elanous child re-imports provider keys from the login shell.
        ELANOUS_SKIP_LOGIN_ENV: '1',
        ELANOUS_UX_SIM_RUN_ID: runId,
        TERM: 'xterm-256color',
        ...(spec.env ?? {}),
    };
    // The check runs on the final env too, so a key added to the base above cannot slip past it.
    for (const name of Object.keys(childEnv)) {
      if (CREDENTIAL_ENV.test(name)) throw new Error(`N03 refuses credential-shaped env: ${name}`);
    }
    pty = spawn(executable, args, { name: 'xterm-256color', cols, rows, cwd: root, env: childEnv });
    const data = pty.onData((chunk) => {
      pending = pending.then(() => new Promise<void>((r) => terminal.write(chunk, r)));
    });
    const exit = pty.onExit(({ exitCode: code, signal: s }) => { exitCode = code; signal = s ?? null; });
    const capture = async (label: string, input: string, until: ScreenUntil, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const { screen, cursor } = await readScreen();
        if (matches(until, screen)) {
          frames.push({ label, input, screen, cursor, at: new Date().toISOString() });
          return;
        }
        if (exitCode !== undefined) throw new Error(`N03 child exited ${exitCode} before «${label}»\n${screen}`);
        if (Date.now() > deadline) throw new Error(`N03 timed out waiting for «${label}» (${describeUntil(until)})\n${screen}`);
        await sleep(150);
      }
    };
    try {
      await capture(spec.ready.label, '', spec.ready.until, spec.ready.timeoutMs ?? 60_000);
      for (const step of spec.steps) {
        let input = '';
        if (step.keys) { pty.write(step.keys); input += step.keys; }
        if (step.text !== undefined) {
          pty.write(step.text);
          input += step.text;
          if (step.enter !== false) { await sleep(150); pty.write('\r'); input += '\r'; }
        }
        for (const [i, chunk] of (step.chunks ?? []).entries()) {
          if (i > 0 && step.gapMs) await sleep(step.gapMs);
          pty.write(chunk);
          input += chunk;
        }
        await capture(step.label, input, step.until, step.timeoutMs ?? 60_000);
      }
      pty.write(spec.quitKeys ?? '\x11');
      const deadline = Date.now() + (spec.exitTimeoutMs ?? 10_000);
      while (exitCode === undefined && Date.now() < deadline) await sleep(100);
    } finally {
      data.dispose();
      exit.dispose();
    }
    const evidence: SeatPtySequenceEvidence = {
      runId, executable, args, root, rootKept, binarySha256, entrySha256, rows, cols, startedAt, actualHost,
      frames, exitCode: exitCode ?? null, signal, artifactPath: spec.artifactPath ?? null,
    };
    if (spec.artifactPath) {
      mkdirSync(dirname(spec.artifactPath), { recursive: true });
      writeFileSync(spec.artifactPath, JSON.stringify(evidence, null, 2) + '\n');
    }
    return evidence;
  } finally {
    if (exitCode === undefined) pty?.kill();
    terminal.dispose();
    if (!rootKept) rmSync(root, { recursive: true, force: true });
  }
}
