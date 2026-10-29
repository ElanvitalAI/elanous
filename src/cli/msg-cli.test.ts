import { setDefaultTimeout, afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { MsgStore, type Message } from '../msg/msg-store.js';
import { readPostOffice, writePostOffice } from '../msg/msg-post-office.js';
import { startMsgSseServer } from '../msg/msg-sse-server.js';
import { formatMessage, registerMsgCommands, type MsgCliDeps } from './msg-cli.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(stdin = '', overrides: (context: { path: string }) => Partial<MsgCliDeps> = () => ({})) {
  const dir = mkdtempSync(join(tmpdir(), 'msg-cli-'));
  dirs.push(dir);
  const path = join(dir, 'messages.db');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  const program = new Command();
  const signal = new AbortController();
  let sleeps = 0;
  registerMsgCommands(program, {
    openStore: () => new MsgStore(path),
    out: { log: line => stdout.push(line), error: line => stderr.push(line) },
    readStdin: async () => stdin,
    sleep: async () => { sleeps++; signal.abort(); }, signal: signal.signal,
    setExitCode: code => exits.push(code),
    // Real wake reads the pty manifest and seat folders; focused tests opt in through overrides.
    registerLogSink: async () => undefined,
    wake: async (address, msgId) => ({ wake: 'none', source: 'unresolved', address, msgId, result: 'skipped-test-universe' }),
    ...overrides({ path }),
  });
  return {
    run: async (...args: string[]) => { await program.parseAsync(['msg', ...args], { from: 'user' }); },
    store: () => new MsgStore(path), stdout, stderr, exits, signal, path,
    get sleeps() { return sleeps; },
  };
}

test('post reads piped stdin, accepts literal body and kind; human and JSON outputs preserve envelope', async () => {
  const f = fixture('  stdin with\nnew line  ');
  await f.run('post', '--from', 's', '--to', 't', '--kind', 'memo');
  expect(f.stderr).toEqual([]);
  expect(f.stdout[0]).toContain('OP → MK [memo]:   stdin with\nnew line  ');
  const store = f.store();
  try { expect(store.list('MK')[0]).toMatchObject({ id: 1, from: 'OP', to: 'MK', body: '  stdin with\nnew line  ', kind: 'memo' }); }
  finally { store.close(); }
  f.stdout.length = 0;
  await f.run('post', 'explicit', '--from', 'ux', '--to', 'mk', '--json');
  expect(JSON.parse(f.stdout[0]!)).toMatchObject({ id: 2, from: 'UX', to: 'MK', body: 'explicit' });
  f.stdout.length = 0;
  await f.run('post', '--body', 'from flag', '--from', 'OP', '--to', 'MK', '--json');
  expect(JSON.parse(f.stdout[0]!).body).toBe('from flag');
});

test('msg mirror with no configured target or pointer fails closed before opening the ledger or GitHub transport', async () => {
  const f = fixture('', () => ({
    mirrorTarget: null,
    mirrorState: { read: () => null, write: () => { throw new Error('disabled mirror must not write state'); } },
    mirrorTransport: {} as NonNullable<MsgCliDeps['mirrorTransport']>,
  }));
  await f.run('mirror', '--dry-run', '--json');
  expect(f.stdout).toEqual(['{"status":"disabled","reason":"msgMirror.target is not configured","target":null}']);
  expect(f.stderr).toEqual([]);
  expect(existsSync(f.path)).toBe(false);
});

test('post warns for recipients without a reply body and leaves loop aliases invalid', async () => {
  const f = fixture();
  for (const recipient of ['GUARDIAN', 'ORCHESTRATOR', 'STEWARD']) {
    await f.run('post', 'request', '--from', 'UX', '--to', recipient, '--json');
    expect(JSON.parse(f.stdout.at(-1)!).to).toBe(recipient);
    expect(f.stderr.at(-1)).toContain('이 주소는 읽는 몸이 없다 — 지금은 OP');
  }
  const posted = f.stdout.length;
  await f.run('post', 'request', '--from', 'UX', '--to', 'loop:orchestrator');
  expect(f.stdout).toHaveLength(posted);
  expect(f.stderr.at(-2)).toContain('지금 읽는 주소는 COORDINATOR');
  expect(f.stderr.at(-1)).toContain('invalid seat ID');
  expect(f.exits.at(-1)).toBe(2);
  await f.run('post', 'request', '--from', 'UX', '--to', 'loop:ORCHESTRATOR');
  expect(f.stderr.at(-2)).toContain('지금 읽는 주소는 COORDINATOR');
  expect(f.stderr.at(-1)).toContain('invalid seat ID');
  await f.run('post', 'request', '--from', 'UX', '--to', 'loop:guardian');
  expect(f.stderr.at(-2)).toContain('GUARDIAN은 읽는 몸이 없다 — 지금은 OP');
  expect(f.stderr.at(-1)).toContain('invalid seat ID');
});

test('post wakes the recipient after the durable save; a reply is passed through and a failed wake keeps rc 0', async () => {
  const calls: Array<{ address: string; msgId: number; message: { from: string; kind?: string }; stored: number }> = [];
  const f = fixture('', ({ path }) => ({
    wake: async (address, msgId, message) => {
      const ledger = new MsgStore(path);
      try { calls.push({ address, msgId, message, stored: ledger.list(address, 0, 10).length }); }
      finally { ledger.close(); }
      throw new Error('wake exploded');
    },
  }));
  const sync = fixture('', () => ({ wake: (() => { throw new Error('sync wake'); }) as unknown as MsgCliDeps['wake'],
    registerLogSink: (() => { throw new Error('sync sink'); }) as unknown as MsgCliDeps['registerLogSink'] }));
  await sync.run('post', 'still saved', '--from', 'OP', '--to', 'OPT', '--json');
  expect(sync.exits).toEqual([]);
  expect(JSON.parse(sync.stdout[0]!).id).toBe(1);
  let woke = 0;
  const hungSink = fixture('', () => ({ registerLogSink: () => new Promise(() => {}), wake: async (address, msgId) => {
    woke++; return { wake: 'none', source: 'unresolved', address, msgId, result: 'no-wake' };
  } }));
  const started = Date.now();
  await hungSink.run('post', 'sink hangs', '--from', 'OP', '--to', 'OPT');
  expect(woke).toBe(1);
  expect(Date.now() - started).toBeLessThan(5000);
  await f.run('post', 'hello', '--from', 'OP', '--to', 'opt', '--json');
  await f.run('post', 'answer', '--from', 'OPT', '--to', 'OP', '--kind', 'reply', '--json');
  expect(calls).toEqual([
    { address: 'OPT', msgId: 1, message: { from: 'OP' }, stored: 1 },
    { address: 'OP', msgId: 2, message: { from: 'OPT', kind: 'reply' }, stored: 1 },
  ]);
  expect(f.exits).toEqual([]);
  expect(f.stdout.map(line => JSON.parse(line).id)).toEqual([1, 2]);
});

test('post with the real wake warns once for an unresolved seat and stays quiet when no reply body was announced', async () => {
  const f = fixture('', () => ({ wake: undefined, wakeDeps: { listPtys: () => [], readPane: () => null, live: false } }));
  await f.run('post', 'hello', '--from', 'OP', '--to', 'UX');
  expect(f.exits).toEqual([]);
  expect(f.stderr).toEqual(['이 주소는 깨울 길이 없다 — 받는 몸이 스스로 읽을 때까지 쌓인다 (wake=none · 모름: no-pty-name-no-herdr-pane)']);
  await f.run('post', 'hello', '--from', 'OP', '--to', 'GUARDIAN');
  expect(f.stderr.at(-1)).toBe('이 주소는 읽는 몸이 없다 — 지금은 OP');
  expect(f.stderr).toHaveLength(2);
});

test('route shows reply body and resolved wake for loop and seat addresses', async () => {
  const f = fixture('', () => ({ wakeDeps: { listPtys: () => [{ id: 'tui:9', nickname: 'opt', alive: true }], readPane: () => null, hasOptIn: () => false } }));
  await f.run('route', 'coordinator', '--json');
  await f.run('route', 'opt', '--json');
  await f.run('route', 'ux', '--json');
  expect(f.stdout.map(line => JSON.parse(line))).toEqual([
    { msgAddress: 'COORDINATOR', replyBody: 'rules', wake: 'cron', source: 'loop-table' },
    { msgAddress: 'OPT', replyBody: 'agent', wake: 'pty-inject', target: 'tui:9', source: 'pty-name', optIn: false },
    { msgAddress: 'UX', replyBody: 'agent', wake: 'none', source: 'unresolved', reason: 'no-pty-name-no-herdr-pane' },
  ]);
  await f.run('route', 'opt');
  expect(f.stdout.at(-1)).toBe('OPT\treplyBody=agent\twake=pty-inject\ttarget=tui:9\toptIn=no(주입 0)\t(pty-name)');
});

