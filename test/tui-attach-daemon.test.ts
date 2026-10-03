// MVP M1.3 — TUI attach to headless daemon e2e test.
//
// Boots `bootAcpServer` on a tmp unix socket inside the SAME process
// (no real daemon spawn) with an echo runTurn, then has a TUI-side
// `DashboardSession.attach()` send a prompt and verify the round-trip
// works end-to-end through the socket transport. Real LLM is mocked
// via a stub runTurn that pushes deterministic chunks.

import { setDefaultTimeout, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

import { bootAcpServer } from '../src/boot/acp-server.js';
import { connectUnixSocket } from '../src/tui-client/acp-transport-unix-client.js';
import { DashboardSession } from '../src/tui-client/dashboard-session.js';
import { waitForSocket } from './helpers/wait-for-socket.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

let tmp: string;
let sockPath: string;

beforeEach(() => {
  tmp = mkdtempSync(joinPath(tmpdir(), 'elanous-tui-attach-test-'));
  sockPath = joinPath(tmp, 'elanous.sock');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('DashboardSession.attach over unix socket', () => {
  test('TUI client attaches, sends prompt, receives streamed text via stub runTurn', async () => {
    const shutdownCtrl = new AbortController();
    // Stub runTurn — no real LLM. Pushes "echo: <userText>" then resolves.
    const stubRunTurn = async (turnCtx: {
      userText: string;
      push: (text: string) => Promise<void>;
    }): Promise<void> => {
      await turnCtx.push(`echo: ${turnCtx.userText}`);
    };

    const serverPromise = bootAcpServer(
      { transport: 'unix-socket', socketPath: sockPath },
      {
        shutdownSignal: shutdownCtrl.signal,
        runTurn: stubRunTurn,
      },
    );

    await waitForSocket(sockPath);

    // Connect from the TUI side.
    const conn = await connectUnixSocket({ path: sockPath });
    const session = await DashboardSession.attach({
      conn,
      cwd: tmp,
    });
    expect(typeof session.id).toBe('string');
    expect(session.id.length).toBeGreaterThan(0);

    // Send a prompt and capture the streamed text.
    const chunks: string[] = [];
    const result = await session.send({
      userText: 'hello daemon',
      onText: (delta: string) => { chunks.push(delta); },
    });
    expect(result.stopReason).toBe('end_turn');
    expect(chunks.join('')).toBe('echo: hello daemon');

    await session.close();
    shutdownCtrl.abort();
    try { await serverPromise; } catch { /* server throws on abort, fine */ }
  });

  test('attach returns a fresh session id different from a second attach', async () => {
    const shutdownCtrl = new AbortController();
    const stubRunTurn = async (turnCtx: {
      userText: string;
      push: (text: string) => Promise<void>;
    }): Promise<void> => {
      await turnCtx.push(`reply ${turnCtx.userText}`);
    };

    const serverPromise = bootAcpServer(
      { transport: 'unix-socket', socketPath: sockPath },
      { shutdownSignal: shutdownCtrl.signal, runTurn: stubRunTurn },
    );

    await waitForSocket(sockPath);

    const conn1 = await connectUnixSocket({ path: sockPath });
    const conn2 = await connectUnixSocket({ path: sockPath });
    const s1 = await DashboardSession.attach({ conn: conn1, cwd: tmp });
    const s2 = await DashboardSession.attach({ conn: conn2, cwd: tmp });

    expect(s1.id).not.toBe(s2.id);

    await s1.close();
    await s2.close();
    shutdownCtrl.abort();
    try { await serverPromise; } catch { /* ignore */ }
  });
});

describe('elanous attach one-shot assertions', () => {
  async function runRawAttach(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn({
      cmd: ['bun', 'src/index.ts', 'attach', '--socket', sockPath, ...args],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      exitCode: await proc.exited,
      stdout: await new Response(proc.stdout).text(),
      stderr: await new Response(proc.stderr).text(),
    };
  }

  function runAttach(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return runRawAttach(['--message', 'inspect tools', ...args]);
  }

  test('explains that a missing Unix socket does not prove the daemon is absent', async () => {
    const result = await runRawAttach(['--message', 'inspect tools']);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.exitCode).toBe(1);
    expect(output).toContain(`No listening or usable Unix socket found at ${sockPath}`);
    expect(output).toContain('only the local Unix-socket transport was checked');
    expect(output).toContain('A daemon may be listening on TCP only');
    expect(output).toContain('elanous attach --host <host>:<port>');
    expect(output).toContain('For a remote daemon, pass --host <tailnet>:<port> or set ELANOUS_REMOTE.');
    expect(output).not.toContain('No elanous daemon listening');
  });

  test('does not claim a stale Unix socket path lacks a file', async () => {
    const livePath = joinPath(tmp, 'live.sock');
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(livePath, resolve);
    });
    renameSync(livePath, sockPath);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    expect(existsSync(sockPath)).toBe(true);

    const result = await runRawAttach(['--message', 'inspect tools']);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.exitCode).toBe(1);
    expect(output).toContain(`No listening or usable Unix socket found at ${sockPath}`);
    expect(output).not.toContain('No Unix socket file found');
    expect(output).toContain('A daemon may be listening on TCP only');
    expect(output).toContain('elanous attach --host <host>:<port>');
    expect(output).toContain('For a remote daemon, pass --host <tailnet>:<port> or set ELANOUS_REMOTE.');
  });

  test('rejects assertions outside one-shot mode before connecting to a daemon', async () => {
    const noMessage = await runRawAttach(['--assert-text-contains', 'confirmed']);
    expect(noMessage.exitCode).not.toBe(0);
    expect(noMessage.stderr).toContain('--assert-* options require --message and cannot be used with --interactive');
    expect(noMessage.stderr).not.toContain('No elanous daemon listening');

    const interactive = await runRawAttach(['--message', 'inspect tools', '--interactive', '--assert-tool-min', 'Read=1']);
    expect(interactive.exitCode).not.toBe(0);
    expect(interactive.stderr).toContain('--assert-* options require --message and cannot be used with --interactive');
    expect(interactive.stderr).not.toContain('No elanous daemon listening');
  });

  test('rejects malformed tool assertions before connecting or sending a turn', async () => {
    const result = await runRawAttach(['--message', 'inspect tools', '--assert-tool-min', 'Read=one']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('invalid --assert-tool-min value "Read=one"; expected ToolName=N');
    expect(result.stderr).not.toContain('No elanous daemon listening');
  });

  test('passes min/max and text assertions from daemon tool_call callbacks', async () => {
    const shutdownCtrl = new AbortController();
    const serverPromise = bootAcpServer(
      { transport: 'unix-socket', socketPath: sockPath },
      {
        shutdownSignal: shutdownCtrl.signal,
        runTurn: async (turnCtx) => {
          await turnCtx.pushToolCall({ id: 'read-1', name: 'Read', args: { file_path: 'README.md' } });
          await turnCtx.push('tool selection confirmed');
        },
      },
    );
    await waitForSocket(sockPath);

    const result = await runAttach([
      '--assert-tool-min', 'Read=1',
      '--assert-tool-max', 'Read=1',
      '--assert-text-contains', 'selection confirmed',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('tool selection confirmed');
    expect(result.stderr).not.toContain('Assertion failed');

    shutdownCtrl.abort();
    try { await serverPromise; } catch { /* server throws on abort, fine */ }
  });

  test('accepts hyphenated and dotted daemon tool names using repro parser syntax', async () => {
    const shutdownCtrl = new AbortController();
    const serverPromise = bootAcpServer(
      { transport: 'unix-socket', socketPath: sockPath },
      {
        shutdownSignal: shutdownCtrl.signal,
        runTurn: async (turnCtx) => {
          await turnCtx.pushToolCall({ id: 'tool-1', name: 'tool-name.v1', args: {} });
          await turnCtx.push('tool selection confirmed');
        },
      },
    );
    await waitForSocket(sockPath);

    const result = await runAttach([
      '--assert-tool-min', 'tool-name.v1=1',
      '--assert-tool-max', 'tool-name.v1=1',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('invalid --assert-tool');

    shutdownCtrl.abort();
    try { await serverPromise; } catch { /* server throws on abort, fine */ }
  });

  test('fails named assertion rules when daemon callbacks or final text do not satisfy them', async () => {
    const shutdownCtrl = new AbortController();
    const serverPromise = bootAcpServer(
      { transport: 'unix-socket', socketPath: sockPath },
      {
        shutdownSignal: shutdownCtrl.signal,
        runTurn: async (turnCtx) => {
          await turnCtx.pushToolCall({ id: 'read-1', name: 'Read', args: { file_path: 'README.md' } });
          await turnCtx.push('tool selection confirmed');
        },
      },
    );
    await waitForSocket(sockPath);

    const minResult = await runAttach(['--assert-tool-min', 'Read=2']);
    expect(minResult.exitCode).not.toBe(0);
    expect(minResult.stdout).toContain('Assertion failed [assertToolMin]: tool Read fired 1× but expected at least 2');

    const maxResult = await runAttach(['--assert-tool-max', 'Read=0']);
    expect(maxResult.exitCode).not.toBe(0);
    expect(maxResult.stdout).toContain('Assertion failed [assertToolMax]: tool Read fired 1× but expected at most 0');

    const textResult = await runAttach(['--assert-text-contains', 'missing response text']);
    expect(textResult.exitCode).not.toBe(0);
    expect(textResult.stdout).toContain('Assertion failed [assertTextContains]: final text did not contain "missing response text"');

    shutdownCtrl.abort();
    try { await serverPromise; } catch { /* server throws on abort, fine */ }
  });
});

describe('createDaemonRuntime echo behaviour', () => {
  test('history accumulates assistant turns per session', async () => {
    const { createDaemonRuntime } = await import('../src/boot/daemon-runtime.js');
    // ⛔ #14191 가드 — PtyShell 표면이면 정리자를 «반드시» 받는다(안 주면 던진다).
    //    이 시험은 히스토리 누적만 재므로 no-op 스텁으로 계약만 지킨다.
    const { history } = createDaemonRuntime({ toolCwd: tmp, killNonDetachedPty: () => { /* no-op */ } });
    expect(history.list()).toEqual([]);

    history.append('s1', [{ role: 'assistant', content: 'first' }]);
    history.append('s1', [{ role: 'assistant', content: 'second' }]);
    history.append('s2', [{ role: 'assistant', content: 'a' }]);

    expect(history.list().sort()).toEqual(['s1', 's2']);
    expect(history.get('s1').length).toBe(2);
    expect(history.get('s2').length).toBe(1);
    expect(history.get('missing')).toEqual([]);

    history.forget('s1');
    expect(history.list()).toEqual(['s2']);
  });
});
