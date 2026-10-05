import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendSeatRequestRows, closeSeatRequests, listSeatRequests, withSeatRequestLedgerLock } from './seat-request-ledger.js';
import { handleSeatRequests } from '../nexus/api/seat-requests.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'seat-request-ledger-'));
  const directory = join(root, 'seat-requests');
  mkdirSync(directory);
  const path = join(directory, 'requests.jsonl');
  const append = (row: Record<string, unknown>) => appendFileSync(path, `${JSON.stringify(row)}\n`);
  const rows = () => readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  return { root, append, rows, close: () => rmSync(root, { recursive: true, force: true }) };
}

const queuedAt = '2026-10-01T00:00:00.000Z';
const request = (key: string, seat = 'TC', status = 'queued', at = queuedAt) =>
  ({ key, seat, status, text: `work ${key}`, queuedAt: at, evidence: 'original evidence',
    ...(status === 'queued' ? { receiptId: `receipt-${key}` } : { ref: `pwa:${key}` }) });

test('list selects last row per key before seat and status filtering, retaining original request fields', () => {
  const f = fixture();
  try {
    expect(listSeatRequests(f.root)).toEqual([]);
    f.append(request('a'));
    f.append(request('b', 'UX', 'pending'));
    f.append({ ...request('a'), status: 'done', reason: 'completed' });
    f.append(request('c', 'TC', 'pending'));
    expect(listSeatRequests(f.root).map(({ key, status }) => [key, status]))
      .toEqual([['a', 'done'], ['b', 'pending'], ['c', 'pending']]);
    expect(listSeatRequests(f.root, { seat: 'TC', status: 'queued' })).toEqual([]);
    expect(listSeatRequests(f.root, { seat: 'TC', status: 'pending' })).toMatchObject([request('c', 'TC', 'pending')]);
    expect(listSeatRequests(f.root, { status: 'done' })[0]).toMatchObject({ key: 'a', reason: 'completed', evidence: 'original evidence' });
    f.append(request('other', 'research-agent'));
    expect(listSeatRequests(f.root, { seat: 'research-agent' })).toMatchObject([request('other', 'research-agent')]);
    expect(f.rows()).toHaveLength(5);
  } finally { f.close(); }
});

test('close appends one reasoned terminal row per eligible key, and repeats cannot close again', () => {
  const f = fixture();
  try {
    f.append(request('a'));
    f.append(request('b', 'UX', 'pending'));
    f.append(request('done', 'MK', 'done'));
    const before = f.rows();
    const now = new Date('2026-10-05T00:00:00.000Z');
    const result = closeSeatRequests(f.root, ['a', 'a', 'missing', 'done', 'b'], { reason: '  stale work  ', status: 'rejected', now });
    expect(result.map(({ key }) => key)).toEqual(['a', 'b']);
    expect(result).toMatchObject([
      { ...request('a'), status: 'rejected', reason: 'stale work', closedAt: now.toISOString() },
      { ...request('b', 'UX', 'pending'), status: 'rejected', reason: 'stale work', closedAt: now.toISOString() },
    ]);
    expect(result[0]).toHaveProperty('receiptId', 'receipt-a');
    expect(result[0]).toHaveProperty('ref', 'receipt-a');
    expect(result[1]).toHaveProperty('ref', 'pwa:b');
    expect(f.rows().slice(0, 3)).toEqual(before);
    expect(f.rows()).toHaveLength(5);
    expect(closeSeatRequests(f.root, ['a', 'b'], { reason: 'retry', now })).toEqual([]);
    expect(f.rows()).toHaveLength(5);
    expect(listSeatRequests(f.root, { status: 'queued' })).toEqual([]);
    expect(listSeatRequests(f.root, { status: 'rejected' }).map(({ key }) => key)).toEqual(['a', 'b']);
    f.append(request('a', 'TC', 'pending'));
    expect(listSeatRequests(f.root, { status: 'pending' }).map(({ key }) => key)).toEqual(['a']);
    expect(closeSeatRequests(f.root, ['a'], { reason: 'completed', status: 'done', now })).toMatchObject([{ key: 'a', status: 'done' }]);
    expect(listSeatRequests(f.root, { status: 'done' }).map(({ key }) => key)).toEqual(['a', 'done']);
  } finally { f.close(); }
});

