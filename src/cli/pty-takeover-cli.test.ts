import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setGitCommandRunnerForTesting } from '../git-fs/runner.js';
import { RemotesStore } from './remotes.js';
import { federatedPtyRefs, findPtyManifestRows, joinPtyLineage, ptyGitDiscoveryEnv, registerPtyTakeoverCommands, resolvePtyWorktreeProvenance, runPtyFind, runPtyLineage, runPtyList, runPtyReap, runPtyRelease, runPtyRetire, runPtySnapshot, runPtyText, runPtyMouse, type PtyTakeoverCommandDeps } from './pty-takeover-cli.js';
import { PTY_MANIFEST_CLOSED_TTL_MS, reapDeadPtyManifestAt, setPtyManifestDbPathForTesting, upsertPtyManifest, type PtyManifestRow } from '../pty-shell/pty-manifest.js';
import { enqueueControlMemo } from '../harness/control-inbox.js';
import type { PtyEventRow } from '../pty-shell/pty-event-log.js';
import type { PtyControlResult } from '../pty-shell/pty-control-ipc.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

function row(overrides: Partial<PtyManifestRow> = {}): PtyManifestRow {
  return {
    id: 'pty_default', kind: 'pty', cmd: 'bun', ownerPid: 1, ptyPid: 0, instance: 'test', startedAt: 10,
    alive: true, exitCode: null, snapshot: '', snapshotAt: 0, outputBytesTotal: 0, updatedAt: 10, frame: '', frameAt: 0,
    runId: '', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
    ...overrides,
  };
}

function event(seq: number, tsMs: number, payload: unknown): PtyEventRow {
  return { seq, tsMs, instance: 'test', surfaceId: 'pty', kind: 'lifecycle', state: null, agent: null, payload: JSON.stringify(payload) };
}

function lineageDeps(manifestRows: readonly PtyManifestRow[], lifecycleRows: readonly PtyEventRow[]): PtyTakeoverCommandDeps {
  return {
    getPty: () => undefined,
    requestPtyTakeover: () => false,
    requestRemote: async () => ({ status: 'unknown-pty' }),
    listManifestRows: () => manifestRows,
    readLifecycleRows: () => lifecycleRows,
    log: () => {},
  };
}

describe('pty install-tool wiring', () => {
  test('real CLI entrypoint rejects an absent PTY ref instead of reporting already', () => {
    const ref = `missing-pty-install-${process.pid}-${Date.now()}`;
    const result = spawnSync(process.execPath, ['bin/elanous.mjs', '--test', 'pty', 'install-tool', ref, 'jq'], {
      cwd: join(import.meta.dir, '../..'),
      env: { ...process.env, NODE_ENV: 'test' },
      encoding: 'utf8', timeout: 30_000,
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    expect(result.status).toBe(1);
    expect(output).toContain(ref);
    expect(output).toContain('PTY probe unavailable');
    expect(output).not.toContain('pty install-tool: already');
  });
  test('Commander invokes smoke-first installer in the supplied PTY and reports its outcome', async () => {
    const stdout: string[] = [];
    const originalOut = process.stdout.write;
    const originalErr = process.stderr.write;
    const typed: string[] = [];
    let checks = 0;
    process.stdout.write = ((chunk: string) => { stdout.push(chunk); return true; }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const program = new Command();
      registerPtyTakeoverCommands(program, lineageDeps([], []), {
        exec: () => ({ status: 0, stdout: `${++checks}` }),
        typeLine: (ref, line) => { expect(ref).toBe('pty-from-cli'); typed.push(line); },
        waitIdle: () => '$', decision: () => {}, log: () => {},
      });
      await program.parseAsync(['node', 'elanous', 'pty', 'install-tool', 'pty-from-cli', 'jq']);
      expect(checks).toBe(1);
      expect(typed).toEqual([]);
      expect(stdout.join('')).toContain('already');
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
      process.exitCode = 0;
    }
  });

  test('codex help does not claim authenticated readiness without login notice', async () => {
    const stdout: string[] = [];
    const originalOut = process.stdout.write;
    const originalErr = process.stderr.write;
    process.stdout.write = ((chunk: string) => { stdout.push(chunk); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => { stdout.push(chunk); return true; }) as typeof process.stderr.write;
    try {
      const program = new Command();
      registerPtyTakeoverCommands(program, lineageDeps([], []), {
        exec: (cmd) => cmd[1] === '--help' ? { status: 0, stdout: 'codex help' } : { status: 1, stdout: 'Not logged in' }, decision: () => {}, log: () => {},
      });
      await program.parseAsync(['node', 'elanous', 'pty', 'install-tool', 'pty-from-cli', 'codex']);
      expect(stdout.join('')).toContain('codex authentication not verified; run codex login');
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
      process.exitCode = 0;
    }
  });
});

describe('federatedPtyRefs', () => {
  test('carries supplied updatedAt values and omits the key when a live row does not supply one', () => {
    const listing = federatedPtyRefs(
      [{ name: 'test', dbPath: '/test/pty/manifest.db' }],
      () => [
        { id: 'pty-earlier', kind: 'shell', alive: true, ownerPid: 1, updatedAt: 100 },
        { id: 'pty-later', kind: 'shell', alive: true, ownerPid: 1, updatedAt: 200 },
        { id: 'pty-unknown', kind: 'shell', alive: true, ownerPid: 1 },
      ],
      () => true,
    );

    expect(listing.refs).toEqual([
      expect.objectContaining({ id: 'pty-earlier', updatedAt: 100 }),
      expect.objectContaining({ id: 'pty-later', updatedAt: 200 }),
      expect.not.objectContaining({ id: 'pty-unknown', updatedAt: expect.anything() }),
    ]);
    expect(Object.keys(listing.refs[2]!)).not.toContain('updatedAt');
  });
});

describe('joinPtyLineage', () => {
  test('lifecycle의 신뢰할 수 없는 runIdSource는 미상으로 정규화한다', () => {
    const result = joinPtyLineage([], [event(1, 10, { event: 'spawned', ptyId: 'untrusted-source', runId: 'run-a', runIdSource: 'invalid' })], 'untrusted-source');
    expect(result.groups[0]!.rows[0]).toMatchObject({ ptyId: 'untrusted-source', runId: 'run-a', runIdSource: '' });
  });

  test('groups a parent and its children by parent edge', () => {
    const result = joinPtyLineage([
      row({ id: 'parent' }), row({ id: 'child-a', parentPtyId: 'parent' }), row({ id: 'child-b', parentPtyId: 'parent' }),
    ], [], 'parent');
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ joinedBy: 'parent', key: 'parent', parentMissing: false });
    expect(result.groups[0]!.rows.map((item) => item.ptyId)).toEqual(['parent', 'child-a', 'child-b']);
  });

  // ⛔⭐⭐⭐ 전이 계보 — 이 자리가 O3 런이 5라운드를 쓰고도 못 닫은 곳이다(리뷰 진단 그대로 회귀로 박는다).
  //   종전 구현은 «직계 한 겹»만 모아서, A→B→C 에서 A 를 물으면 C 가 빠지고
  //   C 를 물으면 그룹 키는 A 인데 «A 행이 결과에 없는» 모순을 냈다.
  test('A→B→C 전이 계보 — 어느 쪽을 물어도 «셋 다» 나오고 그룹은 하나다', () => {
    const chain = [
      row({ id: 'A' }),
      row({ id: 'B', parentPtyId: 'A' }),
      row({ id: 'C', parentPtyId: 'B' }),
    ];
    for (const query of ['A', 'B', 'C']) {
      const result = joinPtyLineage(chain, [], query);
      expect(result.groups).toHaveLength(1);
      // ⭐ 어디서 묻든 «뿌리»가 키다 — 물은 자리가 키가 되면 같은 계보가 세 이름으로 갈린다.
      expect(result.groups[0]).toMatchObject({ joinedBy: 'parent', key: 'A', parentMissing: false });
      expect(result.groups[0]!.rows.map((item) => item.ptyId)).toEqual(['A', 'B', 'C']);
    }
  });

  test('전이 계보에서 뿌리 행이 이 뿌리에 없으면 parentMissing 이 참이고 후손은 «전부» 나온다', () => {
    // A 는 다른 우주의 매니페스트에 있고 여기엔 없다(실측된 형태 — 부모와 자식은 다른 뿌리에 등록된다).
    const result = joinPtyLineage([
      row({ id: 'B', parentPtyId: 'A' }),
      row({ id: 'C', parentPtyId: 'B' }),
    ], [], 'C');
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ joinedBy: 'parent', key: 'A', parentMissing: true });
    expect(result.groups[0]!.rows.map((item) => item.ptyId)).toEqual(['B', 'C']);
  });

  test('순환 간선이어도 «멈춘다» — 손상된 매니페스트가 조회를 걸지 않는다', () => {
    // ⚠️ 이 테스트가 지키는 것은 «종료»이지 그룹 수가 아니다. 순환은 손상된 상태이고 그때
    //   무엇으로 묶이는 것이 옳은지는 계약이 정한 바 없다 ⇒ 임의의 그룹 수를 단언하면
    //   「검사하는 것처럼 보이는데 계약이 아닌」 단언이 된다.
    const result = joinPtyLineage([
      row({ id: 'X', parentPtyId: 'Y' }),
      row({ id: 'Y', parentPtyId: 'X' }),
    ], [], 'X');
    // ⭐ 여기 도달했다는 것 자체가 「안 걸렸다」의 증거다(무한 루프면 타임아웃으로 죽는다).
    expect(result.groups.length).toBeGreaterThan(0);
    // ⛔ 그리고 순환이어도 «행을 잃지 않는다» — 조회가 데이터를 삼키면 안 된다.
    expect(result.groups.flatMap((group) => group.rows.map((item) => item.ptyId)).sort()).toEqual(['X', 'Y']);
  });

  test('groups rows by run when no parent edge exists', () => {
    const result = joinPtyLineage([row({ id: 'one', runId: 'run-1' }), row({ id: 'two', runId: 'run-1' })], [], 'run-1');
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.joinedBy).toBe('run');
  });

  test('ptyId로 찾은 고립 씨앗은 같은 runId 형제를 run 그룹으로 확장한다', () => {
    const result = joinPtyLineage([
      row({ id: 'seed', runId: 'run-siblings' }),
      row({ id: 'sibling-a', runId: 'run-siblings' }),
      row({ id: 'sibling-b', runId: 'run-siblings' }),
      row({ id: 'other-run', runId: 'run-other' }),
    ], [], 'seed');
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ joinedBy: 'run', key: 'run-siblings', parentMissing: false });
    expect(result.groups[0]!.rows.map((item) => item.ptyId)).toEqual(['seed', 'sibling-a', 'sibling-b']);
  });

  test('ptyId로 찾은 parent 계보에는 같은 runId의 계보 밖 행을 넣지 않는다', () => {
    const result = joinPtyLineage([
      row({ id: 'A', runId: 'run-parent' }),
      row({ id: 'B', runId: 'run-parent', parentPtyId: 'A' }),
      row({ id: 'C', runId: 'run-parent', parentPtyId: 'B' }),
      row({ id: 'outside', runId: 'run-parent' }),
    ], [], 'A');
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ joinedBy: 'parent', key: 'A', parentMissing: false });
    expect(result.groups[0]!.rows.map((item) => item.ptyId)).toEqual(['A', 'B', 'C']);
  });

  test('ptyId로 찾은 고립 씨앗은 빈 runId 형제를 확장하지 않는다', () => {
    const result = joinPtyLineage([
      row({ id: 'one', workdir: '/work/one' }),
      row({ id: 'two', workdir: '/work/two' }),
      row({ id: 'three', workdir: '/work/three' }),
    ], [], 'one');
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ joinedBy: 'workdir-heuristic', key: '/work/one', parentMissing: false });
    expect(result.groups[0]!.rows.map((item) => item.ptyId)).toEqual(['one']);
  });

  test('ptyId 선택은 parent 간선이 있는 runId와 workdir 충돌보다 우선한다', () => {
    const result = joinPtyLineage([
      row({ id: 'shared-key', runId: 'seed-run' }),
      row({ id: 'seed-sibling', runId: 'seed-run' }),
      row({ id: 'run-match', runId: 'shared-key' }),
      row({ id: 'run-match-child', runId: 'shared-key', parentPtyId: 'run-match' }),
      row({ id: 'workdir-match', workdir: '/work/shared-key', runId: 'workdir-run' }),
      row({ id: 'workdir-match-child', runId: 'workdir-run', parentPtyId: 'workdir-match' }),
    ], [], 'shared-key');
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ joinedBy: 'run', key: 'seed-run', parentMissing: false });
    expect(result.groups[0]!.rows.map((item) => item.ptyId)).toEqual(['shared-key', 'seed-sibling']);
  });

  test('carries runIdSource from both manifest rows and lifecycle payloads', () => {
    const manifest = joinPtyLineage([row({ id: 'manifest-source', runId: 'run-source', runIdSource: 'minted' })], [], 'run-source');
    expect(manifest.groups[0]!.rows[0]).toMatchObject({ runId: 'run-source', runIdSource: 'minted' });
    const ledger = joinPtyLineage([], [event(1, 1, { event: 'spawned', ptyId: 'ledger-source', runId: 'run-ledger', runIdSource: 'inherited' })], 'run-ledger');
    expect(ledger.groups[0]!.rows[0]).toMatchObject({ runId: 'run-ledger', runIdSource: 'inherited' });
  });

  test('keeps a run parent and its children in one parent-edge group', () => {
    const result = joinPtyLineage([
      row({ id: 'parent', runId: 'run-with-parent' }),
      row({ id: 'child-a', runId: 'run-with-parent', parentPtyId: 'parent' }),
      row({ id: 'child-b', runId: 'run-with-parent', parentPtyId: 'parent' }),
    ], [], 'run-with-parent');
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ joinedBy: 'parent', key: 'parent', parentMissing: false });
    expect(result.groups[0]!.rows.map((item) => item.ptyId)).toEqual(['parent', 'child-a', 'child-b']);
  });

  test('marks workdir-only grouping as an ambiguous heuristic', () => {
    const result = joinPtyLineage([row({ id: 'one', workdir: '/work/a' }), row({ id: 'two', workdir: '/work/a' })], [], '/work/a');
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.joinedBy).toBe('workdir-heuristic');
  });

  test('does not invent a group without a join axis', () => {
    expect(joinPtyLineage([row({ id: 'one' })], [], 'one').groups).toEqual([]);
  });

  test('folds lifecycle events into the latest exited state', () => {
    const events = [
      event(1, 10, { event: 'spawned', ptyId: 'dead', kind: 'pty', instance: 'test', runId: 'run-2', startedAt: 10, closedAt: 0 }),
      event(2, 30, { event: 'exited', ptyId: 'dead', kind: 'pty', instance: 'test', runId: 'run-2', startedAt: 10, closedAt: 30 }),
    ];
    const result = joinPtyLineage([], events, 'run-2');
    expect(result.groups[0]!.rows[0]).toMatchObject({ ptyId: 'dead', alive: false, closedAt: 30 });
  });

  test('folds lifecycle state by ledger seq when timestamps move backward', () => {
    const result = joinPtyLineage([], [
      event(2, 20, { event: 'exited', ptyId: 'clock-skewed', closedAt: 20 }),
      event(1, 30, { event: 'spawned', ptyId: 'clock-skewed', runId: 'run-skewed', startedAt: 30 }),
    ], 'run-skewed');
    expect(result.groups[0]!.rows[0]).toMatchObject({ ptyId: 'clock-skewed', alive: false, closedAt: 20 });
  });

  test('orders each federated ledger by its own seq without treating overlapping seqs as global', () => {
    const rootA = [
      { ...event(2, 20, { event: 'exited', ptyId: 'dead-a', runId: 'run-federated-order', closedAt: 20 }), sourceRoot: 'root-a' },
      { ...event(1, 10, { event: 'spawned', ptyId: 'dead-a', runId: 'run-federated-order', startedAt: 10 }), sourceRoot: 'root-a' },
    ];
    const rootB = [
      { ...event(2, 40, { event: 'exited', ptyId: 'dead-b', runId: 'run-federated-order', closedAt: 40 }), sourceRoot: 'root-b' },
      { ...event(1, 30, { event: 'spawned', ptyId: 'dead-b', runId: 'run-federated-order', startedAt: 30 }), sourceRoot: 'root-b' },
    ];
    const result = joinPtyLineage([], [...rootA, ...rootB], 'run-federated-order');
    expect(result.groups[0]).toMatchObject({ joinedBy: 'run', key: 'run-federated-order', parentMissing: false });
    expect(result.groups[0]!.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ ptyId: 'dead-a', alive: false, closedAt: 20, sourceRoot: 'root-a' }),
      expect.objectContaining({ ptyId: 'dead-b', alive: false, closedAt: 40, sourceRoot: 'root-b' }),
    ]));
  });

  test('preserves spawned metadata when a later lifecycle event is partial', () => {
    const result = joinPtyLineage([], [
      event(1, 10, { event: 'spawned', ptyId: 'child', kind: 'pty', instance: 'test', parentPtyId: 'parent', runId: 'run-3', workdir: '/work/a', codeSha: 'sha', startedAt: 10 }),
      event(2, 30, { event: 'exited', ptyId: 'child', closedAt: 30 }),
    ], 'parent');
    expect(result.groups[0]!.rows[0]).toMatchObject({ alive: false, parentPtyId: 'parent', runId: 'run-3', workdir: '/work/a', codeSha: 'sha', startedAt: 10, closedAt: 30 });
  });

  for (const lifecycleEvent of ['seen-purge', 'seen-orphan', 'seen-remove'] as const) {
    test(`folds ${lifecycleEvent} as a terminal event while preserving spawned metadata`, () => {
      const result = joinPtyLineage([], [
        event(1, 10, { event: 'spawned', ptyId: 'deleted', kind: 'pty', instance: 'test', parentPtyId: 'parent', runId: 'run-deleted', workdir: '/work/a', codeSha: 'sha', startedAt: 10 }),
        event(2, 30, { event: lifecycleEvent, ptyId: 'deleted' }),
      ], 'parent');
      expect(result.groups[0]!.rows[0]).toMatchObject({
        ptyId: 'deleted', alive: false, closedAt: 30, parentPtyId: 'parent', runId: 'run-deleted', workdir: '/work/a', codeSha: 'sha', startedAt: 10,
      });
      expect(result.unreadablePayloads).toBe(0);
    });
  }

  test('ignores unknown lifecycle events without changing the prior state', () => {
    const result = joinPtyLineage([], [
      event(1, 10, { event: 'spawned', ptyId: 'known', runId: 'run-4', startedAt: 10 }),
      event(2, 30, { event: 'typo', ptyId: 'known', closedAt: 30 }),
    ], 'run-4');
    expect(result.groups[0]!.rows[0]).toMatchObject({ alive: true, closedAt: 0 });
    expect(result.unreadablePayloads).toBe(1);
  });

  test('finds children from a deleted parent ID and marks the parent missing', () => {
    const result = joinPtyLineage([row({ id: 'child-a', parentPtyId: 'gone' }), row({ id: 'child-b', parentPtyId: 'gone' })], [], 'gone');
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ joinedBy: 'parent', key: 'gone', parentMissing: true });
    expect(result.groups[0]!.rows.map((item) => item.ptyId)).toEqual(['child-a', 'child-b']);
  });

  test('counts null lifecycle payloads as unreadable without throwing', () => {
    const result = joinPtyLineage([], [{ ...event(1, 10, null), payload: 'null' }], 'anything');
    expect(result).toMatchObject({ scope: 'process-lineage', note: '이 런에 누가 참가했는지는 elanous self participants가 답합니다.', groups: [], unreadablePayloads: 1 });
  });
});

