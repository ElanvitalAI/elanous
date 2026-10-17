import { afterEach, describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { federatedPtyRefs, findPtyManifestRows, listPtyRefs, runPtyFind, runPtyKey, runPtyList, runPtyRelease, runPtyRename, runPtyResize, runPtyRetire, runPtySnapshot, runPtyState, runPtyTakeover, runPtyText, runPtyTextWhenIdle, runPtyWait, registerPtyTakeoverCommands, type PtyTakeoverCommandDeps } from '../../src/cli/pty-takeover-cli.js';
import { getPtyManifest, setPtyManifestDbPathForTesting, upsertPtyManifest, type PtyManifestRow } from '../../src/pty-shell/pty-manifest.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePtyRef } from '../../src/pty-shell/pty-ref.js';
import { setPtyAdapterForTesting, startPty, unregisterPty } from '../../src/pty-shell/registry.js';

const ids: string[] = [];

afterEach(() => {
  for (const id of ids.splice(0)) unregisterPty(id);
  setPtyAdapterForTesting(null);
  process.exitCode = 0;
});

function adapter() {
  return { pid: 42, write() {}, kill() {}, resize() {}, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }) };
}

function tracked(opts: Parameters<typeof startPty>[0]) {
  const handle = startPty(opts);
  ids.push(handle.id);
  return handle;
}

function depsFor(handle: ReturnType<typeof startPty>, events: string[]): PtyTakeoverCommandDeps {
  return {
    getPty: (id) => id === handle.id ? handle : undefined,
    requestPtyTakeover: (id, actor) => id === handle.id && actor === 'human' && handle.setAccessMode('write'),
    requestRemote: async (_id, action) => {
      if (action !== 'release') return { status: 'unknown-pty' };
      const from = handle.accessMode;
      handle.setAccessMode('auto');
      return { status: 'success', from, to: handle.accessMode, policy: handle.transitionPolicy };
    },
    listRefs: () => [{ id: handle.id, kind: handle.kind, source: 'local', alive: handle.isAlive() }],
    log: (event) => { events.push(event); },
  };
}

