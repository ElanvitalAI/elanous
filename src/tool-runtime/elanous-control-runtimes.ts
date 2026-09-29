import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { LLMToolSpec } from '../llm.js';
import { debug } from '../debug/log.js';
import { canonicalizeForBoundary, isWithinBoundary, resolveHarnessBoundary } from '../harness/harness-write-boundary.js';
import { getHarnessSpace } from '../harness/harness-space.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import {
  requestRemotePtyControl,
  type PtyControlAction,
  type PtyControlPayload,
  type PtyControlRequestOptions,
  type PtyControlResult,
} from '../pty-shell/pty-control-ipc.js';
import { resolvePtySpecialKey } from '../pty-shell/pty-special-keys.js';
import { encodeSgrMouse, type PtyMouseInput } from '../pty-shell/pty-mouse.js';
import type { ToolRuntime } from './types.js';

const PTY_ACTIONS = ['takeover', 'release', 'input-text', 'input-key', 'input-mouse', 'resize', 'snapshot', 'rename', 'terminate', 'capabilities'] as const;
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_HOLD_TIMEOUT_MS = 90_000;
const HOLD_OWNER_REGISTRATION_BUDGET_MS = 8_700;
const HOLD_DIAGNOSTIC_DRAIN_GRACE_MS = 500;
const MAX_HOLD_DIAGNOSTIC_LINES = 5;
const MAX_HOLD_DIAGNOSTIC_LINE_CHARS = 8_192;
const ELANOUS_ENTRYPOINT = resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/elanous.mjs');

type Args = Record<string, unknown>;
type HoldStream = {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  on(event: 'end' | 'error', listener: (...args: any[]) => void): unknown;
  destroy(): void;
  unref?: () => void;
};
type HoldChild = Pick<ChildProcess, 'pid' | 'unref' | 'once' | 'kill'> & { stdout: HoldStream; stderr: HoldStream };
type HoldSpawn = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: ['ignore', 'pipe', 'pipe'] }) => HoldChild;
type PtyRequest = (id: string, action: PtyControlAction, payload?: PtyControlPayload, options?: PtyControlRequestOptions) => Promise<PtyControlResult>;
type ElanousHoldResult = { output: string; ptyId: string | null; pid: number | null; cwd: string };

const productionDeps = {
  spawn: ((command, args, options) => spawn(command, args, options)) as HoldSpawn,
  requestPtyControl: requestRemotePtyControl as PtyRequest,
};
let deps = productionDeps;

/** Test-only dependency seam. A second active injection is rejected so parallel tests cannot silently replace one another's process boundary. */
export function setElanousControlDepsForTest(overrides: Partial<typeof productionDeps>): () => void {
  if (deps !== productionDeps) throw new Error('setElanousControlDepsForTest: already injected; restore the prior injection first');
  const injection = { ...productionDeps, ...overrides };
  deps = injection;
  let restored = false;
  return () => {
    if (restored || deps !== injection) return;
    restored = true;
    deps = productionDeps;
  };
}

export function buildElanousHoldTool(): LLMToolSpec {
  return {
    name: 'ElanousHold',
    description: 'Spawn a detached bare Elanous TUI held open for human control. The child inherits the current environment and runs in an owned worktree by default, or in cwd when worktree is false.',
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Working directory for the held Elanous TUI. Defaults to the current working directory.' },
        worktree: { type: 'boolean', default: true, description: 'Create the held Elanous TUI in an owned worktree. Defaults to true.' },
        timeoutMs: { type: 'integer', default: DEFAULT_HOLD_TIMEOUT_MS, description: `Milliseconds for both the child PTY readiness deadline and the outer held-line wait; the outer wait adds finite diagnostic-drain grace. Defaults to ${DEFAULT_HOLD_TIMEOUT_MS}.` },
      },
      additionalProperties: false,
    },
  };
}

