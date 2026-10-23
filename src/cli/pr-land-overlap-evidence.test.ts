import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { resolveOverlapEvidencePath, verifyAllSameHeadReviews, verifyAncestorAutoPass, verifyOverlapEvidence, verifyOverlapEvidenceVirtualRebase } from './pr-land-overlap-evidence.js';
import { runPrLand } from './pr-cli.js';
import type { CmdRunner } from '../autopilot/pr-manager.js';

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const PR = 26343;
const review = (headCommit: string, pr = PR) => JSON.stringify({ pr, headCommit, reviewed: true, verdict: 'pass', mustFix: [] });

function check(filenameHead: string, contentHead: string, filenamePr = PR, contentPr = PR) {
  const path = `/state/review-results/card-${filenamePr}-${filenameHead}.json`;
  const run: CmdRunner = () => ({ ok: true, out: '', err: '' });
  return verifyOverlapEvidence({
    evidencePath: '/evidence.json', pr: PR, expectedHead: HEAD, remote: 'origin', branch: 'main', cwd: '/repo', run,
    reviewResultsDir: '/state/review-results',
    listDir: () => [`card-${filenamePr}-${filenameHead}.json`], reviewMtime: () => 1, reviewRealPath: (path) => path,
    readFile: (file) => file === '/evidence.json'
      ? JSON.stringify({ pr: PR, head: HEAD, reviewResult: path })
      : review(contentHead, contentPr),
    overlappingLandings: ['abcdef1234567'],
  });
}

const BASE_TIP = 'fedcba9876543210fedcba9876543210fedcba98';
const GATE_BASE = 'aaaabbbbccccddddaaaabbbbccccddddaaaabbbb';
const FORK = '1111222233334444111122223333444411112222';
const WINDOW_COMMIT = '9999888877776666999988887777666699998888';
const STD_DIR = '/state/review-results';
const COMMIT_MARK = '\u0001';

describe('CLI overlap evidence path', () => {
  test('resolves a relative --overlap-evidence path under the selected repository cwd', () => {
    expect(resolveOverlapEvidencePath('.state/overlap.json', '/work/target')).toBe('/work/target/.state/overlap.json');
    expect(resolveOverlapEvidencePath('/absolute/evidence.json', '/work/target')).toBe('/absolute/evidence.json');
  });

  test('pinned pr land dry-run reads relative evidence from --cwd and proves overlap with real git', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pr-land-overlap-cli-'));
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    const messages: string[] = [];
    try {
      git('init', '-b', 'main');
      git('config', 'user.name', 'Overlap CLI Test');
      git('config', 'user.email', 'overlap-cli@example.test');
      git('remote', 'add', 'origin', 'https://github.com/example/repo.git');
      writeFileSync(join(cwd, '.gitignore'), '.state/\n');
      writeFileSync(join(cwd, 'file.txt'), Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join(''));
      git('add', '.gitignore');
      git('add', 'file.txt');
      git('commit', '-m', 'initial');
      const lines = readFileSync(join(cwd, 'file.txt'), 'utf8').split('\n');
      lines[2] = 'recent overlapping landing';
      writeFileSync(join(cwd, 'file.txt'), lines.join('\n'));
      git('add', 'file.txt');
      git('commit', '-m', 'overlap landing (#28864)');
      const baseTip = git('rev-parse', 'HEAD');
      git('switch', '-c', 'feature');
      const featureLines = readFileSync(join(cwd, 'file.txt'), 'utf8').split('\n');
      featureLines[25] = 'reviewed feature change';
      writeFileSync(join(cwd, 'file.txt'), featureLines.join('\n'));
      git('add', 'file.txt');
      git('commit', '-m', 'feature change');
      const head = git('rev-parse', 'HEAD');
      git('update-ref', 'refs/remotes/origin/main', baseTip);

      const reviewDir = join(cwd, '.state', 'review-results');
      mkdirSync(reviewDir, { recursive: true });
      const reviewResult = join(reviewDir, `card-28865-${head.slice(0, 12)}.json`);
      writeFileSync(reviewResult, JSON.stringify({ pr: 28865, headCommit: head, reviewed: true, verdict: 'pass', mustFix: [] }));
      writeFileSync(join(cwd, '.state', 'overlap.json'), JSON.stringify({ pr: 28865, head, reviewResult }));

      const run: CmdRunner = (command, args, options) => {
        if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') return {
          ok: true,
          out: JSON.stringify({ headRefOid: head, headRefName: 'feature', baseRefName: 'main', state: 'OPEN', isDraft: false, url: 'https://github.com/example/repo/pull/28865' }),
          err: '',
        };
        if (command === 'git' && args[0] === 'ls-remote') return { ok: true, out: `${baseTip}\trefs/heads/main\n`, err: '' };
        const result = spawnSync(command, args, { cwd: options?.cwd ?? cwd, encoding: 'utf8' });
        return { ok: result.status === 0, out: result.stdout ?? '', err: result.stderr ?? '' };
      };
      const code = await runPrLand({ pr: '28865', expectedHead: head, dryRun: true, overlapEvidence: '.state/overlap.json', cwd }, {
        run, resolveBase: () => 'origin/main', currentBranch: () => 'feature', reviewResultsDir: reviewDir,
        out: { log: (line) => messages.push(line), error: (line) => messages.push(line) },
      });

      if (code !== 0) throw new Error(messages.join('\n'));
      expect(code).toBe(0);
      expect(messages.some((line) => line.includes('overlap-evidence: already-ancestor'))).toBe(true);
      expect(messages.some((line) => line.includes('[dry-run] ✓ overlap: evidence accepted'))).toBe(true);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }, 30_000);
});

