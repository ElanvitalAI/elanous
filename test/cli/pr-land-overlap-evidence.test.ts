/**
 * OVERLAP-EVIDENCE-BASE-WINDOW — 재게이트 뒤 base 가 앞섰을 때의 «창» 판정을 «진짜 git» 위에서 잰다.
 * (pr-cli.test 의 가짜 러너는 인자 모양만 문다 — 여기서는 log/diff 출력의 해석과 ref 를 안 쓰는 fetch 를 문다.)
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CmdRunner } from '../../src/autopilot/pr-manager.js';
import { verifyAncestorAutoPass, verifyOverlapEvidence } from '../../src/cli/pr-land-overlap-evidence.js';

const run: CmdRunner = (cmd, args, opts) => {
  const r = spawnSync(cmd, [...args], { cwd: opts?.cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}` };
};

let root: string;
let work: string;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function commit(cwd: string, file: string, body: string): string {
  mkdirSync(join(cwd, file, '..'), { recursive: true });
  writeFileSync(join(cwd, file), body);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', `touch ${file}`);
  return git(cwd, 'rev-parse', 'HEAD');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'overlap-window-'));
  git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  work = join(root, 'work');
  git(root, 'clone', '-q', join(root, 'origin.git'), 'work');
  git(work, 'checkout', '-q', '-b', 'main');
  commit(work, 'src/base.ts', 'base\n');
  git(work, 'push', '-q', 'origin', 'main');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** PR 가지(src/land.ts) → 게이트 base = 그 시점 main 끝. 그 뒤 main 에 `advance` 파일들을 착지시킨다. */
function scenario(advance: readonly string[], opts: { mergeTip?: boolean } = {}) {
  const gateBase = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '-q', '-b', 'feat');
  commit(work, 'src/land.ts', 'pr\n');
  git(work, 'checkout', '-q', 'main');
  for (const file of advance) commit(work, file, `${file}\n`);
  git(work, 'push', '-q', 'origin', 'main');
  const tip = git(work, 'rev-parse', 'main');
  git(work, 'checkout', '-q', 'feat');
  if (opts.mergeTip) git(work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'merge', '-q', '--no-edit', 'main');
  const head = git(work, 'rev-parse', 'HEAD');
  const reviewDir = join(root, 'review-results');
  mkdirSync(reviewDir, { recursive: true });
  const reviewResult = join(reviewDir, `TA-1-51-${head.slice(0, 12)}.json`);
  writeFileSync(reviewResult, JSON.stringify({ pr: 51, verdict: 'warn', reviewed: true, mustFix: [], headCommit: head }));
  const evidencePath = join(root, 'evidence.json');
  writeFileSync(evidencePath, JSON.stringify({ pr: 51, head, gate: { head, baseCommit: gateBase, passed: true }, reviewResult }));
  return { gateBase, tip, head, evidencePath };
}
const verify = (evidencePath: string, head: string, cwd = work) => verifyOverlapEvidence({
  evidencePath, pr: 51, expectedHead: head, remote: 'origin', branch: 'main', cwd, run, readFile: (p) => readFileSync(p, 'utf8'),
  reviewResultsDir: join(root, 'review-results'), listDir: readdirSync,
  reviewMtime: (p) => statSync(p).mtimeMs, reviewRealPath: realpathSync,
});

describe('OVERLAP-EVIDENCE-BASE-WINDOW — real git', () => {
  it('accepts when every window commit is disjoint from the PR files', () => {
    const { tip, gateBase, head, evidencePath } = scenario(['docs/a.md', 'src/other.ts']);
    expect(verify(evidencePath, head)).toEqual({
      ok: true, mode: 'base-advanced-disjoint', baseTip: tip, gateBase, windowCommits: 2, reviewResult: expect.any(String),
    });
  });

  it('refuses with base-stale-overlap when a window commit touches a PR file', () => {
    const { head, evidencePath } = scenario(['docs/a.md', 'src/land.ts']);
    const verdict = verify(evidencePath, head);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? '' : verdict.reason).toMatch(/^base-stale-overlap: .*1\/2 window commits touch PR files .*src\/land\.ts/);
  });

  it('PR files exclude main changes merged into the head (merge-base, not gate base)', () => {
    const { head, evidencePath } = scenario(['docs/a.md'], { mergeTip: true });
    expect(verify(evidencePath, head)).toMatchObject({ ok: true, mode: 'base-advanced-disjoint', windowCommits: 1 });
  });

  it('a merge commit in the window counts its second-parent changes (-m --first-parent)', () => {
    const gateBase = git(work, 'rev-parse', 'HEAD');
    git(work, 'checkout', '-q', '-b', 'side');
    commit(work, 'src/land.ts', 'side\n');
    git(work, 'checkout', '-q', 'main');
    commit(work, 'docs/a.md', 'a\n');
    git(work, 'merge', '-q', '--no-ff', '--no-edit', 'side');
    git(work, 'push', '-q', 'origin', 'main');
    git(work, 'checkout', '-q', '-b', 'feat', gateBase);
    commit(work, 'src/land.ts', 'pr\n');
    const head = git(work, 'rev-parse', 'HEAD');
    const reviewDir = join(root, 'review-results');
    mkdirSync(reviewDir, { recursive: true });
    const reviewResult = join(reviewDir, `TA-1-51-${head.slice(0, 12)}.json`);
    writeFileSync(reviewResult, JSON.stringify({ pr: 51, verdict: 'pass', reviewed: true, mustFix: [], headCommit: head }));
    const evidencePath = join(root, 'evidence.json');
    writeFileSync(evidencePath, JSON.stringify({ pr: 51, head, gate: { head, baseCommit: gateBase, passed: true }, reviewResult }));
    const verdict = verify(evidencePath, head);
    expect(verdict.ok ? '' : verdict.reason).toMatch(/^base-stale-overlap: .*1\/2 window commits touch PR files .*src\/land\.ts/);
  });

  it('fetches a missing tip without writing any ref', () => {
    const { tip, head, evidencePath } = scenario(['docs/a.md']);
    // 고정 머리만 가진 새 저장소 — 원격 끝 커밋이 로컬에 없다.
    const fresh = join(root, 'fresh');
    git(root, 'init', '-q', 'fresh');
    git(fresh, 'remote', 'add', 'origin', join(root, 'origin.git'));
    git(fresh, 'fetch', '-q', work, 'feat');
    rmSync(join(fresh, '.git', 'FETCH_HEAD'));
    expect(spawnSync('git', ['cat-file', '-e', `${tip}^{commit}`], { cwd: fresh }).status).not.toBe(0);
    const refsBefore = git(fresh, 'for-each-ref');
    expect(verify(evidencePath, head, fresh)).toMatchObject({ ok: true, mode: 'base-advanced-disjoint' });
    expect(git(fresh, 'for-each-ref')).toBe(refsBefore);
    expect(spawnSync('git', ['rev-parse', '--verify', '-q', 'FETCH_HEAD'], { cwd: fresh }).status).not.toBe(0);
  });
});

