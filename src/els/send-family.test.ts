// #90792 (JUD #90769) P0 — the send family (send-text / send-keys) at the layers that actually run it:
//   ① core.send types cleaned text only: the four control bytes (\x15 \r \x03 \x1b) never reach a pane,
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
import { clean, createElsCore, type ElsPty } from './core.js';
import { createControl } from './control.js';
import { elsSocketPath, startElsServer } from './server.js';
import { emptyJournal } from './space.js';

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

test('P0 ① — send-text cannot press keys: clean() drops \\x15 \\r \\x03 \\x1b and the pane PTY writes none of them', async () => {
  expect(clean('a\x15b')).toBe('a b');
  expect(clean('a\rb')).toBe('a b');
  expect(clean('a\x03b')).toBe('a b');
  expect(clean('a\x1bb')).toBe('a b');
  expect(clean('\x15\r\x03\x1b')).toBe('');
  // The real path (`els pane send-text` → op send → core.send): the PTY sees the cleaned text only.
  const writes: string[] = [];
  let n = 0;
  const core = createElsCore({ load: () => emptyJournal(), save: () => {}, spawn: () => fakePty(`p${++n}`, writes) });
  expect(core.start()).toBeUndefined();
  const pane = (JSON.parse(core.newPane({ ws: 'w', cwd: '/tmp', command: ['/bin/sh'] }).message) as { pane: string }).pane;
  writes.length = 0;
  const sent = await core.send(pane, 'echo\x03one\x15two\rthree\x1bfour');
  expect(sent.exitCode).toBe(0);
  expect(writes).toEqual(['echo one two three four']);
  writes.length = 0;
  const onlyControl = await core.send(pane, '\x15\r\x03\x1b');
  expect(onlyControl.exitCode).toBe(0);
  expect(writes).toEqual(['']);
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