describe('pty takeover CLI commands', () => {
  test('list merges local handles with manifest rows, prefers local duplicates, and resolves every listed id', async () => {
    const refs = listPtyRefs([
      { id: 'pty_local', kind: 'tui', nickname: 'local-tui', workdir: undefined, isAlive: () => true, accessMode: 'auto' as const },
      // ⭐ `read`(관찰 전용)도 그대로 나와야 한다 — 세 모드 중 하나만 빠지면 이 컬럼을 만든 이유가 준다(리뷰 1R).
      { id: 'pty_ro', kind: 'shell', nickname: 'read-only', workdir: undefined, isAlive: () => true, accessMode: 'read' as const },
      { id: 'pty_shared', kind: 'local-shell', nickname: 'local-shared', workdir: undefined, isAlive: () => false, accessMode: 'write' as const },
    ], [
      { id: 'pty_shared', kind: 'remote-shell', nickname: 'remote-shared', alive: true },
      { id: 'pty_remote', kind: 'shell', nickname: 'remote-shell', alive: false },
    ]);
    const remote: string[] = [];
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined, requestPtyTakeover: () => false,
      requestRemote: async (id) => { remote.push(id); return { status: 'success' }; },
      listRefs: () => refs,
      log() {},
    };

    expect(runPtyList(deps)).toEqual({
      exitCode: 0,
      message: 'pty_local\ttui\tlocal-tui\tlocal\talive\tauto\t-\t-\torigin=unknown reason=legacy-or-malformed-origin-decision\tpurpose=workdir-not-recorded\tturn=?\npty_ro\tshell\tread-only\tlocal\talive\tread\t-\t-\torigin=unknown reason=legacy-or-malformed-origin-decision\tpurpose=workdir-not-recorded\npty_shared\tlocal-shell\tlocal-shared\tlocal\tdead\twrite\t-\t-\torigin=unknown reason=legacy-or-malformed-origin-decision\tpurpose=workdir-not-recorded\npty_remote\tshell\tremote-shell\tremote\tdead\t?\t-\t-\torigin=unknown reason=legacy-or-malformed-origin-decision\tpurpose=workdir-not-recorded\npurpose-known rows: 0/4',
    });
    expect(refs.filter((ref) => ref.id === 'pty_shared')).toEqual([{
      id: 'pty_shared', kind: 'local-shell', nickname: 'local-shared', source: 'local', alive: false, mode: 'write',
    }]);
    for (const ref of refs) expect(resolvePtyRef(ref.id, deps.listRefs!()).match?.id).toBe(ref.id);
    await Promise.all(refs.map((ref) => expect(runPtyText(ref.id, 'x', false, deps)).resolves.toMatchObject({ exitCode: 0 })));
    expect(remote).toEqual(refs.map((ref) => ref.id));
  });

  test('list appends a run column (boot build, stale) only for rows that record a build', () => {
    const row = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({
      id, kind, cmd: 'elanous', ownerPid: 1, ptyPid: 0, instance: 'prod', startedAt: 100, alive: true, exitCode: null,
      snapshot: '', snapshotAt: 0, outputBytesTotal: 0, updatedAt: 200, frame: '', frameAt: 0, runId: '', runIdSource: '' as const, spaceId: '', sessionId: '',
      parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '', ...extra,
    });
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined, requestPtyTakeover: () => false, requestRemote: async () => ({ status: 'unknown-pty' as const }), log() {},
      listRefs: () => [
        { id: 'tui:1', kind: 'tui', source: 'remote', alive: true },
        { id: 'tui:2', kind: 'tui', source: 'remote', alive: true },
        { id: 'tui:3', kind: 'tui', source: 'remote', alive: true },
        { id: 'pty_sh', kind: 'shell', source: 'remote', alive: true },
      ],
      listManifestRows: () => [
        row('tui:1', 'tui', { build: { version: 'v', sha: 'a'.repeat(40), source: 'installed' } }),
        row('tui:2', 'tui', { build: { version: 'v', sha: 'b'.repeat(40), source: 'installed' } }),
        // 판 기록 없는 옛 TUI 행 — 설치본이 그 행보다 늦게 깔렸다 ⇒ 추정 stale.
        row('tui:3', 'tui'),
        row('pty_sh', 'shell'),
      ],
      readInstalledBuild: () => ({ sha: 'b'.repeat(40), installedAt: 150 }),
      resolveWorktreeProvenance: () => ({ known: false, provenanceReason: 'workdir-not-recorded' }),
    };
    const lines = runPtyList(deps).message.split('\n');
    // ⭐ H10: TUI 행엔 턴 칸이 붙는다 — 턴 기록이 없는 행은 «모른다»(`turn=?`) · 셸 행엔 없다.
    expect(lines[0]).toEndWith('\trun=aaaaaaa,stale\tturn=?');
    expect(lines[1]).toEndWith('\trun=bbbbbbb\tturn=?');
    expect(lines[2]).toEndWith('\trun=?,stale\tturn=?');
    expect(lines[3]).not.toContain('run=');
    expect(lines[3]).not.toContain('turn=');
    // 설치본 판독기가 없는 구성은 판 칸을 안 낸다(기계마다 다른 값이 새지 않게).
    const { readInstalledBuild: _omit, ...withoutReader } = deps;
    expect(runPtyList(withoutReader).message).not.toContain('run=');
    // ⭐ 턴 칸은 판독기와 무관하다 — 판독기가 없어도 TUI 행마다 그대로 나온다.
    const bare = runPtyList(withoutReader).message.split('\n');
    expect(bare.slice(0, 3).every((line) => line.endsWith('\tturn=?'))).toBe(true);
    expect(bare[3]).not.toContain('turn=');
  });

  test('list shows the self-reported turn cell (busy with elapsed seconds · idle) without reading the screen', () => {
    const row = (id: string, extra: Partial<PtyManifestRow> = {}): PtyManifestRow => ({
      id, kind: 'tui', cmd: 'elanous', ownerPid: 1, ptyPid: 0, instance: 'prod', startedAt: 100, alive: true, exitCode: null,
      snapshot: '', snapshotAt: 0, outputBytesTotal: 0, updatedAt: 200, frame: '', frameAt: 0, runId: '', runIdSource: '', spaceId: '', sessionId: '',
      parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
      build: { version: 'v', sha: 'c'.repeat(40), source: 'installed' }, ...extra,
    });
    let screenReads = 0;
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined, requestPtyTakeover: () => false,
      requestRemote: async () => { screenReads++; return { status: 'unknown-pty' as const }; }, log() {},
      listRefs: () => [
        { id: 'tui:busy', kind: 'tui', source: 'remote', alive: true },
        { id: 'tui:idle', kind: 'tui', source: 'remote', alive: true },
      ],
      listManifestRows: () => [
        row('tui:busy', { turnState: 'busy', turnAt: 1_000_000 }),
        row('tui:idle', { turnState: 'idle', turnAt: 1_040_000 }),
      ],
      readInstalledBuild: () => ({ sha: 'c'.repeat(40) }),
      resolveWorktreeProvenance: () => ({ known: false, provenanceReason: 'workdir-not-recorded' }),
      now: () => 1_042_500,
    };
    const lines = runPtyList(deps).message.split('\n');
    expect(lines[0]).toEndWith('\trun=ccccccc\tturn=busy,42s');
    expect(lines[1]).toEndWith('\trun=ccccccc\tturn=idle,2s');
    expect(screenReads).toBe(0);
    // 설치본 판독기가 없어도(판 칸 없음) 턴 칸은 같은 값으로 나온다.
    const { readInstalledBuild: _r, ...noReader } = deps;
    const bare = runPtyList(noReader).message.split('\n');
    expect(bare[0]).toEndWith('\tpurpose=workdir-not-recorded\tturn=busy,42s');
    expect(bare[1]).toEndWith('\tpurpose=workdir-not-recorded\tturn=idle,2s');
    // manifest 행이 없는 TUI ref → «모른다»(`turn=?`) · 셸 ref 엔 칸이 없다.
    const noRows = runPtyList({ ...deps, listRefs: () => [{ id: 'tui:ghost', kind: 'tui', source: 'remote', alive: true }, { id: 'sh:1', kind: 'shell', source: 'remote', alive: true }] }).message.split('\n');
    expect(noRows[0]).toEndWith('\tturn=?');
    expect(noRows[1]).not.toContain('turn=');
    // 행 조회 예외 → «모른다».
    const throwing = runPtyList({ ...deps, listManifestRows: () => { throw new Error('manifest locked'); } }).message.split('\n');
    expect(throwing[0]).toEndWith('\tturn=?');
    // ref 는 TUI 인데 같은 id 의 manifest 행 종류가 다르면 칸을 «빼지 않고» 모른다로 낸다(r2 mf).
    const mismatch = runPtyList({ ...deps, listManifestRows: () => [row('tui:busy', { kind: 'shell', turnState: 'busy', turnAt: 1_000_000 }), row('tui:idle', { turnState: 'idle', turnAt: 1_040_000 })] }).message.split('\n');
    expect(mismatch[0]).toEndWith('\tturn=?');
    expect(mismatch[1]).toEndWith('\tturn=idle,2s');
  });

  test('list distinguishes no PTYs from unavailable reference listing', () => {
    const base = { getPty: () => undefined, requestPtyTakeover: () => false, requestRemote: async () => ({ status: 'unknown-pty' as const }), log() {} };
    expect(runPtyList({ ...base, listRefs: () => [] })).toEqual({ exitCode: 0, message: 'pty list: no PTYs found (scope: current instance only)\npurpose-known rows: 0/0' });
    expect(runPtyList(base)).toEqual({ exitCode: 1, message: 'pty list: PTY reference listing is unavailable' });
  });

  test('list --json exposes the monotonic output total without changing liveness fields', () => {
    const row: PtyManifestRow = {
      id: 'pty_json', kind: 'tui', cmd: 'elanous', ownerPid: 41, ptyPid: 42, instance: 'test', startedAt: 1,
      alive: true, exitCode: null, snapshot: '', snapshotAt: 0, outputBytesTotal: 123, updatedAt: 1_000,
      frame: '', frameAt: 0, runId: '', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
    };
    const result = runPtyList({
      getPty: () => undefined, requestPtyTakeover: () => false, requestRemote: async () => ({ status: 'unknown-pty' }), log() {},
      listManifestRows: () => [row], currentManifestDbPath: () => '/roots/current/pty/manifest.db', manifestTargets: () => [{ name: 'actual-current-root', dbPath: '/roots/current/pty/manifest.db' }], isProcessAlive: (pid) => pid === 42, now: () => 1_100,
      listManifestRowsAt: () => [row],
    }, { json: true });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.message)).toEqual([{
      id: 'pty_json', kind: 'tui', instance: 'test', sourceRoot: { name: 'actual-current-root', dbPath: '/roots/current/pty/manifest.db' }, alive: true,
      ownerProcessAlive: true, updatedAgeMs: 100, outputBytesTotal: 123, runTerminated: 'no-run-id',
      // ⛔ 출처 두 칸은 «항상» 실린다 — 주입 여부에 따라 사라지면 「안 냈다」와 「그 축이 없다」를 못 가른다.
      runTerminationSource: 'unknown', runStoreIo: 'not-checked',
      // ⭐ 2026-08-19 — 「이 화면이 «쓰이고 있나»」 축이 더해졌다(#10354). 런 식별자가 없으면 이 축으로 못 묻는다.
      ownerRunUsage: 'no-run-id',
      provenanceReason: 'workdir-not-recorded',
      terminalOriginCategory: 'unknown', terminalOriginReason: 'legacy-or-malformed-origin-decision',
      // ⭐ 「얼마나 오래 있었나」 — updatedAgeMs(마지막 갱신 이후)와 «다른 축»이다.
      //   fixture: startedAt=1 · now=1_100 ⇒ 1_099.
      ageMs: 1_099,
      // ⭐ #14980 이 원격·로컬 «키 대칭»으로 더한 셋 — null 은 「모른다」이지 「없다」가 아니다.
      webUrl: null, webUrlSource: null, pwaUnavailableReason: null,
      // ⭐ H10 — 턴·판 칸은 «언제나» 실린다. 턴 기록이 없는 행은 unknown/null.
      turn: { state: 'unknown', at: null, sinceSec: null }, build: null,
    }]);
  });

  test('list --json carries the self-reported turn (busy + elapsed) and the boot build of a TUI row', () => {
    const row: PtyManifestRow = {
      id: 'tui:7', kind: 'tui', cmd: 'elanous', ownerPid: 7, ptyPid: 0, instance: 'test', startedAt: 1,
      alive: true, exitCode: null, snapshot: '', snapshotAt: 0, outputBytesTotal: 0, updatedAt: 99_000,
      frame: '', frameAt: 0, runId: '', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
      turnState: 'busy', turnAt: 58_000, build: { version: '0.2.31-dev.0', sha: 'd'.repeat(40), source: 'installed' },
    };
    let installedReads = 0;
    const logs: Array<[string, unknown]> = [];
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined, requestPtyTakeover: () => false, requestRemote: async () => ({ status: 'unknown-pty' }),
      log: (event, data) => logs.push([event, data]),
      currentManifestDbPath: () => '/r/pty/manifest.db', manifestTargets: () => [{ name: 'test', dbPath: '/r/pty/manifest.db' }],
      isProcessAlive: () => true, now: () => 100_000, listManifestRowsAt: () => [row, { ...row, id: 'tui:8' }],
      readInstalledBuild: () => { installedReads++; return { sha: 'e'.repeat(40) }; },
    };
    const json = JSON.parse(runPtyList(deps, { json: true }).message);
    expect(json[0].turn).toEqual({ state: 'busy', at: 58_000, sinceSec: 42 });
    expect(json[0].build).toEqual({ version: '0.2.31-dev.0', sha: 'd'.repeat(40), source: 'installed', stale: true, staleReason: 'installed-moved' });
    // 설치본 기록은 목록 한 번에 한 번만 읽는다(r2 should-fix).
    expect(installedReads).toBe(1);
    // 턴 끝 → idle 로 바뀌면 같은 칸이 idle 과 그 경과를 낸다.
    const idle = JSON.parse(runPtyList({ ...deps, listManifestRowsAt: () => [{ ...row, turnState: 'idle', turnAt: 99_000 }] }, { json: true }).message);
    expect(idle[0].turn).toEqual({ state: 'idle', at: 99_000, sinceSec: 1 });
    expect(logs.filter(([event]) => event === 'list-build-read-failed')).toEqual([]);
    // 판독 예외 계약: 기록된 턴은 그대로 · 판 sha 는 기록값 그대로 · 낡음만 «모른다»(stale=null) · `list-build-read-failed` 관측.
    const broken = JSON.parse(runPtyList({ ...deps, readCheckoutHead: () => { throw new Error('git exploded'); }, listManifestRowsAt: () => [{ ...row, build: { version: 'v', sha: 'a'.repeat(40), source: 'checkout', codeRoot: '/r' } }] }, { json: true }).message);
    expect(broken[0].turn).toEqual({ state: 'busy', at: 58_000, sinceSec: 42 });
    expect(broken[0].build).toEqual({ version: 'v', sha: 'a'.repeat(40), source: 'checkout', stale: null, staleReason: 'unknown' });
    expect(logs.filter(([event]) => event === 'list-build-read-failed')).toEqual([['list-build-read-failed', { ptyId: 'tui:7', source: 'checkout-head', error: 'git exploded' }]]);
    logs.length = 0;
    const thrownInstalled = JSON.parse(runPtyList({ ...deps, readInstalledBuild: () => { throw new Error('install.json unreadable'); } }, { json: true }).message);
    expect(thrownInstalled.map((r: { turn: unknown }) => r.turn)).toEqual([{ state: 'busy', at: 58_000, sinceSec: 42 }, { state: 'busy', at: 58_000, sinceSec: 42 }]);
    expect(thrownInstalled[0].build).toEqual({ version: '0.2.31-dev.0', sha: 'd'.repeat(40), source: 'installed', stale: null, staleReason: 'unknown' });
    // 목록당 한 줄(행마다 아님).
    expect(logs.filter(([event]) => event === 'list-build-read-failed')).toEqual([['list-build-read-failed', { source: 'installed', error: 'install.json unreadable' }]]);    // 행의 build 접근 자체가 터져도 그 행만 build:null — 목록 전체와 그 행의 턴은 산다.
    logs.length = 0;
    const poisoned = Object.defineProperty({ ...row, id: 'tui:poison' }, 'build', { get() { throw new Error('poisoned build'); }, enumerable: true }) as PtyManifestRow;
    const listed = runPtyList({ ...deps, listManifestRowsAt: () => [poisoned, row] }, { json: true });
    expect(listed.exitCode).toBe(0);
    const pj = JSON.parse(listed.message);
    expect(pj.map((r: { id: string; build: unknown; turn: { state: string } }) => [r.id, r.build === null, r.turn.state])).toEqual([['tui:poison', true, 'busy'], ['tui:7', false, 'busy']]);
    expect(logs.filter(([event]) => event === 'list-build-read-failed')).toEqual([['list-build-read-failed', { ptyId: 'tui:poison', source: 'describe', error: 'poisoned build' }]]);
  });

  test('list text keeps the turn cell when the build read fails (installed reader throws · run column throws)', () => {
    const logs: Array<[string, unknown]> = [];
    const row: PtyManifestRow = {
      id: 'tui:9', kind: 'tui', cmd: 'elanous', ownerPid: 9, ptyPid: 0, instance: 'prod', startedAt: 100, alive: true, exitCode: null,
      snapshot: '', snapshotAt: 0, outputBytesTotal: 0, updatedAt: 200, frame: '', frameAt: 0, runId: '', runIdSource: '', spaceId: '', sessionId: '',
      parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
      turnState: 'busy', turnAt: 10_000, build: { version: 'v', sha: 'f'.repeat(40), source: 'installed' },
    };
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined, requestPtyTakeover: () => false, requestRemote: async () => ({ status: 'unknown-pty' as const }),
      log: (event, data) => logs.push([event, data]),
      listRefs: () => [{ id: 'tui:9', kind: 'tui', source: 'remote', alive: true }],
      listManifestRows: () => [row],
      readInstalledBuild: () => { throw new Error('install.json unreadable'); },
      resolveWorktreeProvenance: () => ({ known: false, provenanceReason: 'workdir-not-recorded' }),
      now: () => 52_000,
    };
    const result = runPtyList(deps);
    expect(result.exitCode).toBe(0);
    expect(result.message.split('\n')[0]).toEndWith('\trun=fffffff\tturn=busy,42s');
    expect(logs.some(([event, data]) => event === 'list-build-read-failed' && (data as { source: string }).source === 'installed')).toBe(true);
    // 판 칸 계산 자체가 터져도(뜻밖의 행 모양) 그 행과 턴 칸은 산다 — 판 칸만 비운다.
    logs.length = 0;
    const poisoned = { ...row, build: Object.defineProperty({ version: 'v', source: 'installed' }, 'sha', { get() { throw new Error('poisoned row'); }, enumerable: true }) as PtyManifestRow['build'] };
    const survived = runPtyList({ ...deps, readInstalledBuild: () => ({}), listManifestRows: () => [poisoned] });
    expect(survived.exitCode).toBe(0);
    const line = survived.message.split('\n')[0]!;
    expect(line).toEndWith('\tpurpose=workdir-not-recorded\tturn=busy,42s');
    expect(line).not.toContain('run=');
    expect(logs.filter(([event]) => event === 'list-build-read-failed')).toEqual([['list-build-read-failed', { ptyId: 'tui:9', source: 'run-column', error: 'poisoned row' }]]);
  });

  test('list --all --json preserves colliding instance names while identifying each manifest root', () => {
    const roots = [
      { name: 'axon', dbPath: '/roots/axon/monad-agent/.elanous-test/pty/manifest.db' },
      { name: 'pilot', dbPath: '/roots/pilot/monad-agent/.elanous-test/pty/manifest.db' },
    ] as const;
    const rows: Record<string, PtyManifestRow[]> = {
      [roots[0].dbPath]: [{
        id: 'pty_axon', kind: 'tui', cmd: 'elanous', ownerPid: 41, ptyPid: 42, instance: 'test:monad-agent', startedAt: 1,
        alive: true, exitCode: null, snapshot: '', snapshotAt: 0, outputBytesTotal: 0, updatedAt: 1_000,
        frame: '', frameAt: 0, runId: '', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
      }],
      [roots[1].dbPath]: [{
        id: 'pty_pilot', kind: 'tui', cmd: 'elanous', ownerPid: 43, ptyPid: 44, instance: 'test:monad-agent', startedAt: 1,
        alive: true, exitCode: null, snapshot: '', snapshotAt: 0, outputBytesTotal: 0, updatedAt: 1_000,
        frame: '', frameAt: 0, runId: '', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
      }],
    };
    const result = JSON.parse(runPtyList({
      getPty: () => undefined, requestPtyTakeover: () => false, requestRemote: async () => ({ status: 'unknown-pty' }), log() {},
      listManifestRows: () => [], listManifestRowsAt: (dbPath) => rows[dbPath] ?? [], manifestTargets: () => roots,
      isProcessAlive: () => true, now: () => 1_100,
    }, { all: true, includeTest: true, json: true }).message);

    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'pty_axon', instance: 'test:monad-agent', sourceRoot: roots[0] }),
      expect.objectContaining({ id: 'pty_pilot', instance: 'test:monad-agent', sourceRoot: roots[1] }),
    ]));
  });

  // ⛔⭐ 2026-07-30 실측 — 하니스 자식 PTY 는 **자기 워크트리 인스턴스**에 등록되므로
  //    부모 뿌리의 `pty list` 로는 영영 안 보였다. `--all` 이 그 목록만 연합한다.
  test('federatedPtyRefs — alive와 프로세스 생존을 함께 확인하고 ptyPid를 우선한다', () => {
    const rows: Record<string, Array<{ id: string; kind: string; nickname?: string; alive: boolean; ownerPid?: number; ptyPid?: number; instance?: string }>> = {
      '/a/manifest.db': [
        { id: 'self_1', kind: 'self', alive: true, ownerPid: 11, ptyPid: 12 },
        { id: 'dead_1', kind: 'self', alive: false, ownerPid: 13 },
        { id: 'ghost_1', kind: 'self', alive: true, ownerPid: 14, ptyPid: 15 },
        { id: 'unknown_1', kind: 'self', alive: true },
      ],
      '/b/manifest.db': [
        { id: 'self_1', kind: 'self', alive: true, ownerPid: 16 },
        { id: 'tui_9', kind: 'tui', nickname: 'nine', alive: true, ownerPid: 17, instance: 'stamped' },
      ],
    };
    const checked: number[] = [];
    expect(federatedPtyRefs(
      [{ name: 'wt-a', dbPath: '/a/manifest.db' }, { name: 'wt-b', dbPath: '/b/manifest.db' }],
      (dbPath) => rows[dbPath] ?? [],
      (pid) => { checked.push(pid); return pid !== 15; },
    )).toEqual({
      refs: [
        // ⭐ 2026-08-19(#10354) — 「소유 프로세스가 사나」가 ref 에 실린다. 「화면이 alive」와 «다른 축»이다.
        { instance: 'wt-a', id: 'self_1', kind: 'self', alive: true, sourceRoot: '/a/manifest.db', ownerProcessAlive: true },
        { instance: 'stamped', id: 'tui_9', kind: 'tui', nickname: 'nine', alive: true, sourceRoot: '/b/manifest.db', ownerProcessAlive: true },
      ],
      unreadable: [],
    });
    expect(checked).toEqual([12, 15, 16, 17]);
  });

  // ⛔⭐ 리뷰 must-fix — 읽기 실패를 삼키면 *"PTY 가 없다"* 와 *"못 봤다"* 가 같은 모습이 된다.
  test('읽기 실패한 뿌리는 이름으로 남고, 전부 실패하면 fail-closed 다', () => {
    const listing = federatedPtyRefs(
      [{ name: 'ok', dbPath: '/ok' }, { name: 'broken', dbPath: '/broken' }],
      (dbPath) => { if (dbPath === '/broken') throw new Error('db locked'); return [{ id: 'a', kind: 'tui', alive: true, ownerPid: process.pid }]; },
    );
    expect(listing).toEqual({ refs: [{ instance: 'ok', id: 'a', kind: 'tui', alive: true, sourceRoot: '/ok', ownerProcessAlive: true }], unreadable: ['broken'] });

    const base = { getPty: () => undefined, requestPtyTakeover: () => false, requestRemote: async () => ({ status: 'unknown-pty' as const }), log() {} };
    // 일부만 실패 ⇒ 목록은 주되 **부분임을 밝힌다**
    expect(runPtyList({ ...base, listFederatedRefs: () => listing }, { all: true })).toEqual({
      exitCode: 0, message: 'ok\t-\ta\ttui\t-\talive\t-\tno-run-id\torigin=unknown reason=legacy-or-malformed-origin-decision\tpurpose=workdir-not-recorded\npurpose-known rows: 0/1\n⚠️ partial: could not read broken',
    });
    // 전부 실패 ⇒ "없다"가 아니라 **못 봤다**
    expect(runPtyList({ ...base, listFederatedRefs: () => ({ refs: [], unreadable: ['broken', 'other'] }) }, { all: true })).toEqual({
      exitCode: 1, message: 'pty list --all: could not read 2 instance manifest(s): broken, other',
    });
  });

  test('list --all 은 인스턴스를 첫 칸에 싣고, 연합 주입이 없으면 fail-closed 다', () => {
    const base = { getPty: () => undefined, requestPtyTakeover: () => false, requestRemote: async () => ({ status: 'unknown-pty' as const }) };
    const events: Array<Record<string, unknown>> = [];
    const deps: PtyTakeoverCommandDeps = {
      ...base,
      listRefs: () => [{ id: 'local_only', kind: 'tui', source: 'local', alive: true }],
      listFederatedRefs: ({ includeTest }) => ({
        refs: includeTest ? [{ instance: 'test:wt-docs', id: 'self_a', kind: 'self', alive: true }] : [],
        unreadable: [],
      }),
      log(_event, data) { events.push(data); },
    };
    expect(runPtyList(deps, { all: true, includeTest: true })).toEqual({
      exitCode: 0, message: 'test:wt-docs\t-\tself_a\tself\t-\talive\t-\tunknown\torigin=unknown reason=legacy-or-malformed-origin-decision\tpurpose=workdir-not-recorded\npurpose-known rows: 0/1',
    });
    expect(events.at(-1)).toMatchObject({ federated: true, includeTest: true, count: 1 });
    // ⭐ 격리 test 는 기본 제외 — 빈 목록이 "없다"로 정직하게 나온다.
    expect(runPtyList(deps, { all: true })).toEqual({ exitCode: 0, message: 'pty list: no PTYs found (scope: all registered non-test instances)\npurpose-known rows: 0/0' });
    // ⛔ 연합 주입이 없으면 로컬 목록으로 **조용히 대체하지 않는다**.
    const noFed: PtyTakeoverCommandDeps = { ...base, listRefs: deps.listRefs!, log() {} };
    expect(runPtyList(noFed, { all: true })).toEqual({ exitCode: 1, message: 'pty list --all: federated listing is unavailable' });
    // ⛔ `--include-test` 단독은 조용히 무시되지 않는다 — 격리를 봤다고 착각시키면 안 된다.
    expect(runPtyList(deps, { includeTest: true })).toEqual({ exitCode: 1, message: 'pty list: --include-test only applies with --all' });
  });

  test('find tests every key axis and retire proves before deleting only with --yes', () => {
    const row: PtyManifestRow = {
      id: 'pty_ghost', kind: 'tui', cmd: 'elanous', ownerPid: 41, ptyPid: 42, instance: 'test', startedAt: 1,
      alive: true, exitCode: null, snapshot: '', snapshotAt: 0, outputBytesTotal: 0, updatedAt: 1_000,
      frame: '', frameAt: 0, runId: 'run_42', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
    };
    const matches = findPtyManifestRows([row], '42');
    expect(matches).toEqual([{ row, matchedBy: ['ptyPid'] }]);
    expect(findPtyManifestRows([row], '41')[0]?.matchedBy).toEqual(['ownerPid']);
    expect(findPtyManifestRows([row], 'pty_ghost')[0]?.matchedBy).toEqual(['ptyId']);
    expect(findPtyManifestRows([row], 'run_42')[0]?.matchedBy).toEqual(['runId']);
    const removed: string[] = [];
    const rows = [row];
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined, requestPtyTakeover: () => false, requestRemote: async () => ({ status: 'unknown-pty' }), log() {},
      listManifestRows: () => rows, isProcessAlive: (pid) => pid !== 42, now: () => 1_000 + 60 * 60 * 1000,
      // The fake drops the row so the command's post-removal re-read has something real to observe.
      removeManifest: (id) => {
        removed.push(id);
        const at = rows.findIndex((candidate) => candidate.id === id);
        if (at >= 0) rows.splice(at, 1);
      },
    };
    expect(runPtyFind('missing', deps)).toEqual({ exitCode: 0, message: 'pty find: no manifest rows matched ptyPid, ownerPid, ptyId, or runId' });
    const preview = runPtyRetire('42', deps);
    expect(preview.exitCode).toBe(0);
    expect(preview.message).toContain('ownership ownerPid=41 instance=test');
    expect(preview.message).toContain('inactivity updatedAt=1000');
    expect(preview.message).toContain('liveness pid=42 alive=false');
    expect(preview.message).toContain('state alive=true closedAt=0');
    expect(preview.message).toContain('removable=true reasons=2');
    expect(removed).toEqual([]);
    expect(runPtyRetire('42', deps, true).message).toContain('removed');
    expect(removed).toEqual(['pty_ghost']);
  });

  test('live find and retire dry-run use the non-reaping manifest reader', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'pty-cli-live-reader-'));
    const manifestPath = join(stateRoot, 'pty', 'manifest.db');
    setPtyManifestDbPathForTesting(manifestPath);
    try {
      upsertPtyManifest({ id: 'pty_live_ghost', kind: 'tui', cmd: 'elanous', startedAt: 1, now: 1, ptyPid: 999_999_999 });
      expect(runPtyFind('999999999')).toMatchObject({ exitCode: 0, message: expect.stringContaining('pty_live_ghost') });
      expect(runPtyRetire('pty_live_ghost')).toMatchObject({ exitCode: 0, message: expect.stringContaining('dry-run') });
      const retained = getPtyManifest('pty_live_ghost');
      expect(retained).toMatchObject({ id: 'pty_live_ghost', alive: true, ptyPid: 999_999_999 });
    } finally {
      setPtyManifestDbPathForTesting(null);
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  test('retire --yes refuses a current alive manifest and preserves its row', () => {
    const row: PtyManifestRow = {
      id: 'pty_active', kind: 'tui', cmd: 'elanous', ownerPid: 41, ptyPid: 42, instance: 'test', startedAt: 1,
      alive: true, exitCode: null, snapshot: '', snapshotAt: 0, outputBytesTotal: 0, updatedAt: 10_000,
      frame: '', frameAt: 0, runId: 'run_active', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
    };
    const removed: string[] = [];
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined, requestPtyTakeover: () => false, requestRemote: async () => ({ status: 'unknown-pty' }), log() {},
      listManifestRows: () => [row], isProcessAlive: (pid) => pid === 42, now: () => 10_001,
      removeManifest: (id) => { removed.push(id); },
    };

    const result = runPtyRetire('42', deps, true);
    const message = Array.isArray(result.message) ? result.message.join('\n') : result.message;
    expect(result.exitCode).toBe(1);
    expect(message).toContain('removable=false');
    expect(message).toContain('removal refused; manifest row is not removable');
    expect(removed).toEqual([]);
    expect(deps.listManifestRows!()).toEqual([row]);
  });

  test('find and retire are registered through Commander and retire forwards --yes', async () => {
    const program = new Command();
    const out: string[] = [];
    const originalOut = process.stdout.write;
    process.stdout.write = ((chunk: string) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
    const row: PtyManifestRow = {
      id: 'pty_cli', kind: 'tui', cmd: 'elanous', ownerPid: 7, ptyPid: 8, instance: 'test', startedAt: 1,
      alive: false, exitCode: 0, snapshot: '', snapshotAt: 0, outputBytesTotal: 0, updatedAt: 1,
      frame: '', frameAt: 0, runId: '', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 2, codeSha: '',
    };
    const removed: string[] = [];
    try {
      registerPtyTakeoverCommands(program, {
        getPty: () => undefined, requestPtyTakeover: () => false, requestRemote: async () => ({ status: 'unknown-pty' }), log() {},
        listManifestRows: () => [row], isProcessAlive: () => false, now: () => 1_000_000, removeManifest: (id) => { removed.push(id); },
      });
      await program.parseAsync(['node', 'elanous', 'pty', 'find', '8']);
      await program.parseAsync(['node', 'elanous', 'pty', 'retire', 'pty_cli']);
      expect(removed).toEqual([]);
      await program.parseAsync(['node', 'elanous', 'pty', 'retire', 'pty_cli', '--yes']);
      expect(removed).toEqual(['pty_cli']);
      expect(out.join('')).toContain('matchedBy=ptyPid');
      expect(out.join('')).toContain('dry-run');
    } finally {
      process.stdout.write = originalOut;
      process.exitCode = 0;
    }
  });

  test('takeover grants human write; release restores auto and is idempotent', async () => {
    setPtyAdapterForTesting(adapter);
    const handle = tracked({ cmd: 'x', accessMode: 'auto', transitionPolicy: 'open', detach: true });
    const events: string[] = [];
    const deps = depsFor(handle, events);

    await expect(runPtyTakeover(handle.id, deps)).resolves.toMatchObject({ exitCode: 0 });
    expect(handle.accessMode).toBe('write');
    expect(handle.canWrite('human')).toBe(true);
    expect(handle.canWrite('agent')).toBe(false);
    await expect(runPtyRelease(handle.id, deps)).resolves.toMatchObject({ exitCode: 0 });
    await expect(runPtyRelease(handle.id, deps)).resolves.toMatchObject({ exitCode: 0 });
    expect(handle.accessMode).toBe('auto');
    expect(handle.canWrite('agent')).toBe(true);
    expect(events).toEqual(['takeover', 'release', 'release']);
  }, 15_000);

  test('unknown PTY is rejected and observed without state mutation', async () => {
    const events: string[] = [];
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined,
      requestPtyTakeover: () => false,
      requestRemote: async () => ({ status: 'unknown-pty' }),
      log: (event) => { events.push(event); },
    };

    await expect(runPtyTakeover('pty_missing', deps)).resolves.toMatchObject({ exitCode: 1, message: expect.stringContaining('not found') });
    await expect(runPtyRelease('pty_missing', deps)).resolves.toMatchObject({ exitCode: 1, message: expect.stringContaining('not found') });
    expect(events).toEqual(['denied', 'denied']);
  });

  test('locked policy rejects takeover without changing ownership', async () => {
    setPtyAdapterForTesting(adapter);
    const handle = tracked({ cmd: 'x', accessMode: 'auto', transitionPolicy: 'locked', detach: true });
    const events: string[] = [];

    await expect(runPtyTakeover(handle.id, depsFor(handle, events))).resolves.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('auto+locked → write 거부'),
    });
    expect(handle.accessMode).toBe('auto');
    expect(events).toEqual(['denied']);
  });

  test('snapshot renders a local screen without requesting takeover and logs no screen content', async () => {
    const logs: Array<Record<string, unknown>> = [];
    let remoteCalls = 0;
    const handle = {
      id: 'pty_local', accessMode: 'auto' as const, transitionPolicy: 'open' as const,
      setAccessMode: () => true, isAlive: () => true, canWrite: () => false, write() {}, resize() {},
      renderScreen: async () => 'local screen\nsecond line',
    };
    const deps: PtyTakeoverCommandDeps = {
      getPty: (id) => id === handle.id ? handle : undefined,
      requestPtyTakeover: () => false,
      requestRemote: async () => { remoteCalls++; return { status: 'failed' }; },
      listRefs: () => [{ id: handle.id, kind: 'shell', nickname: 'local-screen', source: 'local', alive: true }],
      log: (_event, data) => logs.push(data),
    };

    await expect(runPtySnapshot('local-screen', deps)).resolves.toEqual({
      exitCode: 0, message: 'PtyShellSnapshot process_id=pty_local status=running source=live\nlocal screen\nsecond line',
    });
    expect(remoteCalls).toBe(0);
    expect(logs).toEqual([{ ptyId: 'pty_local', action: 'snapshot', source: 'live', bytes: 24, lines: 2 }]);
    expect(JSON.stringify(logs)).not.toContain('local screen');
  });

  // ⭐ 무인 리뷰 must-fix(2026-07-29): `screen.length` 는 **UTF-16 코드 단위**라 한글 화면에서
  //    바이트 수가 아니다. TUI 화면은 한글이 흔하므로 이 단언이 없으면 payload 가 조용히 거짓을 말한다.
  test('snapshot falls back to a seeded manifest frame when the remote owner cannot render', async () => {
    const id = 'tui:frame-fallback';
    const frameAt = 1_234;
    const logs: Array<Record<string, unknown>> = [];
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined, requestPtyTakeover: () => false,
      requestRemote: async () => ({ status: 'failed', reason: 'screen-unavailable' }),
      readManifestFrame: (candidate) => candidate === id ? { frame: 'PROBE_MARKER_A4', frameAt } : null,
      listRefs: () => [{ id, kind: 'tui', source: 'remote', alive: true }],
      log: (_event, data) => logs.push(data),
    };
    await expect(runPtySnapshot(id, deps)).resolves.toEqual({
      exitCode: 0,
      message: `PtyShellSnapshot process_id=${id} status=running source=frame fallback=render-unavailable frame_at=${frameAt}\nPROBE_MARKER_A4`,
    });
    expect(logs).toEqual([{ ptyId: id, action: 'snapshot', source: 'frame', frameAt, fallback: 'render-unavailable', bytes: 15, lines: 1, from: undefined, to: undefined }]);
  });

  test('snapshot falls back when a local handle has no renderer', async () => {
    const id = 'tui:local-no-renderer';
    const handle = {
      id, accessMode: 'auto' as const, transitionPolicy: 'open' as const,
      setAccessMode: () => true, isAlive: () => true, canWrite: () => false, write() {}, resize() {},
    };
    const deps: PtyTakeoverCommandDeps = {
      getPty: (candidate) => candidate === id ? handle : undefined, requestPtyTakeover: () => false,
      requestRemote: async () => ({ status: 'failed' }),
      readManifestFrame: () => ({ frame: 'LOCAL_FRAME', frameAt: 123 }),
      listRefs: () => [{ id, kind: 'tui', source: 'local', alive: true }], log() {},
    };

    await expect(runPtySnapshot(id, deps)).resolves.toEqual({
      exitCode: 0,
      message: `PtyShellSnapshot process_id=${id} status=running source=frame fallback=render-unavailable frame_at=123\nLOCAL_FRAME`,
    });
  });

  test('snapshot falls back when the remote owner is unavailable', async () => {
    const id = 'tui:owner-unavailable';
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined, requestPtyTakeover: () => false,
      requestRemote: async () => ({ status: 'unknown-pty' }),
      readManifestFrame: () => ({ frame: 'OWNERLESS_FRAME', frameAt: 456 }),
      listRefs: () => [{ id, kind: 'tui', source: 'remote', alive: true }], log() {},
    };

    await expect(runPtySnapshot(id, deps)).resolves.toEqual({
      exitCode: 0,
      message: `PtyShellSnapshot process_id=${id} status=running source=frame fallback=owner-unavailable frame_at=456\nOWNERLESS_FRAME`,
    });
  });

  test('snapshot preserves the public screen-unavailable error and exposes render/frame diagnostics', async () => {
    const id = 'tui:no-frame';
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined, requestPtyTakeover: () => false,
      requestRemote: async () => ({ status: 'failed', reason: 'screen-unavailable' }),
      readManifestFrame: () => null,
      listRefs: () => [{ id, kind: 'tui', source: 'remote', alive: true }], log() {},
    };

    await expect(runPtySnapshot(id, deps)).resolves.toEqual({
      exitCode: 1,
      message: `pty snapshot: failed for ${id} (reason=screen-unavailable cause=render-unavailable frame=unavailable)`,
    });
  });

  test('snapshot respects an injected null frame reader exactly once', async () => {
    const id = 'tui:injected-null';
    let reads = 0;
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined, requestPtyTakeover: () => false,
      requestRemote: async () => ({ status: 'unknown-pty' }),
      readManifestFrame: () => { reads++; return null; },
      listRefs: () => [{ id, kind: 'tui', source: 'remote', alive: true }], log() {},
    };

    await expect(runPtySnapshot(id, deps)).resolves.toEqual({
      exitCode: 1,
      message: `pty snapshot: failed for ${id} (reason=screen-unavailable cause=owner-unavailable frame=unavailable)`,
    });
    expect(reads).toBe(1);
  });

  test('snapshot does not mask non-render IPC failures with a manifest frame', async () => {
    const id = 'tui:owner-error';
    let reads = 0;
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined, requestPtyTakeover: () => false,
      requestRemote: async () => ({ status: 'failed', reason: 'owner-processing-error' }),
      readManifestFrame: () => { reads++; return { frame: 'stale frame', frameAt: 1 }; },
      listRefs: () => [{ id, kind: 'tui', source: 'remote', alive: true }], log() {},
    };
    await expect(runPtySnapshot(id, deps)).resolves.toEqual({
      exitCode: 1,
      message: `pty snapshot: failed for ${id} (reason=owner-processing-error)`,
    });
    expect(reads).toBe(0);
  });

  test('snapshot logs UTF-8 byte length — not UTF-16 code units (한글·이모지 화면)', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const screen = '한글 화면\n🙂';           // UTF-16 units 10 · UTF-8 bytes 20
    const handle = {
      id: 'pty_utf8', accessMode: 'auto' as const, transitionPolicy: 'open' as const,
      setAccessMode: () => true, isAlive: () => true, canWrite: () => false, write() {}, resize() {},
      renderScreen: async () => screen,
    };
    const deps: PtyTakeoverCommandDeps = {
      getPty: (id) => id === handle.id ? handle : undefined,
      requestPtyTakeover: () => false,
      requestRemote: async () => ({ status: 'failed' }),
      listRefs: () => [{ id: handle.id, kind: 'shell', nickname: 'utf8-screen', source: 'local', alive: true }],
      log: (_event, data) => logs.push(data),
    };

    await runPtySnapshot('utf8-screen', deps);
    const utf8 = Buffer.byteLength(screen, 'utf8');
    expect(utf8).not.toBe(screen.length);            // ⭐ 이 단언이 테스트를 유의미하게 만든다
    expect(logs[0]!.bytes).toBe(utf8);
    expect(logs[0]!.lines).toBe(2);
    expect(JSON.stringify(logs)).not.toContain('한글');
  });

  // ⭐ 무인 리뷰 must-fix(2026-07-29): 로컬 렌더 실패가 **reject 로 새면** 원격 실패 경로·
  //    기존 명령들과 형태가 갈린다. 호출자가 두 갈래로 갈리지 않게 결과로 정규화한다.
  test('snapshot normalizes a local renderScreen failure into a result (no reject)', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const handle = {
      id: 'pty_boom', accessMode: 'auto' as const, transitionPolicy: 'open' as const,
      setAccessMode: () => true, isAlive: () => true, canWrite: () => false, write() {}, resize() {},
      renderScreen: async () => { throw new Error('emulator exploded'); },
    };
    const deps: PtyTakeoverCommandDeps = {
      getPty: (id) => id === handle.id ? handle : undefined,
      requestPtyTakeover: () => false,
      requestRemote: async () => ({ status: 'failed' }),
      listRefs: () => [{ id: handle.id, kind: 'shell', nickname: 'boom', source: 'local', alive: true }],
      log: (_event, data) => logs.push(data),
    };

    const r = await runPtySnapshot('boom', deps);   // ⛔ reject 면 이 줄에서 테스트가 죽는다
    expect(r.exitCode).not.toBe(0);
    expect(r.message).toContain('screen-unavailable');
  });

  test('snapshot delegates remotely when no local handle, resolves aliases, and preserves the screen contract', async () => {
    const calls: Array<[string, string]> = [];
    const logs: Array<Record<string, unknown>> = [];
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined, requestPtyTakeover: () => false,
      requestRemote: async (id, action) => { calls.push([id, action]); return { status: 'success', screen: 'remote modal' }; },
      listRefs: () => [{ id: 'pty_remote', kind: 'tui', nickname: 'outside', source: 'remote', alive: true }],
      log: (_event, data) => logs.push(data),
    };

    await expect(runPtySnapshot('outside', deps)).resolves.toEqual({
      exitCode: 0, message: 'PtyShellSnapshot process_id=pty_remote status=running source=live\nremote modal',
    });
    expect(calls).toEqual([['pty_remote', 'snapshot']]);
    expect(logs).toEqual([{ ptyId: 'pty_remote', action: 'snapshot', source: 'live', bytes: 12, lines: 1, from: undefined, to: undefined }]);
    expect(JSON.stringify(logs)).not.toContain('remote modal');
  });

  test('state emits the idle verdict as JSON from the snapshot acquisition path', async () => {
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined, requestPtyTakeover: () => false,
      requestRemote: async () => ({ status: 'success', screen: '❯ /command, or type a question' }),
      listRefs: () => [{ id: 'pty_x', kind: 'tui', source: 'remote', alive: true }], now: () => 1234, log() {},
    };
    await expect(runPtyState('pty_x', deps, true)).resolves.toEqual({ exitCode: 0, message: JSON.stringify({ id: 'pty_x', state: 'idle', stateSource: 'screen', screenState: 'idle', label: 'bare-prompt', at: 1234, turn: 'unknown', build: null, installed: null, stale: null, staleReason: 'unknown' }) });
    await expect(runPtyState('pty_x', deps)).resolves.toEqual({ exitCode: 0, message: 'pty state: pty_x state=idle source=screen label=bare-prompt turn=unknown build=unknown installed=- stale=unknown' });
  });

  test('state follows the TUI-recorded turn over the screen guess and reports a stale running build', async () => {
    const boot = 'a'.repeat(40); const current = 'b'.repeat(40);
    const logs: Array<[string, unknown]> = [];
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined, requestPtyTakeover: () => false,
      // 화면은 idle 로 보이지만 TUI 가 적은 턴은 busy 다 — ⭐ H10: state 는 턴을 따르고(working) 화면 원값은 guess 로 남는다.
      requestRemote: async () => ({ status: 'success', screen: '❯ /command, or type a question' }),
      listRefs: () => [{ id: 'tui:42', kind: 'tui', source: 'remote', alive: true }], now: () => 1234,
      readManifestRow: (id) => id === 'tui:42' ? {
        id, kind: 'tui', cmd: 'elanous', ownerPid: 42, ptyPid: 0, instance: 'prod', startedAt: 100, alive: true, exitCode: null,
        snapshot: '', snapshotAt: 0, outputBytesTotal: 0, updatedAt: 200, frame: '', frameAt: 0, runId: '', runIdSource: '', spaceId: '', sessionId: '',
        parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
        turnState: 'busy', turnAt: 150, build: { version: '0.2.29-dev.0', sha: boot, source: 'installed' },
      } : null,
      readInstalledBuild: () => ({ sha: current, installedAt: 300 }),
      log: (event, data) => logs.push([event, data]),
    };
    const json = JSON.parse((await runPtyState('tui:42', deps, true)).message);
    expect(json).toMatchObject({ state: 'working', stateSource: 'turn', screenState: 'idle', turn: 'busy', turnAt: 150, build: { version: '0.2.29-dev.0', sha: boot, source: 'installed' }, installed: current, stale: true, staleReason: 'installed-moved' });
    await expect(runPtyState('tui:42', deps)).resolves.toEqual({ exitCode: 0, message: 'pty state: tui:42 state=working source=turn guess=idle label=bare-prompt turn=busy build=0.2.29-dev.0@aaaaaaa(installed) installed=bbbbbbb stale=true (installed-moved)' });
    expect(logs.filter(([event]) => event === 'state-run-unknown')).toEqual([]);
    expect(logs.filter(([event]) => event === 'state-reconciled')[0]).toEqual(['state-reconciled', { ptyId: 'tui:42', turn: 'busy', screenState: 'idle', label: 'bare-prompt', state: 'working' }]);
  });

  test('state never prints working next to turn=idle: a leftover «Streaming» line yields to the recorded idle turn', async () => {
    const logs: Array<[string, unknown]> = [];
    const tuiRow = (turnState: 'busy' | 'idle'): PtyManifestRow => ({
      id: 'tui:55', kind: 'tui', cmd: 'elanous', ownerPid: 55, ptyPid: 0, instance: 'prod', startedAt: 100, alive: true, exitCode: null,
      snapshot: '', snapshotAt: 0, outputBytesTotal: 0, updatedAt: 200, frame: '', frameAt: 0, runId: '', runIdSource: '', spaceId: '', sessionId: '',
      parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
      turnState, turnAt: 150, build: { version: 'v', sha: 'a'.repeat(40), source: 'installed' },
    });
    // 10-16 실측 꼴: 턴은 끝났는데 스크롤백 하단 10줄 안에 «· Streaming… (5s · esc 중단)» 이 남아 화면 규칙이 working 을 문다.
    const screen = ['· Streaming…  (5s · esc 중단)', '✔ 완료', '', '❯ '].join('\n');
    let turn: 'busy' | 'idle' = 'idle';
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined, requestPtyTakeover: () => false,
      requestRemote: async () => ({ status: 'success', screen }),
      listRefs: () => [{ id: 'tui:55', kind: 'tui', source: 'remote', alive: true }], now: () => 1,
      readManifestRow: () => tuiRow(turn),
      readInstalledBuild: () => ({ sha: 'a'.repeat(40) }),
      log: (event, data) => logs.push([event, data]),
    };
    const json = JSON.parse((await runPtyState('tui:55', deps, true)).message);
    expect(json).toMatchObject({ state: 'idle', stateSource: 'turn', screenState: 'working', label: 'elanous-tui-turn-in-progress', turn: 'idle' });
    expect(json.state === 'working' && json.turn === 'idle').toBe(false);
    const text = (await runPtyState('tui:55', deps)).message;
    expect(text).toStartWith('pty state: tui:55 state=idle source=turn guess=working label=elanous-tui-turn-in-progress turn=idle ');
    expect(logs.some(([event, data]) => event === 'state-reconciled' && (data as { state: string }).state === 'idle')).toBe(true);
    // 턴 중이면 같은 화면이 working 으로 «합의»한다 — 덮어쓰기 관측은 없다.
    turn = 'busy'; logs.length = 0;
    expect(JSON.parse((await runPtyState('tui:55', deps, true)).message)).toMatchObject({ state: 'working', stateSource: 'turn', screenState: 'working', turn: 'busy' });
    expect(logs.filter(([event]) => event === 'state-reconciled')).toEqual([]);
  });

  test('wait polls until idle and reports the third acquired screen', async () => {
    const screens = ['✽ Thinking…  (4s · esc 중단)', '· Streaming…  (5s · esc 중단)', '❯ /command, or type a question'];
    let requests = 0; let clock = 0;
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined, requestPtyTakeover: () => false,
      requestRemote: async () => ({ status: 'success', screen: screens[requests++]! }),
      listRefs: () => [{ id: 'pty_x', kind: 'tui', source: 'remote', alive: true }], now: () => clock, sleep: async (ms) => { clock += ms; }, log() {},
    };
    const result = await runPtyWait('pty_x', 'idle', { timeoutMs: 10_000, pollMs: 1 }, deps);
    expect(result).toMatchObject({ exitCode: 0, message: expect.stringContaining('reached idle') });
    expect(requests).toBe(3);
  });

  test('text --when-idle waits for idle, then injects once', async () => {
    const screens = ['✽ Thinking…  (4s · esc 중단)', '❯ /command, or type a question'];
    const actions: string[] = []; let snaps = 0; let clock = 0;
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined, requestPtyTakeover: () => false,
      requestRemote: async (_id, action) => {
        actions.push(action);
        return action === 'snapshot' ? { status: 'success', screen: screens[snaps++]! } : { status: 'success' };
      },
      listRefs: () => [{ id: 'pty_x', kind: 'tui', source: 'remote', alive: true }], now: () => clock, sleep: async (ms) => { clock += ms; }, log() {},
    };
    const result = await runPtyTextWhenIdle('pty_x', 'wake', true, { timeoutMs: 10_000, pollMs: 1 }, deps);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('reached idle');
    expect(actions).toEqual(['snapshot', 'snapshot', 'input-text']);
  });

  test('text --when-idle times out without injecting (rc=1)', async () => {
    const actions: string[] = []; let clock = 0;
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined, requestPtyTakeover: () => false,
      requestRemote: async (_id, action) => { actions.push(action); return { status: 'success', screen: '✽ Thinking…  (4s · esc 중단)' }; },
      listRefs: () => [{ id: 'pty_x', kind: 'tui', source: 'remote', alive: true }], now: () => clock, sleep: async (ms) => { clock += ms; }, log() {},
    };
    const result = await runPtyTextWhenIdle('pty_x', 'wake', true, { timeoutMs: 20, pollMs: 10 }, deps);
    expect(result).toMatchObject({ exitCode: 1, message: expect.stringContaining('pty text --when-idle: not delivered') });
    expect(actions.includes('input-text')).toBe(false);
  });

  test('wait times out with the last working state', async () => {
    let clock = 0;
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined, requestPtyTakeover: () => false,
      requestRemote: async () => ({ status: 'success', screen: '✽ Thinking…  (4s · esc 중단)' }),
      listRefs: () => [{ id: 'pty_x', kind: 'tui', source: 'remote', alive: true }], now: () => clock, sleep: async (ms) => { clock += ms; }, log() {},
    };
    await expect(runPtyWait('pty_x', 'idle', { timeoutMs: 20, pollMs: 10 }, deps)).resolves.toMatchObject({ exitCode: 1, message: expect.stringContaining('timed out after 20ms (last state=working') });
  });

  test('wait rejects an invalid target before screen acquisition', async () => {
    let requests = 0;
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined, requestPtyTakeover: () => false,
      requestRemote: async () => { requests++; return { status: 'success', screen: '' }; },
      listRefs: () => [{ id: 'pty_x', kind: 'tui', source: 'remote', alive: true }], log() {},
    };
    await expect(runPtyWait('pty_x', 'sleeping', {}, deps)).resolves.toMatchObject({ exitCode: 2, message: expect.stringContaining('idle, working, blocked, waiting, done') });
    expect(requests).toBe(0);
  });

  test('state degrades a throwing checkout-HEAD read to stale=unknown instead of failing', async () => {
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined, requestPtyTakeover: () => false,
      requestRemote: async () => ({ status: 'success', screen: '❯ /command, or type a question' }),
      listRefs: () => [{ id: 'tui:43', kind: 'tui', source: 'remote', alive: true }], now: () => 1,
      readManifestRow: () => ({
        id: 'tui:43', kind: 'tui', cmd: 'elanous', ownerPid: 43, ptyPid: 0, instance: 'prod', startedAt: 100, alive: true, exitCode: null,
        snapshot: '', snapshotAt: 0, outputBytesTotal: 0, updatedAt: 200, frame: '', frameAt: 0, runId: '', runIdSource: '', spaceId: '', sessionId: '',
        parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
        turnState: 'idle', turnAt: 150, build: { version: 'v', sha: 'a'.repeat(40), source: 'checkout', codeRoot: '/r' },
      }),
      readInstalledBuild: () => ({}),
      readCheckoutHead: () => { throw new Error('git exploded'); },
      log() {},
    };
    await expect(runPtyState('tui:43', deps)).resolves.toEqual({ exitCode: 0, message: 'pty state: tui:43 state=idle source=turn label=bare-prompt turn=idle build=v@aaaaaaa(checkout) installed=- stale=unknown' });
  });

  test('state still reports the recorded turn and build when the screen cannot be read', async () => {
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined, requestPtyTakeover: () => false,
      requestRemote: async () => ({ status: 'failed', reason: 'screen-unavailable' }), readManifestFrame: () => null,
      listRefs: () => [{ id: 'tui:42', kind: 'tui', source: 'remote', alive: true }], now: () => 9,
      readManifestRow: () => ({
        id: 'tui:42', kind: 'tui', cmd: 'elanous', ownerPid: 42, ptyPid: 0, instance: 'prod', startedAt: 100, alive: true, exitCode: null,
        snapshot: '', snapshotAt: 0, outputBytesTotal: 0, updatedAt: 200, frame: '', frameAt: 0, runId: '', runIdSource: '', spaceId: '', sessionId: '',
        parentPtyId: '', parentPid: 0, parentKind: '', closedAt: 0, codeSha: '',
        turnState: 'busy', turnAt: 150, build: { version: 'v', sha: 'a'.repeat(40), source: 'installed' },
      }),
      readInstalledBuild: () => ({ sha: 'a'.repeat(40) }),
      log() {},
    };
    expect(JSON.parse((await runPtyState('tui:42', deps, true)).message)).toMatchObject({ state: 'working', stateSource: 'turn', screenState: 'unknown', screenUnavailable: 'screen-unavailable', turn: 'busy', stale: false });
    await expect(runPtyState('tui:42', deps)).resolves.toEqual({ exitCode: 0, message: 'pty state: tui:42 state=working source=turn label=- screen=unavailable(screen-unavailable) turn=busy build=v@aaaaaaa(installed) installed=aaaaaaa stale=false (same-as-installed)' });
  });

  test('state preserves snapshot-equivalent screen acquisition failures', async () => {
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined, requestPtyTakeover: () => false,
      requestRemote: async () => ({ status: 'failed', reason: 'screen-unavailable' }), readManifestFrame: () => null,
      listRefs: () => [{ id: 'pty_x', kind: 'tui', source: 'remote', alive: true }], log() {},
    };
    const snapshot = await runPtySnapshot('pty_x', deps);
    await expect(runPtyState('pty_x', deps)).resolves.toEqual(snapshot);
  });

  test('snapshot unknown refs use the same not-found failure as text', async () => {
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined, requestPtyTakeover: () => false,
      requestRemote: async () => ({ status: 'unknown-pty' }),
      listRefs: () => [], log() {},
    };
    const expected = { exitCode: 1 as const, message: 'pty: missing was not found in the current instance address book (0 live PTY refs); inspect all registered instances with elanous pty list --all --include-test' };
    await expect(runPtySnapshot('missing', deps)).resolves.toEqual(expected);
    await expect(runPtyText('missing', 'x', false, deps)).resolves.toEqual(expected);
  });

  test('input resolves nickname locally, propagates write denial, and logs only safe metadata', async () => {
    const writes: string[] = []; const logs: Array<Record<string, unknown>> = [];
    const remote: Array<[string, string, unknown]> = [];
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined, requestPtyTakeover: () => false,
      requestRemote: async (id, action, payload) => { remote.push([id, action, payload]); return { status: 'success' }; },
      listRefs: () => [{ id: 'pty_remote', kind: 'shell', nickname: 'remote-shell', source: 'remote', alive: true }],
      log: (_event, data) => logs.push(data),
    };
    await expect(runPtyText('remote-shell', 'secret-token', true, deps)).resolves.toMatchObject({ exitCode: 0 });
    await expect(runPtyKey('remote-shell', ' UP ', 2, deps)).resolves.toMatchObject({ exitCode: 0 });
    await expect(runPtyResize('remote-shell', 120, 40, deps)).resolves.toMatchObject({ exitCode: 0 });
    expect(remote).toEqual([
      ['pty_remote', 'input-text', { chars: 'secret-token\r' }],
      ['pty_remote', 'input-key', { chars: '\x1b[A\x1b[A' }],
      ['pty_remote', 'resize', { cols: 120, rows: 40 }],
    ]);
    expect(logs[0]).toMatchObject({ length: 13 });
    expect(JSON.stringify(logs)).not.toContain('secret-token');
    expect(logs[1]).toMatchObject({ key: 'up', repeat: 2 });
    expect(JSON.stringify(logs[1])).not.toContain('\x1b');
    expect(writes).toEqual([]);
  });

  test('local auto resize is denied without calling resize, then takeover permits it', async () => {
    const resized: Array<[number, number]> = [];
    setPtyAdapterForTesting(() => ({ ...adapter(), resize(cols: number, rows: number) { resized.push([cols, rows]); } }));
    const handle = tracked({ cmd: 'x', accessMode: 'auto', transitionPolicy: 'open', detach: true });
    const events: string[] = [];
    const deps = depsFor(handle, events);

    await expect(runPtyResize(handle.id, 120, 40, deps)).resolves.toMatchObject({ exitCode: 1, message: expect.stringContaining('write-arbiter') });
    expect(resized).toEqual([]);
    await expect(runPtyTakeover(handle.id, deps)).resolves.toMatchObject({ exitCode: 0 });
    await expect(runPtyResize(handle.id, 120, 40, deps)).resolves.toMatchObject({ exitCode: 0 });
    expect(resized).toEqual([[120, 40]]);
    expect(events).toEqual(['denied', 'takeover', 'resize']);
  });

  test('local adapter write failure is not reported as an arbiter denial', async () => {
    setPtyAdapterForTesting(() => ({ ...adapter(), write() { throw new Error('closed fd'); } }));
    const handle = tracked({ cmd: 'x', accessMode: 'write', detach: true });
    const events: string[] = [];
    await expect(runPtyText(handle.id, 'secret-token', false, depsFor(handle, events))).resolves.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('adapter-write'),
    });
    expect(events).toEqual(['failed']);
  });

  test('ambiguous ref is rejected before local or remote injection', async () => {
    let remoteCalls = 0;
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined, requestPtyTakeover: () => false,
      requestRemote: async () => { remoteCalls++; return { status: 'success' }; },
      listRefs: () => [{ id: 'pty_one', kind: 'shell', nickname: 'same', source: 'remote', alive: true }, { id: 'pty_two', kind: 'shell', nickname: 'same', source: 'remote', alive: true }], log() {},
    };
    await expect(runPtyText('same', 'x', false, deps)).resolves.toMatchObject({ exitCode: 1, message: expect.stringContaining('ambiguous') });
    expect(remoteCalls).toBe(0);
  });

  test('registers commands, forwards the id, and separates success/error output', async () => {
    const program = new Command();
    const output: string[] = [];
    const errors: string[] = [];
    const originalOut = process.stdout.write;
    const originalErr = process.stderr.write;
    process.stdout.write = ((chunk: string) => { output.push(chunk); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => { errors.push(chunk); return true; }) as typeof process.stderr.write;
    try {
      registerPtyTakeoverCommands(program, {
        getPty: () => undefined,
        requestPtyTakeover: () => false,
        requestRemote: async (id) => id === 'pty_ok'
          ? { status: 'success', from: 'auto', to: 'write', policy: 'open' }
          : { status: 'unknown-pty' },
        log() {},
      });
      await program.parseAsync(['node', 'elanous', 'pty', 'takeover', 'pty_ok']);
      expect(process.exitCode).toBe(0);
      expect(output.join('')).toContain('pty_ok');
      expect(errors).toEqual([]);

      output.splice(0);
      process.exitCode = 0;
      await program.parseAsync(['node', 'elanous', 'pty', 'list']);
      expect(process.exitCode).toBe(1);
      expect(errors.join('')).toContain('reference listing is unavailable');

      process.exitCode = 0;
      await program.parseAsync(['node', 'elanous', 'pty', 'release', 'pty_missing']);
      expect(process.exitCode).toBe(1);
      expect(errors.join('')).toContain('pty_missing');
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    }
  });

  test('registers state JSON and forwards wait polling options', async () => {
    const program = new Command();
    const output: string[] = [];
    const originalOut = process.stdout.write;
    let clock = 0;
    const screens = ['✽ Thinking…  (4s · esc 중단)', '✽ Thinking…  (4s · esc 중단)', '❯ /command, or type a question'];
    const polls: number[] = [];
    process.stdout.write = ((chunk: string) => { output.push(chunk); return true; }) as typeof process.stdout.write;
    try {
      registerPtyTakeoverCommands(program, {
        getPty: () => undefined, requestPtyTakeover: () => false,
        requestRemote: async () => ({ status: 'success', screen: screens.shift() ?? '❯ /command, or type a question' }),
        listRefs: () => [{ id: 'pty_cli_state', kind: 'tui', source: 'remote', alive: true }],
        now: () => clock, sleep: async (ms) => { polls.push(ms); clock += ms; }, log() {},
      });
      await program.parseAsync(['node', 'elanous', 'pty', 'state', 'pty_cli_state', '--json']);
      expect(process.exitCode).toBe(0);
      expect(JSON.parse(output.join(''))).toMatchObject({ id: 'pty_cli_state', state: 'working', label: 'elanous-tui-turn-in-progress', at: 0 });

      output.splice(0);
      process.exitCode = 0;
      await program.parseAsync(['node', 'elanous', 'pty', 'wait', 'pty_cli_state', '--until', 'idle', '--timeout', '7', '--poll-ms', '3']);
      expect(process.exitCode).toBe(0);
      expect(output.join('')).toContain('reached idle after 3ms');
      expect(polls).toEqual([3]);
    } finally {
      process.stdout.write = originalOut;
      process.exitCode = 0;
    }
  });
});

