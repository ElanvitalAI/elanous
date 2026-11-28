import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { MsgStore, type Message } from '../msg/msg-store.js';
import { readPostOffice, writePostOffice } from '../msg/msg-post-office.js';
import { startMsgSseServer } from '../msg/msg-sse-server.js';
import { formatMessage, registerMsgCommands, HOOK_STDIN_READ_LIMIT_MS, type MsgCliDeps } from './msg-cli.js';
import { drainControlInbox, enqueueControlMemo, enqueueSoftStop, inspectControlInbox, readSoftStopRequest } from '../harness/control-inbox.js';
import { runSelfImplement } from '../self-implement/orchestrator.js';
import { seams } from '../self-implement/test-seams.js';
import { appendRunLedgerEntry, loadRunLedger, runLedgerDir } from '../self-implement/run-ledger.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const STRUCTURED_POST_FLAGS = ['--kind', '--intent', '--announce', '--crown-directive', '--origin-key', '--ref'];
function withLegacyKind(args: string[]): string[] {
  if (args[0] !== 'post' || args.some((a) => STRUCTURED_POST_FLAGS.includes(a) || a.startsWith('--kind='))) return args;
  return [...args, '--kind', 'info'];
}

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
    // MSG-FILTERS-RELAX: the caller seat is explicit in tests (the host ELANOUS_TRACK never leaks into origin).
    callerSeat: () => null,
    saveAckDigest: async () => {},
    ...overrides({ path }),
  });
  return {
    // MAIL-ANTI-FLOOD E: these posts predate --kind; the fixture names the passive class (info) the CLI would store anyway,
    // so their stderr stays free of the kind-less warning. The warning itself is covered by «a kind-less post is stored …».
    run: async (...args: string[]) => { await program.parseAsync(['msg', ...withLegacyKind(args)], { from: 'user' }); },
    store: () => new MsgStore(path), stdout, stderr, exits, signal, path,
    get sleeps() { return sleeps; },
  };
}