export function buildPtyControlTool(): LLMToolSpec {
  return {
    name: 'PtyControl',
    description: 'Control a registered PTY through its owning process: inspect, take/release ownership, send text/key/mouse input, resize, rename, or terminate. Mouse requires enabled SGR tracking on the owning PTY.',
    parameters: {
      type: 'object',
      properties: {
        ptyId: { type: 'string', description: 'Registered PTY id.' },
        action: { type: 'string', enum: [...PTY_ACTIONS] },
        text: { type: 'string', description: 'Required for input-text as literal text, or input-key as a key name (enter, esc, tab, up, down, left, right, backspace, ctrl+c, etc.).' },
        x: { type: 'integer', description: 'Required for input-mouse; 1-based column.' },
        y: { type: 'integer', description: 'Required for input-mouse; 1-based row.' },
        kind: { type: 'string', enum: ['click', 'scroll-up', 'scroll-down'] },
        button: { type: 'string', enum: ['left', 'middle', 'right'] },
        cols: { type: 'integer', description: 'Required for resize; positive integer.' },
        rows: { type: 'integer', description: 'Required for resize; positive integer.' },
        ansi: { type: 'boolean', description: 'Optional ANSI reconstruction for snapshot.' },
        nickname: { type: 'string', description: 'Required for rename.' },
        actor: { type: 'string', enum: ['human', 'agent'], description: 'Write actor. Defaults to human.' },
        timeoutMs: { type: 'integer', description: `Remote-control timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.` },
      },
      required: ['ptyId', 'action'],
      additionalProperties: false,
    },
  };
}

export async function dispatchElanousHold(raw: Args): Promise<ElanousHoldResult> {
  const cwd = parseCwd(raw.cwd);
  const worktree = raw.worktree === undefined ? true : boolean(raw.worktree, 'worktree');
  const timeoutMs = raw.timeoutMs === undefined ? DEFAULT_HOLD_TIMEOUT_MS : positiveInteger(raw.timeoutMs, 'timeoutMs');
  const boundary = getHarnessSpace() ? resolveHarnessBoundary(process.env, cwd) : null;
  if (boundary && !isWithinBoundary(canonicalizeForBoundary(cwd), boundary)) {
    const output = `ElanousHold refused: cwd ${cwd} is outside the harness boundary ${boundary}`;
    debug.log('tool-runtime.elanous-control', 'hold', { outcome: 'refused-boundary', cwd, boundary });
    return { output, ptyId: null, pid: null, cwd };
  }
  const instanceRoot = effectiveInstanceRoot();
  const command = ['bun', ELANOUS_ENTRYPOINT, '--config-dir', instanceRoot, 'dev', '--elanous', '--hold', '--ready-timeout-ms', String(timeoutMs), ...(worktree ? ['--worktree'] : ['--cwd', cwd])];
  const child = await spawnHeldElanous(command, cwd, instanceRoot);
  return waitForHeldPty(child, { cwd, worktree, timeoutMs, instanceRoot });
}

export async function dispatchPtyControl(raw: Args): Promise<{ output: string; result: PtyControlResult }> {
  const ptyId = requiredString(raw.ptyId, 'ptyId');
  const action = parseAction(raw.action);
  const actor = raw.actor === undefined ? 'human' : parseActor(raw.actor);
  const timeoutMs = raw.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : positiveInteger(raw.timeoutMs, 'timeoutMs');
  const payload = payloadFor(action, raw);
  const result = await deps.requestPtyControl(ptyId, action, payload, { actor, timeoutMs });
  return { output: `PtyControl ptyId=${ptyId} action=${action} status=${result.status}${result.reason ? ` reason=${result.reason}` : ''}`, result };
}