// ── F3 `agent` 슬라이스 CLI — `--actor agent` (같은 run 의 감독만 auto 자식에 넣는다) ──
describe('pty CLI --actor', () => {
  function remoteDeps(captured: Array<[string, string, unknown, unknown]>): PtyTakeoverCommandDeps {
    return {
      getPty: () => undefined, requestPtyTakeover: () => false,
      requestRemote: async (id, action, payload, options) => { captured.push([id, action, payload, options]); return { status: 'success' }; },
      listRefs: () => [{ id: 'pty_remote', kind: 'shell', nickname: 'remote-shell', source: 'remote', alive: true }],
      log() {},
    };
  }

  test('원격 경로는 actor 를 IPC 옵션으로 실어 보낸다(기본은 human)', async () => {
    const captured: Array<[string, string, unknown, unknown]> = [];
    const deps = remoteDeps(captured);
    await expect(runPtyText('remote-shell', 'x', false, deps)).resolves.toMatchObject({ exitCode: 0 });
    await expect(runPtyText('remote-shell', 'x', false, deps, 'agent')).resolves.toMatchObject({ exitCode: 0 });
    await expect(runPtyKey('remote-shell', 'enter', 1, deps, 'agent')).resolves.toMatchObject({ exitCode: 0 });
    await expect(runPtyResize('remote-shell', 120, 40, deps, 'agent')).resolves.toMatchObject({ exitCode: 0 });
    expect(captured.map(([, action, , options]) => [action, options])).toEqual([
      ['input-text', { actor: 'human' }],
      ['input-text', { actor: 'agent' }],
      ['input-key', { actor: 'agent' }],
      ['resize', { actor: 'agent' }],
    ]);
  });

  test('⭐ 로컬 경로도 같은 인가를 탄다 — 같은 run 이면 auto 자식에 쓰고, 다른 run 이면 write 가 안 불린다', async () => {
    const writes: string[] = [];
    setPtyAdapterForTesting(() => ({ ...adapter(), write(chars: string) { writes.push(chars); } }));
    const handle = tracked({ cmd: 'x', accessMode: 'auto', transitionPolicy: 'open', detach: true });
    const logs: Array<Record<string, unknown>> = [];
    const base: PtyTakeoverCommandDeps = {
      getPty: (id) => id === handle.id ? handle : undefined,
      requestPtyTakeover: () => false,
      requestRemote: async () => ({ status: 'unknown-pty' }),
      listRefs: () => [{ id: handle.id, kind: handle.kind, source: 'local', alive: true }],
      log: (_event, data) => logs.push(data),
    };

    const mismatched = { ...base, runIdentity: () => ({ requester: 'run-beta', target: 'run-alpha' }) };
    await expect(runPtyText(handle.id, 'intruder', false, mismatched, 'agent')).resolves.toMatchObject({
      exitCode: 1, message: expect.stringContaining('run-mismatch'),
    });
    expect(writes).toEqual([]);

    const matched = { ...base, runIdentity: () => ({ requester: 'run-alpha', target: 'run-alpha' }) };
    await expect(runPtyText(handle.id, 'supervise', false, matched, 'agent')).resolves.toMatchObject({ exitCode: 0 });
    expect(writes).toEqual(['supervise']);
    // human 은 같은 auto 자식에서 여전히 막힌다 — agent 통과가 arbiter 를 무력화한 게 아니다.
    await expect(runPtyText(handle.id, 'nope', false, matched)).resolves.toMatchObject({
      exitCode: 1, message: expect.stringContaining('write-arbiter'),
    });
    expect(writes).toEqual(['supervise']);
    expect(logs.map((data) => data.actor)).toEqual(['agent', 'agent', 'human']);
  });

  test('runIdentity 를 못 구하는 배선에서 agent 는 통과하지 않는다(fail-closed)', async () => {
    const writes: string[] = [];
    setPtyAdapterForTesting(() => ({ ...adapter(), write(chars: string) { writes.push(chars); } }));
    const handle = tracked({ cmd: 'x', accessMode: 'auto', detach: true });
    const deps: PtyTakeoverCommandDeps = {
      getPty: (id) => id === handle.id ? handle : undefined,
      requestPtyTakeover: () => false,
      requestRemote: async () => ({ status: 'unknown-pty' }),
      listRefs: () => [{ id: handle.id, kind: handle.kind, source: 'local', alive: true }],
      log() {},   // runIdentity 미주입
    };
    await expect(runPtyText(handle.id, 'x', false, deps, 'agent')).resolves.toMatchObject({
      exitCode: 1, message: expect.stringContaining('agent-run-unidentified'),
    });
    expect(writes).toEqual([]);
  });

  // ⊕ 값 판정 자체는 `parsePtyWriteActor`(arbiter)의 단위 테스트가 덮는다 — 여기서는 **배선**만 본다:
  //   플래그가 그 판정을 타는가, 그리고 거부가 주입 前에 끊는가.
  test('알 수 없는 --actor 는 주입 前에 끊긴다 — 원격 호출이 일어나지 않는다', async () => {
    const program = new Command();
    const errors: string[] = [];
    const originalErr = process.stderr.write;
    process.stderr.write = ((chunk: string) => { errors.push(chunk); return true; }) as typeof process.stderr.write;
    let remoteCalls = 0;
    try {
      registerPtyTakeoverCommands(program, {
        getPty: () => undefined, requestPtyTakeover: () => false,
        requestRemote: async () => { remoteCalls++; return { status: 'success' }; },
        listRefs: () => [{ id: 'pty_remote', kind: 'shell', source: 'remote', alive: true }],
        log() {},
      });
      await program.parseAsync(['node', 'elanous', 'pty', 'text', 'pty_remote', 'x', '--actor', 'brain']);
      expect(process.exitCode).toBe(1);
      expect(errors.join('')).toContain("--actor must be 'human' or 'agent'");
      expect(remoteCalls).toBe(0);
    } finally {
      process.stderr.write = originalErr;
    }
  });
});

