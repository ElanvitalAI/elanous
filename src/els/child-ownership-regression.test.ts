import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { processIdentity, resolvePeerSeatWithAnchor } from './peer-seat.js';
import { elsJournalPath, loadJournal } from './journal.js';
import { elsToolSocketPath, startElsServer, type ElsRequest } from './server.js';

// Real Darwin socket peer PID and ancestry, private ledger, simulated herdr pane-info.
// No pane/owner token is sent; the socket peer is checked against its live OS identity.
test.skipIf(process.platform !== 'darwin')('promoted child lifecycle is restricted to its owning seat', async () => {
  if (process.env.ELS_CHILD_PRIVATE_TTY !== '1') {
    const child = Bun.spawn(['/usr/bin/script', '-q', '/dev/null', process.execPath, 'test', import.meta.path], {
      env: { ...process.env, ELS_CHILD_PRIVATE_TTY: '1', NO_COLOR: '1' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: out + err }).toMatchObject({ code: 0, output: expect.stringContaining('1 pass') });
    return;
  }
  const root = mkdtempSync('/tmp/els-own-');
  const ledger = join(root, 'seats.tsv');
  const previous = process.env.ELANOUS_ELS_OWNER_TOKEN;
  let lookups = 0;
  const setSeat = (seat: string) => writeFileSync(ledger, `${seat}\twFixture:p1\n`);
  setSeat('OP');
  const server = await startElsServer({ stateRoot: root, stall: false,
    seatLookup: async (pid, baseline) => {
      expect(pid).toBe(process.pid);
      expect(baseline).toEqual(processIdentity(process.pid));
      lookups++;
      return resolvePeerSeatWithAnchor(pid, baseline, ledger, {
        identity: processIdentity,
        ledger: async path => readFileSync(path, 'utf8'),
        paneInfo: async pane => ({ pane_id: pane, shell_pid: process.pid }),
      });
    },
    spawn: () => ({ id: 'fixture', isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {} }),
  });
  if ('exitCode' in server) throw new Error(server.message);
  const ask = (request: ElsRequest) => new Promise<{ exitCode: number; message: string }>((resolve, reject) => {
    const socket = createConnection(elsToolSocketPath(root)); let data = '';
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => { data += chunk.toString(); });
    socket.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    socket.on('error', reject);
  });
  try {
    expect(server.core.newPane({ ws: 'one', cwd: root, command: ['fixture'], ownerSeat: 'OP' }).exitCode).toBe(0);
    const start = (id: string, ws: string): ElsRequest => ({ op: 'child', action: 'start', id, ws, source: 'harness', label: id });
    expect((await ask(start('a', 'one'))).exitCode).toBe(0);
    expect((await ask({ op: 'child', action: 'progress', id: 'a', line: 'before pin' })).exitCode).toBe(0);
    expect((await ask({ op: 'child', action: 'pin', id: 'a' })).exitCode).toBe(0);
    const journalPath = elsJournalPath(root);
    const normalJournal = loadJournal(journalPath);
    const childPane = normalJournal.panes.find(p => p.kind === 'harness-child');
    expect(childPane).toBeDefined();
    expect(childPane?.ownerSeat).toBeUndefined();
    const ownedWorkspace = normalJournal.workspaces.find(w => w.name === 'one')!;
    writeFileSync(journalPath, JSON.stringify({ ...normalJournal, tabs: [...normalJournal.tabs,
      { id: 'empty-tab', workspaceId: ownedWorkspace.id, label: 'empty', focusPaneId: '' }] }));
    expect((await ask(start('empty-blocked', 'one'))).exitCode).toBe(1);
    writeFileSync(journalPath, JSON.stringify({ ...normalJournal, panes: normalJournal.panes.filter(p => p.kind === 'harness-child') }));
    expect((await ask(start('virtual-only-blocked', 'one'))).exitCode).toBe(1);
    const realPane = normalJournal.panes.find(p => p.kind !== 'harness-child')!;
    writeFileSync(journalPath, JSON.stringify({ ...normalJournal, panes: normalJournal.panes.map(p =>
      p.id === realPane.id ? { ...p, ownerSeat: undefined } : p) }));
    expect((await ask(start('unowned-real-blocked', 'one'))).exitCode).toBe(1);
    writeFileSync(journalPath, JSON.stringify(normalJournal));
    // A normally promoted child has no owner; it must not block another child in the owned workspace.
    expect((await ask(start('ownerless-ok', 'one'))).exitCode).toBe(0);
    expect((await ask({ op: 'child', action: 'end', id: 'ownerless-ok', ok: true, summary: 'done' })).exitCode).toBe(0);
    expect((await ask({ op: 'child', action: 'dismiss', id: 'ownerless-ok' })).exitCode).toBe(0);
    expect(server.core.newPane({ ws: 'two', cwd: root, command: ['fixture'], ownerSeat: 'OP' }).exitCode).toBe(0);
    expect((await ask({ ...start('cross-workspace', 'two'), parent: 'a' } as ElsRequest)).exitCode).toBe(1);
    expect((await ask({ op: 'child', action: 'pin', id: 'cross-workspace' })).exitCode).toBe(1);

    // Model a persisted explicit foreign owner while retaining a real socket caller and real child pane.
    const beforeForeign = loadJournal(journalPath);
    writeFileSync(journalPath, JSON.stringify({ ...beforeForeign, panes: beforeForeign.panes.map(p =>
      p.id === childPane!.id ? { ...p, ownerSeat: 'RES-INFRA' } : p) }));
    expect(loadJournal(journalPath).panes.find(p => p.id === childPane!.id)?.ownerSeat).toBe('RES-INFRA');
    const foreignChildStart = await ask(start('foreign-child-blocked', 'one'));
    expect(foreignChildStart.exitCode).toBe(1);
    expect(foreignChildStart.message).toContain('not owned by caller seat');
    writeFileSync(journalPath, JSON.stringify(beforeForeign));
    expect((await ask({ op: 'child', action: 'pin', id: 'foreign-child-blocked' })).exitCode).toBe(1);
    setSeat('RES-INFRA');
    const refused = await ask({ op: 'child', action: 'progress', id: 'a', line: 'foreign' });
    expect(refused.exitCode).toBe(1);
    expect(refused.message).toMatch(/denied/i);
    expect(loadJournal(elsJournalPath(root)).panes.find(p => p.kind === 'harness-child')?.scrollback).not.toContain('foreign');
    setSeat('OP');
    expect((await ask({ op: 'child', action: 'progress', id: 'a', line: 'step' })).exitCode).toBe(0);
    expect(loadJournal(elsJournalPath(root)).panes.find(p => p.kind === 'harness-child')?.scrollback).toContain('step');
    expect((await ask({ op: 'child', action: 'end', id: 'a', ok: false, summary: 'failed' })).exitCode).toBe(0);
    expect((await ask({ op: 'child', action: 'dismiss', id: 'a' })).exitCode).toBe(0);
    expect(loadJournal(elsJournalPath(root)).panes.some(p => p.kind === 'harness-child')).toBe(false);
    expect(server.core.newPane({ ws: 'one', cwd: root, command: ['fixture'], ownerSeat: 'RES-INFRA' }).exitCode).toBe(0);
    expect((await ask(start('b', 'one'))).message).toContain('not owned by caller seat');
    expect(server.core.newPane({ ws: 'unowned', cwd: root, command: ['fixture'] }).exitCode).toBe(0);
    expect((await ask(start('c', 'unowned'))).message).toContain('not owned by caller seat');
    expect(lookups).toBeGreaterThan(5);
  } finally {
    await server.close();
    if (previous === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
