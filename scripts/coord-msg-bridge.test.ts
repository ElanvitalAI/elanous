import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { MsgStore } from '../src/msg/msg-store.js';
import { registerMsgCommands } from '../src/cli/msg-cli.js';
import { routeCoordComment, runBridge, runBridgeWithClock } from './coord-msg-bridge.js';

const roots: string[] = [];
const oldState = process.env.ELANOUS_STATE_DIR;
afterEach(() => {
  if (oldState === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = oldState;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const comment = (id: number, body: string, created_at = '2026-10-12T09:00:00Z') =>
  ({ id, body, created_at, html_url: `https://github.com/example/repo/issues/26146#issuecomment-${id}` });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'coord-msg-bridge-'));
  roots.push(root);
  process.env.ELANOUS_STATE_DIR = root;
  const dbPath = join(root, 'msg', 'messages.db');
  const cursorPath = join(root, 'msg', 'coord-bridge-26146-MK.json');
  const run = (items: ReturnType<typeof comment>[], ...args: string[]) =>
    runBridge(['--seat', 'MK', '--channel', '26146', ...args], () => items);
  return { root, dbPath, cursorPath, run };
}

test('first-line, cc, whole-channel, and body mention route once per recipient; sender is excluded', () => {
  expect(routeCoordComment('**[OP]** 10:00 → MK · TC · cc UX · 요청\n🙋 TC 🙋 OP')).toEqual({
    sender: 'OP', recipients: ['MK', 'TC', 'UX'],
  });
  expect(routeCoordComment('**[MK]** 10:00 → 전체 · 사고\ntext')?.recipients).toEqual(['OP', 'TC', 'UX', 'E']);
  expect(routeCoordComment('**[MK]** 10:00 → OP · 보고\n🙋 MK')?.recipients).toEqual(['OP']);
  expect(routeCoordComment('**[OP]** 2026-10-12 18:26 KST → MK(⊕ UX·TC) · 지시\n본문')?.recipients)
    .toEqual(['MK', 'UX', 'TC']);
  expect(routeCoordComment('**[TC]** 19:46 KST → OP 🎓 확인: 방법 맞나?')?.recipients).toEqual(['OP']);
  expect(routeCoordComment('no sender → MK')).toBeNull();
});

test('an overlapping older run cannot move the durable cursor backward', () => {
  const f = fixture();
  const older = comment(100, '**[OP]** 10:00 → MK · old');
  const newer = comment(200, '**[OP]** 10:01 → MK · new');
  const oldResult = runBridge(['--seat', 'MK', '--channel', '26146'], () => {
    expect(f.run([older, newer]).cursor).toBe(200);
    return [older];
  });
  expect(oldResult.cursor).toBe(200);
  expect(f.run([older, newer])).toMatchObject({ picked: 0, cursor: 200 });
  const db = new MsgStore(f.dbPath);
  expect(db.list('MK').map((row) => row.body)).toEqual([older.body, newer.body]);
  db.close();
});

test('a torn cursor append does not prevent replay and later progress', () => {
  const f = fixture();
  const first = comment(100, '**[OP]** 10:00 → MK · first');
  const second = comment(200, '**[OP]** 10:01 → MK · second');
  expect(f.run([first]).cursor).toBe(100);
  appendFileSync(f.cursorPath, '{"lastId":999,"createdAt":');
  expect(f.run([first, second])).toMatchObject({ picked: 1, added: 1, cursor: 200 });
  expect(f.run([first, second])).toMatchObject({ picked: 0, cursor: 200 });
  const db = new MsgStore(f.dbPath);
  expect(db.list('MK').map((row) => row.body)).toEqual([first.body, second.body]);
  db.close();
});