test('concurrent closing processes serialize on the journal and preserve a concurrent API request', async () => {
  const f = fixture();
  try {
    f.append(request('same'));
    const modulePath = new URL('./seat-request-ledger.ts', import.meta.url).href;
    const apiPath = new URL('../nexus/api/seat-requests.ts', import.meta.url).href;
    const script = `const [{closeSeatRequests}, {handleSeatRequests}] = await Promise.all([import(${JSON.stringify(modulePath)}), import(${JSON.stringify(apiPath)})]);
      const kind = process.argv.at(-2); const root = process.argv.at(-1);
      if (kind === 'close') closeSeatRequests(root, ['same'], {reason:'concurrent'});
      else { const res = await handleSeatRequests(new Request('http://localhost/v1/seat-requests', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({seat:'TC',text:'new request'})}), {root:()=>root, dispatch:async()=>({reply:'accepted',channel:'posted'})}); if(res.status!==202) throw Error(String(res.status)); }`;
    const child = (kind: string) => Bun.spawn(['bun', '-e', script, kind, f.root], { stdout: 'pipe', stderr: 'pipe' });
    const processes = [child('close'), child('close'), child('request')];
    const results = await Promise.all(processes.map(async (process) => ({ exit: await process.exited, error: await new Response(process.stderr).text() })));
    expect(results).toEqual([{ exit: 0, error: '' }, { exit: 0, error: '' }, { exit: 0, error: '' }]);
    expect(f.rows().filter((row) => row.key === 'same' && row.status === 'rejected')).toHaveLength(1);
    expect(f.rows().filter((row) => row.text === 'new request').map((row) => row.status)).toEqual(['pending', 'queued']);
    expect(f.rows()[0]).toMatchObject(request('same'));
  } finally { f.close(); }
});

test('closing waits for the shared writer lock before re-reading eligibility', async () => {
  const f = fixture();
  try {
    f.append(request('same'));
    const path = join(f.root, 'seat-requests', 'requests.jsonl');
    const modulePath = new URL('./seat-request-ledger.ts', import.meta.url).href;
    const script = `const {closeSeatRequests} = await import(${JSON.stringify(modulePath)});
      closeSeatRequests(process.argv.at(-1), ['same'], {reason:'late close'});`;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    withSeatRequestLedgerLock(path, () => {
      child = Bun.spawn(['bun', '-e', script, f.root], { stdout: 'pipe', stderr: 'pipe' });
      Bun.sleepSync(300);
      appendSeatRequestRows(path, [{ ...request('same'), status: 'done', reason: 'already closed' }]);
    });
    expect(await child!.exited).toBe(0);
    expect(await new Response(child!.stderr as ReadableStream<Uint8Array>).text()).toBe('');
    expect(f.rows().filter((row) => row.key === 'same' && row.status === 'rejected')).toHaveLength(0);
    expect(f.rows()).toHaveLength(2);
  } finally { f.close(); }
});

