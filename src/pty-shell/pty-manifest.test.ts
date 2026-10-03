// 크로스-프로세스 PTY 매니페스트 store 계약 테스트. 격리 tmp ELANOUS_STATE_DIR 로 실제 데이터 무접촉.
//   upsert/list·snapshot throttle(now 주입)·close(alive=0)·remove. reap 은 owner=process.pid 라 유닛 불가(스킵).
import { setDefaultTimeout, afterAll, beforeEach, test, expect, describe } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setGitCommandRunnerForTesting } from '../git-fs/runner.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const previousStateDir = process.env.ELANOUS_STATE_DIR;
const stateDir = mkdtempSync(join(tmpdir(), 'pty-manifest-'));
process.env.ELANOUS_STATE_DIR = stateDir;
let manifestDbPath = '';

const {
  addPtyManifestOutputBytes, upsertPtyManifest, updatePtyManifestSnapshot, updatePtyManifestFrame, readPtyManifestFrame, markPtyManifestClosed,
  removePtyManifest, listPtyManifest, listPtyManifestRows, getPtyManifest, ptyManifestDbPath, setPtyManifestDbPathForTesting,
  purgeClosedPtyManifest, PTY_MANIFEST_CLOSED_TTL_MS, reapOrphanedOwnedPtyManifest,
  reapStalePtyManifest, touchLivePtyManifest, PTY_MANIFEST_STALE_MS, migratePtyManifestSchema,
  listPtyManifestByRun, listPtyManifestAt, listPtyManifestRowsAt, reapDeadPtyManifest, reapDeadPtyManifestAt, markPtyControlled, classifyTerminalOrigin,
  listLongLivedLivePtyManifest,
} = await import('./pty-manifest.js');
const { readPtyEventsAfter, recordSurfaceStateTransition, latestSurfaceState, resetPtyEventLogForTesting } = await import('./pty-event-log.js');
const { ensureRunIdentity } = await import('../harness/harness-space.js');

function lifecycleEvents(ptyId: string) {
  return readPtyEventsAfter(0, { surfaceId: ptyId, kind: 'lifecycle' });
}

beforeEach(() => {
  manifestDbPath = join(mkdtempSync(join(stateDir, 'store-')), 'pty', 'manifest.db');
  setPtyManifestDbPathForTesting(manifestDbPath);
  resetPtyEventLogForTesting();
});
afterAll(() => {
  setPtyManifestDbPathForTesting(null);
  resetPtyEventLogForTesting();
  if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = previousStateDir;
});

describe('terminal origin decisions', () => {
  test('distinguishes human, elanous, external tool, and unknown without conflating missing evidence with human', () => {
    expect(classifyTerminalOrigin({ originRoot: 'human-cli' })).toEqual({ category: 'direct-human', reason: 'inherited-human-cli-marker' });
    expect(classifyTerminalOrigin({ originRoot: 'elanous-internal' })).toEqual({ category: 'elanous', reason: 'inherited-elanous-marker' });
    expect(classifyTerminalOrigin({ originRoot: 'external-agent', originAgent: 'codex' })).toEqual({ category: 'external-tool', reason: 'inherited-external-agent-marker', externalToolName: 'codex' });
    expect(classifyTerminalOrigin({})).toEqual({ category: 'unknown', reason: 'origin-marker-absent' });
  });

  test('treats malformed and conflicting inherited markers as unknown', () => {
    expect(classifyTerminalOrigin({ originRoot: 'external-agent', originAgent: 'bad tool name' })).toEqual({ category: 'unknown', reason: 'invalid-external-tool-marker' });
    expect(classifyTerminalOrigin({ originRoot: 'human-cli', originAgent: 'codex' })).toEqual({ category: 'unknown', reason: 'conflicting-human-agent-marker' });
    expect(classifyTerminalOrigin({ originRoot: 'elanous-internal', originSession: 'run-1' })).toEqual({ category: 'unknown', reason: 'conflicting-monad-agent-marker' });
  });
});