describe('pty CLI 관측 sink 배선', () => {
  test('⭐ sink 등록이 명령보다 **먼저** 끝난다 — 늦으면 짧은 명령의 로그를 통째로 놓친다', async () => {
    const program = new Command();
    const order: string[] = [];
    const originalOut = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      registerPtyTakeoverCommands(program, {
        getPty: () => undefined, requestPtyTakeover: () => false,
        requestRemote: async () => ({ status: 'success' }),
        listRefs: () => [{ id: 'pty_remote', kind: 'shell', source: 'remote', alive: true }],
        // 등록이 즉시 끝나지 않는 실제 조건(동적 import·db 열기)을 흉내낸다 — 동기 스텁이면 순서가 우연히 맞는다.
        registerObservationSink: async () => { await Bun.sleep(20); order.push('sink'); },
        log: (event) => { order.push(`log:${event}`); },
      });
      await program.parseAsync(['node', 'elanous', 'pty', 'text', 'pty_remote', 'x']);
      expect(order[0]).toBe('sink');
      expect(order).toContain('log:input-text');
    } finally {
      process.stdout.write = originalOut;
    }
  });

  test('sink 등록이 없어도(주입 안 된 배선) 명령은 그대로 돈다 — fail-open', async () => {
    const program = new Command();
    const originalOut = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      registerPtyTakeoverCommands(program, {
        getPty: () => undefined, requestPtyTakeover: () => false,
        requestRemote: async () => ({ status: 'success' }),
        listRefs: () => [{ id: 'pty_remote', kind: 'shell', source: 'remote', alive: true }],
        log() {},   // registerObservationSink 미주입
      });
      await program.parseAsync(['node', 'elanous', 'pty', 'text', 'pty_remote', 'x']);
      expect(process.exitCode).toBe(0);
    } finally {
      process.stdout.write = originalOut;
    }
  });
});

