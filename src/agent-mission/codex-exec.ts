import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type CodexExecResult = {
  ok: boolean;
  reason: 'success' | 'no-session' | 'no-result' | 'cli-error' | 'timeout' | 'spawn-error';
  exitCode: number | null;
  sessionId: string | null;
  result: string | null;
  numTurns: number;
  malformedLines: number;
};

type Spawn = (command: string, args: string[], options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ['pipe', 'pipe', 'pipe'];
}) => ChildProcessWithoutNullStreams;

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Run one non-interactive Codex exec turn, optionally resuming the exact thread from a prior turn. */
export async function runCodexExec({ cwd, prompt, env, resumeSessionId, spawn = nodeSpawn, timeoutMs = 1_800_000, onSpawn }: {
  cwd: string;
  prompt: string;
  env: NodeJS.ProcessEnv;
  resumeSessionId?: string;
  spawn?: Spawn;
  timeoutMs?: number;
  onSpawn?: (pid: number, kill: () => void) => void;
}): Promise<CodexExecResult> {
  if (resumeSessionId !== undefined && !resumeSessionId.trim()) throw new Error('Codex resume session id must not be empty');
  const args = resumeSessionId === undefined
    ? ['exec', '--json', '--approve-for-me', '-']
    : ['exec', 'resume', '--json', '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"', resumeSessionId, '-'];
  const base: CodexExecResult = {
    ok: false, reason: 'no-result', exitCode: null, sessionId: null, result: null, numTurns: 0, malformedLines: 0,
  };
  let child: ChildProcessWithoutNullStreams;
  try { child = spawn('codex', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch { return { ...base, reason: 'spawn-error' }; }
  if (typeof child.pid === 'number' && child.pid > 0) onSpawn?.(child.pid, () => { try { child.kill(); } catch { /* Already exited. */ } });

  return new Promise((resolve) => {
    const state = { ...base };
    let pending = '';
    let sawCompletedTurn = false;
    let failedTurn = false;
    let timedOut = false;
    let spawnError = false;
    let settled = false;
    const parseLine = (line: string): void => {
      if (!line.trim()) return;
      let event: unknown;
      try { event = JSON.parse(line); }
      catch { state.malformedLines++; return; }
      if (!object(event) || typeof event.type !== 'string') { state.malformedLines++; return; }
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') state.sessionId = event.thread_id;
      else if (event.type === 'item.completed' && object(event.item) && event.item.type === 'agent_message' && typeof event.item.text === 'string') {
        state.result = event.item.text;
      } else if (event.type === 'turn.completed') {
        sawCompletedTurn = true;
        state.numTurns++;
      } else if (event.type === 'turn.failed') failedTurn = true;
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
      state.reason = timedOut ? 'timeout' : spawnError ? 'spawn-error'
        : exitCode !== 0 || failedTurn ? 'cli-error'
          : !sawCompletedTurn || !state.result ? 'no-result'
            : !state.sessionId ? 'no-session' : 'success';
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
    child.stderr.resume();
    child.on('error', () => { spawnError = true; finish(null); });
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => { /* A child that exits before reading stdin is classified on close. */ });
    try { child.stdin.end(prompt); }
    catch { spawnError = true; try { child.kill('SIGKILL'); } catch { /* Already exited. */ } finish(null); }
  });
}
