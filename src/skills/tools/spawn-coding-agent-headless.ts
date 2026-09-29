// Native tool: SpawnCodingAgentHeadless — I2 (텔레그램 코딩 에이전트).
//
// Lands claude-code / codex in a bare PtyShell so a HEADLESS surface
// (telegram / continuation) can spawn a sub coding-agent and drive its
// live terminal with the PtyShell family:
//
//   SpawnCodingAgentHeadless → process_id
//     · PtyShellSnapshot  — read the agent's screen (it's a full-screen TUI)
//     · PtyShellSend      — type the task / answer its prompts (raw bytes,
//                           so no shell-quoting of the prompt)
//     · PtyShellScreenshot— show its screen as an image on Telegram
//     · PtyShellKill      — end it
//
// Relationship to delegate_code_agent (ACP): ACP is the STRUCTURED path —
// prefer it for fire-and-forget "delegate this coding task, give me the
// result". This tool is for when you want to DRIVE or SEE the agent's
// actual terminal (observe its work, steer mid-run, or run a CLI that has
// no ACP). The macOS keychain-unlock wrap lets `claude` read its credentials.

import { spawnSync } from 'node:child_process';
import type { LLMToolSpec } from '../../llm.js';
import { getSessionCwd } from '../../session/working-dir.js';
import { startPty, unregisterPty, type PtyHandle } from '../../pty-shell/registry.js';
import { CodingAgentBinaryMissing } from '../../terminal/coding-agent.js';
import { wrapCommandForKeychainUnlock, shouldWrapForKeychainUnlock } from '../../terminal/keychain-unlock.js';
export type CodingAgentBrand = 'claude-code' | 'codex';

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

function binaryForBrand(brand: CodingAgentBrand): string {
  return brand === 'claude-code' ? 'claude' : 'codex';
}

function defaultWhich(binary: string): string | null {
  const r = spawnSync('which', [binary], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 1500 });
  if (r.status !== 0) return null;
  const p = r.stdout?.toString().trim();
  return p || null;
}

/** Single-quote-escape an argv token for a POSIX shell string (only used
 *  on the keychain-wrapped claude path, which must be one shell command). */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface SpawnCodingAgentHeadlessDeps {
  /** Test seam for the `which` binary probe. */
  whichBinary?: (name: string) => string | null;
  /** Test seam — overrides the keychain-unlock command wrap. */
  wrapCommand?: (cmd: string) => string;
}

export function buildSpawnCodingAgentHeadlessTool(): LLMToolSpec {
  return {
    name: 'SpawnCodingAgentHeadless',
    description:
      'Spawn claude-code or codex under a PTY (no dashboard/VW needed) and return a process_id you drive with the PtyShell tools — ' +
      'PtyShellSnapshot to read its screen, PtyShellSend to type the task / answer prompts, PtyShellScreenshot to show it as an image, PtyShellKill to end it. ' +
      'These agents are full-screen TUIs: after spawn, Poll/Snapshot for ~1-2s until the prompt draws, THEN send the task as text. ' +
      'For a fire-and-forget STRUCTURED delegation prefer delegate_code_agent (ACP); use THIS when you want to observe/steer the agent\'s live terminal. ' +
      'Fails with a clear error when the binary isn\'t on PATH.',
    parameters: {
      type: 'object',
      properties: {
        brand: { type: 'string', enum: ['claude-code', 'codex'], description: 'Which coding agent to spawn.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to the session working directory.' },
        extra_args: { type: 'array', items: { type: 'string' }, description: 'Extra CLI flags after the binary (e.g. a model flag). Do NOT pass the task prompt here — send it via PtyShellSend after the TUI is ready.' },
        cols: { type: 'integer', description: 'PTY columns. Default 120 (coding TUIs need room).' },
        rows: { type: 'integer', description: 'PTY rows. Default 40.' },
      },
      required: ['brand'],
      additionalProperties: false,
    },
  };
}

