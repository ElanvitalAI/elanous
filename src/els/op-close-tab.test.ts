// ELS-OP-CLOSE-TAB (대표 11-24 «보안 기본 완화 · 큰 비가역만 사람에게»): the OP coordinator closes a seat's tab without a
// person; a hand seat still needs one; the OP tab itself is refused without one. Expectations are literals.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ElsPty } from './core.js';
import { runElsControl } from './els-control-tool.js';
import { authorizeRequest, closeTabAuditLine, PaneRegistry, resolveTabCloseScope, type ServerRole } from './server-auth.js';
import { elsSocketPath, startElsServer } from './server.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const tempDir = (prefix: string): string => { const dir = mkdtempSync(join(tmpdir(), prefix)); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };

const OP_PANE: ServerRole = { kind: 'op', pane: 'p-op' };
const OP_PEER: ServerRole = { kind: 'peer', pid: 7, pane: 'p-op', seat: 'OP', uid: 501 };
const HAND: ServerRole = { kind: 'hand', seat: 'TC', workspaces: ['W'], pane: 'p-tc' };
const JUD_TAB = { tabId: 't-jud', workspace: 'W', ownerSeats: ['JUD-A'], opTab: false, label: 'JUD-A', paneCount: 2 };
const OP_TAB = { tabId: 't-op', workspace: 'W', ownerSeats: ['OP'], opTab: true, label: 'OP', paneCount: 1 };

describe('server door: close-tab', () => {
  test('the OP pane, a verified OP peer and the acting OP close a seat tab without a person', () => {
    expect(authorizeRequest(OP_PANE, { op: 'close-tab', tab: 't-jud' }, 'W', undefined, JUD_TAB)).toEqual({ allow: true });
    expect(authorizeRequest(OP_PEER, { op: 'close-tab', tab: 't-jud' }, 'W', undefined, JUD_TAB)).toEqual({ allow: true });
    expect(authorizeRequest(HAND, { op: 'close-tab', tab: 't-jud' }, 'W', undefined, JUD_TAB, true)).toEqual({ allow: true });
  });

  test('a non-OP seat still needs a person', () => {
    expect(authorizeRequest(HAND, { op: 'close-tab', tab: 't-jud' }, 'W', undefined, JUD_TAB)).toEqual(
      { allow: false, reason: 'els: close-tab denied — close needs confirm:true (human confirmation)' });
  });

  test('the OP tab itself is refused without a person — for every caller', () => {
    const refused = { allow: false, reason: "els: close-tab denied — the OP tab itself is closed only with a person's confirmation" };
    for (const role of [OP_PANE, OP_PEER, { kind: 'owner', note: 'x' } as ServerRole, { kind: 'outsider', note: 'x' } as ServerRole]) {
      expect(authorizeRequest(role, { op: 'close-tab', tab: 't-op' }, 'W', undefined, OP_TAB)).toEqual(refused);
    }
    expect(authorizeRequest(OP_PANE, { op: 'close-tab', tab: 't-op', confirmed: true }, 'W', undefined, OP_TAB)).toEqual({ allow: true });
  });

  test('the tab scope marks a tab holding a registered OP pane or a pane seated OP', () => {
    const registry = new PaneRegistry();
    registry.registerSpawn({ ELANOUS_ELS_PANE: 'p-op', ELANOUS_ELS_WS: 'W' }, '/x', { kind: 'op' });
    const listed = { workspaces: [{ id: 'w', name: 'W' }], tabs: [{ id: 't1', workspaceId: 'w', label: 'OP' }, { id: 't2', workspaceId: 'w', label: 'JUD-A' }, { id: 't3', workspaceId: 'w', label: 'seated' }],
      panes: [{ pane: 'p-op', tab: 't1' }, { pane: 'p-j1', tab: 't2', seat: 'JUD-A' }, { pane: 'p-j2', tab: 't2', seat: 'JUD-A' }, { pane: 'p-s', tab: 't3', seat: 'OP' }] };
    expect(resolveTabCloseScope(listed, registry.entries(), 't1')).toMatchObject({ opTab: true, label: 'OP', paneCount: 1 });
    expect(resolveTabCloseScope(listed, registry.entries(), 't2')).toMatchObject({ opTab: false, label: 'JUD-A', paneCount: 2 });
    expect(resolveTabCloseScope(listed, registry.entries(), 't3')).toMatchObject({ opTab: true });
  });

  test('els.close audit line: caller · tab label · pane count · confirmed', () => {
    const line = closeTabAuditLine(OP_PANE, JUD_TAB, false);
    expect(JSON.parse(JSON.stringify({ ...line, ts: 'T' })) as unknown).toEqual({ ts: 'T', event: 'els.close', principal: 'els-pane:p-op(OP)', workspace: 'W', tab: 't-jud',
      label: 'JUD-A', panes: 2, action: 'close-tab', result: 'allowed', confirmed: false });
    expect(closeTabAuditLine(HAND, JUD_TAB, false, true)).toMatchObject({ principal: 'els-pane:p-tc(TC)', actingOp: true });
  });
});

