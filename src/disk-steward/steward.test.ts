import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { debug } from '../debug/log.js';
import { readReclaimLedger, requestReclaim, type ReclaimRequest } from './ledger.js';
import { judgeReclaimTarget, isInside } from './judge.js';
import { releaseWindowPredicate, runDiskSteward, type DiskStewardDeps, type TreeInfo } from './steward.js';

let root: string;
let stateDir: string;
let ledgerPath: string;
let events: Array<{ event: string; data: unknown }>;
const originalLog = debug.log;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'disk-steward-'));
  stateDir = join(root, 'state', 'disk-steward');
  ledgerPath = join(stateDir, 'requests.jsonl');
  events = [];
  debug.log = ((category: string, event: string, data: unknown) => {
    if (category === 'disk.steward') events.push({ event, data });
  }) as typeof debug.log;
});
afterEach(() => {
  debug.log = originalLog;
  rmSync(root, { recursive: true, force: true });
});

function dir(name: string): string {
  const p = join(root, name);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, 'f.txt'), 'x');
  return p;
}

function deps(over: Partial<DiskStewardDeps> & { trees?: Record<string, TreeInfo>; heads?: string[]; shas?: string[] } = {}) {
  const removed: string[] = [];
  const gitCalls: string[][] = [];
  const d: DiskStewardDeps = {
    stateDir,
    ledgerPath,
    listOpenPrs: () => ({ ok: true, value: { heads: new Set(over.heads ?? []), shas: new Set(over.shas ?? []) } }),
    listLiveDirectories: () => ({ ok: true, value: [] }),
    readTree: (p) => over.trees?.[p] ?? null,
    isOwnerLive: () => false,
    protectedRoots: [],
    isReleaseWindow: () => false,
    removeDir: (p) => { removed.push(p); rmSync(p, { recursive: true, force: true }); return { ok: true }; },
    git: (args) => { gitCalls.push(args); return { status: 0, stdout: '', stderr: '' }; },
    sleep: async () => {},
    ...over,
  };
  return { d, removed, gitCalls };
}

const req = (path: string, extra: Partial<ReclaimRequest> = {}): ReclaimRequest =>
  ({ path, kind: 'worktree', owner: 'run:r1', reason: 'run-ended', requester: 'test', ...extra });

describe('requestReclaim', () => {
  it('원장에 한 줄을 붙이고 reclaim-requested 를 남긴다', () => {
    const r = requestReclaim(req('/x/a'), { ledgerPath });
    expect(r.ok).toBe(true);
    const read = readReclaimLedger(ledgerPath);
    expect(read.requests).toHaveLength(1);
    expect(read.requests[0]).toMatchObject({ path: '/x/a', kind: 'worktree', owner: 'run:r1', requester: 'test' });
    expect(events.map((e) => e.event)).toEqual(['reclaim-requested']);
  });

  it('어떤 입력에도 던지지 않는다 (fail-soft)', () => {
    const blocked = join(root, 'file-not-dir');
    writeFileSync(blocked, 'x');
    const bad: unknown[] = [undefined, null, {}, { path: 'relative', kind: 'worktree' }, { path: '/a', kind: 'nope' },
      { get path() { throw new Error('boom'); } }];
    for (const input of bad) {
      expect(() => requestReclaim(input as ReclaimRequest, { ledgerPath })).not.toThrow();
      expect(requestReclaim(input as ReclaimRequest, { ledgerPath }).ok).toBe(false);
    }
    // 쓸 수 없는 원장 경로(부모가 파일)
    const r = requestReclaim(req('/x/a'), { ledgerPath: join(blocked, 'requests.jsonl') });
    expect(r.ok).toBe(false);
    // 관측 자체가 던져도 호출자는 깨지지 않는다
    debug.log = (() => { throw new Error('log down'); }) as typeof debug.log;
    expect(() => requestReclaim(req('/x/b'), { ledgerPath })).not.toThrow();
  });

  it('잘린 마지막 줄은 커서 뒤로 남긴다', () => {
    requestReclaim(req('/x/a'), { ledgerPath });
    const { appendFileSync } = require('node:fs') as typeof import('node:fs');
    appendFileSync(ledgerPath, '{"path":"/x/b","kind":"wor');
    const read = readReclaimLedger(ledgerPath);
    expect(read.requests).toHaveLength(1);
    expect(read.nextOffset).toBe(readFileSync(ledgerPath, 'utf8').indexOf('\n') + 1);
  });
});

