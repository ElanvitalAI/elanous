import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from './msg-store.js';
import { startMsgSseServer } from './msg-sse-server.js';

const dirs: string[] = [];
setDefaultTimeout(15_000);
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function nextEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<{ id: number; body: string; replyTo?: number }> {
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const boundary = text.indexOf('\n\n');
    if (boundary >= 0) {
      const frame = text.slice(0, boundary);
      text = text.slice(boundary + 2);
      if (!frame.includes('id: ')) continue;
      const id = Number(frame.match(/^id: (\d+)$/m)?.[1]);
      const message = JSON.parse(frame.match(/^data: (.+)$/m)?.[1] ?? '{}');
      return { id, body: message.body, ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }) };
    }
    const read = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSE event timeout')), 3000)),
    ]);
    if (read.done) throw new Error('SSE closed before event');
    text += decoder.decode(read.value);
  }
  throw new Error('SSE event timeout');
}

test('authenticated stream receives a post within one second; missing and wrong tokens get 401', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'msg-sse-'));
  dirs.push(dir);
  const path = join(dir, 'messages.db');
  const store = new MsgStore(path);
  const readOnly = new MsgStore(path, { readOnly: true });
  const service = startMsgSseServer({ store: readOnly, token: 'same-nexus-token', port: 0, pollMs: 100 });
  const url = `http://127.0.0.1:${service.port}/stream?to=TC&since=0`;
  try {
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    const response = await fetch(url, { headers: { Authorization: 'Bearer same-nexus-token' } });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const at = Date.now();
    store.post({ from: 'OP', to: 'TC', body: 'first' });
    expect(await nextEvent(reader)).toEqual({ id: 1, body: 'first' });
    expect(Date.now() - at).toBeLessThan(1000);
    await reader.cancel();
    expect(() => readOnly.post({ from: 'OP', to: 'TC', body: 'forbidden' })).toThrow();
    expect(() => startMsgSseServer({ store: readOnly, token: 'same-nexus-token', port: 0, hostname: '0.0.0.0' })).toThrow('loopback');
  } finally { service.stop(); readOnly.close(); store.close(); }
});

test('group SSE delivery reaches active subscribers only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'msg-sse-group-'));
  dirs.push(dir);
  const path = join(dir, 'messages.db');
  const writer = new MsgStore(path);
  const group = writer.createGroup('release-window', 'OP');
  writer.joinGroup(group, 'TC');
  const message = writer.post({ from: 'OP', to: group, body: 'subscribers only' });
  const readOnly = new MsgStore(path, { readOnly: true });
  const service = startMsgSseServer({ store: readOnly, token: 'same-nexus-token', port: 0, pollMs: 100 });
  const open = async (to: string) => fetch(`http://127.0.0.1:${service.port}/stream?to=${to}&since=0`, {
    headers: { Authorization: 'Bearer same-nexus-token' },
  });
  try {
    const tc = await open('TC');
    const tcReader = tc.body!.getReader();
    expect(await nextEvent(tcReader)).toEqual({ id: message.id, body: 'subscribers only' });
    await tcReader.cancel();
    const ux = await open('UX');
    const uxReader = ux.body!.getReader();
    await uxReader.read(); // connected comment
    const result = await Promise.race([
      uxReader.read().then(() => 'event'),
      new Promise<'quiet'>(resolve => setTimeout(() => resolve('quiet'), 350)),
    ]);
    expect(result).toBe('quiet');
    await uxReader.cancel();
  } finally { service.stop(); readOnly.close(); writer.close(); }
});

test('replayed SSE reply keeps the durable question link', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'msg-sse-thread-'));
  dirs.push(dir);
  const path = join(dir, 'messages.db');
  const writer = new MsgStore(path);
  const question = writer.post({ from: 'OP', to: 'TC', body: 'question' });
  const answer = writer.post({ from: 'TC', to: 'OP', body: 'answer', replyTo: question.id });
  const readOnly = new MsgStore(path, { readOnly: true });
  const service = startMsgSseServer({ store: readOnly, token: 'same-nexus-token', port: 0, pollMs: 100 });
  try {
    const response = await fetch(`http://127.0.0.1:${service.port}/stream?to=OP&since=0`, {
      headers: { Authorization: 'Bearer same-nexus-token' },
    });
    const reader = response.body!.getReader();
    try { expect(await nextEvent(reader)).toEqual({ id: answer.id, body: 'answer', replyTo: question.id }); }
    finally { await reader.cancel(); }
  } finally { service.stop(); readOnly.close(); writer.close(); }
});

test('SSE opened before a legacy migration later replays a linked reply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'msg-sse-legacy-'));
  dirs.push(dir);
  const path = join(dir, 'messages.db');
  const legacy = new Database(path);
  try {
    legacy.exec(`CREATE TABLE msg_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, recipient TEXT NOT NULL,
      body TEXT NOT NULL, kind TEXT, created_at TEXT NOT NULL
    )`);
  } finally { legacy.close(); }
  const readOnly = new MsgStore(path, { readOnly: true });
  const service = startMsgSseServer({ store: readOnly, token: 'same-nexus-token', port: 0, pollMs: 100 });
  let writer: MsgStore | undefined;
  try {
    writer = new MsgStore(path);
    const question = writer.post({ from: 'OP', to: 'TC', body: 'question' });
    const answer = writer.post({ from: 'TC', to: 'OP', body: 'answer', replyTo: question.id });
    const response = await fetch(`http://127.0.0.1:${service.port}/stream?to=OP&since=0`, {
      headers: { Authorization: 'Bearer same-nexus-token' },
    });
    const reader = response.body!.getReader();
    try { expect(await nextEvent(reader)).toEqual({ id: answer.id, body: 'answer', replyTo: question.id }); }
    finally { await reader.cancel(); }
  } finally { service.stop(); readOnly.close(); writer?.close(); }
});

