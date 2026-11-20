import { describe, expect, test } from 'bun:test';
import { baselineBeforePidLookup, processIdentity, resolvePeerSeat, peerIdentitySupported, validHerdrPane, type ProcessIdentity } from './peer-seat.js';
import { authorizeRequest, type ServerRole } from './server-auth.js';

const old: ProcessIdentity = { pid: 42, ppid: 3, session: 3, tty: 9, start: '100:123000', startedMs: 100123 };
describe('peer process generation boundary', () => {
  test('rejects new/reused PID born in or after credential lookup millisecond', () => {
    expect(baselineBeforePidLookup(old, 42, 100123)).toBeUndefined();
    expect(baselineBeforePidLookup(old, 42, 100122)).toBeUndefined();
    expect(baselineBeforePidLookup(old, 42, 100124)).toEqual(old);
    expect(baselineBeforePidLookup(old, 43, 100124)).toBeUndefined();
    expect(baselineBeforePidLookup(undefined, 42, 100124)).toBeUndefined();
  });
  test('missing baseline denies before consulting any ledger', async () => {
    expect(await resolvePeerSeat(process.pid, undefined, '/nonexistent/op17/seat-panes.tsv')).toBeUndefined();
  });
  test('impossible PID is never a process identity', () => {
    expect(processIdentity(-1)).toBeUndefined();
    expect(processIdentity(undefined)).toBeUndefined();
  });
});

test('platform and pane grammar fail closed', () => {
  expect(peerIdentitySupported('darwin')).toBe(true);
  expect(peerIdentitySupported('linux')).toBe(false);
  expect(peerIdentitySupported('win32')).toBe(false);
  expect(validHerdrPane('wK:p3')).toBe(true);
  expect(validHerdrPane('w1:p19')).toBe(true);
  for (const pane of ['-x', 'w1:p2\n', 'w1:p2 --help', 'w1:p', 'w1:p2/x']) expect(validHerdrPane(pane)).toBe(false);
});

test('resolver denies changed pane shell, changed generation, and changed ledger', async () => {
  const peer: ProcessIdentity = { pid: 42, ppid: 3, session: 3, tty: 9, start: '100:1', startedMs: 100000 };
  const shell: ProcessIdentity = { pid: 3, ppid: 1, session: 3, tty: 9, start: '90:1', startedMs: 90000 };
  const harness = (change: 'none' | 'pane' | 'generation' | 'ledger') => {
    let paneReads = 0, ledgerReads = 0, peerReads = 0;
    return {
      ledger: async () => ++ledgerReads === 2 && change === 'ledger' ? 'OP\tw1:p3\n' : 'OP\tw1:p2\n',
      paneInfo: async () => ({ pane_id: 'w1:p2', shell_pid: ++paneReads === 2 && change === 'pane' ? 4 : 3 }),
      identity: (pid: number | undefined) => pid === 42 ? (++peerReads === 2 && change === 'generation' ? { ...peer, start: '101:1' } : peer) : pid === 3 ? shell : undefined,
    };
  };
  expect(await resolvePeerSeat(42, peer, 'isolated', harness('none'))).toEqual({ seat: 'OP', pane: 'w1:p2' });
  for (const scenario of ['pane', 'generation', 'ledger'] as const)
    expect(await resolvePeerSeat(42, peer, 'isolated', harness(scenario))).toBeUndefined();
});

test('an unavailable unrelated privileged pane does not block a verified peer', async () => {
  const peer: ProcessIdentity = { pid: 42, ppid: 3, session: 3, tty: 9, start: '100:1', startedMs: 100000 };
  const shell: ProcessIdentity = { pid: 3, ppid: 1, session: 3, tty: 9, start: '90:1', startedMs: 90000 };
  const identity = (pid: number | undefined) => pid === 42 ? peer : pid === 3 ? shell : undefined;
  const run = (ledgerText: string, op: 'throw' | 'missing' | 'wrong' | 'match', res: 'match' | 'wrong' | 'throw' = 'match') => resolvePeerSeat(42, peer, 'isolated', {
    identity, ledger: async () => ledgerText,
    paneInfo: async (pane) => {
      if (pane === 'w1:p1') {
        if (op === 'throw') throw new Error('unavailable');
        if (op === 'missing') return undefined;
        return { pane_id: pane, shell_pid: op === 'match' ? 3 : 10 };
      }
      if (res === 'throw') throw new Error('unavailable');
      return { pane_id: pane, shell_pid: res === 'match' ? 3 : 10 };
    },
  });
  const ledger = 'OP\tw1:p1\nRES-INFRA\tw1:p2\n';
  for (const op of ['throw', 'missing', 'wrong'] as const)
    expect(await run(ledger, op)).toEqual({ seat: 'RES-INFRA', pane: 'w1:p2' });
  expect(await run(ledger, 'throw', 'wrong')).toBeUndefined();
  expect(await run(ledger, 'wrong', 'throw')).toBeUndefined();
  expect(await run(ledger, 'match', 'match')).toBeUndefined();
  expect(await run('OP\tw1:p1\nRES-INFRA\tw1:p1\n', 'throw')).toBeUndefined();
  expect(await run('OP\tw1:p1\nRES-INFRA\tw1:p2\nOTHER\tw1:p2\n', 'throw')).toBeUndefined();
});