// ⊕ Commander → IPC 옵션까지 **끝에서 끝까지** — 위 테스트들은 함수를 직접 부르므로
//   "플래그가 실제로 그 인자로 흘러가는가"의 배선 회귀를 못 잡는다(리뷰 should-fix).
describe('pty CLI --all 배선(Commander → 연합 조회)', () => {
  // ⛔⭐ 리뷰 should-fix — 순수 함수·주입 대역만 재면 **플래그가 실제로 그 인자로 흘러가는가**를 못 잡는다.
  test('--all·--include-test 가 파싱부터 연합 조회 인자까지 그대로 전달된다', async () => {
    const program = new Command();
    const seen: Array<{ includeTest: boolean }> = [];
    const out: string[] = [];
    const originalOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      registerPtyTakeoverCommands(program, {
        getPty: () => undefined, requestPtyTakeover: () => false,
        requestRemote: async () => ({ status: 'unknown-pty' as const }),
        listRefs: () => [{ id: 'local_only', kind: 'tui', source: 'local', alive: true }],
        listFederatedRefs: (o) => { seen.push(o); return { refs: [{ instance: 'test:wt-docs', id: 'self_a', kind: 'self', alive: true }], unreadable: [] }; },
        log() {},
      });
      await program.parseAsync(['node', 'elanous', 'pty', 'list', '--all', '--include-test']);
      await program.parseAsync(['node', 'elanous', 'pty', 'list', '--all']);
      await program.parseAsync(['node', 'elanous', 'pty', 'list']);
      expect(seen).toEqual([{ includeTest: true }, { includeTest: false }]);   // ⭐ 3번째(플래그 없음)는 연합을 안 탄다
      expect(out.join('')).toContain('test:wt-docs\t-\tself_a');
      expect(out.join('')).toContain('local_only');
      expect(process.exitCode).toBe(0);
    } finally {
      process.stdout.write = originalOut;
      process.exitCode = 0;
    }
  });
});