test('a changed parser replays only the last six hours once, recovering a previously skipped addressee', () => {
  const f = fixture();
  mkdirSync(join(f.root, 'msg'), { recursive: true });
  const oldCursor = `${JSON.stringify({ lastId: 200, createdAt: '2026-10-12T11:00:00Z',
    parserHash: '0'.repeat(64) })}\n`;
  writeFileSync(f.cursorPath, oldCursor);
  const atBoundary = comment(198, '**[TC]** 06:00 KST → MK 🎓 확인: 경계 포함', '2026-10-12T06:00:00Z');
  const missed = comment(199, '**[TC]** 09:00 KST → MK 🎓 확인: 재조회', '2026-10-12T09:00:00Z');
  const tooOld = comment(200, '**[TC]** 05:00 KST → MK 🎓 확인: 제외', '2026-10-12T05:00:00Z');
  const fresh = comment(201, '**[OP]** 11:30 KST → MK · 새 글', '2026-10-12T11:30:00Z');
  const items = [atBoundary, missed, tooOld, fresh];
  const since: Array<string | undefined> = [];
  // GitHub's `since` is exclusive on updated_at. These fixtures were never edited.
  const fetch = (_channel: string, floor?: string) => {
    since.push(floor);
    return items.filter((item) => !floor || Date.parse(item.created_at) > Date.parse(floor));
  };
  const now = () => Date.parse('2026-10-12T12:00:00Z');
  expect(runBridgeWithClock(['--seat', 'MK'], fetch, now)).toMatchObject({ picked: 3, added: 3, cursor: 201 });
  expect(since[0]).toBe('2026-10-12T05:59:59.000Z');
  const cursor = JSON.parse(readFileSync(f.cursorPath, 'utf8').trim().split('\n').at(-1)!);
  expect(cursor.parserHash).toMatch(/^[a-f0-9]{64}$/);
  expect(cursor.parserHash).not.toBe('0'.repeat(64));
  expect(runBridgeWithClock(['--seat', 'MK'], fetch, now)).toMatchObject({ picked: 0, added: 0, cursor: 201 });
  const db = new MsgStore(f.dbPath);
  expect(db.list('MK').map((row) => row.body)).toEqual([atBoundary.body, missed.body, fresh.body]);
  db.close();
  // An older overlapping process cannot erase a current marker at the same ID.
  appendFileSync(f.cursorPath, oldCursor.replace('"lastId":200', '"lastId":201'));
  expect(runBridgeWithClock(['--seat', 'MK'], fetch, now)).toMatchObject({ picked: 0, added: 0 });
  // A crash after insertion but before the parser marker is durable replays safely.
  writeFileSync(f.cursorPath, oldCursor.replace('"lastId":200', '"lastId":201'));
  expect(runBridgeWithClock(['--seat', 'MK'], fetch, now)).toMatchObject({ picked: 3, added: 0, existing: 3 });
});

test('parser replay fetch failure preserves the previous cursor and message store', () => {
  const f = fixture();
  mkdirSync(join(f.root, 'msg'), { recursive: true });
  const oldCursor = `${JSON.stringify({ lastId: 200, createdAt: '2026-10-12T11:00:00Z' })}\n`;
  writeFileSync(f.cursorPath, oldCursor);
  expect(() => runBridgeWithClock(['--seat', 'MK'], () => { throw new Error('gh unavailable'); },
    () => Date.parse('2026-10-12T12:00:00Z'))).toThrow('gh unavailable');
  expect(readFileSync(f.cursorPath, 'utf8')).toBe(oldCursor);
  expect(existsSync(f.dbPath)).toBe(false);
});

test('CLI cursor and provenance make repeated fetches and crash replay idempotent without advancing ack', async () => {
  const f = fixture();
  const items = [comment(100, '**[OP]** 10:00 → MK · 요청 · K1\nhello'),
    comment(101, '**[TC]** 10:01 → UX · cc MK · 보고\n🙋 MK'),
    comment(102, '**[MK]** 10:02 → MK · 보고\nself'),
    comment(103, '**[TC]** 10:03 → OP · 보고\nother')];
  expect(f.run(items)).toEqual({ seat: 'MK', read: 4, picked: 2, added: 2, existing: 0, cursor: 103 });
  const db = new MsgStore(f.dbPath);
  expect(db.list('MK').map((row) => [row.from, row.body])).toEqual([
    ['OP', items[0]!.body], ['TC', items[1]!.body],
  ]);
  const firstId = db.list('MK')[0]!.id;
  db.ack('MK', firstId);
  db.close();
  expect(f.run(items)).toMatchObject({ picked: 0, added: 0, existing: 0, cursor: 103 });
  rmSync(f.cursorPath); // a crash after DB commit but before cursor rename replays the same comments
  expect(f.run(items)).toMatchObject({ picked: 2, added: 0, existing: 2, cursor: 103 });
  const reopened = new MsgStore(f.dbPath);
  expect(reopened.list('MK')).toHaveLength(2);
  expect(reopened.getCursor('MK')).toBe(firstId);
  const output: string[] = [];
  const program = new Command();
  registerMsgCommands(program, { openStore: () => new MsgStore(f.dbPath), out: { log: (line) => output.push(line), error: (line) => output.push(line) } });
  await program.parseAsync(['msg', 'watch', '--to', 'MK', '--since-ack', '--once', '--json'], { from: 'user' });
  expect(output.map((line) => JSON.parse(line).body)).toEqual([items[1]!.body]);
  reopened.close();
});

