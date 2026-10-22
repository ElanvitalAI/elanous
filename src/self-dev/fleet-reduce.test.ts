import { describe, expect, test } from 'bun:test';
import { reduceBody, reduceShards, type Run, type Shard } from './fleet-reduce.js';

const shards: Shard[] = [
  { label: '#1 add a', branch: 'feat/a', prNumber: 1 },
  { label: '#2 add b', branch: 'feat/b', prNumber: 2 },
];

function fakeRun(opts: { conflictOn?: string; gateRc?: number } = {}) {
  const calls: string[] = [];
  const run: Run = (cmd, args) => {
    const line = `${cmd} ${args.join(' ')}`;
    calls.push(line);
    if (cmd === 'git' && args[0] === 'merge' && args[1] === '--no-ff' && opts.conflictOn && args.at(-1) === `origin/${opts.conflictOn}`) return { status: 1, stdout: '', stderr: 'CONFLICT' };
    if (cmd === 'git' && args[0] === 'diff' && args.includes('--diff-filter=U')) return { status: 0, stdout: 'src/x.ts\nsrc/y.ts\n', stderr: '' };
    if (cmd === 'bun' && args.includes('gate')) return { status: opts.gateRc ?? 0, stdout: 'gate: new regressions 0', stderr: '' };
    if (cmd === 'gh' && args[1] === 'create') return { status: 0, stdout: 'https://github.com/o/r/pull/9\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

describe('fleet reduce — 조각 PR 들을 하나로', () => {
  test('둘 다 합쳐지면 게이트 한 번 → 통합 브랜치 푸시 → PR 하나 → 조각 PR 에 대체 코멘트(닫지 않음)', async () => {
    const f = fakeRun();
    const r = await reduceShards({ repoRoot: '/repo', shards, branch: 'reduce/t', run: f.run, log: () => {} });
    expect(r).toMatchObject({ kind: 'pr-opened', prUrl: 'https://github.com/o/r/pull/9', branch: 'reduce/t' });
    expect(f.calls.filter((c) => c.startsWith('git merge --no-ff'))).toHaveLength(2);
    expect(f.calls.filter((c) => c.includes('self gate --local --changed --base origin/main'))).toHaveLength(1);
    expect(f.calls.some((c) => c.startsWith('git push -q origin reduce/t:reduce/t'))).toBe(true);
    expect(f.calls.filter((c) => c.startsWith('gh pr comment'))).toHaveLength(2);
    expect(f.calls.some((c) => c.startsWith('gh pr close'))).toBe(false);
    expect(f.calls.at(-1)).toContain('git worktree remove');
  });

  test('충돌이면 그 조각과 파일을 대고 병합을 되돌린 뒤 멈춘다 — 푸시·PR 없음', async () => {
    const f = fakeRun({ conflictOn: 'feat/b' });
    const r = await reduceShards({ repoRoot: '/repo', shards, run: f.run, log: () => {} });
    expect(r).toMatchObject({ kind: 'conflict', files: ['src/x.ts', 'src/y.ts'] });
    if (r.kind === 'conflict') { expect(r.shard.branch).toBe('feat/b'); expect(r.merged.map((s) => s.branch)).toEqual(['feat/a']); }
    expect(f.calls).toContain('git merge --abort');
    expect(f.calls.some((c) => c.startsWith('git branch -D reduce/'))).toBe(true);
    expect(f.calls.some((c) => c.startsWith('git push') || c.startsWith('gh pr create'))).toBe(false);
  });

  test('합친 것이 게이트에서 새 회귀를 내면 PR 을 열지 않는다', async () => {
    const f = fakeRun({ gateRc: 1 });
    const r = await reduceShards({ repoRoot: '/repo', shards, run: f.run, log: () => {} });
    expect(r.kind).toBe('gate-failed');
    expect(f.calls.some((c) => c.startsWith('gh pr create'))).toBe(false);
  });

  test('dry-run 은 푸시·PR·코멘트 없이 멈추고 통합 브랜치를 지운다 · 조각 하나면 거절', async () => {
    const f = fakeRun();
    const r = await reduceShards({ repoRoot: '/repo', shards, branch: 'reduce/d', dryRun: true, run: f.run, log: () => {} });
    expect(r.kind).toBe('dry-run');
    expect(f.calls.some((c) => c.startsWith('git push') || c.startsWith('gh '))).toBe(false);
    expect(f.calls).toContain('git branch -D reduce/d');
    await expect(reduceShards({ repoRoot: '/repo', shards: [shards[0]!], run: f.run, log: () => {} })).rejects.toThrow('둘 이상');
  });

  test('PR 본문이 조각을 순서대로 나열한다', () => {
    const body = reduceBody(shards, 'origin/main', '통과');
    expect(body.indexOf('#1')).toBeLessThan(body.indexOf('#2'));
    expect(body).toContain('게이트(변경 범위 · 새 회귀만 빨강): 통과');
  });
});

import { shardsFromResults } from './fleet-reduce.js';
describe('shardsFromResults — 오케스트레이터 결과에서 reduce 할 조각 고르기', () => {
  test('pr-opened ⊕ 미병합 ⊕ 브랜치 있음만 · 순서 유지 · PR 번호는 prNumber 또는 URL 에서', () => {
    const shards = shardsFromResults([
      { feature: 'a', stage: 'pr-opened', merged: false, branch: 'self-impl/a', prNumber: 11 },
      { feature: 'b', stage: 'merged', merged: true, branch: 'self-impl/b', prNumber: 12 },
      { feature: 'c', stage: 'gate-failed', branch: 'self-impl/c' },
      { feature: 'd', stage: 'pr-opened', merged: false, branch: 'self-impl/d', prUrl: 'https://github.com/o/r/pull/14' },
      { feature: 'e', stage: 'pr-opened', merged: false },
    ]);
    expect(shards).toEqual([
      { label: 'a', branch: 'self-impl/a', prNumber: 11 },
      { label: 'd', branch: 'self-impl/d', prNumber: 14 },
    ]);
  });
});