test('post --origin-key deduplicates a channel mirror, accepts a loop address, and rejects a mismatched key', async () => {
  const f = fixture();
  const args = ['--from', 'MK', '--to', 'COORDINATOR', '--kind', 'coord', '--origin-key', 'coord:65001:COORDINATOR', '--json'];
  await f.run('post', '--body', 'first channel body', ...args);
  const first = JSON.parse(f.stdout.at(-1)!);
  await f.run('post', '--body', 'changed on retry', ...args);
  expect(JSON.parse(f.stdout.at(-1)!)).toEqual(first);
  const store = f.store();
  try { expect(store.list('COORDINATOR')).toEqual([first]); }
  finally { store.close(); }
  await f.run('post', '--body', 'wrong target', '--from', 'MK', '--to', 'UX', '--origin-key', 'coord:65001:COORDINATOR');
  expect(f.exits.at(-1)).toBe(2);
  expect(f.stderr.at(-1)).toContain('provenance recipient does not match');
  const reopened = f.store();
  try { expect(reopened.list('UX')).toEqual([]); }
  finally { reopened.close(); }
});

test('post --to ALL reaches other seats and a loop address through the existing list, watch and unread commands', async () => {
  const f = fixture();
  await f.run('post', 'one row', '--from', 'OP', '--to', 'ALL', '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toMatchObject({ from: 'OP', to: 'ALL', body: 'one row' });
  await f.run('list', '--to', 'MK', '--json');
  const mk = JSON.parse(f.stdout.at(-1)!) as Array<{ id: number; to: string }>;
  expect(mk).toHaveLength(1);
  expect(mk[0]!.to).toBe('ALL');
  await f.run('list', '--to', 'OP', '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toEqual([]);
  await f.run('unread', '--to', 'COORDINATOR', '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toEqual([{ recipient: 'COORDINATOR', count: 1 }]);
  await f.run('watch', '--to', 'TC', '--since-ack', '--once', '--json');
  expect(JSON.parse(f.stdout.at(-1)!).to).toBe('ALL');
  await f.run('ack', String(mk[0]!.id), '--to', 'MK');
  await f.run('unread', '--to', 'MK', '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toEqual([]);
  expect(f.stderr).toEqual([]);
});

test('list pages by recipient and cursor; unread and watch are read-only until explicit ack', async () => {
  const f = fixture();
  const store = f.store();
  try {
    store.post({ from: 'OP', to: 'MK', body: 'first' });
    store.post({ from: 'MK', to: 'UX', body: 'other' });
    store.post({ from: 'OP', to: 'MK', body: 'second' });
  } finally { store.close(); }
  await f.run('list', '--to', 't', '--limit', '1', '--json');
  expect(JSON.parse(f.stdout.pop()!).map((row: { id: number }) => row.id)).toEqual([1]);
  await f.run('list', '--to', 'MK', '--after', '1');
  expect(f.stdout.pop()).toContain('#3 ');
  await f.run('unread', '--json');
  expect(JSON.parse(f.stdout.pop()!)).toEqual([{ recipient: 'MK', count: 2 }, { recipient: 'UX', count: 1 }]);
  await f.run('watch', '--to', 'CMO', '--once', '--json');
  expect(f.stdout.splice(0).map(line => JSON.parse(line).id)).toEqual([1, 3]);
  await f.run('watch', '--to', 'MK', '--after', '1', '--json');
  expect(f.stdout.splice(0).map(line => JSON.parse(line).id)).toEqual([3]);
  expect(f.sleeps).toBe(1);
  const before = f.store();
  try { expect(before.getCursor('MK')).toBe(0); } finally { before.close(); }
  await f.run('ack', '1', '--to', 't', '--json');
  expect(JSON.parse(f.stdout.pop()!)).toEqual({ recipient: 'MK', cursor: 1 });
  await f.run('list', '--to', 'MK', '--json');
  expect(JSON.parse(f.stdout.pop()!).map((row: { id: number }) => row.id)).toEqual([3]);
  await f.run('ack', '3', '--to', 'MK');
  expect(f.stdout.pop()).toBe('MK acknowledged through #3');
  await f.run('unread', '--to', 't');
  expect(f.stdout.pop()).toBe('No unread messages.');
  await f.run('unread');
  expect(f.stdout.pop()).toBe('UX: 1 unread');
  const reopened = f.store();
  try { expect(reopened.getCursor('MK')).toBe(3); } finally { reopened.close(); }
});

test('watch prints only unacknowledged messages for the seat and never acks by itself', async () => {
  const f = fixture();
  const store = f.store();
  try {
    store.post({ from: 'OP', to: 'MK', body: 'acknowledged' });
    store.ack('MK', 1);
    store.post({ from: 'OP', to: 'MK', body: 'unacknowledged' });
    store.post({ from: 'OP', to: 'UX', body: 'other seat' });
  } finally { store.close(); }

  const before = f.store();
  try { expect(before.getCursor('MK')).toBe(1); } finally { before.close(); }

  await f.run('watch', '--to', 'MK', '--since-ack', '--once', '--json');
  expect(f.stdout.map(line => JSON.parse(line).id)).toEqual([2]);
  expect(f.stderr).toEqual([]);

  const after = f.store();
  try { expect(after.getCursor('MK')).toBe(1); } finally { after.close(); }

  await f.run('watch', '--to', 'MK', '--since-ack', '--after', '0', '--once');
  expect(f.exits.at(-1)).toBe(2);
  expect(f.stderr.at(-1)).toBe('msg: --since-ack cannot be used with --after');
  expect(f.stdout).toHaveLength(1);
});

test('post --reply-to links a reply to its question through the durable store', async () => {
  const f = fixture();
  await f.run('post', 'what about the budget?', '--from', 'op', '--to', 'tc', '--json');
  const question = JSON.parse(f.stdout.at(-1)!);
  await f.run('post', 'settled yesterday', '--from', 'tc', '--to', 'op', '--reply-to', String(question.id), '--json');
  const reply = JSON.parse(f.stdout.at(-1)!);
  expect(reply.replyTo).toBe(question.id);
  const store = f.store();
  try {
    expect(store.listReplies(question.id).map(message => message.body)).toEqual(['settled yesterday']);
    expect(store.getMessage(reply.id)).toMatchObject({ replyTo: question.id });
  } finally { store.close(); }
  await f.run('post', 'bad target', '--from', 'OP', '--to', 'MK', '--reply-to', '1.5');
  expect(f.exits.at(-1)).toBe(2);
  expect(f.stderr.at(-1)).toMatch(/^msg: --reply-to must be an integer/);
  await f.run('post', 'zero target', '--from', 'OP', '--to', 'MK', '--reply-to', '0');
  expect(f.exits.at(-1)).toBe(2);
  expect(f.stderr.at(-1)).toMatch(/^msg: --reply-to must be an integer/);
  await f.run('post', 'missing target', '--from', 'OP', '--to', 'MK', '--reply-to', '999');
  expect(f.exits.at(-1)).toBe(2);
  expect(f.stderr.at(-1)).toBe('msg: reply target not found: #999');
  const unchanged = f.store();
  try { expect(unchanged.list('MK')).toEqual([]); } finally { unchanged.close(); }
});

test('list --thread shows the durable request and reply across seats without changing DM, ALL or ack', async () => {
  const f = fixture();
  await f.run('post', 'request', '--from', 'OP', '--to', 'TC', '--json');
  const request = JSON.parse(f.stdout.at(-1)!) as Message;
  await f.run('post', 'notice', '--from', 'MK', '--to', 'ALL', '--json');
  const notice = JSON.parse(f.stdout.at(-1)!) as Message;
  await f.run('post', 'reply', '--from', 'TC', '--to', 'OP', '--reply-to', String(request.id), '--json');
  const reply = JSON.parse(f.stdout.at(-1)!) as Message;
  await f.run('list', '--thread', String(request.id), '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toEqual([request, reply]);
  await f.run('list', '--thread', String(request.id), '--after', String(request.id), '--limit', '1', '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toEqual([reply]);
  await f.run('list', '--to', 'TC', '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toEqual([request, notice]);
  await f.run('list', '--to', 'OP', '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toEqual([notice, reply]);
  await f.run('ack', String(request.id), '--to', 'TC');
  await f.run('list', '--to', 'TC', '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toEqual([notice]);
  await f.run('list', '--thread', String(request.id), '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toEqual([request, reply]);
  await f.run('thread', String(reply.id), '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toEqual({ question: request, replies: [reply] });
  await f.run('list', '--thread', String(reply.id), '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toEqual([request, reply]);
  const store = f.store();
  try { expect(store.getCursor('TC')).toBe(request.id); expect(store.getCursor('OP')).toBe(0); }
  finally { store.close(); }
  expect(f.stderr).toEqual([]);
  expect(f.exits).toEqual([]);
  await f.run('list', '--thread', String(request.id), '--to', 'TC');
  expect(f.stderr.at(-1)).toBe('msg: --thread cannot be used with --to');
  await f.run('list', '--thread', '999');
  expect(f.stderr.at(-1)).toBe('msg: message not found: #999');
  expect(f.exits).toEqual([2, 2]);
});

test('ask waits for the first reply pointing at its question and exits 0', async () => {
  let postedDuringWait = false;
  const f = fixture('', ({ path }) => ({
    sleep: async () => {
      postedDuringWait = true;
      const store = new MsgStore(path);
      try { store.post({ from: 'TC', to: 'OP', body: '42 ships on friday', replyTo: 1 }); }
      finally { store.close(); }
    },
  }));
  await f.run('ask', 'tc', 'what ships on friday?', '--from', 'op', '--wait', '5', '--json');
  expect(f.stderr).toEqual([]);
  expect(f.exits).toEqual([]);
  expect(postedDuringWait).toBe(true);
  expect(JSON.parse(f.stdout[0]!)).toMatchObject({ id: 1, from: 'OP', to: 'TC', body: 'what ships on friday?' });
  expect(JSON.parse(f.stdout.at(-1)!)).toMatchObject({ id: 2, from: 'TC', to: 'OP', body: '42 ships on friday', replyTo: 1 });
  const store = f.store();
  try {
    expect(store.getMessage(1)).toMatchObject({ from: 'OP', to: 'TC', body: 'what ships on friday?' });
    expect(store.listReplies(1).map(message => message.id)).toEqual([2]);
  } finally { store.close(); }
});

test('ask requires an explicit sender and does not post on behalf of OP', async () => {
  const f = fixture();
  await f.run('ask', 'tc', 'what ships on friday?', '--wait', '0');
  expect(f.exits.at(-1)).toBe(2);
  expect(f.stderr.at(-1)).toMatch(/--from/);
  const store = f.store();
  try { expect(store.list('TC')).toEqual([]); }
  finally { store.close(); }
});

test('ask without a reply prints the question id and exits 2', async () => {
  const f = fixture();
  await f.run('ask', 'tc', 'anyone alive?', '--from', 'op', '--wait', '0');
  expect(f.exits.at(-1)).toBe(2);
  expect(f.stderr.at(-1)).toBe('msg: no reply to #1 within 0s');
  expect(f.stdout).toEqual(['#1']);
  const store = f.store();
  try { expect(store.list('TC')).toHaveLength(1); expect(store.listReplies(1)).toEqual([]); }
  finally { store.close(); }
  await f.run('ask', '../bad', 'question', '--from', 'op');
  expect(f.exits.at(-1)).toBe(2);
  expect(f.stderr.at(-1)).toBe('msg: invalid seat ID');
});

test('ask reports interruption separately from reply timeout', async () => {
  const f = fixture();
  await f.run('ask', 'TC', 'question', '--from', 'OP', '--wait', '60');
  expect(f.exits.at(-1)).toBe(2);
  expect(f.stderr.at(-1)).toBe('msg: ask interrupted after posting #1');
});

test('real ask reports the durable question ID when SIGINT interrupts waiting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'msg-cli-interrupt-'));
  dirs.push(dir);
  const path = join(dir, 'msg', 'messages.db');
  const script = `import { Command } from 'commander'; import { registerMsgCommands } from './src/cli/msg-cli.ts'; const cli = new Command(); registerMsgCommands(cli); await cli.parseAsync(process.argv.slice(1), { from: 'user' });`;
  const child = Bun.spawn(['bun', '-e', script, 'msg', 'ask', 'TC', 'question', '--from', 'OP', '--wait', '60'], {
    cwd: process.cwd(), env: { ...process.env, ELANOUS_STATE_DIR: dir }, stdout: 'pipe', stderr: 'pipe',
  });
  try {
    let posted = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (existsSync(path)) {
        try {
          const store = new MsgStore(path, { readOnly: true });
          try { posted = store.getMessage(1) !== null; } finally { store.close(); }
        } catch { /* Writer may still be initializing its schema. */ }
      }
      if (posted) break;
      await Bun.sleep(20);
    }
    expect(posted).toBe(true);
    child.kill('SIGINT');
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code, stderr).toBe(2);
    expect(stderr).toContain('msg: ask interrupted after posting #1');
  } finally { if (child.exitCode === null) child.kill(); }
});

test('ask catches SIGINT immediately after the question is stored', async () => {
  const f = fixture('', ({ path }) => ({
    signal: undefined,
    openStore: () => {
      const store = new MsgStore(path);
      const post = store.post.bind(store);
      store.post = (input) => {
        const message = post(input);
        process.emit('SIGINT');
        return message;
      };
      return store;
    },
  }));
  await f.run('ask', 'TC', 'question', '--from', 'OP', '--wait', '60');
  expect(f.exits.at(-1)).toBe(2);
  expect(f.stderr.at(-1)).toBe('msg: ask interrupted after posting #1');
  const store = f.store();
  try { expect(store.getMessage(1)).toMatchObject({ body: 'question', from: 'OP', to: 'TC' }); }
  finally { store.close(); }
});

test('thread prints the question and its replies in time order', async () => {
  const f = fixture();
  const store = f.store();
  let questionId = 0;
  try {
    const question = store.post({ from: 'OP', to: 'TC', body: 'the question' });
    questionId = question.id;
    store.post({ from: 'MK', to: 'UX', body: 'unrelated' });
    store.post({ from: 'TC', to: 'OP', body: 'first reply', replyTo: questionId });
    store.post({ from: 'TC', to: 'OP', body: 'second reply', replyTo: questionId });
  } finally { store.close(); }
  await f.run('thread', String(questionId), '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toMatchObject({
    question: { id: questionId, body: 'the question' },
    replies: [
      { id: 3, body: 'first reply', replyTo: questionId },
      { id: 4, body: 'second reply', replyTo: questionId },
    ],
  });
  await f.run('thread', String(questionId));
  const lines = f.stdout.splice(-3);
  expect(lines[0]).toContain('the question');
  expect(lines[1]).toContain('first reply');
  expect(lines[2]).toContain('second reply');
  await f.run('thread', '999');
  expect(f.exits.at(-1)).toBe(2);
  expect(f.stderr.at(-1)).toBe('msg: message not found: #999');
  await f.run('thread', '1.5');
  expect(f.exits.at(-1)).toBe(2);
  expect(f.stderr.at(-1)).toMatch(/^msg: message ID must be an integer/);
  const untouched = f.store();
  try { expect(untouched.getCursor('TC')).toBe(0); } finally { untouched.close(); }
});

test('thread pages past a full reply page instead of silently truncating the thread', async () => {
  const f = fixture();
  const store = f.store();
  try {
    const question = store.post({ from: 'OP', to: 'TC', body: 'the question' });
    for (let index = 1; index <= 101; index++) store.post({ from: 'TC', to: 'OP', body: `reply ${index}`, replyTo: question.id });
  } finally { store.close(); }
  await f.run('thread', '1', '--json');
  const thread = JSON.parse(f.stdout.at(-1)!) as { question: { id: number }; replies: Array<{ id: number; body: string }> };
  expect(thread.question.id).toBe(1);
  expect(thread.replies).toHaveLength(101);
  expect(thread.replies.map(reply => reply.id)).toEqual(Array.from({ length: 101 }, (_, index) => index + 2));
  expect(thread.replies[99]).toMatchObject({ body: 'reply 100' });
  expect(thread.replies[100]).toMatchObject({ body: 'reply 101' });
  await f.run('thread', '1');
  expect(f.stdout.at(-1)).toContain('reply 101');
}, 120000);
test('CLI list, thread and post --reply-to leave a pre-threading ledger undamaged', async () => {
  const f = fixture();
  const legacy = new Database(f.path);
  try {
    legacy.exec(`CREATE TABLE msg_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      body TEXT NOT NULL,
      kind TEXT,
      created_at TEXT NOT NULL
    );`);
    legacy.query('INSERT INTO msg_messages(sender, recipient, body, kind, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('OP', 'TC', 'old question', 'memo', '2026-10-01T00:00:00.000Z');
    legacy.query('INSERT INTO msg_messages(sender, recipient, body, created_at) VALUES (?, ?, ?, ?)')
      .run('TC', 'OP', 'old answer', '2026-10-01T00:01:00.000Z');
  } finally { legacy.close(); }
  const oldQuestion = { id: 1, from: 'OP', to: 'TC', body: 'old question', kind: 'memo', createdAt: '2026-10-01T00:00:00.000Z' };
  const oldAnswer = { id: 2, from: 'TC', to: 'OP', body: 'old answer', createdAt: '2026-10-01T00:01:00.000Z' };
  await f.run('list', '--to', 'TC', '--after', '0', '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toEqual([oldQuestion]);
  await f.run('thread', '1', '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toEqual({ question: oldQuestion, replies: [] });
  await f.run('post', 'new reply', '--from', 'TC', '--to', 'OP', '--reply-to', '1', '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toMatchObject({ id: 3, from: 'TC', to: 'OP', body: 'new reply', replyTo: 1 });
  await f.run('thread', '1', '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toMatchObject({
    question: oldQuestion,
    replies: [{ id: 3, body: 'new reply', replyTo: 1 }],
  });
  const store = f.store();
  try {
    expect(store.getMessage(1)).toEqual(oldQuestion);
    expect(store.getMessage(2)).toEqual(oldAnswer);
    expect(store.getMessage(1)!.replyTo).toBeUndefined();
    expect(store.getMessage(2)!.replyTo).toBeUndefined();
    expect(store.getCursor('TC')).toBe(0);
    expect(store.getCursor('OP')).toBe(0);
  } finally { store.close(); }
});
test('watch --sse falls back to the durable ledger during a disconnected service', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'msg-cli-sse-'));
  dirs.push(dir);
  const path = join(dir, 'messages.db');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const signal = new AbortController();
  const program = new Command();
  let polls = 0;
  registerMsgCommands(program, {
    openStore: () => new MsgStore(path),
    out: { log: line => stdout.push(line), error: line => stderr.push(line) },
    authToken: () => 'same-nexus-token',
    fetch: (async () => { throw new Error('service stopped'); }) as unknown as typeof fetch,
    signal: signal.signal,
    sleep: async () => {
      polls++;
      if (polls === 1) {
        const writer = new MsgStore(path);
        try { writer.post({ from: 'OP', to: 'TC', body: 'posted during outage' }); }
        finally { writer.close(); }
      } else signal.abort();
    },
  });
  await program.parseAsync(['msg', 'watch', '--to', 'TC', '--sse', 'http://127.0.0.1:1', '--json'], { from: 'user' });
  expect(stdout.map((line) => JSON.parse(line).body)).toEqual(['posted during outage']);
  expect(stderr).toHaveLength(1);
  const store = new MsgStore(path);
  try { expect(store.getCursor('TC')).toBe(0); } finally { store.close(); }
});

test('watch --sse receives a live event and prints the matching durable message once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'msg-cli-sse-live-'));
  dirs.push(dir);
  const path = join(dir, 'messages.db');
  const store = new MsgStore(path);
  const service = startMsgSseServer({ store, token: 'same-nexus-token', port: 0, pollMs: 100 });
  const signal = new AbortController();
  const stdout: string[] = [];
  const program = new Command();
  registerMsgCommands(program, {
    openStore: () => new MsgStore(path),
    out: { log: line => { stdout.push(line); signal.abort(); }, error: () => {} },
    authToken: () => 'same-nexus-token',
    signal: signal.signal,
  });
  try {
    const watching = program.parseAsync(['msg', 'watch', '--to', 'TC', '--sse', `http://127.0.0.1:${service.port}`, '--json'], { from: 'user' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    store.post({ from: 'OP', to: 'TC', body: 'live' });
    await watching;
    expect(stdout.map((line) => JSON.parse(line).body)).toEqual(['live']);
  } finally { service.stop(); store.close(); }
});

test('watch --sse leaves a silent half-open stream and recovers from the ledger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'msg-cli-sse-idle-'));
  dirs.push(dir);
  const path = join(dir, 'messages.db');
  const signal = new AbortController();
  const stdout: string[] = [];
  const program = new Command();
  registerMsgCommands(program, {
    openStore: () => new MsgStore(path),
    out: { log: line => { stdout.push(line); signal.abort(); }, error: () => {} },
    authToken: () => 'same-nexus-token',
    fetch: (async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(': connected\n\n'));
    } }), { status: 200 })) as unknown as typeof fetch,
    signal: signal.signal,
  });
  const writer = new MsgStore(path);
  const post = setTimeout(() => writer.post({ from: 'OP', to: 'TC', body: 'while silent' }), 100);
  try {
    await program.parseAsync(['msg', 'watch', '--to', 'TC', '--sse', 'http://127.0.0.1:1', '--interval', '1', '--json'], { from: 'user' });
    expect(stdout.map((line) => JSON.parse(line).body)).toEqual(['while silent']);
  } finally { clearTimeout(post); writer.close(); }
});

test('watch --sse returns to ledger polling when fetch never sends response headers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'msg-cli-sse-connect-'));
  dirs.push(dir);
  const path = join(dir, 'messages.db');
  const signal = new AbortController();
  const stdout: string[] = [];
  const program = new Command();
  registerMsgCommands(program, {
    openStore: () => new MsgStore(path),
    out: { log: line => { stdout.push(line); signal.abort(); }, error: () => {} },
    authToken: () => 'same-nexus-token',
    fetch: (() => new Promise<Response>(() => {})) as unknown as typeof fetch,
    signal: signal.signal,
  });
  const writer = new MsgStore(path);
  const post = setTimeout(() => writer.post({ from: 'OP', to: 'TC', body: 'before response' }), 100);
  try {
    await program.parseAsync(['msg', 'watch', '--to', 'TC', '--sse', 'http://127.0.0.1:1', '--interval', '1', '--json'], { from: 'user' });
    expect(stdout.map((line) => JSON.parse(line).body)).toEqual(['before response']);
  } finally { clearTimeout(post); writer.close(); }
});

test('real stdin piping and validation failure use process exit 2 without a stack', () => {
  const dir = mkdtempSync(join(tmpdir(), 'msg-cli-child-'));
  dirs.push(dir);
  const script = `import { Command } from 'commander'; import { registerMsgCommands } from './src/cli/msg-cli.ts';\nconst cli = new Command(); registerMsgCommands(cli); await cli.parseAsync(process.argv.slice(1), { from: 'user' });`;
  const env = { ...process.env, ELANOUS_STATE_DIR: dir };
  const post = spawnSync('bun', ['-e', script, 'msg', 'post', '--from', 'OP', '--to', 'MK', '--json'],
    { cwd: process.cwd(), env, input: 'actual piped stdin', encoding: 'utf8' });
  expect(post.status, post.stderr).toBe(0);
  expect(JSON.parse(post.stdout).body).toBe('actual piped stdin');
  const invalid = spawnSync('bun', ['-e', script, 'msg', 'ack', '1.2', '--to', 'MK'],
    { cwd: process.cwd(), env, encoding: 'utf8' });
  expect(invalid.status).toBe(2);
  expect(invalid.stdout).toBe('');
  expect(invalid.stderr.trim()).toMatch(/^msg: message ID must be an integer/);
  expect(invalid.stderr).not.toContain('    at ');
  for (const args of [
    ['list', '--to'],
    ['post', 'body', '--from', 'OP', '--to', 'MK', '--unexpected'],
  ]) {
    const parsed = spawnSync('bun', ['-e', script, 'msg', ...args],
      { cwd: process.cwd(), env, encoding: 'utf8' });
    expect(parsed.status, `${args.join(' ')}: ${parsed.stderr}`).toBe(2);
    expect(parsed.stdout).toBe('');
    expect(parsed.stderr.trim()).toMatch(/^error: (option '--to <seat>' argument missing|unknown option '--unexpected')$/);
    expect(parsed.stderr).not.toContain('    at ');
  }
  const help = spawnSync('bun', ['-e', script, 'msg', 'list', '--help'],
    { cwd: process.cwd(), env, encoding: 'utf8' });
  expect(help.status, help.stderr).toBe(0);
  expect(help.stdout).toContain('--to <seat>');
  expect(help.stderr).toBe('');
  const reply = spawnSync('bun', ['-e', script, 'msg', 'post', 'settled yesterday', '--from', 'MK', '--to', 'OP', '--reply-to', '1', '--json'],
    { cwd: process.cwd(), env, encoding: 'utf8' });
  expect(reply.status, reply.stderr).toBe(0);
  expect(JSON.parse(reply.stdout)).toMatchObject({ id: 2, replyTo: 1 });
  const thread = spawnSync('bun', ['-e', script, 'msg', 'thread', '1'],
    { cwd: process.cwd(), env, encoding: 'utf8' });
  expect(thread.status, thread.stderr).toBe(0);
  expect(thread.stdout).toContain('actual piped stdin');
  expect(thread.stdout).toContain('settled yesterday');
  const askTimeout = spawnSync('bun', ['-e', script, 'msg', 'ask', 'MK', 'anyone alive?', '--from', 'OP', '--wait', '1'],
    { cwd: process.cwd(), env, encoding: 'utf8' });
  expect(askTimeout.status, askTimeout.stderr).toBe(2);
  expect(askTimeout.stdout).toContain('#3');
  expect(askTimeout.stderr.trim()).toBe('msg: no reply to #3 within 1s');
  expect(askTimeout.stderr).not.toContain('    at ');
});

test('bad seats, body, kind, cursor, limit and future ack exit 2 with one-line error, no stack or mutation', async () => {
  const f = fixture('');
  for (const args of [
    ['post', '--from', 'OP', '--to', 'MK'],
    ['post', 'body', '--to', 'MK'],
    ['list'],
    ['watch', '--once'],
    ['unread', '--to', '../MK'],
    ['post', 'body', '--from', '../bad', '--to', 'MK'],
    ['post', 'body', '--from', 'OP', '--to', 'MK', '--kind', 'BAD!'],
    ['post', 'body', '--body', 'duplicate', '--from', 'OP', '--to', 'MK'],
    ['list', '--to', 'MK', '--after', '-1'],
    ['list', '--to', 'MK', '--limit', '1.5'],
    ['watch', '--to', 'MK', '--interval', '0', '--once'],
    ['ack', '1', '--to', 'MK'],
    ['ack', '1.2', '--to', 'MK'],
    ['ack', '--to', 'MK'],
  ]) {
    const before = f.stderr.length;
    await f.run(...args);
    expect(f.exits.at(-1)).toBe(2);
    expect(f.stderr.length).toBe(before + 1);
    expect(f.stderr.at(-1)).toMatch(/^msg: [^\n]+$/);
    expect(f.stderr.at(-1)).not.toContain('    at ');
  }
  expect(f.stdout).toEqual([]);
  const store = f.store();
  try { expect(store.unread()).toEqual([]); expect(store.getCursor('MK')).toBe(0); }
  finally { store.close(); }
});

test('TA status, memo and stop use the card run and link exactly one reply to each message', async () => {
  const sent: Array<{ space: string; message: unknown }> = [];
  const card = { id: 'ta-20261015-a1b2c3', status: 'launched' as const, runId: 'run-card-1',
    text: 'task', createdAt: new Date().toISOString(), history: [] };
  const f = fixture('', () => ({
    readCard: id => id === card.id ? card : undefined,
    podFragmentsForRun: () => [{ spaceId: 'pod-card-1', runId: card.runId, context: 'ctx', namespace: 'ns', job: 'job', inboxDir: '/tmp/inbox' }],
    sendPod: (space, message) => { sent.push({ space, message }); return { job: 'job' }; },
  }));
  await f.run('ask', 'TA', `status ${card.id}?`, '--from', 'OP', '--wait', '0', '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toMatchObject({ from: 'TA', to: 'OP', replyTo: 1, body: `${card.id}: launched · run ${card.runId}` });
  await f.run('post', `memo ${card.id} please check the build`, '--from', 'OP', '--to', 'TA');
  await f.run('post', `stop ${card.id}`, '--from', 'OP', '--to', 'TA');
  const store = f.store();
  try {
    const messages = store.list('TA');
    expect(messages).toHaveLength(3);
    for (const message of messages) expect(store.listReplies(message.id)).toHaveLength(1);
    expect(store.listReplies(messages[1]!.id)[0]!.body).toContain('감독 메모 기록');
    expect(store.listReplies(messages[2]!.id)[0]!.body).toContain('soft stop 요청');
  } finally { store.close(); }
  expect(sent).toEqual([
    { space: 'pod-card-1', message: { memo: { version: 1, kind: 'supervisor', urgency: 'normal', body: 'please check the build' } } },
    { space: 'pod-card-1', message: { stop: true } },
  ]);
  expect(f.exits).toEqual([]);
});

test('TA retries of the same origin-key request do not send a second memo or reply', async () => {
  const sent: unknown[] = [];
  const card = { id: 'ta-20261015-a1b2c3', status: 'launched' as const, runId: 'run-card-1',
    text: 'task', createdAt: new Date().toISOString(), history: [] };
  const f = fixture('', () => ({
    readCard: id => id === card.id ? card : undefined,
    podFragmentsForRun: () => [{ spaceId: 'pod-card-1', runId: card.runId, context: 'ctx', namespace: 'ns', job: 'job', inboxDir: '/tmp/inbox' }],
    sendPod: (_space, message) => { sent.push(message); return { job: 'job' }; },
  }));
  const args = ['post', `memo ${card.id} once only`, '--from', 'OP', '--to', 'TA', '--origin-key', 'coord:7:TA'];
  await f.run(...args);
  await f.run(...args);
  const store = f.store();
  try {
    expect(store.list('TA')).toHaveLength(1);
    expect(store.listReplies(1)).toHaveLength(1);
  } finally { store.close(); }
  expect(sent).toEqual([{ memo: { version: 1, kind: 'supervisor', urgency: 'normal', body: 'once only' } }]);
});

test('TA does not resend an ambiguous memo when the previous sender died', async () => {
  const sent: unknown[] = [];
  const card = { id: 'ta-20261015-a1b2c3', status: 'launched' as const, runId: 'run-card-1',
    text: 'task', createdAt: new Date().toISOString(), history: [] };
  const f = fixture('', () => ({
    readCard: () => undefined,
    podFragmentsForRun: () => [{ spaceId: 'pod-card-1', runId: card.runId, context: 'ctx', namespace: 'ns', job: 'job', inboxDir: '/tmp/inbox' }],
    sendPod: (_space, message) => { sent.push(message); return { job: 'job' }; },
  }));
  const key = 'coord:77:TA';
  const store = f.store();
  try {
    const request = store.appendWithProvenance({ from: 'OP', to: 'TA', body: `memo ${card.id} check build` }, key);
    store.post({ from: 'TA', to: 'OP', body: '전달 여부 미확인 — 런 인박스를 확인하세요', replyTo: request.id });
    store.setTaDeliveryStatus(request.id, 'pending');
    store.claimTaDelivery(request.id);
  } finally { store.close(); }
  await f.run('post', `memo ${card.id} check build`, '--from', 'OP', '--to', 'TA', '--origin-key', key);
  expect(sent).toEqual([]);
  const after = f.store();
  try {
    expect(after.list('TA')).toHaveLength(1);
    expect(after.listReplies(1)).toHaveLength(1);
    expect(after.listReplies(1)[0]!.body).toContain('전달 여부 미확인');
  } finally { after.close(); }
});

test('TA keeps a claim when DB settlement fails after Pod publication', async () => {
  let sent = 0;
  const card = { id: 'ta-20261015-a1b2c3', status: 'launched' as const, runId: 'run-card-1',
    text: 'task', createdAt: new Date().toISOString(), history: [] };
  const f = fixture('', ({ path }) => ({
    openStore: () => {
      const store = new MsgStore(path);
      store.settleTaDelivery = () => { throw new Error('settlement interrupted'); };
      return store;
    },
    readCard: id => id === card.id ? card : undefined,
    podFragmentsForRun: () => [{ spaceId: 'pod-card-1', runId: card.runId, context: 'ctx', namespace: 'ns', job: 'job', inboxDir: '/tmp/inbox' }],
    sendPod: () => { sent++; return { job: 'job' }; },
  }));
  const args = ['post', `memo ${card.id} once only`, '--from', 'OP', '--to', 'TA', '--origin-key', 'coord:78:TA'];
  await f.run(...args);
  await f.run(...args);
  const store = f.store();
  try {
    expect(store.list('TA')).toHaveLength(1);
    expect(store.listReplies(1)).toHaveLength(1);
    expect(store.listReplies(1)[0]!.body).toContain('전달 여부 미확인');
    expect(store.taDeliveryStatus(1)).toBe('pending');
    expect(store.taDeliveryClaimState(1)).toBe('held');
  } finally { store.close(); }
  expect(sent).toBe(1);
});

test('TA stops automatic Pod memo retry when transport failure leaves publication uncertain', async () => {
  let sent = 0;
  const card = { id: 'ta-20261015-a1b2c3', status: 'launched' as const, runId: 'run-card-1',
    text: 'task', createdAt: new Date().toISOString(), history: [] };
  const f = fixture('', ({ path }) => ({
    readCard: id => id === card.id ? card : undefined,
    podFragmentsForRun: () => [{ spaceId: 'pod-card-1', runId: card.runId, context: 'ctx', namespace: 'ns', job: 'job', inboxDir: '/tmp/inbox' }],
    sendPod: () => {
      const before = new MsgStore(path);
      try { expect(before.listReplies(1)[0]!.body).toContain('런 인박스를 확인하세요'); }
      finally { before.close(); }
      sent++;
      throw new Error('Pod publication uncertain');
    },
  }));
  const args = ['post', `memo ${card.id} once only`, '--from', 'OP', '--to', 'TA', '--origin-key', 'coord:8:TA'];
  await f.run(...args);
  const failed = f.store();
  try {
    expect(failed.taDeliveryStatus(1)).toBe('pending');
    expect(failed.listReplies(1)[0]!.body).toContain('전달 여부 미확인');
  } finally { failed.close(); }
  await f.run(...args);
  await f.run(...args);
  const store = f.store();
  try {
    expect(store.list('TA')).toHaveLength(1);
    expect(store.listReplies(1)).toHaveLength(1);
    expect(store.taDeliveryStatus(1)).toBe('pending');
    expect(store.listReplies(1)[0]!.body).toContain('전달 여부 미확인');
  } finally { store.close(); }
  expect(sent).toBe(1);
});

test('TA leaves a local memo transport error uncertain without a second send', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'msg-cli-ta-memo-retry-'));
  dirs.push(dir);
  const { inspectControlInbox } = await import('../harness/control-inbox.js');
  const card = { id: 'ta-20261015-a1b2c3', status: 'launched' as const, runId: 'run-card-1',
    text: 'task', createdAt: new Date().toISOString(), history: [] };
  let attempts = 0;
  const f = fixture('', () => ({
    readCard: id => id === card.id ? card : undefined,
    podFragmentsForRun: () => [],
    runScreen: () => ({ screenKey: 'local-card-space', logStoreStatus: 'read' }) as ReturnType<NonNullable<MsgCliDeps['runScreen']>>,
    screenAlive: space => space === 'local-card-space',
    sendMemo: () => { attempts++; throw new Error('memo publication uncertain'); },
  }));
  const args = ['post', `memo ${card.id} check build`, '--from', 'OP', '--to', 'TA', '--origin-key', 'coord:10:TA'];
  await f.run(...args);
  expect(inspectControlInbox('local-card-space', { env: { ELANOUS_STATE_DIR: dir } }).memoCount).toBe(0);
  await f.run(...args);
  await f.run(...args);
  expect(attempts).toBe(1);
  expect(inspectControlInbox('local-card-space', { env: { ELANOUS_STATE_DIR: dir } }).memoCount).toBe(0);
  const store = f.store();
  try {
    expect(store.list('TA')).toHaveLength(1);
    expect(store.listReplies(1)).toHaveLength(1);
    expect(store.taDeliveryStatus(1)).toBe('pending');
    expect(store.listReplies(1)[0]!.body).toContain('전달 여부 미확인');
  } finally { store.close(); }
});

