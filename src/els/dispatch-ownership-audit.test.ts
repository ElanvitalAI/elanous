import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { processIdentity } from './peer-seat.js';
import { denialAuditLine } from './server-auth.js';

test('unavailable socket peer PID is unknown, never the claimed PID', () => {
  const row = JSON.parse(denialAuditLine({ op: 'do' }, { kind: 'outsider', note: 'test' }, 'denied', undefined, 123456));
  expect(row.peerPid).toBe('unknown');
  expect(row.claimedPid).toBe(123456);
});
import { elsSocketPath, startElsServer } from './server.js';

test.skipIf(process.platform !== 'darwin')('dispatch audits a foreign seat do denial without recording the body', async () => {
  if (process.env.ELS_AUDIT_PRIVATE_TTY !== '1') {
    const child = Bun.spawn(['/usr/bin/script', '-q', '/dev/null', process.execPath, 'test', import.meta.path], {
      env: { ...process.env, ELS_AUDIT_PRIVATE_TTY: '1', NO_COLOR: '1' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: out + err }).toMatchObject({ code: 0, output: expect.stringContaining('2 pass') });
    return;
  }
  const identity = processIdentity(process.pid);
  expect(identity).toBeDefined();
  const root = mkdtempSync('/tmp/els-audit-');
  const writes: string[] = [], tokens: string[] = [];
  const previous = process.env.ELANOUS_ELS_OWNER_TOKEN;
  const server = await startElsServer({ stateRoot: root, stall: false,
    spawn: (_c, _d, _t, env) => {
      tokens.push(env.ELANOUS_ELS_PANE_TOKEN!);
      return { id: `fake-${tokens.length}`, ...(tokens.length === 1 ? { pid: process.pid, processBinding: { pid: process.pid, start: identity!.start, generation: 'fixture' } } : {}), isAlive: () => true, write: v => writes.push(v), renderScreen: async () => '', onExit: () => {}, kill: () => {} };
    },
  });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const own = await server.core.newPane({ ws: 'shared', cwd: root, command: ['sh'], ownerSeat: 'OP', parent: { kind: 'op' } });
    expect(own.exitCode).toBe(0);
    const made = await server.core.newPane({ ws: 'shared', cwd: root, command: ['sh'], ownerSeat: 'OTHER' });
    expect(made.exitCode).toBe(0);
    const pane = JSON.parse(made.message).pane;
    const body = 'private-body-should-not-be-recorded';
    const from = 'private-origin-should-not-be-recorded';
    const forgedPid = process.pid + 1000000;
    for (const claim of [{ pid: forgedPid }, {}]) {
      const result = await new Promise<{ exitCode: number; message: string }>((resolve, reject) => {
        const socket = createConnection(elsSocketPath(root)); let data = '';
        socket.on('connect', () => { socket.write(JSON.stringify({ op: 'auth', token: tokens[0], ...claim }) + '\n'); socket.write(JSON.stringify({ op: 'do', pane, text: body, from }) + '\n'); });
        socket.on('data', chunk => { data += chunk.toString(); });
        socket.on('end', () => { try { resolve(JSON.parse(data.trim().split('\n').at(-1)!)); } catch (error) { reject(error); } });
        socket.on('error', reject);
      });
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('target is not owned by caller seat');
    }
    expect(writes).toEqual([]);
    expect(server.core.queued(pane)).toBe(0);
    const path = join(root, 'els', 'control-audit.jsonl');
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain(body);
    expect(raw).not.toContain(from);
    const rows = raw.trim().split('\n').map(line => JSON.parse(line));
    expect(rows).toHaveLength(2);
    expect(rows[0].claimedPid).toBe(forgedPid);
    expect(rows[1].claimedPid).toBeUndefined();
    for (const row of rows) {
      expect(row).toMatchObject({ action: 'do', pane, result: 'denied', reason: 'target is not owned by caller seat', peerPid: process.pid });
      expect(row.peerPid).not.toBe(forgedPid);
    }
    // Real socket path through the control.ts input-line door, not dispatch's denial audit.
    const ownPane = JSON.parse(own.message).pane;
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(elsSocketPath(root));
      socket.on('connect', () => {
        socket.write(JSON.stringify({ op: 'auth', token: tokens[0], pid: forgedPid }) + '\n');
        socket.write(JSON.stringify({ op: 'input-line', pane: ownPane, text: body, from }) + '\n');
      });
      socket.on('data', () => {}); socket.on('end', resolve); socket.on('error', reject);
    });
    const doorRaw = readFileSync(path, 'utf8');
    const doorRows = doorRaw.trim().split('\n').slice(2).map(line => JSON.parse(line));
    expect(doorRows.length).toBeGreaterThan(0);
    for (const row of doorRows) expect(row).toMatchObject({ action: 'input', peerPid: process.pid, claimedPid: forgedPid });
    expect(doorRaw).not.toContain(body);
    expect(doorRaw).not.toContain(from);
  } finally {
    await server.close(); rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = previous;
  }
});
