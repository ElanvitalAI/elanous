import { test, expect } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { startElsServer, elsSocketPath, elsToolSocketPath } from './server.js';
import { requestEls } from './client.js';
import { runElsControl } from './els-control-tool.js';
import { loadJournal } from './journal.js';
import { processIdentity } from './peer-seat.js';
import { openMsgStore } from '../msg/msg-store.js';

test.skipIf(process.platform !== 'darwin')('a known peer never silently creates a pane owned by unknown', async () => {
  if (process.env.ELS_OP_PEER_PRIVATE_TTY !== '1') {
    const child = Bun.spawn(['/usr/bin/script', '-q', '/dev/null', process.execPath, 'test', import.meta.path, '-t', 'a known peer never silently creates a pane owned by unknown'], {
      env: { ...process.env, ELS_OP_PEER_PRIVATE_TTY: '1', NO_COLOR: '1' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: out + err }).toMatchObject({ code: 0, output: expect.stringContaining('1 pass') });
    return;
  }
  // The requesting process is the first fixture pane's actual, generation-bound peer.
  const identity = processIdentity(process.pid);
  expect(identity).toBeDefined();
  const root = mkdtempSync('/tmp/op-peer-owner-');
  const tokens: string[] = [];
  let peer = false;
  const server = await startElsServer({ stateRoot: root, stall: false,
    seatLookup: () => peer ? { pane: 'op-pane', seat: 'OP' } : undefined,
    spawn: (_c, _d, _t, env) => { tokens.push(env.ELANOUS_ELS_PANE_TOKEN ?? ''); return { id: `fake-${tokens.length}`, ...(tokens.length === 1 ? { pid: process.pid, processBinding: { pid: process.pid, start: identity!.start, generation: 'op-peer-fixture' } } : {}), isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {} }; },
  });
  if ('exitCode' in server) throw new Error(server.message);
  const raw = (request: object, token: string) => new Promise<{ exitCode: number; message: string }>((resolve, reject) => {
    const socket = createConnection(elsSocketPath(root)); let data = '';
    socket.on('connect', () => { socket.write(JSON.stringify({ op: 'auth', token }) + '\n'); socket.write(JSON.stringify(request) + '\n'); });
    socket.on('data', chunk => { data += chunk.toString(); });
    socket.on('end', () => resolve(JSON.parse(data.split('\n').filter(Boolean).pop()!)));
    socket.on('error', reject);
  });
  try {
    const owner = process.env.ELANOUS_ELS_OWNER_TOKEN!;
    const first = await raw({ op: 'new', ws: 'test', cwd: root, command: ['eln'] }, owner);
    expect(first.exitCode).toBe(0);
    expect(tokens[0]).toBeTruthy();
    writeFileSync(join(root, 'els', 'control-allow.json'), JSON.stringify({ rules: [{ principal: '*', workspace: '*', pane: '*', actions: ['new'] }] }));
    peer = true;
    const second = await raw({ op: 'new', ws: 'test', cwd: root, command: ['eln'] }, tokens[0]!);
    if (second.exitCode === 0) {
      const pane = JSON.parse(second.message).pane;
      expect(loadJournal(join(root, 'els', 'journal.json')).panes.find(p => p.id === pane)?.ownerSeat).toBe('OP');
    } else {
      expect(second.message).toContain('seat');
    }
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('server still starts when the existing socket fits at the Darwin path limit', async () => {
  const base = mkdtempSync('/tmp/op-path-');
  try {
    const root = join(base, 'x'.repeat(103 - Buffer.byteLength(join(base, 'els', 'els.sock')) - 1));
    mkdirSync(root);
    expect(Buffer.byteLength(elsSocketPath(root))).toBe(103);
    const server = await startElsServer({ stateRoot: root, spawn: () => { throw new Error('unexpected spawn'); } });
    if ('exitCode' in server) throw new Error(server.message);
    try { expect((await requestEls(elsSocketPath(root), { op: 'ping' })).exitCode).toBe(0); }
    finally { await server.close(); }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('socket peer, explicit seats, audit failure and priority through control', async () => {
  const root = mkdtempSync(join(tmpdir(), 'op17-')); const writes: string[] = []; let busy = true;
  let seat: 'OP' | 'RES-INFRA' | undefined;
  const server = await startElsServer({ stateRoot: root, seatLookup: (pid) => pid && seat ? { pane: seat === 'OP' ? 'w1:p2' : 'wK:p3', seat } : undefined, spawn: () => ({ id: 'fake', isAlive: () => true, write: (v) => writes.push(v), renderScreen: async () => busy ? 'Turn running' : '', onExit: () => {}, kill: () => {} }) });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const socket = elsSocketPath(root); const ask = (request: any) => requestEls(socket, request);
    seat = 'OP';
    const made = await ask({ op: 'new', ws: 'victim', cwd: root, command: ['eln'] });
    seat = undefined;
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
    expect((await ask({ op: 'do', pane, text: 'normal', from: 'test' })).exitCode).toBe(0);
    const queued = await line('URGENT', 'forged');
    expect(queued.exitCode).toBe(0);
    expect(queued.queued).toBe(2);
    expect(writes).toEqual([]);
    busy = false; await server.core.drain(); expect(writes).toEqual(['URGENT\r']);
    const audit = readFileSync(join(root, 'els/control-audit.jsonl'), 'utf8');
    expect(audit).toContain('"result":"queued"');
    expect(audit).not.toContain('"result":"executed"');
    expect(audit).toContain(`"principal":"local:${process.getuid!()}"`);
    expect(audit).toContain(createHash('sha256').update('URGENT').digest('hex')); expect(audit).not.toContain('URGENT');
    const rows = audit.trim().split('\n').map((line) => JSON.parse(line));
    const priority = rows.filter((row) => row.sha256 === createHash('sha256').update('URGENT').digest('hex'));
    expect(priority.map((row) => row.result)).toEqual(['executing', 'queued', 'delivering', 'delivered']);
    expect(new Set(priority.map((row) => row.requestId)).size).toBe(1);
    expect(priority.every((row) => row.principal === `local:${process.getuid!()}` && row.seat === 'OP' && row.callerPane === 'w1:p2')).toBe(true);
    renameSync(join(root, 'els/control-audit.jsonl'), join(root, 'els/saved.jsonl')); mkdirSync(join(root, 'els/control-audit.jsonl'));
    expect((await line('NO-AUDIT')).exitCode).toBe(1); expect(writes).toEqual(['URGENT\r']);
    rule('RES-INFRA');
  } finally { await server.close(); }
});

test('ElsControl creates a tab on the real isolated server and lists it', async () => {
  const root = mkdtempSync('/tmp/op-new-');
  let next = 0;
  const server = await startElsServer({ stateRoot: root, stall: false,
    seatLookup: () => ({ pane: 'op-pane', seat: 'OP' }),
    spawn: () => ({ id: `fake-${++next}`, isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {} }),
  });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const socketPath = elsSocketPath(root); const stateDir = join(root, 'els');
    const initial = await requestEls(socketPath, { op: 'new', ws: 'test', cwd: root, command: ['eln'] });
    expect(initial.exitCode).toBe(0);
    const pane = JSON.parse(initial.message).pane;
    writeFileSync(join(stateDir, 'control-allow.json'), JSON.stringify({ rules: [{ principal: 'eln:tool', workspace: '*', pane: '*', actions: ['new', 'list'] }] }));
    const made = await runElsControl({ action: 'new', pane, text: 'eln', title: 'worker' }, { socketPath, stateDir });
    expect(made).toMatchObject({ ok: true, exitCode: 0 });
    const created = JSON.parse(made.message).pane;
    expect(created).not.toBe(pane);
    const recorded = loadJournal(join(stateDir, 'journal.json')).panes.find(row => row.id === created);
    expect(recorded).toMatchObject({ cwd: root, ownerSeat: 'OP' });
    const listing = await runElsControl({ action: 'ls' }, { socketPath, stateDir });
    expect(listing.ok).toBe(true);
    expect(JSON.stringify(listing.data)).toContain(created);
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('tool socket cannot bypass its control door using raw input', async () => {
  const root = mkdtempSync(join(tmpdir(), 'op-tool-raw-')); const writes: string[] = [];
  const server = await startElsServer({ stateRoot: root,
    seatLookup: () => ({ pane: 'op-pane', seat: 'OP' }),
    spawn: () => ({ id: 'fake', isAlive: () => true, write: v => writes.push(v), renderScreen: async () => '', onExit: () => {}, kill: () => {} }),
  });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const made = await requestEls(elsSocketPath(root), { op: 'new', ws: 'test', cwd: root, command: ['eln'] });
    expect(made.exitCode).toBe(0);
    const pane = JSON.parse(made.message).pane;
    const result = await requestEls(elsToolSocketPath(root), { op: 'input', pane, bytes: 'unsafe\r' });
    expect(result.exitCode).not.toBe(0);
    const attach = await requestEls(elsToolSocketPath(root), { op: 'attach', pane });
    expect(attach.exitCode).not.toBe(0);
    for (const op of ['send', 'send-verified'] as const) {
      const sent = await requestEls(elsToolSocketPath(root), { op, pane, text: 'unsafe' });
      expect(sent.exitCode).not.toBe(0);
    }
    expect(writes).toEqual([]);
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('ElsControl send and stop cross both authorization doors on a real server socket', async () => {
  const root = mkdtempSync(join(tmpdir(), 'op-tool-int-')); const writes: string[] = [];
  let verified = false; let busy = false;
  const server = await startElsServer({ stateRoot: root,
    seatLookup: () => verified ? { pane: 'op-pane', seat: 'OP' } : undefined,
    spawn: () => ({ id: 'fake', isAlive: () => true, write: (v) => writes.push(v), renderScreen: async () => busy ? 'Turn running' : '', onExit: () => {}, kill: () => {} }),
  });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const socketPath = elsSocketPath(root); const stateDir = join(root, 'els');
    verified = true;
    const made = await requestEls(socketPath, { op: 'new', ws: 'victim', cwd: root, command: ['eln'] });
    verified = false;
    expect(made.exitCode).toBe(0);
    const pane = JSON.parse(made.message).pane;
    writeFileSync(join(stateDir, 'control-allow.json'), JSON.stringify({ rules: [{ principal: 'eln:tool', workspace: '*', pane: '*', actions: ['do'] }] }));
    const send = () => runElsControl({ action: 'send', pane, text: 'pwd' }, { socketPath, stateDir });
    const stop = () => runElsControl({ action: 'stop', pane }, { socketPath, stateDir });
    expect((await send()).ok).toBe(false);
    expect((await stop()).ok).toBe(false);
    expect(writes).toEqual([]);
    verified = true;
    const sent = await send();
    expect(sent).toMatchObject({ ok: true, exitCode: 0 });
    expect(writes).toEqual(['pwd\r']);
    busy = true;
    expect(await runElsControl({ action: 'send', pane, text: 'ls' }, { socketPath, stateDir })).toMatchObject({ ok: true, exitCode: 0, queued: 1 });
    expect(writes).toEqual(['pwd\r']);
    const rows = readFileSync(join(stateDir, 'control-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const toolRows = rows.filter(row => row.principal === 'eln:tool' && row.sha256 === createHash('sha256').update('ls').digest('hex'));
    expect(toolRows.map(row => row.result)).toEqual(['executing', 'queued']);
    expect(await stop()).toMatchObject({ ok: true, exitCode: 0 });
    expect(writes).toEqual(['pwd\r', '\x1b']);
  } finally { await server.close(); }
});

test('stale agent display must not allow prose into a shell', async () => {
  const root = mkdtempSync('/tmp/op-stale-agent-'); const writes: string[] = [];
  const server = await startElsServer({ stateRoot: root, stall: false,
    seatLookup: () => ({ pane: 'op-pane', seat: 'OP' }),
    ps: async () => '42 42 /bin/zsh\n',
    spawn: () => ({ id: 'fake', pid: 42, isAlive: () => true, write: value => writes.push(value), renderScreen: async () => '', onExit: () => {}, kill: () => {} }),
  });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const made = await requestEls(elsSocketPath(root), { op: 'new', ws: 'test', cwd: root, command: ['zsh'] });
    const pane = JSON.parse(made.message).pane;
    server.core.setForegrounds(new Map([[pane, { kind: 'eln', command: ['eln'], pid: 43 }]]));
    writeFileSync(join(root, 'els/control-allow.json'), JSON.stringify({ rules: [{ principal: 'eln:tool', workspace: '*', pane: '*', actions: ['do'] }] }));
    const sent = await runElsControl({ action: 'send', pane, text: 'Please inspect this task' }, { socketPath: elsSocketPath(root), stateDir: join(root, 'els') });
    expect(sent.ok && sent.exitCode === 0).toBe(false);
    expect(writes).toEqual([]);
  } finally { await server.close(); }
});

// ELS-OP-PROSE-INPUT-HOLD: the HQ coordinator (OP) may type plain words into another seat's agent tab; the line is
// typed as-is, and a copy goes to that seat's mailbox so the instruction is durable.
test('HQ prose into another seat agent tab is typed and mailed to that seat', async () => {
  const root = mkdtempSync('/tmp/op-agent-prose-'); const writes: string[] = [];
  const server = await startElsServer({ stateRoot: root, stall: false,
    seatLookup: () => ({ pane: 'op-pane', seat: 'OP' }),
    ps: async () => '42 43 /bin/zsh\n43 43 eln\n',
    spawn: () => ({ id: 'fake', pid: 42, isAlive: () => true, write: value => writes.push(value), bracketedPasteEnabled: () => true, renderScreen: async () => '', onExit: () => {}, kill: () => {} }),
  });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const made = server.core.newPane({ ws: 'test', cwd: root, command: ['eln'], ownerSeat: 'JUD' });
    expect(made.exitCode).toBe(0);
    const pane = JSON.parse(made.message).pane;
    server.core.setForegrounds(new Map([[pane, { kind: 'eln', command: ['eln'], pid: 43 }]]));
    writeFileSync(join(root, 'els/control-allow.json'), JSON.stringify({ rules: [{ principal: 'eln:tool', workspace: '*', pane: '*', actions: ['do'] }] }));
    const sent = await runElsControl({ action: 'send', pane, text: 'Please inspect this task' }, { socketPath: elsSocketPath(root), stateDir: join(root, 'els') });
    expect(sent).toMatchObject({ ok: true, exitCode: 0 });
    expect(writes).toEqual(['\x1b[200~Please inspect this task\x1b[201~\r']);
    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try {
      expect(store.list('JUD').map(m => ({ from: m.from, to: m.to, kind: m.kind, body: m.body }))).toEqual([
        { from: 'OP', to: 'JUD', kind: 'info', body: '[typed into your tab] Please inspect this task' },
      ]);
    } finally { store.close(); }
    const rows = readFileSync(join(root, 'els', 'control-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows.filter(row => row.principal === 'hq-typed-mail').map(row => ({ seat: row.seat, to: row.to, result: row.result, chars: row.chars }))).toEqual([
      { seat: 'OP', to: 'JUD', result: 'mail-posted', chars: 24 },
    ]);
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a hand seat sending prose to its own agent tab is still held and pointed at seat mail', async () => {
  const root = mkdtempSync('/tmp/op-hand-prose-'); const writes: string[] = [];
  const server = await startElsServer({ stateRoot: root, stall: false,
    seatLookup: () => ({ pane: 'tc-pane', seat: 'TC' }),
    ps: async () => '42 43 /bin/zsh\n43 43 eln\n',
    spawn: () => ({ id: 'fake', pid: 42, isAlive: () => true, write: value => writes.push(value), bracketedPasteEnabled: () => true, renderScreen: async () => '', onExit: () => {}, kill: () => {} }),
  });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const made = server.core.newPane({ ws: 'test', cwd: root, command: ['eln'], ownerSeat: 'TC' });
    expect(made.exitCode).toBe(0);
    const pane = JSON.parse(made.message).pane;
    server.core.setForegrounds(new Map([[pane, { kind: 'eln', command: ['eln'], pid: 43 }]]));
    writeFileSync(join(root, 'els/control-allow.json'), JSON.stringify({ rules: [{ principal: 'eln:tool', workspace: '*', pane: '*', actions: ['do'] }] }));
    const sent = await runElsControl({ action: 'send', pane, text: 'Please inspect this task' }, { socketPath: elsSocketPath(root), stateDir: join(root, 'els') });
    expect(sent.ok).toBe(false);
    expect(sent.message).toContain('agent prose is not supported');
    expect(sent.message).toContain('eln msg');
    expect(writes).toEqual([]);
    expect(existsSync(join(root, 'msg', 'messages.db'))).toBe(false);
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('tool do applies shell policy on the server independently of the client', async () => {
  const root = mkdtempSync('/tmp/op-tool-policy-'); const writes: string[] = [];
  const server = await startElsServer({ stateRoot: root, stall: false,
    seatLookup: () => ({ pane: 'op-pane', seat: 'OP' }),
    ps: async () => '42 42 /bin/sh\n',
    spawn: () => ({ id: 'fake', pid: 42, isAlive: () => true, write: value => writes.push(value), renderScreen: async () => '', onExit: () => {}, kill: () => {} }),
  });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const made = await requestEls(elsSocketPath(root), { op: 'new', ws: 'test', cwd: root, command: ['/bin/sh'] });
    expect(made.exitCode).toBe(0);
    const pane = JSON.parse(made.message).pane;
    // A stale UI snapshot must never cause shell policy to be skipped.
    server.core.setForegrounds(new Map([[pane, { kind: 'eln', command: ['eln'], pid: 43 }]]));
    writeFileSync(join(root, 'els/control-allow.json'), JSON.stringify({ rules: [{ principal: 'eln:tool', workspace: '*', pane: '*', actions: ['do'] }] }));
    const result = await requestEls(elsToolSocketPath(root), { op: 'do', pane, text: 'unlisted-command', from: 'test' });
    expect(result.exitCode).toBe(1);
    const input = await requestEls(elsToolSocketPath(root), { op: 'input-line', pane, text: 'unlisted-command', from: 'test' });
    expect(input.exitCode).toBe(1);
    expect(writes).toEqual([]);
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
});

// ELS-OP-CROSS-SPACE-SEND (#39797): the OP/HQ caller may type into a pane with no owner record; stop (Escape) stays owner-only.
test('ElsControl lets OP send into a pane with no seat ownership record but still refuses stop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'op-owner-')); const writes: string[] = [];
  let verified = false;
  const server = await startElsServer({ stateRoot: root,
    seatLookup: () => verified ? ({ pane: 'op-pane', seat: 'OP' }) : undefined,
    spawn: () => ({ id: 'fake', isAlive: () => true, write: (v) => writes.push(v), renderScreen: async () => '', onExit: () => {}, kill: () => {} }),
  });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const socketPath = elsSocketPath(root); const stateDir = join(root, 'els');
    const made = await requestEls(socketPath, { op: 'new', ws: 'victim', cwd: root, command: ['eln'] });
    const pane = JSON.parse(made.message).pane;
    verified = true;
    writeFileSync(join(stateDir, 'control-allow.json'), JSON.stringify({ rules: [{ principal: 'eln:tool', workspace: '*', pane: '*', actions: ['do'] }] }));
    expect(await runElsControl({ action: 'send', pane, text: 'pwd' }, { socketPath, stateDir })).toMatchObject({ ok: true, exitCode: 0 });
    expect(writes).toEqual(['pwd\r']);
    const stopped = await runElsControl({ action: 'stop', pane }, { socketPath, stateDir });
    expect(stopped.ok).toBe(false);
    expect(stopped.message).toContain('target pane owner is unknown or differs from caller seat');
    expect(writes).toEqual(['pwd\r']);
  } finally { await server.close(); }
});

test('interrupt requires verified OP and durable audit and sends only Escape', async () => {
  const root = mkdtempSync(join(tmpdir(), 'op-stop-')); const writes: string[] = [];
  let verified = false;
  const server = await startElsServer({ stateRoot: root,
    seatLookup: () => verified ? { pane: 'op-pane', seat: 'OP' } : undefined,
    spawn: () => ({ id: 'fake', isAlive: () => true, write: (v) => writes.push(v), renderScreen: async () => '', onExit: () => {}, kill: () => {} }),
  });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const ask = (request: any) => requestEls(elsSocketPath(root), request);
    verified = true;
    const made = await ask({ op: 'new', ws: 'victim', cwd: root, command: ['eln'] });
    verified = false;
    const pane = JSON.parse(made.message).pane;
    expect((await ask({ op: 'interrupt', pane })).exitCode).toBe(1);
    expect(writes).toEqual([]);
    verified = true;
    expect(await ask({ op: 'interrupt', pane, bytes: 'forged' })).toMatchObject({ exitCode: 0 });
    expect(writes).toEqual(['\x1b']);
    const audit = join(root, 'els/control-audit.jsonl');
    const rows = readFileSync(audit, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const sent = rows.filter(row => row.result === 'executed');
    expect(sent).toHaveLength(1);
    expect(sent[0].sha256).toBe(createHash('sha256').update('\x1b').digest('hex'));
    renameSync(audit, join(root, 'els/saved.jsonl')); mkdirSync(audit);
    expect((await ask({ op: 'interrupt', pane })).exitCode).toBe(1);
    expect(writes).toEqual(['\x1b']);
  } finally { await server.close(); }
});

test('interrupt is not delivered if the tool grant is revoked before execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'op-stop-revoke-')); const writes: string[] = [];
  const allow = join(root, 'els/control-allow.json');
  let armed = false; let lookups = 0;
  const server = await startElsServer({ stateRoot: root, stall: false,
    seatLookup: () => {
      if (armed && ++lookups === 2) writeFileSync(allow, JSON.stringify({ rules: [] }));
      return { pane: 'op-pane', seat: 'OP' };
    },
    spawn: () => ({ id: 'fake', isAlive: () => true, write: v => writes.push(v), renderScreen: async () => '', onExit: () => {}, kill: () => {} }),
  });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const made = await requestEls(elsSocketPath(root), { op: 'new', ws: 'test', cwd: root, command: ['eln'] });
    const pane = JSON.parse(made.message).pane;
    writeFileSync(allow, JSON.stringify({ rules: [{ principal: 'eln:tool', workspace: '*', pane: '*', actions: ['do'] }] }));
    armed = true;
    const result = await requestEls(elsToolSocketPath(root), { op: 'interrupt', pane });
    expect(lookups).toBeGreaterThanOrEqual(2);
    expect(result.exitCode).toBe(1);
    expect(writes).toEqual([]);
  } finally { await server.close(); }
});

test('verified creator owns the pane across journal reload; other seats cannot control it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'op-owner-')); const writes: string[] = [];
  let seat = 'OP';
  const options = { stateRoot: root, seatLookup: () => ({ pane: 'w1:p2', seat }),
    spawn: () => ({ id: 'fake', isAlive: () => true, write: (v: string) => writes.push(v), renderScreen: async () => '', onExit: () => {}, kill: () => {} }) };
  const server = await startElsServer(options);
  if ('exitCode' in server) throw new Error(server.message);
  let pane = '';
  try {
    const socketPath = elsSocketPath(root); const stateDir = join(root, 'els');
    const made = await requestEls(socketPath, { op: 'new', ws: 'victim', cwd: root, command: ['eln'], ownerSeat: 'RES-INFRA' } as any);
    expect(made.exitCode).toBe(0);
    pane = JSON.parse(made.message).pane;
    expect(loadJournal(join(stateDir, 'journal.json')).panes.find(p => p.id === pane)?.ownerSeat).toBe('OP');
    writeFileSync(join(stateDir, 'control-allow.json'), JSON.stringify({ rules: [{ principal: 'eln:tool', workspace: '*', pane: '*', actions: ['do'] }] }));
    seat = 'RES-INFRA';
    expect((await runElsControl({ action: 'send', pane, text: 'no' }, { socketPath, stateDir })).ok).toBe(false);
    expect((await runElsControl({ action: 'stop', pane }, { socketPath, stateDir })).ok).toBe(false);
    expect(writes).toEqual([]);
    seat = 'OP';
    expect(await runElsControl({ action: 'send', pane, text: 'pwd' }, { socketPath, stateDir })).toMatchObject({ ok: true });
    expect(writes).toEqual(['pwd\r']);
  } finally { await server.close(); }
  const restarted = await startElsServer(options);
  if ('exitCode' in restarted) throw new Error(restarted.message);
  try { expect(loadJournal(join(root, 'els', 'journal.json')).panes.find(p => p.id === pane)?.ownerSeat).toBe('OP'); }
  finally { await restarted.close(); }
});

test('queued input is discarded when the verified caller is revoked before delivery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'op-revoke-')); const writes: string[] = [];
  let verified = true; let busy = true;
  const server = await startElsServer({ stateRoot: root, stall: false,
    seatLookup: () => verified ? { pane: 'op-pane', seat: 'OP' } : undefined,
    spawn: () => ({ id: 'fake', isAlive: () => true, write: v => writes.push(v), renderScreen: async () => busy ? 'Turn running' : '', onExit: () => {}, kill: () => {} }),
  });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const socket = elsSocketPath(root);
    const made = await requestEls(socket, { op: 'new', ws: 'test', cwd: root, command: ['eln'] });
    expect(made.exitCode).toBe(0);
    const pane = JSON.parse(made.message).pane;
    const queued = await requestEls(socket, { op: 'input-line', pane, text: 'pending', from: 'test' });
    expect(queued).toMatchObject({ exitCode: 0, queued: 1 });
    verified = false; busy = false;
    await server.core.drain();
    expect(writes).toEqual([]);
    expect(server.core.queued(pane)).toBe(0);
    const rows = readFileSync(join(root, 'els/control-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows.at(-1).result).toBe('discarded');
  } finally { await server.close(); }
});

test('queued input is discarded when the caller pane shell generation changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'op-generation-')); const writes: string[] = [];
  let busy = true;
  let anchor = { pid: 7, ppid: 1, session: 3, tty: 9, start: '20:1', startedMs: 20000 };
  const server = await startElsServer({ stateRoot: root, stall: false,
    seatLookup: () => ({ pane: 'op-pane', seat: 'OP', anchor }),
    spawn: () => ({ id: 'fake', isAlive: () => true, write: v => writes.push(v), renderScreen: async () => busy ? 'Turn running' : '', onExit: () => {}, kill: () => {} }),
  });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const socket = elsSocketPath(root);
    const made = await requestEls(socket, { op: 'new', ws: 'test', cwd: root, command: ['eln'] });
    const pane = JSON.parse(made.message).pane;
    expect(await requestEls(socket, { op: 'input-line', pane, text: 'pending', from: 'test' })).toMatchObject({ exitCode: 0, queued: 1 });
    anchor = { ...anchor, start: '21:1', startedMs: 21000 }; busy = false;
    await server.core.drain();
    expect(writes).toEqual([]);
    expect(server.core.queued(pane)).toBe(0);
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('queued input is discarded when policy denies it before delivery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'op-policy-')); const writes: string[] = [];
  let busy = true;
  const server = await startElsServer({ stateRoot: root, stall: false,
    seatLookup: () => ({ pane: 'op-pane', seat: 'OP' }),
    spawn: () => ({ id: 'fake', isAlive: () => true, write: v => writes.push(v), renderScreen: async () => busy ? 'Turn running' : '', onExit: () => {}, kill: () => {} }),
  });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const socket = elsSocketPath(root);
    const made = await requestEls(socket, { op: 'new', ws: 'test', cwd: root, command: ['eln'] });
    const pane = JSON.parse(made.message).pane;
    expect(await requestEls(socket, { op: 'input-line', pane, text: 'pending', from: 'test' })).toMatchObject({ exitCode: 0, queued: 1 });
    writeFileSync(join(root, 'els/control-allow.json'), JSON.stringify({ rules: [{ principal: '*', workspace: '*', pane: '*', actions: ['input'], effect: 'deny' }] }));
    busy = false; await server.core.drain();
    expect(writes).toEqual([]);
    expect(server.core.queued(pane)).toBe(0);
  } finally { await server.close(); }
});

test('tab-scoped input deny blocks queued delivery through the server socket', async () => {
  const root = mkdtempSync(join(tmpdir(), 'op-tab-deny-')); const writes: string[] = [];
  let busy = true;
  const server = await startElsServer({ stateRoot: root, stall: false,
    seatLookup: () => ({ pane: 'op-pane', seat: 'OP' }),
    spawn: () => ({ id: 'fake', isAlive: () => true, write: v => writes.push(v), renderScreen: async () => busy ? 'Turn running' : '', onExit: () => {}, kill: () => {} }),
  });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const socket = elsSocketPath(root);
    const made = await requestEls(socket, { op: 'new', ws: 'test', cwd: root, command: ['eln'] });
    const pane = JSON.parse(made.message).pane;
    const tab = loadJournal(join(root, 'els/journal.json')).panes.find(p => p.id === pane)?.tabId;
    expect(tab).toBeDefined();
    expect(await requestEls(socket, { op: 'input-line', pane, text: 'pending', from: 'OP' })).toMatchObject({ exitCode: 0, queued: 1 });
    writeFileSync(join(root, 'els/control-allow.json'), JSON.stringify({ rules: [{ principal: '*', workspace: '*', pane: '*', tab, actions: ['input'], effect: 'deny' }] }));
    busy = false; await server.core.drain();
    expect(writes).toEqual([]);
    expect(server.core.queued(pane)).toBe(0);
  } finally { await server.close(); }
});

test('human CLI queued input survives the originating peer exiting', async () => {
  const root = mkdtempSync('/tmp/op-human-'); const writes: string[] = [];
  let busy = true, peerAlive = true;
  const anchor = { pid: 7, ppid: 1, session: 3, tty: 9, start: '20:1', startedMs: 20000 };
  const server = await startElsServer({ stateRoot: root, stall: false,
    seatLookup: (pid, baseline) => peerAlive || (pid === anchor.pid && baseline === anchor)
      ? { pane: 'op-pane', seat: 'OP', anchor } : undefined,
    spawn: () => ({ id: 'fake', isAlive: () => true, write: v => writes.push(v), renderScreen: async () => busy ? 'Turn running' : '', onExit: () => {}, kill: () => {} }),
  });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const socket = elsSocketPath(root);
    const made = await requestEls(socket, { op: 'new', ws: 'test', cwd: root, command: ['eln'] });
    const pane = JSON.parse(made.message).pane;
    const script = `import { requestEls } from ${JSON.stringify(new URL('./client.js', import.meta.url).href)}; console.log(JSON.stringify(await requestEls(${JSON.stringify(socket)}, { op: 'input-line', pane: ${JSON.stringify(pane)}, text: 'human line', from: 'OP' })));`;
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ exitCode: 0, queued: 1 });
    peerAlive = false; busy = false;
    await server.core.drain();
    expect(writes).toEqual(['human line\r']);
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('exited CLI cannot deliver queued input after its seat binding is revoked', async () => {
  const root = mkdtempSync('/tmp/op-revoke-exited-'); const writes: string[] = [];
  let busy = true, bound = true;
  const anchor = { pid: 7, ppid: 1, session: 3, tty: 9, start: '20:1', startedMs: 20000 };
  const server = await startElsServer({ stateRoot: root, stall: false,
    seatLookup: () => bound ? { pane: 'op-pane', seat: 'OP', anchor } : undefined,
    spawn: () => ({ id: 'fake', isAlive: () => true, write: v => writes.push(v), renderScreen: async () => busy ? 'Turn running' : '', onExit: () => {}, kill: () => {} }),
  });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const socket = elsSocketPath(root);
    const made = await requestEls(socket, { op: 'new', ws: 'test', cwd: root, command: ['eln'] });
    const pane = JSON.parse(made.message).pane;
    const script = `import { requestEls } from ${JSON.stringify(new URL('./client.js', import.meta.url).href)}; console.log(JSON.stringify(await requestEls(${JSON.stringify(socket)}, { op: 'input-line', pane: ${JSON.stringify(pane)}, text: 'revoked line', from: 'OP' })));`;
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ exitCode: 0, queued: 1 });
    bound = false; busy = false;
    await server.core.drain();
    expect(writes).toEqual([]);
    expect(server.core.queued(pane)).toBe(0);
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('ElsControl do rejects another seat and reauthorizes queued delivery', async () => {
  const root = mkdtempSync('/tmp/op-do-'); const writes: string[] = [];
  let busy = false, seat = 'OP';
  const server = await startElsServer({ stateRoot: root, stall: false,
    seatLookup: () => ({ pane: 'caller-pane', seat }),
    spawn: () => ({ id: 'fake', isAlive: () => true, write: v => writes.push(v), renderScreen: async () => busy ? 'Turn running' : '', onExit: () => {}, kill: () => {} }),
  });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const socketPath = elsSocketPath(root), stateDir = join(root, 'els');
    const made = await requestEls(socketPath, { op: 'new', ws: 'test', cwd: root, command: ['eln'] });
    const pane = JSON.parse(made.message).pane;
    const allow = join(stateDir, 'control-allow.json');
    writeFileSync(allow, JSON.stringify({ rules: [{ principal: 'eln:tool', workspace: '*', pane: '*', actions: ['do'] }] }));
    seat = 'RES-INFRA';
    expect((await runElsControl({ action: 'do', pane, text: 'pwd' }, { socketPath, stateDir })).ok).toBe(false);
    expect(writes).toEqual([]);
    seat = 'OP'; busy = true;
    expect(await runElsControl({ action: 'do', pane, text: 'pwd' }, { socketPath, stateDir })).toMatchObject({ ok: true, exitCode: 0 });
    writeFileSync(allow, JSON.stringify({ rules: [] }));
    busy = false; await server.core.drain();
    expect(writes).toEqual([]);
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('queued ElsControl send is discarded when its tool grant is revoked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'op-tool-revoke-')); const writes: string[] = [];
  let busy = true;
  const server = await startElsServer({ stateRoot: root, stall: false,
    seatLookup: () => ({ pane: 'op-pane', seat: 'OP' }),
    spawn: () => ({ id: 'fake', isAlive: () => true, write: v => writes.push(v), renderScreen: async () => busy ? 'Turn running' : '', onExit: () => {}, kill: () => {} }),
  });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const socketPath = elsSocketPath(root); const stateDir = join(root, 'els');
    const made = await requestEls(socketPath, { op: 'new', ws: 'test', cwd: root, command: ['eln'] });
    const pane = JSON.parse(made.message).pane;
    writeFileSync(join(stateDir, 'control-allow.json'), JSON.stringify({ rules: [{ principal: 'eln:tool', workspace: '*', pane: '*', actions: ['do'] }] }));
    expect(await runElsControl({ action: 'send', pane, text: 'pwd' }, { socketPath, stateDir })).toMatchObject({ ok: true, queued: 1 });
    writeFileSync(join(stateDir, 'control-allow.json'), JSON.stringify({ rules: [] }));
    busy = false; await server.core.drain();
    expect(writes).toEqual([]);
    expect(server.core.queued(pane)).toBe(0);
  } finally { await server.close(); }
});

test('tool listener is owner-only, rejects an unowned pane despite a human label, and closes cleanly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'op-door-')); const writes: string[] = [];
  let verified = false;
  const server = await startElsServer({ stateRoot: root,
    seatLookup: () => verified ? { pane: 'op-pane', seat: 'OP' } : undefined,
    spawn: () => ({ id: 'fake', isAlive: () => true, write: (v) => writes.push(v), renderScreen: async () => '', onExit: () => {}, kill: () => {} }),
  });
  if ('exitCode' in server) throw new Error(server.message);
  const toolSocket = elsToolSocketPath(root);
  try {
    expect(statSync(toolSocket).mode & 0o777).toBe(0o600);
    const made = await requestEls(elsSocketPath(root), { op: 'new', ws: 'legacy', cwd: root, command: ['eln'] });
    const pane = JSON.parse(made.message).pane;
    verified = true;
    const result = await requestEls(toolSocket, { op: 'input-line', pane, text: 'not delivered', from: 'OP' });
    expect(result.exitCode).toBe(1);
    expect(writes).toEqual([]);
  } finally { await server.close(); }
  expect(existsSync(toolSocket)).toBe(false);
});

test('direct raw input to an older unowned pane remains available to verified OP', async () => {
  const root = mkdtempSync(join(tmpdir(), 'op-direct-')); const writes: string[] = [];
  let verified = false; let now = 0;
  const server = await startElsServer({ stateRoot: root, now: () => now,
    seatLookup: () => verified ? { pane: 'op-pane', seat: 'OP' } : undefined,
    spawn: () => ({ id: 'fake', isAlive: () => true, write: (v) => writes.push(v), renderScreen: async () => '', onExit: () => {}, kill: () => {} }),
  });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const socket = elsSocketPath(root);
    const made = await requestEls(socket, { op: 'new', ws: 'legacy', cwd: root, command: ['eln'] });
    expect(made.exitCode).toBe(0);
    const pane = JSON.parse(made.message).pane;
    verified = true;
    expect((await requestEls(socket, { op: 'input', pane, bytes: 'human' })).exitCode).toBe(0);
    expect(await requestEls(socket, { op: 'input-line', pane, text: 'human line', from: 'OP' })).toMatchObject({ exitCode: 0, queued: 1 });
    expect(writes).toEqual(['human']);
    now += 60_000;
    await server.core.drain();
    expect(writes).toEqual(['human', 'human line\r']);
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
    lookups = 0;
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