test('TA leaves a failed stop send uncertain without repeating it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'msg-cli-ta-stop-retry-'));
  dirs.push(dir);
  const { inspectControlInbox } = await import('../harness/control-inbox.js');
  const card = { id: 'ta-20261015-a1b2c3', status: 'launched' as const, runId: 'run-card-1',
    text: 'task', createdAt: new Date().toISOString(), history: [] };
  let attempts = 0;
  const f = fixture('', () => ({
    readCard: id => id === card.id ? card : undefined,
    podFragmentsForRun: () => [],
    runScreen: () => ({ screenKey: 'local-card-space', logStoreStatus: 'read' }) as ReturnType<NonNullable<MsgCliDeps['runScreen']>>,
    screenAlive: space => space === 'local-card-space',
    sendStop: () => { attempts++; throw new Error('stop publication uncertain'); },
  }));
  const args = ['post', `stop ${card.id}`, '--from', 'OP', '--to', 'TA', '--origin-key', 'coord:9:TA'];
  await f.run(...args);
  expect(inspectControlInbox('local-card-space', { env: { ELANOUS_STATE_DIR: dir } }).stop).toBe(false);
  await f.run(...args);
  await f.run(...args);
  expect(attempts).toBe(1);
  expect(inspectControlInbox('local-card-space', { env: { ELANOUS_STATE_DIR: dir } }).stop).toBe(false);
  const store = f.store();
  try {
    expect(store.listReplies(1)).toHaveLength(1);
    expect(store.taDeliveryStatus(1)).toBe('pending');
    expect(store.listReplies(1)[0]!.body).toContain('전달 여부 미확인');
  } finally { store.close(); }
});

