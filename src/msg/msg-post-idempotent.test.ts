/**
 * ELN-MSG-POST-IDEMPOTENT — real SQLite files in a temp dir. The CLI runs through `registerMsgCommands` (the
 * `msg post` action itself); concurrency uses two real Bun processes on the same file. No real ledger is touched.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { MsgStore } from './msg-store.js';
import { registerMsgCommands } from '../cli/msg-cli.js';
import { dispatchMsgPost } from '../skills/tools/ops-ledger.js';

// Two real Bun child processes can exceed the 5 s default under gate load (same headroom as msg-cli.test.ts).
setDefaultTimeout(60_000);

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'msg-idem-'));
  dirs.push(dir);
  return dir;
}

function rows(path: string): Array<{ id: number; recipient: string; body: string }> {
  const db = new Database(path, { readonly: true });
  try { return db.query('SELECT id, recipient, body FROM msg_messages ORDER BY id').all() as Array<{ id: number; recipient: string; body: string }>; }
  finally { db.close(); }
}

function cli(dir: string, openStore: () => MsgStore) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  const program = new Command();
  registerMsgCommands(program, {
    openStore,
    out: { log: line => stdout.push(line), error: line => stderr.push(line) },
    readStdin: async () => '',
    setExitCode: code => exits.push(code),
    registerLogSink: async () => undefined,
    wake: async (address, msgId) => ({ wake: 'none', source: 'unresolved', address, msgId, result: 'skipped-test-universe' }),
    postOfficeStateRoot: dir,
  });
  return { stdout, stderr, exits, run: (...args: string[]) => program.parseAsync(['msg', 'post', ...args], { from: 'user' }) };
}

/** A real store whose close() fails the way a busy ledger does — after the write already committed. */
class LockedOnCloseStore extends MsgStore {
  override close(): void {
    super.close();
    throw new Error('database is locked');
  }
}