describe('find and retire local manifest rows', () => {
  test('does not treat the unknown ptyPid sentinel 0 as a PID match or deletion target', () => {
    const unknownPidRow = row({ id: 'unknown-pty-pid', ptyPid: 0, ownerPid: 77, updatedAt: 0 });
    const remainingRows = [unknownPidRow];
    const removed: string[] = [];
    const deps: PtyTakeoverCommandDeps = {
      ...lineageDeps(remainingRows, []),
      listManifestRows: () => remainingRows,
      isProcessAlive: () => false,
      now: () => 100_000,
      removeManifest: (id) => removed.push(id),
    };

    expect(findPtyManifestRows(remainingRows, '0')).toEqual([]);
    expect(runPtyFind('0', deps).message).toContain('no manifest rows matched');
    expect(runPtyRetire('0', deps, true)).toMatchObject({ exitCode: 1, message: 'pty retire: 0 was not found in the local manifest' });
    expect(removed).toEqual([]);
    expect(remainingRows).toEqual([unknownPidRow]);
  });

  test('finds all four axes and retires an open removable row through injected dependencies', () => {
    const staleRow = row({ id: 'stale-pty', ptyPid: 4242, ownerPid: 77, runId: 'run-find', updatedAt: 0 });
    const sharedKeyRow = row({ id: 'shared', ownerPid: 88, runId: 'shared' });
    const remainingRows = [staleRow, sharedKeyRow];
    const removed: string[] = [];
    const deps: PtyTakeoverCommandDeps = {
      ...lineageDeps(remainingRows, []),
      listManifestRows: () => remainingRows,
      isProcessAlive: () => false,
      now: () => 100_000,
      // ⛔⭐ The fake must actually **drop the row**, not merely record the call. A spy that only records makes
      //   `removed: true` unfalsifiable: the command would pass this test even if the real removal silently
      //   failed. Mutating the backing list is what lets the re-read in `runPtyRetire` mean something.
      removeManifest: (id) => {
        removed.push(id);
        const at = remainingRows.findIndex((candidate) => candidate.id === id);
        if (at >= 0) remainingRows.splice(at, 1);
      },
    };

    expect(runPtyFind('4242', deps).message).toContain('matchedBy=ptyPid');
    expect(runPtyFind('77', deps).message).toContain('matchedBy=ownerPid');
    expect(runPtyFind('stale-pty', deps).message).toContain('matchedBy=ptyId');
    expect(runPtyFind('run-find', deps).message).toContain('matchedBy=runId');
    expect(findPtyManifestRows(remainingRows, 'shared')[0]?.matchedBy).toEqual(['ptyId', 'runId']);
    expect(runPtyRetire('4242', deps).message).toContain('dry-run');
    expect(removed).toEqual([]);
    expect(runPtyRetire('4242', deps, true).exitCode).toBe(0);
    expect(removed).toEqual(['stale-pty']);
    expect(remainingRows.map(({ id }) => id)).toEqual(['shared']);
  });

  // ⛔⭐⭐ `removePtyManifest` is fail-soft and returns `void`, so a swallowed write error is indistinguishable
  //   from success **at the call site**. Before the re-read, `runPtyRetire` echoed the `--yes` flag back as
  //   `removed: true` and exited 0 for a row that never left the manifest — the caller then believes a ghost
  //   was retired and stops looking for it. This is the regression that the call-recording spy could not catch.
  test('reports failure when a fail-soft removal silently leaves the manifest row in place', () => {
    const staleRow = row({ id: 'stuck-pty', ptyPid: 5252, ownerPid: 99, updatedAt: 0 });
    const remainingRows = [staleRow];
    const attempted: string[] = [];
    const deps: PtyTakeoverCommandDeps = {
      ...lineageDeps(remainingRows, []),
      listManifestRows: () => remainingRows,
      isProcessAlive: () => false,
      now: () => 100_000,
      removeManifest: (id) => { attempted.push(id); },   // swallows the failure, exactly like the real one
    };

    const result = runPtyRetire('5252', deps, true);
    expect(attempted).toEqual(['stuck-pty']);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('removal did not take effect');
    expect(JSON.parse(runPtyRetire('5252', deps, true, true).message).removed).toBe(false);
  });

  test('preserves a newly closed row for the full closed TTL even when its process is dead', () => {
    const recentlyClosed = row({ id: 'recently-closed', ptyPid: 4343, alive: false, closedAt: 99_000, updatedAt: 99_000 });
    const removed: string[] = [];
    const deps: PtyTakeoverCommandDeps = {
      ...lineageDeps([recentlyClosed], []),
      listManifestRows: () => [recentlyClosed],
      isProcessAlive: () => false,
      now: () => 100_000,
      removeManifest: (id) => removed.push(id),
    };

    const dryRun = JSON.parse(runPtyRetire('4343', deps, false, true).message) as { proof: { removable: boolean; reasons: string[]; liveness: { alive: boolean } } };
    expect(dryRun.proof).toMatchObject({ removable: false, reasons: [], liveness: { alive: false } });
    expect(runPtyRetire('4343', deps, true)).toMatchObject({ exitCode: 1 });
    expect(removed).toEqual([]);
  });

  // ⛔⭐ Closed grace must key on closedAt, not updatedAt (review MF-444765bc/MF-8b73b551). This row's
  //   updatedAt is far past the closed TTL, but it closed only moments ago — keying on updatedAt would
  //   delete it early. closedAt ≠ updatedAt is what makes this test discriminate the fixed code.
  test('does not retire a row whose closedAt is recent even though updatedAt is past the closed TTL', () => {
    const now = 1_000_000;
    const recentlyClosedStaleUpdate = row({
      id: 'closed-recently', ptyPid: 5454, alive: false,
      updatedAt: now - PTY_MANIFEST_CLOSED_TTL_MS - 50_000,   // long-idle before close → old updatedAt
      closedAt: now - 1_000,                                  // closed moments ago → within grace
    });
    const removed: string[] = [];
    const deps: PtyTakeoverCommandDeps = {
      ...lineageDeps([recentlyClosedStaleUpdate], []),
      listManifestRows: () => [recentlyClosedStaleUpdate],
      isProcessAlive: () => false,
      now: () => now,
      removeManifest: (id) => removed.push(id),
    };

    const dryRun = JSON.parse(runPtyRetire('5454', deps, false, true).message) as { proof: { removable: boolean; reasons: string[]; state: { closedGraceExpired: boolean } } };
    expect(dryRun.proof).toMatchObject({ removable: false, reasons: [], state: { closedGraceExpired: false } });
    expect(runPtyRetire('5454', deps, true)).toMatchObject({ exitCode: 1 });
    expect(removed).toEqual([]);
  });

  test('retires a closed row once its closedAt passes the closed TTL', () => {
    const now = 1_000_000;
    const expiredClosed = row({
      id: 'closed-expired', ptyPid: 6565, alive: false,
      updatedAt: now - 1_000,                                 // recent updatedAt would keep it if keyed wrong
      closedAt: now - PTY_MANIFEST_CLOSED_TTL_MS - 1,         // closed past the grace TTL → removable
    });
    const removed: string[] = [];
    const rows = [expiredClosed];
    const deps: PtyTakeoverCommandDeps = {
      ...lineageDeps(rows, []),
      listManifestRows: () => rows,
      isProcessAlive: () => false,
      now: () => now,
      // The fake drops the row so the command's post-removal re-read has something real to observe.
      removeManifest: (id) => {
        removed.push(id);
        const at = rows.findIndex((candidate) => candidate.id === id);
        if (at >= 0) rows.splice(at, 1);
      },
    };

    const dryRun = JSON.parse(runPtyRetire('6565', deps, false, true).message) as { proof: { removable: boolean; reasons: string[]; state: { closedGraceExpired: boolean } } };
    expect(dryRun.proof).toMatchObject({ removable: true, reasons: ['closed-grace-expired'], state: { closedGraceExpired: true } });
    expect(runPtyRetire('6565', deps, true).exitCode).toBe(0);
    expect(removed).toEqual(['closed-expired']);
  });
});