test('TA local run inbox receives exactly one memo and stop; invalid card never controls a run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'msg-cli-ta-inbox-'));
  dirs.push(dir);
  const { inspectControlInbox } = await import('../harness/control-inbox.js');
  const card = { id: 'ta-20261015-a1b2c3', status: 'launched' as const, runId: 'run-card-1',
    text: 'task', createdAt: new Date().toISOString(), history: [] };
  const f = fixture('', () => ({
    readCard: id => id === card.id ? card : undefined,
    podFragmentsForRun: () => [],
    runScreen: () => ({ screenKey: 'local-card-space', logStoreStatus: 'read' }) as ReturnType<NonNullable<MsgCliDeps['runScreen']>>,
    screenAlive: space => space === 'local-card-space',
    sendMemo: (space, memo) => {
      const { enqueueControlMemo } = require('../harness/control-inbox.js') as typeof import('../harness/control-inbox.js');
      return enqueueControlMemo(space, memo, { env: { ELANOUS_STATE_DIR: dir } });
    },
    sendStop: space => {
      const { enqueueSoftStop } = require('../harness/control-inbox.js') as typeof import('../harness/control-inbox.js');
      enqueueSoftStop(space, { env: { ELANOUS_STATE_DIR: dir } });
    },
  }));
  await f.run('post', `memo ${card.id} check next step`, '--from', 'OP', '--to', 'TA');
  await f.run('post', `stop ${card.id}`, '--from', 'OP', '--to', 'TA');
  expect(inspectControlInbox('local-card-space', { env: { ELANOUS_STATE_DIR: dir } })).toMatchObject({ memoCount: 1, stop: true });
  await f.run('post', 'stop ta-20261015-deadbeef', '--from', 'OP', '--to', 'TA');
  const store = f.store();
  try {
    const requests = store.list('TA');
    expect(requests).toHaveLength(3);
    expect(store.listReplies(requests[0]!.id)).toHaveLength(1);
    expect(store.listReplies(requests[1]!.id)).toHaveLength(1);
    expect(store.listReplies(requests[2]!.id)[0]!.body).toContain('카드 없음');
  } finally { store.close(); }
  expect(inspectControlInbox('local-card-space', { env: { ELANOUS_STATE_DIR: dir } })).toMatchObject({ memoCount: 1, stop: true });
  const { drainControlInbox, readSoftStopRequest } = await import('../harness/control-inbox.js');
  const inbox = drainControlInbox('local-card-space', { env: { ELANOUS_STATE_DIR: dir } });
  expect(inbox).toMatchObject({ stop: true, receivedCount: 1, memos: ['check next step'] });
  expect(readSoftStopRequest('local-card-space', { env: { ELANOUS_STATE_DIR: dir } })?.version).toBe(1);
});

