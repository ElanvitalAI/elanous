import { setDefaultTimeout, afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { MsgStore, type Message } from '../msg/msg-store.js';
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
  expect(f.stdout).toEqual([]);
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

test('human line puts a kind emoji right before the unchanged [kind] text; unknown or missing kind stays as before', () => {
  const base: Message = { id: 7, createdAt: '2026-10-15T00:00:00.000Z', from: 'OP', to: 'MK', body: 'hi' };
  expect(formatMessage({ ...base, kind: 'coord' })).toBe('#7 2026-10-15T00:00:00.000Z OP → MK 🤝[coord]: hi');
  expect(formatMessage({ ...base, kind: 'memo' })).toBe('#7 2026-10-15T00:00:00.000Z OP → MK [memo]: hi');
  expect(formatMessage({ ...base, kind: 'toString' })).toBe('#7 2026-10-15T00:00:00.000Z OP → MK [toString]: hi');
  expect(formatMessage(base)).toBe('#7 2026-10-15T00:00:00.000Z OP → MK: hi');
});
