// ELS-BATON-AUTO-ON-RESTART (대표 11-24 04:4x · CEO spec 12:3x) — literal expectations, test universe only.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BatonLease, type BatonEvent } from './baton.js';
import { requestEls } from './client.js';
import { processIdentity } from './peer-seat.js';
import { AUTH_OWNER_TOKEN_ENV, AUTH_PANE_TOKEN_ENV } from './server-auth.js';
import { elsSocketPath, startElsServer, type ElsRequest } from './server.js';
import { updateAllElsTabs, type UpdateAllDeps, type UpdatePane, type UpdateSeatRow } from './update-all.js';
import { openMsgStore, readUnreadCount } from '../msg/msg-store.js';

const T0 = Date.parse('2026-11-24T03:00:00Z');
const MIN = 60_000; // 출처: #39781 baton TTL unit (one minute)

describe('baton lease — automatic hand, return, missed registration', () => {
  test('auto-hand gives TC the lease for 15m; auto-return clears it with a memo', () => {
    let now = T0;
    const events: BatonEvent[] = [];
    const lease = new BatonLease(event => events.push(event), () => now);
    const { baton, handed } = lease.autoHand('update-all migration');
    expect(handed).toBe(true);
    expect(baton).toEqual({ owner: 'OP', acting: 'TC', reason: 'OP restart update-all migration', expiresAt: '2026-11-24T03:15:00.000Z' });
    expect(lease.autoHand('seat-stop migrate').handed).toBe(false);
    now += 2 * MIN;
    expect(lease.tick()).toBeNull();
    expect(lease.autoReturn('new OP pane registered')).toBe(true);
    expect(lease.active()).toBeNull();
    expect(lease.autoReturn('again')).toBe(false);
    expect(events.map(e => [e.action, e.actor])).toEqual([['auto-hand', 'runtime'], ['auto-return', 'runtime']]);
    expect(events[1]!.handoff).toBe('new OP pane registered');
  });

  test('new OP never registers: lease is kept (extended) and exactly one alert is raised', () => {
    let now = T0;
    const events: BatonEvent[] = [];
    const lease = new BatonLease(event => events.push(event), () => now);
    lease.autoHand('OP pane p1 exited');
    now = T0 + 14 * MIN + 30_000; // within a minute of expiry: kept silently
    expect(lease.tick()).toBeNull();
    expect(lease.active()?.acting).toBe('TC');
    now = T0 + 15 * MIN;
    const alert = lease.tick();
    expect(alert).toEqual({ acting: 'TC', reason: 'OP restart OP pane p1 exited', since: '2026-11-24T03:00:00.000Z', expiresAt: '2026-11-24T03:45:00.000Z' });
    now = T0 + 44 * MIN + 30_000;
    expect(lease.tick()).toBeNull();
    now = T0 + 120 * MIN;
    expect(lease.tick()).toBeNull();
    expect(lease.active()?.acting).toBe('TC');
    expect(events.filter(e => e.action === 'expire')).toEqual([]);
  });

  test('the local operator may hand, take and return; another seat may not', () => {
    const lease = new BatonLease(() => {}, () => T0);
    expect(() => lease.hand({ kind: 'other' }, 'OP', 'TC', 'restart', MIN)).toThrow('authenticated OP required');
    lease.hand({ kind: 'operator' }, 'OP', 'TC', 'restart', MIN);
    expect(() => lease.end('return', { kind: 'seat', seat: 'MK' }, 'OP', 'x')).toThrow('unauthorized baton return');
    lease.end('return', { kind: 'operator' }, 'OP', 'handled by Claude OP');
    expect(lease.active()).toBeNull();
    lease.hand({ kind: 'operator' }, 'OP', 'TC', 'restart', MIN);
    lease.end('take', { kind: 'operator' }, 'OP', 'back');
    expect(lease.active()).toBeNull();
  });
});