describe('already-ancestor-auto — 증거 파일 없이', () => {
  /** main 에 착지 하나(landed) → feat 가 그 위에서 갈라짐 → main 에 늦은 착지(late) 하나. */
  function ancestorScenario(review: { verdict?: string; mustFix?: string[] } | null) {
    const landed = commit(work, 'src/landed.ts', 'landed\n');
    git(work, 'push', '-q', 'origin', 'main');
    git(work, 'checkout', '-q', '-b', 'feat');
    commit(work, 'src/land.ts', 'pr\n');
    const head = git(work, 'rev-parse', 'HEAD');
    git(work, 'checkout', '-q', 'main');
    const late = commit(work, 'src/late.ts', 'late\n');
    const reviewResultsDir = join(root, 'review-results');
    mkdirSync(reviewResultsDir, { recursive: true });
    if (review) {
      writeFileSync(join(reviewResultsDir, `TA-1-51-${head.slice(0, 12)}.json`), JSON.stringify({
        pr: 51, verdict: review.verdict ?? 'pass', reviewed: true, mustFix: review.mustFix ?? [], headCommit: head,
      }));
    }
    return { landed, late, head, reviewResultsDir };
  }
  const auto = (head: string, reviewResultsDir: string, overlappingLandings: string[]) => verifyAncestorAutoPass({
    pr: 51, expectedHead: head, cwd: work, run, readFile: (p) => readFileSync(p, 'utf8'),
    reviewResultsDir, listDir: (dir) => readdirSync(dir), overlappingLandings,
  });

  it('겹친 착지가 전부 머리의 조상 ⊕ 리뷰 pass 면 통과', () => {
    const { landed, head, reviewResultsDir } = ancestorScenario({ verdict: 'warn' });
    expect(auto(head, reviewResultsDir, [landed])).toEqual({
      ok: true, mode: 'already-ancestor-auto', reviewResult: join(reviewResultsDir, `TA-1-51-${head.slice(0, 12)}.json`),
    });
  });

  it('조상이 아닌 착지가 하나라도 있으면 거부', () => {
    const { landed, late, head, reviewResultsDir } = ancestorScenario({});
    const verdict = auto(head, reviewResultsDir, [landed, late]);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? '' : verdict.reason).toMatch(/^ancestor-auto-not-ancestor/);
  });

  it('리뷰 결과가 없으면 거부', () => {
    const { landed, head, reviewResultsDir } = ancestorScenario(null);
    expect(auto(head, reviewResultsDir, [landed])).toEqual({ ok: false, reason: 'review-missing' });
  });

  it('리뷰에 must-fix 가 남아 있으면 거부', () => {
    const { landed, head, reviewResultsDir } = ancestorScenario({ verdict: 'pass', mustFix: ['남은 수리'] });
    expect(auto(head, reviewResultsDir, [landed])).toEqual({ ok: false, reason: 'review-must-fix-1' });
  });

  it('PR-LAND-MUSTFIX-NONE — 검증된 무소견 표지만 있으면 0 으로 보고 통과', () => {
    const { landed, head, reviewResultsDir } = ancestorScenario({ verdict: 'pass', mustFix: ['(없음 — 수용기준 충족)'] });
    expect(auto(head, reviewResultsDir, [landed])).toMatchObject({ ok: true, mode: 'already-ancestor-auto' });
  });

  it('PR-LAND-MUSTFIX-NONE — 미확인 설명은 must-fix 로 남겨 착지를 거부', () => {
    const { landed, head, reviewResultsDir } = ancestorScenario({ verdict: 'pass', mustFix: ['(없음 — 수용기준 충족: 관문이 리뷰 출력과 같은 판정을 쓴다)'] });
    expect(auto(head, reviewResultsDir, [landed])).toEqual({ ok: false, reason: 'review-must-fix-1' });
  });

  it('같은 머리의 리뷰 중 하나라도 must-fix 가 남으면 거부(처음 통과한 하나로 승인하지 않는다)', () => {
    const { landed, head, reviewResultsDir } = ancestorScenario({ verdict: 'pass' });
    writeFileSync(join(reviewResultsDir, `TA-2-51-${head.slice(0, 12)}.json`), JSON.stringify({
      pr: 51, verdict: 'fail', reviewed: true, mustFix: ['남은 수리'], headCommit: head,
    }));
    expect(auto(head, reviewResultsDir, [landed]).ok).toBe(false);
  });
});