describe('pty CLI --ansi snapshot 배선(Commander → IPC)', () => {
  test('--ansi passes the ANSI snapshot payload through the cross-process request path', async () => {
    const program = new Command();
    const captured: Array<[string, unknown]> = [];
    const output: string[] = [];
    const originalOut = process.stdout.write;
    process.stdout.write = ((chunk: string) => { output.push(chunk); return true; }) as typeof process.stdout.write;
    try {
      registerPtyTakeoverCommands(program, {
        getPty: () => undefined, requestPtyTakeover: () => false,
        requestRemote: async (_id, action, payload) => {
          captured.push([action, payload]);
          return { status: 'success', screen: '\u001b[31mREMOTE\u001b[0m', source: 'live' };
        },
        listRefs: () => [{ id: 'pty_remote', kind: 'shell', source: 'remote', alive: true }],
        log() {},
      });
      await program.parseAsync(['node', 'elanous', 'pty', 'snapshot', 'pty_remote', '--ansi']);
      expect(captured).toEqual([['snapshot', { ansi: true }]]);
      expect(output.join('')).toContain('PtyShellSnapshot process_id=pty_remote status=running source=live\n\u001b[31mREMOTE\u001b[0m');
      expect(process.exitCode).toBe(0);
    } finally {
      process.stdout.write = originalOut;
      process.exitCode = 0;
    }
  });
});