// ── update-all ordering: TC first, hand, then OP, never both down ─────────────────────────────
const DESIRED = 'b'.repeat(40);
const OLD = 'a'.repeat(40);

function world(opts: { tcComesBack: boolean }) {
  let now = T0;
  const timeline: string[] = [];
  const down = new Set<string>();
  const live: Record<string, UpdateSeatRow> = {
    OP: { id: 'op-1', seat: 'OP', ownerPid: 101, alive: true, kind: 'tui', sessionId: 's-op', workdir: '/w/OP', build: { sha: OLD, source: 'installed' } },
    TC: { id: 'tc-1', seat: 'TC', ownerPid: 201, alive: true, kind: 'tui', sessionId: 's-tc', workdir: '/w/TC', build: { sha: OLD, source: 'installed' } },
  };
  const restartAt = new Map<string, number>();
  let bothDown = 0;
  const handCalls: string[] = []; const giveBacks: string[] = []; const skips: string[] = [];
  const panes: UpdatePane[] = [
    { address: 'mshq:OP', host: 'mshq', reach: 'local', seat: 'OP', state: 'idle', cwd: '/w/OP', pid: 101, kind: 'eln' },
    { address: 'mshq:TC', host: 'mshq', reach: 'local', seat: 'TC', state: 'idle', cwd: '/w/TC', pid: 201, kind: 'eln' },
  ];
  const seats = (): UpdateSeatRow[] => {
    for (const [seat, at] of restartAt) {
      if (now >= at && (seat !== 'TC' || opts.tcComesBack)) {
        live[seat] = { ...live[seat]!, ownerPid: live[seat]!.ownerPid + 1, build: { sha: DESIRED, source: 'installed' } };
        down.delete(seat); restartAt.delete(seat); timeline.push(`${seat} up`);
      }
    }
    if (down.has('OP') && down.has('TC')) bothDown++;
    return Object.values(live).filter(row => !down.has(row.seat!));
  };
  const deps: UpdateAllDeps = {
    sender: () => 'OP',
    target: () => ({ desired: DESIRED, installed: DESIRED }),
    list: async () => ({ panes, hosts: [{ name: 'mshq', reach: 'local' }] }),
    seats,
    migrate: async (seat) => {
      timeline.push(`${seat} migrate`);
      if (down.size) bothDown += [...down].some(s => s !== seat) ? 1 : 0;
      down.add(seat); restartAt.set(seat, now + 3_000);
      return { status: 'success', reason: 'waiting' };
    },
    sleep: async (ms) => { now += ms; },
    now: () => now,
    timeoutMs: 60_000,
    baton: {
      acting: 'TC',
      hand: async (reason, exclude) => { timeline.push('baton hand'); handCalls.push(`${reason}|${exclude.join(',')}`); return { ok: true }; },
      giveBack: async (memo) => { timeline.push('baton return'); giveBacks.push(memo); return true; },
      skip: async (reason) => { timeline.push('baton skip'); skips.push(reason); },
    },
  };
  return { deps, timeline, handCalls, giveBacks, skips, bothDown: () => bothDown };
}

describe('update-all with OP and TC both stale', () => {
  test('TC restarts first, baton is handed after TC is healthy, OP restarts after, baton returns', async () => {
    const w = world({ tcComesBack: true });
    const result = await updateAllElsTabs(w.deps);
    expect(w.timeline).toEqual(['TC migrate', 'TC up', 'baton hand', 'OP migrate', 'OP up', 'baton return']);
    expect(w.bothDown()).toBe(0);
    expect(w.handCalls).toEqual([`update-all migration to ${DESIRED.slice(0, 12)}|101`]);
    expect(w.giveBacks).toEqual([`update-all: new OP 102 on ${DESIRED.slice(0, 12)}`]);
    expect(result.rows.map(r => [r.tab, r.result, r.detail])).toEqual([
      ['mshq:TC', 'updated', DESIRED.slice(0, 12)],
      ['mshq:OP', 'updated', `${DESIRED.slice(0, 12)} · baton returned`],
    ]);
    expect(result.ok).toBe(true);
  });

  test('TC never comes back healthy: OP is not restarted, one skip (acting-unhealthy)', async () => {
    const w = world({ tcComesBack: false });
    const result = await updateAllElsTabs(w.deps);
    expect(w.timeline).toEqual(['TC migrate', 'baton skip']);
    expect(w.skips).toEqual(['acting-unhealthy (deadline before the acting seat was verified)']);
    expect(w.handCalls).toEqual([]);
    expect(result.rows.find(r => r.tab === 'mshq:OP')).toEqual({ tab: 'mshq:OP', seat: 'OP', result: 'waiting', detail: 'OP not restarted this wave: acting-unhealthy (deadline before the acting seat was verified)', runtime: 'eln' });
    expect(result.ok).toBe(false);
  });
});