describe('server socket: OP closes a seat tab, logged', () => {
  const askRaw = (root: string, request: object, authLine?: object): Promise<{ exitCode: number; message: string }> => new Promise((resolve, reject) => {
    const socket = createConnection(elsSocketPath(root));
    let data = '';
    socket.on('connect', () => { if (authLine) socket.write(`${JSON.stringify(authLine)}\n`); socket.write(`${JSON.stringify(request)}\n`); });
    socket.on('data', (chunk) => { data += chunk.toString(); });
    socket.on('end', () => resolve(JSON.parse(data.split('\n').filter(Boolean).pop()!) as { exitCode: number; message: string }));
    socket.on('error', reject);
  });

  test('OP (registered owner) closes a non-OP tab unconfirmed → closed + els.close line; its own tab is refused', async () => {
    const root = tempDir('els-op-close-');
    const killed: string[] = [];
    let n = 0;
    const started = await startElsServer({ stateRoot: root, spawn: (_command, _cwd, title): ElsPty => {
      const id = `pty_${n++}`;
      return { id, isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => { killed.push(String(title)); } };
    } });
    if ('exitCode' in started) throw new Error(started.message);
    cleanups.push(() => started.close());
    const ownerAuth = { op: 'auth', token: readFileSync(join(root, 'els', 'owner-token'), 'utf8').trim() };
    // A seat tab made by a no-credential caller (hand role, no seat) and the OP's own tab made by the OP.
    const seatTab = JSON.parse((await askRaw(root, { op: 'new', ws: 'W', cwd: '/w', command: ['sh'], title: 'JUD-A' })).message) as { pane: string };
    expect((await askRaw(root, { op: 'seat-set', seat: 'OP' }, ownerAuth)).exitCode).toBe(0);
    const opTab = JSON.parse((await askRaw(root, { op: 'new', ws: 'W', cwd: '/w', command: ['sh'], title: 'OP' }, ownerAuth)).message) as { pane: string };
    const listed = JSON.parse((await askRaw(root, { op: 'ls' })).message) as { panes: Array<{ pane: string; tab: string }> };
    const tabOf = (pane: string): string => listed.panes.find((row) => row.pane === pane)!.tab;

    const closed = await askRaw(root, { op: 'close-tab', tab: tabOf(seatTab.pane) }, ownerAuth);
    expect(closed.exitCode, closed.message).toBe(0);
    expect(killed).toEqual(['JUD-A']);
    const audit = readFileSync(join(root, 'els', 'control-audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((row) => JSON.parse(row) as Record<string, unknown>);
    const closeLine = audit.find((row) => row.event === 'els.close')!;
    expect({ principal: closeLine.principal, tab: closeLine.tab, label: closeLine.label, panes: closeLine.panes, confirmed: closeLine.confirmed })
      .toEqual({ principal: 'els-pane:server-owner(OP)', tab: tabOf(seatTab.pane), label: 'JUD-A', panes: 1, confirmed: false });

    const refused = await askRaw(root, { op: 'close-tab', tab: tabOf(opTab.pane) }, ownerAuth);
    expect(refused.exitCode).toBe(1);
    expect(refused.message).toBe("els: close-tab denied — the OP tab itself is closed only with a person's confirmation");
    expect(killed).toEqual(['JUD-A']);
  });
});

describe('ElsControl tool: close', () => {
  const LISTING = {
    workspaces: [{ id: 'w1', name: 'one' }],
    tabs: [{ id: 't-jud', workspaceId: 'w1' }, { id: 't-op', workspaceId: 'w1' }],
    panes: [{ pane: 'p-jud', tab: 't-jud', kind: 'agent', seat: 'JUD-A' }, { pane: 'p-op', tab: 't-op', kind: 'agent', seat: 'OP' }],
  };
  async function fakeEls(dir: string): Promise<{ received: Record<string, unknown>[] }> {
    const received: Record<string, unknown>[] = [];
    const server: Server = createServer((socket: Socket) => {
      let buffer = '';
      let timer: ReturnType<typeof setTimeout> | undefined;
      const handle = (line: string): void => {
        const request = JSON.parse(line) as Record<string, unknown>;
        if (request.op !== 'auth' && request.op !== 'ls') received.push(request);
        const message = request.op === 'ls' ? JSON.stringify(LISTING) : request.op === 'auth' ? 'auth: fixture' : 'els close: tab t-jud (1 panes)';
        socket.write(`${JSON.stringify({ exitCode: 0, message })}\n`);
      };
      socket.on('data', (chunk) => {
        buffer += String(chunk);
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line) handle(line);
          index = buffer.indexOf('\n');
        }
        // The client may send its last line without a newline (same fixture rule as els-control-tool.test.ts).
        if (timer) clearTimeout(timer);
        if (buffer.trim()) timer = setTimeout(() => { const line = buffer.trim(); buffer = ''; handle(line); }, 150);
      });
    });
    await new Promise<void>((resolve) => server.listen(join(dirname(join(dir, 's.sock')), 'ctl.sock'), () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return { received };
  }

  test('OP caller closes a non-OP tab without asking → close-tab sent and audited', async () => {
    const dir = tempDir('elsctl-op-close-');
    const fake = await fakeEls(dir);
    let asked = 0;
    const outcome = await runElsControl({ action: 'close', pane: 'p-jud' },
      { socketPath: join(dir, 's.sock'), stateDir: dir, seat: { name: 'OP' }, ask: async () => { asked += 1; return false; } });
    expect(outcome.ok).toBe(true);
    expect(asked).toBe(0);
    expect(fake.received).toEqual([{ op: 'close-tab', tab: 't-jud' }]);
    const audit = readFileSync(join(dir, 'control-audit.jsonl'), 'utf8');
    expect(audit).toContain('"action":"close"');
  });

  test('a non-OP seat caller still needs the person: no confirm → denied, nothing sent', async () => {
    const dir = tempDir('elsctl-mk-close-');
    const fake = await fakeEls(dir);
    writeFileSync(join(dir, 'control-allow.json'), JSON.stringify({ rules: [{ principal: '*', workspace: 'w1', pane: '*', actions: ['close'] }] }));
    const outcome = await runElsControl({ action: 'close', pane: 'p-jud' }, { socketPath: join(dir, 's.sock'), stateDir: dir, seat: { name: 'MK' } });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('close needs confirm:true (human confirmation)');
    expect(fake.received).toEqual([]);
  });

  test('OP caller closing the OP tab itself is refused, nothing sent', async () => {
    const dir = tempDir('elsctl-op-self-');
    const fake = await fakeEls(dir);
    const outcome = await runElsControl({ action: 'close', pane: 'p-op' }, { socketPath: join(dir, 's.sock'), stateDir: dir, seat: { name: 'OP' } });
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('op-tab');
    expect(fake.received).toEqual([]);
  });
});