test('post reads piped stdin, accepts literal body and kind; human and JSON outputs preserve envelope', async () => {
  const f = fixture('  stdin with\nnew line  ');
  await f.run('post', '--no-coalesce', '--from', 's', '--to', 't', '--kind', 'notice');
  expect(f.stderr).toEqual([]);
  // ELN-MSG-POST-IDEMPOTENT: the human line names the stored message without echoing its body.
  expect(f.stdout[0]).toMatch(/^#1 \S+ OP → MK \[notice\] · 23 bytes$/);
  const store = f.store();
  try { expect(store.list('MK')[0]).toMatchObject({ id: 1, from: 'OP', to: 'MK', body: '  stdin with\nnew line  ', kind: 'notice' }); }
  finally { store.close(); }
  f.stdout.length = 0;
  await f.run('post', '--no-coalesce', 'explicit', '--from', 'ux', '--to', 'mk', '--json');
  expect(JSON.parse(f.stdout[0]!)).toMatchObject({ id: 2, from: 'UX', to: 'MK', body: 'explicit' });
  f.stdout.length = 0;
  await f.run('post', '--no-coalesce', '--body', 'from flag', '--from', 'OP', '--to', 'MK', '--json');
  expect(JSON.parse(f.stdout[0]!).body).toBe('from flag');
});

test('post reads --body-file and explicit stdin without evaluating literal backticks', async () => {
  const f = fixture('stdin `bun test`', ({ path }) => ({ registerLogSink: async () => undefined }));
  const bodyPath = join(dirname(f.path), 'report.txt');
  writeFileSync(bodyPath, 'file `bun install`\nsecond line');
  await f.run('post', '--no-coalesce', '--from', 'OP', '--to', 'MK', '--body-file', bodyPath, '--json');
  await f.run('post', '--no-coalesce', '--from', 'OP', '--to', 'MK', '--body-file', '-', '--json');
  const store = f.store();
  try { expect(store.list('MK').map(row => row.body)).toEqual(['file `bun install`\nsecond line', 'stdin `bun test`']); }
  finally { store.close(); }
  expect(f.stderr.filter(line => line.includes('msg post 경고: 백틱이 포함됨'))).toHaveLength(2);
});

test('post warns when shell substitution has erased command names from a report', async () => {
  const f = fixture();
  const fakeBin = join(dirname(f.path), 'fake-bin');
  const trace = join(dirname(f.path), 'shell-trace.txt');
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'bun'), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$MSG_GUARD_TRACE"\n');
  chmodSync(join(fakeBin, 'bun'), 0o755);
  const shell = spawnSync('/bin/sh', ['-c', 'printf "%s" "mbp에서 `bun install` 와 `bun test` 실행; install=, test="'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}`, MSG_GUARD_TRACE: trace },
  });
  expect(shell.status).toBe(0);
  expect(readFileSync(trace, 'utf8')).toBe('install\ntest\n');
  await f.run('post', '--from', 'OP', '--to', 'MK', '--body', shell.stdout, '--json');
  expect(f.stderr.some(line => line.includes('문장 중간 연속 공백'))).toBe(true);
  expect(f.stderr.some(line => line.includes('빈 값 패턴'))).toBe(true);
  const store = f.store();
  try { expect(store.list('MK')[0]?.body).toBe('mbp에서  와  실행; install=, test='); }
  finally { store.close(); }
});

test('post warns for a Unicode empty value and mixed interior whitespace', async () => {
  const f = fixture();
  await f.run('post', '--no-coalesce', '--from', 'OP', '--to', 'MK', '--body', '상태=, 다음', '--json');
  expect(f.stderr.some(line => line.includes('빈 값 패턴'))).toBe(true);
  f.stderr.length = 0;
  await f.run('post', '--no-coalesce', '--from', 'OP', '--to', 'MK', '--body', 'cafe\u0301=, 다음', '--json');
  expect(f.stderr.some(line => line.includes('빈 값 패턴'))).toBe(true);
  for (const separator of ['\u2028', '\u2029']) {
    f.stderr.length = 0;
    await f.run('post', '--no-coalesce', '--from', 'OP', '--to', 'MK', '--body', `상태=${separator}다음`, '--json');
    expect(f.stderr.some(line => line.includes('빈 값 패턴'))).toBe(true);
  }
  f.stderr.length = 0;
  await f.run('post', '--no-coalesce', '--from', 'OP', '--to', 'MK', '--body', '앞  \t뒤', '--json');
  expect(f.stderr.some(line => line.includes('문장 중간 연속 공백'))).toBe(true);
  const store = f.store();
  try { expect(store.list('MK').map(row => row.body)).toEqual(['상태=, 다음', 'cafe\u0301=, 다음', '상태=\u2028다음', '상태=\u2029다음', '앞  \t뒤']); }
  finally { store.close(); }
});

test('post scans a long body without repeatedly searching each key suffix', async () => {
  const f = fixture();
  const longKey = '가'.repeat(200_000); // Source: regression input exceeds ordinary seat reports by several orders of magnitude.
  const bodyPath = join(dirname(f.path), 'long-report.txt');
  writeFileSync(bodyPath, `${longKey}=,`);
  await f.run('post', '--from', 'OP', '--to', 'MK', '--body-file', bodyPath, '--json');
  expect(f.stderr.some(line => line.includes('빈 값 패턴'))).toBe(true);
  f.stderr.length = 0;
  await f.run('post', '--from', 'OP', '--to', 'MK', '--body', longKey, '--json');
  expect(f.stderr.some(line => line.includes('빈 값 패턴'))).toBe(false);
});

test('post rejects an ambiguous body source before saving', async () => {
  const f = fixture();
  const bodyPath = join(dirname(f.path), 'report.txt');
  writeFileSync(bodyPath, 'report');
  for (const args of [
    ['post', '--from', 'OP', '--to', 'MK', '--body', 'inline', '--body-file', bodyPath],
    ['post', '-', '--from', 'OP', '--to', 'MK', '--body-file', bodyPath],
    ['post', '-', '--from', 'OP', '--to', 'MK', '--body', 'inline'],
  ]) {
    await f.run(...args);
    expect(f.stderr.at(-1)).toContain('provide body once');
  }
  const store = f.store();
  try { expect(store.list('MK')).toEqual([]); }
  finally { store.close(); }
});

test('msg hook CLI derives seat from cwd, loads unread messages, and emits no duplicate bundle', async () => {
  const f = fixture(JSON.stringify({ cwd: '/tmp/elanous-hq/seats/OP', session_id: 'hook-cli-1' }), ({ path }) => ({ hookStateDir: join(dirname(path), 'hooks') }));
  const store = f.store();
  let firstId: number;
  try {
    firstId = store.post({ from: 'MK', to: 'OP', body: 'already acked', kind: 'coord' }).id;
    store.post({ from: 'TC', to: 'OP', body: 'attention', kind: 'coord' });
    store.ackMessage('OP', firstId);
  }
  finally { store.close(); }
  await f.run('hook', '--event', 'user-prompt-submit', '--format', 'claude');
  expect(JSON.parse(f.stdout[0]!)).toMatchObject({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: expect.stringContaining('#2 TC→OP [coord] attention') } });
  expect(f.stdout[0]).not.toContain('#1 MK→OP');
  f.stdout.length = 0;
  await f.run('hook', '--event', 'stop', '--format', 'claude');
  expect(f.stdout).toEqual([]);
  const newMail = f.store();
  try { newMail.post({ from: 'MK', to: 'OP', body: 'arrived after prompt' }); }
  finally { newMail.close(); }
  await f.run('hook', '--event', 'stop', '--format', 'claude');
  expect(JSON.parse(f.stdout[0]!)).toEqual({ decision: 'block', reason: '새 우편 2통(#2, #3) — 처리 후 ack' });
  expect(f.stderr).toEqual([]);
});

test('msg hook CLI honors an explicit seat outside a seat worktree', async () => {
  const f = fixture(JSON.stringify({ cwd: '/tmp/repo', session_id: 'hook-cli-explicit-seat' }), ({ path }) => ({ hookStateDir: join(dirname(path), 'hooks') }));
  const store = f.store();
  try { store.post({ from: 'MK', to: 'OP', body: 'explicit recipient' }); }
  finally { store.close(); }
  await f.run('hook', '--event', 'user-prompt-submit', '--format', 'claude', '--seat', 'OP');
  expect(JSON.parse(f.stdout[0]!)).toMatchObject({ hookSpecificOutput: { additionalContext: expect.stringContaining('#1 MK→OP') } });
  expect(f.stderr).toEqual([]);
});

test('msg hook CLI does not emit an unkeyed Stop block that could loop forever', async () => {
  const f = fixture(JSON.stringify({ cwd: '/tmp/elanous-hq/seats/OP' }), ({ path }) => ({ hookStateDir: join(dirname(path), 'hooks') }));
  const store = f.store();
  try { store.post({ from: 'MK', to: 'OP', body: 'new mail' }); }
  finally { store.close(); }
  await f.run('hook', '--event', 'stop', '--format', 'claude');
  await f.run('hook', '--event', 'stop', '--format', 'claude');
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual([]);
});

test('MSG-CHANNELS CLI creates groups, gates delivery by subscriptions, and accepts seat: DM addresses', async () => {
  const f = fixture();
  await f.run('group', 'create', 'release-window', '--from', 'OP', '--json');
  await f.run('group', 'join', 'release-window', '--seat', 'TC', '--json');
  await f.run('group', 'join', 'release-window', '--seat', 'MK', '--json');
  await f.run('group', 'list', '--seat', 'TC', '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toEqual(['group:release-window']);
  await f.run('post', 'subscribers only', '--from', 'OP', '--to', 'group:release-window', '--json');
  const posted = JSON.parse(f.stdout.at(-1)!);
  expect(posted.to).toBe('group:release-window');
  const store = f.store();
  try {
    expect(store.list('TC').map(row => row.body)).toEqual(['subscribers only']);
    expect(store.list('MK').map(row => row.body)).toEqual(['subscribers only']);
    expect(store.list('UX')).toEqual([]);
  } finally { store.close(); }
  await f.run('group', 'leave', 'release-window', '--seat', 'TC', '--json');
  await f.run('post', 'after leave', '--from', 'OP', '--to', 'group:release-window', '--json');
  const afterLeave = f.store();
  try { expect(afterLeave.list('TC').map(row => row.body)).toEqual(['subscribers only']); }
  finally { afterLeave.close(); }
  await f.run('post', 'direct', '--from', 'OP', '--to', 'seat:cmo', '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toMatchObject({ to: 'MK', body: 'direct' });
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
  // ORCHESTRATOR has no live tab — DORMANT-ADDRESS REROUTE sends it to the OP digest (dormant-reroute.test.ts).
  for (const recipient of ['GUARDIAN', 'STEWARD']) {
    await f.run('post', 'request', '--from', 'UX', '--to', recipient, '--json');
    expect(JSON.parse(f.stdout.at(-1)!).to).toBe(recipient);
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
  // 수호자 v2 reads its own mail: GUARDIAN and loop:guardian are addressable
  await f.run('post', 'request', '--from', 'UX', '--to', 'loop:guardian', '--json');
  expect(JSON.parse(f.stdout.at(-1)!).to).toBe('GUARDIAN');
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
    { address: 'OPT', msgId: 1, message: { from: 'OP', kind: 'info' }, stored: 1 },
    { address: 'OP', msgId: 2, message: { from: 'OPT', kind: 'reply' }, stored: 1 },
  ]);
  expect(f.exits).toEqual([]);
  expect(f.stdout.map(line => JSON.parse(line).id)).toEqual([1, 2]);
});

test('post with the real wake warns once for an unresolved seat and stays quiet when no reply body was announced', async () => {
  const f = fixture('', () => ({ wake: undefined, wakeDeps: { listPtys: () => [], listHerdrPanes: () => [], readPane: () => null, live: false } }));
  await f.run('post', 'hello', '--from', 'OP', '--to', 'UX');
  expect(f.exits).toEqual([]);
  expect(f.stderr).toEqual(['이 주소는 깨울 길이 없다 — 받는 몸이 스스로 읽을 때까지 쌓인다 (wake=none · 받는 몸 모름: 등록부·pane 에서 못 찾음 — seat-registry-missing:candidates=0)']);
});

test('route shows reply body and resolved wake for loop and seat addresses', async () => {
  const f = fixture('', () => ({ wakeDeps: { listPtys: () => [{ id: 'tui:9', nickname: 'opt', alive: true }], listHerdrPanes: () => [], readPane: () => null, hasOptIn: () => false } }));
  await f.run('route', 'coordinator', '--json');
  await f.run('route', 'opt', '--json');
  await f.run('route', 'ux', '--json');
  expect(f.stdout.map(line => JSON.parse(line))).toEqual([
    { msgAddress: 'COORDINATOR', replyBody: 'rules', wake: 'cron', source: 'loop-table', liveness: 'down' },
    { msgAddress: 'OPT', replyBody: null, wake: 'none', source: 'unresolved', reason: 'seat-registry-missing:candidates=0', liveness: 'down' },
    { msgAddress: 'UX', replyBody: null, wake: 'none', source: 'unresolved', reason: 'seat-registry-missing:candidates=0', liveness: 'down' },
  ]);
  await f.run('route', 'opt');
  expect(f.stdout.at(-1)).toBe('OPT\treplyBody=모름\twake=none\tliveness=down\t(unresolved: seat-registry-missing:candidates=0)');
});

test('pane address forms route through the Herdr census; unread drops recipients whose addresses are dead', async () => {
  const f = fixture('', () => ({ wakeDeps: {
    listHerdrPanes: () => [{ paneId: 'wT:p4', sessionId: 'sess-4', title: 'editor | TC', cwd: '/hq/seats/TC', host: 'local', status: 'idle' }],
    readRegistry: () => ({ status: 'ready', registry: { version: 1, seats: [] } }),
  } }));
  await f.run('route', 'TC/p4', '--json');
  expect(JSON.parse(f.stdout[0]!)).toMatchObject({ msgAddress: 'TC/p4', wake: 'herdr', target: 'wT:p4' });
  await f.run('route', 'session:sess-4', '--json');
  expect(JSON.parse(f.stdout[1]!)).toMatchObject({ msgAddress: 'session:sess-4', wake: 'herdr', target: 'wT:p4' });
  await f.run('post', 'direct pane delivery', '--from', 'OP', '--to', 'TC/p4');
  await f.run('list', '--to', 'TC/p4', '--json');
  const direct = JSON.parse(f.stdout.at(-1)!)[0];
  expect(direct).toMatchObject({ to: 'TC/p4', body: 'direct pane delivery' });
  const directStore = f.store();
  try { directStore.ack('TC/p4', direct.id); } finally { directStore.close(); }
  await f.run('post', 'orphan', '--from', 'OP', '--to', 'GONE');
  await f.run('unread', '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toEqual([]);
});

test('unavailable Herdr census stays unknown; unread filters only confirmed dead addresses for aggregate and direct queries', async () => {
  let herdrResult: { status: number | null; stdout: string; error?: unknown } = { status: null, stdout: '', error: new Error('herdr timed out') };
  const f = fixture('', () => ({ wakeDeps: {
    runHerdrPaneList: () => herdrResult,
    readRegistry: () => ({ status: 'ready', registry: { version: 1, seats: [] } }),
  } }));
  await f.run('post', '--no-coalesce', 'preserve unknown', '--from', 'OP', '--to', 'pane:wT:p4', '--reject-undeclared');
  const store = f.store();
  try { expect(store.list('pane:wT:p4')).toHaveLength(1); } finally { store.close(); }
  await f.run('unread', '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toEqual([{ recipient: 'pane:wT:p4', count: 1 }]);
  await f.run('unread', '--to', 'pane:wT:p4', '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toEqual([{ recipient: 'pane:wT:p4', count: 1 }]);

  herdrResult = { status: 0, stdout: 'not JSON' };
  await f.run('route', 'pane:wT:p4', '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toMatchObject({ reason: 'pane-census-unavailable:candidates=unknown' });
  herdrResult = { status: 0, stdout: JSON.stringify({ result: { panes: [
    { pane_id: 'wT:p4', status: 'idle' }, { pane_id: 'wT:p4', status: 'idle' },
  ] } }) };
  await f.run('route', 'pane:wT:p4', '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toMatchObject({ reason: 'ambiguous-pane:candidates=2' });
  await f.run('post', '--no-coalesce', 'ambiguous durable', '--from', 'OP', '--to', 'pane:wT:p4', '--reject-undeclared');
  expect(f.exits).toEqual([]);
  const afterAmbiguous = f.store();
  try { expect(afterAmbiguous.list('pane:wT:p4')).toHaveLength(2); } finally { afterAmbiguous.close(); }
  await f.run('unread', '--to', 'pane:wT:p4', '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toEqual([{ recipient: 'pane:wT:p4', count: 2 }]);

  herdrResult = { status: 0, stdout: JSON.stringify({ result: { panes: [{ pane_id: 'wT:p4', status: 'dead' }] } }) };
  await f.run('unread', '--to', 'pane:wT:p4', '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toEqual([]);
  await f.run('post', '--no-coalesce', 'dead reject', '--from', 'OP', '--to', 'pane:wT:p4', '--reject-undeclared');
  expect(f.exits.at(-1)).toBe(2);

  const missingRegistry = fixture('', () => ({ wakeDeps: {
    listHerdrPanes: () => [],
    readRegistry: () => ({ status: 'absent' }),
  } }));
  await missingRegistry.run('post', '--no-coalesce', 'keep unknown registry', '--from', 'OP', '--to', 'UX', '--reject-undeclared');
  expect(missingRegistry.exits).toEqual([]);
  const unknownStore = missingRegistry.store();
  try { expect(unknownStore.list('UX')).toHaveLength(1); } finally { unknownStore.close(); }
});

test('post --reject-undeclared rejects before writing, while default post warns and remains durable', async () => {
  const f = fixture('', () => ({ wakeDeps: {
    listHerdrPanes: () => [],
    readRegistry: () => ({ status: 'ready', registry: { version: 1, seats: [] } }),
  } }));
  await f.run('post', 'no write', '--from', 'OP', '--to', 'UNKNOWN', '--reject-undeclared');
  expect(f.exits.at(-1)).toBe(2);
  const before = f.store();
  try { expect(before.list('UNKNOWN')).toEqual([]); } finally { before.close(); }
  await f.run('post', 'durable warning', '--from', 'OP', '--to', 'UNKNOWN');
  expect(f.stderr.some(line => line.includes('undeclared-address'))).toBe(true);
  const store = f.store();
  try { expect(store.list('UNKNOWN')).toHaveLength(1); } finally { store.close(); }
});

test('address register writes one private central registry row with explicit wake opt-in', async () => {
  const seatStateRoot = mkdtempSync(join(tmpdir(), 'msg-seat-address-'));
  dirs.push(seatStateRoot);
  const f = fixture('', () => ({ wakeDeps: { seatStateRoot, listPtys: () => [], listHerdrPanes: () => [
    { paneId: 'wJ:p10', sessionId: 'session-nt-1', title: 'work | NT-1', cwd: '/hq/seats/NT-1', host: 'mshq', status: 'idle' },
  ] } }));
  await f.run('address', 'register', 'NT-1', '--herdr-pane', 'wJ:p10', '--host', 'mshq', '--wake', '--json');
  const result = JSON.parse(f.stdout[0]!);
  expect(result).toMatchObject({ address: 'NT-1', paneId: 'wJ:p10', host: 'mshq', changed: true, wakeEnabled: true });
  const registryPath = join(seatStateRoot, 'seat-registry.json');
  expect(readFileSync(join(seatStateRoot, 'OP', 'tools', 'seat-panes.tsv'), 'utf8')).toBe('NT-1\twJ:p10\n');
  expect(lstatSync(registryPath).isFile()).toBe(true);
  expect(JSON.parse(readFileSync(registryPath, 'utf8')).seats.find((row: { address: string }) => row.address === 'OPT'))
    .toEqual({ address: 'OPT', host: 'unknown', wake: 'none', replyBody: 'agent', optIn: false });
  expect(JSON.parse(readFileSync(registryPath, 'utf8')).seats.find((row: { address: string }) => row.address === 'NT-1'))
    .toEqual({ address: 'NT-1', host: 'mshq', target: 'wJ:p10', wake: 'herdr', replyBody: 'agent', optIn: true });
  expect(existsSync(join(seatStateRoot, 'NT-1'))).toBe(false);
  await f.run('route', 'nt-1', '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toMatchObject({ msgAddress: 'NT-1', replyBody: 'agent', wake: 'herdr', target: 'wJ:p10', host: 'mshq', optIn: true });
  await f.run('address', 'register', 'NT-1', '--herdr-pane', 'wJ:p10', '--host', 'mshq', '--wake', '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toMatchObject({ changed: false, wakeEnabled: true });
  await f.run('address', 'register', 'NT-1', '--herdr-pane', 'wJ:p11', '--host', 'mshq', '--wake');
  expect(f.exits.at(-1)).toBe(2);
  expect(JSON.parse(readFileSync(registryPath, 'utf8')).seats.find((row: { address: string }) => row.address === 'NT-1').target).toBe('wJ:p10');
  await f.run('address', 'register', 'NT-1', '--herdr-pane', 'wJ:p11', '--host', 'mshq', '--replace');
  const rebound = JSON.parse(readFileSync(registryPath, 'utf8')).seats.find((row: { address: string }) => row.address === 'NT-1');
  expect(rebound).toMatchObject({ target: 'wJ:p11', optIn: false });
  expect(readFileSync(join(seatStateRoot, 'OP', 'tools', 'seat-panes.tsv'), 'utf8')).toBe('NT-1\twJ:p11\n');
  await f.run('address', 'register', 'NT-1', '--herdr-pane', 'wJ:p12', '--host', 'node-c', '--replace');
  expect(readFileSync(join(seatStateRoot, 'OP', 'tools', 'seat-panes.tsv'), 'utf8')).toBe('');
});

test('remote tmux registration revokes old pane consent and requires exact seat session', async () => {
  const seatStateRoot = mkdtempSync(join(tmpdir(), 'msg-seat-tmux-'));
  dirs.push(seatStateRoot);
  const f = fixture('', () => ({ wakeDeps: { seatStateRoot, listPtys: () => [], listHerdrPanes: () => [] } }));
  await f.run('address', 'register', 'TC-H-CX-15', '--herdr-pane', 'wJ:p10', '--host', 'node-b', '--wake');
  await f.run('address', 'register', 'TC-H-CX-15', '--tmux-session', 'seat-TC-H-CX-15', '--host', 'node-b', '--replace', '--json');
  const first = JSON.parse(f.stdout.at(-1)!);
  expect(first).toMatchObject({ address: 'TC-H-CX-15', paneId: 'seat-TC-H-CX-15', wakeEnabled: false });
  await f.run('route', 'TC-H-CX-15', '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toMatchObject({ wake: 'tmux', target: 'seat-TC-H-CX-15', optIn: false });
  await f.run('address', 'register', 'TC-H-CX-15', '--tmux-session', 'seat-TC-H-CX-15', '--host', 'node-b', '--wake', '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toMatchObject({ changed: true, wakeEnabled: true });
  await f.run('address', 'register', 'TC-H-CX-15', '--tmux-session', 'seat-OTHER', '--host', 'node-b', '--replace', '--wake');
  expect(f.exits.at(-1)).toBe(2);
  const row = JSON.parse(readFileSync(join(seatStateRoot, 'seat-registry.json'), 'utf8')).seats.find((entry: { address: string }) => entry.address === 'TC-H-CX-15');
  expect(row).toMatchObject({ target: 'seat-TC-H-CX-15', wake: 'tmux', optIn: true });
});

test('real msg post CLI wakes only the explicitly re-opted remote tmux seat', async () => {
  const seatStateRoot = mkdtempSync(join(tmpdir(), 'msg-seat-tmux-cli-'));
  dirs.push(seatStateRoot);
  const sent: string[][] = [];
  const f = fixture('', () => ({ wake: undefined, wakeDeps: {
    seatStateRoot, stateRoot: seatStateRoot, live: true, localHostAliases: ['mshq'],
    listPtys: () => [], listHerdrPanes: () => [],
    remoteTmuxRun: async (_host, argv) => {
      if (argv[0] === 'send-keys') sent.push([...argv]);
      return { code: 0, stdout: argv[0] === 'list-panes'
        ? '%21|seat-TC-H-CX-15|/Users/test/elanous-hq/seats/TC-H-CX-15/work|0|codex\n'
          + '%22|seat-OTHER|/Users/test/elanous-hq/seats/OTHER/work|0|codex\n' : '', stderr: '' };
    },
  } }));
  await f.run('address', 'register', 'TC-H-CX-15', '--herdr-pane', 'wJ:p10', '--host', 'node-b', '--wake');
  await f.run('address', 'register', 'TC-H-CX-15', '--tmux-session', 'seat-TC-H-CX-15', '--host', 'node-b', '--replace');
  await f.run('post', '--no-coalesce', '--from', 'OP', '--to', 'TC-H-CX-15', 'before consent');
  expect(sent).toHaveLength(0);
  await f.run('address', 'register', 'TC-H-CX-15', '--tmux-session', 'seat-TC-H-CX-15', '--host', 'node-b', '--wake');
  await f.run('post', '--no-coalesce', '--from', 'OP', '--to', 'TC-H-CX-15', 'after consent');
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain('%21');
  expect(sent[0]).not.toContain('%22');
});

test('address register refuses a symlinked central registry and leaves its target untouched', async () => {
  const seatStateRoot = mkdtempSync(join(tmpdir(), 'msg-seat-address-link-'));
  const outside = mkdtempSync(join(tmpdir(), 'msg-seat-address-outside-'));
  dirs.push(seatStateRoot, outside);
  const outsideRegistry = join(outside, 'seat-registry.json');
  writeFileSync(outsideRegistry, '{"version":1,"seats":[]}\n');
  symlinkSync(outsideRegistry, join(seatStateRoot, 'seat-registry.json'));
  const f = fixture('', () => ({ wakeDeps: { seatStateRoot, listPtys: () => [] } }));
  await f.run('address', 'register', 'NT-1', '--herdr-pane', 'wJ:p10', '--host', 'local');
  expect(f.exits.at(-1)).toBe(2);
  expect(readFileSync(outsideRegistry, 'utf8')).toBe('{"version":1,"seats":[]}\n');
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

test('MSG-ACK-MULTI-ID: repeated --id selects only those IDs and leaves the cursor unchanged', async () => {
  const f = fixture();
  const store = f.store();
  try { for (const body of ['one', 'two', 'three', 'four']) store.post({ from: 'OP', to: 'MK', body }); }
  finally { store.close(); }
  await f.run('ack', '--id', '1', '--id', '3', '--to', 'MK', '--json');
  expect(JSON.parse(f.stdout.pop()!)).toMatchObject({ recipient: 'MK', ids: [1, 3], status: 'acked' });
  const check = f.store();
  try {
    expect(check.getCursor('MK')).toBe(0);
    expect(check.listByRecipient('MK').map(row => row.id)).toEqual([2, 4]);
  } finally { check.close(); }
  expect(f.stderr).toEqual([]);
});

test('MSG-ACK-MULTI-ID: positional and selected IDs never acknowledge siblings or advance the cursor', async () => {
  const f = fixture();
  const store = f.store();
  try { for (const body of ['one', 'two', 'three', 'four']) store.post({ from: 'OP', to: 'MK', body }); }
  finally { store.close(); }
  await f.run('ack', '2', '--to', 'MK', '--json');
  expect(JSON.parse(f.stdout.pop()!)).toEqual({ recipient: 'MK', id: 2, status: 'acked' });
  await f.run('ack', '--ids', '1,3', '--to', 'MK', '--json');
  expect(JSON.parse(f.stdout.pop()!)).toMatchObject({ recipient: 'MK', ids: [1, 3], status: 'acked' });
  const check = f.store();
  try {
    expect(check.getCursor('MK')).toBe(0);
    expect(check.listByRecipient('MK').map(row => row.id)).toEqual([4]);
    for (const id of [1, 2, 3]) expect(check.listReceipts({ messageId: id }).map(row => row.state)).toEqual(['posted', 'seen']);
  } finally { check.close(); }
  await f.run('ack', '--ids', '4,999', '--to', 'MK');
  const after = f.store();
  try { expect(after.listByRecipient('MK').map(row => row.id)).toEqual([4]); }
  finally { after.close(); }
  expect(f.stderr.at(-1)).toContain('message not found');
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
  expect(f.stderr.pop()).toContain('+1 더 · --after 1');
  await f.run('list', '--to', 'MK', '--after', '1');
  expect(f.stdout.pop()).toBe('+0 더 · --after 3');
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
  await f.run('ack', '--through', '1', '--to', 't', '--json');
  expect(JSON.parse(f.stdout.pop()!)).toEqual({ recipient: 'MK', through: 1 });
  await f.run('list', '--to', 'MK', '--json');
  expect(JSON.parse(f.stdout.pop()!).map((row: { id: number }) => row.id)).toEqual([3]);
  await f.run('ack', '--through', '3', '--to', 'MK');
  expect(f.stdout.pop()).toBe('MK acknowledged through #3');
  const storeForPerMessageAck = f.store();
  let individualId: number;
  try { individualId = storeForPerMessageAck.post({ from: 'OP', to: 'MK', body: 'individual ack' }).id; }
  finally { storeForPerMessageAck.close(); }
  await f.run('ack', '--id', String(individualId!), '--to', 'MK', '--json');
  expect(JSON.parse(f.stdout.pop()!)).toEqual({ recipient: 'MK', id: individualId!, status: 'acked' });
  await f.run('unread', '--to', 't');
  expect(f.stdout.pop()).toBe('No unread messages.');
  await f.run('unread');
  expect(f.stdout.pop()).toBe('UX: 1 unread');
  const reopened = f.store();
  try { expect(reopened.getCursor('MK')).toBe(3); } finally { reopened.close(); }
});

test('list reports the exact unread remainder and next cursor after a 100-message page', async () => {
  const f = fixture();
  const store = f.store();
  try { for (let i = 1; i <= 140; i++) store.post({ from: 'OP', to: 'MK', body: `message ${i}` }); }
  finally { store.close(); }
  await f.run('list', '--to', 'MK');
  expect(f.stdout.filter(line => line.startsWith('#'))).toHaveLength(100);
  expect(f.stdout.at(-1)).toBe('+40 더 · --after 100');
  f.stdout.length = 0;
  await f.run('list', '--to', 'MK', '--after', '100');
  expect(f.stdout.filter(line => line.startsWith('#'))).toHaveLength(40);
  expect(f.stdout.at(-1)).toBe('+0 더 · --after 140');
  f.stdout.length = 0;
  await f.run('list', '--to', 'MK', '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toHaveLength(100);
  expect(f.stderr.at(-1)).toBe('+40 더 · --after 100');
});

test('list remainder excludes individually acknowledged mail and other recipients', async () => {
  const f = fixture(), store = f.store();
  try {
    for (let i = 1; i <= 140; i++) store.post({ from: 'OP', to: 'MK', body: `message ${i}` });
    store.ackMessage('MK', 20);
    store.post({ from: 'OP', to: 'UX', body: 'not for MK' });
    expect(store.unreadCountAfter('MK', 0)).toBe(139);
    expect(store.unreadCountAfter('MK', 100)).toBe(40);
  } finally { store.close(); }
  await f.run('list', '--to', 'MK');
  expect(f.stdout.filter(line => line.startsWith('#'))).toHaveLength(100);
  expect(f.stdout.at(-1)).toBe('+39 더 · --after 101');
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
  // SEAT-MAIL #24 — the sender-entrance reply auto-acked the request for TC (one per-message ack row; the cursor
  // still starts at 0). The stored row never carries the field, so strip it for the read-path comparisons below.
  expect(reply.autoAcked).toBe(request.id);
  delete reply.autoAcked;
  await f.run('list', '--thread', String(request.id), '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toEqual([request, reply]);
  await f.run('list', '--thread', String(request.id), '--after', String(request.id), '--limit', '1', '--json');
  expect(JSON.parse(f.stdout.at(-1)!)).toEqual([reply]);
  await f.run('list', '--to', 'TC', '--json');
  // SEAT-MAIL #24 — the auto-ack already consumed the request for TC; only the notice stays unread before the
  // explicit cursor ack below.
  expect(JSON.parse(f.stdout.at(-1)!)).toEqual([notice]);
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
  try { expect(store.getCursor('TC')).toBe(0); expect(store.getCursor('OP')).toBe(0); expect(store.listByRecipient('TC').map(row => row.id)).toEqual([notice.id]); }
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
  const oldQuestion: Message = { id: 1, from: 'OP', to: 'TC', body: 'old question', kind: 'memo', intent: 'info', needsAck: false, origin: { kind: 'agent', seat: 'OP' }, schemaVersion: 1, createdAt: '2026-10-01T00:00:00.000Z' };
  const oldAnswer: Message = { id: 2, from: 'TC', to: 'OP', body: 'old answer', intent: 'info', needsAck: false, origin: { kind: 'agent', seat: 'TC' }, schemaVersion: 1, createdAt: '2026-10-01T00:01:00.000Z' };
  await f.run('list', '--to', 'TC', '--after', '0', '--json');
  // MSG-FILTERS-RELAX: an explicit --after is a history read — each row carries its ack state.
  expect(JSON.parse(f.stdout.at(-1)!)).toEqual([{ ...oldQuestion, ackState: 'unread' }]);
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
  const post = spawnSync('bun', ['-e', script, 'msg', 'post', '--from', 'OP', '--to', 'MK', '--kind', 'info', '--json'],
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
  const reply = spawnSync('bun', ['-e', script, 'msg', 'post', 'settled yesterday', '--from', 'MK', '--to', 'OP', '--reply-to', '1', '--kind', 'status', '--json'],
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
    // MSG-FILTERS-RELAX: any --kind is stored now (see the MSG-FILTERS-RELAX tests); no row here.
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
  const card = { id: 'ta-20261015-a1b2c3', status: 'launched' as const, runId: 'run-card-1',
    text: 'task', createdAt: new Date().toISOString(), history: [] };
  const f = fixture('', () => ({
    readCard: id => id === card.id ? card : undefined,
    podFragmentsForRun: () => [],
    runScreen: () => ({ screenKey: 'local-card-space', logStoreStatus: 'read' }) as ReturnType<NonNullable<MsgCliDeps['runScreen']>>,
    screenAlive: space => space === 'local-card-space',
    sendMemo: (space, memo) => {
      return enqueueControlMemo(space, memo, { env: { ELANOUS_STATE_DIR: dir } });
    },
    sendStop: space => {
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
    const card = { id: 'ta-20261015-a1b2c3', status: 'launched' as const, runId: 'run-card-1',
      text: 'task', createdAt: new Date().toISOString(), history: [] };
    const f = fixture('', () => ({
      readCard: id => id === card.id ? card : undefined,
      podFragmentsForRun: () => [],
      runScreen: () => ({ screenKey: 'local-card-space', logStoreStatus: 'read' }) as ReturnType<NonNullable<MsgCliDeps['runScreen']>>,
      screenAlive: space => space === 'local-card-space',
    }));
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
  // #38516 r2 MF2: the TA follow-up failure is a warning with the stored id — the request itself is durable (not exit 2).
  expect(f.stderr.at(-1)).toBe('msg post: #1 stored; the TA follow-up failed: reply insert failed (retry with the same --origin-key is safe)');
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
  expect(wakes).toEqual([{ address: 'COORDINATOR', msgId: posted.id, message: { from: 'OP', kind: 'info' } }]);
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
  await program.parseAsync(['msg', 'post', 'durable while the service is down', '--from', 'OP', '--to', 'TC', '--kind', 'info', '--json'], { from: 'user' });
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
  await program.parseAsync(['msg', 'post', 'restart must replay me', '--from', 'OP', '--to', 'TC', '--kind', 'info', '--json'], { from: 'user' });
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

test('MSG-RECEIPTS-FOLLOWUP ① — positional and --through hand acks leave «seen» for acknowledged messages', async () => {
  const f = fixture();
  const writer = f.store();
  const a = writer.post({ from: 'OP', to: 'TC', body: 'a' });
  const b = writer.post({ from: 'OP', to: 'TC', body: 'b' });
  const c = writer.post({ from: 'OP', to: 'TC', body: 'c' });
  const d = writer.post({ from: 'OP', to: 'TC', body: 'd' });
  writer.close();
  await f.run('ack', String(b.id), '--to', 'TC'); // positional = exactly one
  await f.run('ack', '--through', String(c.id), '--to', 'TC');
  const store = f.store();
  try {
    for (const id of [a.id, b.id, c.id]) expect(store.listReceipts({ messageId: id }).map(r => `${r.state}:${r.source}`)).toEqual(['posted:ledger', 'seen:cli-ack']);
    expect(store.listReceipts({ messageId: d.id }).map(r => r.state)).toEqual(['posted']);
  } finally { store.close(); }
});

test('ELN-SEAT-LIVE 11-18 — msg post to a runtime=eln seat WITHOUT autowake: no herdr typing (one mail, one turn) · the 60s safety net is armed', async () => {
  const typed: Array<{ argv: string[] }> = [];
  const fallbacks: Array<{ messageId: number; recipient: string; from: string }> = [];
  const f = fixture('', ({ path }) => ({
    wake: undefined,
    spawnMailFallback: (input: { messageId: number; recipient: string; from: string }) => { fallbacks.push(input); },
    wakeDeps: {
      stateRoot: dirname(path), seatStateRoot: join(dirname(path), 'seats'), live: true,
      listPtys: () => [], readPane: () => null, hasOptIn: () => false,
      listHerdrPanes: () => [{ paneId: 'wX:p1', status: 'idle' }],
      herdrRun: async (argv: string[]) => { typed.push({ argv }); return { code: 0, stdout: '{}', stderr: '' }; },
      readRegistry: () => ({ status: 'ready', registry: { version: 1, seats: [
        { address: 'HAND-ELN-ELS-API', host: 'local', target: 'wX:p1', wake: 'herdr', replyBody: 'agent', optIn: true, runtime: 'eln' },
      ] } }),
    },
  } as unknown as Partial<MsgCliDeps>));
  await f.run('post', '기동 확인', '--from', 'RES-INFRA', '--to', 'HAND-ELN-ELS-API');
  expect(f.exits).toEqual([]);
  expect(typed).toEqual([]);
  expect(fallbacks).toEqual([{ messageId: 1, recipient: 'HAND-ELN-ELS-API', from: 'RES-INFRA' }]);
});

test('ELS seat registration appears in msg route output', async () => {
  const seatStateRoot = mkdtempSync(join(tmpdir(), 'msg-els-address-'));
  dirs.push(seatStateRoot);
  const f = fixture('', () => ({ wakeDeps: { seatStateRoot, listPtys: () => [], listHerdrPanes: () => [] } }));
  await f.run('address', 'register', 'CX1', '--els-pane', 'els:w1/t1/p1', '--host', 'local', '--wake');
  expect(f.exits).toEqual([]);
  await f.run('route', 'CX1');
  expect(f.stdout.at(-1)).toContain('wake=els');
  expect(f.stdout.at(-1)).toContain('target=els:w1/t1/p1');
});

test('route uses a live ELS seat when its inbox heartbeat is absent', async () => {
  const seatStateRoot = mkdtempSync(join(tmpdir(), 'msg-els-live-'));
  dirs.push(seatStateRoot);
  const calls: string[] = [];
  let herdrReads = 0;
  const f = fixture('', () => ({ wakeDeps: {
    seatStateRoot, listPtys: () => [], listHerdrPanes: () => { herdrReads++; return []; },
    elsRequest: async request => {
      calls.push(request.op);
      if (request.op === 'ls') return { exitCode: 0, message: JSON.stringify({ panes: [
        { seat: 'CX1', address: 'w1/t1/p1', pane: 'p1', state: 'idle', ptyId: 'h:p1' },
      ] }) };
      if (request.op === 'status') return { exitCode: 0, message: JSON.stringify({ state: 'idle', inputEmpty: true }) };
      return { exitCode: 1, message: 'unexpected request' };
    },
  } }));
  await f.run('route', 'CX1', '--json');
  expect(JSON.parse(f.stdout[0]!)).toMatchObject({ msgAddress: 'CX1', wake: 'els', target: 'els:w1/t1/p1', liveness: 'live' });
  expect(calls).toEqual(['ls', 'status']);
  expect(herdrReads).toBe(0);
});

test('route uses ELS cwd seat when the PTY is alive but its activity screen has no recognised prompt', async () => {
  const seatStateRoot = mkdtempSync(join(tmpdir(), 'msg-els-cwd-live-'));
  dirs.push(seatStateRoot);
  const f = fixture('', () => ({ wakeDeps: {
    seatStateRoot, listHerdrPanes: () => [],
    elsRequest: async request => request.op === 'ls'
      ? { exitCode: 0, message: JSON.stringify({ panes: [{ seat: null,
        cwd: '/tmp/probe/elanous-hq/seats/CX15-ELS-PROBE', address: 'w1/t1/p1', pane: 'p1', state: 'working', ptyId: 'h:p1',
      }] }) }
      : { exitCode: 0, message: JSON.stringify({ state: 'unknown',
        reason: 'no working row and no prompt recognised on screen', inputEmpty: 'unknown' }) },
  } }));
  await f.run('route', 'CX15-ELS-PROBE', '--json');
  expect(JSON.parse(f.stdout[0]!)).toMatchObject({ msgAddress: 'CX15-ELS-PROBE', source: 'els',
    wake: 'els', target: 'els:w1/t1/p1', optIn: false, liveness: 'live' });
});

test('route reads the registered remote host ELS ledger and does not use the local server', async () => {
  const hosts: string[] = [];
  const f = fixture('', () => ({ wakeDeps: {
    listHerdrPanes: () => [],
    readRegistry: () => ({ status: 'ready', registry: { version: 1, seats: [
      { address: 'CX2', host: 'node-b', wake: 'herdr', target: 'wX:p2', replyBody: 'agent', optIn: false },
    ] } }),
    elsRequestForHost: async (host, request) => {
      hosts.push(`${host}:${request.op}`);
      return request.op === 'ls'
        ? { exitCode: 0, message: JSON.stringify({ panes: [{ seat: 'CX2', address: 'w2/t2/p2', pane: 'p2', ptyId: 'h:p2' }] }) }
        : { exitCode: 0, message: JSON.stringify({ state: 'working', inputEmpty: 'unknown' }) };
    },
  } }));
  await f.run('route', 'CX2', '--json');
  expect(JSON.parse(f.stdout[0]!)).toMatchObject({ host: 'node-b', wake: 'els', target: 'els:w2/t2/p2', liveness: 'live', optIn: false });
  expect(hosts).toEqual(['node-b:ls', 'node-b:status']);
});

test('route distinguishes an absent ELS seat from a failed server lookup', async () => {
  const seatStateRoot = mkdtempSync(join(tmpdir(), 'msg-els-errors-'));
  dirs.push(seatStateRoot);
  let failed = false;
  const f = fixture('', () => ({ wakeDeps: {
    seatStateRoot, listHerdrPanes: () => [],
    elsRequest: async () => failed
      ? { exitCode: 1, message: 'server unavailable' }
      : { exitCode: 0, message: JSON.stringify({ panes: [] }) },
  } }));
  await f.run('route', 'CX4', '--json');
  expect(JSON.parse(f.stdout[0]!)).toMatchObject({ liveness: 'down' });
  failed = true;
  await f.run('route', 'CX4', '--json');
  expect(JSON.parse(f.stdout[1]!)).toMatchObject({ liveness: 'unknown', livenessReason: 'els-unavailable' });
});

test('remote tmux seat is live from its host ledger when ELS is unavailable', async () => {
  const seatStateRoot = mkdtempSync(join(tmpdir(), 'msg-remote-ledger-'));
  dirs.push(seatStateRoot);
  const hosts: string[] = [];
  const f = fixture('', () => ({ wakeDeps: {
    seatStateRoot, listHerdrPanes: () => [],
    readRegistry: () => ({ status: 'ready', registry: { version: 1, seats: [
      { address: 'CX5', host: 'node-b', wake: 'herdr', target: 'w5:p5', replyBody: 'agent', optIn: false },
    ] } }),
    elsRequestForHost: async () => ({ exitCode: 1, message: 'no ELS server' }),
    remoteSeatLiveness: async (host, seat) => { hosts.push(`${host}:${seat}`); return { state: 'live', ageMs: 0 }; },
  } }));
  await f.run('route', 'CX5', '--json');
  expect(JSON.parse(f.stdout[0]!)).toMatchObject({ host: 'node-b', wake: 'herdr', liveness: 'live' });
  expect(hosts).toEqual(['node-b:CX5']);
});

test('route falls back to the federated Herdr host cwd when the ELS owner has no seat', async () => {
  const seatStateRoot = mkdtempSync(join(tmpdir(), 'msg-herdr-ledger-'));
  dirs.push(seatStateRoot);
  const f = fixture('', () => ({ wakeDeps: {
    seatStateRoot, listHerdrPanes: () => [],
    elsRequest: async () => ({ exitCode: 0, message: JSON.stringify({ panes: [] }) }),
    herdrRun: async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ result: { snapshot: { panes: [
      { workspace_id: 'w8', pane_id: 'w8:pP', tab_id: 'w8:tP', cwd: '/Users/j/elanous-hq/seats/TC-H-POOL-4', agent_status: 'working' },
    ] } } }) }),
  } }));
  await f.run('route', 'TC-H-POOL-4', '--json');
  expect(JSON.parse(f.stdout[0]!)).toMatchObject({ msgAddress: 'TC-H-POOL-4', liveness: 'live' });
});

test('route treats its own mshq registry alias as local for Herdr fallback', async () => {
  const seatStateRoot = mkdtempSync(join(tmpdir(), 'msg-local-alias-'));
  dirs.push(seatStateRoot);
  const f = fixture('', () => ({ wakeDeps: {
    seatStateRoot, localHostAliases: ['mshq'], listHerdrPanes: () => [{ paneId: 'wA:p1', status: 'done' }],
    readRegistry: () => ({ status: 'ready', registry: { version: 1, seats: [
      { address: 'MK', host: 'mshq', wake: 'herdr', target: 'wA:p1', replyBody: 'agent', optIn: true },
    ] } }),
    elsRequest: async () => ({ exitCode: 0, message: JSON.stringify({ panes: [] }) }),
    herdrRun: async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ result: { snapshot: { panes: [
      { workspace_id: 'wA', pane_id: 'wA:p1', tab_id: 'wA:t1', cwd: '/Users/j/elanous-hq/seats/MK', agent_status: 'done' },
    ] } } }) }),
  } }));
  await f.run('route', 'MK', '--json');
  expect(JSON.parse(f.stdout[0]!)).toMatchObject({ host: 'mshq', wake: 'herdr', liveness: 'live' });
});

test('twelve ELS registered seats form a live CLI route table', async () => {
  const seatStateRoot = mkdtempSync(join(tmpdir(), 'msg-els-table-'));
  dirs.push(seatStateRoot);
  const seats = Array.from({ length: 12 }, (_, i) => `CX-${i + 1}`);
  const panes = seats.map((seat, i) => ({ seat, address: `w1/t1/p${i + 1}`, pane: `p${i + 1}`, ptyId: `h:p${i + 1}` }));
  const f = fixture('', () => ({ wakeDeps: { seatStateRoot, listHerdrPanes: () => [],
    elsRequest: async request => request.op === 'ls'
      ? { exitCode: 0, message: JSON.stringify({ panes }) }
      : { exitCode: 0, message: JSON.stringify({ state: 'working', inputEmpty: 'unknown' }) },
  } }));
  for (const seat of seats) await f.run('route', seat, '--json');
  expect(f.stdout.map(line => JSON.parse(line)).map(row => [row.msgAddress, row.source, row.liveness]))
    .toEqual(seats.map(seat => [seat, 'els', 'live']));
});

test('successful verified ELS wake records delivered but not seen', async () => {
  const f = fixture('', () => ({ wake: async (address, msgId) => ({ wake: 'els', target: 'els:w1/t1/p1', source: 'seat-registry', address, msgId, result: 'injected' }) }));
  await f.run('post', 'hello', '--from', 'OP', '--to', 'CX1', '--json');
  const posted = JSON.parse(f.stdout[0]!) as { id: number };
  const store = f.store();
  try { expect(store.listReceipts({ messageId: posted.id }).map(row => row.state)).toEqual(['posted', 'delivered']); }
  finally { store.close(); }
});

test('a busy ELS wake reports deferral while retaining the posted message', async () => {
  const f = fixture('', () => ({ wake: async (address, msgId) => ({ wake: 'els', source: 'seat-registry', address, msgId, result: 'busy', reason: 'els-working' }) }));
  await f.run('post', 'hello', '--from', 'OP', '--to', 'CX1', '--json');
  expect(f.stderr.join('\n')).toContain('deferred (busy: els-working)');
  const store = f.store();
  try { expect(store.list('CX1').map(row => row.body)).toEqual(['hello']); }
  finally { store.close(); }
});

test('busy ELS wake arms the existing one-shot retry, but uncertain delivery does not', async () => {
  const retries: { messageId: number; recipient: string; from: string }[] = [];
  let result: 'busy' | 'failed' = 'busy';
  const f = fixture('', () => ({ wake: async (address, msgId) => ({ wake: 'els', source: 'seat-registry', address, msgId, result }),
    spawnMailFallback: input => { retries.push(input); } }));
  await f.run('post', 'first', '--from', 'OP', '--to', 'CX1');
  result = 'failed';
  await f.run('post', 'second', '--from', 'OP', '--to', 'CX1');
  expect(retries).toEqual([{ messageId: 1, recipient: 'CX1', from: 'OP' }]);
});

test('msg hook CLI never blocks on a TTY stdin (interactive invocation)', async () => {
  const f = fixture('', () => ({
    hookStateDir: undefined, stdinIsTty: () => true,
    readStdin: () => new Promise<string>(() => { /* never resolves — TTY 라면 읽지 않아야 완주 */ }),
  }));
  const store = f.store();
  try { store.post({ from: 'MK', to: 'OP', body: 'tty invocation wake' }); } finally { store.close(); }
  await f.run('hook', '--event', 'user-prompt-submit', '--format', 'claude', '--seat', 'OP');
  expect(f.stdout[0]).toBeDefined();
  expect(f.stderr).toEqual([]);
});

test('msg hook CLI bounds an unclosed pipe stdin: HOOK_STDIN_READ_LIMIT_MS 뒤 빈 입력 폴백으로 완주', async () => {
  const f = fixture('', () => ({
    hookStateDir: undefined, stdinIsTty: () => false,
    readStdin: () => new Promise<string>(() => { /* never resolves — 닫히지 않는 파이프(테스트·데몬) */ }),
    stdinReadLimitMs: 20,
  }));
  const store = f.store();
  try { store.post({ from: 'MK', to: 'OP', body: 'unclosed pipe wake' }); } finally { store.close(); }
  const started = Date.now();
  await f.run('hook', '--event', 'user-prompt-submit', '--format', 'claude', '--seat', 'OP');
  expect(Date.now() - started).toBeGreaterThanOrEqual(15); // 상한 대기 후 폴백 (즉시 EOF 아님)
  expect(f.stdout[0]).toBeDefined(); // 빈 입력 → 프로세스 문맥(--seat) 으로 정상 hook 출력
  expect(f.stderr).toEqual([]);
});

// [JUD-B #106365 must 1] fd0 반납 회귀 — 실자식: stdin 파이프를 열어 둔 채(EOF 없음) hook 을 돌려도
// 상한+여유 안에 exit 0 이어야 한다(진행 중 읽기를 reader.cancel() 로 취소하지 않으면 프로세스가 종료하지 않는다).
test('real hook child exits 0 within HOOK_STDIN_READ_LIMIT_MS+margin with an unclosed pipe stdin (fd0 released)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'msg-cli-hook-fd0-'));
  dirs.push(dir);
  const script = `import { Command } from 'commander'; import { registerMsgCommands } from './src/cli/msg-cli.ts'; const cli = new Command(); registerMsgCommands(cli); await cli.parseAsync(process.argv.slice(1), { from: 'user' });`;
  const child = Bun.spawn(['bun', '-e', script, 'msg', 'hook', '--event', 'user-prompt-submit', '--format', 'claude', '--seat', 'OP'], {
    cwd: process.cwd(), env: { ...process.env, ELANOUS_STATE_DIR: dir }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  const started = Date.now();
  const stderrText = new Response(child.stderr).text();
  try {
    const code = await child.exited; // stdin 을 끝내지 않은 채 대기 — 취소 없으면 60s 기본 타임아웃으로 빨강
    expect(code, await stderrText).toBe(0);
    expect(Date.now() - started).toBeLessThan(HOOK_STDIN_READ_LIMIT_MS + 8_000); // 상한(5s)+여유 안에 종료
    expect(Date.now() - started).toBeGreaterThanOrEqual(HOOK_STDIN_READ_LIMIT_MS); // 상한을 실제로 기다린 뒤 폴백
  } finally { try { child.stdin.end(); } catch { /* 자식 종료 뒤 정리 */ } }
});

describe('MSG-FILTERS-RELAX — msg post accepts and stores instead of refusing', () => {
  test('MAIL-ANTI-FLOOD E: an unknown kind is refused with the fix (nothing stored); an unknown intent is stored as info with an intent: ref', async () => {
    const f = fixture();
    await f.run('post', 'hello', '--from', 'OP', '--to', 'TC', '--kind', 'Coord.Reply', '--json');
    expect(f.exits).toEqual([2]);
    expect(f.stderr.at(-1)).toStartWith('msg: msg post refused (unknown --kind "Coord.Reply"): add --kind <request|question|decision|alert|info|notice|status|report|announce|coord|ack|receipt|goal|consult|coach>');
    await f.run('post', 'hello', '--from', 'OP', '--to', 'TC', '--kind', 'Coord', '--intent', 'Heads-Up', '--json');
    const posted = JSON.parse(f.stdout.at(-1)!);
    expect([posted.id, posted.kind, posted.intent, posted.refs]).toEqual([1, 'coord', 'info', ['intent:heads-up']]);
  });

  test('MAIL-ANTI-FLOOD E·F: a kind-less post is stored as passive info with one warning line (exit 0); self-mail becomes a scheduled wake; coach info becomes a note', async () => {
    const f = fixture();
    await f.run('post', 'hello', '--from', 'TC', '--to', 'OP', '--kind', '', '--json');
    expect(f.exits).toEqual([]);
    expect(f.stderr).toEqual(['msg post warning (no --kind): stored as --kind info (passive · needsReply=false · no turn) — add --kind <request|question|decision|alert|info|notice|status|report|announce|coord|ack|receipt|goal|consult|coach> and --needs-reply when you wait for an answer']);
    expect(JSON.parse(f.stdout.at(-1)!)).toMatchObject({ id: 1, kind: 'info', needsAck: false });
    await f.run('post', '⏰ 13:20 check', '--from', 'OP', '--to', 'OP', '--kind', 'notice', '--json');
    expect(JSON.parse(f.stdout.at(-1)!)).toEqual({ diverted: 'self-wake', to: 'OP', kind: 'notice', needsReply: false, line: 'self-mail → scheduled wake for OP (not a mailbox row)' });
    await f.run('post', 'board', '--from', 'CLAUDE-OP', '--to', 'OP', '--kind', 'coach');
    expect(f.stdout.at(-1)).toBe('msg post: coach injection → coach note for OP (one line per 30 min in its next turn · not mail)');
    await f.run('post', 'decide?', '--from', 'CLAUDE-OP', '--to', 'OP', '--kind', 'decision', '--json');
    expect(JSON.parse(f.stdout.at(-1)!)).toMatchObject({ id: 2, from: 'CLAUDE-OP', kind: 'decision', needsAck: true });
    const store = f.store();
    try { expect(store.list('OP').map((m) => m.body)).toEqual(['hello', 'decide?']); } finally { store.close(); }
  });

  test('a --from that differs from the caller seat is stored with the caller in origin.seat', async () => {
    const f = fixture('', () => ({ callerSeat: () => 'OP' }));
    await f.run('post', 'on behalf', '--from', 'TC', '--to', 'UX', '--json');
    expect(f.exits).toEqual([]);
    const posted = JSON.parse(f.stdout.at(-1)!);
    expect([posted.from, posted.origin]).toEqual(['TC', { kind: 'agent', seat: 'OP' }]);
    const store = f.store();
    try { expect(store.getMessage(posted.id)!.origin).toEqual({ kind: 'agent', seat: 'OP' }); } finally { store.close(); }
  });

  test('--from defaults to the caller seat, then to the seat folder of the cwd', async () => {
    const f = fixture('', () => ({ callerSeat: () => 'ux' }));
    await f.run('post', 'no from', '--to', 'OP', '--json');
    expect(JSON.parse(f.stdout.at(-1)!).from).toBe('UX');
    const g = fixture('', () => ({ cwd: () => '/Users/someone/elanous-hq/seats/MK/sub' }));
    await g.run('post', 'from cwd', '--to', 'OP', '--json');
    expect(JSON.parse(g.stdout.at(-1)!).from).toBe('MK');
  });

  test('a sub-seat sender is accepted', async () => {
    const f = fixture();
    await f.run('post', 'sub seat', '--from', 'mk/graphics', '--to', 'OP', '--json');
    expect(f.exits).toEqual([]);
    expect(JSON.parse(f.stdout.at(-1)!).from).toBe('MK/graphics');
  });

  test('an unknown --priority and an unparsable --deadline are warnings; the message is stored', async () => {
    const f = fixture();
    await f.run('post', 'still goes', '--from', 'OP', '--to', 'TC', '--priority', 'asap', '--deadline', 'soon', '--json');
    expect(f.exits).toEqual([]);
    const posted = JSON.parse(f.stdout.at(-1)!);
    expect(posted.body).toBe('still goes');
    expect(posted.priority).toBeUndefined();
    expect(posted.deadlineAt).toBeUndefined();
    expect(f.stderr).toContain('msg post 경고: --priority asap 를 모른다 (urgent · p0 · normal · 정수) — 우선순위 없이 저장한다');
    expect(f.stderr).toContain('msg post 경고: --deadline must be a date/time Date.parse accepts, HH:MM or +<n>m|h (soon) — 기한 없이 저장한다');
    await f.run('post', 'numeric', '--from', 'OP', '--to', 'TC', '--priority', '5', '--json');
    expect(JSON.parse(f.stdout.at(-1)!).priority).toBe(5);
  });
});

describe('MSG-FILTERS-RELAX — msg list re-reads acknowledged mail', () => {
  test('ack a mail → plain list hides it, --all shows it with its acked state, --after returns it too', async () => {
    const f = fixture();
    const store = f.store();
    try {
      store.post({ from: 'OP', to: 'MK', body: 'first' });
      store.post({ from: 'OP', to: 'MK', body: 'second' });
    } finally { store.close(); }
    await f.run('ack', '--id', '1', '--to', 'MK', '--json');
    await f.run('list', '--to', 'MK', '--json');
    expect(JSON.parse(f.stdout.at(-1)!).map((row: { id: number }) => row.id)).toEqual([2]);
    await f.run('list', '--to', 'MK', '--all', '--json');
    expect(JSON.parse(f.stdout.at(-1)!).map((row: { id: number; ackState: string }) => [row.id, row.ackState])).toEqual([[1, 'acked'], [2, 'unread']]);
    await f.run('list', '--to', 'MK', '--after', '0', '--json');
    expect(JSON.parse(f.stdout.at(-1)!).map((row: { id: number }) => row.id)).toEqual([1, 2]);
    f.stdout.length = 0;
    await f.run('list', '--to', 'MK', '--all');
    expect(f.stdout[0]).toMatch(/^#1 \S+ OP → MK \[\S+\] \(acked\): first$/);
    expect(f.stdout[1]).toMatch(/^#2 \S+ OP → MK \[\S+\] \(unread\): second$/);
    // cursor ack (through) is shown as acked too.
    await f.run('ack', '2', '--to', 'MK');
    f.stdout.length = 0;
    await f.run('list', '--to', 'MK', '--all', '--json');
    expect(JSON.parse(f.stdout[0]!).map((row: { ackState: string }) => row.ackState)).toEqual(['acked', 'acked']);
    await f.run('list', '--thread', '1', '--json');
    expect(JSON.parse(f.stdout.at(-1)!).map((row: { id: number }) => row.id)).toEqual([1]);
  });
});

test('MSG-ADDRESS-DID-YOU-MEAN: a near-miss undeclared address is refused with a suggestion; a new address still posts', async () => {
  const { didYouMeanAddress } = await import('./msg-cli.js');
  expect(didYouMeanAddress('OP-CLAUDE', ['CLAUDE-OP', 'OP'])).toBe('CLAUDE-OP');
  expect(didYouMeanAddress('JUD-33', ['JUD-3', 'OP'])).toBe('JUD-3');
  expect(didYouMeanAddress('BRANDNEW', ['CLAUDE-OP', 'OP'])).toBe(null);
  expect(didYouMeanAddress('CLAUDE-OP', ['CLAUDE-OP'])).toBe(null);
  const f = fixture('', () => ({ wakeDeps: {
    listHerdrPanes: () => [],
    readRegistry: () => ({ status: 'ready', registry: { version: 1, seats: [] } }),
  } }));
  await f.run('post', 'seed', '--from', 'OP', '--to', 'CLAUDE-OP');
  await f.run('post', 'typo', '--from', 'OP', '--to', 'OP-CLAUDE');
  expect(f.exits.at(-1)).not.toBe(0);
  expect(f.stderr.some(line => line.includes('did you mean CLAUDE-OP'))).toBe(true);
  const store = f.store();
  try { expect(store.list('OP-CLAUDE')).toEqual([]); } finally { store.close(); }
});
