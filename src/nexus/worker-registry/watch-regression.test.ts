import { test, expect } from 'bun:test';
import { existsSync, mkdtempSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerRegistryStore } from './store.js';
import { bindWorkerRegistryFront, MAX_WORKER_WATCH_STREAMS } from './api.js';

function setup() {
  const path = join(mkdtempSync(join(tmpdir(), 'watch-regression-')), 'registry.db');
  const store = new WorkerRegistryStore(path);
  return { path, store, front: bindWorkerRegistryFront(store) };
}
const text = (x: Uint8Array | undefined) => new TextDecoder().decode(x);

test('replay to committed other connection live is ordered without duplicates', async () => {
  const { path, store, front } = setup();
  const other = new WorkerRegistryStore(path);
  store.appendEvent({ workerId: 'one', type: 'output' }); // already committed replay
  const reader = front.sseFromLastEventId(null).getReader();
  try {
    other.appendEvent({ workerId: 'two', type: 'output' }); // replay/live boundary
    expect(text((await reader.read()).value)).toContain('id: 1\n');
    expect(text((await reader.read()).value)).toContain('id: 2\n');
    const waiting = reader.read(); // request another event before the next commit
    other.appendEvent({ workerId: 'three', type: 'output' });
    expect(text((await waiting).value)).toContain('id: 3\n');
  } finally { await reader.cancel(); other.close(); store.close(); }
});

test('bad, expired and gapped cursors fail closed', async () => {
  const { store, front } = setup();
  try {
    expect(() => front.sseFromLastEventId('-1')).toThrow();
    expect(() => front.sseFromLastEventId('1e3')).toThrow();
    store.appendEvent({ workerId: 'a', type: 'output' });
    store.appendEvent({ workerId: 'b', type: 'output' });
    store.db.query('DELETE FROM worker_watch WHERE seq = 1').run();
    const expired = front.sseFromLastEventId('1').getReader();
    await expect(expired.read()).rejects.toThrow('expired');
    const gap = front.sseFromLastEventId(null).getReader();
    await expect(gap.read()).rejects.toThrow('gap');
  } finally { store.close(); }
});

test('replacement and oversized frame fail closed', async () => {
  const { path, store, front } = setup();
  store.appendEvent({ workerId: 'x'.repeat(70_000), type: 'output' });
  const oversized = front.sseFromLastEventId(null).getReader();
  await expect(oversized.read()).rejects.toThrow('too large');
  store.close(); // WAL 체크포인트 — 남은 -wal/-shm 없이 교체 시뮬레이션
  renameSync(path, `${path}.old`);
  for (const suffix of ['-wal', '-shm']) {
    const side = `${path}${suffix}`;
    if (existsSync(side)) renameSync(side, `${path}.old${suffix}`);
  }
  const replacement = new WorkerRegistryStore(path);
  try {
    const reader = front.sseFromLastEventId(null).getReader();
    await expect(reader.read()).rejects.toThrow('replaced');
  } finally { replacement.close(); store.close(); }
});

test('stream capacity is shared across fronts and cancellation releases exactly one slot', async () => {
  const { store, front } = setup();
  const otherFront = bindWorkerRegistryFront(store);
  const readers = Array.from({ length: MAX_WORKER_WATCH_STREAMS }, () => front.sseFromLastEventId(null).getReader());
  try {
    expect(() => otherFront.sseFromLastEventId(null)).toThrow('capacity exceeded');
    await readers[0]!.cancel();
    await readers[0]!.cancel();
    readers.push(otherFront.sseFromLastEventId(null).getReader());
    expect(() => front.sseFromLastEventId(null)).toThrow('capacity exceeded');
  } finally { await Promise.all(readers.map(reader => reader.cancel())); store.close(); }
});

test('stream failure releases its slot', async () => {
  const { store, front } = setup();
  const readers = Array.from({ length: MAX_WORKER_WATCH_STREAMS - 1 }, () => front.sseFromLastEventId(null).getReader());
  try {
    const bad = front.sseFromLastEventId('999').getReader();
    await expect(bad.read()).rejects.toThrow('expired');
    readers.push(front.sseFromLastEventId(null).getReader());
    expect(() => front.sseFromLastEventId(null)).toThrow('capacity exceeded');
  } finally { await Promise.all(readers.map(reader => reader.cancel())); store.close(); }
});

test('slow reader retains ordered backlog in database, not an unbounded stream queue', async () => {
  const { store, front } = setup();
  for (let i = 0; i < 200; i++) store.appendEvent({ workerId: String(i), type: 'output' });
  const reader = front.sseFromLastEventId(null).getReader();
  try {
    for (let i = 1; i <= 200; i++) expect(text((await reader.read()).value)).toContain(`id: ${i}\n`);
  } finally { await reader.cancel(); store.close(); }
});

