import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Command } from 'commander';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerMsgCommands } from '../cli/msg-cli.js';
import { MsgStore } from './msg-store.js';

const dirs: string[] = [];
function diskPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elanous-msg-fromkind-'));
  dirs.push(dir);
  return join(dir, 'messages.db');
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('SEAT-INBOX-PROTOCOL B1-A first step: message origin', () => {
  test(':memory: post then read derives agent for seat senders and system for the rest', () => {
    const store = new MsgStore(':memory:');
    try {
      const agent = store.post({ from: 'OP', to: 'TC', body: 'seat author' });
      expect(agent.origin).toEqual({ kind: 'agent', seat: 'OP' });
      expect(store.getMessage(agent.id)?.origin).toEqual({ kind: 'agent', seat: 'OP' });

      const tool = store.post({ from: 'TA', to: 'OP', body: 'tooling author' });
      expect(tool.origin).toEqual({ kind: 'tool', seat: 'TA' });
      expect(store.getMessage(tool.id)?.origin).toEqual({ kind: 'tool', seat: 'TA' });

      expect(store.listByRecipient('TC').map((m) => m.origin)).toEqual([{ kind: 'agent', seat: 'OP' }]);
    } finally { store.close(); }
  });

  test('v1 ledger without from_kind migrates with zero errors and derives origin for old rows', () => {
    const path = diskPath();
    const seed = new MsgStore(path);
    const seeded = [
      seed.post({ from: 'OP', to: 'TC', body: 'legacy agent row' }),
      seed.post({ from: 'TA', to: 'OP', body: 'legacy system row' }),
    ];
    seed.close();

    // Rewind to a v1-shaped ledger: every current column except from_kind.
    const rewind = new Database(path);
    rewind.exec('ALTER TABLE msg_messages DROP COLUMN from_kind');
    rewind.close();

    const store = new MsgStore(path); // migration must not throw
    try {
      const probe = new Database(path, { readonly: true });
      const cols = (probe.query("PRAGMA table_info('msg_messages')").all() as { name: string }[]).map((c) => c.name);
      probe.close();
      expect(cols).toContain('from_kind');

      expect(store.getMessage(seeded[0].id)?.origin).toEqual({ kind: 'agent', seat: 'OP' });
      expect(store.getMessage(seeded[1].id)?.origin).toEqual({ kind: 'tool', seat: 'TA' });
    } finally { store.close(); }

    const again = new MsgStore(path); // idempotent: column already there, skip
    try { expect(again.getMessage(seeded[0].id)?.origin).toEqual({ kind: 'agent', seat: 'OP' }); }
    finally { again.close(); }
  });

  test('post() return keeps the historical envelope shape (regression)', () => {
    const store = new MsgStore(':memory:');
    try {
      const posted = store.post({ from: 'OP', to: 'MK', body: 'regression' });
      expect(posted.from).toBe('OP');
      expect(posted.to).toBe('MK');
      expect(posted.body).toBe('regression');
      expect(typeof posted.id).toBe('number');
      expect(typeof posted.createdAt).toBe('string');
    } finally { store.close(); }
  });
});