test('dry-run leaves both files absent; fetch failure and malformed page preserve message and cursor state', () => {
  const f = fixture();
  const one = comment(200, '**[OP]** 10:00 → MK · 요청\nprivate');
  expect(f.run([one], '--dry-run')).toMatchObject({ picked: 1, added: 1, cursor: 0 });
  expect(existsSync(f.dbPath)).toBe(false);
  expect(existsSync(f.cursorPath)).toBe(false);
  f.run([one]);
  const cursorBefore = readFileSync(f.cursorPath, 'utf8');
  expect(() => runBridge(['--seat', 'MK'], () => { throw new Error('gh unavailable'); })).toThrow('gh unavailable');
  expect(() => f.run([comment(201, '**[TC]** → MK\nvalid'), { ...comment(202, 'bad'), id: NaN }])).toThrow('invalid channel comment');
  expect(readFileSync(f.cursorPath, 'utf8')).toBe(cursorBefore);
  const db = new MsgStore(f.dbPath);
  expect(db.list('MK')).toHaveLength(1);
  db.close();
});

test('initial --since checks creation time even when GitHub returns an older edited comment', () => {
  const f = fixture();
  const old = comment(201, '**[OP]** 10:00 → MK · 요청\nold', '2026-10-11T09:00:00Z');
  const fresh = comment(202, '**[TC]** 10:00 → MK · 보고\nfresh', '2026-10-12T09:00:00Z');
  const seenSince: Array<string | undefined> = [];
  const fetch = (_channel: string, since?: string) => { seenSince.push(since); return [old, fresh]; };
  expect(runBridge(['--seat', 'MK', '--since', '2026-10-12T00:00:00Z'], fetch))
    .toMatchObject({ read: 2, picked: 1, added: 1, cursor: 202 });
  expect(seenSince).toEqual(['2026-10-12T00:00:00Z']);
  const db = new MsgStore(f.dbPath);
  expect(db.list('MK').map((row) => row.body)).toEqual([fresh.body]);
  db.close();
});

test('empty first --since fetch saves the floor and later excludes older edited comments', () => {
  const f = fixture();
  const floor = '2026-10-12T00:00:00Z';
  expect(runBridge(['--seat', 'MK', '--since', floor], () => []))
    .toMatchObject({ read: 0, picked: 0, cursor: 0 });
  expect(JSON.parse(readFileSync(f.cursorPath, 'utf8'))).toMatchObject({ lastId: 0, sinceFloor: floor });
  const old = comment(201, '**[OP]** 10:00 → MK · 요청\nold', '2026-10-11T09:00:00Z');
  const fresh = comment(202, '**[TC]** 10:00 → MK · 보고\nfresh', '2026-10-12T09:00:00Z');
  const seenSince: Array<string | undefined> = [];
  expect(runBridge(['--seat', 'MK'], (_channel, since) => { seenSince.push(since); return [old, fresh]; }))
    .toMatchObject({ read: 2, picked: 1, added: 1, cursor: 202 });
  expect(seenSince).toHaveLength(1);
  expect(seenSince[0]).toContain('2026-10-11T23:59:59');
  const db = new MsgStore(f.dbPath);
  expect(db.list('MK').map((row) => row.body)).toEqual([fresh.body]);
  db.close();
});

