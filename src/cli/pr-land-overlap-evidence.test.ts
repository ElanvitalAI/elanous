import { describe, expect, test } from 'bun:test';
import { verifyAncestorAutoPass, verifyOverlapEvidence } from './pr-land-overlap-evidence.js';
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

describe('PR land review filename head prefix', () => {
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

describe('explicit review attempt selection', () => {
  const dir = '/state/review-results';
  const selected = `card-R4-${PR}-${HEAD.slice(0, 12)}.json`;
  const failed = `card-R3-${PR}-${HEAD.slice(0, 12)}.json`;
  const extra = `card-R2-${PR}-${HEAD.slice(0, 12)}.json`;
  const evidence = (supersedes?: unknown, followupPr?: unknown) => JSON.stringify({
    pr: PR, head: HEAD, reviewResult: `${dir}/${selected}`, supersedes, followupPr,
  });
  const runCase = (options: { supersedes?: unknown; followupPr?: unknown; names?: string[]; followupState?: string; selectedHead?: string; failedTime?: number; failedVerdict?: unknown } = {}) => {
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
        : path.endsWith(selected) ? review(options.selectedHead ?? HEAD)
          : JSON.stringify({ pr: PR, headCommit: HEAD, reviewed: true,
            verdict: options.failedVerdict === undefined ? 'fail' : options.failedVerdict, mustFix: [] }),
    });
  };
  const replacement = [{ reviewResult: `${dir}/${failed}`, reason: 'review-verdict-fail' }];

  test('fails closed on an old same-head FAIL unless explicitly superseded with an OPEN follow-up', () => {
    expect(runCase()).toMatchObject({ ok: false, reason: expect.stringContaining('review-attempt-not-superseded') });
    expect(runCase({ supersedes: replacement, followupPr: PR + 1 })).toMatchObject({ ok: true, mode: 'already-ancestor' });
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