async function spawnHeldElanous(command: string[], cwd: string, instanceRoot: string): Promise<HoldChild> {
  return new Promise((resolveSpawn, rejectSpawn) => {
    let child: HoldChild;
    try {
      child = deps.spawn(command[0]!, command.slice(1), {
        cwd,
        env: { ...process.env, ELANOUS_STATE_DIR: instanceRoot },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      rejectSpawn(new Error(`ElanousHold spawn failed: ${(error as Error).message}`));
      return;
    }
    child.once('error', (error) => rejectSpawn(new Error(`ElanousHold spawn failed: ${error.message}`)));
    child.once('spawn', () => resolveSpawn(child));
  });
}

function waitForHeldPty(child: HoldChild, context: { cwd: string; worktree: boolean; timeoutMs: number; instanceRoot: string }): Promise<ElanousHoldResult> {
  return new Promise((resolveResult) => {
    const lines: Array<{ value: string; sequence: number }> = [];
    const streams = new Map<HoldStream, { decoder: StringDecoder; remainder: string; remainderSequence: number | null }>([
      [child.stdout, { decoder: new StringDecoder('utf8'), remainder: '', remainderSequence: null }],
      [child.stderr, { decoder: new StringDecoder('utf8'), remainder: '', remainderSequence: null }],
    ]);
    let nextSequence = 0;
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    const endedStreams = new Set<HoldStream>();
    const pid = child.pid ?? null;
    const addLine = (line: string, sequence = nextSequence++) => {
      if (!line) return;
      lines.push({ value: line.slice(-MAX_HOLD_DIAGNOSTIC_LINE_CHARS), sequence });
      lines.sort((left, right) => left.sequence - right.sequence);
      if (lines.length > MAX_HOLD_DIAGNOSTIC_LINES) lines.shift();
    };
    const addRemainders = () => {
      for (const state of streams.values()) {
        const remainder = state.remainder + state.decoder.end();
        state.remainder = '';
        if (remainder) addLine(remainder, state.remainderSequence ?? nextSequence++);
        state.remainderSequence = null;
      }
    };
    const detach = () => {
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdout.unref?.();
      child.stderr.unref?.();
    };
    const finish = (outcome: 'held' | 'timeout' | 'exited', ptyId: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!ptyId) addRemainders();
      detach();
      if (outcome === 'held') child.unref();
      else if (!exited) child.kill('SIGTERM');
      debug.log('tool-runtime.elanous-control', 'hold', { ptyId, pid, cwd: context.cwd, worktree: context.worktree, instanceRoot: context.instanceRoot, outcome });
      if (ptyId) {
        resolveResult({ output: `ElanousHold held ptyId=${ptyId} pid=${pid ?? 'unknown'} cwd=${context.cwd}`, ptyId, pid, cwd: context.cwd });
        return;
      }
      const exit = exited ? (exitCode === null ? `signal=${exitSignal ?? 'unknown'}` : exitCode) : 'running';
      resolveResult({ output: `ElanousHold failed: no "held" line within ${context.timeoutMs}ms (exit=${exit}) · last: ${lines.map(({ value }) => value).join(' | ') || '(no output)'}`, ptyId: null, pid, cwd: context.cwd });
    };
    const consume = (stream: HoldStream, detectHeld: boolean, chunk: Buffer | string) => {
      if (settled) return;
      const state = streams.get(stream)!;
      const decoded = state.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (!decoded) return;
      if (!state.remainder) state.remainderSequence = nextSequence++;
      const complete = (state.remainder + decoded).split(/\r?\n/);
      state.remainder = complete.pop()!.slice(-MAX_HOLD_DIAGNOSTIC_LINE_CHARS);
      let sequence = state.remainderSequence;
      for (const line of complete) {
        addLine(line, sequence ?? nextSequence++);
        sequence = nextSequence++;
        const match = detectHeld && !exited ? /⛭ held (pty_[0-9a-f]+)/.exec(line) : null;
        if (match) finish('held', match[1]!);
      }
      state.remainderSequence = state.remainder ? sequence : null;
    };
    const finishExitedAfterDrain = () => {
      if (exited && endedStreams.size === streams.size) finish('exited', null);
    };
    const streamEnded = (stream: HoldStream) => {
      if (settled) return;
      endedStreams.add(stream);
      finishExitedAfterDrain();
    };
    const streamError = () => finish(exited ? 'exited' : 'timeout', null);
    // The requested child deadline starts after owner boot. Keep an independent 8,700ms boot budget (above the observed 8,698ms maximum) plus 500ms for terminal output, so even a short request can emit and drain its diagnostic before this finite safety net SIGTERMs a non-exiting child.
    const outerTimeoutMs = context.timeoutMs + HOLD_OWNER_REGISTRATION_BUDGET_MS + HOLD_DIAGNOSTIC_DRAIN_GRACE_MS;
    const timer = setTimeout(() => finish(exited ? 'exited' : 'timeout', null), outerTimeoutMs);
    child.stdout.on('data', (chunk) => consume(child.stdout, true, chunk));
    child.stderr.on('data', (chunk) => consume(child.stderr, false, chunk));
    child.stdout.on('end', () => streamEnded(child.stdout));
    child.stderr.on('end', () => streamEnded(child.stderr));
    child.stdout.on('error', streamError);
    child.stderr.on('error', streamError);
    child.once('exit', (code, signal) => {
      exited = true;
      exitCode = typeof code === 'number' ? code : null;
      exitSignal = typeof signal === 'string' ? signal : null;
      finishExitedAfterDrain();
    });
  });
}

function parseCwd(value: unknown): string {
  if (value === undefined) return process.cwd();
  if (typeof value !== 'string' || !value.trim()) throw new Error("'cwd' must be a non-empty string");
  return resolve(value);
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`'${name}' must be a boolean`);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`'${name}' must be a non-empty string`);
  return value;
}

