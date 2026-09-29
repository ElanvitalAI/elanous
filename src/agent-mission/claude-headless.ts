import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type ClaudeHeadlessResult = {
  ok: boolean;
  reason: 'success' | 'no-result' | 'cli-error' | 'result-error' | 'timeout' | 'spawn-error';
  exitCode: number | null;
  result: string | null;
  subtype: string | null;
  sessionId: string | null;
  isError: boolean | null;
  numTurns: number | null;
  durationMs: number | null;
  durationApiMs: number | null;
  totalCostUsd: number | null;
  usage: Record<string, unknown> | null;
  toolEvents: number;
  malformedLines: number;
};

type Spawn = (command: string, args: string[], options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ['pipe', 'pipe', 'pipe'];
}) => ChildProcessWithoutNullStreams;

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const string = (value: unknown): string | null => typeof value === 'string' ? value : null;
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Run the non-interactive Claude CLI with a pipe, never passing the prompt as an argv value. */
export async function runClaudeHeadless({ cwd, prompt, env, spawn = nodeSpawn, timeoutMs = 1_800_000, maxTurns, onSpawn }: {
  cwd: string;
  prompt: string;
  env: NodeJS.ProcessEnv;
  spawn?: Spawn;
  timeoutMs?: number;
  maxTurns?: number;
  onSpawn?: (pid: number, kill: () => void) => void;
}): Promise<ClaudeHeadlessResult> {
  if (maxTurns !== undefined && (!Number.isSafeInteger(maxTurns) || maxTurns < 1)) {
    throw new Error('Claude headless maxTurns must be a positive integer');
  }
  let child: ChildProcessWithoutNullStreams;
  const base: ClaudeHeadlessResult = {
    ok: false, reason: 'no-result', exitCode: null, result: null, subtype: null,
    sessionId: null, isError: null, numTurns: null, durationMs: null,
    durationApiMs: null, totalCostUsd: null, usage: null, toolEvents: 0, malformedLines: 0,
  };
  try {
    child = spawn('claude', [
      '-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions',
      ...(maxTurns === undefined ? [] : ['--max-turns', String(maxTurns)]),
    ], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return { ...base, reason: 'spawn-error' };
  }

  // A missing executable yields a child with no pid; its async 'error' event resolves as spawn-error below.
  if (typeof child.pid === 'number' && child.pid > 0) onSpawn?.(child.pid, () => { try { child.kill(); } catch { /* Already exited. */ } });
  return new Promise((resolve) => {
    const state = { ...base };
    let pending = '';
    let sawResult = false;
    let timedOut = false;
    let spawnError = false;
    let settled = false;
    const parseLine = (line: string): void => {
      if (!line.trim()) return;
      let event: unknown;
      try { event = JSON.parse(line); }
      catch { state.malformedLines++; return; }
      if (!object(event) || typeof event.type !== 'string') {
        state.malformedLines++;
        return;
      }
      if (event.type === 'assistant' && object(event.message) && Array.isArray(event.message.content)) {
        state.toolEvents += event.message.content.filter((block: unknown) => object(block) && block.type === 'tool_use').length;
      }
      if (event.type !== 'result') return;
      sawResult = true;
      state.result = string(event.result);
      state.subtype = string(event.subtype);
      state.sessionId = string(event.session_id);
      state.isError = typeof event.is_error === 'boolean' ? event.is_error : null;
      state.numTurns = number(event.num_turns);
      state.durationMs = number(event.duration_ms);
      state.durationApiMs = number(event.duration_api_ms);
      state.totalCostUsd = number(event.total_cost_usd);
      state.usage = object(event.usage) ? event.usage : null;
    };
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      const finalLine = pending;
      pending = '';
      parseLine(finalLine);
      state.exitCode = exitCode;
      state.reason = timedOut ? 'timeout' : spawnError ? 'spawn-error' : !sawResult ? 'no-result'
        : exitCode !== 0 ? 'cli-error' : state.isError === true || state.subtype !== 'success' ? 'result-error' : 'success';
      state.ok = state.reason === 'success';
      resolve(state);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* Report timeout even when the process cannot be killed. */ }
      finish(null);
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    const onData = (chunk: string): void => {
      if (settled) return;
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf('\n')) !== -1) {
        parseLine(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
    };
    child.stdout.on('data', onData);
    // Drain diagnostics so a verbose CLI cannot block on a full stderr pipe; never expose secrets from it.
    child.stderr.resume();
    child.on('error', () => { spawnError = true; finish(null); });
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => { /* A child that exits before reading stdin is classified on close. */ });
    try { child.stdin.end(prompt); }
    catch { spawnError = true; try { child.kill('SIGKILL'); } catch { /* Already exited. */ } finish(null); }
  });
}