/** Injected git seam — the overlap 판정 함수들 read git only through this runner. */
interface GitWorld {
  /** `git ls-remote <remote> refs/heads/main` sha (default BASE_TIP). */
  lsRemote?: string;
  /** `git rev-parse refs/remotes/origin/main` sha (default BASE_TIP). */
  localRef?: string;
  /** `git merge-base --is-ancestor BASE_TIP HEAD` (default true). */
  baseAncestor?: boolean;
  /** `git merge-base --is-ancestor GATE_BASE …` (default true). */
  gateAncestor?: boolean;
  /** `git merge-base BASE_TIP HEAD` (default FORK). */
  fork?: string;
  /** `git diff --name-only <fork> HEAD` — the PR's changed files. */
  prFiles?: readonly string[];
  /** `git log --name-only GATE_BASE..BASE_TIP` window commits and the files they touch. */
  window?: ReadonlyArray<{ sha: string; files: readonly string[] }>;
}

function gitFor(world: GitWorld = {}): CmdRunner {
  return (command, args) => {
    if (command !== 'git' || args.length === 0) return { ok: false, out: '', err: `unexpected ${command}` };
    const sub = args[0] ?? '';
    if (sub === 'ls-remote') return { ok: true, out: `${world.lsRemote ?? BASE_TIP}\trefs/heads/main\n`, err: '' };
    if (sub === 'rev-parse') return { ok: true, out: `${world.localRef ?? BASE_TIP}\n`, err: '' };
    if (sub === 'merge-base' && args[1] === '--is-ancestor') {
      const ok = args[2] === BASE_TIP && args[3] === HEAD ? (world.baseAncestor ?? true)
        : args[2] === GATE_BASE ? (world.gateAncestor ?? true)
        : false;
      return { ok, out: '', err: ok ? '' : 'not an ancestor' };
    }
    if (sub === 'merge-base') return { ok: true, out: `${world.fork ?? FORK}\n`, err: '' };
    if (sub === 'cat-file') return { ok: true, out: '', err: '' };
    if (sub === 'diff') return { ok: true, out: `${(world.prFiles ?? ['src/cli/pr-cli.ts']).join('\n')}\n`, err: '' };
    if (sub === 'log') {
      const commits = world.window ?? [{ sha: WINDOW_COMMIT, files: ['docs/unrelated.md'] }];
      return { ok: true, out: `${commits.map(({ sha, files }) => `${COMMIT_MARK}${sha}\n${files.join('\n')}`).join('\n')}\n`, err: '' };
    }
    return { ok: false, out: '', err: `unexpected git ${sub}` };
  };
}

describe('PR land review filename head prefix', () => {
  test('accepts a decimal string PR in overlap evidence and still rejects another PR', () => {
    const run: CmdRunner = () => ({ ok: true, out: '', err: '' });
    const verify = (pr: unknown, expectedPr = PR) => verifyOverlapEvidence({
      evidencePath: '/evidence.json', pr: expectedPr, expectedHead: HEAD, remote: 'origin', branch: 'main', cwd: '/repo', run,
      reviewResultsDir: '/state/review-results', overlappingLandings: ['abcdef1234567'],
      listDir: () => [`card-${PR}-${HEAD.slice(0, 12)}.json`], reviewMtime: () => 1, reviewRealPath: (path) => path,
      readFile: (path) => path === '/evidence.json'
        ? JSON.stringify({ pr, head: HEAD, reviewResult: `/state/review-results/card-${PR}-${HEAD.slice(0, 12)}.json` })
        : review(HEAD),
    });
    expect(verify(String(PR))).toMatchObject({ ok: true, mode: 'already-ancestor' });
    expect(verify(`0${PR}`)).toMatchObject({ ok: true, mode: 'already-ancestor' });
    expect(verify(String(PR + 1))).toEqual({ ok: false, reason: `evidence-pr-mismatch: ${PR + 1} ≠ ${PR}` });
    expect(verify(`${PR}x`)).toEqual({ ok: false, reason: `evidence-pr-mismatch: ${PR}x ≠ ${PR}` });
    expect(verify('0')).toEqual({ ok: false, reason: `evidence-pr-mismatch: 0 ≠ ${PR}` });
    expect(verify('9007199254740993', 9007199254740992)).toEqual({
      ok: false, reason: 'evidence-pr-mismatch: 9007199254740993 ≠ 9007199254740992',
    });
  });

  test('accepts a 10-character filename prefix only when review headCommit exactly matches', () => {
    expect(check(HEAD.slice(0, 10), HEAD)).toMatchObject({ ok: true, mode: 'already-ancestor' });
  });

  test('rejects a matching head-10 filename when review headCommit differs using the existing reason', () => {
    const result = check(HEAD.slice(0, 10), 'f'.repeat(40));
    expect(result).toEqual({ ok: false, reason: 'review-head-mismatch' });
  });

  test('rejects a different full head even when its first 10 characters match', () => {
    const collidingHead = `${HEAD.slice(0, 10)}${'f'.repeat(30)}`;
    expect(check(HEAD.slice(0, 10), collidingHead)).toEqual({ ok: false, reason: 'review-head-mismatch' });
  });

  test('retains the existing standard 12-character filename behavior', () => {
    expect(check(HEAD.slice(0, 12), HEAD)).toMatchObject({ ok: true, mode: 'already-ancestor' });
  });

  test('does not accept a filename head prefix shorter than 10 characters', () => {
    expect(check(HEAD.slice(0, 9), HEAD)).toEqual({ ok: false, reason: 'review-path-not-for-this-pr-head' });
  });

  test('accepts a full 40-character head as filename suffix', () => {
    expect(check(HEAD, HEAD)).toMatchObject({ ok: true, mode: 'already-ancestor' });
  });

  test('rejects a 41-character filename head suffix', () => {
    expect(check(`${HEAD}a`, HEAD)).toEqual({ ok: false, reason: 'review-path-not-for-this-pr-head' });
  });

  test('rejects another PR in the filename or the review body', () => {
    expect(check(HEAD.slice(0, 10), HEAD, PR + 1)).toEqual({ ok: false, reason: 'review-path-not-for-this-pr-head' });
    expect(check(HEAD.slice(0, 10), HEAD, PR, PR + 1)).toEqual({ ok: false, reason: 'review-pr-mismatch' });
  });

  test('automatic lookup accepts head-10 with matching JSON and rejects a different full head', () => {
    const name = `card-${PR}-${HEAD.slice(0, 10)}.json`;
    const automatic = (contentHead: string) => verifyAncestorAutoPass({
      pr: PR, expectedHead: HEAD, cwd: '/repo', reviewResultsDir: '/state/review-results',
      overlappingLandings: ['abcdef1234567'],
      run: () => ({ ok: true, out: '', err: '' }),
      listDir: () => [name],
      readFile: () => review(contentHead),
    });
    expect(automatic(HEAD)).toEqual({
      ok: true, mode: 'already-ancestor-auto', reviewResult: `/state/review-results/${name}`,
    });
    expect(automatic('f'.repeat(40))).toEqual({ ok: false, reason: 'review-head-mismatch' });
    expect(automatic(`${HEAD.slice(0, 10)}${'f'.repeat(30)}`)).toEqual({ ok: false, reason: 'review-head-mismatch' });
  });

  test('automatic lookup ignores another PR and head prefixes shorter than 10', () => {
    const result = verifyAncestorAutoPass({
      pr: PR, expectedHead: HEAD, cwd: '/repo', reviewResultsDir: '/state/review-results',
      overlappingLandings: ['abcdef1234567'],
      run: () => ({ ok: true, out: '', err: '' }),
      listDir: () => [`card-${PR + 1}-${HEAD.slice(0, 10)}.json`, `card-${PR}-${HEAD.slice(0, 9)}.json`],
      readFile: () => review(HEAD),
    });
    expect(result).toEqual({ ok: false, reason: 'review-missing' });
  });
});