describe('judge', () => {
  it('접두만 같은 형제는 «안»이 아니다', () => {
    expect(isInside('/a/b/c', '/a/b')).toBe(true);
    expect(isInside('/a/bc', '/a/b')).toBe(false);
  });
  it('보호 뿌리를 품은 경로도 남긴다', () => {
    const v = judgeReclaimTarget({ path: '/home/u', kind: 'tmp' }, {
      openPrs: { heads: new Set(), shas: new Set() }, liveDirectories: [], protectedRoots: ['/home/u/elanous-hq/seats'],
      isOwnerLive: () => false, head: null });
    expect(v).toMatchObject({ action: 'keep', reason: 'protected-root' });
  });
});

describe('runDiskSteward', () => {
  it('sim E3-E5: pressured ledger preserves open PR and live work, reclaims only the eligible fixture, and records the completion boundary', async () => {
    const runId = 'disk-steward-e3-e5-sim-run-1';
    const openPrPath = dir('pressure-open-pr');
    const livePath = dir('pressure-live');
    const eligiblePath = dir('pressure-eligible');
    requestReclaim(req(openPrPath, { owner: `run:${runId}` }), { ledgerPath });
    requestReclaim(req(livePath, { owner: `run:${runId}` }), { ledgerPath });
    requestReclaim(req(eligiblePath, { owner: `run:${runId}` }), { ledgerPath });
    const removeCalls: string[] = [];
    const removeFixtureDir = (path: string) => {
      const resolvedRoot = resolve(root);
      const resolvedPath = resolve(path);
      const pathFromRoot = relative(resolvedRoot, resolvedPath);
      if (pathFromRoot === '' || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
        return { ok: false, error: 'outside-simulated-temp-root' };
      }
      let current = resolvedRoot;
      try {
        for (const segment of pathFromRoot.split(sep)) {
          current = join(current, segment);
          if (lstatSync(current).isSymbolicLink()) return { ok: false, error: 'symlink-in-simulated-path' };
        }
        const realRoot = realpathSync(resolvedRoot);
        const realPath = realpathSync(resolvedPath);
        const realPathFromRoot = relative(realRoot, realPath);
        if (realPathFromRoot === '' || realPathFromRoot === '..' || realPathFromRoot.startsWith(`..${sep}`) || isAbsolute(realPathFromRoot)) {
          return { ok: false, error: 'outside-simulated-temp-root' };
        }
      } catch {
        return { ok: false, error: 'unmeasured-simulated-path' };
      }
      removeCalls.push(realpathSync(resolvedPath));
      rmSync(realpathSync(resolvedPath), { recursive: true, force: true });
      return { ok: true };
    };
    expect(removeFixtureDir(`${root}/../outside-simulated-temp-root`))
      .toEqual({ ok: false, error: 'outside-simulated-temp-root' });
    expect(removeCalls).toEqual([]);
    symlinkSync(tmpdir(), join(root, 'external-link'), 'dir');
    expect(removeFixtureDir(join(root, 'external-link', 'outside-simulated-temp-root')))
      .toEqual({ ok: false, error: 'symlink-in-simulated-path' });
    expect(removeCalls).toEqual([]);
    const { d } = deps({
      heads: ['feat/open-pr'],
      listLiveDirectories: () => ({ ok: true, value: [join(livePath, 'child')] }),
      removeDir: removeFixtureDir,
      trees: {
        [openPrPath]: { branch: 'feat/open-pr', sha: 'a'.repeat(40) },
        [livePath]: { branch: 'feat/live-run', sha: 'b'.repeat(40) },
        [eligiblePath]: { branch: 'feat/merged', sha: 'c'.repeat(40) },
      },
    });
    const realEligiblePath = realpathSync(eligiblePath);

    const result = await runDiskSteward({ apply: true, pauseMs: 0 }, d);

    expect(result).toMatchObject({ outcome: 'ok', considered: 3, reclaimed: 1, keptOpenPr: 1, keptLive: 1, failed: 0 });
    expect(removeCalls).toEqual([realEligiblePath]);
    expect(existsSync(openPrPath)).toBe(true);
    expect(existsSync(livePath)).toBe(true);
    expect(existsSync(eligiblePath)).toBe(false);
    const ledgerRows = readReclaimLedger(ledgerPath).requests;
    expect(ledgerRows.map((row) => [row.path, row.owner])).toEqual([
      [openPrPath, `run:${runId}`], [livePath, `run:${runId}`], [eligiblePath, `run:${runId}`],
    ]);
    const requested = events.filter((event) => event.event === 'reclaim-requested');
    expect(requested).toHaveLength(3);
    expect(requested.map((event) => [(event.data as { path: string }).path, (event.data as { owner: string }).owner]))
      .toEqual([[openPrPath, `run:${runId}`], [livePath, `run:${runId}`], [eligiblePath, `run:${runId}`]]);
    expect(events.filter((event) => event.event === 'kept-open-pr')).toHaveLength(1);
    expect(events.find((event) => event.event === 'kept-open-pr')?.data)
      .toMatchObject({ path: openPrPath, owner: `run:${runId}`, head: 'feat/open-pr' });
    expect(events.filter((event) => event.event === 'kept-live')).toHaveLength(1);
    expect(events.find((event) => event.event === 'kept-live')?.data).toMatchObject({ path: livePath, owner: `run:${runId}` });
    expect(events.filter((event) => event.event === 'reclaimed')).toHaveLength(1);
    expect(events.find((event) => event.event === 'reclaimed')?.data)
      .toMatchObject({ path: eligiblePath, owner: `run:${runId}`, branch: 'feat/merged' });
    const summaries = events.filter((event) => event.event === 'run-summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.data).toMatchObject({ outcome: 'ok', considered: 3, reclaimed: 1, keptOpenPr: 1, keptLive: 1, failed: 0 });
  });

  it('기본은 dry-run — 아무것도 지우지 않고 상태도 안 쓴다', async () => {
    const a = dir('wt-a');
    requestReclaim(req(a), { ledgerPath });
    const { d, removed, gitCalls } = deps({ trees: { [a]: { branch: 'gone', sha: 'a'.repeat(40), commonDir: '/r.git' } } });
    const r = await runDiskSteward({}, d);
    expect(r.dryRun).toBe(true);
    expect(r.planned).toBe(1);
    expect(removed).toEqual([]);
    expect(gitCalls).toEqual([]);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(join(stateDir, 'state.json'))).toBe(false);
    expect(events.some((e) => e.event === 'reclaim-planned')).toBe(true);
  });

  it('열린 PR 가지 이름이면 남긴다', async () => {
    const a = dir('wt-branch');
    const { d, removed } = deps({ heads: ['feat/x'], trees: { [a]: { branch: 'feat/x', sha: 'b'.repeat(40) } } });
    const r = await runDiskSteward({ apply: true, targets: [req(a)] }, d);
    expect(r.keptOpenPr).toBe(1);
    expect(removed).toEqual([]);
    expect(events.find((e) => e.event === 'kept-open-pr')?.data).toMatchObject({ match: 'branch', head: 'feat/x' });
  });

  it('가지 이름이 달라도 HEAD sha 가 열린 PR head 면 남긴다', async () => {
    const sha = 'c'.repeat(40);
    const a = dir('wt-harvest');
    const b = dir('wt-detached');
    const { d, removed } = deps({ heads: ['pr-head'], shas: [sha], trees: {
      [a]: { branch: 'harvest/local-name', sha }, [b]: { sha } } });
    const r = await runDiskSteward({ apply: true, targets: [req(a), req(b)] }, d);
    expect(r.keptOpenPr).toBe(2);
    expect(removed).toEqual([]);
  });

  it('살아 있는 cwd 가 그 아래면 남기고 다음 판으로 넘긴다', async () => {
    const a = dir('wt-live');
    const { d, removed } = deps({ listLiveDirectories: () => ({ ok: true, value: [join(a, 'sub')] }),
      trees: { [a]: { branch: 'x' } } });
    const r = await runDiskSteward({ apply: true, targets: [req(a)] }, d);
    expect(r.keptLive).toBe(1);
    expect(removed).toEqual([]);
    const state = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
    expect(state.pending.map((t: { path: string }) => t.path)).toEqual([a]);
  });

  it('소유 런이 살아 있으면 남긴다', async () => {
    const a = dir('wt-owner');
    const { d, removed } = deps({ isOwnerLive: (o) => o === 'run:alive' });
    const r = await runDiskSteward({ apply: true, targets: [req(a, { owner: 'run:alive', kind: 'graph-context' })] }, d);
    expect(r.keptLive).toBe(1);
    expect(removed).toEqual([]);
  });

  it('보호 뿌리 안은 남긴다', async () => {
    const seats = dir('seats');
    const a = dir('seats/OP');
    const { d, removed } = deps({ protectedRoots: [seats] });
    const r = await runDiskSteward({ apply: true, targets: [req(a), req(root, { kind: 'tmp' })] }, d);
    expect(r.keptProtected).toBe(2);
    expect(removed).toEqual([]);
  });

  it('열린 PR 목록을 못 얻으면 그 판은 하나도 지우지 않고 요청을 잃지 않는다', async () => {
    const a = dir('wt-unknown');
    requestReclaim(req(a), { ledgerPath });
    const { d, removed, gitCalls } = deps({ listOpenPrs: () => ({ ok: false, error: 'gh: HTTP 502' }) });
    const r = await runDiskSteward({ apply: true }, d);
    expect(r.outcome).toBe('pr-list-unavailable');
    expect(r.reclaimed).toBe(0);
    expect(removed).toEqual([]);
    expect(gitCalls).toEqual([]);
    expect(existsSync(a)).toBe(true);
    const state = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
    expect(state.pending.map((t: { path: string }) => t.path)).toEqual([a]);
    expect(events.find((e) => e.event === 'run-summary')?.data).toMatchObject({ outcome: 'pr-list-unavailable' });
  });

  it('살아 있는 cwd 목록을 못 얻어도 지우지 않는다', async () => {
    const a = dir('wt-nolsof');
    const { d, removed } = deps({ listLiveDirectories: () => ({ ok: false, error: 'lsof timeout' }) });
    const r = await runDiskSteward({ apply: true, targets: [req(a)] }, d);
    expect(r.outcome).toBe('live-list-unavailable');
    expect(removed).toEqual([]);
  });

  it('apply 면 모르는 것은 지우고 prune·가지 삭제를 한다', async () => {
    const a = dir('wt-merged');
    const t = dir('tmp-repo');
    requestReclaim(req(a), { ledgerPath });
    requestReclaim(req(t, { kind: 'tmp', owner: undefined }), { ledgerPath });
    const { d, removed, gitCalls } = deps({ trees: { [a]: { branch: 'merged/x', sha: 'd'.repeat(40), commonDir: '/r.git' } } });
    const r = await runDiskSteward({ apply: true }, d);
    expect(r.reclaimed).toBe(2);
    expect(removed.sort()).toEqual([a, t].sort());
    expect(gitCalls).toEqual([['-C', '/r.git', 'worktree', 'prune'], ['-C', '/r.git', 'branch', '-D', 'merged/x']]);
    expect(events.filter((e) => e.event === 'reclaimed')).toHaveLength(2);
    // 커서가 전진해 같은 요청을 다시 보지 않는다
    const again = await runDiskSteward({ apply: true }, d);
    expect(again.outcome).toBe('nothing-to-do');
  });

  it('발행 창이면 디렉터리만 지우고 ref·prune 은 미뤘다가 창 밖에서 한다', async () => {
    const a = dir('wt-window');
    let inWindow = true;
    const { d, removed, gitCalls } = deps({ isReleaseWindow: () => inWindow,
      trees: { [a]: { branch: 'old/x', commonDir: '/r.git' } } });
    const r = await runDiskSteward({ apply: true, targets: [req(a)] }, d);
    expect(r.releaseWindow).toBe(true);
    expect(removed).toEqual([a]);
    expect(gitCalls).toEqual([]);
    expect(r.refsDeferred).toBe(1);
    inWindow = false;
    const after = await runDiskSteward({ apply: true }, d);
    expect(after.deletedBranches).toEqual(['old/x']);
    expect(gitCalls).toEqual([['-C', '/r.git', 'worktree', 'prune'], ['-C', '/r.git', 'branch', '-D', 'old/x']]);
  });

  it('지우기 실패는 reclaim-failed 로 남기고 다음 판으로 넘긴다', async () => {
    const a = dir('wt-stuck');
    const { d } = deps({ removeDir: () => ({ ok: false, error: 'EBUSY' }) });
    const r = await runDiskSteward({ apply: true, targets: [req(a)] }, d);
    expect(r.failed).toBe(1);
    expect(events.find((e) => e.event === 'reclaim-failed')?.data).toMatchObject({ error: 'EBUSY' });
  });

  it('발행 창 술어 — 컷 −90분 ~ 공개 +30분', () => {
    const cutAt = new Date('2026-10-29T04:30:00Z');
    const publishAt = new Date('2026-10-29T06:00:00Z');
    const p = releaseWindowPredicate([{ cutAt, publishAt }]);
    expect(p(new Date('2026-10-29T02:59:00Z'))).toBe(false);
    expect(p(new Date('2026-10-29T03:00:00Z'))).toBe(true);
    expect(p(new Date('2026-10-29T06:30:00Z'))).toBe(true);
    expect(p(new Date('2026-10-29T06:31:00Z'))).toBe(false);
  });
});