test('one-shot command fetches GitHub comments and advances only its own seat cursor', () => {
  const f = fixture();
  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  const gh = join(bin, 'gh');
  writeFileSync(gh, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GH_CALLS"\ncat "$GH_COMMENTS"\n');
  chmodSync(gh, 0o755);
  const items = [comment(301, '**[OP]** 10:00 → MK · cc TC\nmessage')];
  const commentsPath = join(f.root, 'comments.jsonl');
  writeFileSync(commentsPath, `${JSON.stringify(items[0])}\n`);
  const callsPath = join(f.root, 'calls.txt');
  const env = { ...process.env, ELANOUS_STATE_DIR: f.root, GH_COMMENTS: commentsPath, GH_CALLS: callsPath,
    PATH: `${bin}:${process.env.PATH}` };
  const invoke = () => Bun.spawnSync(['bun', join(import.meta.dir, 'coord-msg-bridge.ts'), '--seat', 'MK', '--channel', '26146', '--json'],
    { env, stdout: 'pipe', stderr: 'pipe' });
  const first = invoke();
  expect(first.exitCode).toBe(0);
  expect(JSON.parse(new TextDecoder().decode(first.stdout))).toMatchObject({ added: 1, cursor: 301 });
  expect(JSON.parse(new TextDecoder().decode(invoke().stdout))).toMatchObject({ added: 0, cursor: 301 });
  const calls = readFileSync(callsPath, 'utf8').trim().split('\n');
  expect(calls[0]).toBe('api repos/{owner}/{repo}/issues/26146/comments --paginate --jq .[]');
  expect(calls[1]).toContain('since=');
  const db = new MsgStore(f.dbPath);
  expect(db.list('MK')).toHaveLength(1);
  expect(db.list('TC')).toHaveLength(0); // TC's own invocation owns TC's cursor and insertion
  db.close();
});

test('CLI replays a comment created exactly six hours ago through GitHub exclusive since', () => {
  const f = fixture();
  mkdirSync(join(f.root, 'msg'), { recursive: true });
  writeFileSync(f.cursorPath, `${JSON.stringify({ lastId: 200,
    createdAt: '2026-10-12T11:00:00Z', parserHash: '0'.repeat(64) })}\n`);
  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  const gh = join(bin, 'gh');
  writeFileSync(gh, [
    '#!/usr/bin/env bun',
    "import { readFileSync, appendFileSync } from 'node:fs';",
    "const endpoint = process.argv.find((arg) => arg.includes('/comments'));",
    "const since = new URL(endpoint, 'https://example.test').searchParams.get('since');",
    "appendFileSync(process.env.GH_CALLS, String(since) + '\\n');",
    "for (const line of readFileSync(process.env.GH_COMMENTS, 'utf8').trim().split('\\n')) {",
    '  const item = JSON.parse(line);',
    "  if (!since || Date.parse(item.created_at) > Date.parse(since)) process.stdout.write(line + '\\n');",
    '}',
  ].join('\n'));
  chmodSync(gh, 0o755);
  const boundary = comment(198, '**[TC]** → MK · 경계', '2026-10-12T06:00:00Z');
  const old = comment(197, '**[TC]** → MK · 오래됨', '2026-10-12T05:00:00Z');
  const commentsPath = join(f.root, 'comments.jsonl');
  writeFileSync(commentsPath, `${JSON.stringify(old)}\n${JSON.stringify(boundary)}\n`);
  const callsPath = join(f.root, 'calls.txt');
  const clock = join(f.root, 'clock.js');
  writeFileSync(clock, "Date.now = () => Date.parse('2026-10-12T12:00:00Z');\n");
  const env = { ...process.env, ELANOUS_STATE_DIR: f.root, GH_COMMENTS: commentsPath, GH_CALLS: callsPath,
    PATH: `${bin}:${process.env.PATH}` };
  const result = Bun.spawnSync(['bun', '--preload', clock, join(import.meta.dir, 'coord-msg-bridge.ts'),
    '--seat', 'MK', '--channel', '26146', '--json'], { env, stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(new TextDecoder().decode(result.stdout))).toMatchObject({ added: 1, cursor: 200 });
  expect(readFileSync(callsPath, 'utf8').trim()).toBe('2026-10-12T05:59:59.000Z');
  const db = new MsgStore(f.dbPath);
  expect(db.list('MK').map((row) => row.body)).toEqual([boundary.body]);
  db.close();
});