describe('review provider evidence', () => {
  const name = `card-${PR}-${HEAD.slice(0, 12)}.json`;
  const path = `/state/review-results/${name}`;
  const inspect = (body: Record<string, unknown>, automatic = false) => {
    const input = {
      pr: PR, expectedHead: HEAD, cwd: '/repo', run: (() => ({ ok: true, out: '', err: '' })) as CmdRunner,
      readFile: (file: string) => file === '/evidence.json'
        ? JSON.stringify({ pr: PR, head: HEAD, reviewResult: path })
        : JSON.stringify({ pr: PR, headCommit: HEAD, reviewed: true, verdict: 'pass', mustFix: [], ...body }),
      reviewResultsDir: '/state/review-results', listDir: () => [name], overlappingLandings: ['abcdef1234567'],
    };
    return automatic ? verifyAncestorAutoPass(input) : verifyOverlapEvidence({ ...input, evidencePath: '/evidence.json', remote: 'origin', branch: 'main', reviewMtime: () => 1, reviewRealPath: (file) => file });
  };

  test('warns the user about requested versus actual provider on both landing paths without altering the evidence format', () => {
    const warnings: string[] = [];
    const old = console.warn;
    console.warn = (line) => { warnings.push(line); };
    try {
      const mismatched = { requestedModel: 'openrouter/z-ai/glm-5.3', actualBackend: 'acp:grok', model: 'acp:grok', reviewRoute: 'acp-fallback' };
      expect(inspect(mismatched)).toEqual({ ok: true, mode: 'already-ancestor', reviewResult: path });
      expect(inspect(mismatched, true)).toEqual({ ok: true, mode: 'already-ancestor-auto', reviewResult: path });
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain('requestedModel=openrouter/z-ai/glm-5.3 actualBackend=acp:grok model=acp:grok reviewRoute=acp-fallback');
      expect(inspect({ requestedModel: 'openrouter/z-ai/glm-5.3', model: 'openrouter/z-ai/glm-5.3', reviewRoute: 'api' })).toMatchObject({ ok: true });
      expect(inspect({ requestedModel: 'acp:grok/grok-4', actualBackend: 'acp:grok', model: 'acp:grok/grok-4', reviewRoute: 'acp' })).toMatchObject({ ok: true });
      expect(warnings).toHaveLength(2);
      expect(inspect({ requestedModel: 'acp:grok/grok-4', actualBackend: 'acp:grok', model: 'acp:grok/grok-4', reviewRoute: 'acp-fallback' })).toMatchObject({ ok: true });
      expect(warnings.at(-1)).toContain('reviewRoute=acp-fallback');
      expect(inspect({ requestedModel: 'openrouter/z-ai/glm-5.3', actualBackend: 'openai', model: 'openrouter/z-ai/glm-5.3', reviewRoute: 'api' })).toMatchObject({ ok: true });
      expect(warnings.at(-1)).toContain('actualBackend=openai');
      expect(inspect({ requestedModel: 'openrouter/z-ai/glm-5.3', model: 'openrouter/other/model', reviewRoute: 'api' })).toMatchObject({ ok: true });
      expect(warnings.at(-1)).toContain('model=openrouter/other/model');
      expect(inspect({ requestedModel: 'openrouter/z-ai/glm-5.3', model: 'openrouter/z-ai/glm-5.3', reviewRoute: 'acp' })).toMatchObject({ ok: true });
      expect(warnings.at(-1)).toContain('reviewRoute=acp');
      expect(inspect({ requestedModel: 'openrouter/z-ai/glm-5.3', model: 'openrouter/z-ai/glm-5.3', reviewRoute: 'api', respondedProvider: 'openrouter', respondedModel: 'z-ai/glm-5.3' })).toMatchObject({ ok: true });
      expect(warnings).toHaveLength(6);
      expect(inspect({ requestedModel: 'openrouter/z-ai/glm-5.3', model: 'openrouter/z-ai/glm-5.3', reviewRoute: 'api', respondedProvider: 'openai', respondedModel: 'z-ai/glm-5.3' })).toMatchObject({ ok: true });
      expect(warnings.at(-1)).toContain('respondedProvider=openai');
      expect(inspect({ requestedModel: 'openrouter/z-ai/glm-5.3', model: 'openrouter/z-ai/glm-5.3', reviewRoute: 'api', respondedProvider: 'openrouter', respondedModel: 'other/model' })).toMatchObject({ ok: true });
      expect(warnings.at(-1)).toContain('respondedModel=other/model');
      expect(inspect({ requestedModel: 'openrouter/z-ai/glm-5.3', model: 'openrouter/z-ai/glm-5.3', reviewRoute: 'api', respondedModel: 'other/model' })).toMatchObject({ ok: true });
      expect(warnings.at(-1)).toContain('respondedModel=other/model');
      const beforeBare = warnings.length;
      expect(inspect({ requestedModel: 'claude-sonnet-4', model: 'claude-sonnet-4', reviewRoute: 'api', respondedProvider: 'anthropic', respondedModel: 'claude-sonnet-4' })).toMatchObject({ ok: true });
      expect(inspect({ requestedModel: 'gpt-6-sol', model: 'gpt-6-sol', reviewRoute: 'api', respondedProvider: 'openai-codex', respondedModel: 'gpt-6-sol' })).toMatchObject({ ok: true });
      expect(warnings).toHaveLength(beforeBare);
    } finally { console.warn = old; }
  });

  test('forbidden acp:claude is never landing evidence, including automatic lookup', () => {
    for (const body of [
      { model: 'acp:claude', reviewRoute: 'acp' },
      { model: 'acp:claude/opus', reviewRoute: 'acp' },
      { actualBackend: 'acp:claude/opus', reviewRoute: 'acp' },
      { requestedModel: 'openrouter/z-ai/glm-5.3', actualBackend: 'acp:claude', model: 'openrouter/z-ai/glm-5.3', reviewRoute: 'acp-fallback' },
      { reviewRoute: 'acp-fallback', fallbackBackend: 'claude' },
    ]) {
      expect(inspect(body)).toEqual({ ok: false, reason: 'review-forbidden-acp-claude' });
      expect(inspect(body, true)).toEqual({ ok: false, reason: 'review-forbidden-acp-claude' });
    }
  });
});