// A separate process commits via SQLite, bypassing the in-process emitter.
test('separate process commits are replayed in order; rollback stays invisible', async () => {
  const { path, store, front } = setup();
  const reader = front.sseFromLastEventId(null).getReader();
  const code = `const { Database } = require('bun:sqlite');
    const db = new Database(process.argv[1]);
    const put = db.query("INSERT INTO worker_watch(worker_id,type,at) VALUES (?, 'output', 'now')");
    db.exec('BEGIN'); put.run('rolled-back'); db.exec('ROLLBACK');
    db.exec('BEGIN'); put.run('first'); put.run('second'); db.exec('COMMIT'); db.close();`;
  try {
    const waiting = reader.read();
    const child = Bun.spawn([process.execPath, '-e', code, path], { stdout: 'pipe', stderr: 'pipe' });
    const error = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(error).toBe('');
    const first = text((await waiting).value);
    const second = text((await reader.read()).value);
    expect(first).toContain('id: 1\n');
    expect(first).toContain('first');
    expect(second).toContain('id: 2\n');
    expect(second).toContain('second');
    expect(store.eventsSince(0).map(e => e.workerId)).toEqual(['first', 'second']);
  } finally { await reader.cancel(); store.close(); }
});

// The draft router is not wired to production HTTP: this adapter exercises the real socket.
test('HTTP cancel, reconnect, concurrent process commits and overflow', async () => {
  const { path, store, front } = setup();
  let cancelled = 0;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) {
    const stream = front.sseFromLastEventId(req.headers.get('last-event-id'));
    const reader = stream.getReader();
    return new Response(new ReadableStream({
      async pull(c) { try { const r = await reader.read(); if (r.done) c.close(); else c.enqueue(r.value); } catch (e) { c.error(e); } },
      async cancel() { cancelled++; await reader.cancel(); },
    }), { headers: { 'content-type': 'text/event-stream' } });
  }});
  const url = `http://127.0.0.1:${server.port}/v1/worker-watch`;
  const abort = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const frame = async (r: ReadableStreamDefaultReader<Uint8Array>) => {
    let data = '';
    while (!data.includes('\n\n')) { const v = await r.read(); if (v.done) throw new Error('early EOF'); data += text(v.value); }
    return data;
  };
  const writer = `const {Database}=require('bun:sqlite'); const db=new Database(process.argv[1]);
    db.exec('PRAGMA busy_timeout=5000'); const put=db.query("INSERT INTO worker_watch(worker_id,type,at) VALUES (?, 'output', 'now')");
    for(let i=0;i<10;i++) put.run(process.argv[2]+'-'+i); db.close();`;
  try {
    store.appendEvent({ workerId: 'replay', type: 'output' });
    const response = await fetch(url, { signal: abort.signal });
    expect(response.status).toBe(200);
    reader = response.body!.getReader();
    expect(await frame(reader)).toContain('id: 1\n');
    abort.abort();
    const deadline = Date.now() + 3000;
    while (!cancelled && Date.now() < deadline) await Bun.sleep(10);
    expect(cancelled).toBe(1);
    const children = ['a','b'].map(id => Bun.spawn([process.execPath, '-e', writer, path, id], { stdout: 'ignore', stderr: 'pipe' }));
    for (const child of children) { const err = await new Response(child.stderr).text(); expect(err).toBe(''); expect(await child.exited).toBe(0); }
    const next = await fetch(url, { headers: { 'Last-Event-ID': '1' } });
    reader = next.body!.getReader();
    // HTTP may coalesce multiple SSE frames; parse the byte stream rather than chunks.
    let received = '';
    while ((received.match(/id: /g) ?? []).length < 20) {
      const v = await reader.read(); if (v.done) throw new Error('early EOF'); received += text(v.value);
    }
    const ids = [...received.matchAll(/id: (\d+)/g)].map(x => Number(x[1]));
    expect(ids).toEqual(Array.from({ length: 20 }, (_, i) => i + 2));
    await reader.cancel(); reader = undefined;
    store.appendEvent({ workerId: 'x'.repeat(70_000), type: 'output' });
    const over = await fetch(url, { headers: { 'Last-Event-ID': '20' } });
    const overflowReader = over.body!.getReader();
    // The server must terminate, never emit a truncated oversized frame as success.
    let output = ''; try { for (;;) { const r = await overflowReader.read(); if (r.done) break; output += text(r.value); } } catch {}
    expect(output).not.toContain('id: 22');
  } finally { abort.abort(); await reader?.cancel().catch(() => {}); server.stop(true); store.close(); }
}, 15000);