describe('runPtyReap', () => {
  test('defaults to per-root dry-run and applies only after --yes', () => {
    const calls: Array<{ path: string; apply: boolean }> = [];
    const deps: PtyTakeoverCommandDeps = {
      ...lineageDeps([], []),
      manifestTargets: () => [{ name: 'other-root', dbPath: '/roots/other/manifest.db' }],
      reapManifestAt: (path, opts) => {
        calls.push({ path, apply: opts.apply !== false });
        return {
          dbPath: path, status: 'ok', missingColumns: [], removed: 1, preserved: 2,
          decisions: [
            { id: 'dead', livenessPid: 999999, livenessSource: 'owner-pid', action: 'remove', reason: 'process-dead' },
            { id: 'live', livenessPid: 42, livenessSource: 'owner-pid', action: 'preserve', reason: 'process-alive' },
            { id: 'unknown', livenessPid: 43, livenessSource: 'owner-pid', action: 'preserve', reason: 'liveness-unknown' },
          ],
        };
      },
    };
    const preview = runPtyReap(deps);
    expect(preview.message).toContain('pty reap: dry-run');
    expect(preview.message).toContain('root=other-root status=ok removed=1 preserved=2');
    expect(preview.message).toContain('dead\tremove\tprocess-dead');
    expect(calls).toEqual([{ path: '/roots/other/manifest.db', apply: false }]);

    const applied = JSON.parse(runPtyReap(deps, { yes: true, json: true }).message);
    expect(applied).toMatchObject({ mode: 'applied', roots: [{ name: 'other-root', removed: 1, preserved: 2 }] });
    expect(calls).toEqual([
      { path: '/roots/other/manifest.db', apply: false },
      { path: '/roots/other/manifest.db', apply: true },
    ]);
  });

  test('applied missing, read-write open, PRAGMA, and delete failures are non-zero in text and JSON', () => {
    const root = mkdtempSync(join(tmpdir(), 'pty-reap-cli-failures-'));
    const pragmaPath = join(root, 'pragma.db');
    const d = new Database(pragmaPath);
    d.run(`CREATE TABLE pty_manifest (id TEXT PRIMARY KEY, owner_pid INTEGER NOT NULL, pty_pid INTEGER NOT NULL DEFAULT 0, alive INTEGER NOT NULL)`);
    d.close();
    const targets = [
      { name: 'missing-root', dbPath: join(root, 'missing.db') },
      { name: 'open-failed-root', dbPath: root },
      { name: 'pragma-failed-root', dbPath: pragmaPath },
      { name: 'delete-failed-root', dbPath: join(root, 'delete.db') },
    ];
    const deps: PtyTakeoverCommandDeps = {
      ...lineageDeps([], []),
      manifestTargets: () => targets,
      reapManifestAt: (dbPath, opts) => {
        if (dbPath.endsWith('pragma.db')) {
          return reapDeadPtyManifestAt(dbPath, { apply: opts.apply, configureWriteConnection: () => { throw new Error('PRAGMA failed'); } });
        }
        if (dbPath.endsWith('delete.db')) return { dbPath, status: 'write-failed', missingColumns: [], removed: 0, preserved: 0, decisions: [] };
        return reapDeadPtyManifestAt(dbPath, { apply: opts.apply });
      },
    };

    const expected = [
      { name: 'missing-root', status: 'missing' },
      { name: 'open-failed-root', status: 'unreadable' },
      { name: 'pragma-failed-root', status: 'unreadable' },
      { name: 'delete-failed-root', status: 'write-failed' },
    ] as const;
    for (let index = 0; index < targets.length; index += 1) {
      const isolatedDeps = { ...deps, manifestTargets: () => [targets[index]!] };
      const text = runPtyReap(isolatedDeps, { yes: true });
      const json = runPtyReap(isolatedDeps, { yes: true, json: true });
      expect(text.exitCode).toBe(1);
      expect(text.message).toContain(`root=${expected[index]!.name} status=${expected[index]!.status} removed=0 preserved=0`);
      expect(json.exitCode).toBe(1);
      expect(JSON.parse(json.message)).toMatchObject({ mode: 'applied', roots: [expected[index]!] });
    }
  });

  // ⭐ 2026-08-19 실측 동기: 126 루트에서 「98행 제거 성공 · 루트 하나 schema-mismatch」로 rc=1 이
  //    났는데, 그 대조가 산출 어디에도 없어 사람이 126줄을 손으로 세야 했다. exit 의 «뜻»(fail-closed)
  //    은 그대로 두고 그 뜻이 «보이게» 한다.
  test('summarises removed vs unprocessed roots so a fail-closed exit is legible', () => {
    const okRoot = { name: 'ok-root', dbPath: '/roots/ok/manifest.db' };
    const badRoot = { name: 'bad-root', dbPath: '/roots/bad/manifest.db' };
    const deps: PtyTakeoverCommandDeps = {
      ...lineageDeps([], []),
      manifestTargets: () => [okRoot, badRoot],
      reapManifestAt: (path) => (path === okRoot.dbPath
        ? { dbPath: path, status: 'ok' as const, missingColumns: [], removed: 98, preserved: 44, decisions: [] }
        : { dbPath: path, status: 'unreadable' as const, missingColumns: [], removed: 0, preserved: 0, decisions: [] }),
    };

    const text = runPtyReap(deps, { yes: true });
    expect(text.exitCode).toBe(1);
    // ⭐ 리뷰 should-fix(2026-08-19): «마지막 줄»인 것이 이 착지의 값이다 — 126줄 뒤에 있어야
    //    사람이 스크롤 끝에서 바로 본다. toContain 만으로는 중간에 끼어도 통과한다.
    const lastLine = text.message.split('\n').at(-1);
    expect(lastLine).toBe(
      'pty reap summary: roots=2 viewedRoots=2 viewedRootNameRange=ok-root…bad-root unprocessed=1 removed=98 preserved=44'
      + ' → exit 1 (fail-closed: 처리하지 못한 루트가 있으면 제거가 성공해도 실패로 낸다)',
    );

    const json = JSON.parse(runPtyReap(deps, { yes: true, json: true }).message);
    expect(json.summary).toEqual({ roots: 2, unprocessedRoots: 1, removed: 98, preserved: 44, failClosed: true, viewedRootCount: 2, viewedRootNameRange: 'ok-root…bad-root' });

    // 모든 루트가 정상이면 요약이 exit 0 을 말하고 fail-closed 문면이 없다.
    const cleanDeps: PtyTakeoverCommandDeps = { ...deps, manifestTargets: () => [okRoot] };
    const clean = runPtyReap(cleanDeps, { yes: true });
    expect(clean.exitCode).toBe(0);
    expect(clean.message.split('\n').at(-1))
      .toBe('pty reap summary: roots=1 viewedRoots=1 viewedRootNameRange=ok-root unprocessed=0 removed=98 preserved=44 → exit 0');
    expect(clean.message).not.toContain('fail-closed');
  });

  test('narrows preview and apply to requested registered root names while preserving default scope metadata', () => {
    const calls: string[] = [];
    const targets = [
      { name: 'dead-root', dbPath: '/roots/dead/manifest.db' },
      { name: 'empty-root', dbPath: '/roots/empty/manifest.db' },
      { name: 'other-root', dbPath: '/roots/other/manifest.db' },
    ];
    const deps: PtyTakeoverCommandDeps = {
      ...lineageDeps([], []),
      manifestTargets: () => targets,
      reapManifestAt: (dbPath) => {
        calls.push(dbPath);
        return { dbPath, status: 'ok', missingColumns: [], removed: dbPath.includes('/dead/') ? 1 : 0, preserved: 0, decisions: [] };
      },
    };

    const defaultPreview = runPtyReap(deps);
    expect(defaultPreview.exitCode).toBe(0);
    expect(defaultPreview.message).toContain('viewedRoots=3 viewedRootNameRange=dead-root…other-root');
    expect(calls).toEqual(targets.map((target) => target.dbPath));

    calls.length = 0;
    const singlePreview = runPtyReap(deps, { instance: ['dead-root'] });
    expect(singlePreview.exitCode).toBe(0);
    expect(singlePreview.message).toContain('viewedRoots=1 viewedRootNameRange=dead-root');
    expect(singlePreview.message).toContain('root=dead-root');
    expect(singlePreview.message).not.toContain('root=empty-root');
    expect(calls).toEqual(['/roots/dead/manifest.db']);

    calls.length = 0;
    const multipleApplied = JSON.parse(runPtyReap(deps, { yes: true, json: true, instance: ['other-root', 'dead-root'] }).message);
    expect(multipleApplied.summary).toMatchObject({ viewedRootCount: 2, viewedRootNameRange: 'dead-root…other-root', removed: 1 });
    expect(multipleApplied.roots.map((root: { name: string }) => root.name)).toEqual(['dead-root', 'other-root']);
    expect(calls).toEqual(['/roots/dead/manifest.db', '/roots/other/manifest.db']);
  });

  test('fails before preview or apply when any requested root name is unregistered', () => {
    const calls: string[] = [];
    const deps: PtyTakeoverCommandDeps = {
      ...lineageDeps([], []),
      manifestTargets: () => [{ name: 'registered-root', dbPath: '/roots/registered/manifest.db' }],
      reapManifestAt: (dbPath) => {
        calls.push(dbPath);
        return { dbPath, status: 'ok', missingColumns: [], removed: 0, preserved: 0, decisions: [] };
      },
    };

    const unmatched = runPtyReap(deps, { instance: ['missing-root'] });
    expect(unmatched).toEqual({ exitCode: 1, message: 'pty reap: unregistered root name(s): missing-root' });
    expect(calls).toEqual([]);

    const partial = runPtyReap(deps, { yes: true, json: true, instance: ['registered-root', 'missing-root'] });
    expect(partial.exitCode).toBe(1);
    expect(JSON.parse(partial.message)).toEqual({ error: 'pty reap: unregistered root name(s): missing-root', unmatchedNames: ['missing-root'] });
    expect(calls).toEqual([]);
  });

  test('Commander forwards repeated --instance values to the reap execution path', async () => {
    const stdout: string[] = [];
    const originalOut = process.stdout.write;
    const originalErr = process.stderr.write;
    const calls: string[] = [];
    process.stdout.write = ((chunk: string) => { stdout.push(chunk); return true; }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const program = new Command();
      registerPtyTakeoverCommands(program, {
        ...lineageDeps([], []),
        manifestTargets: () => [
          { name: 'first-root', dbPath: '/roots/first/manifest.db' },
          { name: 'second-root', dbPath: '/roots/second/manifest.db' },
        ],
        reapManifestAt: (dbPath) => {
          calls.push(dbPath);
          return { dbPath, status: 'ok', missingColumns: [], removed: 0, preserved: 0, decisions: [] };
        },
      });
      await program.parseAsync(['node', 'elanous', 'pty', 'reap', '--instance', 'first-root', 'second-root']);
      expect(calls).toEqual(['/roots/first/manifest.db', '/roots/second/manifest.db']);
      expect(stdout.join('')).toContain('viewedRoots=2 viewedRootNameRange=first-root…second-root');
      expect(process.exitCode).toBe(0);
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
      process.exitCode = 0;
    }
  });
});

