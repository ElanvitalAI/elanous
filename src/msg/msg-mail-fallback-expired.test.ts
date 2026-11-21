import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from './msg-store.js';
import { mailReceived, runMailFallback } from './msg-mail-fallback.js';

test('read-only legacy ledger without receipt table remains readable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-legacy-'));
  const path = join(dir, 'messages.db');
  try {
    const store = new MsgStore(path);
    const message = store.post({ from: 'OP', to: 'HAND-X', body: 'legacy' });
    store.close();
    const legacy = new Database(path);
    legacy.exec('DROP TABLE msg_receipts');
    legacy.close();
    const reader = new MsgStore(path, { readOnly: true });
    try { expect(mailReceived(reader, message.id, 'HAND-X')).toBe(false); }
    finally { reader.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('receipt history gives seen priority over expired without an ack row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-mixed-'));
  const path = join(dir, 'messages.db');
  try {
    const store = new MsgStore(path);
    const message = store.post({ from: 'OP', to: 'HAND-X', body: 'mixed' });
    const insert = store.db.query("INSERT INTO msg_receipts (message_id, recipient, state, at, source) VALUES (?, 'HAND-X', ?, ?, 'plan')");
    insert.run(message.id, 'expired', new Date().toISOString());
    insert.run(message.id, 'seen', new Date().toISOString());
    expect(mailReceived(store, message.id, 'hand-x')).toBe(true);
    store.close();
    let knocks = 0;
    expect(await runMailFallback({ messageId: message.id, recipient: 'hand-x', from: 'OP' }, {
      openStore: () => new MsgStore(path), sleep: async () => {},
      wake: async () => { knocks++; return { result: 'injected' }; },
    })).toBe('received');
    expect(knocks).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('two fallback checks in one process claim only one wake', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-concurrent-'));
  const path = join(dir, 'messages.db');
  try {
    const store = new MsgStore(path);
    const message = store.post({ from: 'OP', to: 'HAND-X', body: 'pending' });
    store.close();
    let knocks = 0;
    const deps = { openStore: () => new MsgStore(path), sleep: async () => {},
      wake: async () => { knocks++; return { result: 'injected' }; } };
    const input = { messageId: message.id, recipient: 'HAND-X', from: 'OP' };
    expect((await Promise.all([runMailFallback(input, deps), runMailFallback(input, deps)])).sort()).toEqual(['already-knocked', 'knocked']);
    expect(knocks).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('independent fallback processes produce one claim and one wake', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-process-race-'));
  const path = join(dir, 'messages.db');
  const children: ReturnType<typeof Bun.spawn>[] = [];
  let locker: Database | undefined;
  const waitFor = async (condition: () => boolean, label: string) => {
    const deadline = Date.now() + 5000;
    while (!condition()) {
      for (const child of children) {
        if (child.exitCode !== null) {
          const stderr = await new Response(child.stderr as ReadableStream).text();
          throw new Error(`worker exited ${child.exitCode} waiting for ${label}: ${stderr}`);
        }
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await Bun.sleep(10);
    }
  };
  try {
    const store = new MsgStore(path);
    // WAL prevents transient constructor reads from blocking the parent's lock release.
    store.db.exec('PRAGMA journal_mode = WAL');
    const message = store.post({ from: 'OP', to: 'HAND-X', body: 'pending' });
    store.close();
    // Both children open their own SQLite connection before the start barrier.
    // The parent holds a write lock until both openStore markers appear; these
    // markers do not establish that either child has attempted a SQLite write.
    const script = `
      import { writeFileSync, existsSync, appendFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { MsgStore } from ${JSON.stringify(join(import.meta.dir, 'msg-store.js'))};
      import { runMailFallback } from ${JSON.stringify(join(import.meta.dir, 'msg-mail-fallback.js'))};
      const { DIR: dir, DB: path, ID: id, WORKER: worker } = process.env;
      const store = new MsgStore(path, { busyTimeoutMs: 5000 });
      const result = await runMailFallback({ messageId: Number(id), recipient: worker === '0' ? 'HAND-X' : 'hand-x', from: 'OP' }, {
        sleep: async () => {
          writeFileSync(join(dir, 'ready-' + worker), String(process.pid));
          while (!existsSync(join(dir, 'release'))) await Bun.sleep(5);
        },
        openStore: () => { writeFileSync(join(dir, 'attempt-' + worker), ''); return store; },
        wake: async () => { appendFileSync(join(dir, 'wakes'), worker + '\\n'); return { result: 'injected' }; },
      });
      console.log(result);
    `;
    for (let i = 0; i < 2; i++) {
      children.push(Bun.spawn([process.execPath, '-e', script], {
        env: { ...process.env, DIR: dir, DB: path, ID: String(message.id), WORKER: String(i) },
        stdout: 'pipe', stderr: 'pipe',
      }));
    }
    await waitFor(() => [0, 1].every(i => existsSync(join(dir, `ready-${i}`))), 'both workers ready');
    expect(readFileSync(join(dir, 'ready-0'), 'utf8')).not.toBe(readFileSync(join(dir, 'ready-1'), 'utf8'));
    locker = new Database(path);
    locker.exec('BEGIN IMMEDIATE');
    writeFileSync(join(dir, 'release'), '');
    await waitFor(() => [0, 1].every(i => existsSync(join(dir, `attempt-${i}`))), 'both openStore markers');
    await Bun.sleep(100);
    expect(children.map(child => child.exitCode)).toEqual([null, null]);
    locker.exec('COMMIT');
    locker.close();
    locker = undefined;
    const outputs = await Promise.all(children.map(async child => ({
      stdout: await new Response(child.stdout as ReadableStream).text(),
      stderr: await new Response(child.stderr as ReadableStream).text(),
      code: await child.exited,
    })));
    expect(outputs.map(o => ({ code: o.code, stderr: o.stderr }))).toEqual([{ code: 0, stderr: '' }, { code: 0, stderr: '' }]);
    expect(outputs.map(o => o.stdout.trim()).sort()).toEqual(['already-knocked', 'knocked']);
    const winner = outputs.findIndex(o => o.stdout.trim() === 'knocked');
    expect(readFileSync(join(dir, 'wakes'), 'utf8')).toBe(`${winner}\n`);
    const reader = new Database(path, { readonly: true });
    try { expect(reader.query('SELECT count(*) AS n FROM msg_mail_fallbacks WHERE message_id = ?').get(message.id)).toEqual({ n: 1 }); }
    finally { reader.close(); }
  } finally {
    if (locker) { locker.exec('ROLLBACK'); locker.close(); }
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map(child => child.exited));
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

test('expiry beyond the first 1000 receipt rows suppresses the fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-expired-many-'));
  const path = join(dir, 'messages.db');
  try {
    const store = new MsgStore(path);
    const message = store.post({ from: 'OP', to: 'ALL', body: 'many receipts' });
    const insert = store.db.query("INSERT INTO msg_receipts (message_id, recipient, state, at, source) VALUES (?, ?, 'delivered', ?, 'tui-queue')");
    store.db.transaction(() => {
      for (let i = 0; i < 1001; i++) insert.run(message.id, `OTHER-${i}`, new Date().toISOString());
    })();
    store.recordReceipt({ messageId: message.id, recipient: 'HAND-X', state: 'expired', source: 'plan' });
    store.close();
    let knocks = 0;
    expect(await runMailFallback({ messageId: message.id, recipient: 'HAND-X', from: 'OP' }, {
      openStore: () => new MsgStore(path), sleep: async () => {},
      wake: async () => { knocks++; return { result: 'injected' }; },
    })).toBe('expired');
    expect(knocks).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('expired alone ends fallback without claiming receipt; seen before expiry is received', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-expired-'));
  const path = join(dir, 'messages.db');
  try {
    const store = new MsgStore(path);
    const expired = store.post({ from: 'OP', to: 'HAND-X', body: 'expired' });
    const seen = store.post({ from: 'OP', to: 'HAND-X', body: 'seen' });
    store.recordReceipt({ messageId: expired.id, recipient: 'HAND-X', state: 'expired', source: 'plan' });
    store.recordReceipt({ messageId: seen.id, recipient: 'HAND-X', state: 'seen', source: 'plan' });
    expect(store.recordReceipt({ messageId: seen.id, recipient: 'HAND-X', state: 'expired', source: 'plan' }).recorded).toBe(false);
    expect(store.listReceipts({ messageId: seen.id }).map(r => r.state)).toEqual(['posted', 'seen']);
    expect(mailReceived(store, expired.id, 'HAND-X')).toBe(false);
    expect(mailReceived(store, seen.id, 'HAND-X')).toBe(true);
    store.close();
    const knocks: number[] = [];
    const deps = { openStore: () => new MsgStore(path), sleep: async () => {}, wake: async (_to: string, id: number) => { knocks.push(id); return { result: 'injected' }; } };
    expect(await runMailFallback({ messageId: expired.id, recipient: 'HAND-X', from: 'OP' }, deps)).toBe('expired');
    expect(await runMailFallback({ messageId: expired.id, recipient: 'hand-x', from: 'OP' }, deps)).toBe('expired');
    expect(await runMailFallback({ messageId: seen.id, recipient: 'HAND-X', from: 'OP' }, deps)).toBe('received');
    expect(knocks).toEqual([]);
    const reader = new MsgStore(path, { readOnly: true });
    try {
      expect(reader.listReceipts({ messageId: expired.id }).map(r => r.state)).toEqual(['posted', 'expired']);
      const claimTable = reader.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'msg_mail_fallbacks'").get();
      if (claimTable) expect(reader.db.query('SELECT count(*) AS n FROM msg_mail_fallbacks WHERE message_id = ?').get(expired.id)).toEqual({ n: 0 });
    } finally { reader.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