test('API rechecks a pending key while holding the same lock as close', async () => {
  const f = fixture();
  try {
    const header = 'close-before-API-lock';
    const key = new Bun.CryptoHasher('sha256').update(`client\0${header}`).digest('hex');
    const text = 'pending before lock';
    f.append({ ...request(key, 'TC', 'pending'), text });
    const path = join(f.root, 'seat-requests', 'requests.jsonl');
    const apiPath = new URL('../nexus/api/seat-requests.ts', import.meta.url).href;
    const script = `const {handleSeatRequests} = await import(${JSON.stringify(apiPath)});
      console.log('ready');
      const response = await handleSeatRequests(new Request('http://localhost/v1/seat-requests', {method:'POST',
        headers:{'content-type':'application/json','idempotency-key':${JSON.stringify(header)}},
        body:JSON.stringify({seat:'TC',text:${JSON.stringify(text)}})}),
        {root:()=>process.argv.at(-1),dispatch:async()=>({reply:'accepted',channel:'posted'})});
      console.log(response.status);`;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    withSeatRequestLedgerLock(path, () => {
      child = Bun.spawn(['bun', '-e', script, f.root], { stdout: 'pipe', stderr: 'pipe' });
      Bun.sleepSync(500);
      appendSeatRequestRows(path, [{ ...request(key, 'TC', 'pending'), text, status: 'done', reason: 'closed before write', closedAt: new Date().toISOString() }]);
    });
    expect(await child!.exited).toBe(0);
    expect(await new Response(child!.stdout as ReadableStream<Uint8Array>).text()).toContain('409');
    expect(f.rows().map((row) => row.status)).toEqual(['pending', 'done']);
  } finally { f.close(); }
});

test('a failed partial write preserves the readable old journal and removes the temporary file', () => {
  const f = fixture();
  try {
    f.append(request('original'));
    const path = join(f.root, 'seat-requests', 'requests.jsonl');
    const before = readFileSync(path, 'utf8');
    expect(() => withSeatRequestLedgerLock(path, () => appendSeatRequestRows(path, [request('next')],
      (fd, data, offset) => {
        writeSync(fd, data, offset, 3);
        throw new Error('disk interrupted');
      }))).toThrow('disk interrupted');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(listSeatRequests(f.root).map((row) => row.key)).toEqual(['original']);
    expect(closeSeatRequests(f.root, ['original'], { reason: 'still readable' })).toHaveLength(1);
    expect(f.rows()).toHaveLength(2);
  } finally { f.close(); }
});

test('a killed lock owner releases the journal lock for another writer', async () => {
  const f = fixture();
  try {
    f.append(request('original'));
    const modulePath = new URL('./seat-request-ledger.ts', import.meta.url).href;
    const script = `const {withSeatRequestLedgerLock} = await import(${JSON.stringify(modulePath)});
      withSeatRequestLedgerLock(process.argv.at(-1), () => { console.log('locked'); Bun.sleepSync(30000); });`;
    const child = Bun.spawn(['bun', '-e', script, join(f.root, 'seat-requests', 'requests.jsonl')], { stdout: 'pipe', stderr: 'pipe' });
    try {
      const reader = child.stdout.getReader();
      const signal = await reader.read();
      expect(new TextDecoder().decode(signal.value)).toContain('locked');
      child.kill('SIGKILL');
      await child.exited;
      expect(closeSeatRequests(f.root, ['original'], { reason: 'owner died' })).toHaveLength(1);
      expect(f.rows()).toHaveLength(2);
    } finally { child.kill('SIGKILL'); }
  } finally { f.close(); }
});

test('older-than uses original queuedAt and only closes strictly older rows; dry-run does not write', () => {
  const f = fixture();
  try {
    const now = new Date('2026-10-05T00:00:00.000Z');
    f.append(request('old', 'TC', 'queued', '2026-10-03T23:59:59.999Z'));
    f.append(request('boundary', 'TC', 'queued', '2026-10-04T00:00:00.000Z'));
    f.append(request('new', 'TC', 'pending', '2026-10-04T00:00:00.001Z'));
    f.append(request('invalid', 'TC', 'pending', 'invalid-date'));
    const options = { reason: 'age policy', status: 'done' as const, olderThan: 86_400_000, now };
    expect(closeSeatRequests(f.root, ['old', 'boundary', 'new', 'invalid'], { ...options, dryRun: true }))
      .toMatchObject([{ key: 'old', status: 'done', reason: 'age policy' }]);
    expect(f.rows()).toHaveLength(4);
    expect(closeSeatRequests(f.root, ['old', 'boundary', 'new', 'invalid'], options)).toMatchObject([{ key: 'old', status: 'done' }]);
    expect(f.rows()).toHaveLength(5);
    expect(closeSeatRequests(f.root, ['old'], options)).toEqual([]);
    expect(listSeatRequests(f.root, { status: 'done' }).map(({ key }) => key)).toEqual(['old']);
  } finally { f.close(); }
});

