import { afterAll, beforeAll, describe, it, expect, spyOn } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POD_GITHUB_CREDENTIAL_TOKEN_ENV, POD_GITHUB_CREDENTIAL_URL_ENV } from '../nexus/api/pod-credential-api.js';
import { ghAutomationEnv, defaultCmdRunner, makePrManager, configuredHunkOverlapMode, extractPrNumber, resolveDeliverableBase, prBaseFromComparison, collectLandedCommitsOnBase, landingHistoryGitLogArgs, recordPrCreateFailureIncident, sanitizeCredentialText, stderrTailOf, type PrCreateFailureIncident, type CmdRunner, type CmdResult } from './pr-manager.js';
import { DEFAULT_BRANCH_WORKTREE_BASE } from '../git-fs/worktree.js';
import { debug } from '../debug/log.js';
import { cardIdFromBody, guardNewPr } from '../pr-tool/census.js';
import { composeSliceHandText } from '../task-agent/tier-split.js';
import { prBody } from '../self-implement/orchestrator.js';

const originalHarnessEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => key === 'ELANOUS_TASK_CARD_ID' || key === 'ELANOUS_SUBSTRATE' || key.startsWith('ELANOUS_POD_')));
beforeAll(() => {
  for (const key of Object.keys(originalHarnessEnv)) delete process.env[key];
});
afterAll(() => {
  for (const key of ['ELANOUS_TASK_CARD_ID', 'ELANOUS_SUBSTRATE', ...Object.keys(process.env).filter(key => key.startsWith('ELANOUS_POD_'))])
    delete process.env[key];
  Object.assign(process.env, originalHarnessEnv);
});

/** 호출 기록 + 프로그램된 응답을 주는 스텁 러너. */
function stubRunner(responses: Record<string, CmdResult> = {}): { run: CmdRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: CmdRunner = (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = [cmd, ...args].join(' ');
    for (const [pat, res] of Object.entries(responses)) if (key.includes(pat)) return res;
    return { ok: true, out: '' };
  };
  return { run, calls };
}

/** 같은 패턴에 순차 응답을 주는 스텁 — 재조회(OPEN→MERGED 등) 시뮬레이션. */
function sequentialStubRunner(responses: Record<string, CmdResult | CmdResult[]>): { run: CmdRunner; calls: string[][] } {
  const calls: string[][] = [];
  const queues: Record<string, CmdResult[]> = {};
  for (const [pat, res] of Object.entries(responses)) queues[pat] = Array.isArray(res) ? [...res] : [res];
  const run: CmdRunner = (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = [cmd, ...args].join(' ');
    for (const [pat, queue] of Object.entries(queues)) {
      if (!key.includes(pat)) continue;
      return queue.length > 1 ? queue.shift()! : (queue[0] ?? { ok: true, out: '' });
    }
    return { ok: true, out: '' };
  };
  return { run, calls };
}

function viewCalls(calls: string[][]): string[][] {
  return calls.filter((call) => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'view' && call.includes('state'));
}

describe('extractPrNumber', () => {
  it('PR URL → 번호', () => expect(extractPrNumber('https://github.com/o/r/pull/3895')).toBe(3895));
  it('아니면 null', () => expect(extractPrNumber('https://x/tree/main')).toBeNull());
});

describe('resolveDeliverableBase — 비교 base 해석(2026-07-26)', () => {
  it('명시 base 최우선(공백 트림) — 로컬 ref 검증 성공 시 그대로 사용', () => {
    const { run, calls } = stubRunner();
    expect(resolveDeliverableBase(run, '/wt', '  release/x  ')).toBe('release/x');
    expect(calls).toEqual([['git', '-C', '/wt', 'rev-parse', '--verify', '--quiet', 'release/x']]);
  });

  it('미지정 → origin/HEAD 해석', () => {
    const { run } = stubRunner({ 'rev-parse --abbrev-ref origin/HEAD': { ok: true, out: 'origin/trunk\n' } });
    expect(resolveDeliverableBase(run, '/wt')).toBe('origin/trunk');
  });

  it('origin/HEAD 가 자기 이름을 되돌려주면(미설정 리포) 해소 실패로 보고 후보 폴백', () => {
    const { run } = stubRunner({
      'rev-parse --abbrev-ref origin/HEAD': { ok: true, out: 'origin/HEAD' },
      'rev-parse --verify --quiet origin/main': { ok: false, out: '' },
      'rev-parse --verify --quiet origin/master': { ok: true, out: 'abc' },
    });
    expect(resolveDeliverableBase(run, '/wt')).toBe('origin/master');
  });

  it('★ main/master 도 아니고 origin/HEAD 도 없으면 원격에 직접 질의(ls-remote --symref) 폴백', () => {
    const { run, calls } = stubRunner({
      'rev-parse --abbrev-ref origin/HEAD': { ok: false, out: '' },
      'rev-parse --verify --quiet origin/main': { ok: false, out: '' },
      'rev-parse --verify --quiet origin/master': { ok: false, out: '' },
      'rev-parse --verify --quiet main': { ok: false, out: '' },
      'rev-parse --verify --quiet master': { ok: false, out: '' },
      'ls-remote --symref': { ok: true, out: 'ref: refs/heads/develop\tHEAD\nabc123\tHEAD' },
      'rev-parse --verify --quiet origin/develop': { ok: true, out: 'abc123' },
    });
    expect(resolveDeliverableBase(run, '/wt')).toBe('origin/develop');
    // 네트워크 질의는 로컬 후보가 전부 실패한 뒤에만.
    expect(calls.findIndex((c) => c.includes('ls-remote'))).toBeGreaterThan(0);
  });

  it('원격 기본 브랜치를 알아냈지만 로컬에 미fetch 면 비교 불가 → undefined', () => {
    const { run } = stubRunner({
      'rev-parse': { ok: false, out: '' },
      'ls-remote --symref': { ok: true, out: 'ref: refs/heads/develop\tHEAD' },
    });
    expect(resolveDeliverableBase(run, '/wt')).toBeUndefined();
  });

  it('후보가 하나도 없으면 undefined(호출부가 reason=base 실패로 올린다)', () => {
    const { run } = stubRunner({ 'rev-parse': { ok: false, out: '' }, 'ls-remote': { ok: false, out: '' } });
    expect(resolveDeliverableBase(run, '/wt')).toBeUndefined();
  });
});

describe('prBaseFromComparison — gh 에 넘길 base', () => {
  it('remote-tracking ref 는 접두를 벗긴다(gh 는 브랜치명을 받는다)', () => {
    expect(prBaseFromComparison('origin/main')).toBe('main');
    expect(prBaseFromComparison('origin/release/1.x')).toBe('release/1.x');
  });
  it('로컬 브랜치명은 그대로', () => {
    expect(prBaseFromComparison('main')).toBe('main');
    // 'origin' 은 접두가 아니라 이름의 일부일 수 있다 — 정확히 `origin/` 만 제거.
    expect(prBaseFromComparison('originals')).toBe('originals');
  });
});

describe('collectLandedCommitsOnBase — 착지 이력은 base 범위만', () => {
  it('resolved base ref 만 로컬 git log 로 읽고 HEAD/gh 는 쓰지 않는다', () => {
    const { run, calls } = stubRunner({ 'git log': { ok: true, out: 'commit aaa111bbb222ccc333ddd444eee555fff666aaa\nlanded.md\n' } });
    const result = collectLandedCommitsOnBase(run, '/wt', { since: '1 day ago', baseRef: 'origin/main' });
    expect(result).toEqual({ ok: true, out: 'commit aaa111bbb222ccc333ddd444eee555fff666aaa\nlanded.md\n' });
    expect(calls).toEqual([[
      'git', 'log', '--since=1 day ago', '--pretty=format:commit %H',
      '--name-only', '--no-merges', '--no-renames', 'origin/main',
    ]]);
    expect(landingHistoryGitLogArgs('1 day ago', 'origin/main')).not.toContain('HEAD');
    expect(calls.some((call) => call[0] === 'gh')).toBe(false);
  });
});

describe('makePrManager.findPrForBranch observation', () => {
  it('base 표식은 gh 를 아예 부르지 않고 건너뛴 사실을 남긴다 · 실제 브랜치는 종전대로 조회한다', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const { run, calls } = stubRunner({
        [`--head ${DEFAULT_BRANCH_WORKTREE_BASE}`]: { ok: true, out: '' },
        '--head feature/real': { ok: true, out: 'https://github.com/o/r/pull/9' },
      });
      const manager = makePrManager(run);
      expect(manager.findPrForBranch(DEFAULT_BRANCH_WORKTREE_BASE, '/wt')).toBeNull();
      expect(manager.findPrForBranch('feature/real', '/wt')).toBe('https://github.com/o/r/pull/9');
      // ⛔ 표식으로는 gh 를 부르지 않는다 — 부르면 gh 가 실패처럼 읽히는 stderr 한 줄을 뱉고,
      //    그 줄이 진짜 PR 실패 옆에 앉아 사람을 눈멀게 한다(2026-08-02 실측 · #6604).
      expect(calls.some((c) => c.includes(DEFAULT_BRANCH_WORKTREE_BASE))).toBe(false);
      expect(calls.some((c) => c.includes('feature/real'))).toBe(true);
      expect(log).toHaveBeenCalledWith('autopilot.pr-manager', 'lookup.skipped', {
        branch: DEFAULT_BRANCH_WORKTREE_BASE,
        reason: 'default-branch-sentinel-is-not-a-head',
        status: 'SKIPPED',
      });
      expect(log).toHaveBeenCalledWith('autopilot.pr-manager', 'lookup', {
        branch: 'feature/real',
        returnedUrlCount: 1,
        status: 'ok OUTPUT',
      });
      for (const [, event, data] of log.mock.calls.filter(([, event]) => event === 'lookup')) {
        expect(data).not.toHaveProperty('args');
        expect(data).not.toHaveProperty('out');
        expect(data).not.toHaveProperty('output');
      }
    } finally {
      log.mockRestore();
    }
  });
});

describe('makePrManager.findPrForBranchOutcome', () => {
  it('found, empty, failed, and skipped lookups have distinct status names and preserve the legacy URL contract', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const { run, calls } = stubRunner({
        '--head feature/found': { ok: true, out: 'https://github.com/o/r/pull/9' },
        '--head feature/empty': { ok: true, out: '' },
        '--head feature/failed': { ok: false, out: '', err: 'network unavailable' },
      });
      const manager = makePrManager(run);
      expect(manager.findPrForBranchOutcome('feature/found', '/wt')).toEqual({ status: 'ok OUTPUT', url: 'https://github.com/o/r/pull/9' });
      expect(manager.findPrForBranchOutcome('feature/empty', '/wt')).toEqual({ status: 'ok EMPTY', url: null });
      expect(manager.findPrForBranchOutcome('feature/failed', '/wt')).toEqual({ status: 'FAILED', url: null, stderrTail: 'network unavailable' });
      expect(manager.findPrForBranchOutcome(DEFAULT_BRANCH_WORKTREE_BASE, '/wt')).toEqual({ status: 'SKIPPED', url: null });
      expect(manager.findPrForBranch('feature/failed', '/wt')).toBeNull();
      expect(calls.some((call) => call.includes(DEFAULT_BRANCH_WORKTREE_BASE))).toBe(false);
      expect(log).toHaveBeenCalledWith('autopilot.pr-manager', 'lookup', expect.objectContaining({ branch: 'feature/failed', status: 'FAILED' }));
      expect(log).toHaveBeenCalledWith('autopilot.pr-manager', 'lookup.skipped', expect.objectContaining({ branch: DEFAULT_BRANCH_WORKTREE_BASE, status: 'SKIPPED' }));
    } finally {
      log.mockRestore();
    }
  });
});

