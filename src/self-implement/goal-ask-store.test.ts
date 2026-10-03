import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { setDefaultTimeout, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqlNowIso } from '../time/db-window.js';
import { GoalAskStore, addDocumentMetadataColumns, loadGoalAskRecords, recordGoalAsk, renderGoalAskRecords } from './goal-ask-store.js';
import { debug } from '../debug/log.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function path(): string {
  const directory = mkdtempSync(join(tmpdir(), 'goal-ask-store-'));
  directories.push(directory);
  return join(directory, 'self-implement', 'goal-runs.db');
}

const document = '- GoalId: 0123456789abcdef\n- RootIntent: record CLI ask\n';

describe('GoalAskStore', () => {
  test('stores an exact ask and retains multiple goals for the same author run', () => {
    const store = new GoalAskStore(path());
    try {
      const ask = '원문 ask\n공백과 줄바꿈을 포함해 그대로 보존한다.';
      expect(store.insert({ authorRunId: 'author-shared', goalFile: 'docs/goals/one.md', ask, document })).toBe(true);
      expect(store.insert({ authorRunId: 'author-shared', goalFile: 'docs/goals/two.md', ask: '둘째 ask', document })).toBe(true);

      const records = store.query({ goalId: '0123456789abcdef' });
      expect(records).toHaveLength(2);
      expect(records[1]).toMatchObject({ authorRunId: 'author-shared', goalFile: 'docs/goals/one.md', ask, askChars: ask.length });
      expect(records[1].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(store.query({ authorRunId: 'author-shared', limit: 1 })).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test('writes ISO UTC created_at when a legacy schema retains its old default', () => {
    const databasePath = path();
    mkdirSync(join(databasePath, '..'), { recursive: true });
    const legacy = new Database(databasePath, { create: true });
    const legacyCurrentTimestamp = ['CURRENT', 'TIMESTAMP'].join('_');
    legacy.run(`CREATE TABLE goal_ask (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author_run_id TEXT NOT NULL,
      goal_id TEXT NOT NULL,
      goal_file TEXT NOT NULL,
      ask TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ${legacyCurrentTimestamp},
      ask_chars INTEGER GENERATED ALWAYS AS (length(ask)) VIRTUAL
    )`);
    legacy.close();

    const store = new GoalAskStore(databasePath);
    try {
      expect(store.insert({ authorRunId: 'author-current', goalFile: 'docs/goals/current.md', ask: 'current ask', document })).toBe(true);
      expect(store.query({ authorRunId: 'author-current' })).toEqual([
        expect.objectContaining({ createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) }),
      ]);
    } finally {
      store.close();
    }
  });

  test('records document metadata and preserves unknown metadata for legacy rows', () => {
    const databasePath = path();
    mkdirSync(join(databasePath, '..'), { recursive: true });
    const legacy = new Database(databasePath, { create: true });
    legacy.run(`CREATE TABLE goal_ask (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author_run_id TEXT NOT NULL,
      goal_id TEXT NOT NULL,
      goal_file TEXT NOT NULL,
      ask TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (${sqlNowIso()}),
      ask_chars INTEGER GENERATED ALWAYS AS (length(ask)) VIRTUAL
    )`);
    legacy.run('INSERT INTO goal_ask (author_run_id, goal_id, goal_file, ask) VALUES (?, ?, ?, ?)', ['author-legacy', '0123456789abcdef', 'docs/goals/legacy.md', 'legacy ask']);
    legacy.close();

    const store = new GoalAskStore(databasePath);
    try {
      expect(store.insert({ authorRunId: 'author-current', goalFile: 'docs/goals/current.md', ask: 'current ask', document })).toBe(true);
      const records = store.query({ goalId: '0123456789abcdef' });
      const current = records.find((record) => record.authorRunId === 'author-current')!;
      const legacyRecord = records.find((record) => record.authorRunId === 'author-legacy')!;
      expect(current).toMatchObject({
        documentChars: document.length,
        documentSha256: createHash('sha256').update(document).digest('hex'),
      });
      expect(legacyRecord).toMatchObject({ documentChars: null, documentSha256: null });
      const rendered = renderGoalAskRecords([current, legacyRecord]);
      expect(rendered).toContain(`document: ${document.length}자 · sha256: ${current.documentSha256}`);
      expect(rendered).toContain('document: unknown · sha256: unknown');
      expect(rendered).not.toContain('document: 0자');
    } finally {
      store.close();
    }
  });

  // ⛔⭐⭐ 동시 초기화 경쟁 (무인 리뷰 must-fix 2026-08-08).
  //   종전 마이그레이션은 `PRAGMA table_info` 로 「없다」를 «보고 나서» `ALTER` 를 던졌다.
  //   하니스 자식은 «동시에» 저작하므로 두 프로세스가 둘 다 「없다」를 보고 둘 다 ALTER 를 던진다 —
  //   뒤엣것이 `duplicate column name` 으로 «생성자에서» 죽고, `recordGoalAsk` 의 fail-soft 가
  //   그 죽음을 삼켜 ***그 저작의 ask 가 유실된다***. 유실을 막으려는 저장소가 유실을 만드는 경로다.
  //   ⇒ 이 테스트는 「같은 레거시 db 를 «두 연결»이 연다」를 실물로 돌려 그 유실을 문다.
  test('경쟁에서 «진» 프로세스가 만나는 상태 — ALTER 가 duplicate 를 던져도 죽지 않는다', () => {
    // ⭐ 이것이 「진 프로세스」의 상태다: 검사로는 없는데 `ALTER` 는 이미 «이긴 쪽»이 만든 컬럼을 만난다.
    //   ⛔ 두 연결을 «순차»로 여는 테스트로는 못 잡는다 — 종전 구현도 통과해 판별력이 «0» 이다
    //     (무인 리뷰가 그것을 Goodhart 테스트라 지적했고 맞다).
    const attempted: string[] = [];
    const losingRacer = {
      run: (sql: string) => {
        attempted.push(sql);
        if (sql.includes('document_chars')) throw new Error('SQLiteError: duplicate column name: document_chars');
        return undefined;
      },
    };
    expect(() => addDocumentMetadataColumns(losingRacer)).not.toThrow();
    // ⛔ 「안 죽었다」로 끝내지 않는다 — ***중복 뒤의 둘째 컬럼도 시도돼야*** 마이그레이션이 «완결»된다.
    expect(attempted).toHaveLength(2);
    expect(attempted[1]).toContain('document_sha256');
  });

  test('⛔ 다른 오류는 «삼키지 않는다» — 삼키면 그것이 또 조용한 유실이다', () => {
    const brokenDisk = { run: () => { throw new Error('SQLiteError: attempt to write a readonly database'); } };
    expect(() => addDocumentMetadataColumns(brokenDisk)).toThrow(/readonly database/);
  });

  // ⛔ 이름을 «사실»에 맞춘다(리뷰 should-fix) — 이것은 «동시성» 테스트가 아니라 «순차» 테스트다.
  //   동시성의 판별은 위 스텁 테스트가 지고, 이것은 「실물 db 에서 두 연결이 각자 쓴 것이 남는가」만 문다.
  test('실물 db 를 «순차»로 연 두 연결이 각자 쓴 기록이 둘 다 남는다 (⛔ 동시성 테스트가 아니다)', () => {
    const databasePath = path();
    mkdirSync(join(databasePath, '..'), { recursive: true });
    const legacy = new Database(databasePath, { create: true });
    legacy.run(`CREATE TABLE goal_ask (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author_run_id TEXT NOT NULL,
      goal_id TEXT NOT NULL,
      goal_file TEXT NOT NULL,
      ask TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (${sqlNowIso()}),
      ask_chars INTEGER GENERATED ALWAYS AS (length(ask)) VIRTUAL
    )`);
    legacy.close();

    const first = new GoalAskStore(databasePath);
    const second = new GoalAskStore(databasePath);
    const reader = new GoalAskStore(databasePath);
    try {
      expect(second.insert({ authorRunId: 'author-second', goalFile: 'docs/goals/second.md', ask: 'second ask', document })).toBe(true);
      expect(first.insert({ authorRunId: 'author-first', goalFile: 'docs/goals/first.md', ask: 'first ask', document })).toBe(true);
      const runs = reader.query({ goalId: '0123456789abcdef' }).map((record) => record.authorRunId);
      expect(runs).toContain('author-second');
      expect(runs).toContain('author-first');
    } finally {
      first.close();
      second.close();
      reader.close();   // ⛔ 리뷰 should-fix — 조회용 연결도 닫는다(누수)
    }
  });

  test('counts Unicode code points for document metadata while preserving the ask and hash', () => {
    const store = new GoalAskStore(path());
    const unicodeDocument = '- GoalId: 0123456789abcdef\n- RootIntent: 😀 authored goal\n';
    const ask = 'emoji ask 😀';
    try {
      expect(store.insert({ authorRunId: 'author-unicode', goalFile: 'docs/goals/unicode.md', ask, document: unicodeDocument })).toBe(true);
      expect(store.query({ authorRunId: 'author-unicode' })).toEqual([expect.objectContaining({
        ask,
        askChars: Array.from(ask).length,
        documentChars: Array.from(unicodeDocument).length,
        documentSha256: createHash('sha256').update(unicodeDocument).digest('hex'),
      })]);
      expect(Array.from(unicodeDocument).length).not.toBe(unicodeDocument.length);
    } finally {
      store.close();
    }
  });

  test('returns false without throwing or recording when the document has no GoalId', () => {
    const store = new GoalAskStore(path());
    try {
      expect(store.insert({ authorRunId: 'author-missing', goalFile: 'docs/goals/missing.md', ask: 'unrecorded', document: '# no id' })).toBe(false);
      expect(store.query({ authorRunId: 'author-missing' })).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('logs failed goal-ask writes while preserving the false sentinel', () => {
    const stateRoot = join(mkdtempSync(join(tmpdir(), 'goal-ask-state-root-file-')), 'not-a-directory');
    directories.push(join(stateRoot, '..'));
    writeFileSync(stateRoot, 'not a directory');
    const previousStateDir = process.env.ELANOUS_STATE_DIR;
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    process.env.ELANOUS_STATE_DIR = stateRoot;
    try {
      expect(recordGoalAsk({ authorRunId: 'author-failed', goalFile: 'docs/goals/failed.md', ask: 'failed ask', document })).toBe(false);
      expect(log).toHaveBeenCalledWith('goal-ledger.read', 'goal-ask-record-failed', {
        path: join(stateRoot, 'self-implement', 'goal-runs.db'),
        error: expect.any(String),
      });
      expect(log.mock.calls[0]?.[2]).toMatchObject({ error: expect.stringMatching(/ENOTDIR|not a directory/i) });
    } finally {
      if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousStateDir;
      log.mockRestore();
    }
  });

  test('self goal-asks CLI returns exact JSON ask text from the shared ledger database', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'goal-ask-cli-'));
    directories.push(stateDir);
    const ask = 'CLI ask 원문\n둘째 줄도 보존';
    const databasePath = join(stateDir, 'self-implement', 'goal-runs.db');
    const store = new GoalAskStore(databasePath);
    try {
      expect(store.insert({ authorRunId: 'author-cli', goalFile: 'docs/goals/cli.md', ask, document })).toBe(true);
    } finally {
      store.close();
    }

    const result = Bun.spawnSync({
      cmd: [process.execPath, 'bin/elanous.mjs', 'self', 'goal-asks', '--goal', '0123456789abcdef', '--limit', '1', '--json'],
      cwd: process.cwd(),
      env: { ...process.env, ELANOUS_STATE_DIR: stateDir },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      authorRunId: 'author-cli',
      goalId: '0123456789abcdef',
      ask,
      askChars: ask.length,
      documentChars: document.length,
      documentSha256: createHash('sha256').update(document).digest('hex'),
    });
  });

  test('self goal-asks CLI reads an unmigrated legacy ledger without changing its schema', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'goal-ask-legacy-read-only-cli-'));
    directories.push(stateDir);
    const databasePath = join(stateDir, 'self-implement', 'goal-runs.db');
    mkdirSync(join(databasePath, '..'), { recursive: true });
    const legacy = new Database(databasePath, { create: true });
    legacy.run(`CREATE TABLE goal_ask (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author_run_id TEXT NOT NULL,
      goal_id TEXT NOT NULL,
      goal_file TEXT NOT NULL,
      ask TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (${sqlNowIso()}),
      ask_chars INTEGER GENERATED ALWAYS AS (length(ask)) VIRTUAL
    )`);
    legacy.run('INSERT INTO goal_ask (author_run_id, goal_id, goal_file, ask) VALUES (?, ?, ?, ?)', ['author-legacy-read-only', '0123456789abcdef', 'docs/goals/legacy.md', 'legacy ask']);
    legacy.close();

    const result = Bun.spawnSync({
      cmd: [process.execPath, 'bin/elanous.mjs', 'self', 'goal-asks', '--goal', '0123456789abcdef', '--limit', '1', '--json'],
      cwd: process.cwd(),
      env: { ...process.env, ELANOUS_STATE_DIR: stateDir },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      authorRunId: 'author-legacy-read-only',
      documentChars: null,
      documentSha256: null,
    });
    const inspected = new Database(databasePath, { readonly: true });
    try {
      expect((inspected.query('PRAGMA table_info(goal_ask)').all() as Array<{ name: string }>).map((column) => column.name))
        .not.toContain('document_chars');
      expect((inspected.query('PRAGMA table_info(goal_ask)').all() as Array<{ name: string }>).map((column) => column.name))
        .not.toContain('document_sha256');
    } finally {
      inspected.close();
    }
  });

  test('self goal-asks CLI distinguishes known document metadata from legacy unknown metadata in human output', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'goal-ask-human-cli-'));
    directories.push(stateDir);
    const databasePath = join(stateDir, 'self-implement', 'goal-runs.db');
    mkdirSync(join(databasePath, '..'), { recursive: true });
    const legacy = new Database(databasePath, { create: true });
    legacy.run(`CREATE TABLE goal_ask (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author_run_id TEXT NOT NULL,
      goal_id TEXT NOT NULL,
      goal_file TEXT NOT NULL,
      ask TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (${sqlNowIso()}),
      ask_chars INTEGER GENERATED ALWAYS AS (length(ask)) VIRTUAL
    )`);
    legacy.run('INSERT INTO goal_ask (author_run_id, goal_id, goal_file, ask) VALUES (?, ?, ?, ?)', ['author-legacy-cli', '0123456789abcdef', 'docs/goals/legacy.md', 'legacy ask']);
    legacy.close();
    const store = new GoalAskStore(databasePath);
    try {
      expect(store.insert({ authorRunId: 'author-current-cli', goalFile: 'docs/goals/current.md', ask: 'current ask', document })).toBe(true);
    } finally {
      store.close();
    }

    const result = Bun.spawnSync({
      cmd: [process.execPath, 'bin/elanous.mjs', 'self', 'goal-asks', '--goal', '0123456789abcdef', '--limit', '2'],
      cwd: process.cwd(),
      env: { ...process.env, ELANOUS_STATE_DIR: stateDir },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(`document: ${document.length}자 · sha256: ${createHash('sha256').update(document).digest('hex')}`);
    expect(result.stdout.toString()).toContain('document: unknown · sha256: unknown');
    expect(result.stdout.toString()).not.toContain('document: 0자');
  });

  test('self goal-asks CLI reports an empty ledger without claiming authoring never occurred or creating it', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'goal-ask-empty-cli-'));
    directories.push(stateDir);
    const databasePath = join(stateDir, 'self-implement', 'goal-runs.db');
    const result = Bun.spawnSync({
      cmd: [process.execPath, 'bin/elanous.mjs', 'self', 'goal-asks', '--limit', '1'],
      cwd: process.cwd(),
      env: { ...process.env, ELANOUS_STATE_DIR: stateDir },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('기록 없음');
    expect(result.stdout.toString()).toContain('저작이 없었다는 뜻은 아님');
    expect(existsSync(databasePath)).toBe(false);
  });

  test('read-only queries find literal ASCII text in either ask or goal file', () => {
    const databasePath = path();
    const store = new GoalAskStore(databasePath);
    try {
      const otherGoalDocument = '- GoalId: fedcba9876543210\n- RootIntent: other goal\n';
      expect(store.insert({ authorRunId: 'author-ask', goalFile: 'docs/goals/plain.md', ask: 'Find Needle in the ask', document })).toBe(true);
      expect(store.insert({ authorRunId: 'author-file', goalFile: 'docs/goals/needle-path.md', ask: 'ordinary ask', document: otherGoalDocument })).toBe(true);
      expect(store.insert({ authorRunId: 'author-other', goalFile: 'docs/goals/other.md', ask: 'unrelated text', document })).toBe(true);
      expect(store.insert({ authorRunId: 'author-percent', goalFile: 'docs/goals/rate_100%.md', ask: 'literal % and _ value', document })).toBe(true);

      const matching = loadGoalAskRecords({ text: 'NEEDLE' }, databasePath);
      expect(matching.map((record) => record.authorRunId).sort()).toEqual(['author-ask', 'author-file']);
      expect(loadGoalAskRecords({ text: 'needle' }, databasePath)).toEqual(matching);
      expect(loadGoalAskRecords({ text: '%' }, databasePath).map((record) => record.authorRunId)).toEqual(['author-percent']);
      expect(loadGoalAskRecords({ text: '_' }, databasePath).map((record) => record.authorRunId)).toEqual(['author-percent']);
      expect(loadGoalAskRecords({ goalId: '0123456789abcdef', text: 'needle', limit: 1 }, databasePath).map((record) => record.authorRunId)).toEqual(['author-ask']);
      expect(loadGoalAskRecords({ goalId: 'not-a-goal', text: 'needle' }, databasePath)).toEqual([]);
      expect(loadGoalAskRecords({}, databasePath).map((record) => record.authorRunId)).toEqual([
        'author-percent',
        'author-other',
        'author-file',
        'author-ask',
      ]);
    } finally {
      store.close();
    }
  });

  test('read-only queries observe committed asks while the shared WAL writer remains open', () => {
    const databasePath = path();
    const store = new GoalAskStore(databasePath);
    try {
      const ask = 'WAL writer가 열린 상태의 최신 ask';
      expect(store.insert({ authorRunId: 'author-wal', goalFile: 'docs/goals/wal.md', ask, document })).toBe(true);
      expect(loadGoalAskRecords({ goalId: '0123456789abcdef' }, databasePath)).toEqual([
        expect.objectContaining({ authorRunId: 'author-wal', ask, askChars: ask.length }),
      ]);
    } finally {
      store.close();
    }
  });

  test('read-only queries do not require write access or alter the shared database or WAL files', () => {
    const databasePath = path();
    const ledgerDirectory = join(databasePath, '..');
    const store = new GoalAskStore(databasePath);
    try {
      expect(store.insert({ authorRunId: 'author-read-only', goalFile: 'docs/goals/read-only.md', ask: 'stored ask', document })).toBe(true);
    } finally {
      store.close();
    }

    const trackedLedgerFiles = readdirSync(ledgerDirectory).sort().filter((name) => name === 'goal-runs.db' || name === 'goal-runs.db-wal');
    const before = trackedLedgerFiles.map((name) => {
      const file = join(ledgerDirectory, name);
      const stat = statSync(file);
      return { name, size: stat.size, mtimeMs: stat.mtimeMs };
    });
    const openCalls: Array<{ spec: string; options: { readonly?: boolean } | undefined }> = [];
    const reader = new GoalAskStore(databasePath, true, class extends Database {
      constructor(spec: string, options?: { readonly?: boolean }) {
        openCalls.push({ spec, options });
        super(spec, options);
      }
    });
    try {
      expect(reader.query({ goalId: '0123456789abcdef' })).toHaveLength(1);
    } finally {
      reader.close();
    }
    expect(openCalls).toEqual([{ spec: databasePath, options: { readonly: true } }]);
    expect(openCalls[0]?.spec).not.toStartWith('file:');
    expect(openCalls[0]?.spec).not.toContain('?mode=ro');
    chmodSync(databasePath, 0o444);
    chmodSync(ledgerDirectory, 0o555);
    try {
      expect(loadGoalAskRecords({ goalId: '0123456789abcdef' }, databasePath)).toHaveLength(1);
      const after = trackedLedgerFiles.map((name) => {
        const file = join(ledgerDirectory, name);
        const stat = statSync(file);
        return { name, size: stat.size, mtimeMs: stat.mtimeMs };
      });
      expect(after).toEqual(before);
    } finally {
      chmodSync(ledgerDirectory, 0o755);
      chmodSync(databasePath, 0o644);
    }
  });

  test('treats only a missing goal_ask table as an empty ledger and propagates corrupt databases', () => {
    const legacyPath = path();
    mkdirSync(join(legacyPath, '..'), { recursive: true });
    const legacyStore = new Database(legacyPath, { create: true });
    legacyStore.run('CREATE TABLE goal_run (id INTEGER PRIMARY KEY)');
    legacyStore.close();
    expect(loadGoalAskRecords({}, legacyPath)).toEqual([]);

    const corruptPath = path();
    mkdirSync(join(corruptPath, '..'), { recursive: true });
    writeFileSync(corruptPath, 'not a SQLite database');
    expect(() => loadGoalAskRecords({}, corruptPath)).toThrow();
  });
});