/** Shared spawn: validate brand, resolve binary (+ keychain wrap for
 *  claude), start the PTY. Throws on bad brand / missing binary. */
function resolveAndSpawn(
  rawArgs: Record<string, unknown>,
  deps: SpawnCodingAgentHeadlessDeps,
): { handle: PtyHandle; brand: CodingAgentBrand; binary: string; cwd: string; cols: number; rows: number } {
  const brandRaw = String(rawArgs.brand ?? '').trim();
  if (brandRaw !== 'claude-code' && brandRaw !== 'codex') {
    throw new Error(`'brand' must be 'claude-code' or 'codex'`);
  }
  const brand = brandRaw as CodingAgentBrand;
  const cwd = typeof rawArgs.cwd === 'string' && rawArgs.cwd.trim() ? rawArgs.cwd.trim() : getSessionCwd();
  const extraArgs = Array.isArray(rawArgs.extra_args) ? rawArgs.extra_args.map(String) : [];
  const cols = typeof rawArgs.cols === 'number' ? Math.max(20, Math.floor(rawArgs.cols)) : 120;
  const rows = typeof rawArgs.rows === 'number' ? Math.max(10, Math.floor(rawArgs.rows)) : 40;

  const binary = binaryForBrand(brand);
  const which = deps.whichBinary ?? defaultWhich;
  if (which(binary) === null) {
    throw new CodingAgentBinaryMissing(binary);
  }
  // Only `claude` reads the macOS keychain — wrap it in the SSH unlock
  // preamble so credentials resolve. codex
  // spawns as a plain direct binary.
  const wrap = brand === 'claude-code' && shouldWrapForKeychainUnlock();
  const wrapCommand = deps.wrapCommand ?? wrapCommandForKeychainUnlock;
  const handle = wrap
    ? startPty({ cmd: wrapCommand([binary, ...extraArgs.map(shq)].join(' ')), workdir: cwd, cols, rows })
    : startPty({ cmd: binary, args: extraArgs, workdir: cwd, cols, rows });
  return { handle, brand, binary, cwd, cols, rows };
}

export function dispatchSpawnCodingAgentHeadless(
  rawArgs: Record<string, unknown>,
  deps: SpawnCodingAgentHeadlessDeps = {},
): { output: string } {
  const { handle, brand, binary, cwd, cols, rows } = resolveAndSpawn(rawArgs, deps);
  return {
    output:
      `SpawnCodingAgentHeadless — spawned ${brand} (${binary}) process_id=${handle.id} in ${cwd} (${cols}x${rows}).\n` +
      `Next: PtyShellSnapshot(process_id=${handle.id}) after ~1-2s to see its prompt, then PtyShellSend the task as text. ` +
      `PtyShellScreenshot to show its screen; PtyShellKill when done.`,
  };
}

/** Poll a handle's output until it goes quiet (no new bytes for `quietMs`)
 *  or `maxWaitMs` elapses or the process exits. Drains the delta buffer as
 *  it goes; the emulator grid + head/tail snapshot are unaffected. */
async function waitForQuiet(
  handle: PtyHandle,
  opts: { initialWaitMs?: number; quietMs: number; maxWaitMs: number },
): Promise<'quiet' | 'timeout' | 'exited'> {
  const start = Date.now();
  if (opts.initialWaitMs) await sleep(opts.initialWaitMs);
  handle.drainDelta(); // clear the pre-wait backlog so quiet is measured fresh
  let lastChange = Date.now();
  while (Date.now() - start < opts.maxWaitMs) {
    if (!handle.isAlive()) return 'exited';
    const delta = handle.drainDelta();
    if (delta.length > 0) lastChange = Date.now();
    else if (Date.now() - lastChange >= opts.quietMs) return 'quiet';
    await sleep(300);
  }
  return 'timeout';
}