describe('makePrManager.upsertPr — 기존 PR 재활용(대표 2026-07-12)', () => {
  const input = {
    branch: 'se/apm-x-abc', worktreePath: '/wt', title: '[SE] x', body: 'b', base: 'main',
    commitMessage: 'm', excludePaths: ['node_modules', 'apps/pwa/out'], reuseComment: '🔄 재구현',
  };

  it('카드 후보 inventory 미측정은 새 draft로 관측하고 기존 가지를 강제 push하지 않는다', () => {
    const { run, calls } = stubRunner({ 'pr list': { ok: true, out: '' }, 'pr create': { ok: true, out: 'https://github.com/o/r/pull/91' } });
    const body = '칸: PR-GUARD-INVENTORY-UNMEASURED-FU\n카드: ta-123';
    const guard = () => guardNewPr({ files: ['src/new.ts'], cellId: 'PR-GUARD-INVENTORY-UNMEASURED-FU', cardId: 'ta-123' }, { status: 'unknown', reason: 'network' });
    const result = makePrManager(run, guard, () => ({ count: 4, blocked: true })).upsertPr({ ...input, body, seat: 'TC' });
    expect(result).toMatchObject({ ok: true, reused: false, url: 'https://github.com/o/r/pull/91' });
    const create = calls.find(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create');
    expect(create).toContain('--draft');
    expect(create).toContain('pr-guard:unmeasured');
    expect(calls).toContainEqual(['git', '-C', '/wt', 'push', '-u', 'origin', input.branch]);
    expect(calls.some(call => call[0] === 'git' && call.includes('--force'))).toBe(false);
  });

  it('카드 후보 inventory 검사기가 없을 때도 draft만 만들고 미측정을 표시한다', () => {
    const { run, calls } = stubRunner({ 'pr list': { ok: true, out: '' }, 'pr create': { ok: true, out: 'https://github.com/o/r/pull/92' } });
    const result = makePrManager(run).upsertPr({ ...input, body: '칸: PR-GUARD-INVENTORY-UNMEASURED-FU\n카드: ta-123' });
    expect(result).toMatchObject({ ok: true, reused: false });
    const create = calls.find(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create');
    expect(create).toContain('--draft');
    expect(create).toContain('pr-guard:unmeasured');
  });

  it('★ sibling-slice: 같은 칸의 다른 조각(2/6) OPEN draft 가 있어도 조각 5/6 은 새 draft 를 연다(outcome=allowed)', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const head = 'a'.repeat(40);
      // 운영 생산자(tier-split hand) → PR 본문 조립 → pr-manager 파서의 실제 문면.
      const body = `칸: PR-SAME-CELL-SLICE\n카드: ta-slice-5\n${prBody(composeSliceHandText('대상 경로: src/new.ts',
        '현재 계약: 부모 계약 유지', { index: 5, total: 6, fromTier: '상', cid: 'TUI-SEAT-PILOT' }), '구현 완료')}`;
      const existing = { number: 7, headRefName: 'se/slice-2', title: '조각 2/6', draft: true,
        updatedAt: '2026-10-21T00:00:00Z', headSha: head, labels: [], files: ['src/old.ts'], seat: null,
        cellId: 'PR-SAME-CELL-SLICE', cardId: 'ta-slice-5', slice: { slice: 2, total: 6 } };
      const { run, calls } = stubRunner({
        'pr list': { ok: true, out: '' },
        'pr create': { ok: true, out: 'https://github.com/o/r/pull/95' },
      });
      const guard = () => guardNewPr({ files: ['src/new.ts'], cellId: 'PR-SAME-CELL-SLICE', cardId: 'ta-slice-5',
        slice: { slice: 5, total: 6 } },
        { status: 'checked', prs: [existing] });
      const result = makePrManager(run, guard).upsertPr({ ...input, body, draft: true });
      expect(result).toMatchObject({ ok: true, reused: false, url: 'https://github.com/o/r/pull/95' });
      expect(calls.some(call => call[0] === 'git' && call.some(arg => arg.startsWith('--force')))).toBe(false);
      const create = calls.find(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create');
      expect(create).toContain('--draft');
      expect(create?.[create.indexOf('--title') + 1]).toContain('조각 5/6');
      expect(create?.[create.indexOf('--body') + 1]).toContain('조각 5/6');
      expect(log).toHaveBeenCalledWith('autopilot.pr-manager', 'same-cell-sibling-slice', {
        cell: 'PR-SAME-CELL-SLICE', slice: 5, total: 6, existingSlice: 2, outcome: 'allowed',
      });
    } finally {
      log.mockRestore();
    }
  });

  it('★ sibling-slice: 같은 조각(2/6) 재발사는 기존 재사용 경로를 그대로 쓴다', () => {
    const head = 'a'.repeat(40);
    const body = '칸: PR-SAME-CELL-SLICE\n카드: ta-slice-2\n조각 2/6 — 부모 TUI-SEAT-PILOT';
    const url = 'https://github.com/o/r/pull/7';
    const { run, calls } = stubRunner({
      'pr view 7 --json state': { ok: true, out: JSON.stringify({ state: 'OPEN', headRefOid: head, headRefName: 'old-branch', body, isCrossRepository: false, url }) },
      'ls-remote --exit-code origin refs/heads/old-branch': { ok: true, out: `${head}\trefs/heads/old-branch` },
      'rev-parse refs/elanous/pr-reuse/7-aaaaaaaaaaaa': { ok: true, out: head },
    });
    const inventory = { status: 'checked' as const, prs: [{ number: 7, headRefName: 'old-branch', title: 'old', draft: true,
      updatedAt: '2026-10-19T00:00:00Z', headSha: head, labels: [], files: ['src/old.ts'], seat: null,
      cellId: 'PR-SAME-CELL-SLICE', cardId: 'ta-slice-2', slice: { slice: 2, total: 6 } }] };
    const guard = () => guardNewPr({ files: ['src/new.ts'], cellId: 'PR-SAME-CELL-SLICE', cardId: 'ta-slice-2',
      slice: { slice: 2, total: 6 } }, inventory);
    expect(makePrManager(run, guard).upsertPr({ ...input, body })).toEqual({ ok: true, url, reused: true, boundCardHeadRefName: 'old-branch' });
    expect(calls).toContainEqual(['git', '-C', '/wt', 'push', `--force-with-lease=refs/heads/old-branch:${head}`, 'origin', 'HEAD:refs/heads/old-branch']);
    expect(calls.some(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create')).toBe(false);
  });

  it('★ sibling-slice: 조각 표지 없는 일반 런의 같은 칸 가드는 그대로 거부한다', () => {
    const head = 'a'.repeat(40);
    const body = '칸: PR-SAME-CELL-SLICE\n카드: ta-slice-5';
    const { run, calls } = stubRunner();
    const guard = () => guardNewPr({ files: ['src/new.ts'], cellId: 'PR-SAME-CELL-SLICE', cardId: 'ta-slice-5' },
      { status: 'checked', prs: [{ number: 7, headRefName: 'se/slice-2', title: '조각 2/6', draft: true,
        updatedAt: '2026-10-21T00:00:00Z', headSha: head, labels: [], files: ['src/old.ts'], seat: null,
        cellId: 'PR-SAME-CELL-SLICE', cardId: 'ta-slice-2', slice: { slice: 2, total: 6 } }] });
    const result = makePrManager(run, guard).upsertPr({ ...input, body });
    expect(result).toMatchObject({ ok: false, reason: 'guard', detail: expect.stringContaining('same-cell') });
    expect(calls.some(call => call[0] === 'git' && call.includes('push'))).toBe(false);
    expect(calls.some(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create')).toBe(false);
  });

  it('같은 칸·같은 카드의 기존 PR 머리를 합쳐 빠른 전진으로 갱신하고 새 PR을 열지 않는다', () => {
    const head = 'a'.repeat(40);
    const body = '칸: PR-SAME-CELL-REUSE\n카드: ta-123';
    const url = 'https://github.com/o/r/pull/7';
    const { run, calls } = stubRunner({
      'pr view 7 --json state': { ok: true, out: JSON.stringify({ state: 'OPEN', headRefOid: head, headRefName: 'old-branch', body, isCrossRepository: false, url }) },
      'ls-remote --exit-code origin refs/heads/old-branch': { ok: true, out: `${head}\trefs/heads/old-branch` },
      'rev-parse refs/elanous/pr-reuse/7-aaaaaaaaaaaa': { ok: true, out: head },
    });
    const inventory = { status: 'checked' as const, prs: [{ number: 7, headRefName: 'old-branch', title: 'old', draft: true,
      updatedAt: '2026-10-19T00:00:00Z', headSha: head, labels: [], files: ['src/old.ts'], seat: null,
      cellId: 'PR-SAME-CELL-REUSE', cardId: 'ta-123' }] };
    const guard = () => guardNewPr({ files: ['src/new.ts'], cellId: 'PR-SAME-CELL-REUSE', cardId: 'ta-123' }, inventory);
    expect(makePrManager(run, guard).upsertPr({ ...input, body })).toEqual({ ok: true, url, reused: true, boundCardHeadRefName: 'old-branch' });
    expect(calls).toContainEqual(['git', '-C', '/wt', 'push', `--force-with-lease=refs/heads/old-branch:${head}`, 'origin', 'HEAD:refs/heads/old-branch']);
    expect(calls.some(call => call[0] === 'git' && call[1] === '-C' && call[2] === '/wt' && call[3] === 'push' && call.includes('--force'))).toBe(false);
    expect(calls.some(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create')).toBe(false);
  });

  it('충돌 draft의 scratch ref 삭제 실패 stderr 전문을 절단 없이 기록한다', () => {
    const head = 'a'.repeat(40);
    const body = '칸: PR-SAME-CELL-REUSE\n카드: ta-123';
    const url = 'https://github.com/o/r/pull/7';
    const stderr = `remote: ${'cleanup detail '.repeat(24)}END`;
    const stdout = `notice: ${'secondary output '.repeat(20)}END`;
    expect(stderr.length).toBeGreaterThan(220);
    expect(stdout.length).toBeGreaterThan(220);
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    // 하니스 디스패치 env 의 ELANOUS_TASK_CARD_ID(이 런의 과업 카드)가 새어 들면 upsertPr 입구의
    // 카드 계보 가드가 무대 카드(ta-123)와 충돌해 cleanup 경로에 못 미치게 차단한다 — 무대의
    // 카드 표식이 지배하도록 잠시 비우고 끝내 복원한다.
    const savedCardId = process.env.ELANOUS_TASK_CARD_ID;
    delete process.env.ELANOUS_TASK_CARD_ID;
    try {
      const { run, calls } = stubRunner({
        'pr view 7 --json state': { ok: true, out: JSON.stringify({ state: 'OPEN', headRefOid: head,
          headRefName: 'old-branch', body, isCrossRepository: false, isDraft: true, url }) },
        'ls-remote --exit-code origin refs/heads/old-branch': { ok: true, out: `${head}\trefs/heads/old-branch` },
        'rev-parse refs/elanous/pr-reuse/7-aaaaaaaaaaaa': { ok: true, out: head },
        'merge --no-edit': { ok: false, out: '', err: 'merge conflict' },
        'rev-parse HEAD': { ok: true, out: 'b'.repeat(40) },
        'repo view --json nameWithOwner': { ok: true, out: 'o/r' },
        'push origin :refs/heads/self-impl/pr-create-ra1b2c3-': { ok: false, out: stdout, err: stderr },
        'pr create': { ok: true, out: 'https://github.com/o/r/pull/8' },
      });
      const inventory = { status: 'checked' as const, prs: [{ number: 7, headRefName: 'old-branch', title: 'old', draft: true,
        updatedAt: '2026-10-19T00:00:00Z', headSha: head, labels: [], files: ['src/old.ts'], seat: null,
        cellId: 'PR-SAME-CELL-REUSE', cardId: 'ta-123' }] };
      const guard = () => guardNewPr({ files: ['src/new.ts'], cellId: 'PR-SAME-CELL-REUSE', cardId: 'ta-123' }, inventory);
      expect(makePrManager(run, guard).upsertPr({ ...input, body, runId: 'run-a1b2c3d4-1111-2222-3333-444444444444' })).toEqual({
        ok: true, url: 'https://github.com/o/r/pull/8', reused: false, supersededPr: 7,
      });
      const scratchRemoval = calls.find(call => call[0] === 'git' && call.includes('push')
        && call.some(arg => arg.startsWith(':refs/heads/self-impl/pr-create-ra1b2c3-')));
      expect(scratchRemoval).toBeDefined();
      const cleanupLog = log.mock.calls.find(([, event]) => event === 'same-cell-scratch-cleanup-failed');
      expect(cleanupLog).toBeDefined();
      expect(cleanupLog![2]).toMatchObject({ detail: stderr, stderr, stdout, truncated: false,
        scratchRef: expect.stringMatching(/^refs\/heads\/self-impl\/pr-create-ra1b2c3-/) });
      expect(cleanupLog![3]).toEqual({ level: 'warn' });
    } finally {
      log.mockRestore();
      if (savedCardId === undefined) delete process.env.ELANOUS_TASK_CARD_ID;
      else process.env.ELANOUS_TASK_CARD_ID = savedCardId;
    }
  });

  it('짧은 원문의 scratch ref 삭제 실패도 그대로 남긴다(220자 미만 무절단)', () => {
    const head = 'a'.repeat(40);
    const body = '칸: PR-SAME-CELL-REUSE\n카드: ta-123';
    const url = 'https://github.com/o/r/pull/7';
    const stderr = 'remote: short cleanup failure';
    const stdout = 'notice: brief stdout';
    expect(stderr.length).toBeLessThan(220);
    expect(stdout.length).toBeLessThan(220);
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    // 무대 카드(ta-123)가 지배하도록 하니스 디스패치 env 의 과업 카드 표식을 잠시 비우고 끝내 복원한다.
    const savedCardId = process.env.ELANOUS_TASK_CARD_ID;
    delete process.env.ELANOUS_TASK_CARD_ID;
    try {
      const { run, calls } = stubRunner({
        'pr view 7 --json state': { ok: true, out: JSON.stringify({ state: 'OPEN', headRefOid: head,
          headRefName: 'old-branch', body, isCrossRepository: false, isDraft: true, url }) },
        'ls-remote --exit-code origin refs/heads/old-branch': { ok: true, out: `${head}\trefs/heads/old-branch` },
        'rev-parse refs/elanous/pr-reuse/7-aaaaaaaaaaaa': { ok: true, out: head },
        'merge --no-edit': { ok: false, out: '', err: 'merge conflict' },
        'rev-parse HEAD': { ok: true, out: 'b'.repeat(40) },
        'repo view --json nameWithOwner': { ok: true, out: 'o/r' },
        'push origin :refs/heads/self-impl/pr-create-ra1b2c3-': { ok: false, out: stdout, err: stderr },
        'pr create': { ok: true, out: 'https://github.com/o/r/pull/8' },
      });
      const inventory = { status: 'checked' as const, prs: [{ number: 7, headRefName: 'old-branch', title: 'old', draft: true,
        updatedAt: '2026-10-19T00:00:00Z', headSha: head, labels: [], files: ['src/old.ts'], seat: null,
        cellId: 'PR-SAME-CELL-REUSE', cardId: 'ta-123' }] };
      const guard = () => guardNewPr({ files: ['src/new.ts'], cellId: 'PR-SAME-CELL-REUSE', cardId: 'ta-123' }, inventory);
      expect(makePrManager(run, guard).upsertPr({ ...input, body, runId: 'run-a1b2c3d4-1111-2222-3333-444444444444' })).toEqual({
        ok: true, url: 'https://github.com/o/r/pull/8', reused: false, supersededPr: 7,
      });
      const scratchRemoval = calls.find(call => call[0] === 'git' && call.includes('push')
        && call.some(arg => arg.startsWith(':refs/heads/self-impl/pr-create-ra1b2c3-')));
      expect(scratchRemoval).toBeDefined();
      const cleanupLog = log.mock.calls.find(([, event]) => event === 'same-cell-scratch-cleanup-failed');
      expect(cleanupLog).toBeDefined();
      expect(cleanupLog![2]).toMatchObject({ detail: stderr, stderr, stdout, truncated: false,
        scratchRef: expect.stringMatching(/^refs\/heads\/self-impl\/pr-create-ra1b2c3-/) });
      expect(cleanupLog![3]).toEqual({ level: 'warn' });
    } finally {
      log.mockRestore();
      if (savedCardId === undefined) delete process.env.ELANOUS_TASK_CARD_ID;
      else process.env.ELANOUS_TASK_CARD_ID = savedCardId;
    }
  });

  it('같은 카드 후보라도 PR 머리가 바뀌면 기존 가지를 밀지 않는다', () => {
    const head = 'a'.repeat(40);
    const body = '칸: PR-SAME-CELL-REUSE\n카드: ta-123';
    const { run, calls } = stubRunner({
      'pr view 7 --json state': { ok: true, out: JSON.stringify({ state: 'OPEN', headRefOid: 'b'.repeat(40), headRefName: 'old-branch', body, isCrossRepository: false, url: 'https://github.com/o/r/pull/7' }) },
    });
    const guard = () => guardNewPr({ files: ['src/new.ts'], cellId: 'PR-SAME-CELL-REUSE', cardId: 'ta-123' }, { status: 'checked', prs: [{
      number: 7, headRefName: 'old-branch', title: 'old', draft: true, updatedAt: '2026-10-19T00:00:00Z', headSha: head,
      labels: [], files: ['src/old.ts'], seat: null, cellId: 'PR-SAME-CELL-REUSE', cardId: 'ta-123',
    }] });
    expect(makePrManager(run, guard).upsertPr({ ...input, body })).toMatchObject({ ok: false, reason: 'guard', detail: expect.stringContaining('changed') });
    expect(calls.some(call => call[0] === 'git' && call.includes('push'))).toBe(false);
  });

  it('재사용 병합 중 두 번째 같은 칸 PR이 열리면 전체 OPEN 재조회 뒤 push를 거부한다', () => {
    const head = 'a'.repeat(40);
    const body = '칸: PR-SAME-CELL-REUSE\n카드: ta-123';
    const url = 'https://github.com/o/r/pull/7';
    const { run, calls } = stubRunner({
      'pr view 7 --json state': { ok: true, out: JSON.stringify({ state: 'OPEN', headRefOid: head, headRefName: 'old-branch', body, isCrossRepository: false, url }) },
      'ls-remote --exit-code origin refs/heads/old-branch': { ok: true, out: `${head}\trefs/heads/old-branch` },
      'rev-parse refs/elanous/pr-reuse/7-aaaaaaaaaaaa': { ok: true, out: head },
    });
    const first = { number: 7, headRefName: 'old-branch', title: 'old', draft: true,
      updatedAt: '2026-10-19T00:00:00Z', headSha: head, labels: [], files: ['src/old.ts'], seat: null,
      cellId: 'PR-SAME-CELL-REUSE', cardId: 'ta-123' };
    const events: Array<{ event: string; data: unknown }> = [];
    const log = spyOn(debug, 'log').mockImplementation((_category, event, data) => { events.push({ event, data }); });
    let checks = 0;
    const guard = () => guardNewPr({ files: ['src/new.ts'], cellId: 'PR-SAME-CELL-REUSE', cardId: 'ta-123' }, {
      status: 'checked', prs: ++checks === 1 ? [first] : [{ ...first, headRefName: 'renamed-branch', headSha: 'b'.repeat(40) },
        { ...first, number: 8, headRefName: 'second-branch', headSha: 'c'.repeat(40) }],
    });
    try {
      expect(makePrManager(run, guard).upsertPr({ ...input, body })).toMatchObject({
        ok: false, reason: 'guard', detail: expect.stringContaining('OPEN PR inventory changed before push'),
      });
      expect(checks).toBe(2);
      expect(calls.some(call => call[0] === 'git' && call.includes('push'))).toBe(false);
      const event = events.find((row) => row.event === 'same-cell-push-decision');
      expect(event?.data).toMatchObject({
        cardId: 'ta-123', ref: 'refs/heads/old-branch',
        reason: 'OPEN PR inventory changed before push',
        inventoryBefore: { conflicts: [{ pr: 7, branch: 'old-branch', headSha: head, cardId: 'ta-123', slice: null }],
          reusable: { number: 7, branch: 'old-branch', headSha: head, cellId: 'PR-SAME-CELL-REUSE', cardId: 'ta-123', legacyBound: false } },
        inventoryAfter: { conflicts: [{ pr: 7, branch: 'renamed-branch', headSha: 'b'.repeat(40), cardId: 'ta-123', slice: null },
          { pr: 8, branch: 'second-branch', headSha: 'c'.repeat(40), cardId: 'ta-123', slice: null }], reusable: null },
        inventoryDiff: { added: [{ pr: 8, branch: 'second-branch', headSha: 'c'.repeat(40), cardId: 'ta-123', slice: null }], removed: [],
          changed: [{ pr: 7, before: { pr: 7, branch: 'old-branch', headSha: head, cardId: 'ta-123', slice: null },
            after: { pr: 7, branch: 'renamed-branch', headSha: 'b'.repeat(40), cardId: 'ta-123', slice: null } }], reusableChanged: true },
      });
    } finally { log.mockRestore(); }
  });

  it('병합 중 PR head가 움직이거나 본문 카드가 모호해지면 push 전에 멈춘다', () => {
    const head = 'a'.repeat(40);
    const body = '칸: PR-SAME-CELL-REUSE\n카드: ta-123';
    const url = 'https://github.com/o/r/pull/7';
    const { run, calls } = sequentialStubRunner({
      'pr view 7 --json state': [
        { ok: true, out: JSON.stringify({ state: 'OPEN', headRefOid: head, headRefName: 'old-branch', body, isCrossRepository: false, url }) },
        { ok: true, out: JSON.stringify({ state: 'OPEN', headRefOid: 'b'.repeat(40), headRefName: 'old-branch', body, isCrossRepository: false, url }) },
      ],
      'ls-remote --exit-code origin refs/heads/old-branch': { ok: true, out: `${head}\trefs/heads/old-branch` },
      'rev-parse refs/elanous/pr-reuse/7-aaaaaaaaaaaa': { ok: true, out: head },
    });
    const guard = () => guardNewPr({ files: ['src/new.ts'], cellId: 'PR-SAME-CELL-REUSE', cardId: 'ta-123' }, { status: 'checked', prs: [{
      number: 7, headRefName: 'old-branch', title: 'old', draft: true, updatedAt: '2026-10-19T00:00:00Z', headSha: head,
      labels: [], files: ['src/old.ts'], seat: null, cellId: 'PR-SAME-CELL-REUSE', cardId: 'ta-123',
    }] });
    expect(makePrManager(run, guard).upsertPr({ ...input, body })).toMatchObject({ ok: false, reason: 'guard', detail: expect.stringContaining('before push') });
    expect(calls.some(call => call[0] === 'git' && call.includes('push'))).toBe(false);
    const ambiguous = guardNewPr({ files: ['src/new.ts'], cellId: 'PR-SAME-CELL-REUSE', cardId: 'ta-123' }, { status: 'checked', prs: [{
      number: 7, headRefName: 'old-branch', title: 'old', draft: true, updatedAt: '2026-10-19T00:00:00Z', headSha: head,
      labels: [], files: ['src/old.ts'], seat: null, cellId: 'PR-SAME-CELL-REUSE', cardId: cardIdFromBody(`${body}\n카드: ta-other`),
    }] });
    expect(ambiguous.sameCellReuse).toBeUndefined();
  });

  it('후보 본문 카드 표식이 충돌하면 같은 가지 force push 전에 거부한다', () => {
    const { run, calls } = stubRunner({ 'pr list': { ok: true, out: 'https://github.com/o/r/pull/7' } });
    const body = '칸: PR-SAME-CELL-REUSE\n카드: ta-123\n카드: ta-other';
    expect(makePrManager(run).upsertPr({ ...input, body })).toMatchObject({
      ok: false, reason: 'guard', detail: expect.stringContaining('card lineage is ambiguous'),
    });
    expect(calls.some(call => call[0] === 'git' && call.includes('push'))).toBe(false);
    expect(calls.some(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'edit')).toBe(false);
  });

  it('첫 조회 뒤 다른 카드의 OPEN PR이 생기면 생성 직전 재조회에서 중복 PR을 거부한다', () => {
    const { run, calls } = stubRunner({ 'pr list': { ok: true, out: '' } });
    const body = '칸: PR-SAME-CELL-REUSE\n카드: ta-123';
    let checks = 0;
    const guard = () => {
      checks += 1;
      return guardNewPr({ files: ['src/new.ts'], cellId: 'PR-SAME-CELL-REUSE', cardId: 'ta-123' }, {
        status: 'checked', prs: checks === 1 ? [] : [{
          number: 8, headRefName: 'other-run', title: 'other', draft: true,
          updatedAt: '2026-10-19T00:00:00Z', headSha: 'b'.repeat(40), labels: [],
          files: ['src/other.ts'], seat: null, cellId: 'PR-SAME-CELL-REUSE', cardId: 'ta-other',
        }],
      });
    };
    expect(makePrManager(run, guard).upsertPr({ ...input, body })).toMatchObject({
      ok: false, reason: 'guard', detail: expect.stringContaining('same-cell'),
    });
    expect(checks).toBe(2);
    expect(calls.some(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create')).toBe(false);
  });

  it('첫 조회 뒤 같은 카드 PR이 생기면 새 run 가지를 비강제로 밀었더라도 재사용하지 않고 거부한다', () => {
    const { run, calls } = stubRunner({ 'pr list': { ok: true, out: '' } });
    const body = '칸: PR-SAME-CELL-REUSE\n카드: ta-123';
    let checks = 0;
    const guard = () => guardNewPr({ files: ['src/new.ts'], cellId: 'PR-SAME-CELL-REUSE', cardId: 'ta-123' }, {
      status: 'checked', prs: ++checks === 1 ? [] : [{
        number: 8, headRefName: 'other-run', title: 'same card', draft: true,
        updatedAt: '2026-10-19T00:00:00Z', headSha: 'b'.repeat(40), labels: [],
        files: ['src/other.ts'], seat: null, cellId: 'PR-SAME-CELL-REUSE', cardId: 'ta-123',
      }],
    });
    expect(makePrManager(run, guard).upsertPr({ ...input, body })).toMatchObject({
      ok: false, reason: 'guard', detail: expect.stringContaining('appeared after run branch push'),
    });
    expect(checks).toBe(2);
    expect(calls.some(call => call[0] === 'git' && call.includes('push') && call.includes('--force'))).toBe(false);
    expect(calls.some(call => call[0] === 'gh' && call[1] === 'pr' && (call[2] === 'create' || call[2] === 'edit'))).toBe(false);
  });

  it('새 run 가지 push 뒤 바로 그 가지에 PR이 생겨도 edit 경로를 열지 않는다', () => {
    const { run, calls } = sequentialStubRunner({
      '--head se/apm-x-abc': [
        { ok: true, out: '' },
        { ok: true, out: 'https://github.com/o/r/pull/9' },
      ],
    });
    const body = '칸: PR-SAME-CELL-REUSE\n카드: ta-123';
    const guard = () => guardNewPr({ files: ['src/new.ts'], cellId: 'PR-SAME-CELL-REUSE', cardId: 'ta-123' }, { status: 'checked', prs: [] });
    expect(makePrManager(run, guard).upsertPr({ ...input, body })).toMatchObject({
      ok: false, reason: 'guard', detail: expect.stringContaining('appeared after push'),
    });
    expect(calls.some(call => call[0] === 'gh' && call[1] === 'pr' && (call[2] === 'edit' || call[2] === 'create'))).toBe(false);
    expect(calls.some(call => call[0] === 'git' && call.includes('push') && call.includes('--force'))).toBe(false);
  });

  it('하니스 신규 PR 생성 직전 공유 open-guard 거부를 적용하고 gh pr create 를 부르지 않는다', () => {
    const { run, calls } = stubRunner({ 'pr list': { ok: true, out: '' } });
    let checked = 0;
    const result = makePrManager(run, () => {
      checked += 1;
      return guardNewPr({ files: ['docs/goals/GOAL-only.md'] }, { status: 'checked', prs: [] });
    }).upsertPr(input);
    expect(checked).toBe(1);
    expect(result).toMatchObject({ ok: false, reason: 'guard', detail: expect.stringContaining('goal-only') });
    expect(calls.some(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create')).toBe(false);
  });

  it('하니스 호출자 seat 를 신규 PR 라벨에 남긴다', () => {
    const { run, calls } = stubRunner({ 'pr list': { ok: true, out: '' }, 'pr create': { ok: true, out: 'https://github.com/o/r/pull/91' } });
    const result = makePrManager(run, () => ({ status: 'allow', reasons: [], warnings: [] })).upsertPr({ ...input, seat: 'UX' });
    expect(result).toMatchObject({ ok: true, reused: false });
    expect(calls.find(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create')).toContain('seat:UX');
  });

  it('줄 겹침 경고(기본 warn)는 PR 을 막지 않고 pr-guard:hunk-overlap 라벨 ⊕ 관측 이벤트를 남긴다', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const { run, calls } = stubRunner({ 'pr list': { ok: true, out: '' }, 'pr create': { ok: true, out: 'https://github.com/o/r/pull/91' } });
      const inventory = { status: 'checked' as const, prs: [{ number: 7, title: 't', draft: false, updatedAt: '2026-10-17T00:00:00Z', headSha: 'a', labels: [], files: ['src/a.ts'], seat: null, cellId: null, hunks: [{ path: 'src/a.ts', start: 10, end: 20 }] }] };
      const guard = () => guardNewPr({ files: ['src/a.ts'], hunks: [{ path: 'src/a.ts', start: 15, end: 16 }] }, inventory);
      const result = makePrManager(run, guard).upsertPr({ ...input, seat: 'UX' });
      expect(result).toMatchObject({ ok: true, reused: false });
      const create = calls.find(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create');
      expect(create).toContain('pr-guard:hunk-overlap');
      expect(log).toHaveBeenCalledWith('pr-tool.guard', 'hunk-overlap-warn', { pr: 91, files: ['src/a.ts'], against: [7] });
    } finally {
      log.mockRestore();
    }
  });

  it('줄 겹침 라벨 생성이 실패해도 라벨을 빼고 PR 을 연다', () => {
    const calls: string[][] = [];
    const run: CmdRunner = (cmd, args) => {
      calls.push([cmd, ...args]);
      const key = [cmd, ...args].join(' ');
      if (key.includes('pr list')) return { ok: true, out: '' };
      if (key.includes('label create')) return { ok: false, out: '', err: 'HTTP 403' };
      if (key.includes('pr create')) {
        return args.includes('pr-guard:hunk-overlap')
          ? { ok: false, out: '', err: "could not add label: 'pr-guard:hunk-overlap' not found" }
          : { ok: true, out: 'https://github.com/o/r/pull/92' };
      }
      return { ok: true, out: '' };
    };
    const guard = () => ({ status: 'allow' as const, reasons: [], warnings: [{ code: 'hunk-overlap' as const, detail: 'x', prs: [7], files: ['src/a.ts'] }] });
    const result = makePrManager(run, guard).upsertPr(input);
    expect(result).toMatchObject({ ok: true, url: 'https://github.com/o/r/pull/92', reused: false });
    expect(calls.some(call => call[0] === 'gh' && call[1] === 'label' && call[2] === 'create' && call[3] === 'pr-guard:hunk-overlap')).toBe(true);
  });

  it('refuse 모드 줄 겹침은 옛 동작대로 PR 을 막는다', () => {
    const { run, calls } = stubRunner({ 'pr list': { ok: true, out: '' } });
    const inventory = { status: 'checked' as const, prs: [{ number: 7, title: 't', draft: false, updatedAt: '2026-10-17T00:00:00Z', headSha: 'a', labels: [], files: ['src/a.ts'], seat: null, cellId: null, hunks: [{ path: 'src/a.ts', start: 10, end: 20 }] }] };
    const guard = () => guardNewPr({ files: ['src/a.ts'], hunks: [{ path: 'src/a.ts', start: 15, end: 16 }], hunkOverlap: 'refuse' }, inventory);
    expect(makePrManager(run, guard).upsertPr(input)).toMatchObject({ ok: false, reason: 'guard', detail: expect.stringContaining('hunk-overlap') });
    expect(calls.some(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create')).toBe(false);
  });

  it('config prTool.hunkOverlap 은 refuse 만 옛 동작, 없거나 그 밖은 warn', () => {
    expect(configuredHunkOverlapMode({})).toBe('warn');
    expect(configuredHunkOverlapMode({ prTool: { hunkOverlap: 'refuse' } })).toBe('refuse');
    expect(configuredHunkOverlapMode({ prTool: { hunkOverlap: 'block' } })).toBe('warn');
  });

  it('열린 PR 조회 불가 세 번은 unmeasured 라벨로 진행하고 네 번째는 새 PR을 차단한다', () => {
    const { run, calls } = stubRunner({ 'pr list': { ok: true, out: '' }, 'pr create': { ok: true, out: 'https://github.com/o/r/pull/91' } });
    let count = 0;
    const guard = () => guardNewPr({ files: ['src/new.ts'], seat: 'UX' }, { status: 'unknown', reason: 'network' });
    const manager = makePrManager(run, guard, () => ({ count: ++count, blocked: count > 3 }));
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(manager.upsertPr({ ...input, seat: 'UX' })).toMatchObject({ ok: true });
    }
    const create = calls.find(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create');
      expect(create).toContain('pr-guard:unmeasured');
    expect(manager.upsertPr({ ...input, seat: 'UX' })).toMatchObject({ ok: false, reason: 'guard', detail: expect.stringContaining('차단') });
    expect(calls.filter(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create')).toHaveLength(3);
    expect(calls.some(call => call[0] === 'eln' && call[1] === 'msg' && call[2] === 'post')).toBe(true);
  });

  it('seat 미상인 네 번째 조회 실패도 HARNESS 신원으로 OP에 알린다', () => {
    const { run, calls } = stubRunner({ 'pr list': { ok: true, out: '' } });
    const guard = () => guardNewPr({ files: ['src/new.ts'] }, { status: 'unknown', reason: 'network' });
    const result = makePrManager(run, guard, () => ({ count: 4, blocked: true })).upsertPr(input);
    expect(result).toMatchObject({ ok: false, reason: 'guard' });
    const alert = calls.find(call => call[0] === 'eln' && call[1] === 'msg' && call[2] === 'post');
    expect(alert).toContain('HARNESS');
  });

  it('Pod의 로컬 원장·우편에는 미측정을 쓰지 않고 경고 라벨과 이벤트로 진행한다', () => {
    const before = process.env.ELANOUS_POD_NAME;
    process.env.ELANOUS_POD_NAME = 'test-pod';
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const { run, calls } = stubRunner({ 'pr list': { ok: true, out: '' }, 'pr create': { ok: true, out: 'https://github.com/o/r/pull/91' } });
      let recorded = 0;
      const guard = () => guardNewPr({ files: ['src/new.ts'] }, { status: 'unknown', reason: 'network' });
      const result = makePrManager(run, guard, () => { recorded += 1; return { count: 4, blocked: true }; }).upsertPr({ ...input, seat: 'UX' });
      expect(result).toMatchObject({ ok: true, reused: false });
      expect(recorded).toBe(0);
      expect(calls.find(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create')).toContain('pr-guard:unmeasured');
      expect(calls.some(call => call[0] === 'eln' && call[1] === 'msg')).toBe(false);
      expect(log).toHaveBeenCalledWith('pr-tool.open-guard', 'pod-unmeasured', expect.objectContaining({ seat: 'UX' }));
    } finally {
      log.mockRestore();
      if (before === undefined) delete process.env.ELANOUS_POD_NAME;
      else process.env.ELANOUS_POD_NAME = before;
    }
  });

  it('기존 PR 있으면 재사용(reused=true)·force-push·코멘트, 새로 안 만듦', () => {
    const { run, calls } = stubRunner({ 'pr list': { ok: true, out: 'https://github.com/o/r/pull/9' } });
    const r = makePrManager(run).upsertPr(input);
    expect(r).toEqual({ ok: true, url: 'https://github.com/o/r/pull/9', reused: true });
    const flat = calls.map((c) => c.join(' '));
    expect(flat.some((c) => c.includes('push --force'))).toBe(true); // force-push
    // 제목·본문·base 를 실제 인자 단위로 검증(Goodhart 회피 — '--body' 플래그 문자열이 body 값 'b' 를
    //   substring 으로 포함해 c.includes('b') 가 값과 무관히 통과하던 약한 단언 대체).
    const editCall = calls.find((c) => c[1] === 'pr' && c[2] === 'edit');
    expect(editCall).toEqual(['gh', 'pr', 'edit', 'https://github.com/o/r/pull/9', '--title', '[SE] x', '--body', 'b', '--base', 'main']);
    expect(flat.some((c) => c.includes('pr create'))).toBe(false); // 새로 안 만듦
    expect(flat.some((c) => c.includes('pr comment') && c.includes('재구현'))).toBe(true); // 재사용 코멘트
  });

  it('기존 PR 재사용은 호출자 seat 라벨로 소유를 바꾸지 않는다', () => {
    const { run, calls } = stubRunner({ 'pr list': { ok: true, out: 'https://github.com/o/r/pull/9' } });
    expect(makePrManager(run).upsertPr({ ...input, seat: 'UX' })).toMatchObject({ ok: true, reused: true });
    const edit = calls.find(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'edit');
    expect(edit).not.toContain('seat:UX');
    expect(calls.filter(call => call[0] === 'gh' && call[1] === 'label' && call[2] === 'create')).toHaveLength(0);
  });

  it('재사용 시 base·labels 반영 + draft=false 이고 현재 draft 면 ready 로 승격', () => {
    const { run, calls } = stubRunner({ 'pr list': { ok: true, out: 'https://github.com/o/r/pull/9' }, 'pr view': { ok: true, out: 'true' } });
    const r = makePrManager(run).upsertPr({ ...input, draft: false, labels: ['auto-review', '  ', 'x'] });
    expect(r).toEqual({ ok: true, url: 'https://github.com/o/r/pull/9', reused: true });
    const editCall = calls.find((c) => c[1] === 'pr' && c[2] === 'edit');
    // base + 각 비공백 라벨 --add-label 부착(무인 리뷰 진입 라벨 유지) — 공백 라벨은 드롭.
    expect(editCall).toEqual([
      'gh', 'pr', 'edit', 'https://github.com/o/r/pull/9', '--title', '[SE] x', '--body', 'b',
      '--base', 'main', '--add-label', 'auto-review', '--add-label', 'x',
    ]);
    // 현재 draft → ready 승격(--undo 없이).
    expect(calls.some((c) => c[1] === 'pr' && c[2] === 'ready' && c[3] === 'https://github.com/o/r/pull/9' && !c.includes('--undo'))).toBe(true);
  });

  it('재사용 시 이미 ready 면 draft=false 라도 ready 를 재실행하지 않는다(멱등)', () => {
    const { run, calls } = stubRunner({ 'pr list': { ok: true, out: 'https://github.com/o/r/pull/9' }, 'pr view': { ok: true, out: 'false' } });
    makePrManager(run).upsertPr({ ...input, draft: false });
    expect(calls.some((c) => c[1] === 'pr' && c[2] === 'ready')).toBe(false);
  });

  it('재사용 시 draft=true 이고 현재 ready 면 --undo 로 draft 로 되돌린다', () => {
    const { run, calls } = stubRunner({ 'pr list': { ok: true, out: 'https://github.com/o/r/pull/9' }, 'pr view': { ok: true, out: 'false' } });
    makePrManager(run).upsertPr({ ...input, draft: true });
    expect(calls.some((c) => c[1] === 'pr' && c[2] === 'ready' && c.includes('--undo'))).toBe(true);
  });

  it('재사용 시 draft 요청인데 isDraft 조회 실패/비정상 출력이면 fail-closed(계약 위반 방지)', () => {
    const fail = stubRunner({ 'pr list': { ok: true, out: 'https://github.com/o/r/pull/9' }, 'pr view': { ok: false, out: '' } });
    expect(makePrManager(fail.run).upsertPr({ ...input, draft: false }).ok).toBe(false);
    const garbage = stubRunner({ 'pr list': { ok: true, out: 'https://github.com/o/r/pull/9' }, 'pr view': { ok: true, out: 'maybe' } });
    expect(makePrManager(garbage.run).upsertPr({ ...input, draft: true }).ok).toBe(false);
  });

  it('기존 PR 없으면 새로 생성(reused=false)·base/draft/label 인자 전달', () => {
    const { run, calls } = stubRunner({ 'pr list': { ok: true, out: '' }, 'pr create': { ok: true, out: 'https://github.com/o/r/pull/10' } });
    const r = makePrManager(run).upsertPr({ ...input, draft: true, labels: ['auto-review', '  ', 'x'] });
    expect(r).toEqual({ ok: true, url: 'https://github.com/o/r/pull/10', reused: false, labelsApplied: true });
    const createCall = calls.find((c) => c[1] === 'pr' && c[2] === 'create');
    expect(createCall).toBeDefined();
    expect(createCall).toEqual([
      'gh', 'pr', 'create', '--head', 'se/apm-x-abc', '--title', '[SE] x', '--body', 'b',
      '--base', 'main', '--draft', '--label', 'auto-review', '--label', 'x', // 공백 라벨은 드롭
    ]);
    expect(calls.map((c) => c.join(' ')).some((c) => c.includes('pr create'))).toBe(true);
  });

  it('★ gitignored 제외 경로는 pathspec 에서 드롭(대표 2026-07-21·"ignored·use -f" exit1 방지)', () => {
    // check-ignore -q → ok(exit0)=gitignored → git add -A 가 자동 skip 하므로 :(exclude) 로 명시하지 않음
    //   (명시하면 git 이 "paths ignored … use -f" 로 exit 1 → add 실패 오판·705308 근본).
    const { run, calls } = stubRunner({ 'pr list': { ok: true, out: 'url/pull/1' }, 'check-ignore': { ok: true, out: '' } });
    makePrManager(run).upsertPr(input);
    const add = calls.find((c) => c.includes('add'));
    expect(add?.join(' ')).not.toContain(':(exclude)'); // gitignored 라 명시 제외 안 함(exit1 회피)
  });

  it('gitignore 안 된 제외 경로는 :(exclude) 로 실림', () => {
    // check-ignore -q → not-ok(exit1)=미ignored → git add -A 가 staging 하므로 명시 제외 필요.
    const { run, calls } = stubRunner({ 'pr list': { ok: true, out: 'url/pull/1' }, 'check-ignore': { ok: false, out: '' } });
    makePrManager(run).upsertPr(input);
    const add = calls.find((c) => c.includes('add'));
    expect(add?.join(' ')).toContain(':(exclude)node_modules');
    expect(add?.join(' ')).toContain(':(exclude)apps/pwa/out');
  });

  it('★ elanous 런타임 산출물은 호출부가 안 줘도 빠진다 — «남의 저장소» 누출 차단', () => {
    // 📏 2026-09-21: monad-agent 는 .gitignore 가 그 이름들을 가려서 이 경로가 «원리상» 안 보였고,
    //    빈 시험 저장소에서 돌리니 `.elanous-child-liveness.hb` 가 PR diff 에 들어갔다.
    //    그리고 리뷰어가 그것을 「실행 부산물」로 지적했고 자식은 «원리상» 못 지워 런이 버려졌다.
    const { run, calls } = stubRunner({
      'pr list': { ok: true, out: 'url/pull/1' },
      'check-ignore': { ok: false, out: '' },
      'ls-files --others': { ok: true, out: '.elanous-child-liveness.hb\0.elanous/state.json\0src/user.ts\0' },
    });
    makePrManager(run).upsertPr(input);
    const add = calls.find((c) => c.includes('add'));
    expect(add?.join(' ')).toContain(':(exclude,literal).elanous-child-liveness.hb');
    expect(add?.join(' ')).toContain(':(exclude,literal).elanous/state.json');
    // ⭐ 사용자 파일은 빼면 안 된다 — 벙어리 방지
    expect(add?.join(' ')).not.toContain('src/user.ts');
  });

  it('★ 경합으로 «새로 스테이징된» 런타임 산출물은 사후 조건으로 다시 내린다', () => {
    // ⛔ 사전 제외는 «스냅샷»이라 경합에 진다 — 그 파일은 5초마다 쓰인다.
    const { run, calls } = stubRunner({
      'pr list': { ok: true, out: 'url/pull/1' },
      'check-ignore': { ok: false, out: '' },
      'ls-files --others': { ok: true, out: '' },                        // ← 스냅샷 시점엔 «없다»
      'diff --cached': { ok: true, out: '.elanous-child-liveness.hb\0src/user.ts\0' },  // ← add 뒤엔 «있다»
    });
    makePrManager(run).upsertPr(input);
    const reset = calls.find((c) => c.includes('reset'));
    expect(reset?.join(' ')).toContain('.elanous-child-liveness.hb');
    expect(reset?.join(' ')).not.toContain('src/user.ts');   // ⭐ 사용자 파일은 안 내린다
  });

  it('commit 실패(진짜 오류) 시 reason=commit·detail(stderr)·push 안 함', () => {
    const { run, calls } = stubRunner({ 'commit': { ok: false, out: '', err: 'fatal: unable to write' } });
    const r = makePrManager(run).upsertPr(input);
    expect(r).toEqual({ ok: false, reason: 'commit', detail: 'fatal: unable to write' });
    expect(calls.map((c) => c.join(' ')).some((c) => c.includes('push'))).toBe(false);
  });

  // rev-list 를 '0' 으로 명시 스텁 — 실제 git 은 성공 시 **항상 숫자**를 출력한다. 종전엔 미스텁(빈 출력)
  //   상태를 `parseInt('') || 0` 이 조용히 0 으로 접어 통과했는데, 그 폴백이 폐기 경로의 구멍이라
  //   제거했다(리뷰 should-fix). "진짜 no-op" 의도는 그대로 유지된다.
  it('★ "nothing to commit" 은 실패 아닌 noop(이미 반영됨)·push 안 함', () => {
    const { run, calls } = stubRunner({ 'commit': { ok: false, out: 'nothing to commit, working tree clean' }, 'rev-list --count': { ok: true, out: '0' } });
    const r = makePrManager(run).upsertPr(input);
    expect(r).toEqual({ ok: false, reason: 'noop', detail: 'nothing to commit(이미 반영됨·no-op)' });
    expect(calls.map((c) => c.join(' ')).some((c) => c.includes('push'))).toBe(false);
  });

  it('★ untracked-only(nothing added to commit but untracked files present) 도 noop(대표 2026-07-21·617097 오분류 수정)', () => {
    const { run, calls } = stubRunner({ 'commit': { ok: false, out: 'On branch x\nUntracked files:\nnothing added to commit but untracked files present (use "git add" to track)' }, 'rev-list --count': { ok: true, out: '0' } });
    const r = makePrManager(run).upsertPr(input);
    expect(r).toEqual({ ok: false, reason: 'noop', detail: 'nothing to commit(이미 반영됨·no-op)' });
    expect(calls.map((c) => c.join(' ')).some((c) => c.includes('push'))).toBe(false);
  });

  it('★ "nothing to commit" 이지만 base 대비 앞선 커밋 존재(goal-loop 이 PR 전 이미 커밋) → noop 아님·push+PR 진행(대표 2026-07-26)', () => {
    // self-implement goal-loop 이 자기 산출을 이미 커밋 → PR 단계 재커밋이 "nothing to commit" →
    //   종전엔 noop 오판→"PR noop 실패"로 완성 산출을 버림. base 대비 앞선 커밋이 있으면 push+PR 로 전달해야.
    const { run, calls } = stubRunner({
      'commit': { ok: false, out: 'nothing to commit, working tree clean' },
      'rev-list --count': { ok: true, out: '2' },              // base 보다 2 커밋 앞섬
      'diff --name-only': { ok: true, out: 'src/x.ts\n' },     // 실제 내용차 존재(전달할 산출)
      'pr list': { ok: true, out: '' },           // 기존 PR 없음 → 생성
      'pr create': { ok: true, out: 'https://github.com/o/r/pull/42' },
    });
    const r = makePrManager(run).upsertPr(input);
    expect(r).toEqual({ ok: true, url: 'https://github.com/o/r/pull/42', reused: false });
    const flat = calls.map((c) => c.join(' '));
    expect(flat.some((c) => c.includes('rev-list --count main..HEAD'))).toBe(true); // ahead 판정
    expect(flat.some((c) => c.includes('push --force'))).toBe(true);                 // 이미 커밋된 산출 push
    expect(flat.some((c) => c.includes('pr create'))).toBe(true);                    // PR 생성
  });

  // ── base 해석 (2026-07-26 재발 근본 · PR #5471 실사고) ──────────────────────
  //   위 테스트들은 픽스처가 항상 base:'main' 을 넘겨서, **base 미지정 경로가 한 번도 커버되지 않았다.**
  //   그런데 `--base` 미지정이 기본값이라 실제로는 그 경로가 상시 경로였고, 판정이 즉시 noop 으로
  //   퇴화해 게이트·리뷰까지 통과한 완성 산출이 "PR noop 실패"로 버려졌다.
  it('★ base 미지정 + 이미 커밋된 산출 → origin/HEAD 로 해석해 push+PR 진행(종전엔 즉시 noop 오판)', () => {
    const { base: _drop, ...noBase } = input;
    const { run, calls } = stubRunner({
      'commit': { ok: false, out: 'nothing to commit, working tree clean' },
      'rev-parse --abbrev-ref origin/HEAD': { ok: true, out: 'origin/main' },
      'rev-list --count': { ok: true, out: '2' },
      'diff --name-only': { ok: true, out: 'src/x.ts\n' },
      'pr list': { ok: true, out: '' },
      'pr create': { ok: true, out: 'https://github.com/o/r/pull/77' },
    });
    const r = makePrManager(run).upsertPr(noBase);
    expect(r).toEqual({ ok: true, url: 'https://github.com/o/r/pull/77', reused: false });
    const flat = calls.map((c) => c.join(' '));
    expect(flat.some((c) => c.includes('rev-list --count origin/main..HEAD'))).toBe(true); // 해석된 base 로 판정
    expect(flat.some((c) => c.includes('push --force'))).toBe(true);
    expect(flat.some((c) => c.includes('pr create'))).toBe(true);
    expect(calls.filter((c) => c.join(' ') === 'git -C /wt rev-parse --abbrev-ref origin/HEAD')).toHaveLength(1);
    // ⭐ 리뷰 must-fix — 판정에 쓴 base 를 PR 개설에도 쓴다(비교 기준 ≠ PR 대상 모순 차단).
    //   gh 는 remote-tracking ref 를 모르므로 `origin/` 접두를 벗겨 넘긴다.
    const createCall = calls.find((c) => c[1] === 'pr' && c[2] === 'create');
    expect(createCall?.slice(createCall.indexOf('--base'), createCall.indexOf('--base') + 2)).toEqual(['--base', 'main']);
  });

  it('★ base 미지정 + origin/HEAD 미설정 → origin/main 후보로 폴백', () => {
    const { base: _drop, ...noBase } = input;
    const { run, calls } = stubRunner({
      'commit': { ok: false, out: 'nothing to commit, working tree clean' },
      'rev-parse --abbrev-ref origin/HEAD': { ok: false, out: '', err: 'ambiguous argument' },
      'rev-list --count': { ok: true, out: '1' },
      'diff --name-only': { ok: true, out: 'docs/a.md\n' },
      'pr list': { ok: true, out: '' },
      'pr create': { ok: true, out: 'https://github.com/o/r/pull/78' },
    });
    const r = makePrManager(run).upsertPr(noBase);
    expect(r.ok).toBe(true);
    const flat = calls.map((c) => c.join(' '));
    expect(flat.some((c) => c.includes('rev-parse --verify --quiet origin/main'))).toBe(true);
    expect(flat.some((c) => c.includes('rev-list --count origin/main..HEAD'))).toBe(true);
  });

  it('★ 앞선 커밋은 있지만 내용차 0(pre-pr-sync 병합 커밋만) → noop · 빈 PR 안 만든다', () => {
    const { run, calls } = stubRunner({
      'commit': { ok: false, out: 'nothing to commit, working tree clean' },
      'rev-list --count': { ok: true, out: '1' },        // 병합 커밋 1개로 ahead=1
      'diff --name-only': { ok: true, out: '   \n' },    // 그러나 전달할 내용차 없음
    });
    const r = makePrManager(run).upsertPr(input);
    expect(r).toEqual({ ok: false, reason: 'noop', detail: 'nothing to commit(이미 반영됨·no-op)' });
    expect(calls.map((c) => c.join(' ')).some((c) => c.includes('push'))).toBe(false);
  });

  // ⭐ 리뷰 must-fix(2026-07-26): `noop` 은 **안전한 판정이 아니다** — 호출부가 그 값을 보고 완성 산출을
  //   버린다. 그러므로 "판정 불가"(base 미해석·git 조회 실패)를 noop 으로 접으면 이 PR 이 고치려는
  //   폐기 버그가 다른 입구로 재발한다. 별도 실패(reason:'base')로 올려 원인이 관측에 남게 한다.
  it('★ diff 조회 실패(잘못된 ref 등) → noop 아님·reason=base 실패(폐기 금지·원인 노출)', () => {
    const { run, calls } = stubRunner({
      'commit': { ok: false, out: 'nothing to commit, working tree clean' },
      'rev-list --count': { ok: true, out: '2' },
      'diff --name-only': { ok: false, out: '', err: 'fatal: bad revision' },
    });
    const r = makePrManager(run).upsertPr(input);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: 'base' });
    expect((r as { detail: string }).detail).toContain('fatal: bad revision');
    expect(calls.map((c) => c.join(' ')).some((c) => c.includes('push'))).toBe(false);
  });

  it('★ rev-list 조회 실패 → noop 아님·reason=base 실패', () => {
    const { run } = stubRunner({
      'commit': { ok: false, out: 'nothing to commit, working tree clean' },
      'rev-list --count': { ok: false, out: '', err: 'fatal: ambiguous argument' },
    });
    const r = makePrManager(run).upsertPr(input);
    expect(r).toMatchObject({ ok: false, reason: 'base' });
  });

  it('★ base 를 하나도 해석 못함 + nothing to commit → noop 아님·reason=base(비표준 기본브랜치 리포 회귀 차단)', () => {
    const { base: _drop, ...noBase } = input;
    const { run, calls } = stubRunner({
      'commit': { ok: false, out: 'nothing to commit, working tree clean' },
      'rev-parse': { ok: false, out: '' }, // origin/HEAD·후보 전부 해석 실패
    });
    const r = makePrManager(run).upsertPr(noBase);
    expect(r).toMatchObject({ ok: false, reason: 'base' });
    expect((r as { detail: string }).detail).toContain('판정 불가');
    expect(calls.map((c) => c.join(' ')).some((c) => c.includes('push'))).toBe(false);
  });

  // ⭐ 리뷰 must-fix(2026-07-26·회귀 차단) — 추론한 base 를 **기존 PR 재사용** 경로에 넘기면 요청자가
  //   base 를 지정하지도 않았는데 `release/*` 대상 PR 이 main 으로 재타기팅된다. 미지정 = 건드리지 마라.
  it('★ base 미지정 + 기존 PR 재사용 → --base 를 넘기지 않는다(비기본 base PR 재타기팅 회귀 차단)', () => {
    const { base: _drop, ...noBase } = input;
    const { run, calls } = stubRunner({
      'rev-parse --abbrev-ref origin/HEAD': { ok: true, out: 'origin/main' },
      'pr list': { ok: true, out: 'https://github.com/o/r/pull/9' }, // release/1.x 대상으로 이미 열린 PR
      'commit': { ok: true, out: '1 file changed' },
    });
    const r = makePrManager(run).upsertPr(noBase);
    expect(r).toEqual({ ok: true, url: 'https://github.com/o/r/pull/9', reused: true });
    const editCall = calls.find((c) => c[1] === 'pr' && c[2] === 'edit');
    expect(editCall).toBeDefined();
    expect(editCall?.includes('--base')).toBe(false); // 기존 PR 의 base 보존
  });

  it('명시 base + 기존 PR 재사용 → 명시값은 그대로 --base 로 반영(의도된 재타기팅·공백 트림)', () => {
    const { run, calls } = stubRunner({ 'pr list': { ok: true, out: 'https://github.com/o/r/pull/9' } });
    makePrManager(run).upsertPr({ ...input, base: '  release/1.x  ' });
    const editCall = calls.find((c) => c[1] === 'pr' && c[2] === 'edit');
    expect(editCall?.slice(editCall.indexOf('--base'), editCall.indexOf('--base') + 2)).toEqual(['--base', 'release/1.x']);
  });

  it('명시 origin/main + 기존 PR 재사용 → gh edit에는 정규화한 main만 넘김', () => {
    const { run, calls } = stubRunner({ 'pr list': { ok: true, out: 'https://github.com/o/r/pull/9' } });
    makePrManager(run).upsertPr({ ...input, base: 'origin/main' });
    const editCall = calls.find((c) => c[1] === 'pr' && c[2] === 'edit');
    expect(editCall?.slice(editCall.indexOf('--base'), editCall.indexOf('--base') + 2)).toEqual(['--base', 'main']);
    expect(editCall).not.toContain('origin/main');
  });

  it('공백 전용 base + 기존 PR 재사용 → 미지정으로 보고 --base 안 넘김(리뷰 should-fix)', () => {
    const { run, calls } = stubRunner({
      'pr list': { ok: true, out: 'https://github.com/o/r/pull/9' },
      'rev-parse --abbrev-ref origin/HEAD': { ok: true, out: 'origin/main' },
      'commit': { ok: true, out: '1 file changed' },
    });
    makePrManager(run).upsertPr({ ...input, base: '   ' });
    const editCall = calls.find((c) => c[1] === 'pr' && c[2] === 'edit');
    expect(editCall?.includes('--base')).toBe(false);
  });

  it('★ rev-list 출력이 숫자가 아니면 noop 으로 접지 않고 reason=base(폐기 경로 재발 차단)', () => {
    const { run, calls } = stubRunner({
      'commit': { ok: false, out: 'nothing to commit, working tree clean' },
      'rev-list --count': { ok: true, out: 'warning: something\n' }, // exit 0 이지만 숫자 아님
    });
    const r = makePrManager(run).upsertPr(input);
    expect(r).toMatchObject({ ok: false, reason: 'base' });
    expect((r as { detail: string }).detail).toContain('출력 이상');
    expect(calls.map((c) => c.join(' ')).some((c) => c.includes('push'))).toBe(false);
  });

  it('★ base 미해석이어도 **정상 커밋** 경로는 그대로 PR 개설(무회귀 — 판정이 필요 없는 경로)', () => {
    const { base: _drop, ...noBase } = input;
    const { run, calls } = stubRunner({
      'rev-parse': { ok: false, out: '' },  // base 해석 실패
      'commit': { ok: true, out: '1 file changed' }, // 그러나 실제 커밋할 변경이 있었다
      'pr list': { ok: true, out: '' },
      'pr create': { ok: true, out: 'https://github.com/o/r/pull/91' },
    });
    const r = makePrManager(run).upsertPr(noBase);
    expect(r).toEqual({ ok: true, url: 'https://github.com/o/r/pull/91', reused: false });
    // base 를 못 구했으면 --base 를 붙이지 않는다(gh 기본 브랜치 위임 — 종전 거동).
    const createCall = calls.find((c) => c[1] === 'pr' && c[2] === 'create');
    expect(createCall?.includes('--base')).toBe(false);
  });

  it('★ "nothing to commit" + base 대비 앞선 커밋 0 → 여전히 noop(진짜 no-op·push 안 함)', () => {
    const { run, calls } = stubRunner({
      'commit': { ok: false, out: 'nothing to commit, working tree clean' },
      'rev-list --count': { ok: true, out: '0' },
    });
    const r = makePrManager(run).upsertPr(input);
    expect(r).toEqual({ ok: false, reason: 'noop', detail: 'nothing to commit(이미 반영됨·no-op)' });
    expect(calls.map((c) => c.join(' ')).some((c) => c.includes('push'))).toBe(false);
  });

  // ⚠️ **의도적 반전(2026-07-26)** — 종전 이 테스트는 rev-list 실패를 "판정불가라 **안전** noop 폴백"으로
  //   고정했다(직전 리뷰 should-fix). 그 전제가 틀렸다: `noop` 은 호출부가 **완성 산출을 버리는** 판정이라
  //   (`seams.ts` openPr 이 throw) "안전"이 아니다. push 를 막는 것과 산출을 폐기하는 것은 다른 일인데
  //   한 값에 뭉쳐 있었다. 이제 판정불가는 `reason:'base'` 로 올린다 — **push 는 여전히 안 하고**(보수)
  //   실패 사유가 관측에 남아 triage 가 원인을 읽는다. noop 은 "진짜 산출 없음"에만 쓴다.
  it('★ "nothing to commit" + rev-list 실패(로컬 base ref 없음/오래됨) → push 안 함 + reason=base(noop 으로 뭉개지 않음)', () => {
    const { run, calls } = stubRunner({
      'commit': { ok: false, out: 'nothing to commit, working tree clean' },
      'rev-list --count': { ok: false, out: '', err: "fatal: bad revision 'main..HEAD'" },
    });
    const r = makePrManager(run).upsertPr(input);
    expect(r).toMatchObject({ ok: false, reason: 'base' });
    expect((r as { detail: string }).detail).toContain('bad revision');
    expect(calls.map((c) => c.join(' ')).some((c) => c.includes('push'))).toBe(false); // 보수성 유지
  });

  it('★ 인수 발사: base=작업 브랜치 자신 + origin에 없는 산출 → 원격 추적 ref로 판정해 push+기본 base PR 생성', () => {
    const inherited = { ...input, base: 'refs/heads/se/apm-x-abc' };
    const { run, calls } = stubRunner({
      'rev-parse --abbrev-ref se/apm-x-abc@{upstream}': { ok: true, out: 'origin/se/apm-x-abc\n' },
      'rev-parse --abbrev-ref origin/HEAD': { ok: true, out: 'origin/main\n' },
      'commit': { ok: false, out: 'nothing to commit, working tree clean' },
      'rev-list --count origin/se/apm-x-abc..HEAD': { ok: true, out: '1' },
      'diff --name-only origin/se/apm-x-abc..HEAD': { ok: true, out: 'src/x.ts\n' },
      'pr list': { ok: true, out: '' },
      'pr create': { ok: true, out: 'https://github.com/o/r/pull/92' },
    });
    expect(makePrManager(run).upsertPr(inherited)).toEqual({ ok: true, url: 'https://github.com/o/r/pull/92', reused: false });
    expect(calls).toContainEqual(['git', '-C', '/wt', 'rev-list', '--count', 'origin/se/apm-x-abc..HEAD']);
    expect(calls).toContainEqual(['git', '-C', '/wt', 'push', '--force', '-u', 'origin', 'se/apm-x-abc']);
    expect(calls.find((c) => c[1] === 'pr' && c[2] === 'create')).toEqual([
      'gh', 'pr', 'create', '--head', 'se/apm-x-abc', '--title', '[SE] x', '--body', 'b', '--base', 'main',
    ]);
    // self-base만 upstream 비교와 기본 PR base 해석을 추가한다.
    expect(calls.filter((c) => c.join(' ') === 'git -C /wt rev-parse --abbrev-ref origin/HEAD')).toHaveLength(1);
  });

  it('★ 인수 발사: base=작업 브랜치 자신 + origin과 동일 → 정직하게 noop', () => {
    const { run, calls } = stubRunner({
      'rev-parse --abbrev-ref se/apm-x-abc@{upstream}': { ok: true, out: 'origin/se/apm-x-abc\n' },
      'commit': { ok: false, out: 'nothing to commit, working tree clean' },
      'rev-list --count origin/se/apm-x-abc..HEAD': { ok: true, out: '0' },
      'diff --name-only origin/se/apm-x-abc..HEAD': { ok: true, out: '' },
    });
    expect(makePrManager(run).upsertPr({ ...input, base: 'se/apm-x-abc' })).toMatchObject({ ok: false, reason: 'noop' });
    expect(calls.some((c) => c.includes('push'))).toBe(false);
  });

  it('★ 인수 발사: 원격 추적 ref 없는 새 브랜치 → noop 대신 reason=base', () => {
    const { run, calls } = stubRunner({
      'rev-parse --abbrev-ref se/apm-x-abc@{upstream}': { ok: false, out: '', err: 'fatal: no upstream configured' },
      'commit': { ok: false, out: 'nothing to commit, working tree clean' },
    });
    expect(makePrManager(run).upsertPr({ ...input, base: 'origin/se/apm-x-abc' })).toMatchObject({ ok: false, reason: 'base' });
    expect(calls.some((c) => c.includes('push'))).toBe(false);
  });

  it('★ 인수 발사: 기존 PR이면 자기 브랜치를 --base로 쓰지 않고 push로 갱신한다', () => {
    const { run, calls } = stubRunner({
      'rev-parse --abbrev-ref se/apm-x-abc@{upstream}': { ok: true, out: 'origin/se/apm-x-abc\n' },
      'commit': { ok: false, out: 'nothing to commit, working tree clean' },
      'rev-list --count origin/se/apm-x-abc..HEAD': { ok: true, out: '1' },
      'diff --name-only origin/se/apm-x-abc..HEAD': { ok: true, out: 'src/x.ts\n' },
      'pr list': { ok: true, out: 'https://github.com/o/r/pull/93' },
    });
    expect(makePrManager(run).upsertPr({ ...input, base: 'origin/se/apm-x-abc' })).toEqual({ ok: true, url: 'https://github.com/o/r/pull/93', reused: true });
    const edit = calls.find((c) => c[1] === 'pr' && c[2] === 'edit');
    expect(edit?.includes('--base')).toBe(false);
    expect(calls.some((c) => c[1] === 'pr' && c[2] === 'create')).toBe(false);
  });

  it('git write lock은 재시도 성공 시도 번호를 기존 카테고리에 남긴다', () => {
    let addAttempts = 0;
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const run: CmdRunner = (cmd, args) => {
      if (cmd === 'git' && args.includes('add')) {
        addAttempts++;
        return addAttempts < 3
          ? { ok: false, out: '', err: "fatal: Unable to create '/repo/.git/index.lock': File exists" }
          : { ok: true, out: '' };
      }
      if (cmd === 'gh' && args.includes('list')) return { ok: true, out: 'https://github.com/o/r/pull/9' };
      return { ok: true, out: '' };
    };
    try {
      expect(makePrManager(run).upsertPr(input)).toMatchObject({ ok: true, reused: true });
      expect(addAttempts).toBe(3);
      expect(log).toHaveBeenCalledWith('autopilot.pr-manager', 'git-write.retry-succeeded', {
        attempt: 3,
        args: ['-C', '/wt', 'add', '-A', '--'],
      });
    } finally {
      log.mockRestore();
    }
  });

  it('비일시 git write 실패는 재시도하지 않고 마지막 일시 실패는 그대로 돌려준다', () => {
    let nonTransientAttempts = 0;
    const nonTransient: CmdRunner = (cmd, args) => {
      if (cmd === 'git' && args.includes('add')) {
        nonTransientAttempts++;
        return { ok: false, out: '', err: 'fatal: invalid pathspec' };
      }
      return { ok: true, out: '' };
    };
    expect(makePrManager(nonTransient).upsertPr(input)).toEqual({ ok: false, reason: 'add', detail: 'fatal: invalid pathspec' });
    expect(nonTransientAttempts).toBe(1);

    let transientAttempts = 0;
    const transient: CmdRunner = (cmd, args) => {
      if (cmd === 'git' && args.includes('add')) {
        transientAttempts++;
        return { ok: false, out: '', err: 'fatal: could not lock index' };
      }
      return { ok: true, out: '' };
    };
    expect(makePrManager(transient).upsertPr(input)).toEqual({ ok: false, reason: 'add', detail: 'fatal: could not lock index' });
    expect(transientAttempts).toBe(6);
  });

  it('첫 git write 성공은 한 번만 실행되고 retry 관측을 남기지 않는다', () => {
    const { run, calls } = stubRunner({ 'pr list': { ok: true, out: 'https://github.com/o/r/pull/9' } });
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(makePrManager(run).upsertPr(input)).toMatchObject({ ok: true, reused: true });
      expect(calls.filter((call) => call[0] === 'git' && call.includes('add'))).toHaveLength(1);
      expect(log.mock.calls.some(([, event]) => event === 'git-write.retry-succeeded')).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  it('push 실패 시 reason=push·detail(stderr)', () => {
    const { run } = stubRunner({ 'push': { ok: false, out: '', err: 'remote: rejected' } });
    expect(makePrManager(run).upsertPr(input)).toEqual({ ok: false, reason: 'push', detail: 'remote: rejected' });
  });

  it('ok=false/rc=0 명령 실패는 push 성공으로 뒤집히지 않고 실제 rc=0을 incident에 남긴다', () => {
    const { run } = stubRunner({ 'push --force': { ok: false, out: '', err: 'output exceeded 256MiB (ENOBUFS)', rc: 0 } });
    const r = makePrManager(run).upsertPr({ ...input, runId: 'run-buffer-overflow' });
    expect(r).toMatchObject({ ok: false, reason: 'push', incident: { push: { ran: true, ok: false, rc: 0 }, gh: { ran: false } } });
  });
  it('push 가 처음 두 번은 remote: Internal Server Error 로 실패하고 세 번째에 성공하면 ok 이고 push 는 3번', () => {
    const pushResults: CmdResult[] = [
      { ok: false, out: '', err: 'remote: Internal Server Error' },
      { ok: false, out: '', err: 'remote: Internal Server Error' },
      { ok: true, out: '', err: '' },
    ];
    let pushCalls = 0;
    const waits: number[] = [];
    const run: CmdRunner = (cmd, args) => {
      const key = [cmd, ...args].join(' ');
      if (key.includes('push')) {
        pushCalls += 1;
        return pushResults.shift() ?? { ok: false, out: '', err: 'unexpected extra push' };
      }
      if (key.includes('pr list')) return { ok: true, out: 'https://github.com/o/r/pull/9' };
      return { ok: true, out: '' };
    };
    const r = makePrManager(run).upsertPr({
      ...input,
      waitForPushRetry: (attempt) => { waits.push(attempt); },
    });
    expect(r).toEqual({ ok: true, url: 'https://github.com/o/r/pull/9', reused: true });
    expect(pushCalls).toBe(3);
    expect(waits).toEqual([1, 2]);
  });
  it('push 가 non-fast-forward 로 실패하면 push 는 1번만 호출되고 reason 은 push', () => {
    let pushCalls = 0;
    let waits = 0;
    const run: CmdRunner = (cmd, args) => {
      const key = [cmd, ...args].join(' ');
      if (key.includes('push')) {
        pushCalls += 1;
        return { ok: false, out: '', err: '! [rejected] se/apm-x-abc -> se/apm-x-abc (non-fast-forward)' };
      }
      return { ok: true, out: '' };
    };
    const r = makePrManager(run).upsertPr({
      ...input,
      waitForPushRetry: () => { waits += 1; },
    });
    expect(r).toEqual({
      ok: false,
      reason: 'push',
      detail: '! [rejected] se/apm-x-abc -> se/apm-x-abc (non-fast-forward)',
    });
    expect(pushCalls).toBe(1);
    expect(waits).toBe(0);
  });

  it('gh pr create 실패 시 reason=gh', () => {
    const { run, calls } = stubRunner({ 'pr list': { ok: true, out: '' }, 'pr create': { ok: false, out: '', err: 'gh: auth' } });
    expect(makePrManager(run).upsertPr(input)).toEqual({ ok: false, reason: 'gh', detail: 'gh: auth' });
    expect(calls.filter((c) => c[1] === 'pr' && c[2] === 'create')).toHaveLength(1);
  });

  it('라벨 없는 호출은 성공 메타데이터 없이 종전 형태를 유지한다', () => {
    const { run, calls } = stubRunner({ 'pr list': { ok: true, out: '' }, 'pr create': { ok: true, out: 'https://github.com/o/r/pull/10' } });
    const r = makePrManager(run).upsertPr(input);
    expect(r).toEqual({ ok: true, url: 'https://github.com/o/r/pull/10', reused: false });
    const createCall = calls.find((c) => c[1] === 'pr' && c[2] === 'create');
    expect(createCall?.includes('--label')).toBe(false);
  });

  it('라벨 부재로 생성이 실패하면 라벨 없이 한 번 더 만들고 labelsOmitted 로 성공을 가른다', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const { run, calls } = sequentialStubRunner({
        'pr list': { ok: true, out: '' },
        'pr create': [
          { ok: false, out: '', err: "could not add label: 'auto-review' not found" },
          { ok: true, out: 'https://github.com/o/r/pull/11' },
        ],
      });
      const r = makePrManager(run).upsertPr({ ...input, labels: ['auto-review'] });
      expect(r).toEqual({ ok: true, url: 'https://github.com/o/r/pull/11', reused: false, labelsOmitted: true });
      const createCalls = calls.filter((c) => c[1] === 'pr' && c[2] === 'create');
      expect(createCalls).toHaveLength(2);
      expect(createCalls[0]).toEqual([
        'gh', 'pr', 'create', '--head', 'se/apm-x-abc', '--title', '[SE] x', '--body', 'b',
        '--base', 'main', '--label', 'auto-review',
      ]);
      expect(createCalls[1]).toEqual([
        'gh', 'pr', 'create', '--head', 'se/apm-x-abc', '--title', '[SE] x', '--body', 'b',
        '--base', 'main',
      ]);
      expect(log).toHaveBeenCalledWith('autopilot.pr-manager', 'create.labels-omitted', {
        branch: 'se/apm-x-abc',
        labels: ['auto-review'],
        detail: "could not add label: 'auto-review' not found",
        url: 'https://github.com/o/r/pull/11',
      });
    } finally {
      log.mockRestore();
    }
  });

  it("접두 문구 없이 'auto-review' not found 만 있어도 라벨 없이 한 번 더 만들고 labelsOmitted 로 성공을 가른다", () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const { run, calls } = sequentialStubRunner({
        'pr list': { ok: true, out: '' },
        'pr create': [
          { ok: false, out: '', err: "'auto-review' not found" },
          { ok: true, out: 'https://github.com/o/r/pull/16' },
        ],
      });
      const r = makePrManager(run).upsertPr({ ...input, labels: ['auto-review'] });
      expect(r).toEqual({ ok: true, url: 'https://github.com/o/r/pull/16', reused: false, labelsOmitted: true });
      const createCalls = calls.filter((c) => c[1] === 'pr' && c[2] === 'create');
      expect(createCalls).toHaveLength(2);
      expect(createCalls[0]).toEqual([
        'gh', 'pr', 'create', '--head', 'se/apm-x-abc', '--title', '[SE] x', '--body', 'b',
        '--base', 'main', '--label', 'auto-review',
      ]);
      expect(createCalls[1]).toEqual([
        'gh', 'pr', 'create', '--head', 'se/apm-x-abc', '--title', '[SE] x', '--body', 'b',
        '--base', 'main',
      ]);
      expect(log).toHaveBeenCalledWith('autopilot.pr-manager', 'create.labels-omitted', {
        branch: 'se/apm-x-abc',
        labels: ['auto-review'],
        detail: "'auto-review' not found",
        url: 'https://github.com/o/r/pull/16',
      });
    } finally {
      log.mockRestore();
    }
  });

  it("요청하지 않은 이름의 'some-other-thing' not found 는 재시도하지 않고 실패로 남긴다", () => {
    const { run, calls } = sequentialStubRunner({
      'pr list': { ok: true, out: '' },
      'pr create': [
        { ok: false, out: '', err: "'some-other-thing' not found" },
        { ok: true, out: 'https://github.com/o/r/pull/17' },
      ],
    });
    const r = makePrManager(run).upsertPr({ ...input, labels: ['auto-review'] });
    expect(r).toEqual({ ok: false, reason: 'gh', detail: "'some-other-thing' not found" });
    expect(calls.filter((c) => c[1] === 'pr' && c[2] === 'create')).toHaveLength(1);
  });

  it("작은따옴표가 있는 라벨명(won't-fix) 부재도 한 행이면 라벨 없이 한 번 더 만든다", () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const { run, calls } = sequentialStubRunner({
        'pr list': { ok: true, out: '' },
        'pr create': [
          { ok: false, out: '', err: "could not add label: 'won't-fix' not found" },
          { ok: true, out: 'https://github.com/o/r/pull/15' },
        ],
      });
      const r = makePrManager(run).upsertPr({ ...input, labels: ["won't-fix"] });
      expect(r).toEqual({ ok: true, url: 'https://github.com/o/r/pull/15', reused: false, labelsOmitted: true });
      const createCalls = calls.filter((c) => c[1] === 'pr' && c[2] === 'create');
      expect(createCalls).toHaveLength(2);
      expect(createCalls[0]).toEqual([
        'gh', 'pr', 'create', '--head', 'se/apm-x-abc', '--title', '[SE] x', '--body', 'b',
        '--base', 'main', '--label', "won't-fix",
      ]);
      expect(createCalls[1]).toEqual([
        'gh', 'pr', 'create', '--head', 'se/apm-x-abc', '--title', '[SE] x', '--body', 'b',
        '--base', 'main',
      ]);
      expect(log).toHaveBeenCalledWith('autopilot.pr-manager', 'create.labels-omitted', {
        branch: 'se/apm-x-abc',
        labels: ["won't-fix"],
        detail: "could not add label: 'won't-fix' not found",
        url: 'https://github.com/o/r/pull/15',
      });
    } finally {
      log.mockRestore();
    }
  });

  it('라벨과 무관한 생성 실패는 재시도하지 않고 실패로 남긴다', () => {
    const { run, calls } = stubRunner({
      'pr list': { ok: true, out: '' },
      'pr create': { ok: false, out: '', err: 'gh: auth' },
    });
    const r = makePrManager(run).upsertPr({ ...input, labels: ['auto-review'] });
    expect(r).toEqual({ ok: false, reason: 'gh', detail: 'gh: auth' });
    expect(calls.filter((c) => c[1] === 'pr' && c[2] === 'create')).toHaveLength(1);
  });

  it('could not add label 권한 오류와 별도 repository not found 가 함께 있어도 재시도하지 않는다', () => {
    const err = "could not add label: permission denied\nrepository not found";
    const { run, calls } = sequentialStubRunner({
      'pr list': { ok: true, out: '' },
      'pr create': [
        { ok: false, out: '', err },
        { ok: true, out: 'https://github.com/o/r/pull/12' },
      ],
    });
    const r = makePrManager(run).upsertPr({ ...input, labels: ['auto-review'] });
    expect(r).toEqual({ ok: false, reason: 'gh', detail: err });
    expect(calls.filter((c) => c[1] === 'pr' && c[2] === 'create')).toHaveLength(1);
  });

  it('한 스트림의 교차 행 could not add label / not found 는 라벨 부재로 보지 않는다', () => {
    const err = "could not add label:\n'auto-review' not found";
    const { run, calls } = sequentialStubRunner({
      'pr list': { ok: true, out: '' },
      'pr create': [
        { ok: false, out: '', err },
        { ok: true, out: 'https://github.com/o/r/pull/13' },
      ],
    });
    const r = makePrManager(run).upsertPr({ ...input, labels: ['auto-review'] });
    expect(r).toEqual({ ok: false, reason: 'gh', detail: err });
    expect(calls.filter((c) => c[1] === 'pr' && c[2] === 'create')).toHaveLength(1);
  });

  it('stderr/stdout 에 나뉜 could not add label / not found 조각은 라벨 부재로 보지 않는다', () => {
    const { run, calls } = sequentialStubRunner({
      'pr list': { ok: true, out: '' },
      'pr create': [
        { ok: false, out: "'auto-review' not found", err: 'could not add label:' },
        { ok: true, out: 'https://github.com/o/r/pull/14' },
      ],
    });
    const r = makePrManager(run).upsertPr({ ...input, labels: ['auto-review'] });
    expect(r).toEqual({ ok: false, reason: 'gh', detail: 'could not add label:' });
    expect(calls.filter((c) => c[1] === 'pr' && c[2] === 'create')).toHaveLength(1);
  });

  it('기존 PR 재사용 경로의 --add-label 실패는 생성 재시도로 바꾸지 않는다', () => {
    const { run, calls } = stubRunner({
      'pr list': { ok: true, out: 'https://github.com/o/r/pull/9' },
      'pr edit': { ok: false, out: '', err: "could not add label: 'auto-review' not found" },
    });
    const r = makePrManager(run).upsertPr({ ...input, labels: ['auto-review'] });
    expect(r).toEqual({ ok: false, reason: 'gh', detail: "could not add label: 'auto-review' not found" });
    expect(calls.some((c) => c[1] === 'pr' && c[2] === 'create')).toBe(false);
    expect(calls.find((c) => c[1] === 'pr' && c[2] === 'edit')).toEqual([
      'gh', 'pr', 'edit', 'https://github.com/o/r/pull/9', '--title', '[SE] x', '--body', 'b',
      '--base', 'main', '--add-label', 'auto-review',
    ]);
  });
});

describe('makePrManager.closePr / mergePr', () => {
  it('closePr — gh pr close --delete-branch', () => {
    const { run, calls } = stubRunner();
    expect(makePrManager(run).closePr('https://github.com/o/r/pull/5')).toBe(true);
    expect(calls[0]!.join(' ')).toBe('gh pr close 5 --delete-branch');
  });
  it('mergePr — gh pr merge --squash 뒤 fork 원격 head만 삭제한다', () => {
    const { run, calls } = stubRunner({
      'pr view 7 --json headRefName,headRepository': { ok: true, out: '{"headRefName":"feat/land","headRepository":{"nameWithOwner":"fork-owner/fork-repo"}}' },
    });
    expect(makePrManager(run).mergePr('https://github.com/o/r/pull/7')).toBe(true);
    expect(calls.map((call) => call.join(' '))).toEqual([
      'gh pr merge 7 --squash',
      'gh pr view 7 --json headRefName,headRepository',
      'gh api --method DELETE repos/fork-owner/fork-repo/git/refs/heads/feat%2Fland',
    ]);
    expect(calls.map((call) => call.join(' '))).not.toContain('gh api --method DELETE repos/{owner}/{repo}/git/refs/heads/feat%2Fland');
  });
  it('원격 head 삭제는 #와 %가 있는 ref를 안전하게 인코딩한다', () => {
    const { run, calls } = stubRunner({
      'pr view 7 --json headRefName,headRepository': { ok: true, out: '{"headRefName":"feature/a#b%c","headRepository":{"nameWithOwner":"fork-owner/fork-repo"}}' },
    });
    expect(makePrManager(run).mergePrOutcome('https://github.com/o/r/pull/7')).toEqual({ ok: true, kind: 'merge-exit-0' });
    expect(calls.map((call) => call.join(' '))).toContain('gh api --method DELETE repos/fork-owner/fork-repo/git/refs/heads/feature%2Fa%23b%25c');
  });
  it('원격 head 삭제 실패는 병합 성공 outcome에 비치명 상세로 남긴다', () => {
    const { run } = stubRunner({
      'pr view 7 --json headRefName,headRepository': { ok: true, out: '{"headRefName":"feat/land","headRepository":{"nameWithOwner":"fork-owner/fork-repo"}}' },
      'api --method DELETE': { ok: false, out: '', err: 'forbidden' },
    });
    expect(makePrManager(run).mergePrOutcome('https://github.com/o/r/pull/7')).toEqual({
      ok: true,
      kind: 'merge-exit-0',
      remoteBranchDeletion: { detail: 'forbidden' },
    });
  });
  it('merge exit 비영이어도 injected runner state가 MERGED면 성공으로 확인한다', () => {
    const { run, calls } = stubRunner({
      'pr merge': { ok: false, out: '', err: 'branch deletion failed' },
      'pr view 7 --json state': { ok: true, out: '{"state":"MERGED"}' },
    });
    const manager = makePrManager(run);
    expect(manager.mergePr('https://github.com/o/r/pull/7')).toBe(true);
    expect(manager.mergePrOutcome('https://github.com/o/r/pull/7')).toMatchObject({ ok: true, kind: 'merged-after-nonzero' });
    expect(calls.map((call) => call.join(' '))).toContain('gh pr view 7 --json state');
  });
  it('merge exit 비영과 state read 실패 및 미머지를 구분한다', () => {
    const unreadable = makePrManager(stubRunner({ 'pr merge': { ok: false, out: '' }, 'pr view': { ok: false, out: '', err: 'network' } }).run);
    const unmerged = makePrManager(stubRunner({ 'pr merge': { ok: false, out: '' }, 'pr view': { ok: true, out: '{"state":"OPEN"}' } }).run);
    expect(unreadable.mergePrOutcome('https://github.com/o/r/pull/7')).toEqual({ ok: false, kind: 'state-read-failed' });
    expect(unmerged.mergePrOutcome('https://github.com/o/r/pull/7')).toEqual({ ok: false, kind: 'not-merged', state: 'OPEN' });
  });
  it('merge exit 0 성공 경로는 원격 head 삭제 후 merge-exit-0 이다', () => {
    const { run, calls } = stubRunner({
      'pr view 7 --json headRefName,headRepository': { ok: true, out: '{"headRefName":"feat/land","headRepository":{"nameWithOwner":"owner/repo"}}' },
    });
    expect(makePrManager(run).mergePrOutcome('https://github.com/o/r/pull/7')).toEqual({ ok: true, kind: 'merge-exit-0' });
    expect(calls.map((call) => call.join(' '))).toEqual([
      'gh pr merge 7 --squash',
      'gh pr view 7 --json headRefName,headRepository',
      'gh api --method DELETE repos/owner/repo/git/refs/heads/feat%2Fland',
    ]);
  });
  it('merge exit 비영 후 첫 조회가 MERGED면 재확인 없이 병합이다', () => {
    const { run, calls } = sequentialStubRunner({
      'pr merge': { ok: false, out: '', err: 'GraphQL' },
      'pr view': { ok: true, out: '{"state":"MERGED"}' },
    });
    expect(makePrManager(run).mergePrOutcome('https://github.com/o/r/pull/7')).toMatchObject({ ok: true, kind: 'merged-after-nonzero' });
    expect(viewCalls(calls)).toHaveLength(1);
  });
  it('merge exit 비영 후 상태 조회가 여러 번 병합 아니면 확정된 미병합이다', () => {
    const { run, calls } = sequentialStubRunner({
      'pr merge': { ok: false, out: '' },
      'pr view': [
        { ok: true, out: '{"state":"OPEN"}' },
        { ok: true, out: '{"state":"OPEN"}' },
      ],
    });
    expect(makePrManager(run).mergePrOutcome('https://github.com/o/r/pull/7')).toEqual({ ok: false, kind: 'not-merged', state: 'OPEN' });
    expect(viewCalls(calls).length).toBeGreaterThan(1);
  });
  it('merge exit 비영 후 첫 조회가 병합 아니고 이어지는 조회가 MERGED면 병합이다', () => {
    const { run, calls } = sequentialStubRunner({
      'pr merge': { ok: false, out: '' },
      'pr view': [
        { ok: true, out: '{"state":"OPEN"}' },
        { ok: true, out: '{"state":"MERGED"}' },
      ],
    });
    expect(makePrManager(run).mergePrOutcome('https://github.com/o/r/pull/7')).toMatchObject({ ok: true, kind: 'merged-after-nonzero' });
    expect(viewCalls(calls)).toHaveLength(2);
  });
  it('merge exit 비영 후 조회가 확정에 못 미치면 미병합이 아니라 unknown 이다', () => {
    const { run, calls } = sequentialStubRunner({
      'pr merge': { ok: false, out: '' },
      'pr view': [
        { ok: true, out: '{"state":"OPEN"}' },
        { ok: false, out: '', err: 'network' },
      ],
    });
    expect(makePrManager(run).mergePrOutcome('https://github.com/o/r/pull/7')).toEqual({ ok: false, kind: 'unknown' });
    expect(viewCalls(calls)).toHaveLength(2);
  });
  it('PR URL 아니면 false', () => {
    expect(makePrManager(stubRunner().run).closePr('bad')).toBe(false);
  });
});

describe('defaultCmdRunner — Pod GitHub credential relay', () => {
  it('refreshes before gh, caches until within ten minutes of expiry, and leaves other commands alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-manager-relay-'));
    const saved = {
      path: process.env.PATH,
      gh: process.env.GH_TOKEN,
      url: process.env[POD_GITHUB_CREDENTIAL_URL_ENV],
      bearer: process.env[POD_GITHUB_CREDENTIAL_TOKEN_ENV],
    };
    const now = Date.now();
    let clock = now;
    const time = spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      writeFileSync(join(dir, 'gh'), '#!/bin/sh\nprintf "%s" "$GH_TOKEN"\n');
      writeFileSync(join(dir, 'curl'), `#!/bin/sh\ncat > ${JSON.stringify(join(dir, 'authorization'))}\nprintf '%s\\n' "$*" >> ${JSON.stringify(join(dir, 'requests'))}\ncat ${JSON.stringify(join(dir, 'response'))}\n`);
      chmodSync(join(dir, 'gh'), 0o755);
      chmodSync(join(dir, 'curl'), 0o755);
      process.env.PATH = `${dir}:${saved.path ?? ''}`;
      process.env.GH_TOKEN = 'original-token';
      process.env[POD_GITHUB_CREDENTIAL_URL_ENV] = 'http://relay.local/v1/pod/credential/github';
      process.env[POD_GITHUB_CREDENTIAL_TOKEN_ENV] = 'run-bearer';
      writeFileSync(join(dir, 'response'), JSON.stringify({ token: 'new-token', expires_at: new Date(now + 3_600_000).toISOString() }));
      expect(defaultCmdRunner('gh', ['auth', 'status'])).toMatchObject({ ok: true, out: 'new-token' });
      writeFileSync(join(dir, 'response'), JSON.stringify({ token: 'renewed-token', expires_at: new Date(now + 7_200_000).toISOString() }));
      expect(defaultCmdRunner('gh', ['pr', 'list'])).toMatchObject({ ok: true, out: 'new-token' });
      expect(readFileSync(join(dir, 'requests'), 'utf8').trim().split('\n')).toHaveLength(1);
      expect(readFileSync(join(dir, 'requests'), 'utf8')).toContain('--request POST --header @- http://relay.local/v1/pod/credential/github');
      expect(readFileSync(join(dir, 'authorization'), 'utf8')).toBe('Authorization: Bearer run-bearer\n');
      expect(readFileSync(join(dir, 'requests'), 'utf8')).not.toContain('run-bearer');
      clock = now + 3_000_000; // exactly ten minutes remain
      expect(defaultCmdRunner('gh', ['pr', 'view'])).toMatchObject({ ok: true, out: 'renewed-token' });
      expect(defaultCmdRunner('gh', ['pr', 'list'])).toMatchObject({ ok: true, out: 'renewed-token' });
      expect(readFileSync(join(dir, 'requests'), 'utf8').trim().split('\n')).toHaveLength(2);
      expect(defaultCmdRunner(process.execPath, ['-e', 'process.stdout.write(process.env.GH_TOKEN)'])).toMatchObject({ ok: true, out: 'original-token' });
    } finally {
      time.mockRestore();
      for (const [key, value] of [
        ['PATH', saved.path], ['GH_TOKEN', saved.gh],
        [POD_GITHUB_CREDENTIAL_URL_ENV, saved.url], [POD_GITHUB_CREDENTIAL_TOKEN_ENV, saved.bearer],
      ] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('logs a redacted gh-token refresh failure and retains the caller token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-manager-relay-failed-'));
    const saved = {
      path: process.env.PATH, gh: process.env.GH_TOKEN,
      url: process.env[POD_GITHUB_CREDENTIAL_URL_ENV], bearer: process.env[POD_GITHUB_CREDENTIAL_TOKEN_ENV],
    };
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      writeFileSync(join(dir, 'gh'), '#!/bin/sh\nprintf "%s" "$GH_TOKEN"\n');
      writeFileSync(join(dir, 'curl'), '#!/bin/sh\nprintf "%s" "secret-error" >&2\nexit 22\n');
      chmodSync(join(dir, 'gh'), 0o755);
      chmodSync(join(dir, 'curl'), 0o755);
      process.env.PATH = `${dir}:${saved.path ?? ''}`;
      process.env.GH_TOKEN = 'original-token';
      process.env[POD_GITHUB_CREDENTIAL_URL_ENV] = 'http://relay.local/v1/pod/credential/github';
      process.env[POD_GITHUB_CREDENTIAL_TOKEN_ENV] = 'run-bearer-failed';
      expect(defaultCmdRunner('gh', ['pr', 'list'])).toMatchObject({ ok: true, out: 'original-token' });
      expect(log).toHaveBeenCalledWith('pr-manager', 'gh-token', { reason: 'refresh-failed' }, { level: 'warn' });
      expect(JSON.stringify(log.mock.calls)).not.toContain('run-bearer-failed');
      expect(JSON.stringify(log.mock.calls)).not.toContain('secret-error');
      delete process.env[POD_GITHUB_CREDENTIAL_URL_ENV];
      expect(defaultCmdRunner('gh', ['pr', 'list'])).toMatchObject({ ok: true, out: 'original-token' });
      expect(log.mock.calls.filter(([, event]) => event === 'gh-token')).toHaveLength(1);
    } finally {
      log.mockRestore();
      for (const [key, value] of [
        ['PATH', saved.path], ['GH_TOKEN', saved.gh],
        [POD_GITHUB_CREDENTIAL_URL_ENV, saved.url], [POD_GITHUB_CREDENTIAL_TOKEN_ENV, saved.bearer],
      ] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('defaultCmdRunner — bun ≥1.4 1MB maxBuffer', () => {
  it('reads a 2MB stdout whole instead of silently truncating it', () => {
    const r = defaultCmdRunner(process.execPath, ['-e', "process.stdout.write('x'.repeat(2_000_000))"]);
    expect(r.ok).toBe(true);
    expect(r.out.length).toBe(2_000_000);
  });
});

it('ghAutomationEnv: App token when the caller set no GH_TOKEN · a caller GH_TOKEN wins · no App keeps the env', () => {
  const env = { PATH: '/bin' } as NodeJS.ProcessEnv;
  expect(ghAutomationEnv(env, () => 'ghs_app').GH_TOKEN).toBe('ghs_app');
  expect(ghAutomationEnv({ ...env, GH_TOKEN: 'caller' }, () => 'ghs_app').GH_TOKEN).toBe('caller');
  expect(ghAutomationEnv(env, () => null)).toBe(env);
});

// ── 칸 PR-CREATE-FAIL-OBSERVE-FU — PR 생성 실패 incident 관측 단위 ─────────────
describe('PrCreateFailureIncident — 단위·자격증명 제거', () => {
  it('sanitizeCredentialText 는 gh 토큰과 URL 자격증명을 지운다', () => {
    expect(sanitizeCredentialText('token ghp_supersecret1234567890abcdef leaked')).toBe('token [REDACTED] leaked');
    expect(sanitizeCredentialText('github_pat_2_SUPERSECRETSECRETSECRETSECRETSECRET')).toBe('[REDACTED]');
    expect(sanitizeCredentialText('https://bot:hunter2@github.com/o/r.git')).toBe('https://[REDACTED]@github.com/o/r.git');
    expect(sanitizeCredentialText('ssh://bot:hunter2@github.com/o/r.git')).toBe('ssh://[REDACTED]@github.com/o/r.git');
    expect(sanitizeCredentialText('Authorization: Bearer secret123')).toBe('Authorization: Bearer ***');
    expect(sanitizeCredentialText('plain text keeps words')).toBe('plain text keeps words');
  });

  it('stderrTailOf 는 자격증명을 지운 뒤 꼬리만 남기고, 비거나 공백이면 undefined', () => {
    const sanitizedTail = stderrTailOf('x'.repeat(600) + 'tail ghp_supersecret1234567890abc');
    expect(sanitizedTail!.length).toBe(400);
    expect(sanitizedTail).toContain('tail [REDACTED]');
    expect(sanitizedTail).not.toContain('ghp_supersecret1234567890abc');
    expect(stderrTailOf(undefined)).toBeUndefined();
    expect(stderrTailOf('   ')).toBeUndefined();
  });

  it('recordPrCreateFailureIncident 는 push/gh 단계 구분 구조를 원장 이벤트 하나에 남긴다', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const incident: PrCreateFailureIncident = {
        branch: 'se/apm-x-abc', remote: 'origin',
        push: { stage: 'push', ran: true, rc: 1, ok: false, stderrTail: 'remote: rejected' },
        gh: { stage: 'gh', ran: false },
      };
      recordPrCreateFailureIncident(incident);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith('autopilot.pr-manager', 'pr-create-failure-incident', incident);
    } finally {
      log.mockRestore();
    }
  });

  it('기록 경계는 branch·runId·단계 stderr 의 비밀을 모두 가린다', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const incident = recordPrCreateFailureIncident({
        branch: 'se/ghp_supersecret1234567890abcdef', runId: 'run-ghp_supersecret1234567890abcdef', remote: 'origin',
        push: { stage: 'push', ran: true, ok: false, rc: 2, stderrTail: 'Authorization: Bearer secret123' },
        gh: { stage: 'gh', ran: false },
      });
      expect(JSON.stringify(incident)).not.toContain('ghp_supersecret1234567890abcdef');
      expect(JSON.stringify(incident)).not.toContain('secret123');
      expect(incident.push.stderrTail).toBe('Authorization: Bearer ***');
      expect(JSON.stringify(log.mock.calls)).not.toContain('ghp_supersecret1234567890abcdef');
    } finally {
      log.mockRestore();
    }
  });
});

// ── 칸 PR-CREATE-FAIL-OBSERVE-FU — 완료 경계 실물(격리 bare origin + 가짜 gh) ────
describe('upsertPr — 실패 incident 실물(bare origin + 가짜 gh)', () => {
  // 격리 bare origin 은 이 런의 원격이 아니다 — Pod 글로벌 git-guard 훅(core.hooksPath)을
  // GIT_CONFIG_GLOBAL=/dev/null 로 무력화하고, 씬의 pre-receive 거부 훅만 그대로 돌게 한다.
  const ISOLATED_GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (args: string[], opts?: { cwd?: string }): void => {
    const r = spawnSync('git', args, { encoding: 'utf8', env: ISOLATED_GIT_ENV, ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} → exit ${r.status}: ${r.stderr}`);
  };

  const makeScene = (preReceive?: string): { root: string; work: string } => {
    const root = mkdtempSync(join(tmpdir(), 'pr-manager-incident-'));
    const origin = join(root, 'origin.git');
    const work = join(root, 'work');
    git(['init', '--bare', '-b', 'main', origin]);
    git(['clone', origin, work]);
    git(['-C', work, 'config', 'user.email', 't@example.com']);
    git(['-C', work, 'config', 'user.name', 't']);
    writeFileSync(join(work, 'seed.txt'), 'seed\n');
    git(['-C', work, 'add', '.']);
    git(['-C', work, 'commit', '-m', 'seed']);
    git(['-C', work, 'push', '-u', 'origin', 'main']);
    if (preReceive) {
      // 씬 시드(main) push 뒤에만 설치 — 훅이 시드 push 까지 거부하면 씬 자체가 안 선다.
      mkdirSync(join(origin, 'hooks'), { recursive: true });
      writeFileSync(join(origin, 'hooks', 'pre-receive'), preReceive);
      chmodSync(join(origin, 'hooks', 'pre-receive'), 0o755);
    }
    git(['-C', work, 'checkout', '-b', 'se/incident-x']);
    writeFileSync(join(work, 'change.txt'), 'change\n');
    return { root, work };
  };

  const writeFakeGh = (dir: string, createFailure: string, failList = false, listToStdout = false, createToStdout = false): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'gh'), [
      '#!/bin/sh',
      failList
        ? `if [ "$1" = "pr" ] && [ "$2" = "list" ]; then printf "%s\\n" "Authorization: Bearer secret123 lookup failed" ${listToStdout ? '' : '>&2'}; exit 9; fi`
        : 'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then printf ""; exit 0; fi',
      `if [ "$1" = "pr" ] && [ "$2" = "create" ]; then printf '%s\\n' '${createFailure}' ${createToStdout ? '' : '>&2'}; exit 7; fi`,
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(join(dir, 'gh'), 0o755);
  };

  it('gh create 실패 — push 성공·gh rc=7·자격증명 제거 stderr 꼬리가 한 incident 에 남는다', () => {
    const { root, work } = makeScene();
    const ghDir = join(root, 'ghbin');
    writeFakeGh(ghDir, 'gh create failed token ghp_supersecret1234567890abcdef https://bot:hunter2@github.com/o/r');
    const saved = { path: process.env.PATH, token: process.env.GH_TOKEN, gitcfg: process.env.GIT_CONFIG_GLOBAL };
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    process.env.GH_TOKEN = 'test-token';
    process.env.PATH = `${ghDir}:${saved.path ?? ''}`;
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    try {
      const manager = makePrManager(defaultCmdRunner, () => ({ status: 'allow' as const, reasons: [], warnings: [] }));
      const r = manager.upsertPr({
        branch: 'se/incident-x', worktreePath: work, title: '[SE] incident', body: 'b',
        base: 'main', commitMessage: 'm', runId: 'run-incident-gh',
      });
      expect(r).toMatchObject({ ok: false, reason: 'gh' });
      if (r.ok) throw new Error('expected gh failure');
      expect(r.incident).toMatchObject({ runId: 'run-incident-gh', gh: { ran: true, rc: 7 } });
      expect(r.detail).toContain('pr-create-incident=');
      expect(r.detail).toContain('"rc":7');
      expect(r.detail).toContain('gh create failed');
      expect(r.detail).not.toContain('ghp_supersecret1234567890abcdef');
      expect(r.detail).not.toContain('hunter2');
      const incident = log.mock.calls.find(([, event]) => event === 'pr-create-failure-incident')?.[2] as PrCreateFailureIncident;
      expect(incident).toBeDefined();
      expect(incident.branch).toBe('se/incident-x');
      expect(incident.remote).toBe('origin');
      expect(incident.push).toMatchObject({ stage: 'push', ran: true, ok: true, rc: 0 });
      expect(incident.gh).toMatchObject({
        stage: 'gh', ran: true, rc: 7,
        lookup: { stage: 'gh', ran: true, rc: 0 },
        create: { stage: 'gh', ran: true, rc: 7 },
      });
      expect(incident.gh.lookup?.stderrTail).toBeUndefined();
      expect(incident.gh.create?.stderrTail).toContain('gh create failed');
      expect(incident.gh.stderrTail).toContain('gh create failed');
      expect(incident.gh.stderrTail).not.toContain('ghp_supersecret1234567890abcdef');
      expect(incident.gh.stderrTail).not.toContain('hunter2');
      expect(incident.gh.stderrTail).toContain('[REDACTED]');
    } finally {
      log.mockRestore();
      if (saved.path === undefined) delete process.env.PATH; else process.env.PATH = saved.path;
      if (saved.token === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved.token;
      if (saved.gitcfg === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.gitcfg;
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('gh create 실패 stdout-only 진단은 stdoutTail 필드로 보존하고 stderrTail을 비워 둔다', () => {
    const { root, work } = makeScene();
    const ghDir = join(root, 'ghbin');
    writeFakeGh(ghDir, 'create failed ghp_supersecret1234567890abcdef https://bot:hunter2@github.com/o/r', false, false, true);
    const saved = { path: process.env.PATH, token: process.env.GH_TOKEN, gitcfg: process.env.GIT_CONFIG_GLOBAL };
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    process.env.GH_TOKEN = 'test-token';
    process.env.PATH = `${ghDir}:${saved.path ?? ''}`;
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    try {
      const manager = makePrManager(defaultCmdRunner, () => ({ status: 'allow' as const, reasons: [], warnings: [] }));
      const r = manager.upsertPr({ branch: 'se/incident-x', worktreePath: work, title: '[SE] incident', body: 'b',
        base: 'main', commitMessage: 'm', runId: 'run-incident-create-stdout' });
      expect(r).toMatchObject({ ok: false, reason: 'gh' });
      if (r.ok) throw new Error('expected gh create failure');
      expect(r.incident).toMatchObject({
        runId: 'run-incident-create-stdout', push: { ran: true, ok: true, rc: 0 },
        gh: { ran: true, rc: 7, create: { ran: true, rc: 7,
          stdoutTail: 'create failed [REDACTED] https://[REDACTED]@github.com/o/r' } },
      });
      expect(r.incident?.gh.stderrTail).toBeUndefined();
      expect(r.incident?.gh.create?.stderrTail).toBeUndefined();
      expect(log.mock.calls.find(([, event]) => event === 'pr-create-failure-incident')?.[2]).toMatchObject(r.incident!);
    } finally {
      log.mockRestore();
      if (saved.path === undefined) delete process.env.PATH; else process.env.PATH = saved.path;
      if (saved.token === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved.token;
      if (saved.gitcfg === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.gitcfg;
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('push 실패 — pre-receive 거부 rc·자격증명 제거 stderr 꼬리·gh 미실행이 한 incident 에 남는다', () => {
    const hook = '#!/bin/sh\ncat >/dev/null\nprintf \'%s\\n\' "remote: push refused by policy token ghp_leak1234567890abcdef" >&2\nexit 3\n';
    const { root, work } = makeScene(hook);
    const saved = { path: process.env.PATH, token: process.env.GH_TOKEN, gitcfg: process.env.GIT_CONFIG_GLOBAL };
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    process.env.GH_TOKEN = 'test-token';
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    try {
      const manager = makePrManager(defaultCmdRunner, () => ({ status: 'allow' as const, reasons: [], warnings: [] }));
      const r = manager.upsertPr({
        branch: 'se/incident-x', worktreePath: work, title: '[SE] incident', body: 'b',
        base: 'main', commitMessage: 'm', runId: 'run-incident-push',
      });
      expect(r).toMatchObject({ ok: false, reason: 'push' });
      if (r.ok) throw new Error('expected push failure');
      expect(r.incident).toMatchObject({ runId: 'run-incident-push', push: { ran: true, ok: false }, gh: { ran: false } });
      expect(r.detail).toContain('pr-create-incident=');
      expect(r.detail).toContain('push refused by policy');
      expect(r.detail).not.toContain('ghp_leak1234567890abcdef');
      const incident = log.mock.calls.find(([, event]) => event === 'pr-create-failure-incident')?.[2] as PrCreateFailureIncident;
      expect(incident).toBeDefined();
      expect(incident.branch).toBe('se/incident-x');
      expect(incident.push).toMatchObject({ stage: 'push', ran: true, ok: false });
      expect(incident.gh).toMatchObject({ stage: 'gh', ran: false });
      expect(typeof incident.push.rc).toBe('number');
      expect(incident.push.stderrTail).toContain('push refused by policy');
      expect(incident.push.stderrTail).not.toContain('ghp_leak1234567890abcdef');
      expect(incident.push.stderrTail).toContain('[REDACTED]');
      expect(incident.gh).toMatchObject({ stage: 'gh', ran: false });
    } finally {
      log.mockRestore();
      if (saved.path === undefined) delete process.env.PATH; else process.env.PATH = saved.path;
      if (saved.token === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved.token;
      if (saved.gitcfg === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.gitcfg;
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('gh branch 조회 실패가 stdout-only 진단이면 stdoutTail 필드에 원문과 rc를 보존한다', () => {
    const { root, work } = makeScene();
    const ghDir = join(root, 'ghbin');
    writeFakeGh(ghDir, 'create must not run', true, true);
    const saved = { path: process.env.PATH, token: process.env.GH_TOKEN, gitcfg: process.env.GIT_CONFIG_GLOBAL };
    process.env.GH_TOKEN = 'test-token';
    process.env.PATH = `${ghDir}:${saved.path ?? ''}`;
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    try {
      const manager = makePrManager(defaultCmdRunner, () => ({ status: 'allow' as const, reasons: [], warnings: [] }));
      const r = manager.upsertPr({
        branch: 'se/incident-x', worktreePath: work, title: '[SE] incident', body: 'b',
        base: 'main', commitMessage: 'm', runId: 'run-incident-lookup',
      });
      expect(r).toMatchObject({ ok: false, reason: 'gh' });
      if (r.ok) throw new Error('expected gh lookup failure');
      expect(r.incident).toMatchObject({
        runId: 'run-incident-lookup', push: { ran: true, ok: true, rc: 0 },
        gh: {
          ran: true, rc: 9, stdoutTail: 'Authorization: Bearer *** lookup failed',
          lookup: { stage: 'gh', ran: true, rc: 9, stdoutTail: 'Authorization: Bearer *** lookup failed' },
          create: { stage: 'gh', ran: false },
        },
      });
      expect(r.detail).toContain('pr-create-incident=');
      expect(r.detail).not.toContain('secret123');
      expect(r.detail).not.toContain('ghp_');
      const incident = r.incident!;
      expect(incident.gh.stderrTail).toBeUndefined();
      expect(incident.gh.stdoutTail).toBe('Authorization: Bearer *** lookup failed');
      expect(incident.gh.lookup?.stderrTail).toBeUndefined();
      expect(incident.gh.lookup?.stdoutTail).toBe('Authorization: Bearer *** lookup failed');
    } finally {
      if (saved.path === undefined) delete process.env.PATH; else process.env.PATH = saved.path;
      if (saved.token === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved.token;
      if (saved.gitcfg === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.gitcfg;
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('same-cell 충돌 draft의 scratch ref cleanup 실패 긴 stderr 원문이 잘리지 않고 남는다 — 원문 대조', () => {
    // REVIEW-IO-COMPLETE-SIGNAL 첫 조각 완료 경계 실물: 격리 bare origin(pre-receive 가 «삭제만»
    // 긴 stderr 로 거부) + 가짜 gh 에서 superseding draft 경로의 cleanup 1회가 실패하면,
    // same-cell-scratch-cleanup-failed 기록이 원본 출력과 글자 단위로 같고 truncated:false 다.
    const refusal = `remote: scratch ref deletion refused by policy ${'cleanup detail '.repeat(26)}SCRATCH-CLEANUP-TAIL-MARKER`;
    const hook = [
      '#!/bin/sh',
      'reject=0',
      'while read old new ref; do',
      '  case "$new" in 0000000000000000000000000000000000000000) reject=1;; esac',
      'done',
      `if [ "$reject" = "1" ]; then printf '%s\\n' "${refusal}" >&2; exit 1; fi`,
      'exit 0',
      '',
    ].join('\n');
    const { root, work } = makeScene(hook);
    // ⛔ 무대 hermetic 핀 — bun test 의 preload-child-env 계약상 env 를 안 넘긴 spawnSync 자식은
    // «시작 시점» env 를 물려받는다. 그 env 에선 pod 글로벌 git-guard(core.hooksPath)가 살아 있어
    // 원문 대조의 재실행 push 가 씬 pre-receive 에 못 가고 pod pre-push 한 줄로 막힌다. 두 무대
    // 저장소의 hooksPath 를 각자 것으로 못 박는다(국소 설정이 글로벌을 이긴다) — work 는 빈 훅
    // 디렉터리로 클라이언트 훅을 끄고, origin 은 자기 hooks 디렉터리로 씬 pre-receive 를 고정한다.
    const sceneOrigin = join(root, 'origin.git');
    mkdirSync(join(root, 'scene-no-hooks'), { recursive: true });
    git(['-C', work, 'config', 'core.hooksPath', join(root, 'scene-no-hooks')]);
    git(['-C', sceneOrigin, 'config', 'core.hooksPath', join(sceneOrigin, 'hooks')]);
    // 낡은 PR 가지 — 실제 커밋을 밀어 머지 충돌을 만든다(superseding draft 경로의 입구).
    git(['-C', work, 'checkout', '-b', 'old-branch']);
    writeFileSync(join(work, 'conflict.txt'), 'B\n');
    git(['-C', work, 'add', 'conflict.txt']);
    git(['-C', work, 'commit', '-m', 'old pr change']);
    git(['-C', work, 'push', 'origin', 'old-branch']);
    const headSha = spawnSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: ISOLATED_GIT_ENV }).stdout.trim();
    git(['-C', work, 'checkout', 'se/incident-x']);
    writeFileSync(join(work, 'conflict.txt'), 'C\n');
    // 가짜 gh — 같은 칸 OPEN draft(#7) 고정 응답 ⊕ 대체 draft(#8) 개설.
    const body = '칸: PR-SAME-CELL-CLEANUP\n카드: ta-cleanup-1';
    const viewJson = JSON.stringify({ state: 'OPEN', headRefOid: headSha, headRefName: 'old-branch', body,
      isCrossRepository: false, url: 'https://github.com/o/r/pull/7', isDraft: true, labels: [] });
    const ghDir = join(root, 'ghbin-cleanup');
    mkdirSync(ghDir, { recursive: true });
    writeFileSync(join(ghDir, 'gh'), [
      '#!/bin/sh',
      'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then printf ""; exit 0; fi',
      `if [ "$1" = "pr" ] && [ "$2" = "view" ]; then printf '%s\\n' '${viewJson}'; exit 0; fi`,
      'if [ "$1" = "repo" ]; then printf \'%s\\n\' "o/r"; exit 0; fi',
      'if [ "$1" = "api" ]; then printf \'%s\\n\' \'{"ref":"refs/heads/se/incident-x"}\'; exit 0; fi',
      'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then printf \'%s\\n\' "https://github.com/o/r/pull/8"; exit 0; fi',
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(join(ghDir, 'gh'), 0o755);
    const saved = { path: process.env.PATH, token: process.env.GH_TOKEN, gitcfg: process.env.GIT_CONFIG_GLOBAL,
      cardId: process.env.ELANOUS_TASK_CARD_ID };
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    process.env.GH_TOKEN = 'test-token';
    process.env.PATH = `${ghDir}:${saved.path ?? ''}`;
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    // 하니스 디스패치 env 의 ELANOUS_TASK_CARD_ID(이 런의 과업 카드)가 새어 들면 upsertPr 입구의
    // 카드 계보 가드가 무대 카드(ta-cleanup-1)와 충돌해 cleanup 경로에 못 미치게 차단한다 —
    // 무대의 카드 표식이 지배하도록 잠시 비우고 끝내 복원한다.
    delete process.env.ELANOUS_TASK_CARD_ID;
    try {
      const inventory = { status: 'checked' as const, prs: [{ number: 7, headRefName: 'old-branch', title: 'old', draft: true,
        updatedAt: '2026-10-21T00:00:00Z', headSha, labels: [], files: ['src/old.ts'], seat: null,
        cellId: 'PR-SAME-CELL-CLEANUP', cardId: 'ta-cleanup-1' }] };
      const manager = makePrManager(defaultCmdRunner, () =>
        guardNewPr({ files: ['src/new.ts'], cellId: 'PR-SAME-CELL-CLEANUP', cardId: 'ta-cleanup-1' }, inventory));
      const r = manager.upsertPr({
        branch: 'se/incident-x', worktreePath: work, title: '[SE] cleanup', body,
        base: 'main', commitMessage: 'm', runId: 'run-a11ce5-1111-2222-3333-444444444444',
      });
      expect(r).toEqual({ ok: true, url: 'https://github.com/o/r/pull/8', reused: false, supersededPr: 7 });
      const cleanupLog = log.mock.calls.find(([, event]) => event === 'same-cell-scratch-cleanup-failed');
      expect(cleanupLog).toBeDefined();
      const record = cleanupLog![2] as { scratchRef: string; detail: string; stderr: string; stdout: string; truncated: boolean };
      expect(cleanupLog![3]).toEqual({ level: 'warn' });
      // 삭제 거부로 scratch ref 가 원격에 그대로 남았다 — 기록이 지목한 바로 그 ref 인지, 그리고
      // 같은 실패 명령의 원본 출력과 대조(원문 길이 ⊕ truncated 표지).
      const leftovers = spawnSync('git', ['ls-remote', 'origin'], { encoding: 'utf8', cwd: work });
      expect(leftovers.stdout).toContain(record.scratchRef);
      expect(record.scratchRef).toMatch(/^refs\/heads\/self-impl\/pr-create-ra11ce5-/);
      const raw = spawnSync('git', ['-C', work, 'push', 'origin', `:${record.scratchRef}`], { encoding: 'utf8', env: process.env });
      expect(raw.status).not.toBe(0);
      expect(record.truncated).toBe(false);
      expect(record.stderr).toBe(raw.stderr.trim());
      expect(record.stdout).toBe(raw.stdout.trim());
      expect(record.stderr.length).toBeGreaterThan(220);
      expect(record.stderr).toContain('SCRATCH-CLEANUP-TAIL-MARKER');
      expect(record.detail).toBe(record.stderr);
    } finally {
      log.mockRestore();
      if (saved.path === undefined) delete process.env.PATH; else process.env.PATH = saved.path;
      if (saved.token === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved.token;
      if (saved.gitcfg === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.gitcfg;
      if (saved.cardId === undefined) delete process.env.ELANOUS_TASK_CARD_ID; else process.env.ELANOUS_TASK_CARD_ID = saved.cardId;
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