test('a lock that hits after the commit is reported as success with the stored id — exactly one row', async () => {
  const dir = tempDir();
  const path = join(dir, 'messages.db');
  const c = cli(dir, () => new LockedOnCloseStore(path));
  await c.run('--from', 'JUD', '--to', 'OP', '--body', 'report that quotes «database is locked»');
  expect(c.exits).toEqual([]);
  expect(c.stdout).toHaveLength(1);
  expect(c.stdout[0]).toMatch(/^#1 \S+ JUD → OP · 41 bytes$/);
  expect(rows(path)).toEqual([{ id: 1, recipient: 'OP', body: 'report that quotes «database is locked»' }]);
});

test('the human success line never echoes the body (a scan for an error word cannot find it in the message)', async () => {
  const dir = tempDir();
  const path = join(dir, 'messages.db');
  const c = cli(dir, () => new MsgStore(path));
  await c.run('--from', 'JUD', '--to', 'OP', '--body', 'SQLite said: database is locked');
  expect(c.exits).toEqual([]);
  expect([...c.stdout, ...c.stderr].join('\n')).not.toContain('locked');
});

test('a retried identical post returns the stored id, flagged deduped — no new row; --no-dedupe stores again', async () => {
  const dir = tempDir();
  const path = join(dir, 'messages.db');
  const c = cli(dir, () => new MsgStore(path));
  await c.run('--from', 'JUD', '--to', 'OP', '--body', '13:02 report');
  await c.run('--from', 'JUD', '--to', 'OP', '--body', '13:02 report');
  await c.run('--from', 'JUD', '--to', 'OP', '--body', '13:02 report', '--json');
  expect(c.exits).toEqual([]);
  expect(c.stdout[1]).toMatch(/^#1 \S+ JUD → OP · 12 bytes · deduped: already stored within the dedupe window/);
  expect(JSON.parse(c.stdout[2]!)).toMatchObject({ id: 1, deduped: true });
  expect(rows(path).map(row => row.id)).toEqual([1]);
  await c.run('--from', 'JUD', '--to', 'OP', '--body', '13:02 report', '--no-dedupe');
  expect(rows(path).map(row => row.id)).toEqual([1, 2]);
});

test('two processes posting the same message at the same instant leave one row; one of them is deduped', async () => {
  const dir = tempDir();
  const path = join(dir, 'messages.db');
  new MsgStore(path).close(); // schema exists before the race
  const script = join(dir, 'post.ts');
  writeFileSync(script, [
    `import { MsgStore } from ${JSON.stringify(join(import.meta.dir, 'msg-store.ts'))};`,
    'const startAt = Number(process.argv[2]);',
    'while (Date.now() < startAt) await Bun.sleep(1);',
    `const store = new MsgStore(${JSON.stringify(path)});`,
    "const posted = store.post({ from: 'JUD', to: 'OP', body: 'same instant' }, { dedupe: true });",
    'store.close();',
    'console.log(JSON.stringify({ id: posted.id, deduped: posted.deduped === true }));',
  ].join('\n'));
  const startAt = String(Date.now() + 1_500);
  const env = { ...process.env, ELANOUS_STATE_DIR: dir };
  const children = [0, 1].map(() => Bun.spawn([process.execPath, script, startAt], { env, stdout: 'pipe', stderr: 'pipe' }));
  const results = await Promise.all(children.map(async child => {
    const text = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    return JSON.parse(text.trim().split('\n').at(-1)!) as { id: number; deduped: boolean };
  }));
  expect(results.map(result => result.id)).toEqual([1, 1]);
  expect(results.filter(result => result.deduped)).toHaveLength(1);
  expect(rows(path).map(row => row.body)).toEqual(['same instant']);
});

test('the same body after the window is a new message (a periodic report still goes through)', async () => {
  const dir = tempDir();
  const path = join(dir, 'messages.db');
  const store = new MsgStore(path, { dedupeWindowMs: 50 });
  try {
    const first = store.post({ from: 'JUD', to: 'OP', body: 'hourly: 🟢 +0' }, { dedupe: true });
    await Bun.sleep(80);
    const second = store.post({ from: 'JUD', to: 'OP', body: 'hourly: 🟢 +0' }, { dedupe: true });
    expect([first.id, second.id]).toEqual([1, 2]);
    expect([first.deduped, second.deduped]).toEqual([undefined, undefined]);
  } finally { store.close(); }
});

test('a different recipient or body is a separate message', () => {
  const dir = tempDir();
  const path = join(dir, 'messages.db');
  const store = new MsgStore(path);
  try {
    const ids = [
      store.post({ from: 'JUD', to: 'OP', body: 'A' }, { dedupe: true }),
      store.post({ from: 'JUD', to: 'REL', body: 'A' }, { dedupe: true }),
      store.post({ from: 'JUD', to: 'OP', body: 'B' }, { dedupe: true }),
    ];
    expect(ids.map(message => [message.id, message.deduped ?? false])).toEqual([[1, false], [2, false], [3, false]]);
  } finally { store.close(); }
  expect(rows(path).map(row => `${row.recipient}:${row.body}`)).toEqual(['OP:A', 'REL:A', 'OP:B']);
});

test('a ledger from before the key column: migrated, old rows keep NULL and still collapse a retry by body', () => {
  const dir = tempDir();
  const path = join(dir, 'messages.db');
  const old = new Database(path);
  old.exec(`CREATE TABLE msg_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, recipient TEXT NOT NULL,
    body TEXT NOT NULL, kind TEXT, reply_to INTEGER, created_at TEXT NOT NULL, provenance_json TEXT)`);
  old.query('INSERT INTO msg_messages(sender, recipient, body, created_at) VALUES (?, ?, ?, ?)')
    .run('JUD', 'OP', 'posted by the old binary', new Date().toISOString());
  old.close();
  const store = new MsgStore(path);
  try {
    const retried = store.post({ from: 'JUD', to: 'OP', body: 'posted by the old binary' }, { dedupe: true });
    expect([retried.id, retried.deduped]).toEqual([1, true]);
  } finally { store.close(); }
  const db = new Database(path, { readonly: true });
  try {
    expect(db.query('SELECT id, body_sha256 FROM msg_messages').all()).toEqual([{ id: 1, body_sha256: null }]);
  } finally { db.close(); }
});

test('a real lock before the commit is an honest failure with zero new rows', async () => {
  const dir = tempDir();
  const path = join(dir, 'messages.db');
  new MsgStore(path).close();
  const holder = new Database(path);
  holder.exec('BEGIN IMMEDIATE');
  try {
    const c = cli(dir, () => new MsgStore(path, { busyTimeoutMs: 50 }));
    await c.run('--from', 'JUD', '--to', 'OP', '--body', 'blocked before commit');
    expect(c.exits).toEqual([2]);
    expect(c.stderr.at(-1)).toBe('msg: database is locked');
    expect(c.stdout).toEqual([]);
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  expect(rows(path)).toEqual([]);
});

test('the MsgPost tool uses the same key: a retry returns the stored id and says deduped', async () => {
  const dir = tempDir();
  const path = join(dir, 'messages.db');
  const first = await dispatchMsgPost({ from: 'JUD', to: 'OP', body: 'tool report' }, { openStore: () => new MsgStore(path) });
  const again = await dispatchMsgPost({ from: 'JUD', to: 'OP', body: 'tool report' }, { openStore: () => new MsgStore(path) });
  expect(first.output).toBe('MsgPost #1 JUD → OP');
  expect(again.output).toBe('MsgPost #1 JUD → OP · deduped: already stored, no new row');
  expect(rows(path)).toHaveLength(1);
});

// ── #38516 r2 must-fixes (remote-terra-38516-38516-3a6c846c8dd4.json) ──

/** Two real Bun processes post the same envelope at the same instant; returns their {id, deduped}. */
async function racePost(dir: string, path: string, setup: string, envelope: string) {
  const script = join(dir, 'race.ts');
  writeFileSync(script, [
    `import { MsgStore } from ${JSON.stringify(join(import.meta.dir, 'msg-store.ts'))};`,
    'const startAt = Number(process.argv[2]);',
    'while (Date.now() < startAt) await Bun.sleep(1);',
    `const store = new MsgStore(${JSON.stringify(path)});`,
    `const posted = store.post(${envelope}, { dedupe: true });`,
    'store.close();',
    'console.log(JSON.stringify({ id: posted.id, deduped: posted.deduped === true }));',
  ].join('\n'));
  const s = new MsgStore(path);
  try { new Function('store', setup)(s); } finally { s.close(); }
  const startAt = String(Date.now() + 1_500);
  const children = [0, 1].map(() => Bun.spawn([process.execPath, script, startAt], { env: { ...process.env, ELANOUS_STATE_DIR: dir }, stdout: 'pipe', stderr: 'pipe' }));
  return Promise.all(children.map(async child => {
    const text = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    return JSON.parse(text.trim().split('\n').at(-1)!) as { id: number; deduped: boolean };
  }));
}

test('r2 MF1: a group: address — two processes retrying the same send leave ONE row, one deduped', async () => {
  const dir = tempDir();
  const path = join(dir, 'messages.db');
  const results = await racePost(dir, path, "store.createGroup('crew', 'OP');", "{ from: 'JUD', to: 'group:crew', body: 'group retry' }");
  expect(results.map(r => r.id)).toEqual([1, 1]);
  expect(results.filter(r => r.deduped)).toHaveLength(1);
  expect(rows(path).map(row => [row.recipient, row.body])).toEqual([['group:crew', 'group retry']]);
});

test('r2 MF1: ALL — two processes retrying the same broadcast leave ONE row and spend ONE budget slot', async () => {
  const dir = tempDir();
  const path = join(dir, 'messages.db');
  const results = await racePost(dir, path, '', "{ from: 'JUD', to: 'ALL', body: 'broadcast retry' }");
  expect(results.map(r => r.id)).toEqual([1, 1]);
  expect(results.filter(r => r.deduped)).toHaveLength(1);
  expect(rows(path).map(row => [row.recipient, row.body])).toEqual([['ALL', 'broadcast retry']]);
  const db = new Database(path, { readonly: true });
  try { expect(db.query('SELECT broadcast_count FROM msg_group_all_budget').all()).toEqual([{ broadcast_count: 1 }]); }
  finally { db.close(); }
});

test('r2 MF2: a TA follow-up failure after the commit is a warning with the stored id — not exit 2', async () => {
  const dir = tempDir();
  const path = join(dir, 'messages.db');
  const stdout: string[] = []; const stderr: string[] = []; const exits: number[] = [];
  const program = new Command();
  let opens = 0;
  registerMsgCommands(program, {
    // The post's own open succeeds; the TA follow-up's re-open fails (the ledger went away after the commit).
    openStore: () => { opens += 1; if (opens > 1) throw new Error('ledger reopen failed'); return new MsgStore(path); },
    out: { log: line => stdout.push(line), error: line => stderr.push(line) },
    readStdin: async () => '',
    setExitCode: code => exits.push(code),
    registerLogSink: async () => undefined,
    wake: async (address, msgId) => ({ wake: 'none', source: 'unresolved', address, msgId, result: 'skipped-test-universe' }),
    postOfficeStateRoot: dir,
    readCard: () => ({ id: 'ta-20261118-abc123', status: 'launched' as const, runId: 'run-1', text: 't', createdAt: '2026-11-18T00:00:00.000Z', history: [] }),
  });
  await program.parseAsync(['msg', 'post', '--from', 'OP', '--to', 'TA', '--body', 'status ta-20261118-abc123'], { from: 'user' });
  expect(exits).toEqual([]);
  expect(stdout[0]).toMatch(/^#1 \S+ OP → TA · 25 bytes$/);
  expect(stderr).toContain('msg post: #1 stored; the TA follow-up failed: ledger reopen failed (do not resend — it would be a second message; the request is #1)');
  expect(rows(path).map(row => row.body)).toEqual(['status ta-20261118-abc123']);
});

/** A store whose post() commits and then throws — the ambiguous «lock around COMMIT» shape. */
class ThrowAfterCommitStore extends MsgStore {
  override post(...args: Parameters<MsgStore['post']>): ReturnType<MsgStore['post']> {
    super.post(...args);
    throw new Error('database is locked');
  }
}
/** A store whose post() throws WITHOUT storing anything. */
class ThrowBeforeCommitStore extends MsgStore {
  override post(): ReturnType<MsgStore['post']> { throw new Error('database is locked'); }
}

test('r2 MF3: --no-dedupe + an older identical row + a failed write → honest failure, zero new rows (the old row does not stand in)', async () => {
  const dir = tempDir();
  const path = join(dir, 'messages.db');
  const seed = new MsgStore(path);
  try { seed.post({ from: 'JUD', to: 'OP', body: 'same words' }); } finally { seed.close(); }
  const c = cli(dir, () => new ThrowBeforeCommitStore(path));
  await c.run('--from', 'JUD', '--to', 'OP', '--body', 'same words', '--no-dedupe');
  expect(c.exits).toEqual([2]);
  expect(c.stdout).toEqual([]);
  expect(rows(path).map(row => row.id)).toEqual([1]);
});

test('r2 MF3: a commit identified by its attempt token + a lock after it → success with THAT row', async () => {
  const dir = tempDir();
  const path = join(dir, 'messages.db');
  const c = cli(dir, () => new ThrowAfterCommitStore(path));
  await c.run('--from', 'JUD', '--to', 'OP', '--body', 'landed then locked', '--no-dedupe');
  expect(c.exits).toEqual([]);
  expect(c.stdout[0]).toMatch(/^#1 \S+ JUD → OP · 18 bytes$/);
  expect(rows(path).map(row => row.body)).toEqual(['landed then locked']);
});

test('r2 MF3: the MsgPost tool recovers only its own attempt — an older identical row with a failed write is a failure', async () => {
  const dir = tempDir();
  const path = join(dir, 'messages.db');
  const seed = new MsgStore(path);
  try { seed.post({ from: 'JUD', to: 'OP', body: 'tool words' }); } finally { seed.close(); }
  await expect(dispatchMsgPost({ from: 'JUD', to: 'OP', body: 'tool words' }, { openStore: () => new ThrowBeforeCommitStore(path) })).rejects.toThrow('database is locked');
  expect(rows(path).map(row => row.id)).toEqual([1]);
});

test('r2 MF4: --origin-key is idempotent by its key (explicit contract) — a retry returns the stored row, a new key stores again', async () => {
  const dir = tempDir();
  const path = join(dir, 'messages.db');
  const c = cli(dir, () => new MsgStore(path));
  await c.run('--from', 'OP', '--to', 'MK', '--body', 'keyed', '--origin-key', 'coord:41:MK');
  await c.run('--from', 'OP', '--to', 'MK', '--body', 'keyed', '--origin-key', 'coord:41:MK');
  await c.run('--from', 'OP', '--to', 'MK', '--body', 'keyed', '--origin-key', 'coord:42:MK');
  expect(c.exits).toEqual([]);
  expect(rows(path).map(row => row.id)).toEqual([1, 2]);
  expect(c.stdout.map(line => line.split(' ')[0])).toEqual(['#1', '#1', '#2']);
});

/** appendWithProvenance commits and then throws — the ambiguous write on the --origin-key path. */
class KeyedThrowAfterCommitStore extends MsgStore {
  override appendWithProvenance(...args: Parameters<MsgStore['appendWithProvenance']>): ReturnType<MsgStore['appendWithProvenance']> {
    super.appendWithProvenance(...args);
    throw new Error('database is locked');
  }
}

test('r2 MF4: --origin-key + a lock after the commit → recovered by the key, success with the stored row (no exit 2, no resend)', async () => {
  const dir = tempDir();
  const path = join(dir, 'messages.db');
  const c = cli(dir, () => new KeyedThrowAfterCommitStore(path));
  await c.run('--from', 'OP', '--to', 'MK', '--body', 'keyed then locked', '--origin-key', 'coord:43:MK');
  expect(c.exits).toEqual([]);
  expect(c.stdout[0]).toMatch(/^#1 \S+ OP → MK · 17 bytes$/);
  expect(rows(path).map(row => row.body)).toEqual(['keyed then locked']);
});

test('r2 MF4 neighbour: a validation refusal on --origin-key (recipient mismatch) is NOT recovered by the key — exit 2', async () => {
  const dir = tempDir();
  const path = join(dir, 'messages.db');
  const c = cli(dir, () => new MsgStore(path));
  await c.run('--from', 'OP', '--to', 'MK', '--body', 'first', '--origin-key', 'coord:44:MK');
  await c.run('--from', 'OP', '--to', 'UX', '--body', 'wrong target', '--origin-key', 'coord:44:MK');
  expect(c.exits).toEqual([2]);
  expect(c.stderr.at(-1)).toBe('msg: provenance recipient does not match message recipient');
  expect(rows(path).map(row => row.body)).toEqual(['first']);
});

// ── #38516 r3 must-fixes (remote-terra-38516-38516-1313ce4e94cb.json) ──

/** appendWithProvenance throws BEFORE storing or validating — the lock hits ahead of the recipient check. */
class KeyedThrowBeforeCommitStore extends MsgStore {
  override appendWithProvenance(): ReturnType<MsgStore['appendWithProvenance']> { throw new Error('database is locked'); }
}

test('r3 MF2: --origin-key + a lock before validation + the key already stored for ANOTHER recipient → exit 2, not that row', async () => {
  const dir = tempDir();
  const path = join(dir, 'messages.db');
  const seed = new MsgStore(path);
  try { seed.appendWithProvenance({ from: 'OP', to: 'MK', body: 'for MK' }, 'coord:45:MK'); } finally { seed.close(); }
  const c = cli(dir, () => new KeyedThrowBeforeCommitStore(path));
  await c.run('--from', 'OP', '--to', 'UX', '--body', 'for UX', '--origin-key', 'coord:45:MK');
  expect(c.exits).toEqual([2]);
  expect(c.stdout).toEqual([]);
  expect(rows(path).map(row => row.body)).toEqual(['for MK']);
});

test('r3 MF2: --origin-key + a lock before the write + the key stored for the SAME sender → recipient → recovered', async () => {
  const dir = tempDir();
  const path = join(dir, 'messages.db');
  const seed = new MsgStore(path);
  try { seed.appendWithProvenance({ from: 'OP', to: 'MK', body: 'same send' }, 'coord:46:MK'); } finally { seed.close(); }
  const c = cli(dir, () => new KeyedThrowBeforeCommitStore(path));
  await c.run('--from', 'OP', '--to', 'MK', '--body', 'same send', '--origin-key', 'coord:46:MK');
  expect(c.exits).toEqual([]);
  expect(c.stdout[0]).toMatch(/^#1 \S+ OP → MK · 9 bytes$/);
  expect(rows(path).map(row => row.id)).toEqual([1]);
});

test('SEAT-MAIL #16: no origin-key, same body twice → 1 row, counter 2 on the first row, reason returned and printed', async () => {
  const dir = tempDir();
  const path = join(dir, 'messages.db');
  const c = cli(dir, () => new MsgStore(path));
  await c.run('--from', 'JUD', '--to', 'OP', '--body', 'gate 🟢 +0');
  await c.run('--from', 'JUD', '--to', 'OP', '--body', '  gate 🟢   +0 ');
  expect(c.exits).toEqual([]);
  expect(rows(path).map(row => row.id)).toEqual([1]);
  expect(c.stdout[1]).toContain('suppressed as repeat of #1 (×2 · same sender/body/evidence sha/meta within 30 min · no new row)');
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query('SELECT repeat_count, last_repeat_at FROM msg_messages WHERE id = 1').get() as { repeat_count: number; last_repeat_at: string | null };
    expect(row.repeat_count).toBe(2);
    expect(typeof row.last_repeat_at).toBe('string');
  } finally { db.close(); }
  const store = new MsgStore(path);
  try {
    const third = store.post({ from: 'JUD', to: 'OP', body: 'gate 🟢 +0' }, { dedupe: true });
    expect([third.id, third.deduped, third.repeatCount]).toEqual([1, true, 3]);
    expect(third.repeatReason).toBe('repeat of #1 (×3 · same sender/body/evidence sha/meta within 30 min · no new row)');
  } finally { store.close(); }
});

test('SEAT-MAIL #16: no origin-key, a different evidence sha in refs → 2 rows', () => {
  const dir = tempDir();
  const path = join(dir, 'messages.db');
  const store = new MsgStore(path);
  try {
    const a = store.post({ from: 'JUD', to: 'OP', body: 'landed', refs: ['build:abcdef1'] }, { dedupe: true });
    const b = store.post({ from: 'JUD', to: 'OP', body: 'landed', refs: ['build:1234567'] }, { dedupe: true });
    expect([a.id, b.id]).toEqual([1, 2]);
    expect(b.deduped).toBe(undefined);
  } finally { store.close(); }
  expect(rows(path).map(row => row.id)).toEqual([1, 2]);
});

test('SEAT-MAIL #16: no origin-key, a different replyTo → 2 rows', () => {
  const dir = tempDir();
  const path = join(dir, 'messages.db');
  const store = new MsgStore(path);
  try {
    store.post({ from: 'OP', to: 'JUD', body: 'q1' });
    store.post({ from: 'OP', to: 'JUD', body: 'q2' });
    const a = store.post({ from: 'JUD', to: 'OP', body: 'ok', replyTo: 1 }, { dedupe: true });
    const b = store.post({ from: 'JUD', to: 'OP', body: 'ok', replyTo: 2 }, { dedupe: true });
    expect([a.id, b.id]).toEqual([3, 4]);
  } finally { store.close(); }
  expect(rows(path).map(row => row.id)).toEqual([1, 2, 3, 4]);
});

test('SEAT-MAIL #16: an unset window is 30 minutes — 29 min apart is suppressed, 31 min apart is a new row', () => {
  const dir = tempDir();
  const path = join(dir, 'messages.db');
  const saved = process.env.ELANOUS_MSG_DEDUPE_WINDOW_MS;
  delete process.env.ELANOUS_MSG_DEDUPE_WINDOW_MS;
  const store = new MsgStore(path);
  try {
    store.post({ from: 'JUD', to: 'OP', body: 'report' }, { dedupe: true });
    store.db.query('UPDATE msg_messages SET created_at = ? WHERE id = 1').run(new Date(Date.now() - 29 * 60_000).toISOString());
    expect(store.post({ from: 'JUD', to: 'OP', body: 'report' }, { dedupe: true }).id).toBe(1);
    store.db.query('UPDATE msg_messages SET created_at = ? WHERE id = 1').run(new Date(Date.now() - 31 * 60_000).toISOString());
    expect(store.post({ from: 'JUD', to: 'OP', body: 'report' }, { dedupe: true }).id).toBe(2);
  } finally {
    store.close();
    if (saved === undefined) delete process.env.ELANOUS_MSG_DEDUPE_WINDOW_MS; else process.env.ELANOUS_MSG_DEDUPE_WINDOW_MS = saved;
  }
});