describe('pty CLI state/wait wiring', () => {
  test('state JSON and wait options are forwarded through Commander with their exit behavior', async () => {
    const program = new Command();
    const output: string[] = []; const errors: string[] = [];
    const originalOut = process.stdout.write; const originalErr = process.stderr.write;
    let clock = 0;
    process.stdout.write = ((chunk: string) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => { errors.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      registerPtyTakeoverCommands(program, {
        getPty: () => undefined, requestPtyTakeover: () => false,
        requestRemote: async () => ({ status: 'success', screen: '❯ /command, or type a question' }),
        listRefs: () => [{ id: 'pty_x', kind: 'tui', source: 'remote', alive: true }], now: () => clock, sleep: async (ms) => { clock += ms; }, log() {},
      });
      await program.parseAsync(['node', 'elanous', 'pty', 'state', 'pty_x', '--json']);
      expect(output.join('')).toContain('"state":"idle"');
      expect(process.exitCode).toBe(0);
      output.splice(0); process.exitCode = 0;
      await program.parseAsync(['node', 'elanous', 'pty', 'wait', 'pty_x', '--until', 'idle', '--timeout', '10', '--poll-ms', '1']);
      expect(output.join('')).toContain('reached idle after 0ms');
      expect(process.exitCode).toBe(0);
      process.exitCode = 0;
      await program.parseAsync(['node', 'elanous', 'pty', 'wait', 'pty_x', '--until', 'sleeping']);
      expect(errors.join('')).toContain('must be one of idle, working, blocked, waiting, done');
      expect(process.exitCode).toBe(2);
    } finally {
      process.stdout.write = originalOut; process.stderr.write = originalErr; process.exitCode = 0;
    }
  });
});

describe('pty CLI --actor 배선(Commander → IPC)', () => {
  test('유효한 --actor agent 가 파싱부터 원격 IPC 옵션까지 그대로 전달된다', async () => {
    const program = new Command();
    const captured: Array<[string, unknown]> = [];
    const originalOut = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      registerPtyTakeoverCommands(program, {
        getPty: () => undefined, requestPtyTakeover: () => false,
        requestRemote: async (_id, action, _payload, options) => { captured.push([action, options]); return { status: 'success' }; },
        listRefs: () => [{ id: 'pty_remote', kind: 'shell', source: 'remote', alive: true }],
        log() {},
      });
      await program.parseAsync(['node', 'elanous', 'pty', 'text', 'pty_remote', 'x', '--actor', 'agent']);
      await program.parseAsync(['node', 'elanous', 'pty', 'key', 'pty_remote', 'enter', '--actor', 'AGENT']);
      await program.parseAsync(['node', 'elanous', 'pty', 'resize', 'pty_remote', '120', '40', '--actor', 'agent']);
      await program.parseAsync(['node', 'elanous', 'pty', 'text', 'pty_remote', 'x']);   // 플래그 생략 = human
      expect(captured).toEqual([
        ['input-text', { actor: 'agent' }],
        ['input-key', { actor: 'agent' }],   // 대소문자 정규화도 이 경로를 탄다
        ['resize', { actor: 'agent' }],
        ['input-text', { actor: 'human' }],
      ]);
      expect(process.exitCode).toBe(0);
    } finally {
      process.stdout.write = originalOut;
    }
  });
});