describe('SEAT-INBOX-PROTOCOL B1-A mf2: SCHEMA-V2 columns, origin range, envelope roundtrip', () => {
  const V2_COLUMNS = ['crown_directive', 'intent', 'refs_json', 'body_ref_json', 'deadline_at', 'needs_ack', 'schema_version'] as const;

  function columnNames(path: string): string[] {
    const probe = new Database(path, { readonly: true });
    try { return (probe.query("PRAGMA table_info('msg_messages')").all() as { name: string }[]).map((c) => c.name); }
    finally { probe.close(); }
  }
  function rawRow(path: string, id: number): Record<string, unknown> {
    const probe = new Database(path, { readonly: true });
    try { return probe.query('SELECT * FROM msg_messages WHERE id = ?').get(id) as Record<string, unknown>; }
    finally { probe.close(); }
  }

  test('(a) v1 ledger migrates: seven columns exist afterwards, old rows still read', () => {
    const path = diskPath();
    const seed = new MsgStore(path);
    const seeded = seed.post({ from: 'OP', to: 'TC', body: 'v1 row' });
    seed.close();
    const rewind = new Database(path);
    for (const column of [...V2_COLUMNS, 'from_kind']) rewind.exec(`ALTER TABLE msg_messages DROP COLUMN ${column}`);
    rewind.close();

    const store = new MsgStore(path); // migration must not throw
    try {
      const cols = columnNames(path);
      for (const column of V2_COLUMNS) expect(cols).toContain(column);
      expect(store.getMessage(seeded.id)?.body).toBe('v1 row');
      expect(store.getMessage(seeded.id)?.schemaVersion).toBe(1); // (h) old rows read as 1
    } finally { store.close(); }
    const before = columnNames(path).length;
    const again = new MsgStore(path); // idempotent second open
    try { expect(columnNames(path).length).toBe(before); } finally { again.close(); }
  });

  test('(b) new post roundtrips intent, refs, deadlineAt, needsAck, crownDirective', () => {
    const store = new MsgStore(':memory:');
    try {
      const posted = store.post({ from: 'OP', to: 'TC', body: 'v2 roundtrip', intent: 'request',
        refs: ['#38108', 'dir:12'], deadlineAt: '2026-05-01T00:00:00.000Z', needsAck: true, crownDirective: '42' });
      expect(posted.intent).toBe('request');
      expect(posted.refs).toEqual(['#38108', 'dir:12']);
      expect(posted.deadlineAt).toBe('2026-05-01T00:00:00.000Z');
      expect(posted.needsAck).toBe(true);
      expect(posted.crownDirective).toBe('42');
      expect(posted.schemaVersion).toBe(2); // (h) new rows record 2

      const read = store.getMessage(posted.id)!;
      expect(read.intent).toBe('request');
      expect(read.refs).toEqual(['#38108', 'dir:12']);
      expect(read.deadlineAt).toBe('2026-05-01T00:00:00.000Z');
      expect(read.needsAck).toBe(true);
      expect(read.crownDirective).toBe('42');
      expect(read.schemaVersion).toBe(2);
      expect(store.listByRecipient('TC')[0]!.intent).toBe('request');
    } finally { store.close(); }
  });

  test('(c) invalid intent is rejected', () => {
    const store = new MsgStore(':memory:');
    try { expect(() => store.post({ from: 'OP', to: 'TC', body: 'x', intent: 'urgent' as never })).toThrow(); }
    finally { store.close(); }
  });

  test('(d) needsAck defaults: request/decision true, info/alert false, absent intent false', () => {
    const store = new MsgStore(':memory:');
    try {
      expect(store.post({ from: 'OP', to: 'TC', body: 'r', intent: 'request' }).needsAck).toBe(true);
      expect(store.post({ from: 'OP', to: 'TC', body: 'd', intent: 'decision' }).needsAck).toBe(true);
      expect(store.post({ from: 'OP', to: 'TC', body: 'i', intent: 'info' }).needsAck).toBe(false);
      expect(store.post({ from: 'OP', to: 'TC', body: 'a', intent: 'alert' }).needsAck).toBe(false);
      expect(store.post({ from: 'OP', to: 'TC', body: 'n' }).needsAck).toBe(false);
    } finally { store.close(); }
  });

  test('(e) refs omitted stores NULL, not an empty array', () => {
    const path = diskPath();
    const store = new MsgStore(path);
    try {
      const posted = store.post({ from: 'OP', to: 'TC', body: 'no refs', intent: 'info' });
      store.close();
      const row = rawRow(path, posted.id);
      expect(row['refs_json']).toBe(null);
      const reopen = new MsgStore(path);
      try { expect(reopen.getMessage(posted.id)!.refs).toBeUndefined(); }
      finally { reopen.close(); }
    } finally { store.close(); }
  });

  test('(f) explicit origin roundtrips (human/tool included) and crown_directive implies delegatedByCrown', () => {
    const store = new MsgStore(':memory:');
    try {
      const human = store.post({ from: 'OP', to: 'TC', body: 'person', origin: { kind: 'human', seat: 'OP' } });
      expect(human.origin).toEqual({ kind: 'human', seat: 'OP' });
      expect(store.getMessage(human.id)!.origin).toEqual({ kind: 'human', seat: 'OP' });

      const tool = store.post({ from: 'TA', to: 'OP', body: 'tooling', origin: { kind: 'tool', seat: 'TA' } });
      expect(store.getMessage(tool.id)!.origin).toEqual({ kind: 'tool', seat: 'TA' });

      const delegated = store.post({ from: 'OP', to: 'TC', body: 'crown', crownDirective: '7' });
      expect(store.getMessage(delegated.id)!.origin).toEqual({ kind: 'agent', seat: 'OP', delegatedByCrown: true });
    } finally { store.close(); }
  });

  test('(g) CLI post rejects a --crown-directive id missing from the directive ledger', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-msg-fromkind-cli-'));
    dirs.push(dir);
    const stateDir = join(dir, 'state');
    // 프리로드(test/preload-isolation.ts)의 프로세스 전역 격리 스탬프를 지우지 않는다 —
    // 세팅 직전 원값을 캡처해 finally 에서 원복한다(delete 는 미설정이었을 때만).
    // OP #100606: 풀스위트에서 스탬프 소실 시 이후 시험의 effectiveInstanceRoot() 가
    // 기본 prodRoot 로 떨어져 liveUniverse()=참 — msg-post-office.test.ts:73 실패 유발.
    const prevState = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = stateDir;
    try {
      const stdout: string[] = []; const stderr: string[] = []; const exits: number[] = [];
      const program = new Command();
      registerMsgCommands(program, {
        openStore: () => new MsgStore(join(dir, 'messages.db')),
        out: { log: line => stdout.push(line), error: line => stderr.push(line) },
        readStdin: async () => 'body', sleep: async () => undefined,
        registerLogSink: async () => undefined,
        wake: async (address, msgId) => ({ wake: 'none', source: 'unresolved', address, msgId, result: 'skipped' }),
        setExitCode: code => exits.push(code),
      });
      await program.parseAsync(['msg', 'post', '--from', 'OP', '--to', 'TC', '--crown-directive', '999'], { from: 'user' });
      expect(exits[0]).toBe(2);
      expect(stderr.some(line => line.includes('crown-directive'))).toBe(true);

      // Same CLI accepts the id once a fake ledger has it (rowid 1).
      mkdirSync(join(stateDir, 'directives'), { recursive: true });
      const fake = new Database(join(stateDir, 'directives', 'directives.db'));
      fake.exec('CREATE TABLE IF NOT EXISTS directives (ts TEXT NOT NULL, agent TEXT NOT NULL, session_id TEXT NOT NULL, cwd TEXT, track TEXT, released TEXT, dev TEXT, codename TEXT, text TEXT NOT NULL, source_file TEXT NOT NULL, line_no INTEGER NOT NULL, PRIMARY KEY(source_file, line_no))');
      fake.exec("INSERT INTO directives(ts, agent, session_id, cwd, track, released, dev, codename, text, source_file, line_no) VALUES ('2026-04-14T00:00:00Z', 'crown', 's1', NULL, NULL, NULL, NULL, NULL, '지시', 'crown.md', 1)");
      fake.close();
      const program2 = new Command();
      registerMsgCommands(program2, {
        openStore: () => new MsgStore(join(dir, 'messages.db')),
        out: { log: line => stdout.push(line), error: line => stderr.push(line) },
        readStdin: async () => 'body', sleep: async () => undefined,
        registerLogSink: async () => undefined,
        wake: async (address, msgId) => ({ wake: 'none', source: 'unresolved', address, msgId, result: 'skipped' }),
        setExitCode: code => exits.push(code),
      });
      await program2.parseAsync(['msg', 'post', '--from', 'OP', '--to', 'TC', '--crown-directive', '1', '--json'], { from: 'user' });
      expect(stderr.filter(line => line.includes('crown-directive')).length).toBe(1); // no new rejection
      const saved = JSON.parse(stdout.at(-1)!) as { id: number };
      const reopen = new MsgStore(join(dir, 'messages.db'));
      try {
        const row = reopen.getMessage(saved.id)!;
        expect(row.crownDirective).toBe('1');
        expect(row.origin).toEqual({ kind: 'agent', seat: 'OP', delegatedByCrown: true });
      } finally { reopen.close(); }
    } finally {
      if (prevState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = prevState;
    }
  });

  test('a body over 4000 chars stays in the ledger row — no preview, no sidecar file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-msg-bodies-'));
    dirs.push(dir);
    const body = '가'.repeat(4001);
    const a = new MsgStore(join(dir, 'a.db'));
    const b = new MsgStore(join(dir, 'b.db'));
    try {
      const left = a.post({ from: 'OP', to: 'TC', body });
      const right = b.post({ from: 'MK', to: 'UX', body: `${body}B` });
      expect(left.id).toBe(right.id);
      expect(a.getMessage(left.id)!.body).toBe(body);
      expect(b.getMessage(right.id)!.body).toBe(`${body}B`);
      const rawA = rawRow(join(dir, 'a.db'), left.id);
      const rawB = rawRow(join(dir, 'b.db'), right.id);
      expect(rawA['body']).toBe(body);
      expect(rawB['body']).toBe(`${body}B`);
      expect(rawA['body_ref_json']).toBeNull();
      expect(rawB['body_ref_json']).toBeNull();
    } finally { a.close(); b.close(); }
  });

  test('an omitted origin stays unknown instead of being asserted from the sender name', () => {
    const store = new MsgStore(':memory:');
    try {
      const posted = store.post({ from: 'RLA', to: 'OP', body: 'unclassified author' });
      expect(posted.origin).toBeUndefined();
      expect(store.getMessage(posted.id)!.origin).toBeUndefined();
      expect(JSON.stringify(posted)).not.toContain('"kind":"system"');
    } finally { store.close(); }
  });

  test('Terra #38111 r4: system seat and delegatedByCrown false roundtrip', () => {
    const store = new MsgStore(':memory:');
    try {
      const system = store.post({ from: 'RLA', to: 'OP', body: 'named system', origin: { kind: 'system', seat: 'RLA' } });
      expect(system.origin).toEqual({ kind: 'system', seat: 'RLA' });
      expect(store.getMessage(system.id)!.origin).toEqual(system.origin);
      const notCrown = store.post({ from: 'OP', to: 'TC', body: 'not delegated', origin: { kind: 'agent', delegatedByCrown: false } });
      expect(notCrown.origin).toEqual({ kind: 'agent', seat: 'OP', delegatedByCrown: false });
      expect(store.getMessage(notCrown.id)!.origin).toEqual(notCrown.origin);
    } finally { store.close(); }
  });

  test('Terra #38111 r4: a partial v2 ledger keeps the columns that exist, and a v1 ledger retries provenance', () => {
    const partialPath = diskPath();
    const partialSeed = new MsgStore(partialPath);
    const kept = partialSeed.post({ from: 'OP', to: 'TC', body: 'partial', intent: 'alert', refs: ['keep-me'] });
    partialSeed.close();
    const drop = new Database(partialPath);
    drop.exec('ALTER TABLE msg_messages DROP COLUMN deadline_at');
    drop.close();
    const partial = new MsgStore(partialPath, { readOnly: true });
    try {
      const row = partial.getMessage(kept.id)!;
      expect(row.intent).toBe('alert');
      expect(row.refs).toEqual(['keep-me']);
    } finally { partial.close(); }

    const v1Path = diskPath();
    const v1Seed = new MsgStore(v1Path);
    const first = v1Seed.appendWithProvenance({ from: 'OP', to: 'TC', body: 'once', priority: 4 }, 'coord:v1-retry:TC');
    v1Seed.close();
    const rewind = new Database(v1Path);
    for (const column of ['from_kind', 'intent', 'refs_json', 'deadline_at', 'needs_ack', 'crown_directive', 'schema_version', 'body_ref_json', 'origin_seat', 'origin_delegated']) {
      rewind.exec(`ALTER TABLE msg_messages DROP COLUMN ${column}`);
    }
    rewind.close();
    const v1 = new MsgStore(v1Path, { readOnly: true });
    try {
      const again = v1.appendWithProvenance({ from: 'OP', to: 'TC', body: 'twice', priority: 9 }, 'coord:v1-retry:TC');
      expect(again.id).toBe(first.id);
      expect(again.priority).toBe(4);
      expect(again.body).toBe('once');
    } finally { v1.close(); }
  });

  test('origin.seat must match the sender, an omitted seat still roundtrips, and crownDirective sets the flag', () => {
    const store = new MsgStore(':memory:');
    try {
      expect(() => store.post({ from: 'OP', to: 'TC', body: 'other seat', origin: { kind: 'agent', seat: 'MK' } })).toThrow(/origin\.seat/);
      const omitted = store.post({ from: 'OP', to: 'TC', body: 'same seat', origin: { kind: 'human' } });
      expect(omitted.origin).toEqual({ kind: 'human', seat: 'OP' });
      expect(store.getMessage(omitted.id)!.origin).toEqual(omitted.origin);
      const crownOnly = store.post({ from: 'OP', to: 'TC', body: 'flag only', crownDirective: '9' });
      expect(crownOnly.origin).toEqual({ kind: 'agent', seat: 'OP', delegatedByCrown: true });
      expect(store.getMessage(crownOnly.id)!.origin).toEqual(crownOnly.origin);
    } finally { store.close(); }
  });

  test('priority survives getMessage, listThread, listReplies, listAfter, and listCreatedBetween', () => {
    const store = new MsgStore(':memory:');
    try {
      const root = store.post({ from: 'OP', to: 'TC', body: 'root', priority: 2 });
      const reply = store.post({ from: 'TC', to: 'OP', body: 'reply', replyTo: root.id, priority: 1 });
      expect(store.getMessage(root.id)!.priority).toBe(2);
      expect(store.listThread(root.id).map(m => m.priority)).toEqual([2, 1]);
      expect(store.listReplies(root.id).map(m => m.priority)).toEqual([1]);
      expect(store.listAfter(0).map(m => m.priority)).toEqual([2, 1]);
      const window = store.listCreatedBetween('2020-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
      expect(window.find(m => m.id === reply.id)!.priority).toBe(1);
    } finally { store.close(); }
  });

  test('Terra #38111: a missing origin column and an explicit NULL both keep the sender, including system', () => {
    const path = diskPath();
    const seed = new MsgStore(path);
    const system = seed.post({ from: 'RLA', to: 'OP', body: 'named', origin: { kind: 'system', seat: 'RLA' } });
    const agent = seed.post({ from: 'OP', to: 'TC', body: 'seat' });
    seed.close();
    const blank = new Database(path);
    blank.query('UPDATE msg_messages SET origin_seat = NULL WHERE id = ?').run(system.id);
    blank.exec('ALTER TABLE msg_messages DROP COLUMN origin_seat');
    blank.close();
    const store = new MsgStore(path);
    try {
      expect(store.getMessage(system.id)!.origin).toEqual({ kind: 'system', seat: 'RLA' });
      expect(store.getMessage(agent.id)!.origin?.seat).toBe('OP');
    } finally { store.close(); }
  });

  test('a canonical v2 ledger without origin columns still returns intent, and provenance retries keep priority', () => {
    const path = diskPath();
    const seed = new MsgStore(path);
    const posted = seed.post({ from: 'OP', to: 'TC', body: 'kept', intent: 'alert', priority: 7, refs: ['r1'] });
    seed.close();
    const rewind = new Database(path);
    rewind.exec('ALTER TABLE msg_messages DROP COLUMN origin_seat');
    rewind.exec('ALTER TABLE msg_messages DROP COLUMN origin_delegated');
    rewind.query("INSERT INTO msg_provenance(provenance_key, message_id) VALUES ('coord:kept:TC', ?)").run(posted.id);
    rewind.close();
    const store = new MsgStore(path, { readOnly: true });
    try {
      const read = store.getMessage(posted.id)!;
      expect(read.intent).toBe('alert');
      expect(read.refs).toEqual(['r1']);
      expect(read.priority).toBe(7);
      expect(read.body).toBe('kept');
      const again = store.appendWithProvenance({ from: 'OP', to: 'TC', body: 'duplicate' }, 'coord:kept:TC');
      expect(again.id).toBe(posted.id);
      expect(again.priority).toBe(7);
      expect(again.intent).toBe('alert');
    } finally { store.close(); }
  });
});