test('a running card run honors TA CLI stop before its gate and records its terminal stage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'msg-cli-ta-run-'));
  dirs.push(dir);
  const oldState = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = dir;
  try {
    const { runSelfImplement } = await import('../self-implement/orchestrator.js');
    const { seams } = await import('../self-implement/test-seams.js');
    const card = { id: 'ta-20261015-a1b2c3', status: 'launched' as const, runId: 'run-card-1',
      text: 'task', createdAt: new Date().toISOString(), history: [] };
    const f = fixture('', () => ({
      readCard: id => id === card.id ? card : undefined,
      podFragmentsForRun: () => [],
      runScreen: () => ({ screenKey: 'local-card-space', logStoreStatus: 'read' }) as ReturnType<NonNullable<MsgCliDeps['runScreen']>>,
      screenAlive: space => space === 'local-card-space',
    }));
    const { appendRunLedgerEntry, loadRunLedger, runLedgerDir } = await import('../self-implement/run-ledger.js');
    let gateCalls = 0;
    const result = await runSelfImplement({
      feature: 'TA stop running card', runId: card.runId,
      seams: seams({
        createWorktree: async ({ branch, base }) => ({ path: '/wt/local-card-space', branch, base }),
        implement: async () => {
          await f.run('post', `stop ${card.id}`, '--from', 'OP', '--to', 'TA');
          expect(f.exits).toEqual([]);
          return { ok: true, summary: 'implementation completed' };
        },
        gate: async () => { gateCalls++; return { passed: true, log: 'ok' }; },
        writeRunLedger: entry => appendRunLedgerEntry(entry, runLedgerDir(dir)),
      }),
    });
    expect(result.stage).toBe('soft-stopped');
    expect(loadRunLedger(card.runId, runLedgerDir(dir))?.map(entry => entry.event)).toContain('soft-stop-honored');
    expect(gateCalls).toBe(0);
    const store = f.store();
    try { expect(store.listReplies(store.list('TA')[0]!.id)).toHaveLength(1); }
    finally { store.close(); }
  } finally {
    if (oldState === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = oldState;
  }
});

