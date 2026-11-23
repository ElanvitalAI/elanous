import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestEls } from './client.js';
import { processIdentity } from './peer-seat.js';
import { AUTH_OWNER_TOKEN_ENV, AUTH_PANE_TOKEN_ENV } from './server-auth.js';
import { elsSocketPath, startElsServer, type ElsRequest } from './server.js';

test.skipIf(process.platform !== 'darwin')('baton lease through product socket: issue, exercise, return, expire and audit', async () => {
  // The live peer identity requires a controlling tty, including in headless pregate.
  if (!process.env.ELS_BATON_PRIVATE_TTY) {
    const child = Bun.spawn(['/usr/bin/script', '-q', '/dev/null', process.execPath, 'test', import.meta.path, '-t', 'baton lease through product socket'],
      { env: { ...process.env, ELS_BATON_PRIVATE_TTY: '1', NO_COLOR: '1' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: out + err }).toMatchObject({ code: 0, output: expect.stringContaining('1 pass') });
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'eb-'));
  let now = 1_800_000_000_000;
  let peer = 'OP';
  let token = '';
  const identity = processIdentity(process.pid);
  expect(identity).toBeDefined();
  const envKeys = [AUTH_PANE_TOKEN_ENV, AUTH_OWNER_TOKEN_ENV, 'ELANOUS_ELS_RUNTIME_TOKEN_FILE'] as const;
  const savedEnv = envKeys.map(key => process.env[key]);
  const started = await startElsServer({ stateRoot: root, now: () => now,
    seatLookup: async () => ({ pane: 'test-peer', seat: peer }),
    spawn: (_c, _d, _t, env) => {
      token = env[AUTH_PANE_TOKEN_ENV]!;
      return { id: env.ELANOUS_ELS_PANE!, pid: process.pid,
        processBinding: { pid: process.pid, start: identity!.start, generation: 'baton-test' },
        isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {} };
    },
  });
  if ('exitCode' in started) throw new Error(started.message);
  try {
    // startElsServer installs its owner token in this process; inherited credentials
    // take precedence over requestEls's explicit pane token. Exercise the intended actors.
    for (const key of envKeys) delete process.env[key];
    const socket = elsSocketPath(root);
    const ask = (request: ElsRequest, credential?: string) => requestEls(socket, request, 10_000, credential);
    const made = started.core.newPane({ ws: 'TC', cwd: root, command: ['sh'], ownerSeat: 'TC', parent: { kind: 'hand', seat: 'TC', workspaces: ['TC'] } });
    expect(made.exitCode).toBe(0);
    const issue: ElsRequest = { op: 'baton', action: 'hand', owner: 'OP', acting: 'TC', reason: 'restart', ttlMs: 1000 };
    const decision: ElsRequest = { op: 'coordinator', ws: 'TC' };
    peer = 'TC';
    expect((await ask(issue, token)).exitCode).toBe(1);
    expect((await ask(decision, token)).exitCode).toBe(1);
    peer = 'OP';
    const handed = await ask(issue);
    expect(handed.exitCode, handed.message).toBe(0);
    peer = 'TC';
    const active = await ask(decision, token);
    expect(active.exitCode, active.message).toBe(0);
    expect((await ask({ op: 'baton', action: 'return', owner: 'OP', handoff: 'mail 42 handled' }, token)).exitCode).toBe(0);
    expect((await ask(decision, token)).exitCode).toBe(1);
    peer = 'OP';
    expect((await ask(issue)).exitCode).toBe(0);
    peer = 'TC';
    expect((await ask(decision, token)).exitCode).toBe(0);
    now += 1000;
    expect((await ask(decision, token)).exitCode).toBe(1);
    const events = readFileSync(join(root, 'els', 'baton-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events.map(event => [event.action, event.actor])).toEqual([['hand', 'OP'], ['return', 'TC'], ['hand', 'OP'], ['expire', 'server']]);
    expect(events[1].handoff).toBe('mail 42 handled');
  } finally {
    try { await started.close(); } finally {
      for (const [i, key] of envKeys.entries()) {
        if (savedEnv[i] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[i];
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 30_000);