function requiredInput(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`'${name}' must be a non-empty string`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`'${name}' must be a positive integer`);
  return value as number;
}

function parseAction(value: unknown): PtyControlAction {
  if (typeof value !== 'string' || !(PTY_ACTIONS as readonly string[]).includes(value)) {
    throw new Error(`'action' must be one of: ${PTY_ACTIONS.join(', ')}`);
  }
  return value as PtyControlAction;
}

function parseActor(value: unknown): 'human' | 'agent' {
  if (value !== 'human' && value !== 'agent') throw new Error("'actor' must be 'human' or 'agent'");
  return value;
}

function payloadFor(action: PtyControlAction, raw: Args): PtyControlPayload | undefined {
  if (action === 'input-text') return { chars: requiredInput(raw.text, 'text') };
  if (action === 'input-key') return { chars: resolvePtySpecialKey(requiredInput(raw.text, 'text')) };
  if (action === 'input-mouse') {
    const kind = raw.kind;
    const button = raw.button ?? 'left';
    if (kind !== 'click' && kind !== 'scroll-up' && kind !== 'scroll-down') throw new Error("'kind' must be click, scroll-up or scroll-down");
    if (button !== 'left' && button !== 'middle' && button !== 'right') throw new Error("'button' must be left, middle or right");
    const input: PtyMouseInput = { x: positiveInteger(raw.x, 'x'), y: positiveInteger(raw.y, 'y'), kind, button };
    encodeSgrMouse(input);
    return input;
  }
  if (action === 'resize') return { cols: positiveInteger(raw.cols, 'cols'), rows: positiveInteger(raw.rows, 'rows') };
  if (action === 'snapshot') {
    if (raw.ansi !== undefined && typeof raw.ansi !== 'boolean') throw new Error("'ansi' must be a boolean");
    return raw.ansi === true ? { ansi: true } : undefined;
  }
  if (action === 'rename') return { nickname: requiredString(raw.nickname, 'nickname') };
  return undefined;
}

export const elanousHoldRuntime: ToolRuntime<Args, ElanousHoldResult> = {
  id: 'elanous_hold',
  spec: buildElanousHoldTool(),
  run: dispatchElanousHold,
  surfaces: ['tui', 'chat', 'mcp'],
};

export const ptyControlRuntime: ToolRuntime<Args, { output: string; result: PtyControlResult }> = {
  id: 'pty_control',
  spec: buildPtyControlTool(),
  run: dispatchPtyControl,
  surfaces: ['tui', 'chat', 'mcp'],
};

export const ELANOUS_CONTROL_RUNTIMES: ReadonlyArray<ToolRuntime<any, any>> = [elanousHoldRuntime, ptyControlRuntime];