describe('runPtyLineage', () => {
  test('states its scope and participants boundary even when no lineage matches', () => {
    const result = runPtyLineage('nothing', lineageDeps([], []));
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.message).toBe('scope: process-lineage\nnote: 이 런에 누가 참가했는지는 elanous self participants가 답합니다.');
  });

  test('adds shared scope and note without changing lineage group rows in human and JSON output', () => {
    const deps = lineageDeps([row({ id: 'parent', runId: 'run-metadata' }), row({ id: 'child', parentPtyId: 'parent', runId: 'run-metadata' })], []);
    const human = runPtyLineage('run-metadata', deps).message;
    const json = JSON.parse(runPtyLineage('run-metadata', deps, true).message);
    expect(human).toBe('scope: process-lineage\nnote: 이 런에 누가 참가했는지는 elanous self participants가 답합니다.\njoinedBy=parent\n  parent\tpty\ttest\talive\t10\n  child\tpty\ttest\talive\t10');
    expect(json).toMatchObject({
      scope: 'process-lineage',
      note: '이 런에 누가 참가했는지는 elanous self participants가 답합니다.',
      groups: [{ joinedBy: 'parent', rows: [{ ptyId: 'parent' }, { ptyId: 'child' }] }],
    });
  });

  test('uses injected local-root readers and emits structured JSON', () => {
    const result = runPtyLineage('run-injected', lineageDeps(
      [row({ id: 'exited', alive: false, runId: 'run-injected', closedAt: 20 })],
      [],
    ), true);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.message)).toMatchObject({ groups: [{ joinedBy: 'run', rows: [{ ptyId: 'exited', alive: false }] }], unreadablePayloads: 0 });
    expect(JSON.parse(result.message)).not.toHaveProperty('unreadableRoots');
  });

  test('unions manifest and lifecycle ledgers, preserves source roots, and reports missing separately', () => {
    const deps: PtyTakeoverCommandDeps = {
      ...lineageDeps([], []),
      readFederatedLineage: () => ({
        manifestRows: [{ ...row({ id: 'live', runId: 'federated', instance: 'manifest-root' }), sourceRoot: 'manifest-root' }],
        lifecycleRows: [
          { ...event(1, 10, { event: 'spawned', ptyId: 'dead', runId: 'federated', instance: 'ledger-root', startedAt: 10 }), sourceRoot: 'ledger-root' },
          { ...event(2, 20, { event: 'exited', ptyId: 'dead', closedAt: 20 }), sourceRoot: 'ledger-root' },
        ],
        unreadableRoots: [{ name: 'locked-root', dbPath: '/roots/locked/events.db' }],
        missingRoots: [{ name: 'missing-root', dbPath: '/roots/missing/events.db' }],
      }),
      log: () => {},
    };
    const result = JSON.parse(runPtyLineage('federated', deps, true, { all: true }).message);
    expect(result.groups[0].rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ ptyId: 'live', sourceRoot: 'manifest-root' }),
      expect.objectContaining({ ptyId: 'dead', alive: false, sourceRoot: 'ledger-root' }),
    ]));
    expect(result).toMatchObject({
      unreadableRoots: [{ name: 'locked-root', dbPath: '/roots/locked/events.db' }],
      missingRoots: [{ name: 'missing-root', dbPath: '/roots/missing/events.db' }],
    });
  });

  test('keeps duplicate root names distinguishable and folds only human output', () => {
    const missingRoots = Array.from({ length: 11 }, (_, index) => ({
      name: index < 2 ? 'test:monad-agent' : `missing-${index}`,
      dbPath: `/roots/${index}/events.db`,
    }));
    const deps: PtyTakeoverCommandDeps = {
      ...lineageDeps([], []),
      readFederatedLineage: () => ({ manifestRows: [], lifecycleRows: [], unreadableRoots: [], missingRoots }),
    };

    const json = JSON.parse(runPtyLineage('nothing', deps, true, { all: true }).message);
    expect(json.missingRoots).toEqual(missingRoots);

    const human = runPtyLineage('nothing', deps, false, { all: true }).message;
    expect(human).toContain('test:monad-agent (/roots/0/events.db)');
    expect(human).toContain('test:monad-agent (/roots/1/events.db)');
    expect(human).toContain('… 6 more');
    expect(human).not.toContain('/roots/5/events.db');
  });

  test('rejects --include-test without the explicit federation flag', () => {
    expect(runPtyLineage('anything', lineageDeps([], []), false, { includeTest: true })).toMatchObject({
      exitCode: 1, message: 'pty lineage: --include-test requires --all',
    });
  });

  test('keeps non-control human and JSON output free of control fields', () => {
    const deps = lineageDeps([row({ id: 'legacy', runId: 'run-legacy', parentKind: 'unknown', spaceId: 'space', nestDepth: 2, originRoot: 'external-agent', controller: 'agent:codex' })], []);
    const human = runPtyLineage('run-legacy', deps).message;
    const jsonMessage = runPtyLineage('run-legacy', deps, true).message;
    const json = JSON.parse(jsonMessage);
    expect(human).toBe('scope: process-lineage\nnote: 이 런에 누가 참가했는지는 elanous self participants가 답합니다.\njoinedBy=run\n  legacy\tpty\ttest\talive\t10');
    expect(jsonMessage).toBe(`{
  "scope": "process-lineage",
  "note": "이 런에 누가 참가했는지는 elanous self participants가 답합니다.",
  "groups": [
    {
      "joinedBy": "run",
      "key": "run-legacy",
      "rows": [
        {
          "ptyId": "legacy",
          "kind": "pty",
          "instance": "test",
          "alive": true,
          "startedAt": 10,
          "closedAt": 0,
          "parentPtyId": "",
          "parentPid": 0,
          "parentKind": "unknown",
          "runId": "run-legacy",
          "runIdSource": "",
          "codeSha": ""
        }
      ],
      "parentMissing": false
    }
  ],
  "unreadablePayloads": 0
}`);
    expect(human).not.toContain('ctl parent=');
    expect(json.groups[0].rows[0]).not.toHaveProperty('spaceId');
    expect(json.groups[0].rows[0]).not.toHaveProperty('nestDepth');
    expect(json.groups[0].rows[0]).not.toHaveProperty('originRoot');
    expect(json.groups[0].rows[0]).not.toHaveProperty('controller');
  });

  test('renders manifest control lineage and injected inbox snapshot in human and JSON output', () => {
    let inspections = 0;
    const deps: PtyTakeoverCommandDeps = {
      ...lineageDeps([row({ id: 'controlled', runId: 'run-control', parentKind: 'unknown', nestDepth: 2, originRoot: 'external-agent', controller: 'agent:codex', spaceId: 'dev-run-run-x' })], []),
      inspectControlInbox: (spaceId) => {
        inspections += 1;
        expect(spaceId).toBe('dev-run-run-x');
        return { directory: 'present', stop: false, memoCount: 1, oldestMtimeMs: 1, unreadableCount: 0 };
      },
    };

    const human = runPtyLineage('run-control', deps, false, { control: true });
    const json = JSON.parse(runPtyLineage('run-control', deps, true, { control: true }).message);
    expect(human).toMatchObject({ exitCode: 0 });
    expect(human.message).toContain('  ctl parent=unknown depth=2 origin=external-agent controller=agent:codex inbox=present memo=1 stop=no');
    expect(json.groups[0].rows[0].control).toMatchObject({ parentKind: 'unknown', nestDepth: 2, originRoot: 'external-agent', controller: 'agent:codex', inbox: { memoCount: 1 } });
    expect(inspections).toBe(2);
  });

  test('renders process parent as root, leaves missing values unknown, and skips inbox without a space', () => {
    let inspections = 0;
    const deps: PtyTakeoverCommandDeps = {
      ...lineageDeps([row({ id: 'root', runId: 'run-root', parentKind: 'process', spaceId: undefined })], []),
      inspectControlInbox: () => { inspections += 1; return { directory: 'empty', stop: false, memoCount: 0, oldestMtimeMs: null, unreadableCount: 0 }; },
    };

    const result = runPtyLineage('run-root', deps, false, { control: true });
    expect(result.message).toContain('  ctl parent=root depth=? origin=? controller=? inbox=? memo=? stop=?');
    expect(inspections).toBe(0);
  });

  test('keeps control inspection failures local to the row', () => {
    const deps: PtyTakeoverCommandDeps = {
      ...lineageDeps([row({ id: 'unreadable', runId: 'run-unreadable', parentKind: 'unknown', spaceId: 'space', controller: '' })], []),
      inspectControlInbox: () => { throw new Error('state root unavailable'); },
    };

    const json = runPtyLineage('run-unreadable', deps, true, { control: true });
    const human = runPtyLineage('run-unreadable', deps, false, { control: true });
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.message).groups[0].rows[0].control.inbox).toEqual({ directory: 'unreadable' });
    expect(human.message).toContain('  ctl parent=unknown depth=? origin=? controller=- inbox=unreadable memo=? stop=?');
  });

  test('does not inspect foreign inboxes under federated --all while preserving manifest control fields', () => {
    let inspections = 0;
    const deps: PtyTakeoverCommandDeps = {
      ...lineageDeps([], []),
      inspectControlInbox: () => { inspections += 1; return { directory: 'present', stop: false, memoCount: 1, oldestMtimeMs: 1, unreadableCount: 0 }; },
      readFederatedLineage: () => ({
        manifestRows: [{ ...row({ id: 'foreign', runId: 'run-foreign', parentKind: 'unknown', spaceId: 'foreign-space', controller: 'agent:codex' }), sourceRoot: 'foreign-root' }],
        lifecycleRows: [], unreadableRoots: [], missingRoots: [],
      }),
    };

    const json = JSON.parse(runPtyLineage('run-foreign', deps, true, { all: true, control: true }).message);
    expect(inspections).toBe(0);
    expect(json.groups[0].rows[0].control).toMatchObject({ parentKind: 'unknown', controller: 'agent:codex' });
    expect(json.groups[0].rows[0].control).not.toHaveProperty('inbox');
  });

  test('reads unknown manifest parent and a real isolated control memo through production dependencies', () => {
    const root = mkdtempSync(join(tmpdir(), 'pty-lineage-control-'));
    const dbPath = join(root, 'pty', 'manifest.db');
    const envBefore = {
      ELANOUS_STATE_DIR: process.env.ELANOUS_STATE_DIR,
      ELANOUS_NEST_DEPTH: process.env.ELANOUS_NEST_DEPTH,
      ELANOUS_HARNESS_SPACE_ID: process.env.ELANOUS_HARNESS_SPACE_ID,
      ELANOUS_PARENT_PTY_ID: process.env.ELANOUS_PARENT_PTY_ID,
    };
    try {
      process.env.ELANOUS_STATE_DIR = root;
      process.env.ELANOUS_NEST_DEPTH = '1';
      process.env.ELANOUS_HARNESS_SPACE_ID = 'temporary-space';
      delete process.env.ELANOUS_PARENT_PTY_ID;
      setPtyManifestDbPathForTesting(dbPath);
      upsertPtyManifest({ id: 'isolated-pty', kind: 'pty', cmd: 'bun', workdir: root, startedAt: 1, now: 1 });
      enqueueControlMemo('temporary-space', 'inspect me');
      const result = runPtyLineage('isolated-pty', undefined, true, { control: true });
      const control = JSON.parse(result.message).groups[0].rows[0].control;
      expect(control).toMatchObject({ parentKind: 'unknown', inbox: { memoCount: 1 } });
    } finally {
      setPtyManifestDbPathForTesting(null);
      for (const [key, value] of Object.entries(envBefore)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('PTY-less agent references', () => {
  const deps: PtyTakeoverCommandDeps = {
    getPty: () => undefined,
    requestPtyTakeover: () => false,
    requestRemote: async () => ({ status: 'unknown-pty' }),
    readAddressBook: () => ({ refs: [], deadRefs: [] }),
    log: () => {},
  };
  const agentMessage = 'pty: agent:subagent-1 is a participant without a PTY and cannot be controlled by this command; inspect it via the observatory list or elanous logs';

  test('mouse command validates mode, preserves ownership and dispatches structured remote input', async () => {
    const written: string[] = [];
    const { startPty, setPtyAdapterForTesting, unregisterPty } = await import('../pty-shell/registry.js');
    let onData: ((chunk: string) => void) | undefined;
    setPtyAdapterForTesting(() => ({
      pid: 7, write: (chars: string) => { written.push(chars); }, kill() {},
      onData: (callback) => { onData = callback; return { dispose() {} }; },
      onExit: () => ({ dispose() {} }),
    }));
    let id: string | undefined;
    try {
      const handle = startPty({ cmd: 'test', accessMode: 'auto', detach: true });
      id = handle.id;
      const calls: unknown[][] = [];
      const mouseDeps = { ...deps, listRefs: () => [{ id: handle.id, kind: 'test', source: 'local' as const, alive: true }, { id: 'foreign-pty', kind: 'test', source: 'remote' as const, alive: true }], readAddressBook: undefined, getPty: (ref: string) => ref === handle.id ? handle : undefined, requestRemote: async (...args: Parameters<PtyTakeoverCommandDeps['requestRemote']>) => { calls.push(args); return { status: 'success' as const }; }, runIdentity: () => ({ requester: 'run-1', target: 'run-1' }) };
      expect((await runPtyMouse(handle.id, { x: 10, y: 5, kind: 'click' }, mouseDeps, 'agent')).message).toContain('mouse mode is off');
      onData?.('\x1b[?1000;1006h');
      expect((await runPtyMouse(handle.id, { x: 10, y: 5, kind: 'click' }, mouseDeps, 'agent')).exitCode).toBe(0);
      expect(written).toEqual(['\x1b[<0;10;5M\x1b[<0;10;5m']);
      handle.setAccessMode('write');
      expect((await runPtyMouse(handle.id, { x: 10, y: 5, kind: 'click' }, mouseDeps, 'agent')).exitCode).toBe(1);
      expect((await runPtyMouse(handle.id, { x: 10, y: 5, kind: 'click' }, mouseDeps, 'human')).exitCode).toBe(0);
      expect(written).toHaveLength(2);
      onData?.('\x1b[?1000l');
      expect((await runPtyMouse(handle.id, { x: 10, y: 5, kind: 'click' }, mouseDeps, 'human')).message).toContain('mouse mode is off');
      expect(written).toHaveLength(2);
      await runPtyMouse('foreign-pty', { x: 1, y: 1, kind: 'scroll-up' }, mouseDeps);
      expect(calls.at(-1)?.[1]).toBe('input-mouse');
    } finally {
      if (id) unregisterPty(id);
      setPtyAdapterForTesting(null);
    }
  }, 20_000);

  test('distinguishes a PTY-less agent from a missing snapshot or text target', async () => {
    await expect(runPtySnapshot('agent:subagent-1', deps)).resolves.toEqual({ exitCode: 1, message: agentMessage });
    await expect(runPtyText('agent:subagent-1', 'hello', false, deps)).resolves.toEqual({ exitCode: 1, message: agentMessage });
  });

  const scopedMissingMessage = (ref: string, count: number) => `pty: ${ref} was not found in the current instance address book (${count} live PTY ref${count === 1 ? '' : 's'}); inspect all registered instances with elanous pty list --all --include-test`;

  test('reports the local lookup scope and federated next action for a foreign-instance snapshot or text target', async () => {
    const localDeps: PtyTakeoverCommandDeps = {
      ...deps,
      readAddressBook: () => ({ refs: [{ id: 'local-pty', kind: 'pty', source: 'local', alive: true }], deadRefs: [] }),
    };
    const expected = { exitCode: 1 as const, message: scopedMissingMessage('foreign-pty', 1) };

    await expect(runPtySnapshot('foreign-pty', localDeps)).resolves.toEqual(expected);
    await expect(runPtyText('foreign-pty', 'hello', false, localDeps)).resolves.toEqual(expected);
  });

  test('reports the local lookup scope and federated next action for a wholly absent snapshot or text target', async () => {
    const expected = { exitCode: 1 as const, message: scopedMissingMessage('missing-pty', 0) };

    await expect(runPtySnapshot('missing-pty', deps)).resolves.toEqual(expected);
    await expect(runPtyText('missing-pty', 'hello', false, deps)).resolves.toEqual(expected);
  });

  test('names a dead PTY, preserves its live owner, and includes its exit code', async () => {
    const deadPtyDeps: PtyTakeoverCommandDeps = {
      ...deps,
      readAddressBook: () => ({
        refs: [],
        deadRefs: [{ id: 'held', kind: 'pty', source: 'remote', alive: false, livenessSource: 'pty-pid', ownerAlive: true, exitCode: 1 }],
      }),
    };
    const expected = { exitCode: 1 as const, message: 'pty snapshot: PTY for held has exited (exitCode=1); owner is alive' };

    await expect(runPtySnapshot('held', deadPtyDeps)).resolves.toEqual(expected);
    await expect(runPtyText('held', 'hello', false, deadPtyDeps)).resolves.toEqual({ ...expected, message: expected.message.replace('snapshot', 'input-text') });
  });

  test('keeps owner-death wording when the owner fallback was selected', async () => {
    const deadOwnerDeps: PtyTakeoverCommandDeps = {
      ...deps,
      readAddressBook: () => ({
        refs: [],
        deadRefs: [{ id: 'legacy', kind: 'pty', source: 'remote', alive: false, livenessSource: 'owner-pid', exitCode: null }],
      }),
    };

    await expect(runPtySnapshot('legacy', deadOwnerDeps)).resolves.toEqual({ exitCode: 1, message: 'pty snapshot: owner for legacy has exited' });
  });
});

describe('runPtyList web addresses', () => {
  const base = {
    getPty: () => undefined,
    requestPtyTakeover: () => false,
    requestRemote: async () => ({ status: 'unknown-pty' as const }),
    log: () => {},
  };
  const liveRow = row({ id: 'pty /?&', ownerPid: 1, ptyPid: 1, instance: 'current' });
  const jsonManifestDeps = {
    currentManifestDbPath: () => '/roots/current/pty/manifest.db',
    manifestTargets: () => [{ name: 'actual-current-root', dbPath: '/roots/current/pty/manifest.db' }],
  };

  test('adds one encoded web URL to JSON and human rows with one resolver call', () => {
    let calls = 0;
    const resolveNexusPwa = () => { calls += 1; return { status: 'registered' as const, loopback: 'http://127.0.0.1:31415/app/', url: 'http://127.0.0.1:31415/app/', source: 'local' as const }; };
    const json = JSON.parse(runPtyList({ ...base, ...jsonManifestDeps, listManifestRows: () => [liveRow], listManifestRowsAt: () => [liveRow], isProcessAlive: () => true, now: () => 1, resolveNexusPwa }, { json: true }).message);
    expect(json).toEqual([expect.objectContaining({ id: 'pty /?&', webUrl: 'http://127.0.0.1:31415/app/term?pty=pty+%2F%3F%26' })]);
    expect(calls).toBe(1);

    const human = runPtyList({ ...base, listRefs: () => [{ id: 'pty /?&', kind: 'shell', source: 'local' as const, alive: true }], resolveNexusPwa }).message;
    expect(human).toContain('http://127.0.0.1:31415/app/term?pty=pty+%2F%3F%26');
    expect(calls).toBe(2);
  });

  // ⛔⭐ GOAL-T80 회귀: 해석기가 「밖에서 여는 주소」를 고르면 링크가 «그것»을 따라가야 한다.
  //   종전엔 `loopback` 을 읽어, 해석기의 선택이 «조용히» 버려졌다.
  test('follows the base the resolver chose — a tailnet pick must not fall back to loopback', () => {
    const resolveNexusPwa = () => ({
      status: 'registered' as const,
      loopback: 'http://127.0.0.1:31415/app/',
      url: 'https://host.ts.net:31415/app/',
      source: 'tailnet' as const,
    });
    const json = JSON.parse(runPtyList({ ...base, ...jsonManifestDeps, listManifestRows: () => [liveRow], listManifestRowsAt: () => [liveRow], isProcessAlive: () => true, now: () => 1, resolveNexusPwa }, { json: true }).message);
    expect(json[0].webUrl).toBe('https://host.ts.net:31415/app/term?pty=pty+%2F%3F%26');
    expect(json[0].webUrl).not.toContain('127.0.0.1');
    expect(json[0].webUrlSource).toBe('tailnet');

    const human = runPtyList({ ...base, listRefs: () => [{ id: 'pty /?&', kind: 'shell', source: 'local' as const, alive: true }], resolveNexusPwa }).message;
    expect(human).toContain('https://host.ts.net:31415/app/term?pty=pty+%2F%3F%26');
    expect(human).toContain('(tailnet)');
  });

  test('distinguishes daemon absence from an unknown PWA URL in JSON and federated human rows', () => {
    const absent = () => ({ status: 'absent' as const, reason: 'daemon-absent' as const });
    const unknown = () => ({ status: 'unregistered' as const, reason: 'pwa-url-unknown' as const, pid: 1 });
    const json = JSON.parse(runPtyList({ ...base, ...jsonManifestDeps, listManifestRows: () => [liveRow], listManifestRowsAt: () => [liveRow], isProcessAlive: () => true, now: () => 1, resolveNexusPwa: absent }, { json: true }).message);
    expect(json[0]).toMatchObject({ pwaUnavailableReason: 'daemon-absent' });
    // ⛔⭐ 「링크가 없다」를 ***키 부재***로 재지 않는다 — 이제 키는 «언제나» 있고 값이 `null` 이다
    //    (수용기준 ⑤: 키 집합이 출처·상태로 갈리면 안 된다). 뜻은 그대로고 표현만 바뀌었다.
    expect(json[0]).toHaveProperty('webUrl');
    expect(json[0].webUrl).toBeNull();

    const federated = runPtyList({ ...base, listFederatedRefs: () => ({ refs: [{ instance: 'other', id: 'pty', kind: 'shell', alive: true, ownerProcessAlive: true }], unreadable: [] }), resolveNexusPwa: unknown }, { all: true });
    expect(federated.message).toBe('other\t-\tpty\tshell\t-\talive\t-\tno-run-id\torigin=unknown reason=legacy-or-malformed-origin-decision\tpurpose=workdir-not-recorded\tweb-unavailable=pwa-url-unknown\npurpose-known rows: 0/1');
  });
});

describe('runPtyList federated tree identities', () => {
  const base = {
    getPty: () => undefined,
    requestPtyTakeover: () => false,
    requestRemote: async () => ({ status: 'unknown-pty' as const }),
    log: () => {},
  };

  test('adds distinct tree labels only to federated human rows and uses the existing missing marker', () => {
    const federated = runPtyList({
      ...base,
      listFederatedRefs: () => ({
        refs: [
          { instance: 'test:monad-agent', id: 'pty-a', kind: 'shell', alive: true, ownerProcessAlive: true, sourceRoot: '/Users/a/source/tree-a/.elanous/pty/manifest.db' },
          { instance: 'test:monad-agent', id: 'pty-b', kind: 'shell', alive: true, ownerProcessAlive: true, sourceRoot: '/Users/b/source/tree-b/.elanous/pty/manifest.db' },
          { instance: 'test:monad-agent', id: 'pty-missing', kind: 'shell', alive: true, ownerProcessAlive: true },
        ],
        unreadable: [],
      }),
    }, { all: true });
    expect(federated).toEqual({
      exitCode: 0,
      message: [
        'test:monad-agent\ttree-a\tpty-a\tshell\t-\talive\t-\tno-run-id\torigin=unknown reason=legacy-or-malformed-origin-decision\tpurpose=workdir-not-recorded',
        'test:monad-agent\ttree-b\tpty-b\tshell\t-\talive\t-\tno-run-id\torigin=unknown reason=legacy-or-malformed-origin-decision\tpurpose=workdir-not-recorded',
        'test:monad-agent\t-\tpty-missing\tshell\t-\talive\t-\tno-run-id\torigin=unknown reason=legacy-or-malformed-origin-decision\tpurpose=workdir-not-recorded',
        'purpose-known rows: 0/3',
      ].join('\n'),
    });

    const nonFederated = runPtyList({
      ...base,
      listRefs: () => [{ id: 'pty-local', kind: 'shell', source: 'local' as const, alive: true }],
    });
    expect(nonFederated).toEqual({ exitCode: 0, message: 'pty-local\tshell\t-\tlocal\talive\t?\t-\t-\torigin=unknown reason=legacy-or-malformed-origin-decision\tpurpose=workdir-not-recorded\npurpose-known rows: 0/1' });

    const json = JSON.parse(runPtyList({
      ...base,
      currentManifestDbPath: () => '/roots/current/pty/manifest.db',
      manifestTargets: () => [{ name: 'current', dbPath: '/roots/current/pty/manifest.db' }],
      listManifestRowsAt: () => [row({ id: 'pty-json', instance: 'current', ownerPid: 1, ptyPid: 1 })],
      isProcessAlive: () => true,
    }, { all: true, json: true }).message);
    expect(json).toEqual([expect.objectContaining({
      id: 'pty-json',
      instance: 'current',
      sourceRoot: { name: 'current', dbPath: '/roots/current/pty/manifest.db' },
    })]);
    expect(json[0]).not.toHaveProperty('tree');
  });
});

describe('runPtyList JSON source roots', () => {
  const base = {
    getPty: () => undefined,
    requestPtyTakeover: () => false,
    requestRemote: async () => ({ status: 'unknown-pty' as const }),
    log: () => {},
    isProcessAlive: () => true,
    now: () => 20,
  };

  // ⛔⭐ 리뷰 must-fix 의 «그 시나리오»를 그대로 세운다: 주변 리더가 «다른 저장소»의 행을 돌려준다.
  //   종전 구현은 출처를 currentDbPath 에서 고르고 «행»은 주변 리더에서 읽어, 그 행들에 이 뿌리의
  //   sourceRoot 를 «거짓으로» 붙였다 — 이 칸이 막으려던 바로 그 사고를 이 칸이 만들었다.
  //   ⇒ 읽은 경로와 붙이는 출처가 «같은 값»에서 나와야 한다.
  test('reads single-root rows from the resolved root, not from an ambient reader', () => {
    const manifest = '/roots/current/pty/manifest.db';
    const result = JSON.parse(runPtyList({
      ...base,
      currentManifestDbPath: () => manifest,
      manifestTargets: () => [{ name: 'test:monad-agent', dbPath: manifest }],
      // 주변 리더는 «다른» 저장소를 본다 — 구현이 이걸 쓰면 라벨이 거짓이 된다.
      listManifestRows: () => [row({ id: 'from-elsewhere', instance: 'test:monad-agent', ownerPid: 1, ptyPid: 1 })],
      listManifestRowsAt: (dbPath: string) => (dbPath === manifest
        ? [row({ id: 'from-resolved-root', instance: 'test:monad-agent', ownerPid: 1, ptyPid: 1 })]
        : []),
    }, { json: true }).message) as Array<{ id: string; sourceRoot?: { dbPath: string } }>;
    expect(result.map((r) => r.id)).toEqual(['from-resolved-root']);
    expect(result[0]?.sourceRoot?.dbPath).toBe(manifest);
  });

  // ⛔ 리뷰 must-fix: 뿌리 지정 리더«만» 갖춘 구성이 이유 없이 실패하면 안 된다.
  //   (종전 가드가 아무도 안 쓰는 listManifestRows 를 요구해 이 구성을 거부했다)
  test('accepts a deps set that provides only the rooted manifest reader', () => {
    const manifest = '/roots/current/pty/manifest.db';
    const result = JSON.parse(runPtyList({
      ...base,
      currentManifestDbPath: () => manifest,
      manifestTargets: () => [{ name: 'test:monad-agent', dbPath: manifest }],
      listManifestRowsAt: () => [row({ id: 'rooted-only', instance: 'test:monad-agent', ownerPid: 1, ptyPid: 1 })],
    }, { json: true }).message) as Array<{ id: string }>;
    expect(result.map((r) => r.id)).toEqual(['rooted-only']);
  });

  test('includes the current manifest root without changing instance', () => {
    const manifest = '/roots/current/pty/manifest.db';
    const result = JSON.parse(runPtyList({
      ...base,
      currentManifestDbPath: () => manifest,
      manifestTargets: () => [{ name: 'test:monad-agent', dbPath: manifest }],
      listManifestRows: () => [row({ id: 'current', instance: 'test:monad-agent', ownerPid: 1, ptyPid: 1 })],
      listManifestRowsAt: () => [row({ id: 'current', instance: 'test:monad-agent', ownerPid: 1, ptyPid: 1 })],
    }, { json: true }).message);

    expect(result).toEqual([expect.objectContaining({
      id: 'current',
      instance: 'test:monad-agent',
      sourceRoot: { name: 'test:monad-agent', dbPath: manifest },
    })]);
  });

  test('rejects an unregistered current manifest instead of inventing its source root', () => {
    const result = runPtyList({
      ...base,
      currentManifestDbPath: () => '/roots/injected/pty/manifest.db',
      manifestTargets: () => [{ name: 'actual-root', dbPath: '/roots/actual/pty/manifest.db' }],
      listManifestRows: () => [row({ id: 'injected', ownerPid: 1, ptyPid: 1 })],
      listManifestRowsAt: () => [row({ id: 'injected', ownerPid: 1, ptyPid: 1 })],
    }, { json: true });

    expect(result).toEqual({
      exitCode: 1,
      message: 'pty list --json: current manifest target is unregistered: /roots/injected/pty/manifest.db',
    });
  });
});

describe('runPtyList empty-result scope', () => {
  const base = {
    getPty: () => undefined,
    requestPtyTakeover: () => false,
    requestRemote: async () => ({ status: 'unknown-pty' as const }),
    log: () => {},
  };

  test('names the selected human-readable scope only when the listing is empty', () => {
    expect(runPtyList({ ...base, listRefs: () => [] })).toEqual({ exitCode: 0, message: 'pty list: no PTYs found (scope: current instance only)\npurpose-known rows: 0/0' });
    expect(runPtyList({ ...base, listFederatedRefs: () => ({ refs: [], unreadable: [] }) }, { all: true })).toEqual({ exitCode: 0, message: 'pty list: no PTYs found (scope: all registered non-test instances)\npurpose-known rows: 0/0' });
    expect(runPtyList({ ...base, listFederatedRefs: () => ({ refs: [], unreadable: [] }) }, { all: true, includeTest: true })).toEqual({ exitCode: 0, message: 'pty list: no PTYs found (scope: all registered instances, including isolated test instances)\npurpose-known rows: 0/0' });
    expect(runPtyList({ ...base, listRefs: () => [{ id: 'pty_live', kind: 'shell', source: 'local' as const, alive: true }] })).toEqual({ exitCode: 0, message: 'pty_live\tshell\t-\tlocal\talive\t?\t-\t-\torigin=unknown reason=legacy-or-malformed-origin-decision\tpurpose=workdir-not-recorded\npurpose-known rows: 0/1' });
  });

  test('keeps JSON stdout as an array and sends an empty-result scope notice through the CLI stderr path', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const originalOut = process.stdout.write;
    const originalErr = process.stderr.write;
    process.stdout.write = ((chunk: string) => { stdout.push(chunk); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => { stderr.push(chunk); return true; }) as typeof process.stderr.write;
    try {
      const program = new Command();
      registerPtyTakeoverCommands(program, {
        ...base,
        currentManifestDbPath: () => '/roots/current/pty/manifest.db',
        manifestTargets: () => [{ name: 'actual-current-root', dbPath: '/roots/current/pty/manifest.db' }],
        listManifestRows: () => [],
        listManifestRowsAt: () => [],
        isProcessAlive: () => true,
      });
      await program.parseAsync(['node', 'elanous', 'pty', 'list', '--json']);
      expect(stdout).toEqual(['[]\n']);
      expect(JSON.parse(stdout[0]!)).toEqual([]);
      expect(stderr).toEqual(['pty list: no PTYs found (scope: current instance only)\n']);
      expect(process.exitCode).toBe(0);
      const jsonDeps = {
        ...base,
        currentManifestDbPath: () => '/roots/current/pty/manifest.db',
        listManifestRows: () => [],
        isProcessAlive: () => true,
        manifestTargets: () => [{ name: 'actual-current-root', dbPath: '/roots/current/pty/manifest.db' }],
        listManifestRowsAt: () => [],
      };
      expect(runPtyList(jsonDeps, { json: true })).toEqual({
        exitCode: 0,
        message: '[]',
        notice: 'pty list: no PTYs found (scope: current instance only)',
      });
      expect(runPtyList(jsonDeps, { all: true, json: true })).toEqual({
        exitCode: 0,
        message: '[]',
        notice: 'pty list: no PTYs found (scope: all registered non-test instances)',
      });
      expect(runPtyList(jsonDeps, { all: true, includeTest: true, json: true })).toEqual({
        exitCode: 0,
        message: '[]',
        notice: 'pty list: no PTYs found (scope: all registered instances, including isolated test instances)',
      });
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
      process.exitCode = 0;
    }
  });

  test('preserves unreadable fail-closed and partial-list behavior over scope notices', () => {
    expect(runPtyList({ ...base, listFederatedRefs: () => ({ refs: [], unreadable: ['broken'] }) }, { all: true })).toEqual({
      exitCode: 1, message: 'pty list --all: could not read 1 instance manifest(s): broken',
    });
    expect(runPtyList({ ...base, listFederatedRefs: () => ({ refs: [{ instance: 'current', id: 'pty_live', kind: 'shell', alive: true, ownerProcessAlive: true }], unreadable: ['broken'] }) }, { all: true })).toEqual({
      exitCode: 0, message: 'current\t-\tpty_live\tshell\t-\talive\t-\tno-run-id\torigin=unknown reason=legacy-or-malformed-origin-decision\tpurpose=workdir-not-recorded\npurpose-known rows: 0/1\n⚠️ partial: could not read broken',
    });
  });
});

describe('runPtyList remote bookmark', () => {
  const localRow = row({ id: 'pty_local_only', instance: 'current', ownerPid: 1, ptyPid: 1, startedAt: 10, updatedAt: 10 });
  const jsonManifestDeps = {
    currentManifestDbPath: () => '/roots/current/pty/manifest.db',
    manifestTargets: () => [{ name: 'current', dbPath: '/roots/current/pty/manifest.db' }],
    listManifestRows: () => [localRow],
    listManifestRowsAt: () => [localRow],
    isProcessAlive: () => true,
    now: () => 20,
  };
  const base: PtyTakeoverCommandDeps = {
    getPty: () => undefined,
    requestPtyTakeover: () => false,
    requestRemote: async () => ({ status: 'unknown-pty' as const }),
    log: () => {},
    ...jsonManifestDeps,
  };

  function isolatedStore(opts: { defaultName: string; otherName?: string; token?: string }): { store: RemotesStore; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'pty-list-remote-'));
    const tokens = join(dir, 'remotes');
    mkdirSync(tokens, { recursive: true });
    const store = new RemotesStore({ remotesFilePath: join(dir, 'remotes.json'), tokensDir: tokens });
    const tok = store.saveToken(opts.defaultName, opts.token ?? 'secret-token');
    store.addRemote(opts.defaultName, {
      host: opts.defaultName,
      acp_url: 'ws://127.0.0.1:31416/v1/acp',
      token_file: tok,
      addedAt: '2026-09-01T00:00:00Z',
    }, { setDefault: true });
    if (opts.otherName) {
      const otherTok = store.saveToken(opts.otherName, 'other-token');
      store.addRemote(opts.otherName, {
        host: opts.otherName,
        acp_url: 'ws://127.0.0.1:31999/v1/acp',
        token_file: otherTok,
        addedAt: '2026-09-01T00:00:00Z',
      });
    }
    return { store, dir };
  }

  afterEach(() => {
    process.exitCode = 0;
  });

  test('no-remote invocation keeps the local manifest path', () => {
    const { store, dir } = isolatedStore({ defaultName: 'good' });
    try {
      const result = runPtyList({
        ...base,
        remotesStore: () => store,
        fetchRemoteTerminals: async () => { throw new Error('remote must not be fetched without -r'); },
        listRefs: () => [{ id: 'pty_local_only', kind: 'shell', source: 'local' as const, alive: true }],
      });
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('pty_local_only');
      expect(result.message).not.toContain('pty_remote_1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('remote JSON uses the same keys as local JSON and marks unavailable liveness as unknown', async () => {
    const { store, dir } = isolatedStore({ defaultName: 'good' });
    try {
      // ⭐ 라이브 경로는 `resolveNexusPwa` 를 «항상» 부른다(기본 deps). 시험도 그렇게 세운다 —
      //   안 그러면 「시험에서만 생기는 상태」로 계약을 재게 된다(리뷰 should-fix 로 잡힌 축).
      const pwaAbsent = { ...base, resolveNexusPwa: () => ({ status: 'absent', reason: 'daemon-absent' }) as const };
      const local = JSON.parse(runPtyList(pwaAbsent, { json: true }).message) as Array<Record<string, unknown>>;
      const remote = JSON.parse((await runPtyList({
        ...base,
        remotesStore: () => store,
        fetchRemoteTerminals: async () => ({
          ok: true,
          terminals: [{ id: 'pty_remote_1', kind: 'shell', alive: true, startedAt: 10, instance: 'good' }],
        }),
      }, { json: true, remote: true })).message) as Array<Record<string, unknown>>;
      expect(local[0]?.id).toBe('pty_local_only');
      expect(remote[0]?.id).toBe('pty_remote_1');
      expect(Object.keys(local[0]!).sort()).toEqual(Object.keys(remote[0]!).sort());
      expect(remote[0]?.ownerProcessAlive).toBe('unknown');
      expect(remote[0]?.ownerProcessAlive).not.toBe(false);
      expect(local[0]?.ownerProcessAlive).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('omitted remote alive/outputBytes/instance/sourceRoot stay unknown, not false/0/bookmark host', async () => {
    const { store, dir } = isolatedStore({ defaultName: 'good' });
    try {
      const remote = JSON.parse((await runPtyList({
        ...base,
        remotesStore: () => store,
        fetchRemoteTerminals: async () => ({
          ok: true,
          terminals: [{ id: 'pty_remote_sparse' }],
        }),
      }, { json: true, remote: true })).message) as Array<Record<string, unknown>>;
      expect(remote[0]?.id).toBe('pty_remote_sparse');
      expect(remote[0]?.alive).toBe('unknown');
      expect(remote[0]?.alive).not.toBe(false);
      expect(remote[0]?.outputBytesTotal).toBe('unknown');
      expect(remote[0]?.outputBytesTotal).not.toBe(0);
      expect(remote[0]?.instance).toBe('unknown');
      expect(remote[0]?.instance).not.toBe('good');
      expect(remote[0]?.sourceRoot).toBe('unknown');
      expect(remote[0]?.sourceRoot).not.toEqual({ name: 'good', dbPath: 'good' });
      expect(remote[0]?.ownerProcessAlive).toBe('unknown');
      // ⛔⭐ 유래는 «unknown» 이어야 한다 — `workdir-not-recorded` 가 아니다.
      //   🩸 옛 판이 그것을 단언했고 리뷰가 must-fix 로 잡았다: 그 값은 ***저쪽 기계에 대한 사실 주장***인데
      //      우리는 그 기계에서 git 을 돌린 적이 없다. 응답이 그 칸을 «안 실었다」는 것과
      //      «저쪽에 기록이 없다»는 것은 다른 값이다.
      expect(remote[0]?.provenanceReason).toBe('unknown');
      expect(remote[0]?.provenanceReason).not.toBe('workdir-not-recorded');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ⭐⭐ **「모름」과 「없음」이 «갈리는지»를 직접 문는다** (리뷰 must-fix 로 요구된 시험).
  //   ⛔ 앞 시험은 「생략됐을 때」만 본다 — 그것만으로는 두 경우가 «같은 답»을 낼 수도 있다.
  //      두 입력을 «나란히» 넣어 산출이 달라지는지 보는 것이 이 축의 자다.
  // ⭐⭐⭐ **진짜 HTTP 서버를 띄운다** — 리뷰가 지정한 GOODHART PASSING PROOF 그대로.
  //   🩸 아래 `fetchRemoteTerminals` 주입 시험은 ***실제 파서(`parseRemoteTerminalItem`)를 «우회»한다.***
  //      그래서 파서가 `workdir: ''` 를 «생략»으로 접고 있어도 초록이었다. 리뷰가 그것을 잡았다.
  //   ⇒ 여기서는 서버가 «진짜 JSON 을 내고» 그것이 파서·직렬화를 다 거친 stdout 을 본다.
  test('LIVE HTTP: an empty remote workdir survives the real parser (not folded into omitted)', async () => {
    const { store, dir } = isolatedStore({ defaultName: 'live' });
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        // ⭐ 인증 헤더가 «실제로» 실려 오는지도 같이 본다 — 안 실리면 서버가 그것을 말한다.
        if (!req.headers.get('authorization')) return new Response('no-auth', { status: 401 });
        return Response.json({
          terminals: [
            { id: 'live_empty', workdir: '' },
            { id: 'live_omitted' },
            { id: 'live_present', workdir: '/tmp/live/tree' },
          ],
        });
      },
    });
    try {
      // 북마크를 그 서버로 다시 가리킨다(포트는 OS 가 골랐다).
      store.addRemote('live', {
        host: `127.0.0.1:${server.port}`,
        acp_url: `ws://127.0.0.1:${server.port}/v1/acp`,
        token_file: store.saveToken('live', 'live-token'),
        addedAt: '2026-09-01T00:00:00Z',
      }, { setDefault: true });

      const out = (await runPtyList({ ...base, remotesStore: () => store }, { json: true, remote: true })).message;
      const rows = JSON.parse(out) as Array<Record<string, unknown>>;
      const byId = Object.fromEntries(rows.map((r) => [r.id as string, r]));

      // ⛔ 자를 «먼저» 누른다 — 세 행이 다 와야 아래 판정이 뜻을 갖는다.
      expect(Object.keys(byId).sort()).toEqual(['live_empty', 'live_omitted', 'live_present']);
      // ⭐ 본 판정: 빈 값이 «키로» 살아남는다 — stdout 문자열에서도 확인한다.
      expect('workdir' in byId.live_empty!).toBe(true);
      expect(byId.live_empty?.workdir).toBe('');
      expect(out).toContain('"workdir": ""');
      // ⊕ 그리고 생략과 «갈린다».
      expect('workdir' in byId.live_omitted!).toBe(false);
      expect(byId.live_present?.workdir).toBe('/tmp/live/tree');
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ⭐⭐⭐ **수용기준 ⑤ — 키 집합은 «출처»로도 «PWA 상태»로도 갈리지 않는다.**
  //
  // 🩸 이 시험은 «두 번» 약했다. 둘 다 남긴다 — 다음 사람이 같은 길을 판다.
  //   ① 로컬을 «이 기계의 실제 manifest」로 읽어 `startedAt` 유무가 갈렸고,
  //      나는 그 차이를 「출처 차이」로 읽을 뻔했다 ⇒ 양쪽 입력을 «통제»했다.
  //   ② 그다음엔 «양쪽을 PWA-absent 로 고정»해 비교했다 — 그건 ***실패해야 할 경우를 지운 것***이고
  //      리뷰가 Goodhart 로 잡았다. 그리고 내가 적은 *"원리상 불가"* 도 ***틀렸다***:
  //      ***`webUrl: null` 이면 주소를 지어내지 않고도 키가 보존된다.***
  //   ⇒ 이제 ***PWA 가 «등록된» 로컬***과 원격을 «그대로» 비교한다. 조건을 안 맞춘다.
  test('수용기준 ⑤ — registered-local and remote JSON rows have IDENTICAL key sets', async () => {
    const { store, dir } = isolatedStore({ defaultName: 'good' });
    try {
      const localRow = row({ id: 'pty_ctl', startedAt: 10, outputBytesTotal: 0 });
      const localDeps = {
        ...base,
        currentManifestDbPath: () => '/roots/current/pty/manifest.db',
        manifestTargets: () => [{ name: 'cur', dbPath: '/roots/current/pty/manifest.db' }],
        listManifestRows: () => [localRow],
        listManifestRowsAt: () => [localRow],
        isProcessAlive: () => true,
        now: () => 100,
      };
      const remoteRowInput = { id: 'pty_ctl', kind: 'pty', alive: true, startedAt: 10, outputBytes: 0 };
      const registered = () => ({ status: 'registered', loopback: 'http://127.0.0.1:31416', url: 'http://127.0.0.1:31416', source: 'local' }) as const;
      const keysOf = (msg: string) => Object.keys((JSON.parse(msg) as Array<Record<string, unknown>>)[0]!).sort();

      // ⓐ 로컬 — PWA 가 ***등록된*** 상태. 실제 링크가 나온다.
      const localMsg = runPtyList({ ...localDeps, resolveNexusPwa: registered }, { json: true }).message;
      const localRowOut = (JSON.parse(localMsg) as Array<Record<string, unknown>>)[0]!;
      expect(localRowOut.webUrl).toBeTypeOf('string');          // ⛔ 자를 먼저 누른다 — 진짜 등록 상태인가
      expect(localRowOut.pwaUnavailableReason).toBeNull();

      // ⓑ 원격 — 같은 선택 필드. ⛔ 조건을 «맞추지 않는다»(PWA 는 등록된 채로 둔다).
      const remoteMsg = (await runPtyList({
        ...localDeps,
        remotesStore: () => store,
        resolveNexusPwa: registered,
        fetchRemoteTerminals: async () => ({ ok: true, terminals: [remoteRowInput] }),
      }, { json: true, remote: true })).message;
      const remoteRowOut = (JSON.parse(remoteMsg) as Array<Record<string, unknown>>)[0]!;

      // ⭐⭐ 본 판정: 정렬된 키가 ***정확히 같다***.
      expect(keysOf(remoteMsg)).toEqual(keysOf(localMsg));

      // ⭐ 그리고 «값»으로 갈린다 — 주소를 지어내지 않았다.
      expect(remoteRowOut.webUrl).toBeNull();
      expect(remoteRowOut.webUrlSource).toBeNull();
      expect(remoteRowOut.pwaUnavailableReason).toBe('remote-not-queried');
      // ⛔ 「원격이라 안 물었다」를 「데몬이 없다」와 접지 않는다.
      expect(remoteRowOut.pwaUnavailableReason).not.toBe('daemon-absent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ⊕ PWA 가 «부재»인 로컬도 같은 키를 낸다 — 상태가 키를 안 가른다.
  test('수용기준 ⑤ — an ABSENT-PWA local row keeps the same key set too', () => {
    const localRow = row({ id: 'pty_ctl', startedAt: 10, outputBytesTotal: 0 });
    const localDeps = {
      ...base,
      currentManifestDbPath: () => '/roots/current/pty/manifest.db',
      manifestTargets: () => [{ name: 'cur', dbPath: '/roots/current/pty/manifest.db' }],
      listManifestRows: () => [localRow],
      listManifestRowsAt: () => [localRow],
      isProcessAlive: () => true,
      now: () => 100,
    };
    const keysOf = (msg: string) => Object.keys((JSON.parse(msg) as Array<Record<string, unknown>>)[0]!).sort();
    const registered = keysOf(runPtyList({ ...localDeps, resolveNexusPwa: () => ({ status: 'registered', loopback: 'http://127.0.0.1:31416', url: 'http://127.0.0.1:31416', source: 'local' }) }, { json: true }).message);
    const absent = keysOf(runPtyList({ ...localDeps, resolveNexusPwa: () => ({ status: 'absent', reason: 'daemon-absent' }) }, { json: true }).message);
    expect(absent).toEqual(registered);
    // ⛔ 그리고 «값»은 갈린다 — 키가 같다고 사실이 같은 것은 아니다.
    const absentRow = (JSON.parse(runPtyList({ ...localDeps, resolveNexusPwa: () => ({ status: 'absent', reason: 'daemon-absent' }) }, { json: true }).message) as Array<Record<string, unknown>>)[0]!;
    expect(absentRow.webUrl).toBeNull();
    expect(absentRow.pwaUnavailableReason).toBe('daemon-absent');
  });

  // ⭐⭐⭐ **원격 유래도 「없으면 «모른다»」다** — 리뷰가 지정한 실제 HTTP 시험.
  //   🩸 로컬용 기본값 `reason=legacy-or-malformed-origin-decision` 은 ***「그 기계의 옛/손상된 결정이었다」***는
  //      사실 주장이다. 원격에서는 그저 «응답이 칸을 안 실은 것»일 수 있다(옛 서버는 그 필드가 없다).
  //   ⇒ `workdir`·`provenanceReason` 과 «같은 계급»의 결함이었다.
  test('LIVE HTTP: an omitted remote origin becomes unknown, not a legacy-decision claim', async () => {
    const { store, dir } = isolatedStore({ defaultName: 'live2' });
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (!req.headers.get('authorization')) return new Response('no-auth', { status: 401 });
        return Response.json({
          terminals: [
            { id: 'origin_omitted' },                                                              // 유래 칸이 «없다»
            { id: 'origin_given', terminalOriginCategory: 'elanous', terminalOriginReason: 'spawned-by-run' },
          ],
        });
      },
    });
    try {
      store.addRemote('live2', {
        host: `127.0.0.1:${server.port}`,
        acp_url: `ws://127.0.0.1:${server.port}/v1/acp`,
        token_file: store.saveToken('live2', 'live-token'),
        addedAt: '2026-09-01T00:00:00Z',
      }, { setDefault: true });

      const jsonOut = (await runPtyList({ ...base, remotesStore: () => store }, { json: true, remote: true })).message;
      const rows = JSON.parse(jsonOut) as Array<Record<string, unknown>>;
      const byId = Object.fromEntries(rows.map((r) => [r.id as string, r]));
      expect(Object.keys(byId).sort()).toEqual(['origin_given', 'origin_omitted']);   // ⛔ 자를 먼저 누른다

      // ⭐ 본 판정: 생략된 유래가 «옛 결정»으로 단정되지 않는다.
      expect(byId.origin_omitted?.terminalOriginReason).toBe('remote-origin-not-reported');
      expect(byId.origin_omitted?.terminalOriginReason).not.toBe('legacy-or-malformed-origin-decision');
      expect(byId.origin_omitted?.terminalOriginCategory).toBe('unknown');
      // ⊕ 칸이 «오면» 그대로 쓴다 — 가드가 «전부»를 덮으면 그것도 결함이다.
      expect(byId.origin_given?.terminalOriginReason).toBe('spawned-by-run');
      expect(byId.origin_given?.terminalOriginCategory).toBe('elanous');

      // ⊕ 사람 산출(텍스트)에서도 그 문면이 «안 나온다».
      const textOut = (await runPtyList({ ...base, remotesStore: () => store }, { remote: true })).message;
      expect(textOut).not.toContain('legacy-or-malformed-origin-decision');
      expect(textOut).toContain('remote-origin-not-reported');
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ⭐ **`--all` 은 원격에서 «조용히 무시»되지 않는다** (리뷰 should-fix).
  //   ⛔ 조용히 무시하면 사람은 「전 인스턴스를 봤다」고 믿는다 — 이 판이 내내 고쳐 온 형태다.
  test('`--all` with `--remote` fails loudly instead of being silently dropped', async () => {
    const { store, dir } = isolatedStore({ defaultName: 'good' });
    try {
      const all = await runPtyList({
        ...base, remotesStore: () => store,
        fetchRemoteTerminals: async () => { throw new Error('원격을 부르면 안 된다 — 그 전에 멈춰야 한다'); },
      }, { all: true, remote: true });
      expect(all.exitCode).toBe(1);
      expect(all.message).toContain('--all');
      // ⊕ include-test 도 같은 축이다.
      const inc = await runPtyList({
        ...base, remotesStore: () => store,
        fetchRemoteTerminals: async () => { throw new Error('부르면 안 된다'); },
      }, { includeTest: true, remote: true });
      expect(inc.exitCode).toBe(1);
      expect(inc.message).toContain('--include-test');
      // ⛔ 그리고 «없으면» 정상 동작한다 — 가드가 전부를 막으면 그것도 결함이다.
      const ok = await runPtyList({
        ...base, remotesStore: () => store,
        fetchRemoteTerminals: async () => ({ ok: true, terminals: [{ id: 'fine' }] }),
      }, { json: true, remote: true });
      expect(ok.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ⭐ 실패 문면이 ***어느 북마크인지***를 말한다 (리뷰 must-fix).
  //   ⛔ URL 만 말하면 `--remote other` 로 실패했을 때 `other` 가 사라진다.
  test('remote failure messages name the BOOKMARK, not just the URL', async () => {
    const { store, dir } = isolatedStore({ defaultName: 'good', otherName: 'other' });
    try {
      const named = await runPtyList({
        ...base, remotesStore: () => store,
        fetchRemoteTerminals: async () => ({ ok: false as const, status: 500, reason: 'HTTP 500' }),
      }, { json: true, remote: 'other' });
      expect(named.exitCode).toBe(1);
      expect(named.message).toContain('other');           // ⭐ 이름이 산다

      const byDefault = await runPtyList({
        ...base, remotesStore: () => store,
        fetchRemoteTerminals: async () => ({ ok: false as const, status: 500, reason: 'HTTP 500' }),
      }, { json: true, remote: true });
      expect(byDefault.exitCode).toBe(1);
      // ⛔ default 도 «식별 가능한 이름»을 댄다 — "default" 라는 말로 뭉개지 않는다.
      expect(byDefault.message).toContain('good');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('remote workdir: omitted vs explicitly present are DISTINGUISHABLE', async () => {
    const { store, dir } = isolatedStore({ defaultName: 'good' });
    try {
      const rows = JSON.parse((await runPtyList({
        ...base,
        remotesStore: () => store,
        fetchRemoteTerminals: async () => ({
          ok: true,
          terminals: [
            { id: 'pty_omitted' },                                  // workdir 칸이 «없다»
            { id: 'pty_present', workdir: '/tmp/some/tree' },        // 칸이 «있고 값이 있다»
            { id: 'pty_empty', workdir: '' },                        // 칸이 «있는데 빈 값»
          ],
        }),
      }, { json: true, remote: true })).message) as Array<Record<string, unknown>>;

      const byId = Object.fromEntries(rows.map((r) => [r.id as string, r]));
      // ⓐ 생략 — workdir 키가 «아예 없다»(빈 문자열로 채우지 않는다)
      expect('workdir' in byId.pty_omitted!).toBe(false);
      // ⓑ 제공 — 그 값이 «그대로» 산다
      expect(byId.pty_present?.workdir).toBe('/tmp/some/tree');
      // ⓒ 빈 값 — «있는 칸의 빈 값»이라 생략과 갈린다. ⛔ 둘을 한 값으로 접지 않는다.
      expect('workdir' in byId.pty_empty!).toBe(true);
      expect(byId.pty_empty?.workdir).toBe('');
      // ⭐ 본 판정: ⓐ 와 ⓒ 가 «다른 산출»이다. 접혔다면 이 단언이 깨진다.
      expect('workdir' in byId.pty_omitted!).not.toBe('workdir' in byId.pty_empty!);
      // ⊕ 셋 다 유래는 unknown 이다 — 우리는 어느 쪽에서도 git 을 돌리지 않았다.
      for (const id of ['pty_omitted', 'pty_present', 'pty_empty']) {
        expect({ id, reason: byId[id]?.provenanceReason }).toEqual({ id, reason: 'unknown' });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('provided remote alive/outputBytes/instance/sourceRoot/workdir are preserved', async () => {
    const { store, dir } = isolatedStore({ defaultName: 'good' });
    try {
      const result = await runPtyList({
        ...base,
        remotesStore: () => store,
        fetchRemoteTerminals: async () => ({
          ok: true,
          terminals: [{
            id: 'pty_remote_full',
            kind: 'shell',
            alive: true,
            instance: 'remote-instance',
            outputBytes: 42,
            workdir: '/remote/work',
            ownerProcessAlive: true,
            sourceRoot: { name: 'remote-root', dbPath: '/remote/pty/manifest.db' },
          }],
        }),
      }, { json: true, remote: true });
      const remote = JSON.parse(result.message) as Array<Record<string, unknown>>;
      expect(remote[0]?.id).toBe('pty_remote_full');
      expect(remote[0]?.alive).toBe(true);
      expect(remote[0]?.outputBytesTotal).toBe(42);
      expect(remote[0]?.instance).toBe('remote-instance');
      expect(remote[0]?.sourceRoot).toEqual({ name: 'remote-root', dbPath: '/remote/pty/manifest.db' });
      expect(remote[0]?.workdir).toBe('/remote/work');
      expect(remote[0]?.ownerProcessAlive).toBe(true);
      expect(remote[0]?.provenanceReason).toBe('unknown');
      expect(remote[0]?.provenanceReason).not.toBe('workdir-not-recorded');
      const text = await runPtyList({
        ...base,
        remotesStore: () => store,
        fetchRemoteTerminals: async () => ({
          ok: true,
          terminals: [{ id: 'pty_remote_full', kind: 'shell', alive: true, workdir: '/remote/work' }],
        }),
      }, { remote: true });
      expect(text.message).toContain('pty_remote_full');
      expect(text.message).toContain('/remote/work');
      expect(text.message).not.toContain('purpose=workdir-not-recorded');
      expect(text.message).toContain('purpose=unknown');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('remote text and JSON emit the remote terminal id and never fall back to local rows', async () => {
    const { store, dir } = isolatedStore({ defaultName: 'good' });
    try {
      const deps: PtyTakeoverCommandDeps = {
        ...base,
        remotesStore: () => store,
        listRefs: () => [{ id: 'pty_local_only', kind: 'shell', source: 'local' as const, alive: true }],
        fetchRemoteTerminals: async () => ({
          ok: true,
          terminals: [{ id: 'pty_remote_1', kind: 'shell', alive: true }],
        }),
      };
      const text = await runPtyList(deps, { remote: true });
      expect(text.exitCode).toBe(0);
      expect(text.message).toContain('pty_remote_1');
      expect(text.message).not.toContain('pty_local_only');
      const json = JSON.parse((await runPtyList(deps, { json: true, remote: true })).message);
      expect(json.map((row: { id: string }) => row.id)).toEqual(['pty_remote_1']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('remote HTTP failure names the lookup and does not emit local rows', async () => {
    const { store, dir } = isolatedStore({ defaultName: 'good' });
    try {
      const result = await runPtyList({
        ...base,
        remotesStore: () => store,
        listRefs: () => [{ id: 'pty_local_only', kind: 'shell', source: 'local' as const, alive: true }],
        fetchRemoteTerminals: async () => ({ ok: false, status: 500, reason: 'HTTP 500' }),
      }, { remote: true });
      expect(result.exitCode).toBe(1);
      expect(result.message).toMatch(/remote bookmark \S+: lookup failed/);
      expect(result.message).toMatch(/HTTP 500/);
      expect(result.message).not.toContain('pty_local_only');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('mock /v1/terminals via http acp_url hits origin /v1/terminals, not /v1/acp/v1/terminals', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-list-http-acp-'));
    const tokens = join(dir, 'remotes');
    mkdirSync(tokens, { recursive: true });
    const store = new RemotesStore({ remotesFilePath: join(dir, 'remotes.json'), tokensDir: tokens });
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        seen.push(url.pathname);
        if (url.pathname === '/v1/terminals') {
          return Response.json({ terminals: [{ id: 'pty_from_http_acp', kind: 'shell', alive: true }] });
        }
        return new Response('not-found', { status: 404 });
      },
    });
    const tok = store.saveToken('iso', 'http-token');
    store.addRemote('iso', {
      host: 'iso',
      acp_url: `http://127.0.0.1:${server.port}/v1/acp`,
      token_file: tok,
      addedAt: '2026-09-01T00:00:00Z',
    }, { setDefault: true });
    try {
      const result = await runPtyList({
        ...base,
        remotesStore: () => store,
        listRefs: () => [{ id: 'pty_local_only', kind: 'shell', source: 'local' as const, alive: true }],
      }, { json: true, remote: true });
      expect(result.exitCode).toBe(0);
      expect(seen).toEqual(['/v1/terminals']);
      expect(seen).not.toContain('/v1/acp/v1/terminals');
      const remote = JSON.parse(result.message) as Array<Record<string, unknown>>;
      expect(remote[0]?.id).toBe('pty_from_http_acp');
      expect(remote[0]?.alive).toBe(true);
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('mock /v1/terminals preserves id, alive, outputBytes, instance, and sourceRoot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-list-http-ok-'));
    const tokens = join(dir, 'remotes');
    mkdirSync(tokens, { recursive: true });
    const store = new RemotesStore({ remotesFilePath: join(dir, 'remotes.json'), tokensDir: tokens });
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/v1/terminals') {
          return Response.json({
            terminals: [{
              id: 'pty_from_http',
              kind: 'shell',
              alive: true,
              instance: 'remote-instance',
              outputBytes: 77,
              workdir: '/remote/work',
              sourceRoot: { name: 'remote-root', dbPath: '/remote/pty/manifest.db' },
            }],
          });
        }
        return new Response('not-found', { status: 404 });
      },
    });
    const tok = store.saveToken('iso', 'http-token');
    store.addRemote('iso', {
      host: 'iso',
      acp_url: `ws://127.0.0.1:${server.port}/v1/acp`,
      token_file: tok,
      addedAt: '2026-09-01T00:00:00Z',
    }, { setDefault: true });
    try {
      const result = await runPtyList({
        ...base,
        remotesStore: () => store,
        listRefs: () => [{ id: 'pty_local_only', kind: 'shell', source: 'local' as const, alive: true }],
      }, { json: true, remote: true });
      expect(result.exitCode).toBe(0);
      const remote = JSON.parse(result.message) as Array<Record<string, unknown>>;
      expect(remote[0]?.id).toBe('pty_from_http');
      expect(remote[0]?.alive).toBe(true);
      expect(remote[0]?.outputBytesTotal).toBe(77);
      expect(remote[0]?.instance).toBe('remote-instance');
      expect(remote[0]?.sourceRoot).toEqual({ name: 'remote-root', dbPath: '/remote/pty/manifest.db' });
      expect(remote.map((row) => row.id)).not.toContain('pty_local_only');
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('mock /v1/terminals HTTP 500 does not disguise itself as a local listing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-list-http-500-'));
    const tokens = join(dir, 'remotes');
    mkdirSync(tokens, { recursive: true });
    const store = new RemotesStore({ remotesFilePath: join(dir, 'remotes.json'), tokensDir: tokens });
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/v1/terminals') return new Response('boom', { status: 500 });
        return new Response('not-found', { status: 404 });
      },
    });
    const tok = store.saveToken('iso', 'http-token');
    store.addRemote('iso', {
      host: 'iso',
      acp_url: `ws://127.0.0.1:${server.port}/v1/acp`,
      token_file: tok,
      addedAt: '2026-09-01T00:00:00Z',
    }, { setDefault: true });
    try {
      const result = await runPtyList({
        ...base,
        remotesStore: () => store,
        listRefs: () => [{ id: 'pty_local_only', kind: 'shell', source: 'local' as const, alive: true }],
      }, { remote: true });
      expect(result.exitCode).toBe(1);
      expect(result.message).toMatch(/remote bookmark \S+: lookup failed/);
      expect(result.message).toMatch(/HTTP 500/);
      expect(result.message).not.toContain('pty_local_only');
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing default bookmark fails by name and does not list locally', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-list-noremote-'));
    const store = new RemotesStore({ remotesFilePath: join(dir, 'remotes.json'), tokensDir: join(dir, 'remotes') });
    try {
      const result = await runPtyList({
        ...base,
        remotesStore: () => store,
        listRefs: () => [{ id: 'pty_local_only', kind: 'shell', source: 'local' as const, alive: true }],
        fetchRemoteTerminals: async () => { throw new Error('must not fetch'); },
      }, { remote: true });
      expect(result.exitCode).toBe(1);
      expect(result.message).toMatch(/no default remote bookmark/);
      expect(result.message).not.toContain('pty_local_only');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('unknown named bookmark fails by name and does not list locally', async () => {
    const { store, dir } = isolatedStore({ defaultName: 'good' });
    try {
      const result = await runPtyList({
        ...base,
        remotesStore: () => store,
        listRefs: () => [{ id: 'pty_local_only', kind: 'shell', source: 'local' as const, alive: true }],
        fetchRemoteTerminals: async () => { throw new Error('must not fetch'); },
      }, { remote: 'nope' });
      expect(result.exitCode).toBe(1);
      expect(result.message).toMatch(/unknown bookmark/);
      expect(result.message).toContain('nope');
      expect(result.message).not.toContain('pty_local_only');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('CLI `-r` selects the default bookmark', async () => {
    const { store, dir } = isolatedStore({ defaultName: 'good', otherName: 'other' });
    const seen: Array<{ url: string; token: string }> = [];
    const stdout: string[] = [];
    const originalOut = process.stdout.write;
    process.stdout.write = ((chunk: string) => { stdout.push(chunk); return true; }) as typeof process.stdout.write;
    try {
      const program = new Command();
      registerPtyTakeoverCommands(program, {
        ...base,
        remotesStore: () => store,
        fetchRemoteTerminals: async (url, token) => {
          seen.push({ url, token });
          return { ok: true, terminals: [{ id: 'pty_default_remote', kind: 'shell', alive: true }] };
        },
      });
      await program.parseAsync(['node', 'elanous', 'pty', 'list', '-r']);
      expect(seen).toEqual([{ url: 'http://127.0.0.1:31416/v1/terminals', token: 'secret-token' }]);
      expect(stdout.join('')).toContain('pty_default_remote');
      expect(stdout.join('')).not.toContain('pty_local_only');
      expect(process.exitCode).toBe(0);
    } finally {
      process.stdout.write = originalOut;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('CLI `-r other` does not consume the token as a bookmark name and rejects the extra argument', async () => {
    const { store, dir } = isolatedStore({ defaultName: 'good', otherName: 'other' });
    const seen: Array<{ url: string; token: string }> = [];
    try {
      const program = new Command();
      program.exitOverride();
      registerPtyTakeoverCommands(program, {
        ...base,
        remotesStore: () => store,
        fetchRemoteTerminals: async (url, token) => {
          seen.push({ url, token });
          return { ok: true, terminals: [{ id: 'pty_should_not_list', kind: 'shell', alive: true }] };
        },
      });
      await expect(program.parseAsync(['node', 'elanous', 'pty', 'list', '-r', 'other'])).rejects.toThrow(/too many arguments/i);
      expect(seen).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('CLI `--remote <name>` selects that bookmark', async () => {
    const { store, dir } = isolatedStore({ defaultName: 'good', otherName: 'other' });
    const seen: Array<{ url: string; token: string }> = [];
    const stdout: string[] = [];
    const originalOut = process.stdout.write;
    process.stdout.write = ((chunk: string) => { stdout.push(chunk); return true; }) as typeof process.stdout.write;
    try {
      const program = new Command();
      registerPtyTakeoverCommands(program, {
        ...base,
        remotesStore: () => store,
        fetchRemoteTerminals: async (url, token) => {
          seen.push({ url, token });
          return { ok: true, terminals: [{ id: 'pty_named_remote', kind: 'shell', alive: true }] };
        },
      });
      await program.parseAsync(['node', 'elanous', 'pty', 'list', '--remote', 'other']);
      expect(seen).toEqual([{ url: 'http://127.0.0.1:31999/v1/terminals', token: 'other-token' }]);
      expect(stdout.join('')).toContain('pty_named_remote');
      expect(process.exitCode).toBe(0);
    } finally {
      process.stdout.write = originalOut;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('http(s) acp_url origin is used — pathname /v1/acp is not prefixed onto /v1/terminals', async () => {
    const cases = [
      { scheme: 'http', host: 'http://remote.example:31415/v1/acp', want: 'http://remote.example:31415/v1/terminals' },
      { scheme: 'https', host: 'https://remote.example:31415/v1/acp', want: 'https://remote.example:31415/v1/terminals' },
    ] as const;
    for (const spec of cases) {
      const dir = mkdtempSync(join(tmpdir(), `pty-list-acp-${spec.scheme}-`));
      const tokens = join(dir, 'remotes');
      mkdirSync(tokens, { recursive: true });
      const store = new RemotesStore({ remotesFilePath: join(dir, 'remotes.json'), tokensDir: tokens });
      const tok = store.saveToken('iso', 'http-token');
      store.addRemote('iso', {
        host: 'iso',
        acp_url: spec.host,
        token_file: tok,
        addedAt: '2026-09-01T00:00:00Z',
      }, { setDefault: true });
      const seen: string[] = [];
      try {
        const result = await runPtyList({
          ...base,
          remotesStore: () => store,
          listRefs: () => [{ id: 'pty_local_only', kind: 'shell', source: 'local' as const, alive: true }],
          fetchRemoteTerminals: async (url) => {
            seen.push(url);
            return { ok: true, terminals: [{ id: `pty_from_${spec.scheme}`, kind: 'shell', alive: true }] };
          },
        }, { json: true, remote: true });
        expect(result.exitCode).toBe(0);
        expect(seen).toEqual([spec.want]);
        expect(seen.some((url) => url.includes('/v1/acp/v1/terminals'))).toBe(false);
        const remote = JSON.parse(result.message) as Array<Record<string, unknown>>;
        expect(remote[0]?.id).toBe(`pty_from_${spec.scheme}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('remote rows omit local Nexus web links even when resolveNexusPwa is injected', async () => {
    const { store, dir } = isolatedStore({ defaultName: 'good' });
    try {
      const resolveNexusPwa = () => ({
        status: 'registered' as const,
        loopback: 'http://127.0.0.1:31415/app/',
        url: 'http://127.0.0.1:31415/app/',
        source: 'local' as const,
      });
      const result = await runPtyList({
        ...base,
        remotesStore: () => store,
        resolveNexusPwa,
        fetchRemoteTerminals: async () => ({
          ok: true,
          terminals: [{ id: 'pty_remote_nolink', kind: 'shell', alive: true }],
        }),
      }, { json: true, remote: true });
      expect(result.exitCode).toBe(0);
      const remote = JSON.parse(result.message) as Array<Record<string, unknown>>;
      expect(remote[0]?.id).toBe('pty_remote_nolink');
      // ⛔⭐ 키는 있고 값이 null 이다 — ***로컬 링크가 원격 행에 새지 않는다***는 것이 이 시험의 축이고,
      //    그것은 아래 `not.toContain('127.0.0.1:31415')` 가 «직접» 잰다.
      expect(remote[0]?.webUrl).toBeNull();
      expect(remote[0]?.pwaUnavailableReason).toBe('remote-not-queried');
      expect(result.message).not.toContain('127.0.0.1:31415');
      const text = await runPtyList({
        ...base,
        remotesStore: () => store,
        resolveNexusPwa,
        fetchRemoteTerminals: async () => ({
          ok: true,
          terminals: [{ id: 'pty_remote_nolink', kind: 'shell', alive: true }],
        }),
      }, { remote: true });
      expect(text.message).toContain('pty_remote_nolink');
      expect(text.message).not.toContain('127.0.0.1:31415');
      expect(text.message).not.toContain('/app/term');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('malformed remote terminal items fail the lookup instead of becoming an empty success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-list-malformed-'));
    const tokens = join(dir, 'remotes');
    mkdirSync(tokens, { recursive: true });
    const store = new RemotesStore({ remotesFilePath: join(dir, 'remotes.json'), tokensDir: tokens });
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/v1/terminals') {
          return Response.json({ terminals: [{ kind: 'shell', alive: true }, { id: 'pty_ok' }] });
        }
        return new Response('not-found', { status: 404 });
      },
    });
    const tok = store.saveToken('iso', 'http-token');
    store.addRemote('iso', {
      host: 'iso',
      acp_url: `ws://127.0.0.1:${server.port}/v1/acp`,
      token_file: tok,
      addedAt: '2026-09-01T00:00:00Z',
    }, { setDefault: true });
    try {
      const result = await runPtyList({
        ...base,
        remotesStore: () => store,
        listRefs: () => [{ id: 'pty_local_only', kind: 'shell', source: 'local' as const, alive: true }],
      }, { remote: true });
      expect(result.exitCode).toBe(1);
      expect(result.message).toMatch(/remote bookmark \S+: lookup failed/);
      expect(result.message).toMatch(/malformed/);
      expect(result.message).not.toContain('pty_local_only');
      expect(result.message).not.toContain('pty_ok');
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pty mouse CLI remote bookmark', () => {
  test('mouse --remote forwards structured click; agent HTTP path refuses without same-run proof', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-mouse-remote-'));
    const tokens = join(dir, 'remotes');
    mkdirSync(tokens, { recursive: true });
    const store = new RemotesStore({ remotesFilePath: join(dir, 'remotes.json'), tokensDir: tokens });
    const tokenFile = store.saveToken('good', 'test-token');
    store.addRemote('good', { host: 'good', acp_url: 'ws://127.0.0.1:31416/v1/acp', token_file: tokenFile, addedAt: '2026-09-01T00:00:00Z' }, { setDefault: true });
    const posted: unknown[] = [];
    const output: string[] = [];
    const previousOut = process.stdout.write;
    const previousErr = process.stderr.write;
    process.stdout.write = ((chunk: string) => { output.push(chunk); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => { output.push(chunk); return true; }) as typeof process.stderr.write;
    try {
      const command = new Command();
      registerPtyTakeoverCommands(command, { ...lineageDeps([], []), remotesStore: () => store,
        postRemoteTerminalControl: async (_url, _token, body) => { posted.push(body); return { ok: true, status: 200, json: { status: 'success' } }; },
      });
      await command.parseAsync(['node', 'elanous', 'pty', 'mouse', 'pty_one', '10', '5', '--remote', 'good']);
      expect(posted).toEqual([{ action: 'input-mouse', x: 10, y: 5, kind: 'click', button: 'left' }]);
      expect(process.exitCode).toBe(0);
      await command.parseAsync(['node', 'elanous', 'pty', 'mouse', 'pty_one', '3', '4', '--remote', 'good', '--scroll', 'down', '--button', 'right']);
      expect(posted[1]).toEqual({ action: 'input-mouse', x: 3, y: 4, kind: 'scroll-down', button: 'right' });
      await command.parseAsync(['node', 'elanous', 'pty', 'mouse', 'pty_one', '10', '5', '--remote', 'good', '--actor', 'agent']);
      expect(posted).toHaveLength(2);
      expect(process.exitCode).toBe(1);
      expect(output.join('')).toContain('cannot verify same-run agent ownership');
    } finally {
      process.stdout.write = previousOut;
      process.stderr.write = previousErr;
      process.exitCode = 0;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runPtyRelease', () => {
  function releaseDeps(local: boolean, result: PtyControlResult): PtyTakeoverCommandDeps {
    const calls: Array<{ id: string; action: string }> = [];
    const handle = {
      isAlive: () => true,
      accessMode: 'write' as const,
      transitionPolicy: 'locked' as const,
      setAccessMode: () => { throw new Error('release must use the IPC policy'); },
      canWrite: () => true,
      write: () => {},
      resize: () => {},
    };
    return {
      ...lineageDeps([], []),
      getPty: () => local ? handle : undefined,
      requestRemote: async (id, action) => { calls.push({ id, action }); return result; },
      log: () => {},
      releaseCalls: calls,
    } as PtyTakeoverCommandDeps & { releaseCalls: Array<{ id: string; action: string }> };
  }

  test('local and remote release both restore the policy result prior read mode and report it', async () => {
    const result = { status: 'success' as const, from: 'write' as const, to: 'read' as const, policy: 'open' as const };
    const local = releaseDeps(true, result) as PtyTakeoverCommandDeps & { releaseCalls: Array<{ id: string; action: string }> };
    const remote = releaseDeps(false, result) as PtyTakeoverCommandDeps & { releaseCalls: Array<{ id: string; action: string }> };

    await expect(runPtyRelease('pty-release', local)).resolves.toEqual({ exitCode: 0, message: 'pty release: pty-release returned to read mode' });
    await expect(runPtyRelease('pty-release', remote)).resolves.toEqual({ exitCode: 0, message: 'pty release: pty-release returned to read mode' });
    expect(local.releaseCalls).toEqual([{ id: 'pty-release', action: 'release' }]);
    expect(remote.releaseCalls).toEqual([{ id: 'pty-release', action: 'release' }]);
  });

  test('local and remote release report the policy result prior auto mode', async () => {
    const result = { status: 'success' as const, from: 'write' as const, to: 'auto' as const, policy: 'open' as const };
    const local = releaseDeps(true, result);
    const remote = releaseDeps(false, result);

    await expect(runPtyRelease('pty-release', local)).resolves.toEqual({ exitCode: 0, message: 'pty release: pty-release returned to auto mode' });
    await expect(runPtyRelease('pty-release', remote)).resolves.toEqual({ exitCode: 0, message: 'pty release: pty-release returned to auto mode' });
  });

  test('local and remote release surface the policy denial without a fallback mode', async () => {
    const result = { status: 'denied' as const, from: 'write' as const, policy: 'locked' as const, reason: 'transition-policy' as const };
    const local = releaseDeps(true, result);
    const remote = releaseDeps(false, result);

    await expect(runPtyRelease('pty-release', local)).resolves.toEqual({ exitCode: 1, message: 'pty release: denied for pty-release (transition-policy)' });
    await expect(runPtyRelease('pty-release', remote)).resolves.toEqual({ exitCode: 1, message: 'pty release: denied for pty-release (transition-policy)' });
  });
});

describe('livePtyGitRunner 공용 심', () => {
  afterEach(() => setGitCommandRunnerForTesting(undefined));

  test('ptyGitDiscoveryEnv() 가 만든 항목이 git 호출 환경에 그대로 실린다', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'pty-git-env-'));
    mkdirSync(join(workdir, '.git'));
    const seen: Array<{ encoding: unknown; env: NodeJS.ProcessEnv | undefined }> = [];
    try {
      setGitCommandRunnerForTesting((_cwd, args, options) => {
        seen.push({ encoding: options.encoding, env: options.env as NodeJS.ProcessEnv | undefined });
        if (args[0] === 'rev-parse') return { status: 0, stdout: 'true\n', stderr: '' };
        return { status: 1, stdout: '', stderr: '' };
      });
      expect(resolvePtyWorktreeProvenance(workdir)).toEqual({ known: false, provenanceReason: 'config-not-recorded' });
      expect(seen.length).toBeGreaterThan(0);
      const expected = ptyGitDiscoveryEnv();
      for (const call of seen) {
        expect(call.encoding).toBe('utf8');
        expect(call.env).toEqual(expected);
      }
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test('git status 가 0 이 아니면 provenance 는 성공과 구별되는 git-read-failed 로 간다', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'pty-git-fail-'));
    mkdirSync(join(workdir, '.git'));
    try {
      setGitCommandRunnerForTesting(() => ({ status: 128, stdout: 'true\n', stderr: 'fatal: boom' }));
      expect(resolvePtyWorktreeProvenance(workdir)).toEqual({ known: false, provenanceReason: 'git-read-failed' });
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
