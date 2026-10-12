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