test('a failed TA reply insert cannot dispatch a memo; retry of the same origin delivers once', async () => {
  const sent: unknown[] = [];
  let failReply = true;
  const card = { id: 'ta-20261015-a1b2c3', status: 'launched' as const, runId: 'run-card-1',
    text: 'task', createdAt: new Date().toISOString(), history: [] };
  const f = fixture('', ({ path }) => ({
    openStore: () => {
      const store = new MsgStore(path);
      const post = store.post.bind(store);
      store.post = input => {
        if (failReply && input.from === 'TA') { failReply = false; throw new Error('reply insert failed'); }
        return post(input);
      };
      return store;
    },
    readCard: id => id === card.id ? card : undefined,
    podFragmentsForRun: () => [{ spaceId: 'pod-card-1', runId: card.runId, context: 'ctx', namespace: 'ns', job: 'job', inboxDir: '/tmp/inbox' }],
    sendPod: (_space, message) => { sent.push(message); return { job: 'job' }; },
  }));
  const args = ['post', `memo ${card.id} once only`, '--from', 'OP', '--to', 'TA', '--origin-key', 'coord:7:TA'];
  await f.run(...args);
  expect(f.stderr.at(-1)).toBe('msg: reply insert failed');
  expect(sent).toHaveLength(0);
  await f.run(...args);
  const store = f.store();
  try { expect(store.listReplies(1)).toHaveLength(1); }
  finally { store.close(); }
  expect(sent).toHaveLength(1);
});