describe('pty-manifest store (크로스-프로세스 관측)', () => {
  test('테스트 seam 은 명시 격리 경로에 실제 행을 만들고 프로덕션 경로 해석은 보존한다', () => {
    upsertPtyManifest({ id: 'seam-path', kind: 'self', cmd: 'x', startedAt: 0, now: 0 });
    expect(ptyManifestDbPath()).toBe(manifestDbPath);
    expect(listPtyManifest().map((row) => row.id)).toContain('seam-path');
    const store = new Database(manifestDbPath, { readonly: true });
    expect(store.query('SELECT id FROM pty_manifest WHERE id=?').get('seam-path')).toEqual({ id: 'seam-path' });
    store.close();
  });

  test('명시 store 경로를 전환하면 이전 store 행을 읽지 않는다', () => {
    const secondStateDir = mkdtempSync(join(tmpdir(), 'pty-manifest-second-'));
    const secondPath = join(secondStateDir, 'pty', 'manifest.db');
    upsertPtyManifest({ id: 'first-store', kind: 'self', cmd: 'x', startedAt: 0, now: 0 });
    setPtyManifestDbPathForTesting(secondPath);
    expect(listPtyManifest()).toEqual([]);
    upsertPtyManifest({ id: 'second-store', kind: 'self', cmd: 'x', startedAt: 0, now: 0 });
    expect(listPtyManifest().map((row) => row.id)).toEqual(['second-store']);
    setPtyManifestDbPathForTesting(manifestDbPath);
    expect(listPtyManifest().map((row) => row.id)).toContain('first-store');
    rmSync(secondStateDir, { recursive: true, force: true });
  });

  test('listPtyManifestAt — 외부 DB를 readonly로 열어 frame 행만 started_at 순으로 읽고 변경하지 않는다', async () => {
    const path = join(stateDir, 'external-manifest.db');
    rmSync(path, { force: true });
    const d = new Database(path);
    d.run(`CREATE TABLE pty_manifest (id TEXT PRIMARY KEY, kind TEXT NOT NULL, cmd TEXT NOT NULL, workdir TEXT, owner_pid INTEGER NOT NULL, instance TEXT NOT NULL, started_at INTEGER NOT NULL, alive INTEGER NOT NULL, exit_code INTEGER, snapshot TEXT NOT NULL DEFAULT '', snapshot_at INTEGER NOT NULL DEFAULT 0, frame TEXT NOT NULL DEFAULT '', frame_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`);
    d.run(`INSERT INTO pty_manifest VALUES ('late','self','x',NULL,1,'other',20,1,NULL,'',0,'\x1b[31mlate',200,200)`);
    d.run(`INSERT INTO pty_manifest VALUES ('empty','self','x',NULL,1,'other',10,1,NULL,'',0,'',0,100)`);
    d.run(`INSERT INTO pty_manifest VALUES ('early','self','x',NULL,1,'other',5,1,NULL,'',0,'early',100,100)`);
    d.close();
    const before = statSync(path);
    expect(listPtyManifestAt(path).map((row) => row.id)).toEqual(['early', 'late']);
    expect(listPtyManifestRowsAt(path).map((row) => row.id)).toEqual(['early', 'empty', 'late']);
    const after = statSync(path);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(listPtyManifestAt(join(stateDir, 'missing.db'))).toEqual([]);
    const corrupt = join(stateDir, 'corrupt-manifest.db');
    await Bun.write(corrupt, 'not sqlite');
    expect(listPtyManifestAt(corrupt)).toEqual([]);
  });

  test('fresh WAL registration is visible to a separate readonly process before checkpoint', () => {
    upsertPtyManifest({ id: 'fresh-wal', kind: 'tui', cmd: 'elanous', startedAt: 1, now: 1 });
    expect(listPtyManifestRowsAt(manifestDbPath).map((row) => row.id)).toContain('fresh-wal');
    const script = `const { Database } = require('bun:sqlite'); const d = new Database(process.argv.at(-1), { readonly: true }); console.log(d.query('SELECT id FROM pty_manifest WHERE id=?').get('fresh-wal').id); d.close();`;
    const output = execFileSync(process.execPath, ['-e', script, manifestDbPath], { encoding: 'utf8' }).trim();
    expect(output).toBe('fresh-wal');
  });

  test('upsert → list 에 등록(owner_pid=현재 프로세스·alive)', () => {
    upsertPtyManifest({ id: 'self_a1', kind: 'self', cmd: 'bun elanous.mjs', workdir: '/wt', startedAt: 100, now: 1000 });
    const rows = listPtyManifest();
    const r = rows.find((x) => x.id === 'self_a1')!;
    expect(r).toBeTruthy();
    expect(r.kind).toBe('self');
    expect(r.ownerPid).toBe(process.pid);
    expect(r.ptyPid).toBe(0);
    expect(r.alive).toBe(true);
    expect(r.workdir).toBe('/wt');
  });

  test('upsert ptyPid maps the pty_pid column into PtyManifestRow', () => {
    upsertPtyManifest({ id: 'pty-pid-mapped', kind: 'tui', cmd: 'x', startedAt: 1, now: 1, ptyPid: process.pid });
    expect(getPtyManifest('pty-pid-mapped')?.ptyPid).toBe(process.pid);
    expect(listPtyManifestRows().find((row) => row.id === 'pty-pid-mapped')?.ptyPid).toBe(process.pid);
    expect(listPtyManifest().find((row) => row.id === 'pty-pid-mapped')?.ptyPid).toBe(process.pid);
  });

  test('lastControlAt is absent until control is marked, then records only the control axis', () => {
    upsertPtyManifest({ id: 'control-timestamp', kind: 'tui', cmd: 'x', startedAt: 1, now: 10_000 });
    expect(getPtyManifest('control-timestamp')?.lastControlAt).toBeUndefined();

    markPtyControlled('control-timestamp', 20_000);
    expect(getPtyManifest('control-timestamp')).toMatchObject({ lastControlAt: 20_000, updatedAt: 10_000 });
    expect(listPtyManifestRowsAt(manifestDbPath).find((row) => row.id === 'control-timestamp')).toMatchObject({ lastControlAt: 20_000, updatedAt: 10_000 });

    expect(() => markPtyControlled('missing-control-timestamp', 30_000)).not.toThrow();
  });

  test('public list reaps dead PTYs while the find/retire reader remains non-reaping', () => {
    const deadPid = 999_999;
    upsertPtyManifest({ id: 'reader-contract', kind: 'tui', cmd: 'x', startedAt: 1, now: Date.now(), ptyPid: deadPid });
    expect(listPtyManifestRows().find((row) => row.id === 'reader-contract')?.alive).toBe(true);
    expect(listPtyManifest().find((row) => row.id === 'reader-contract')?.alive).toBe(false);
  });

  test('동일 PTY ID upsert는 manifest를 갱신하지만 spawned lifecycle 사건을 중복 기록하지 않는다', () => {
    upsertPtyManifest({ id: 'spawn-once', kind: 'self', cmd: 'first', startedAt: 100, now: 1_000 });
    upsertPtyManifest({ id: 'spawn-once', kind: 'tui', cmd: 'second', workdir: '/next', startedAt: 200, now: 2_000 });

    expect(getPtyManifest('spawn-once')).toMatchObject({ kind: 'tui', cmd: 'second', workdir: '/next', startedAt: 200, updatedAt: 2_000, alive: true });
    expect(lifecycleEvents('spawn-once').filter((event) => JSON.parse(event.payload!).event === 'spawned')).toHaveLength(1);
  });

  test('upsert identity는 정의된 필드만 갱신하고 생략된 필드는 기존 identity를 각각 보존한다', () => {
    upsertPtyManifest({
      id: 'identity-merge', kind: 'self', cmd: 'first', startedAt: 100, now: 1_000,
      identity: { spaceId: 'space-a', parentPtyId: 'parent-a', parentPid: 101 },
    });
    upsertPtyManifest({
      id: 'identity-merge', kind: 'self', cmd: 'second', startedAt: 200, now: 2_000,
      identity: { parentPtyId: 'parent-b' },
    });

    expect(getPtyManifest('identity-merge')).toMatchObject({
      spaceId: 'space-a', parentPtyId: 'parent-b', parentPid: 101,
    });
  });

  test('종료된 동일 PTY ID를 재등록하면 alive=0→1 전이에 spawned lifecycle 사건을 남긴다', () => {
    upsertPtyManifest({ id: 'spawn-revived', kind: 'self', cmd: 'first', startedAt: 100, now: 1_000 });
    markPtyManifestClosed('spawn-revived', 0, 1_001);
    upsertPtyManifest({ id: 'spawn-revived', kind: 'tui', cmd: 'second', startedAt: 2_000, now: 2_000 });

    expect(getPtyManifest('spawn-revived')).toMatchObject({ alive: true, kind: 'tui', cmd: 'second', startedAt: 2_000 });
    expect(lifecycleEvents('spawn-revived').filter((event) => JSON.parse(event.payload!).event === 'spawned')).toHaveLength(2);
  });

  test('등록은 workdir의 Git HEAD를 code_sha/codeSha로 기록한다', () => {
    const expectedSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
    upsertPtyManifest({ id: 'code-sha', kind: 'self', cmd: 'x', workdir: process.cwd(), startedAt: 101, now: 1001 });
    const row = getPtyManifest('code-sha')!;
    expect(row.codeSha).toBe(expectedSha);
    const store = new Database(manifestDbPath, { readonly: true });
    expect((store.query('SELECT code_sha FROM pty_manifest WHERE id=?').get('code-sha') as { code_sha: string }).code_sha).toBe(expectedSha);
    store.close();
  });

  test('Git HEAD 조회가 실패하거나 workdir가 없더라도 빈 codeSha로 PTY를 등록한다', () => {
    setGitCommandRunnerForTesting(() => ({ status: 128, stdout: 'misleading output', stderr: 'fatal: no repository' }));
    try {
      upsertPtyManifest({ id: 'code-sha-failure', kind: 'self', cmd: 'x', workdir: '/not-a-repository', startedAt: 102, now: 1002 });
      upsertPtyManifest({ id: 'code-sha-missing-workdir', kind: 'self', cmd: 'x', startedAt: 103, now: 1003 });
    } finally {
      setGitCommandRunnerForTesting(undefined);
    }
    expect(getPtyManifest('code-sha-failure')).toMatchObject({ alive: true, codeSha: '' });
    expect(getPtyManifest('code-sha-missing-workdir')).toMatchObject({ alive: true, codeSha: '' });
  });

  test('snapshot throttle — now 간격 <1500ms 은 skip, ≥1500ms 은 write', () => {
    upsertPtyManifest({ id: 'self_b2', kind: 'self', cmd: 'x', startedAt: 0, now: 1_000_000 });
    updatePtyManifestSnapshot('self_b2', () => 'first', 1_000_000);
    expect(getPtyManifest('self_b2')!.snapshot).toBe('first');
    updatePtyManifestSnapshot('self_b2', () => 'skipped', 1_000_500);
    expect(getPtyManifest('self_b2')!.snapshot).toBe('first');
    updatePtyManifestSnapshot('self_b2', () => 'second', 1_002_000);
    expect(getPtyManifest('self_b2')!.snapshot).toBe('second');
  });

  test('snapshot getter 는 throttle 통과 시에만 호출(매 chunk snapshot() 방지)', () => {
    upsertPtyManifest({ id: 'self_c3', kind: 'self', cmd: 'x', startedAt: 0, now: 2_000_000 });
    let calls = 0;
    const getter = () => { calls++; return 'snap'; };
    updatePtyManifestSnapshot('self_c3', getter, 2_000_000);
    updatePtyManifestSnapshot('self_c3', getter, 2_000_100);
    expect(calls).toBe(1);
  });

  test('output bytes total is a monotonic additive counter and heartbeat does not change it', () => {
    upsertPtyManifest({ id: 'output-bytes', kind: 'self', cmd: 'x', startedAt: 0, now: 2_100_000 });
    expect(getPtyManifest('output-bytes')?.outputBytesTotal).toBe(0);
    expect(addPtyManifestOutputBytes('output-bytes', 4, 2_100_001)).toBe(true);
    expect(addPtyManifestOutputBytes('output-bytes', 7, 2_100_002)).toBe(true);
    touchLivePtyManifest(new Set(['output-bytes']), 2_100_003);
    expect(getPtyManifest('output-bytes')).toMatchObject({ outputBytesTotal: 11, updatedAt: 2_100_003 });
    expect(listPtyManifestRowsAt(manifestDbPath).find((row) => row.id === 'output-bytes')?.outputBytesTotal).toBe(11);
  });

  test('output bytes retain an uncommitted delta until a later manifest update can commit it', () => {
    expect(addPtyManifestOutputBytes('output-bytes-retry', 9, 2_200_000)).toBe(false);
    upsertPtyManifest({ id: 'output-bytes-retry', kind: 'self', cmd: 'x', startedAt: 0, now: 2_200_001 });
    expect(addPtyManifestOutputBytes('output-bytes-retry', 9, 2_200_002)).toBe(true);
    expect(getPtyManifest('output-bytes-retry')).toMatchObject({ outputBytesTotal: 9, updatedAt: 2_200_002 });
  });

  test('markClosed → alive=0·exitCode 보존·최종 snapshot 유지', () => {
    upsertPtyManifest({ id: 'self_d4', kind: 'self', cmd: 'x', startedAt: 0, now: 3_000_000 });
    updatePtyManifestSnapshot('self_d4', () => 'final screen', 3_000_000);
    markPtyManifestClosed('self_d4', 0, 3_000_100);
    const r = getPtyManifest('self_d4')!;
    expect(r.alive).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.snapshot).toBe('final screen');
  });

  test('markClosed 는 alive=1→0 실제 전이에만 exited lifecycle 사건을 남긴다', () => {
    upsertPtyManifest({ id: 'close-once', kind: 'self', cmd: 'x', startedAt: 0, now: 3_100_000 });
    markPtyManifestClosed('close-once', 0, 3_100_001);
    markPtyManifestClosed('close-once', 1, 3_100_002);
    const exited = lifecycleEvents('close-once').filter((event) => JSON.parse(event.payload!).event === 'exited');
    expect(exited).toHaveLength(1);
    expect(JSON.parse(exited[0]!.payload!)).toMatchObject({ exitCode: 0, closedAt: 3_100_001 });
  });

  test('remove → 완전 삭제', () => {
    upsertPtyManifest({ id: 'self_e5', kind: 'self', cmd: 'x', startedAt: 0, now: 4_000_000 });
    expect(getPtyManifest('self_e5')).toBeTruthy();
    removePtyManifest('self_e5');
    expect(getPtyManifest('self_e5')).toBeNull();
  });

  test('purge(TTL) → grace 지난 종료 행만 제거·최근 종료+라이브 보존', () => {
    const t0 = 10_000_000;
    upsertPtyManifest({ id: 'p_old', kind: 'self', cmd: 'x', startedAt: 0, now: t0 });
    markPtyManifestClosed('p_old', 0, t0);
    upsertPtyManifest({ id: 'p_recent', kind: 'self', cmd: 'x', startedAt: 0, now: t0 });
    markPtyManifestClosed('p_recent', 0, t0);
    upsertPtyManifest({ id: 'p_live', kind: 'self', cmd: 'x', startedAt: 0, now: t0 });

    markPtyManifestClosed('p_recent', 0, t0 + PTY_MANIFEST_CLOSED_TTL_MS);
    const purged = purgeClosedPtyManifest(t0 + PTY_MANIFEST_CLOSED_TTL_MS + 1);

    expect(purged).toBeGreaterThanOrEqual(1);
    expect(getPtyManifest('p_old')).toBeNull();
    expect(getPtyManifest('p_recent')).toBeTruthy();
    expect(getPtyManifest('p_live')!.alive).toBe(true);
  });

  test('purge(ttlMs<=0·--all) → 모든 종료 행 즉시 제거·라이브 보존', () => {
    const t = 20_000_000;
    upsertPtyManifest({ id: 'a_dead1', kind: 'self', cmd: 'x', startedAt: 0, now: t });
    markPtyManifestClosed('a_dead1', 0, t);
    upsertPtyManifest({ id: 'a_dead2', kind: 'self', cmd: 'x', startedAt: 0, now: t });
    markPtyManifestClosed('a_dead2', 1, t);
    upsertPtyManifest({ id: 'a_live', kind: 'self', cmd: 'x', startedAt: 0, now: t });

    const purged = purgeClosedPtyManifest(t, 0);
    expect(purged).toBeGreaterThanOrEqual(2);
    expect(getPtyManifest('a_dead1')).toBeNull();
    expect(getPtyManifest('a_dead2')).toBeNull();
    expect(getPtyManifest('a_live')!.alive).toBe(true);
    expect(listPtyManifest().every((r) => r.alive)).toBe(true);
  });

  test('reapOrphanedOwned → owner=self 인데 in-process 라이브 아닌 fake-alive orphan 제거', () => {
    upsertPtyManifest({ id: 'orph_live', kind: 'self', cmd: 'bun', startedAt: 0, now: 30_000_000 });
    upsertPtyManifest({ id: 'orph_ghost', kind: 'self', cmd: 'foo', startedAt: 0, now: 30_000_000 });
    const removed = reapOrphanedOwnedPtyManifest(new Set(['orph_live']));
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(getPtyManifest('orph_ghost')).toBeNull();
    expect(getPtyManifest('orph_live')).toBeTruthy();
  });

  test('reapStale → 하트비트 끊긴 alive=1 유령 제거·최근 하트비트 행 보존', () => {
    const t0 = 40_000_000;
    upsertPtyManifest({ id: 'stale_ghost', kind: 'self', cmd: 'echo hi', startedAt: 0, now: t0 });
    upsertPtyManifest({ id: 'stale_fresh', kind: 'self', cmd: 'bun', startedAt: 0, now: t0 });
    const later = t0 + PTY_MANIFEST_STALE_MS + 1;
    touchLivePtyManifest(new Set(['stale_fresh']), later);
    const removed = reapStalePtyManifest(later + 1);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(getPtyManifest('stale_ghost')).toBeNull();
    expect(getPtyManifest('stale_fresh')).toBeTruthy();
    const events = lifecycleEvents('stale_ghost');
    expect(JSON.parse(events.at(-1)!.payload!)).toMatchObject({ event: 'seen-stale', ptyId: 'stale_ghost', cmd: 'echo hi' });
    expect(events.at(-1)!.state).toBeNull();
  });

  test('purge 대상이 없으면 lifecycle 원장 행을 추가하지 않는다', () => {
    const before = readPtyEventsAfter(0, { kind: 'lifecycle' }).length;
    expect(purgeClosedPtyManifest(50_000_000, 0)).toBe(0);
    expect(readPtyEventsAfter(0, { kind: 'lifecycle' })).toHaveLength(before);
  });

  test('원장 쓰기 실패는 stale 삭제를 막지 않고 ledger-write-failed를 남긴다', () => {
    const blockedStateDir = mkdtempSync(join(tmpdir(), 'pty-eventlog-blocked-'));
    const childStateDir = mkdtempSync(join(tmpdir(), 'pty-manifest-child-'));
    try {
      const blockedStatePath = join(blockedStateDir, 'state-file');
      writeFileSync(blockedStatePath, 'not a directory');
      const manifestPath = join(childStateDir, 'pty', 'manifest.db');
      const manifestModule = join(process.cwd(), 'src', 'pty-shell', 'pty-manifest.ts');
      const debugModule = join(process.cwd(), 'src', 'debug', 'log.ts');
      const script = `
        process.env.ELANOUS_STATE_DIR = process.argv.at(-2);
        const manifestPath = process.argv.at(-1);
        const { debug } = await import(${JSON.stringify(debugModule)});
        debug.enable();
        const { setPtyManifestDbPathForTesting, upsertPtyManifest, reapStalePtyManifest } = await import(${JSON.stringify(manifestModule)});
        setPtyManifestDbPathForTesting(manifestPath);
        upsertPtyManifest({ id: 'ledger-failure', kind: 'self', cmd: 'x', startedAt: 0, now: 0 });
        const removed = reapStalePtyManifest(2, 1);
        console.log(JSON.stringify({ removed, events: debug.events().filter((event) => event.category === 'pty.manifest' && event.event === 'ledger-write-failed' && (event.data as { event?: string } | undefined)?.event === 'seen-stale') }));
      `;
      const result = JSON.parse(execFileSync(process.execPath, ['-e', script, blockedStatePath, manifestPath], { encoding: 'utf8' })) as {
        removed: number;
        events: Array<{ data?: unknown }>;
      };
      expect(result.removed).toBe(1);
      expect(result.events).toEqual([expect.objectContaining({ data: expect.objectContaining({ ptyId: 'ledger-failure', event: 'seen-stale' }) })]);
    } finally {
      rmSync(blockedStateDir, { recursive: true, force: true });
      rmSync(childStateDir, { recursive: true, force: true });
    }
  });

  test('lifecycle 원장은 spawn·exit·purge·orphan·remove를 상태 전이와 분리해 보존한다', () => {
    const t = 50_000_000;
    upsertPtyManifest({ id: 'lifecycle-purge', kind: 'self', cmd: 'purge', workdir: '/work', startedAt: t - 1, now: t });
    markPtyManifestClosed('lifecycle-purge', 17, t + 1);
    expect(purgeClosedPtyManifest(t + 2, 0)).toBeGreaterThanOrEqual(1);
    const purged = lifecycleEvents('lifecycle-purge').map((event) => JSON.parse(event.payload!));
    expect(purged).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'spawned', ptyId: 'lifecycle-purge', cmd: 'purge', startedAt: t - 1 }),
      expect.objectContaining({ event: 'exited', exitCode: 17, closedAt: t + 1 }),
      expect.objectContaining({ event: 'seen-purge', exitCode: 17, closedAt: t + 1 }),
    ]));

    upsertPtyManifest({ id: 'lifecycle-orphan', kind: 'self', cmd: 'orphan', startedAt: t, now: t });
    expect(reapOrphanedOwnedPtyManifest(new Set())).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(lifecycleEvents('lifecycle-orphan').at(-1)!.payload!)).toMatchObject({ event: 'seen-orphan', ptyId: 'lifecycle-orphan' });

    upsertPtyManifest({ id: 'lifecycle-remove', kind: 'self', cmd: 'remove', startedAt: t, now: t });
    removePtyManifest('lifecycle-remove');
    expect(JSON.parse(lifecycleEvents('lifecycle-remove').at(-1)!.payload!)).toMatchObject({ event: 'seen-remove', ptyId: 'lifecycle-remove' });

    recordSurfaceStateTransition({ instance: 'test', surfaceId: 'lifecycle-remove', state: 'working', now: t });
    expect(latestSurfaceState('lifecycle-remove')).toMatchObject({ state: 'working' });
  });

  test('updatePtyManifestFrame → frame/frameAt write (snapshot 과 독립 컬럼)', () => {
    upsertPtyManifest({ id: 'fr_a', kind: 'tui', cmd: 'elanous', startedAt: 0, now: 60_000_000 });
    updatePtyManifestSnapshot('fr_a', () => 'RAW-ANSI', 60_000_000);
    updatePtyManifestFrame('fr_a', () => '\u276f /command\n status', 60_000_000);
    const r = getPtyManifest('fr_a')!;
    expect(r.frame).toBe('\u276f /command\n status');
    expect(r.frameAt).toBe(60_000_000);
    expect(r.snapshot).toBe('RAW-ANSI');
  });

  test('readPtyManifestFrame returns a stamped frame only', () => {
    upsertPtyManifest({ id: 'fr_read', kind: 'tui', cmd: 'elanous', startedAt: 0, now: 60_500_000 });
    expect(readPtyManifestFrame('fr_read')).toBeNull();
    updatePtyManifestFrame('fr_read', () => 'reported screen', 60_500_000);
    expect(readPtyManifestFrame('fr_read')).toEqual({ frame: 'reported screen', frameAt: 60_500_000 });
  });

  test('frame throttle — <1500ms skip, ≥1500ms write (getter 도 skip 시 미호출)', () => {
    upsertPtyManifest({ id: 'fr_b', kind: 'tui', cmd: 'x', startedAt: 0, now: 61_000_000 });
    let calls = 0;
    updatePtyManifestFrame('fr_b', () => { calls++; return 'frame-1'; }, 61_000_000);
    updatePtyManifestFrame('fr_b', () => { calls++; return 'frame-x'; }, 61_000_500);
    updatePtyManifestFrame('fr_b', () => { calls++; return 'frame-2'; }, 61_002_000);
    expect(calls).toBe(2);
    expect(getPtyManifest('fr_b')!.frame).toBe('frame-2');
  });

  test('신규 db 는 frame 기본 \'\'(마이그레이션/컬럼 존재 보장)', () => {
    upsertPtyManifest({ id: 'fr_c', kind: 'tui', cmd: 'x', startedAt: 0, now: 62_000_000 });
    expect(getPtyManifest('fr_c')!.frame).toBe('');
    expect(getPtyManifest('fr_c')!.frameAt).toBe(0);
  });

  test('touchLivePtyManifest → 남의 owner·종료행 무접촉(자기 라이브만 갱신)', () => {
    const t = 50_000_000;
    upsertPtyManifest({ id: 'hb_live', kind: 'self', cmd: 'x', startedAt: 0, now: t });
    upsertPtyManifest({ id: 'hb_closed', kind: 'self', cmd: 'x', startedAt: 0, now: t });
    markPtyManifestClosed('hb_closed', 0, t);
    touchLivePtyManifest(new Set(['hb_live', 'hb_closed']), t + 5000);
    expect(getPtyManifest('hb_live')!.updatedAt).toBe(t + 5000);
    expect(getPtyManifest('hb_closed')!.updatedAt).toBe(t);
  });
});