describe('explicit review attempt selection', () => {
  const dir = '/state/review-results';
  const selected = `card-R4-${PR}-${HEAD.slice(0, 12)}.json`;
  const failed = `card-R3-${PR}-${HEAD.slice(0, 12)}.json`;
  const extra = `card-R2-${PR}-${HEAD.slice(0, 12)}.json`;
  const priorFinding = '비차단 실물 요청의 결과가 같은 requestId로 다시 조회되어야 한다';
  const evidence = (supersedes?: unknown, followupPr?: unknown) => JSON.stringify({
    pr: PR, head: HEAD, reviewResult: `${dir}/${selected}`, supersedes, followupPr,
  });
  const runCase = (options: { supersedes?: unknown; followupPr?: unknown; names?: string[]; followupState?: string; selectedHead?: string; failedHead?: string; failedTime?: number; failedVerdict?: unknown; selectedResolvedPrior?: unknown; selectedIntent?: string; selectedStatus?: string; failedMustFix?: unknown[] } = {}) => {
    const names = options.names ?? [selected, failed];
    const run: CmdRunner = (command, args) => command === 'gh' && args[0] === 'pr'
      ? { ok: true, out: JSON.stringify({ state: options.followupState ?? 'OPEN' }), err: '' }
      : { ok: true, out: '', err: '' };
    return verifyOverlapEvidence({
      evidencePath: '/evidence.json', pr: PR, expectedHead: HEAD, remote: 'origin', branch: 'main', cwd: '/repo', run,
      reviewResultsDir: dir,
      overlappingLandings: ['abcdef1234567'], listDir: () => names, reviewRealPath: (path) => path,
      reviewMtime: (path) => path.endsWith(selected) ? 20 : (options.failedTime ?? 10),
      readFile: (path) => path === '/evidence.json' ? evidence(options.supersedes, options.followupPr)
        : path.endsWith(selected) ? JSON.stringify({ pr: PR, headCommit: options.selectedHead ?? HEAD, reviewed: true,
          verdict: 'warn', mustFix: [], status: options.selectedStatus, resolvedPrior: options.selectedResolvedPrior, intent: options.selectedIntent })
          : JSON.stringify({ pr: PR, headCommit: options.failedHead ?? HEAD, reviewed: true,
            verdict: options.failedVerdict === undefined ? 'fail' : options.failedVerdict, mustFix: options.failedMustFix ?? [priorFinding] }),
    });
  };
  const replacement = [{ reviewResult: `${dir}/${failed}`, reason: 'review-verdict-fail' }];

  test('fails closed on an old same-head FAIL unless explicitly superseded with an OPEN follow-up', () => {
    expect(runCase()).toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
    expect(runCase({ supersedes: replacement, followupPr: PR + 1 })).toMatchObject({ ok: true, mode: 'already-ancestor' });
  });

  test('accepts a later same-head mf0 review that names every prior FAIL finding as resolved', () => {
    expect(runCase({
      selectedResolvedPrior: [{ reviewResult: `${dir}/${failed}`, mustFix: [priorFinding] }],
    })).toMatchObject({ ok: true, mode: 'already-ancestor' });
    expect(runCase({ selectedResolvedPrior: [priorFinding] })).toMatchObject({ ok: true, mode: 'already-ancestor' });
    expect(runCase({ selectedResolvedPrior: [`${failed}: ${priorFinding}`] }))
      .toMatchObject({ ok: true, mode: 'already-ancestor' });
    expect(runCase({ selectedResolvedPrior: [`Background: ${failed}: ${priorFinding}`] }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
    expect(runCase({ selectedResolvedPrior: [`${failed}: ${priorFinding.replace('requestId', 'requestid')}`] }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
    expect(runCase({ selectedIntent: `Resolved prior review findings:\n- ${failed}: ${priorFinding.replace('requestId', 'requestid')}` }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
    expect(runCase({
      supersedes: [{ reviewResult: `${dir}/${failed}`, reason: 'review-verdict-null' }],
      selectedResolvedPrior: [{ reviewResult: `${dir}/${failed}`, mustFix: [priorFinding] }],
    })).toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
  });

  test('accepts the explicit resolved-prior intent block and rejects partial or unrelated resolution', () => {
    const intent = `Resolved prior review findings:\n- ${failed}: ${priorFinding}`;
    expect(runCase({ selectedIntent: intent })).toMatchObject({ ok: true, mode: 'already-ancestor' });
    expect(runCase({ selectedResolvedPrior: [{ reviewResult: `${dir}/${failed}`, mustFix: [priorFinding] }],
      selectedIntent: 'status: pending' }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
    expect(runCase({ selectedIntent: `${intent}\nstatus: pending` }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
    expect(runCase({ selectedIntent: `Background: ${failed}: ${priorFinding}\nResolved prior review findings:\n- ${failed}: another finding` }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
    expect(runCase({ selectedIntent: `Resolved prior review findings:\n- ${failed}: ${priorFinding} remains unresolved` }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
    expect(runCase({ selectedIntent: `Resolved prior review findings:\n- ${failed}: ${priorFinding} is not resolved` }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
    expect(runCase({ selectedIntent: `Resolved prior review findings:\n- ${failed}: ${priorFinding} is not-resolved` }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
    expect(runCase({ selectedIntent: `Resolved prior review findings:\n- ${failed}: ${priorFinding} is not yet resolved` }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
    expect(runCase({ selectedIntent: `Resolved prior review findings:\n- ${failed}: ${priorFinding} is not-fixed` }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
    expect(runCase({ selectedIntent: `Resolved prior review findings:\n- ${failed}: ${priorFinding} (status: pending)` }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
    expect(runCase({ selectedIntent: `${intent}\n- ${failed}: ${priorFinding} not-addressed` }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
    expect(runCase({
      selectedResolvedPrior: [{ reviewResult: `${dir}/${failed}`, mustFix: [priorFinding, `${priorFinding} remains unresolved`] }],
    })).toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
    expect(runCase({ selectedResolvedPrior: [
      { reviewResult: `${dir}/${failed}`, mustFix: [priorFinding] },
      { reviewResult: `${dir}/${failed}`, resolved: false, mustFix: [priorFinding] },
    ] })).toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
    expect(runCase({ selectedResolvedPrior: [
      { reviewResult: `${dir}/${failed}`, mustFix: [priorFinding] },
      { reviewResult: `${dir}/${failed}`, status: 'open', mustFix: [priorFinding] },
    ] })).toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
    expect(runCase({
      selectedResolvedPrior: [{ reviewResult: `${dir}/${failed}`, mustFix: [`${priorFinding} not yet resolved`] }],
    })).toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
    expect(runCase({
      selectedResolvedPrior: [{ reviewResult: `${dir}/${failed}`, mustFix: [`${priorFinding} not-addressed`] }],
    })).toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
    expect(runCase({ selectedResolvedPrior: [`${failed}: ${priorFinding} remains unresolved`] }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
    expect(runCase({ selectedResolvedPrior: [{ reviewResult: `${dir}/${failed}`, mustFix: [`${priorFinding} remains unresolved`] }] }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
    expect(runCase({ selectedResolvedPrior: [{ reviewResult: `${dir}/${failed}`, mustFix: ['other finding'] }] }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
    expect(runCase({ selectedResolvedPrior: [{ reviewResult: `${dir}/${extra}`, mustFix: [priorFinding] }] }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
    expect(runCase({ selectedIntent: `Resolved prior review findings:\n- ${priorFinding}` }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
    expect(runCase({ selectedResolvedPrior: [{ reviewResult: `${dir}/${failed}`, mustFix: [priorFinding] }], failedHead: 'f'.repeat(40) }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
    expect(runCase({
      failedMustFix: [priorFinding, '두 번째 독립 must-fix'],
      selectedResolvedPrior: [{ reviewResult: `${dir}/${failed}`, mustFix: [priorFinding] }],
    })).toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
    expect(runCase({ selectedIntent: intent, failedTime: 30 }))
      .toEqual({ ok: false, reason: 'review-selected-not-later-than-failure' });
  });

  test('REVIEW-SUPERSEDE-SAME-HEAD: keeps the explicit same-head resolution and refuses the two contradiction axes', () => {
    const intent = `Resolved prior review findings:\n- ${failed}: ${priorFinding}`;
    // (a) A same-head FAIL that a later mf0 review explicitly resolves stays landable.
    expect(runCase({ selectedResolvedPrior: [{ reviewResult: `${dir}/${failed}`, mustFix: [priorFinding] }] }))
      .toMatchObject({ ok: true, mode: 'already-ancestor' });
    expect(runCase({ selectedResolvedPrior: true, selectedIntent: intent }))
      .toMatchObject({ ok: true, mode: 'already-ancestor' });
    expect(runCase({ selectedResolvedPrior: [{ reviewResult: `${dir}/${failed}`, mustFix: [priorFinding] }], selectedStatus: 'resolved' }))
      .toMatchObject({ ok: true, mode: 'already-ancestor' });
    // (b) `resolvedPrior: true` cannot coexist with a separate OPEN/PENDING status on the same record.
    for (const selectedStatus of ['pending', 'open']) {
      expect(runCase({ selectedResolvedPrior: true, selectedIntent: intent, selectedStatus }))
        .toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
      expect(runCase({ selectedResolvedPrior: [{ reviewResult: `${dir}/${failed}`, mustFix: [priorFinding] }], selectedStatus }))
        .toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
    }
    // (c) A sentence-form `status open/pending` inside the intent refuses the same landing.
    for (const suffix of ['status pending', 'status open', 'Review status open — awaiting re-run']) {
      expect(runCase({
        selectedResolvedPrior: [{ reviewResult: `${dir}/${failed}`, mustFix: [priorFinding] }],
        selectedIntent: `${intent}\n${suffix}`,
      })).toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
      expect(runCase({ selectedResolvedPrior: true, selectedIntent: `${intent}\n${suffix}` }))
        .toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
    }
  });

  test('rejects unlisted failures and a closed or absent follow-up', () => {
    expect(runCase({ supersedes: replacement, followupPr: PR + 1, names: [selected, failed, extra] }))
      .toMatchObject({ ok: false, reason: expect.stringContaining(extra) });
    expect(runCase({ supersedes: replacement })).toEqual({ ok: false, reason: 'review-followup-pr-invalid' });
    expect(runCase({ supersedes: replacement, followupPr: PR + 1, followupState: 'MERGED' }))
      .toEqual({ ok: false, reason: 'review-followup-pr-not-open' });
  });

  test('does not supersede a review whose verdict was never measured', () => {
    expect(runCase({
      failedVerdict: null,
      supersedes: [{ reviewResult: `${dir}/${failed}`, reason: 'review-verdict-null' }],
      followupPr: PR + 1,
    })).toEqual({ ok: false, reason: `review-supersedes-not-failed: ${failed} (review-verdict-null)` });
  });

  test('rejects a selected review with the wrong head even when the old failure is listed', () => {
    expect(runCase({ supersedes: replacement, followupPr: PR + 1, selectedHead: 'f'.repeat(40) }))
      .toEqual({ ok: false, reason: 'review-head-mismatch' });
  });

  test('rejects an older selected PASS that precedes the failure, or unmeasured attempts', () => {
    expect(runCase({ supersedes: replacement, followupPr: PR + 1, failedTime: 30 }))
      .toEqual({ ok: false, reason: 'review-selected-not-later-than-failure' });
    const unmeasured = verifyOverlapEvidence({
      evidencePath: '/evidence.json', pr: PR, expectedHead: HEAD, remote: 'origin', branch: 'main', cwd: '/repo',
      reviewResultsDir: dir,
      run: () => ({ ok: true, out: '', err: '' }), overlappingLandings: ['abcdef1234567'],
      readFile: (path) => path === '/evidence.json' ? evidence() : review(HEAD),
      listDir: undefined as unknown as (dir: string) => readonly string[], reviewMtime: () => 20, reviewRealPath: (path) => path,
    });
    expect(unmeasured).toEqual({ ok: false, reason: 'review-attempts-unmeasured' });
  });

  test('rejects a selected review kept outside the standard review directory', () => {
    const result = verifyOverlapEvidence({
      evidencePath: '/evidence.json', pr: PR, expectedHead: HEAD, remote: 'origin', branch: 'main', cwd: '/repo',
      reviewResultsDir: dir, run: () => ({ ok: true, out: '', err: '' }), overlappingLandings: ['abcdef1234567'],
      listDir: () => [selected], reviewMtime: () => 20, reviewRealPath: (path) => path,
      readFile: (path) => path === '/evidence.json'
        ? JSON.stringify({ pr: PR, head: HEAD, reviewResult: `/other/review-results/${selected}` }) : review(HEAD),
    });
    expect(result).toEqual({ ok: false, reason: 'review-selected-outside-standard-dir' });
  });

  test('rejects a symlinked review whose physical file leaves the standard directory', () => {
    const result = verifyOverlapEvidence({
      evidencePath: '/evidence.json', pr: PR, expectedHead: HEAD, remote: 'origin', branch: 'main', cwd: '/repo',
      reviewResultsDir: dir, run: () => ({ ok: true, out: '', err: '' }), overlappingLandings: ['abcdef1234567'],
      listDir: () => [selected], reviewMtime: () => 20,
      reviewRealPath: (path) => path.endsWith(selected) ? `/other/${selected}` : path,
      readFile: (path) => path === '/evidence.json' ? evidence() : review(HEAD),
    });
    expect(result).toEqual({ ok: false, reason: 'review-file-outside-standard-dir' });
  });

  test('rejects a standard review directory symlinked to a different physical directory', () => {
    const result = verifyOverlapEvidence({
      evidencePath: '/evidence.json', pr: PR, expectedHead: HEAD, remote: 'origin', branch: 'main', cwd: '/repo',
      reviewResultsDir: dir, run: () => ({ ok: true, out: '', err: '' }), overlappingLandings: ['abcdef1234567'],
      listDir: () => [selected], reviewMtime: () => 20,
      reviewRealPath: (path) => path === dir ? '/other/reviews' : path,
      readFile: (path) => path === '/evidence.json' ? evidence() : review(HEAD),
    });
    expect(result).toEqual({ ok: false, reason: 'review-standard-dir-symlink' });
  });
});

describe('rebased overlap evidence (① re-base · ② re-gate · ③ review)', () => {
  const selectedName = `card-${PR}-${HEAD.slice(0, 12)}.json`;
  const selectedPath = `${STD_DIR}/${selectedName}`;
  const evidence = (gate?: unknown, reviewResult: string = selectedPath, pr: number = PR) =>
    JSON.stringify({ pr, head: HEAD, ...(gate === undefined ? {} : { gate }), reviewResult });
  const passingGate = { head: HEAD, baseCommit: BASE_TIP, passed: true };
  const verify = (options: { evidence?: string; review?: string; world?: GitWorld } = {}) =>
    verifyOverlapEvidence({
      evidencePath: '/evidence.json', pr: PR, expectedHead: HEAD, remote: 'origin', branch: 'main', cwd: '/repo',
      run: gitFor(options.world),
      readFile: (path) => path === '/evidence.json' ? (options.evidence ?? evidence(passingGate)) : (options.review ?? review(HEAD)),
      reviewResultsDir: STD_DIR, listDir: () => [selectedName], reviewMtime: () => 1, reviewRealPath: (path) => path,
      overlappingLandings: [],
    });

  test('accepts evidence whose gate passed on the current base tip of the same head', () => {
    expect(verify()).toEqual({ ok: true, mode: 'rebased', baseTip: BASE_TIP, reviewResult: selectedPath });
  });

  test('refuses a head that is not rebased on the remote base tip', () => {
    expect(verify({ world: { baseAncestor: false } })).toMatchObject({
      ok: false, reason: expect.stringContaining('not-rebased:'), baseTip: BASE_TIP,
    });
  });

  test('refuses a missing, failed, mistaken-head or unmeasured gate', () => {
    expect(verify({ evidence: evidence() })).toEqual({ ok: false, reason: 'gate-missing' });
    expect(verify({ evidence: evidence({ head: HEAD, baseCommit: BASE_TIP, passed: false }) }))
      .toEqual({ ok: false, reason: 'gate-not-passed' });
    expect(verify({ evidence: evidence({ head: 'f'.repeat(40), baseCommit: BASE_TIP, passed: true }) }))
      .toEqual({ ok: false, reason: 'gate-head-mismatch' });
    expect(verify({ evidence: evidence({ head: HEAD, baseCommit: 'not-a-sha', passed: true }) }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('gate-base-stale:') });
  });

  test('keeps the PR identity of the evidence itself on the gated path', () => {
    expect(verify({ evidence: evidence(passingGate, selectedPath, PR + 1) }))
      .toEqual({ ok: false, reason: `evidence-pr-mismatch: ${PR + 1} ≠ ${PR}` });
  });

  test('enforces the 10~40 filename head prefix and the full-content head on the gated path', () => {
    expect(verify({ evidence: evidence(passingGate, `${STD_DIR}/card-${PR}-${HEAD.slice(0, 9)}.json`) }))
      .toEqual({ ok: false, reason: 'review-path-not-for-this-pr-head' });
    expect(verify({ review: review('f'.repeat(40)) })).toEqual({ ok: false, reason: 'review-head-mismatch' });
  });

  test('keeps provider evidence binding on the gated path', () => {
    expect(verify({ review: JSON.stringify({ pr: PR, headCommit: HEAD, reviewed: true, verdict: 'pass', mustFix: [], model: 'acp:claude', reviewRoute: 'acp' }) }))
      .toEqual({ ok: false, reason: 'review-forbidden-acp-claude' });
  });

  test('only accepts a reviewed pass|warn whose counted must-fix is zero', () => {
    expect(verify({ review: JSON.stringify({ pr: PR, headCommit: HEAD, reviewed: true, verdict: 'fail', mustFix: [] }) }))
      .toEqual({ ok: false, reason: 'review-verdict-fail' });
    expect(verify({ review: JSON.stringify({ pr: PR, headCommit: HEAD, reviewed: true, verdict: 'warn', mustFix: ['one finding'] }) }))
      .toEqual({ ok: false, reason: 'review-must-fix-1' });
    expect(verify({ review: JSON.stringify({ pr: PR, headCommit: HEAD, reviewed: true, verdict: 'warn', mustFix: [42] }) }))
      .toEqual({ ok: false, reason: 'review-must-fix-unknown' });
  });
});

describe('advanced base window (OVERLAP-EVIDENCE-BASE-WINDOW)', () => {
  const selectedName = `card-${PR}-${HEAD.slice(0, 12)}.json`;
  const selectedPath = `${STD_DIR}/${selectedName}`;
  const windowEvidence = () => JSON.stringify({
    pr: PR, head: HEAD, gate: { head: HEAD, baseCommit: GATE_BASE, passed: true }, reviewResult: selectedPath,
  });
  const verifyWindow = (world: GitWorld) => verifyOverlapEvidence({
    evidencePath: '/evidence.json', pr: PR, expectedHead: HEAD, remote: 'origin', branch: 'main', cwd: '/repo',
    run: gitFor(world),
    readFile: (path) => path === '/evidence.json' ? windowEvidence() : review(HEAD),
    reviewResultsDir: STD_DIR, listDir: () => [selectedName], reviewMtime: () => 1, reviewRealPath: (path) => path,
    overlappingLandings: [],
  });

  test('accepts a window whose commits touch none of the PR files', () => {
    expect(verifyWindow({ prFiles: ['src/cli/pr-cli.ts'], window: [{ sha: WINDOW_COMMIT, files: ['docs/unrelated.md'] }] }))
      .toEqual({ ok: true, mode: 'base-advanced-disjoint', baseTip: BASE_TIP, gateBase: GATE_BASE, windowCommits: 1, reviewResult: selectedPath });
  });

  test('refuses a window commit that touches the PR files and asks for a re-judge', () => {
    expect(verifyWindow({ prFiles: ['src/cli/pr-cli.ts'], window: [{ sha: WINDOW_COMMIT, files: ['src/cli/pr-cli.ts'] }] }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('base-stale-overlap:'), baseTip: BASE_TIP });
  });
});

describe('all same-head reviews decide together (already-ancestor-auto)', () => {
  const decide = (names: readonly string[], bodyFor: (name: string) => string) => verifyAllSameHeadReviews({
    pr: PR, expectedHead: HEAD, reviewResultsDir: STD_DIR,
    listDir: () => [...names], readFile: (path) => bodyFor(basename(path)),
  });
  const passBody = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ pr: PR, headCommit: HEAD, reviewed: true, verdict: 'pass', mustFix: [], ...extra });

  test('accepts head-10 and full-head filenames from the standard directory', () => {
    const short = `card-${PR}-${HEAD.slice(0, 10)}.json`;
    expect(decide([short], () => passBody())).toEqual({ ok: true, reviewResult: `${STD_DIR}/${short}` });
    const full = `card-${PR}-${HEAD}.json`;
    expect(decide([full], () => passBody())).toEqual({ ok: true, reviewResult: `${STD_DIR}/${full}` });
  });

  test('ignores head prefixes shorter than 10, longer than 40 and other PRs', () => {
    expect(decide([
      `card-${PR}-${HEAD.slice(0, 9)}.json`,
      `card-${PR}-${HEAD}a.json`,
      `card-${PR + 1}-${HEAD.slice(0, 10)}.json`,
    ], () => passBody())).toEqual({ ok: false, reason: 'review-missing' });
  });

  test('rejects the landing when any same-head review failed, and accepts when all passed', () => {
    const passing = `card-A-${PR}-${HEAD.slice(0, 10)}.json`;
    const later = `card-B-${PR}-${HEAD.slice(0, 12)}.json`;
    const failBody = JSON.stringify({ pr: PR, headCommit: HEAD, reviewed: true, verdict: 'fail', mustFix: [] });
    expect(decide([passing, later], (name) => (name === later ? failBody : passBody())))
      .toEqual({ ok: false, reason: 'review-verdict-fail' });
    expect(decide([passing, later], (name) => (name === later ? passBody({ verdict: 'warn' }) : passBody())))
      .toEqual({ ok: true, reviewResult: `${STD_DIR}/${later}` });
  });

  test('holds every same-head review to the head, PR and provider contract', () => {
    const first = `card-A-${PR}-${HEAD.slice(0, 10)}.json`;
    const second = `card-B-${PR}-${HEAD.slice(0, 12)}.json`;
    expect(decide([first, second], (name) => (name === second ? passBody({ headCommit: 'f'.repeat(40) }) : passBody())))
      .toEqual({ ok: false, reason: 'review-head-mismatch' });
    expect(decide([first, second], (name) => (name === second ? passBody({ pr: PR + 1 }) : passBody())))
      .toEqual({ ok: false, reason: 'review-pr-mismatch' });
    expect(decide([first, second], (name) => (name === second ? passBody({ model: 'acp:claude', reviewRoute: 'acp' }) : passBody())))
      .toEqual({ ok: false, reason: 'review-forbidden-acp-claude' });
  });
});

describe('virtual rebase evidence (verifyOverlapEvidenceVirtualRebase)', () => {
  const selectedName = `card-${PR}-${HEAD.slice(0, 12)}.json`;
  const selectedPath = `${STD_DIR}/${selectedName}`;
  const evidence = (body: Record<string, unknown>) => JSON.stringify({
    pr: PR, head: HEAD, gate: { head: HEAD, baseCommit: GATE_BASE, passed: true }, reviewResult: selectedPath, ...body,
  });
  const verifyVirtual = (options: { evidence?: Record<string, unknown>; review?: string; world?: GitWorld; baseTip?: string } = {}) =>
    verifyOverlapEvidenceVirtualRebase({
      evidencePath: '/evidence.json', pr: PR, expectedHead: HEAD, remote: 'origin', branch: 'main', cwd: '/repo',
      run: gitFor(options.world),
      readFile: (path) => path === '/evidence.json' ? evidence(options.evidence ?? {}) : (options.review ?? review(HEAD)),
      reviewResultsDir: STD_DIR, listDir: () => [selectedName], reviewMtime: () => 1, reviewRealPath: (path) => path,
      overlappingLandings: [],
    }, options.baseTip ?? BASE_TIP);

  test('enforces the evidence PR and head identity before any git work', () => {
    expect(verifyVirtual({ baseTip: 'not-a-sha' })).toEqual({ ok: false, reason: 'virtual-rebase-invalid-sha' });
    expect(verifyVirtual({ evidence: { pr: PR + 1 } })).toEqual({ ok: false, reason: 'evidence-pr-mismatch' });
    expect(verifyVirtual({ evidence: { head: 'f'.repeat(40) } })).toEqual({ ok: false, reason: 'evidence-head-mismatch' });
    expect(verifyVirtual({ evidence: { gate: undefined } })).toEqual({ ok: false, reason: 'gate-missing' });
    expect(verifyVirtual({ evidence: { gate: { head: HEAD, baseCommit: GATE_BASE, passed: false } } }))
      .toEqual({ ok: false, reason: 'gate-not-passed' });
    expect(verifyVirtual({ evidence: { gate: { head: 'f'.repeat(40), baseCommit: GATE_BASE, passed: true } } }))
      .toEqual({ ok: false, reason: 'gate-head-mismatch' });
    expect(verifyVirtual({ evidence: { gate: { head: HEAD, baseCommit: 'short', passed: true } } }))
      .toEqual({ ok: false, reason: 'gate-base-unmeasured' });
  });

  test('holds the reused review to the same head-prefix, content and provider contract', () => {
    expect(verifyVirtual({ evidence: { reviewResult: `${STD_DIR}/card-${PR}-${HEAD.slice(0, 9)}.json` } }))
      .toEqual({ ok: false, reason: 'review-path-not-for-this-pr-head', baseTip: BASE_TIP });
    expect(verifyVirtual({ review: review('f'.repeat(40)) })).toEqual({ ok: false, reason: 'review-head-mismatch', baseTip: BASE_TIP });
    expect(verifyVirtual({ review: review(HEAD, PR + 1) })).toEqual({ ok: false, reason: 'review-pr-mismatch', baseTip: BASE_TIP });
    expect(verifyVirtual({ review: JSON.stringify({ pr: PR, headCommit: HEAD, reviewed: true, verdict: 'pass', mustFix: [], model: 'acp:claude', reviewRoute: 'acp' }) }))
      .toEqual({ ok: false, reason: 'review-forbidden-acp-claude', baseTip: BASE_TIP });
  });

  test('refuses a base tip that advanced again or a stale local tracking ref', () => {
    expect(verifyVirtual({ world: { lsRemote: 'd'.repeat(40) } }))
      .toEqual({ ok: false, reason: 'virtual-rebase-base-advanced' });
    expect(verifyVirtual({ world: { localRef: 'd'.repeat(40) } }))
      .toEqual({ ok: false, reason: 'virtual-rebase-base-stale-or-unmeasured' });
  });
});