export interface DriveCodingAgentHeadlessDeps extends SpawnCodingAgentHeadlessDeps {
  /** Test seam — override the wait loop timings. */
  timings?: { readyInitialMs?: number; readyQuietMs?: number; readyMaxMs?: number; doneQuietMs?: number };
}

export function buildDriveCodingAgentHeadlessTool(): LLMToolSpec {
  return {
    name: 'DriveCodingAgentHeadless',
    description:
      'Spawn claude-code or codex, send it a task PROMPT, wait until it finishes, and return its final screen — ALL IN ONE tool call. ' +
      'Use this for "run this coding task on codex/claude and give me the result": it does the spawn → wait-ready → send → wait-done → capture loop internally, so it does NOT burn the per-turn tool budget with manual Snapshot/Send round-trips. ' +
      'For interactively OBSERVING/steering an agent (multi-step, mid-run changes) use SpawnCodingAgentHeadless + PtyShell* instead. Bounded by timeout_ms (default 120s).',
    parameters: {
      type: 'object',
      properties: {
        brand: { type: 'string', enum: ['claude-code', 'codex'], description: 'Which coding agent to run.' },
        prompt: { type: 'string', description: 'The task to give the agent (sent as text + Enter once its TUI is ready).' },
        cwd: { type: 'string', description: 'Working directory. Defaults to the session working directory.' },
        extra_args: { type: 'array', items: { type: 'string' }, description: 'Extra CLI flags (not the prompt).' },
        timeout_ms: { type: 'integer', description: 'Max total wait for the agent to finish. Default 120000, cap 600000.' },
      },
      required: ['brand', 'prompt'],
      additionalProperties: false,
    },
  };
}

export async function dispatchDriveCodingAgentHeadless(
  rawArgs: Record<string, unknown>,
  deps: DriveCodingAgentHeadlessDeps = {},
): Promise<{ output: string }> {
  if (typeof rawArgs.prompt !== 'string' || !rawArgs.prompt.trim()) {
    throw new Error(`'prompt' is required`);
  }
  const prompt = rawArgs.prompt;
  const timeoutMs = Math.min(typeof rawArgs.timeout_ms === 'number' ? rawArgs.timeout_ms : 120_000, 600_000);
  const t = deps.timings ?? {};
  const { handle, brand, binary } = resolveAndSpawn(rawArgs, deps);
  try {
    // 1. Wait for the TUI to draw + settle (ready).
    const ready = await waitForQuiet(handle, {
      initialWaitMs: t.readyInitialMs ?? 1500,
      quietMs: t.readyQuietMs ?? 700,
      maxWaitMs: t.readyMaxMs ?? 20_000,
    });
    if (ready === 'exited') {
      const screen = await handle.renderScreen();
      return { output: `DriveCodingAgentHeadless(${brand}) — agent exited before the prompt could be sent.\n${screen}` };
    }
    // 2. Send the task + Enter (raw bytes — no shell quoting of the prompt).
    handle.write(prompt);
    await sleep(120);
    handle.write('\r');
    // 3. Wait until the agent finishes working (sustained quiet) or timeout.
    const status = await waitForQuiet(handle, {
      quietMs: t.doneQuietMs ?? 4000,
      maxWaitMs: timeoutMs,
    });
    // 4. Capture the final screen (the agent's answer is at the bottom).
    const screen = await handle.renderScreen();
    const note = status === 'timeout'
      ? `(hit ${Math.round(timeoutMs / 1000)}s timeout — agent may still be working; final screen below)`
      : status === 'exited' ? '(agent exited)' : '(agent went idle — likely done)';
    return {
      output: `DriveCodingAgentHeadless(${brand} · ${binary}) ${note}\n--- final screen ---\n${screen}`,
    };
  } finally {
    // One-shot drive: tear the agent down. (Use SpawnCodingAgentHeadless for
    // a persistent session you keep driving.)
    try { handle.kill('SIGTERM'); } catch { /* ignore */ }
    unregisterPty(handle.id);
  }
}