describe('reapDeadPtyManifest — 생존은 PTY 자신의 프로세스로 본다(등록자가 아니라)', () => {
  const DEAD_PID = 999_999;

  function insert(id: string, ownerPid: number, ptyPid: number): void {
    const d = new Database(manifestDbPath);
    d.run(
      `INSERT INTO pty_manifest (id,kind,cmd,owner_pid,pty_pid,instance,started_at,alive,exit_code,updated_at)
       VALUES (?,?,?,?,?,?,?,1,NULL,?)`,
      [id, 'pty', 'x', ownerPid, ptyPid, 'i', 1, 1],
    );
    d.close();
  }

  test('⭐ 등록자가 죽어도 PTY 가 살아 있으면 눕히지 않는다', () => {
    upsertPtyManifest({ id: 'seed', kind: 'pty', cmd: 'x', startedAt: 1, now: 1 });
    insert('held', DEAD_PID, process.pid);
    reapDeadPtyManifest();
    expect(listPtyManifest().find((r) => r.id === 'held')?.alive).toBe(true);
  });

  test('⭐ 등록자가 살아 있어도 PTY 가 죽었으면 눕히고 PTY 판정을 보존한다', () => {
    upsertPtyManifest({ id: 'seed2', kind: 'pty', cmd: 'x', startedAt: 1, now: 1 });
    insert('gone', process.pid, DEAD_PID);
    reapDeadPtyManifest();
    expect(listPtyManifest().find((r) => r.id === 'gone')).toMatchObject({ alive: false, livenessSource: 'pty-pid' });
  });

  test('⛔ pty_pid 가 0(legacy·자기보고)이면 종전대로 등록자로 판정하고 출처를 보존한다', () => {
    upsertPtyManifest({ id: 'seed3', kind: 'pty', cmd: 'x', startedAt: 1, now: 1 });
    insert('legacy', DEAD_PID, 0);
    reapDeadPtyManifest();
    expect(listPtyManifest().find((r) => r.id === 'legacy')).toMatchObject({ alive: false, livenessSource: 'owner-pid' });
  });

  test('⭐ 같은 등록자 아래에서도 행마다 따로 판정한다', () => {
    upsertPtyManifest({ id: 'seed4', kind: 'pty', cmd: 'x', startedAt: 1, now: 1 });
    insert('sib-live', DEAD_PID, process.pid);
    insert('sib-dead', DEAD_PID, DEAD_PID);
    reapDeadPtyManifest();
    const rows = listPtyManifest();
    expect(rows.find((r) => r.id === 'sib-live')?.alive).toBe(true);
    expect(rows.find((r) => r.id === 'sib-dead')?.alive).toBe(false);
  });
});