test('human line puts a kind emoji right before the unchanged [kind] text; unknown or missing kind stays as before', () => {
  const base: Message = { id: 7, createdAt: '2026-10-15T00:00:00.000Z', from: 'OP', to: 'MK', body: 'hi' };
  expect(formatMessage({ ...base, kind: 'coord' })).toBe('#7 2026-10-15T00:00:00.000Z OP → MK 🤝[coord]: hi');
  expect(formatMessage({ ...base, kind: 'memo' })).toBe('#7 2026-10-15T00:00:00.000Z OP → MK [memo]: hi');
  expect(formatMessage({ ...base, kind: 'toString' })).toBe('#7 2026-10-15T00:00:00.000Z OP → MK [toString]: hi');
  expect(formatMessage(base)).toBe('#7 2026-10-15T00:00:00.000Z OP → MK: hi');
});

// ── MSG-AGENT-CONVERSE-FU ──────────────────────────────────────────────────────────────────────
// 무대: 기존 fixture(격리 임시 DB) + mock deps. 자동 답은 «진짜» replyWithAgent 를 지나고(턴만 fake),
// 우편국 재시작은 launch seam(fake-bin)이 실제 프로세스 대신 argv 를 받는다.

/** One SSE read with a hard deadline — a restarted service replays the ledger on its first pull. */
function readWithDeadline(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number, seen: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no SSE event containing ${seen}`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Reads an SSE response until `needle` shows up — the restarted service replays the ledger on first read. */
async function readSseUntil(response: Response, needle: string, timeoutMs = 10_000): Promise<string> {
  if (!response.body) throw new Error(`no SSE body (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (!text.includes(needle)) {
      const chunk = await readWithDeadline(reader, timeoutMs, `${needle}: ${text.slice(0, 200)}`);
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => undefined); }
  if (!text.includes(needle)) throw new Error(`no SSE event containing ${needle}: ${text.slice(0, 200)}`);
  return text;
}

test('post --agent-reply produces one durable linked agent reply after the wake path passes; no flag leaves the ledger untouched', async () => {
  const order: string[] = [];
  const turns: string[] = [];
  const wakes: Array<{ address: string; msgId: number; message: { from: string; kind?: string } }> = [];
  const f = fixture('', () => ({
    wake: async (address, msgId, message) => {
      order.push('wake');
      wakes.push({ address, msgId, message });
      return { wake: 'cron', source: 'loop-table', address, msgId, result: 'wake-deferred' };
    },
    agentReply: {
      role: { model: 'fake-model' }, pack: 'fake coordinator pack',
      runAgent: async input => { order.push('turn'); turns.push(`${input.request.id}:${input.request.from}:${input.request.body}`); return '  제안: hold 승인 대기  '; },
    },
  }));
  await f.run('post', 'hold 신호 확인 필요', '--from', 'OP', '--to', 'COORDINATOR', '--agent-reply', 'coordinator', '--json');
  const posted = JSON.parse(f.stdout[0]!);
  const store = f.store();
  try {
    const replies = store.listReplies(posted.id);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ from: 'COORDINATOR', to: 'OP', kind: 'reply', body: '제안: hold 승인 대기', replyTo: posted.id });
  } finally { store.close(); }
  expect(turns).toEqual(['1:OP:hold 신호 확인 필요']);
  // 깨움은 저장 «뒤» 그대로 한 번 — 자동 답은 그 뒤에 붙는다.
  expect(order).toEqual(['wake', 'turn']);
  expect(wakes).toEqual([{ address: 'COORDINATOR', msgId: posted.id, message: { from: 'OP' } }]);
  expect(JSON.parse(f.stdout[1]!)).toEqual({ agentReply: { address: 'COORDINATOR', requestId: posted.id, replyId: 2, posted: true } });
  expect(f.stderr).toEqual([]);
  expect(f.exits).toEqual([]);

  const plain = fixture('', () => ({
    agentReply: { role: { model: 'fake-model' }, pack: 'fake coordinator pack', runAgent: async input => { turns.push(`plain:${input.request.id}`); return '답'; } },
  }));
  await plain.run('post', 'hold 신호 확인 필요', '--from', 'OP', '--to', 'COORDINATOR', '--json');
  expect(turns).toEqual(['1:OP:hold 신호 확인 필요']);
  expect(plain.stdout).toHaveLength(1);
  const untouched = plain.store();
  try { expect(untouched.listReplies(1)).toEqual([]); } finally { untouched.close(); }
});

test('ask --agent-reply answers without a human, so the same wait loop returns the generated reply', async () => {
  const f = fixture('', () => ({
    agentReply: { role: { model: 'fake-model' }, pack: 'fake guardian pack',
      runAgent: async input => `${input.request.from} 질문 #${input.request.id} — 보류, 근거 부족` },
  }));
  await f.run('ask', 'coordinator', '지금 hold 풀어도 되나?', '--from', 'TC', '--wait', '5', '--agent-reply', 'COORDINATOR', '--json');
  expect(f.exits).toEqual([]);
  expect(f.stderr).toEqual([]);
  expect(f.sleeps).toBe(0);
  expect(JSON.parse(f.stdout.at(-1)!)).toMatchObject({
    id: 2, from: 'COORDINATOR', to: 'TC', kind: 'reply', replyTo: 1, body: 'TC 질문 #1 — 보류, 근거 부족',
  });
  const store = f.store();
  try { expect(store.listReplies(1).map(message => message.from)).toEqual(['COORDINATOR']); }
  finally { store.close(); }
});

