// /v1/terminals 요약의 outputBytesTotal 미상 보존 계약(리뷰 must-fix 2).
//  - 매니페스트 원시 행의 NULL/누락 output_bytes_total 을 0으로 날조하지 않는다(mapRow).
//  - 목록 요약은 기록된 양수 총계만 사실로 싣고, 계보(lineageRowFromManifest)와 «같은 행 같은 판정»을 낸다.
//  - seat 등 나머지 목록 필드는 미상 총계와 무관하게 그대로 실린다(회귀 보호).
// 격리 tmp ELANOUS_STATE_DIR 로 실제 데이터 무접촉.
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PtyManifestRow } from '../../pty-shell/pty-manifest.js';

const previousStateDir = process.env.ELANOUS_STATE_DIR;
const stateDir = mkdtempSync(join(tmpdir(), 'terminals-summary-'));
process.env.ELANOUS_STATE_DIR = stateDir;

const { listPtyManifestRowsAt } = await import('../../pty-shell/pty-manifest.js');
const { joinPtyLineage } = await import('../../cli/pty-takeover-cli.js');
const { handleTerminalsList } = await import('./terminals.js');

type TerminalsListDeps = Parameters<typeof handleTerminalsList>[2];
const manifestDbPath = join(stateDir, 'manifest.db');

function manifestRow(over: Partial<PtyManifestRow> & { id: string }): PtyManifestRow {
  return {
    kind: 'pty', cmd: 'bash', ownerPid: 456, ptyPid: 123, instance: 'test',
    startedAt: 1_000, alive: true, exitCode: null, snapshot: '', snapshotAt: 0,
    updatedAt: 2_000, frame: '', frameAt: 0, runId: 'run-shared', runIdSource: 'explicit', spaceId: '',
    sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
    terminalOriginCategory: 'unknown', terminalOriginReason: 'origin-marker-absent',
    ...over,
  };
}

/** 목록 조립 전체를 실체 핸들러로 구동 — 원시 매니페스트 행 → 요약 사슬을 우회 없이 지난다. */
function listDeps(rows: PtyManifestRow[]): TerminalsListDeps {
  return {
    ptyManifestTargets: () => [{ name: 'current', dbPath: manifestDbPath }],
    ptyManifestDbPath: () => manifestDbPath,
    realpath: (path: string) => path,
    listPtyManifestRows: () => rows,
    listPtyManifestRowsAt: (dbPath: string) => (dbPath === manifestDbPath ? rows : []),
    isProcessAlive: () => true,
    listPty: () => [],
    reapDeadPtyManifest: () => 0,
    purgeClosedPtyManifest: () => 0,
    reapStalePtyManifest: () => 0,
    reapOrphanedOwnedPtyManifest: () => 0,
    getDefaultLogStore: () => null,
    queryRunningRuns: () => { throw new Error('not-under-test'); },
    runTerminated: () => 'ledger-indeterminate',
  };
}

async function listTerminals(rows: PtyManifestRow[], all: boolean): Promise<Array<Record<string, unknown>>> {
  const response = handleTerminalsList(
    new Request(`http://local/v1/terminals${all ? '?all=true' : ''}`, { headers: { authorization: 'Bearer t' } }),
    { bearerToken: 't' },
    listDeps(rows),
  );
  expect(response.status).toBe(200);
  const body = await response.json() as { terminals: Array<Record<string, unknown>> };
  return body.terminals;
}

function lineageRowFor(row: PtyManifestRow): Record<string, unknown> {
  // 계보는 run 축으로 묶는다(runId 가 있는 고립 행) — 그 행이 속한 그룹에서 행을 직접 찾는다.
  const group = joinPtyLineage([row], [], row.runId).groups
    .find((candidate) => candidate.rows.some((candidateRow) => candidateRow.ptyId === row.id));
  const lineageRow = group?.rows.find((candidate) => candidate.ptyId === row.id);
  expect(lineageRow).toBeDefined();
  return lineageRow as unknown as Record<string, unknown>;
}

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
  if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = previousStateDir;
});