// ── 살아 있는 장기 실행 화면 (읽기 전용 계수) ──
// 의도적 경계: 이 describe 는 새 진입을 시험이 직접 호출한다. 화면 종료·생성 방식
// 변경·명령/UI 연결은 다음 조각이다(끌지 말지는 사람이 정할 일이고, 지금 만드는 것은
// 그 판단에 쓸 값이다).
describe('listLongLivedLivePtyManifest — 살아 있는 장기 실행 화면 (읽기 전용)', () => {
  const HOUR = 60 * 60 * 1000;
  const DEAD_PID = 999_999;

  function tableRowCount(): number {
    const d = new Database(manifestDbPath, { readonly: true });
    try {
      return (d.query('SELECT COUNT(*) AS n FROM pty_manifest').get() as { n: number }).n;
    } finally {
      d.close();
    }
  }

  function insertAlive(id: string, ownerPid: number, ptyPid: number, startedAt: number, updatedAt: number): void {
    const d = new Database(manifestDbPath);
    d.run(
      `INSERT INTO pty_manifest (id,kind,cmd,owner_pid,pty_pid,instance,started_at,alive,exit_code,updated_at)
       VALUES (?,?,?,?,?,?,?,1,NULL,?)`,
      [id, 'pty', 'x', ownerPid, ptyPid, 'i', startedAt, updatedAt],
    );
    d.close();
  }

  test('미탐: 소유가 살아 있고 하트비트도 최근인데 시작한 지 오래된 화면을 센다', () => {
    const now = 90_000_000;
    const startedAt = now - 3 * 24 * HOUR;
    upsertPtyManifest({ id: 'forgotten-live', kind: 'tui', cmd: 'elanous tui', startedAt, now });
    expect(reapStalePtyManifest(now)).toBe(0);
    expect(reapDeadPtyManifest()).toBe(0);
    const found = listLongLivedLivePtyManifest(now, 24 * HOUR);
    expect(found.map((row) => row.id)).toEqual(['forgotten-live']);
  });

  test('미탐: 세어진 값으로 그 화면의 나이를 알 수 있다', () => {
    const now = 91_000_000;
    const startedAt = now - 2 * 24 * HOUR - 3_500;
    upsertPtyManifest({ id: 'forgotten-age', kind: 'tui', cmd: 'elanous tui', startedAt, now });
    const found = listLongLivedLivePtyManifest(now, 24 * HOUR);
    expect(found).toHaveLength(1);
    expect(found[0]!.ageMs).toBe(now - startedAt);
    expect(found[0]!.startedAt).toBe(startedAt);
  });

  test('미탐: 「오래」 기준을 다르게 주면 세어지는 것이 달라진다', () => {
    const now = 92_000_000;
    upsertPtyManifest({ id: 'old-10h', kind: 'tui', cmd: 'x', startedAt: now - 10 * HOUR, now });
    upsertPtyManifest({ id: 'old-2h', kind: 'tui', cmd: 'x', startedAt: now - 2 * HOUR, now });
    expect(listLongLivedLivePtyManifest(now, 3 * HOUR).map((row) => row.id)).toEqual(['old-10h']);
    expect(listLongLivedLivePtyManifest(now, 1 * HOUR).map((row) => row.id)).toEqual(['old-10h', 'old-2h']);
  });

  test('과탐: 방금 시작한 화면은 안 세어진다', () => {
    const now = 93_000_000;
    upsertPtyManifest({ id: 'just-started', kind: 'tui', cmd: 'x', startedAt: now, now });
    expect(listLongLivedLivePtyManifest(now, HOUR)).toEqual([]);
  });

  test('과탐: 읽기 전용 진입 호출 전후로 테이블 행 수가 바뀌지 않는다', () => {
    const now = 94_000_000;
    upsertPtyManifest({ id: 'count-live', kind: 'tui', cmd: 'x', startedAt: now - 5 * HOUR, now });
    upsertPtyManifest({ id: 'count-fresh', kind: 'tui', cmd: 'x', startedAt: now, now });
    const before = tableRowCount();
    expect(before).toBeGreaterThanOrEqual(2);
    listLongLivedLivePtyManifest(now, HOUR);
    expect(tableRowCount()).toBe(before);
    expect(getPtyManifest('count-live')?.alive).toBe(true);
    expect(getPtyManifest('count-fresh')?.alive).toBe(true);
  });

  test('불변식: 갱신이 끊긴 행 걷어내기는 이 변경 전과 같다', () => {
    const t0 = 95_000_000;
    upsertPtyManifest({ id: 'stale-ghost', kind: 'self', cmd: 'echo hi', startedAt: 0, now: t0 });
    upsertPtyManifest({ id: 'stale-fresh', kind: 'self', cmd: 'bun', startedAt: 0, now: t0 });
    const later = t0 + PTY_MANIFEST_STALE_MS + 1;
    touchLivePtyManifest(new Set(['stale-fresh']), later);
    const removed = reapStalePtyManifest(later + 1);
    expect(removed).toBe(1);
    expect(getPtyManifest('stale-ghost')).toBeNull();
    expect(getPtyManifest('stale-fresh')).toBeTruthy();
  });

  test('불변식: 소유가 죽은 행 걷어내기는 이 변경 전과 같다', () => {
    upsertPtyManifest({ id: 'dead-seed', kind: 'pty', cmd: 'x', startedAt: 1, now: 1 });
    insertAlive('dead-pty', process.pid, DEAD_PID, 1, 1);
    insertAlive('live-pty', process.pid, process.pid, 1, 1);
    const tombstoned = reapDeadPtyManifest();
    expect(tombstoned).toBe(1);
    expect(getPtyManifest('dead-pty')?.alive).toBe(false);
    expect(getPtyManifest('live-pty')?.alive).toBe(true);
    expect(tableRowCount()).toBe(3);
  });

  test('불변식: 갱신 시각을 올리는 진입은 자기 라이브 행만 건드린다', () => {
    const t = 96_000_000;
    upsertPtyManifest({ id: 'hb-live', kind: 'self', cmd: 'x', startedAt: 0, now: t });
    upsertPtyManifest({ id: 'hb-closed', kind: 'self', cmd: 'x', startedAt: 0, now: t });
    markPtyManifestClosed('hb-closed', 0, t);
    touchLivePtyManifest(new Set(['hb-live', 'hb-closed']), t + 5000);
    expect(getPtyManifest('hb-live')!.updatedAt).toBe(t + 5000);
    expect(getPtyManifest('hb-closed')!.updatedAt).toBe(t);
  });
});