test('PWA journal reader accepts terminal rows and a retry cannot reopen a closed request', async () => {
  const f = fixture();
  try {
    const header = 'reuse';
    const key = new Bun.CryptoHasher('sha256').update(`client\0${header}`).digest('hex');
    const text = 'work for TC';
    f.append({ ...request(key), text, receiptId: `pwa:${key}` });
    const closed = closeSeatRequests(f.root, [key], { reason: 'owner withdrew', status: 'done' });
    expect(closed).toMatchObject([{ status: 'done', reason: 'owner withdrew', ref: `pwa:${key}` }]);
    const deps = { root: () => f.root };
    const listed = await handleSeatRequests(new Request('http://localhost/v1/seat-requests'), deps);
    expect(listed.status).toBe(200);
    expect((await listed.json() as { items: unknown[] }).items).toEqual([]);
    const attempt = await handleSeatRequests(new Request('http://localhost/v1/seat-requests', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'reuse' },
      body: JSON.stringify({ seat: 'TC', text }),
    }), deps);
    expect(attempt.status).toBe(409);
    expect(await attempt.json()).toMatchObject({ error: 'request-closed', status: 'done', reason: 'owner withdrew' });
    expect(f.rows()).toHaveLength(2);
    f.append({ ...request(key, 'TC', 'pending'), text, ref: `pwa:${key}` });
    const closedPending = closeSeatRequests(f.root, [key], { reason: 'withdrawn', status: 'rejected' });
    expect(closedPending).toMatchObject([{ status: 'rejected', closedAt: expect.any(String) }]);
    const retry = await handleSeatRequests(new Request('http://localhost/v1/seat-requests', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': header },
      body: JSON.stringify({ seat: 'TC', text }),
    }), deps);
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ error: 'request-closed', status: 'rejected', reason: 'withdrawn' });
    expect(f.rows()).toHaveLength(4);
  } finally { f.close(); }
});

test('API completion cannot reopen a request closed while dispatch was in flight', async () => {
  const f = fixture();
  try {
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const post = handleSeatRequests(new Request('http://localhost/v1/seat-requests', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'during-dispatch' },
      body: JSON.stringify({ seat: 'TC', text: 'close during dispatch' }),
    }), { root: () => f.root, dispatch: async () => { started(); await wait; return { reply: 'accepted', channel: 'posted' }; } });
    await startedPromise;
    const key = f.rows()[0]!.key as string;
    closeSeatRequests(f.root, [key], { reason: 'withdrawn' });
    release();
    expect((await post).status).toBe(409);
    expect(f.rows().map((row) => row.status)).toEqual(['pending', 'rejected']);
    expect(listSeatRequests(f.root, { status: 'queued' })).toEqual([]);
  } finally { f.close(); }
});

test('invalid close inputs fail without modifying the ledger', () => {
  const f = fixture();
  try {
    f.append(request('a'));
    const before = f.rows();
    expect(() => closeSeatRequests(f.root, ['a'], { reason: '   ' })).toThrow('requires a reason');
    expect(() => closeSeatRequests(f.root, ['a'], { reason: 'ok', status: 'queued' as 'done' })).toThrow('invalid seat request close status');
    expect(() => closeSeatRequests(f.root, ['a'], { reason: 'ok', olderThan: -1 })).toThrow('invalid seat request older-than duration');
    expect(f.rows()).toEqual(before);
  } finally { f.close(); }
});