test('post --agent-reply without a resolved role LLM posts once and notices instead of generating', async () => {
  let turns = 0;
  const f = fixture('', () => ({
    agentReply: { resolveRole: () => undefined, pack: 'unused', runAgent: async () => { turns++; return '답'; } },
  }));
  await f.run('post', 'hold 신호 확인 필요', '--from', 'OP', '--to', 'COORDINATOR', '--agent-reply', 'coordinator', '--json');
  expect(turns).toBe(0);
  expect(f.exits).toEqual([]);
  expect(f.stderr.at(-1)).toBe('msg: COORDINATOR 역할 LLM 미설정 — 자동 답 없음');
  const store = f.store();
  try { expect(store.list('COORDINATOR')).toHaveLength(1); expect(store.listReplies(1)).toEqual([]); }
  finally { store.close(); }
});

test('post --agent-reply aimed at a different address exits 2 before saving anything', async () => {
  let turns = 0;
  const f = fixture('', () => ({
    agentReply: { role: { model: 'fake-model' }, pack: 'pack', runAgent: async () => { turns++; return '답'; } },
  }));
  await f.run('post', 'body', '--from', 'OP', '--to', 'MK', '--agent-reply', 'COORDINATOR');
  expect(f.exits.at(-1)).toBe(2);
  expect(f.stderr.at(-1)).toBe('msg: --agent-reply COORDINATOR requires --to COORDINATOR');
  await f.run('post', 'body', '--from', 'OP', '--to', 'COORDINATOR', '--agent-reply', 'steward');
  expect(f.exits.at(-1)).toBe(2);
  expect(f.stderr.at(-1)).toBe('msg: --agent-reply must be COORDINATOR or GUARDIAN');
  expect(turns).toBe(0);
  const store = f.store();
  try { expect(store.list('MK')).toEqual([]); expect(store.list('COORDINATOR')).toEqual([]); }
  finally { store.close(); }
});

test('a dead installed post office is restarted from post and the restarted SSE service replays the durable post', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'msg-cli-office-'));
  dirs.push(dir);
  const path = join(dir, 'messages.db');
  const launched: number[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  const program = new Command();
  registerMsgCommands(program, {
    openStore: () => new MsgStore(path),
    out: { log: line => stdout.push(line), error: line => stderr.push(line) },
    readStdin: async () => '',
    setExitCode: code => exits.push(code),
    registerLogSink: async () => undefined,
    wake: async (address, msgId) => ({ wake: 'none', source: 'unresolved', address, msgId, result: 'skipped-test-universe' }),
    postOfficeStateRoot: dir,
    postOfficeAlive: () => false,
    postOfficeProbe: async () => false,
    postOfficeLaunch: input => { launched.push(input.port); },
  });
  writePostOffice(dir, { port: 47821, pid: 999_999 });
  await program.parseAsync(['msg', 'post', 'durable while the service is down', '--from', 'OP', '--to', 'TC', '--json'], { from: 'user' });
  expect(exits).toEqual([]);
  expect(launched).toEqual([47821]);
  expect(stderr.at(-1)).toBe('msg: post office 재시작 (port 47821) — 원장이 정본이라 저장된 글은 다시 밀린다');
  expect(JSON.parse(stdout[0]!).body).toBe('durable while the service is down');

  // 다시 띄운 서비스가 같은 원장을 «처음부터» 민다 — 죽어 있던 동안 저장된 글도 도착한다.
  const store = new MsgStore(path);
  const service = startMsgSseServer({ store, token: 'same-nexus-token', port: 0, pollMs: 20 });
  try {
    const response = await fetch(`http://127.0.0.1:${service.port}/stream?to=TC&since=0`,
      { headers: { Authorization: 'Bearer same-nexus-token' } });
    const text = await readSseUntil(response, 'durable while the service is down');
    expect(text).toContain('"id":1');
  } finally { service.stop(); store.close(); }
});

// PR #30660 리뷰 SHOULD-FIX 구별자 — 배선(msg-cli.ts)을 base 로 되돌리면 이 시험은 «이름 붙은 단언 실패»로 뜬다:
//   git checkout f74e24568d -- src/cli/msg-cli.ts && bun test src/cli/msg-cli.test.ts -t 'restart fires after the durable save'
//   → fail: expected [] to equal [ 47821 ] (재시작 배선이 없으면 발사가 일어나지 않는다). 복원: git checkout HEAD -- src/cli/msg-cli.ts.
test('post office restart fires after the durable save, so the launch can already read the new post', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'msg-cli-office-order-'));
  dirs.push(dir);
  const path = join(dir, 'messages.db');
  const launched: number[] = [];
  const ledgerAtLaunch: number[] = [];
  const stdout: string[] = [];
  const exits: number[] = [];
  const program = new Command();
  registerMsgCommands(program, {
    openStore: () => new MsgStore(path),
    out: { log: line => stdout.push(line), error: () => {} },
    readStdin: async () => '',
    setExitCode: code => exits.push(code),
    registerLogSink: async () => undefined,
    wake: async (address, msgId) => ({ wake: 'none', source: 'unresolved', address, msgId, result: 'skipped-test-universe' }),
    postOfficeStateRoot: dir,
    postOfficeAlive: () => false,
    postOfficeProbe: async () => false,
    postOfficeLaunch: input => {
      launched.push(input.port);
      const ledger = new MsgStore(path, { readOnly: true });
      try { ledgerAtLaunch.push(ledger.list('TC').length); } finally { ledger.close(); }
    },
  });
  writePostOffice(dir, { port: 47821, pid: 999_999 });
  await program.parseAsync(['msg', 'post', 'restart must replay me', '--from', 'OP', '--to', 'TC', '--json'], { from: 'user' });
  expect(exits).toEqual([]);
  // 발사는 등록 줄의 포트 그대로, 그리고 저장 «뒤» — 다시 띄운 서비스가 방금 저장한 글을 첫 재생에 민다(원장이 정본).
  expect(launched).toEqual([47821]);
  expect(ledgerAtLaunch).toEqual([1]);
  expect(JSON.parse(stdout[0]!).body).toBe('restart must replay me');
});

test('post leaves an unregistered or still-listening post office alone', async () => {
  const quiet = fixture('', ({ path }) => ({
    postOfficeStateRoot: dirname(path), postOfficeAlive: () => false, postOfficeProbe: async () => false,
    postOfficeLaunch: () => { throw new Error('must not restart without a registration'); },
  }));
  await quiet.run('post', 'no service registered', '--from', 'OP', '--to', 'TC', '--json');
  expect(quiet.stderr).toEqual([]);
  expect(quiet.exits).toEqual([]);

  const listening = fixture('', ({ path }) => ({
    postOfficeStateRoot: dirname(path), postOfficeAlive: () => true, postOfficeProbe: async () => true,
    postOfficeLaunch: () => { throw new Error('must not restart a listening service'); },
  }));
  writePostOffice(dirname(listening.path), { port: 47822, pid: process.pid });
  await listening.run('post', 'service is up', '--from', 'OP', '--to', 'TC', '--json');
  expect(listening.stderr).toEqual([]);
  expect(listening.exits).toEqual([]);
});

test('msg serve --sse publishes its port for the restart path and clears it when stopped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'msg-cli-office-serve-'));
  dirs.push(dir);
  const path = join(dir, 'messages.db');
  const stdout: string[] = [];
  const program = new Command();
  new MsgStore(path).close(); // the read-only service needs an existing ledger
  registerMsgCommands(program, {
    openStore: () => new MsgStore(path), openReadStore: () => new MsgStore(path, { readOnly: true }),
    out: { log: line => stdout.push(line), error: () => {} },
    authToken: () => 'same-nexus-token',
    postOfficeStateRoot: dir,
  });
  await program.parseAsync(['msg', 'serve', '--sse', '--port', '0'], { from: 'user' });
  const info = readPostOffice(dir);
  expect(info?.pid).toBe(process.pid);
  expect(info?.port).toBeGreaterThan(0);
  expect(stdout.at(-1)).toBe(`msg SSE listening on 127.0.0.1:${info!.port}`);
  process.emit('SIGINT');
  expect(readPostOffice(dir)).toBeNull();
});