describe('pty rename CLI', () => {
  test('remote rename resolves the TUI row by id, sends the nickname over IPC, and later resolves by the new name', async () => {
    const remote: Array<[string, string, unknown, unknown]> = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    const refs = [{ id: 'tui:4242', kind: 'tui', source: 'remote' as const, alive: true } as { id: string; kind: string; source: 'remote'; alive: boolean; nickname?: string }];
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined, requestPtyTakeover: () => false,
      requestRemote: async (id, action, payload, options) => {
        remote.push([id, action, payload, options]);
        if (action === 'rename') refs[0] = { ...refs[0]!, nickname: (payload as { nickname: string }).nickname };
        return { status: 'success' };
      },
      listRefs: () => refs,
      log: (event, data) => { logs.push([event, data]); },
    };
    await expect(runPtyRename('tui:4242', '  op  ', deps)).resolves.toEqual({ exitCode: 0, message: 'pty rename: tui:4242 is now named op' });
    expect(remote).toEqual([['tui:4242', 'rename', { nickname: 'op' }, { actor: 'human' }]]);
    expect(logs[0]).toEqual(['rename', expect.objectContaining({ ptyId: 'tui:4242', nickname: 'op', actor: 'human' })]);
    await expect(runPtySnapshot('op', deps)).resolves.toMatchObject({ exitCode: 0 });
    expect(remote[1]?.[0]).toBe('tui:4242');
  });

  test('rename rejects an empty name and surfaces owner failures', async () => {
    const deps: PtyTakeoverCommandDeps = {
      getPty: () => undefined, requestPtyTakeover: () => false,
      requestRemote: async () => ({ status: 'unknown-pty' }),
      listRefs: () => [{ id: 'tui:1', kind: 'tui', source: 'remote', alive: true }],
      log() {},
    };
    await expect(runPtyRename('tui:1', '   ', deps)).resolves.toEqual({ exitCode: 1, message: 'pty rename: name must not be empty' });
    await expect(runPtyRename('tui:1', 'op', deps)).resolves.toEqual({ exitCode: 1, message: 'pty rename: tui:1 was not found' });
  });

  test('local rename uses the in-process registry handle', async () => {
    setPtyAdapterForTesting(() => adapter());
    const handle = tracked({ cmd: 'x', detach: true });
    const events: string[] = [];
    await expect(runPtyRename(handle.id, 'local-op', depsFor(handle, events))).resolves.toMatchObject({ exitCode: 0 });
    expect(handle.nickname).toBe('local-op');
    expect(events).toEqual(['rename']);
  });

  test('Commander wires pty rename <ref> <name> with --actor', async () => {
    const program = new Command();
    const captured: Array<[string, unknown, unknown]> = [];
    const originalOut = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      registerPtyTakeoverCommands(program, {
        getPty: () => undefined, requestPtyTakeover: () => false,
        requestRemote: async (_id, action, payload, options) => { captured.push([action, payload, options]); return { status: 'success' }; },
        listRefs: () => [{ id: 'tui:7', kind: 'tui', source: 'remote', alive: true }],
        log() {},
      });
      await program.parseAsync(['node', 'elanous', 'pty', 'rename', 'tui:7', 'op']);
      await program.parseAsync(['node', 'elanous', 'pty', 'rename', 'tui:7', 'op2', '--actor', 'agent']);
      expect(captured).toEqual([
        ['rename', { nickname: 'op' }, { actor: 'human' }],
        ['rename', { nickname: 'op2' }, { actor: 'agent' }],
      ]);
      expect(process.exitCode).toBe(0);
    } finally {
      process.stdout.write = originalOut;
    }
  });
});