describe('pty-manifest 원시 행 → outputBytesTotal 매핑', () => {
  const dir = mkdtempSync(join(tmpdir(), 'terminals-maprow-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function rowAt(dbPath: string, id: string): PtyManifestRow | undefined {
    return listPtyManifestRowsAt(dbPath).find((row) => row.id === id);
  }

  test('NULL·누락 옛 행은 미상(undefined)으로 남고, 기록된 0과 42는 그 값 그대로 읽는다', () => {
    // (a) 칼럼은 있지만 NULL 허용 — 옛 판이 NULL 을 싣던 형태.
    const nullableDb = join(dir, 'nullable.db');
    const nullable = new Database(nullableDb);
    nullable.run(`CREATE TABLE pty_manifest (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, cmd TEXT NOT NULL, owner_pid INTEGER NOT NULL,
      instance TEXT NOT NULL, started_at INTEGER NOT NULL, alive INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      seat TEXT, pty_pid INTEGER NOT NULL DEFAULT 0, output_bytes_total INTEGER)`);
    const insert = (id: string, startedAt: number, total: number | null): void => {
      nullable.run(
        'INSERT INTO pty_manifest (id, kind, cmd, owner_pid, instance, started_at, alive, updated_at, seat, pty_pid, output_bytes_total) VALUES (?, ?, ?, 456, \'test\', ?, 1, 2000, \'OP\', 123, ?)',
        [id, 'pty', 'bash', startedAt, total],
      );
    };
    insert('legacy-null', 10, null);
    insert('recorded-zero', 11, 0);
    insert('recorded-positive', 12, 42);
    nullable.close();
    expect(rowAt(nullableDb, 'legacy-null')?.outputBytesTotal).toBeUndefined();
    expect(rowAt(nullableDb, 'recorded-zero')?.outputBytesTotal).toBe(0);
    expect(rowAt(nullableDb, 'recorded-positive')?.outputBytesTotal).toBe(42);

    // (b) 칼럼 자체가 없는 옛 스키마 — 필드 없는 옛 사건도 미상이다.
    const legacyDb = join(dir, 'legacy.db');
    const legacy = new Database(legacyDb);
    legacy.run(`CREATE TABLE pty_manifest (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, cmd TEXT NOT NULL, owner_pid INTEGER NOT NULL,
      instance TEXT NOT NULL, started_at INTEGER NOT NULL, alive INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      seat TEXT, pty_pid INTEGER NOT NULL DEFAULT 0)`);
    legacy.run(
      'INSERT INTO pty_manifest (id, kind, cmd, owner_pid, instance, started_at, alive, updated_at, seat, pty_pid) VALUES (\'no-column-legacy\', \'pty\', \'bash\', 456, \'test\', 10, 1, 2000, \'OP\', 123)',
    );
    legacy.close();
    expect(rowAt(legacyDb, 'no-column-legacy')?.outputBytesTotal).toBeUndefined();
  });
});

describe('/v1/terminals 요약 — 미상 총계는 칸을 비운다', () => {
  const rows = [
    manifestRow({ id: 'pty-legacy-null', seat: 'OP' }),
    manifestRow({ id: 'pty-recorded-zero', seat: 'OP', outputBytesTotal: 0, startedAt: 1_001 }),
    manifestRow({ id: 'pty-recorded-42', seat: 'OP', outputBytesTotal: 42, startedAt: 1_002 }),
  ];

  test('비연합 경로: NULL/누락/0 은 필드 생략, 양수 42 는 사실로, seat 는 무변', async () => {
    const terminals = await listTerminals(rows, false);
    const byId = new Map(terminals.map((terminal) => [terminal.id as string, terminal]));
    expect(terminals).toHaveLength(3);
    expect(byId.get('pty-legacy-null')).not.toHaveProperty('outputBytesTotal');
    expect(byId.get('pty-recorded-zero')).not.toHaveProperty('outputBytesTotal');
    expect(byId.get('pty-recorded-42')).toMatchObject({ outputBytesTotal: 42 });
    // 미상 총계가 다른 목록 필드를 덮어삼키지 않는다(회귀 보호).
    expect(byId.get('pty-legacy-null')).toMatchObject({ seat: 'OP', alive: true, cmd: 'bash' });
  });

  test('연합 경로(all=true)도 같은 규칙을 적용한다', async () => {
    const terminals = await listTerminals(rows, true);
    const byId = new Map(terminals.map((terminal) => [terminal.id as string, terminal]));
    expect(byId.get('pty-legacy-null')).not.toHaveProperty('outputBytesTotal');
    expect(byId.get('pty-recorded-zero')).not.toHaveProperty('outputBytesTotal');
    expect(byId.get('pty-recorded-42')).toMatchObject({ outputBytesTotal: 42 });
  });

  test('계보 판정(lineageRowFromManifest)과 같은 행에 대해 같은 값을 낸다', async () => {
    const terminals = await listTerminals(rows, false);
    const summaryById = new Map(terminals.map((terminal) => [terminal.id as string, terminal]));
    for (const row of rows) {
      const lineage = lineageRowFor(row);
      const expected = typeof row.outputBytesTotal === 'number' && row.outputBytesTotal > 0;
      expect(Object.prototype.hasOwnProperty.call(lineage, 'outputBytesTotal')).toBe(expected);
      // 목록 요약 규칙과 계보 규칙이 «한 행»에서 갈리면 안 된다(리뷰 지적: 두 엔드포인트가 같은 값을 다르게 판정).
      expect(summaryById.has(row.id)).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(summaryById.get(row.id)!, 'outputBytesTotal')).toBe(expected);
      if (expected) {
        expect(lineage.outputBytesTotal).toBe(row.outputBytesTotal);
        expect(summaryById.get(row.id)!.outputBytesTotal).toBe(row.outputBytesTotal);
      }
    }
  });
});
