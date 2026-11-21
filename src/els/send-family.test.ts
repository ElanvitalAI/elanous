// #90792 (JUD #90769) P0 — the send family (send-text / send-keys) at the layers that actually run it:
//   ① core.send rejects control bytes; a printable suffix cannot become a HITL approval key,
//   ③ while a person is deciding on a pane, the control door refuses any other send to it,
//   ④ every send-family execution that reaches the owner over its socket leaves one audit line (no raw text).
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
// A Unix socket path holds at most 103 bytes (macOS): the land train's long TMPDIR puts the els server/holder socket
// under <state>/els/ over it, so a state dir under a long TMPDIR falls back to /tmp (each test removes its own dir).
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
import { join } from 'node:path';
import { requestEls } from './client.js';
import { clean, createElsCore, hitlApprovalPending, type ElsPty } from './core.js';
import { createControl } from './control.js';
import { elsSocketPath, startElsServer } from './server.js';
import { emptyJournal } from './space.js';
import { KeyStreamParser } from '../tui-key.js';
import { applyShellApprovalKey } from '../tui-client/next-shell-approval.js';

const states: string[] = [];
const stateDir = (prefix: string): string => { const dir = mkdtempSync(join(SOCKET_SAFE_TMP, prefix)); states.push(dir); return dir; };
afterEach(() => { for (const dir of states.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A pane PTY that records every write and never exits on its own. */
function fakePty(id: string, writes?: string[]): ElsPty {
  return {
    id,
    isAlive: () => true,
    write: (text) => { writes?.push(text); },
    renderScreen: async () => '$',
    onExit: () => {},
    kill: () => {},
  };
}

test('P0 ① — send-text rejects control bytes and does not write their printable suffix', async () => {
  expect(clean('a\x15b')).toBe('a b');
  expect(clean('a\rb')).toBe('a b');
  expect(clean('a\x03b')).toBe('a b');
  expect(clean('a\x1bb')).toBe('a b');
  expect(clean('\x15\r\x03\x1b')).toBe('');
  // The real path (`els pane send-text` → op send → core.send) refuses the whole mixed input.
  const writes: string[] = [];
  let n = 0;
  const core = createElsCore({ load: () => emptyJournal(), save: () => {}, spawn: () => fakePty(`p${++n}`, writes) });
  expect(core.start()).toBeUndefined();
  const pane = (JSON.parse(core.newPane({ ws: 'w', cwd: '/tmp', command: ['/bin/sh'] }).message) as { pane: string }).pane;
  writes.length = 0;
  const sent = await core.send(pane, 'echo\x03one\x15two\rthree\x1bfour');
  expect(sent.exitCode).toBe(2);
  expect(writes).toEqual([]);
  writes.length = 0;
  const onlyControl = await core.send(pane, '\x15\r\x03\x1b');
  expect(onlyControl.exitCode).toBe(2);
  expect(writes).toEqual([]);
  expect((await core.send(pane, 'hello')).exitCode).toBe(0);
  expect(writes).toEqual(['hello']);
  expect((await core.send(pane, 'y\n')).exitCode).toBe(2);
  expect(writes).toEqual(['hello']);
});

test('HITL viewport: a long command can scroll the title away but the choice row still blocks input', async () => {
  const screen = `${Array.from({ length: 40 }, (_, i) => `command line ${i}`).join('\n')}\ny ru\nn · n deny · Enter def\nault N · Esc de\nny\n❯ `;
  expect(hitlApprovalPending(screen)).toBe(true);
  const writes: string[] = [];
  const core = createElsCore({ load: () => emptyJournal(), save: () => {}, spawn: () => ({ ...fakePty('p', writes), renderScreen: async () => screen }) });
  core.start();
  const pane = (JSON.parse(core.newPane({ ws: 'w', cwd: '/tmp', command: ['/bin/sh'] }).message) as { pane: string }).pane;
  expect((await core.send(pane, 'y')).exitCode).toBe(1);
  expect(writes).toEqual([]);
});

test('HITL transition: a known Next TUI with paste mode unconfirmed never receives raw machine approval text', async () => {
  const writes: string[] = [];
  const core = createElsCore({ load: () => emptyJournal(), save: () => {}, spawn: () => ({ ...fakePty('p', writes),
    bracketedPasteEnabled: () => false, renderScreen: async () => 'elanous\n❯ ' }) });
  core.start();
  const pane = (JSON.parse(core.newPane({ ws: 'w', cwd: '/tmp', command: ['bun', 'elanous.mjs', '--tui', 'next'] }).message) as { pane: string }).pane;
  expect((await core.send(pane, 'y')).exitCode).toBe(1);
  expect((await core.machineInput(pane, 'y')).exitCode).toBe(1);
  expect((await core.do(pane, 'y', 'OP')).exitCode).toBe(1);
  expect(writes).toEqual([]);
});

test('HITL transition: an ordinary shell cannot emit a raw approval letter when it may switch to TUI after inspection', async () => {
  const writes: string[] = [];
  let screen = '$';
  const core = createElsCore({ load: () => emptyJournal(), save: () => {}, spawn: () => ({ ...fakePty('p', writes),
    bracketedPasteEnabled: () => false, renderScreen: async () => screen,
    write: (text) => { screen = 'Bash approval · Full command\ny run · n deny · Enter default N · Esc deny'; writes.push(text); } }) });
  core.start();
  const pane = (JSON.parse(core.newPane({ ws: 'w', cwd: '/tmp', command: ['/bin/sh'] }).message) as { pane: string }).pane;
  expect((await core.send(pane, 'y')).exitCode).toBe(1);
  expect((await core.machineInput(pane, 'y\r')).exitCode).toBe(2);
  expect((await core.machineInput(pane, '\x1b[121u')).exitCode).toBe(2);
  expect((await core.machineInput(pane, '\x1b[27;1;121~')).exitCode).toBe(2);
  expect((await core.do(pane, 'yes', 'OP')).exitCode).toBe(1);
  expect((await core.inputLine(pane, 'yes', 'OP')).exitCode).toBe(1);
  expect(writes).toEqual([]);
  expect((await core.send(pane, 'safe')).exitCode).toBe(0);
  expect(writes).toEqual(['safe']);
});

test('HITL socket boundary refuses control bytes, printable approval keys, and one-shot input with one body-free audit each', async () => {
  const state = stateDir('els-hitl-input-');
  const writes: string[] = [];
  const approval = 'Bash approval · Full command\n  rm -rf /isolated/target\ny run · n deny · Enter default N · Esc deny';
  const started = await startElsServer({ stateRoot: state, spawn: () => ({ ...fakePty('x', writes), renderScreen: async () => approval }), seatLookup: async () => ({ pane: 'op-pane', seat: 'OP' }) });
  if ('exitCode' in started) throw new Error(started.message);
  try {
    const socket = elsSocketPath(state);
    const made = await requestEls(socket, { op: 'new', ws: 'w', cwd: state, command: ['/bin/sh'] });
    const pane = (JSON.parse(made.message) as { pane: string }).pane;
    for (const value of ['\x03', '\x1b', '\r', '\x15', 'y\x03', 'y']) {
      const result = await requestEls(socket, { op: 'send', pane, text: value });
      expect(result.exitCode).not.toBe(0);
    }
    const verified = await requestEls(socket, { op: 'send-verified', pane, text: 'y' });
    expect(verified.exitCode).not.toBe(0);
    const keys = await requestEls(socket, { op: 'input', pane, bytes: 'y' });
    expect(keys.exitCode).not.toBe(0);
    expect(writes).toEqual([]);
    const lines = readFileSync(join(state, 'els', 'control-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(8);
    for (const line of lines) {
      expect(line.result).not.toBe('executed');
      expect(JSON.stringify(line)).not.toContain('rm -rf');
      expect(JSON.stringify(line)).not.toContain('y\\u0003');
    }
  } finally { await started.close(); }
});

test('HITL: queued seat text and OP input-line cannot type into the decision panel', async () => {
  const writes: string[] = [];
  const approval = 'Bash approval · Full command\ny run · n deny · Enter default N · Esc deny';
  const core = createElsCore({ load: () => emptyJournal(), save: () => {}, spawn: () => ({ ...fakePty('p', writes), renderScreen: async () => approval }) });
  core.start();
  const pane = (JSON.parse(core.newPane({ ws: 'w', cwd: '/tmp', command: ['/bin/sh'] }).message) as { pane: string }).pane;
  expect((await core.do(pane, 'y', 'TC')).exitCode).toBe(1);
  expect((await core.inputLine(pane, 'y', 'OP')).exitCode).toBe(1);
  expect(writes).toEqual([]);
});

test('HITL transition: one-shot machine input refuses a running turn before its approval panel can appear', async () => {
  const writes: string[] = [];
  const core = createElsCore({ load: () => emptyJournal(), save: () => {}, spawn: () => ({ ...fakePty('p', writes), renderScreen: async () => 'Turn running\n' }) });
  core.start();
  const pane = (JSON.parse(core.newPane({ ws: 'w', cwd: '/tmp', command: ['/bin/sh'] }).message) as { pane: string }).pane;
  expect((await core.send(pane, 'y')).exitCode).toBe(1);
  expect((await core.machineInput(pane, 'y')).exitCode).toBe(1);
  expect(writes).toEqual([]);
  expect((await core.do(pane, 'next instruction', 'OP')).queued).toBe(1);
});

test('HITL race: machine approval letters become paste events, never an approving key, even if the panel opens after inspection', async () => {
  const writes: string[] = [];
  const core = createElsCore({ load: () => emptyJournal(), save: () => {}, spawn: () => ({ ...fakePty('p', writes), bracketedPasteEnabled: () => true }) });
  core.start();
  const pane = (JSON.parse(core.newPane({ ws: 'w', cwd: '/tmp', command: ['/bin/sh'] }).message) as { pane: string }).pane;
  expect((await core.send(pane, 'y')).exitCode).toBe(0);
  expect((await core.machineInput(pane, 'y\r')).exitCode).toBe(0);
  expect((await core.machineInput(pane, 'y\x03')).exitCode).toBe(2);
  expect(writes).toHaveLength(2);
  const parser = new KeyStreamParser();
  const keys = parser.push(writes.join(''));
  expect(keys.map(key => key.name)).toEqual(['paste', 'paste', 'enter']);
  expect(keys[0]?.paste).toBe('y');
  expect(keys[1]?.paste).toBe('y');
  expect(applyShellApprovalKey(keys[0]!.name, keys[0]!)).toEqual({ kind: 'pending' });
  expect(applyShellApprovalKey(keys[1]!.name, keys[1]!)).toEqual({ kind: 'pending' });
  expect(applyShellApprovalKey(keys[2]!.name, keys[2]!)).toEqual({ kind: 'settled', approved: false });
});

test('P0 ③ — while a person decides on a pane, the door refuses any other send to that pane (and only then)', async () => {
  const state = stateDir('els-p0-hold-');
  writeFileSync(join(state, 'control-allow.json'), JSON.stringify({ rules: [{ principal: '*', workspace: '*', pane: '*', actions: ['do', 'read'] }] }));
  const executed: string[] = [];
  let answer: (a: 'approve' | 'deny') => void = () => {};
  const asked = new Promise<'approve' | 'deny'>((resolve) => { answer = resolve; });
  const control = createControl({
    stateDir: state,
    execute: async (input) => { executed.push(`${input.action}:${input.target.pane}`); return { exitCode: 0, message: 'done' }; },
    hitl: async () => asked,        // the person has not answered yet
  });
  const script = { id: 'script', kind: 'http-token' as const };
  const p1 = { workspace: 'w1', pane: 'p1', shell: true };
  const p2 = { workspace: 'w1', pane: 'p2', shell: true };

  // A dangerous shell line on p1: the ask is in flight (the person is deciding).
  const pending = control.run({ principal: script, action: 'do', target: p1, text: 'rm -rf /tmp/x' });
  await Promise.resolve();           // let the door reach the ask
  expect(executed).toEqual([]);      // nothing has run yet

  // While p1 waits: another send to p1 is refused …
  const during = await control.run({ principal: script, action: 'do', target: p1, text: 'echo not now' });
  expect(during.ok).toBe(false);
  if (!during.ok) expect(during.code).toBe('denied');
  // … while another pane and a read of p1 are untouched.
  const otherPane = await control.run({ principal: script, action: 'do', target: p2, text: 'echo other pane' });
  expect(otherPane.ok).toBe(true);
  const readP1 = await control.run({ principal: script, action: 'read', target: p1 });
  expect(readP1.ok).toBe(true);
  expect(executed).toEqual(['do:p2', 'read:p1']);

  // The person approves: the held line runs, and p1 accepts sends again.
  answer('approve');
  const held = await pending;
  expect(held.ok).toBe(true);
  expect(executed).toEqual(['do:p2', 'read:p1', 'do:p1']);
  const after = await control.run({ principal: script, action: 'do', target: p1, text: 'echo now' });
  expect(after.ok).toBe(true);

  // The refusal was audited (one denied line naming the deciding pane), and no line carries the raw text.
  const lines = readFileSync(join(state, 'control-audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  const deniedLine = lines.find((line) => line.result === 'denied');
  expect(deniedLine).toMatchObject({ pane: 'p1', reason: 'a person is still deciding on this pane' });
  expect(lines.every((line) => !JSON.stringify(line).includes('rm -rf'))).toBe(true);
});

test('P0 ④ — every socket send (send-text / send-keys) leaves exactly one audit line, without the raw text', async () => {
  const state = stateDir('els-p0-audit-');
  const started = await startElsServer({ stateRoot: state, spawn: () => fakePty('x'), seatLookup: async () => ({ pane: 'op-pane', seat: 'OP' }) }); // main's door (#39053): only a peer OP seat may send over the socket
  if ('exitCode' in started) throw new Error(`server did not start: ${started.message}`);
  try {
    const socket = elsSocketPath(state);
    const made = await requestEls(socket, { op: 'new', ws: 'w', cwd: state, command: ['/bin/sh'] });
    expect(made.exitCode).toBe(0);
    const pane = (JSON.parse(made.message) as { pane: string }).pane;
    const text = await requestEls(socket, { op: 'send', pane, text: 'hello world' });   // `els pane send-text`
    expect(text.exitCode).toBe(0);
    const keys = await requestEls(socket, { op: 'input', pane, bytes: '\r' });         // `els pane send-keys enter`
    expect(keys.exitCode).toBe(0);
    const refused = await requestEls(socket, { op: 'send', pane: 'no-such-pane', text: 'x' });
    expect(refused.exitCode).toBe(1);
    const lines = readFileSync(join(state, 'els', 'control-audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ action: 'send', pane, workspace: 'w', chars: 11, result: 'executed', exitCode: 0 });
    expect(lines[1]).toMatchObject({ action: 'input', pane, workspace: 'w', result: 'executed', exitCode: 0 });
    expect(lines[2]).toMatchObject({ action: 'send', pane: 'no-such-pane', result: 'executor-refused', exitCode: 1 });
    for (const line of lines) expect(JSON.stringify(line)).not.toContain('hello world');
  } finally {
    await started.close();
  }
});
