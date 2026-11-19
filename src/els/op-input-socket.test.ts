import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startElsServer, elsSocketPath } from './server.js';
import { requestEls } from './client.js';

test('socket peer, explicit seats, audit failure and priority through control', async () => {
  const root = mkdtempSync(join(tmpdir(), 'op17-')); const writes: string[] = []; let busy = true;
  let seat: 'OP' | 'RES-INFRA' | undefined;
  const server = await startElsServer({ stateRoot: root, seatLookup: (pid) => pid && seat ? { pane: seat === 'OP' ? 'w1:p2' : 'wK:p3', seat } : undefined, spawn: () => ({ id: 'fake', isAlive: () => true, write: (v) => writes.push(v), renderScreen: async () => busy ? 'Turn running' : '', onExit: () => {}, kill: () => {} }) });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const socket = elsSocketPath(root); const ask = (request: any) => requestEls(socket, request);
    const made = await ask({ op: 'new', ws: 'victim', cwd: root, command: ['eln'] });
    const pane = JSON.parse(made.message).pane;
    const line = (text: string, from = 'OP') => ask({ op: 'input-line', pane, text, from });
    expect((await line('DENIED')).exitCode).toBe(1); expect(writes).toEqual([]);
    const allow = join(root, 'els/control-allow.json');
    const rule = (seat: string, principal = `local:${process.getuid!()}`) => writeFileSync(allow, JSON.stringify({ rules: [{ principal, seat, workspace: '*', pane: '*', actions: ['input'] }] }));
    rule('OTHER'); expect((await line('DENIED', 'OP')).exitCode).toBe(1);
    rule('OP'); expect((await line('FORGED', 'OP')).exitCode).toBe(1);
    seat = 'OP';
    writeFileSync(allow, JSON.stringify({ rules: [] })); // no deployment rule is needed
    expect((await ask({ op: 'input-line', pane, text: 'MALFORMED', from: 'OP', at: { ws: 9, tab: 'x' } })).exitCode).toBe(1);
    expect((await ask({ op: 'do', pane, text: 'ordinary', from: 'test' })).exitCode).toBe(0);
    expect((await line('PRIORITY', 'forged')).exitCode).toBe(0); expect(writes).toEqual([]);
    busy = false; await server.core.drain(); expect(writes).toEqual(['PRIORITY\r']);
    const audit = readFileSync(join(root, 'els/control-audit.jsonl'), 'utf8');
    expect(audit).toContain('"result":"queued"');
    expect(audit).not.toContain('"result":"executed"');
    expect(audit).toContain(`"principal":"local:${process.getuid!()}"`);
    expect(audit).toContain(createHash('sha256').update('PRIORITY').digest('hex')); expect(audit).not.toContain('PRIORITY');
    const rows = audit.trim().split('\n').map((line) => JSON.parse(line));
    const priority = rows.filter((row) => row.sha256 === createHash('sha256').update('PRIORITY').digest('hex'));
    expect(priority.map((row) => row.result)).toEqual(['executing', 'queued', 'delivering', 'delivered']);
    expect(new Set(priority.map((row) => row.requestId)).size).toBe(1);
    expect(priority.every((row) => row.principal === `local:${process.getuid!()}` && row.seat === 'OP' && row.callerPane === 'w1:p2')).toBe(true);
    renameSync(join(root, 'els/control-audit.jsonl'), join(root, 'els/saved.jsonl')); mkdirSync(join(root, 'els/control-audit.jsonl'));
    expect((await line('NO-AUDIT')).exitCode).toBe(1); expect(writes).toEqual(['PRIORITY\r']);
    rule('RES-INFRA');
  } finally { await server.close(); }
});

test('caller change between intent and execution denies without writing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'op17-race-')); const writes: string[] = [];
  let lookups = 0;
  const server = await startElsServer({ stateRoot: root,
    seatLookup: () => ++lookups === 1 ? { pane: 'w1:p2', seat: 'OP' } : undefined,
    spawn: () => ({ id: 'fake', isAlive: () => true, write: (v) => writes.push(v), renderScreen: async () => '', onExit: () => {}, kill: () => {} }),
  });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const socket = elsSocketPath(root); const ask = (r: any) => requestEls(socket, r);
    const made = await ask({ op: 'new', ws: 'victim', cwd: root, command: ['eln'] });
    const pane = JSON.parse(made.message).pane;
    writeFileSync(join(root, 'els/control-allow.json'), JSON.stringify({ rules: [{ principal: `local:${process.getuid!()}`, seat: 'OP', workspace: '*', pane: '*', actions: ['input'] }] }));
    const result = await ask({ op: 'input-line', pane, text: 'NO-WRITE', from: 'OP' });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('caller pane changed');
    expect(lookups).toBe(2);
    expect(writes).toEqual([]);
    const rows = readFileSync(join(root, 'els/control-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows.map(row => row.result)).toEqual(['executing', 'executor-refused']);
  } finally { await server.close(); }
});