test('restart replays durable messages after Last-Event-ID without losing a post during downtime', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'msg-sse-'));
  dirs.push(dir);
  const path = join(dir, 'messages.db');
  const store = new MsgStore(path);
  let readOnly = new MsgStore(path, { readOnly: true });
  let service = startMsgSseServer({ store: readOnly, token: 'same-nexus-token', port: 0, pollMs: 100 });
  try {
    store.post({ from: 'OP', to: 'TC', body: 'first' });
    const first = await fetch(`http://127.0.0.1:${service.port}/stream?to=TC`, { headers: { Authorization: 'Bearer same-nexus-token' } });
    const reader = first.body!.getReader();
    expect(await nextEvent(reader)).toEqual({ id: 1, body: 'first' });
    await reader.cancel();
    service.stop();
    readOnly.close();
    store.post({ from: 'MK', to: 'TC', body: 'during restart' });
    readOnly = new MsgStore(path, { readOnly: true });
    service = startMsgSseServer({ store: readOnly, token: 'same-nexus-token', port: 0, pollMs: 100 });
    const resumed = await fetch(`http://127.0.0.1:${service.port}/stream?to=TC&since=0`, {
      headers: { Authorization: 'Bearer same-nexus-token', 'Last-Event-ID': '1' },
    });
    const resumedReader = resumed.body!.getReader();
    expect(await nextEvent(resumedReader)).toEqual({ id: 2, body: 'during restart' });
    await resumedReader.cancel();
  } finally { service.stop(); readOnly.close(); store.close(); }
});

test('msg serve CLI opens the isolated ledger read-only and enforces the Nexus token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'msg-sse-cli-'));
  dirs.push(dir);
  const writer = new MsgStore(join(dir, 'msg', 'messages.db'));
  writeFileSync(join(dir, 'acp-token'), 'same-nexus-token', { mode: 0o600 });
  const child = spawn(process.execPath, [join(process.cwd(), 'bin/elanous.mjs'), '--config-dir', dir,
    'msg', 'serve', '--sse', '--port', '0'], { cwd: process.cwd(), env: { ...process.env, ELANOUS_STATE_DIR: dir } });
  let output = '';
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += String(chunk); });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`msg serve startup timeout: ${errors}`)), 10_000);
      child.stdout.on('data', (chunk) => {
        output += String(chunk);
        const match = output.match(/msg SSE listening on 127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
      });
      child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`msg serve exited ${code}: ${errors}`)); });
    });
    const url = `http://127.0.0.1:${port}/stream?to=TC`;
    expect((await fetch(url)).status).toBe(401);
    const response = await fetch(url, { headers: { Authorization: 'Bearer same-nexus-token' } });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    writer.post({ from: 'OP', to: 'TC', body: 'CLI served' });
    expect(await nextEvent(reader)).toEqual({ id: 1, body: 'CLI served' });
    await reader.cancel();
  } finally {
    child.kill('SIGTERM');
    writer.close();
  }
});

test('a paused HTTP reader keeps the server stream queue bounded, then receives every durable ID', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'msg-sse-replay-'));
  dirs.push(dir);
  const path = join(dir, 'messages.db');
  const writer = new MsgStore(path);
  for (let id = 1; id <= 320; id++) writer.post({ from: 'OP', to: 'TC', body: `row ${id}` });
  const readOnly = new MsgStore(path, { readOnly: true });
  const service = startMsgSseServer({ store: readOnly, token: 'same-nexus-token', port: 0, pollMs: 100 });
  try {
    const response = await fetch(`http://127.0.0.1:${service.port}/stream?to=TC&since=0`, {
      headers: { Authorization: 'Bearer same-nexus-token' },
    });
    const reader = response.body!.getReader();
    // Do not call read(): pause the actual HTTP response consumer while replay is active.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(service.stats().subscribers).toBe(1);
    expect(service.stats().maxQueuedEvents).toBeLessThanOrEqual(1);
    const decoder = new TextDecoder();
    let pending = '';
    const ids: number[] = [];
    while (ids.length < 320) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('long replay timeout')), 5000)),
      ]);
      if (chunk.done) throw new Error(`SSE closed after ${ids.length} IDs`);
      pending += decoder.decode(chunk.value);
      let boundary: number;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const id = frame.match(/^id: (\d+)$/m)?.[1];
        if (id) ids.push(Number(id));
      }
    }
    expect(ids).toEqual(Array.from({ length: 320 }, (_, index) => index + 1));
    await reader.cancel();
  } finally { service.stop(); readOnly.close(); writer.close(); }
});
