import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSeat } from './seat-open.js';
import type { ElsRequest } from './server.js';
import { createElsCore } from './core.js';
import { emptyJournal } from './space.js';
import { loadJournal, saveJournal } from './journal.js';
import { createAttachApp } from './attach-app.js';
import type { AttachHandlers } from './attach-client.js';

test('seat identity survives cwd changes and journal reload without changing creator authority', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-seat-identity-'));
  const path = join(root, 'journal.json');
  let journal = emptyJournal();
  let output: ((data: string) => void) | undefined;
  const pty = { id: 'pty', isAlive: () => true, write() {}, renderScreen: async () => '', onExit() {}, kill() {},
    onOutput(cb: (data: string) => void) { output = cb; return { dispose() {} }; } };
  const core = createElsCore({ load: () => journal, save: value => { journal = value; saveJournal(path, value); },
    spawn: () => pty, isCwdDirectory: async () => true, mailBadges: () => new Map() });
  try {
    core.start();
    const made = core.newPane({ ws: 'w', cwd: '/home/seats/TC', command: ['eln'], ownerSeat: 'OP', seatIdentity: 'TC' });
    expect(made.exitCode).toBe(0);
    output?.('\u001b]7;file:///other/project\u0007');
    for (let i = 0; i < 30 && journal.panes[0]?.cwd !== '/other/project'; i++) await Bun.sleep(10);
    expect(journal.panes[0]?.cwd).toBe('/other/project');
    expect(JSON.parse(core.list().message).panes[0]).toMatchObject({ cwd: '/other/project', seat: 'TC' });
    expect(loadJournal(path).panes[0]).toMatchObject({ seatIdentity: 'TC', ownerSeat: 'OP' });
  } finally { core.stopAll(); rmSync(root, { recursive: true, force: true }); }
});

test('focus event selects the requested tab in the actual attach app', async () => {
  const attached: string[] = [];
  const handlers = new Map<string, AttachHandlers>();
  const listing = JSON.stringify({ workspaces: [{ id: 'w', name: 'w', rootCwd: '/' }], panes: [
    { address: 'w/t1/p1', workspace: 'w', pane: 'p1', title: 'first', state: 'working', cwd: '/' },
    { address: 'w/t2/p2', workspace: 'w', pane: 'p2', title: 'seat', state: 'working', cwd: '/' },
  ] });
  const app = createAttachApp({ request: async () => ({ exitCode: 0, message: listing }),
    attach: (pane, _size, handler) => { attached.push(pane); handlers.set(pane, handler); return { input() {}, resize() {}, scroll() {}, detach() {} }; },
    write() {}, size: () => ({ cols: 100, rows: 30 }), cwd: '/', env: {}, setInterval: () => 0, clearInterval() {}, pollMs: 1000,
    chatCommand: ['eln'], memory: { load: () => ({}), save() {} } });
  try {
    await app.start('p1');
    let accepted: boolean | undefined;
    handlers.get('p1')!.onFocus!('p2', value => { accepted = value; });
    for (let i = 0; i < 30 && accepted === undefined; i++) await Bun.sleep(10);
    expect(accepted).toBe(true);
    expect(attached.at(-1)).toBe('p2');
    handlers.get('p2')!.onFocus!('missing', value => { accepted = value; });
    for (let i = 0; i < 30 && accepted !== false; i++) await Bun.sleep(10);
    expect(accepted).toBe(false);
    expect(attached.at(-1)).toBe('p2');
  } finally { app.key('\u0002q'); }
});

describe('els seat open', () => {
  test('rejects a missing seat before any server request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'els-seat-'));
    try {
      const state = join(root, 'seat-state'); mkdirSync(state);
      mkdirSync(join(root, 'seats'));
      const requests: ElsRequest[] = [];
      const result = await openSeat('missing', state, async r => {
        requests.push(r);
        return { exitCode: 0, message: '{"panes":[]}' };
      });
      expect(result).toEqual({ exitCode: 1, message: 'els seat: seat directory not found or unsafe: MISSING' });
      expect(requests).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  for (const runtime of ['eln', 'codex'] as const) {
    test(`opens using the declared ${runtime} command`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'els-seat-'));
      try {
        const state = join(root, 'seat-state'); mkdirSync(state);
        mkdirSync(join(root, 'seats', 'TC'), { recursive: true });
        writeFileSync(join(state, 'seat-registry.json'), JSON.stringify({ version: 1, seats: [{ address: 'TC', host: 'local', wake: 'none', replyBody: 'agent', optIn: false, runtime }] }));
        const requests: ElsRequest[] = [];
        const result = await openSeat('tc', state, async r => {
          requests.push(r);
          return r.op === 'ls' ? { exitCode: 0, message: '{"panes":[]}' } : { exitCode: 0, message: '{"pane":"p1"}' };
        }, { ws: `TC-${runtime}` });
        expect(result.exitCode).toBe(0);
        expect(requests).toEqual([{ op: 'ls' }, { op: 'new', ws: `TC-${runtime}`, cwd: join(root, 'seats', 'TC'), title: 'TC', command: [runtime], uniqueSeat: 'TC' }]);
        expect(JSON.parse(result.message)).toMatchObject({ pane: 'p1', existing: false });
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
  test('uses the seat directory and declared runtime; owner gets an atomic uniqueness key', async () => {
    const root = mkdtempSync(join(tmpdir(), 'els-seat-'));
    try {
      const state = join(root, 'seat-state'); mkdirSync(state);
      mkdirSync(join(root, 'seats', 'TC'), { recursive: true });
      writeFileSync(join(state, 'seat-registry.json'), JSON.stringify({ version: 1, seats: [{ address: 'TC', host: 'local', wake: 'none', replyBody: 'agent', optIn: false, runtime: 'claude-code' }] }));
      const requests: ElsRequest[] = [];
      const result = await openSeat('tc', state, async r => {
        requests.push(r);
        return r.op === 'ls' ? { exitCode: 0, message: '{"panes":[]}' } : { exitCode: 0, message: '{"pane":"p1"}' };
      }, { ws: 'TC-claude-code' });
      expect(result.exitCode).toBe(0);
      expect(requests[1]).toEqual({ op: 'new', ws: 'TC-claude-code', cwd: join(root, 'seats', 'TC'), title: 'TC', command: ['claude'], uniqueSeat: 'TC' });
      expect(JSON.parse(result.message).existing).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('uses existing live pane, refuses ambiguity, and preserves owner race result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'els-seat-'));
    try {
      const state = join(root, 'seat-state'); mkdirSync(state); mkdirSync(join(root, 'seats', 'TC'), { recursive: true });
      const pane = { seat: 'TC', state: 'working', ptyId: 'pty1', pane: 'p1', address: 'local:w/t/p1' };
      let calls = 0;
      const existing = await openSeat('TC', state, async () => { calls++; return { exitCode: 0, message: JSON.stringify({ panes: [pane] }) }; });
      expect(calls).toBe(1); expect(JSON.parse(existing.message)).toMatchObject({ pane: 'p1', existing: true });
      const ambiguous = await openSeat('TC', state, async () => ({ exitCode: 0, message: JSON.stringify({ panes: [pane, { ...pane, pane: 'p2' }] }) }));
      expect(ambiguous.exitCode).toBe(1);
      const raced = await openSeat('TC', state, async r => r.op === 'ls' ? { exitCode: 0, message: '{"panes":[]}' } : { exitCode: 0, message: '{"pane":"p2","existing":true}' });
      expect(JSON.parse(raced.message)).toMatchObject({ pane: 'p2', existing: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