test.if(process.platform === 'darwin')('Darwin accepted Unix socket exposes actual peer pid', async () => {
  const { createServer, createConnection } = await import('node:net');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { peerPid } = await import('./peer-seat.js');
  const root = mkdtempSync(join(tmpdir(), 'op17pid-'));
  const path = join(root, 's');
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
    const result = new Promise<number | undefined>((resolve) => server.once('connection', socket => { resolve(peerPid(socket)); socket.destroy(); }));
    const client = createConnection(path); client.on('error', () => {});
    expect(await result).toBe(process.pid);
    client.destroy();
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

// JUD #39096 must ⓒ (OP #106966·#107197): els pane 조상 검사 — 무토큰 pane 자손 탐지.
import { resolveAncestorPane } from './peer-seat.js';

test('JUD #39096 ⓒ — resolveAncestorPane: els pane 셸 조상이 있으면 그 pane 을 밝힌다', async () => {
  const peer = { pid: 42, ppid: 3, session: 3, tty: 9, start: '100:1', startedMs: 100000 };
  const shell = { pid: 3, ppid: 1, session: 3, tty: 9, start: '90:1', startedMs: 90000 };
  const identity = (pid: number) => (pid === 42 ? peer : pid === 3 ? shell : undefined);
  expect(await resolveAncestorPane(42, peer, [{ pane: 'w1:p1', pid: 3 }], { identity })).toEqual({ pane: 'w1:p1' });
  expect(await resolveAncestorPane(42, peer, [{ pane: 'w1:p1', pid: 999 }], { identity })).toBeUndefined();
  expect(await resolveAncestorPane(43, peer, [{ pane: 'w1:p1', pid: 3 }], { identity })).toBeUndefined();
});

// JUD #39096 must ⓒ (OP #107371·#107528): no-token typing is fail-closed — a setsid/double-fork
// caller has no resolvable pane ancestor, so its typing ops (input-line AND interactive
// input/resize) are denied by default; a human types with the owner token.
test('JUD #39096 ⓒ — no-token input-line is denied by default regardless of ancestors/rules', () => {
  const OUTSIDER: ServerRole = { kind: 'outsider', note: 'daemonized — no pane ancestor' };
  expect(authorizeRequest(OUTSIDER, { op: 'input-line', pane: 'p1', text: 'x', from: 'HAND' }, 'w1', []).allow).toBe(false);
});

// JUD #39096 ⓒ (#107528): interactive typing ops are default-deny for a no-token connection.
test('JUD #39096 ⓒ — no-token interactive input/resize are denied; view-only attach stays allowed', () => {
  const OUTSIDER: ServerRole = { kind: 'outsider', note: 'daemonized — no pane ancestor' };
  // resize carries cols/rows beyond RequestShape — pass via a const so TS's excess-property
  // check on fresh literals does not fire; the cast-free literal satisfies RequestShape structurally.
  const resizeReq = { op: 'resize', pane: 'p1', cols: 80, rows: 24 };
  expect(authorizeRequest(OUTSIDER, { op: 'input', pane: 'p1', text: 'x' }, 'w1', []).allow).toBe(false);
  expect(authorizeRequest(OUTSIDER, resizeReq, 'w1', []).allow).toBe(false);
  expect(authorizeRequest(OUTSIDER, { op: 'attach', pane: 'p1' }, 'w1', []).allow).toBe(true);
});

test('JUD #39096 ⓒ — the owner token types; reading (attach) keeps its rules', () => {
  const OWNER: ServerRole = { kind: 'owner', note: 'human with the owner token' };
  const resizeReq = { op: 'resize', pane: 'p1', cols: 80, rows: 24 };
  expect(authorizeRequest(OWNER, { op: 'input-line', pane: 'p1', text: 'x', from: 'OP' }, 'w1', []).allow).toBe(true);
  expect(authorizeRequest(OWNER, { op: 'input', pane: 'p1', text: 'k' }, 'w1', []).allow).toBe(true);
  expect(authorizeRequest(OWNER, resizeReq, 'w1', []).allow).toBe(true);
});