// ── product socket: local operator without TTY · auto-hand → registration → auto-return ────────
const envKeys = [AUTH_PANE_TOKEN_ENV, AUTH_OWNER_TOKEN_ENV, 'ELANOUS_ELS_RUNTIME_TOKEN_FILE'] as const;
/** A child must present only the pane token it is handed — never a credential inherited from an earlier test. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !(envKeys as readonly string[]).includes(key)
    && key !== 'ELANOUS_ELS_PANE' && key !== 'ELANOUS_ELS_SOCKET') env[key] = value;
  return env;
}

test.skipIf(process.platform !== 'darwin')('local operator hands and returns the baton without a TTY', async () => {
  const root = mkdtempSync(join(tmpdir(), 'eba-'));
  const saved = envKeys.map(key => process.env[key]);
  const started = await startElsServer({ stateRoot: root, seatLookup: async () => undefined,
    spawn: () => { throw new Error('no panes in this test'); } });
  if ('exitCode' in started) throw new Error(started.message);
  try {
    for (const key of envKeys) delete process.env[key];
    // Headless on purpose: no `script` wrapper, no controlling-terminal requirement for the local operator.
    const ask = (request: ElsRequest) => requestEls(elsSocketPath(root), request, 10_000);
    const hand = await ask({ op: 'baton', action: 'hand', owner: 'OP', acting: 'TC', reason: 'Claude OP restart', ttlMs: 15 * MIN });
    expect(hand.exitCode, hand.message).toBe(0);
    expect(JSON.parse((await ask({ op: 'baton', action: 'status' })).message).acting).toBe('TC');
    const back = await ask({ op: 'baton', action: 'return', owner: 'OP', handoff: 'Claude OP back' });
    expect(back.exitCode, back.message).toBe(0);
    expect((await ask({ op: 'baton', action: 'status' })).message.trim()).toBe('null');
    const events = readFileSync(join(root, 'els', 'baton-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events.map(e => [e.action, e.actor])).toEqual([['hand', 'operator'], ['return', 'operator']]);
  } finally {
    try { await started.close(); } finally {
      for (const [i, key] of envKeys.entries()) { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; }
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 30_000);

test.skipIf(process.platform !== 'darwin')('OP gap: auto-hand → old OP excluded → 15m miss alerts TC once → new OP pane registers → auto-return, 3 mails kept', async () => {
  // The live pane peer identity requires a controlling tty, including in headless pregate (as baton-socket.test).
  if (!process.env.ELS_BATON_AUTO_TTY) {
    const child = Bun.spawn(['/usr/bin/script', '-q', '/dev/null', process.execPath, 'test', import.meta.path, '-t', 'OP gap: auto-hand'],
      { env: { ...cleanEnv(), ELS_BATON_AUTO_TTY: '1', NO_COLOR: '1' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: out + err }).toMatchObject({ code: 0, output: expect.stringContaining('1 pass') });
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'ebg-'));
  let now = T0;
  let token = '';
  let paneId = '';
  const identity = processIdentity(process.pid);
  expect(identity).toBeDefined();
  const saved = envKeys.map(key => process.env[key]);
  const started = await startElsServer({ stateRoot: root, now: () => now,
    seatLookup: async () => ({ pane: 'op-pane', seat: 'OP' }),
    spawn: (_c, _d, _t, env) => {
      token = env[AUTH_PANE_TOKEN_ENV]!; paneId = env.ELANOUS_ELS_PANE!;
      return { id: paneId, pid: process.pid, processBinding: { pid: process.pid, start: identity!.start, generation: 'baton-auto' },
        isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {} };
    },
  });
  if ('exitCode' in started) throw new Error(started.message);
  try {
    for (const key of envKeys) delete process.env[key];
    const socket = elsSocketPath(root);
    const ask = (request: ElsRequest) => requestEls(socket, request, 10_000, token);
    expect(started.core.newPane({ ws: 'OP', cwd: root, command: ['sh'], ownerSeat: 'OP', parent: { kind: 'op' } }).exitCode).toBe(0);
    // The old OP TUI (this process) hands right before it stops and is excluded from counting as the new OP.
    const handed = await ask({ op: 'baton', action: 'auto-hand', reason: 'seat-stop migrate', exclude: [process.pid] });
    expect(handed.exitCode, handed.message).toBe(0);
    expect(JSON.parse(handed.message)).toMatchObject({ owner: 'OP', acting: 'TC', reason: 'OP restart seat-stop migrate' });
    // 3 mails to OP during the gap.
    mkdirSync(join(root, 'msg'), { recursive: true });
    const mailPath = join(root, 'msg', 'messages.db');
    const store = openMsgStore(mailPath);
    try { for (const n of [1, 2, 3]) store.post({ from: 'MK', to: 'OP', body: `gap mail ${n}` }); } finally { store.close(); }
    // The old OP's periodic build report does not return the lease.
    const sha = 'c'.repeat(40);
    expect((await ask({ op: 'build', pane: paneId, sha })).exitCode).toBe(0);
    expect(JSON.parse((await ask({ op: 'baton', action: 'status' })).message)?.acting).toBe('TC');
    // 15 minutes without a new OP: TC keeps it, one 🚨 to TC.
    now += 15 * MIN;
    await Bun.sleep(1_600);
    now += 1_000;
    await Bun.sleep(1_200);
    expect(JSON.parse((await ask({ op: 'baton', action: 'status' })).message)?.acting).toBe('TC');
    const alerts = () => { const s = openMsgStore(mailPath); try { return s.db.query(`SELECT body FROM msg_messages WHERE recipient = 'TC'`).all() as { body: string }[]; } finally { s.close(); } };
    expect(alerts().length).toBe(1);
    expect(alerts()[0]!.body.startsWith('🚨 [baton] the new OP pane did not register within 15m')).toBe(true);
    // The new OP TUI (a new process in the same pane) reports its build → auto-return.
    const child = Bun.spawn([process.execPath, '-e', `import { requestEls } from ${JSON.stringify(join(import.meta.dir, 'client.ts'))};
      const r = await requestEls(${JSON.stringify(socket)}, { op: 'build', pane: ${JSON.stringify(paneId)}, sha: ${JSON.stringify(sha)} }, 10000, ${JSON.stringify(token)});
      process.stdout.write(String(r.exitCode));`], { stdout: 'pipe', stderr: 'pipe', env: cleanEnv() });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(out, err).toBe('0');
    expect((await ask({ op: 'baton', action: 'status' })).message.trim()).toBe('null');
    const events = readFileSync(join(root, 'els', 'baton-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events.map(e => e.action)).toEqual(['auto-hand', 'auto-extend', 'auto-return']);
    expect(events[2].handoff).toContain('OP unread mail 3 held for the new OP pane');
    expect(readUnreadCount('OP', mailPath)).toBe(3);
    expect(alerts().length).toBe(1);
  } finally {
    try { await started.close(); } finally {
      for (const [i, key] of envKeys.entries()) { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; }
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 60_000);
