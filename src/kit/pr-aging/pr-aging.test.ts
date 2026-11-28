// PR-ZOMBIE-AGING kit — the shipped YAML, the head-age basis, the zombie verdict, fresh supply, and local commit times.
// Expected values are literals (rule 11): days, PR numbers and stage names written from the scene, not from the kit.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agingCard, conflictEvidence, headAtOf, headCommitTimes, isFreshPr, judgePrAging, parsePrAgingPolicy, prAgingPolicyPath, splitSupply,
} from './index.js';

const policy = parsePrAgingPolicy(readFileSync(prAgingPolicyPath(), 'utf8'));
const NOW = Date.parse('2026-11-29T02:30:00.000Z');
const daysAgo = (d: number) => NOW - d * 86_400_000;
const H = (n: number) => n.toString(16).padStart(40, '0');

describe('policy (graphs/policies/pr-aging.yaml)', () => {
  test('shipped numbers and signal names', () => {
    // 출처: R-TST16 — the shipped graphs/policies/pr-aging.yaml values pinned as literals (a value change must bite here).
    expect(policy).toEqual({
      supply: { freshHeadMaxDays: 7 },
      conflict: { pregateRedStages: ['merge-main'], landRefusals: ['merge-conflict'] },
      toDraft: { headAgeDays: 7, requireConflict: true, maxPerTick: 20, cardTo: ['author'] }, // 출처: R-TST16 (shipped YAML literal)
      closeProposal: { headAgeDays: 14, requireConflict: true, cardTo: ['author', 'landing-owner'] },
    });
  });
  test('invalid values are refused, never defaulted', () => {
    const text = readFileSync(prAgingPolicyPath(), 'utf8');
    expect(() => parsePrAgingPolicy(text.replace('head_age_days: 14', 'head_age_days: 3'))).toThrow('close_proposal.head_age_days < to_draft.head_age_days');
    expect(() => parsePrAgingPolicy(text.replace('card_to: [author]\n', 'card_to: [everyone]\n'))).toThrow('to_draft.card_to');
    expect(() => parsePrAgingPolicy(text.replace('require_conflict: true', 'require_conflict: yes-please'))).toThrow('to_draft.require_conflict');
  });
});

describe('head age basis', () => {
  test('commit time first · updatedAt second · neither = unknown', () => {
    expect(headAtOf(daysAgo(9), '2026-11-28T00:00:00Z')).toEqual({ at: daysAgo(9), source: 'commit' });
    expect(headAtOf(undefined, '2026-11-20T02:30:00.000Z')).toEqual({ at: daysAgo(9), source: 'pr-updated' });
    expect(headAtOf(undefined, undefined)).toBeNull();
  });
  test('fresh = not draft and head ≤ 7 days · unknown age is fresh · a draft is never supply', () => {
    expect(isFreshPr({ draft: false, headAt: { at: daysAgo(7), source: 'commit' } }, policy, NOW)).toBe(true);
    expect(isFreshPr({ draft: false, headAt: { at: daysAgo(8), source: 'commit' } }, policy, NOW)).toBe(false);
    expect(isFreshPr({ draft: false, headAt: null }, policy, NOW)).toBe(true);
    expect(isFreshPr({ draft: true, headAt: { at: daysAgo(1), source: 'commit' } }, policy, NOW)).toBe(false);
  });
});

describe('zombie verdict', () => {
  test('conflict evidence comes only from the named RED step or land refusal class', () => {
    expect(conflictEvidence({ redFailedSteps: ['rules-and-ratchets', 'merge-main'], landRefusals: [] }, policy)).toBe('pregate RED merge-main');
    expect(conflictEvidence({ redFailedSteps: ['focused'], landRefusals: ['merge-conflict'] }, policy)).toBe('land refused merge-conflict');
    expect(conflictEvidence({ redFailedSteps: ['focused', 'changed-tsc'], landRefusals: ['no-receipt', 'stale-head'] }, policy)).toBeNull();
  });
  test('7d ⊕ conflict → to-draft · 14d ⊕ conflict → close proposal (drafts too) · no conflict / unknown age → nothing', () => {
    const at = (d: number) => ({ at: daysAgo(d), source: 'commit' as const });
    const v = judgePrAging([
      { pr: 36001, head: H(1), draft: false, author: 'TC', headAt: at(8), conflict: 'pregate RED merge-main' },
      { pr: 36002, head: H(2), draft: true, author: 'UX', headAt: at(15), conflict: 'land refused merge-conflict' },
      { pr: 36003, head: H(3), draft: false, author: 'TC', headAt: at(30), conflict: null },
      { pr: 36004, head: H(4), draft: false, author: 'TC', headAt: null, conflict: 'pregate RED merge-main' },
      { pr: 36005, head: H(5), draft: false, author: 'MK', headAt: at(6), conflict: 'pregate RED merge-main' },
      { pr: 36006, head: H(6), draft: true, author: 'MK', headAt: at(9), conflict: 'pregate RED merge-main' },
    ], policy, NOW);
    expect(v.map(x => [x.pr, x.stage, x.ageDays])).toEqual([[36002, 'close-proposal', 15], [36001, 'to-draft', 8]]);
    expect(v[1]!.why).toBe('head unchanged 8d ≥ 7d · pregate RED merge-main');
  });
  test('cards say what the author does · the close proposal says code does not close', () => {
    const [d, c] = [
      { pr: 36001, head: H(1), stage: 'to-draft' as const, ageDays: 8, basis: 'commit' as const, conflict: 'x', author: 'TC', why: 'w' },
      { pr: 36002, head: H(2), stage: 'close-proposal' as const, ageDays: 15, basis: 'commit' as const, conflict: 'x', author: 'UX', why: 'w' },
    ];
    expect(agingCard(d, 'feat: x')).toContain('gh pr ready 36001');
    expect(agingCard(c, 'feat: y')).toContain('코드는 닫지 않는다');
  });
});

describe('fresh supply', () => {
  test('stale non-drafts are left out by number; drafts are never supply; no policy = every non-draft', () => {
    const times = new Map([[H(1), daysAgo(2)], [H(2), daysAgo(12)]]);
    const prs = [
      { pr: 40001, head: H(1), draft: false },
      { pr: 37002, head: H(2), draft: false },
      { pr: 36003, head: H(3), draft: false, updatedAt: '2026-11-10T00:00:00Z' },
      { pr: 40004, head: H(4), draft: true },
      { pr: 40005, head: H(5), draft: false },
    ];
    const s = splitSupply(prs, times, policy, NOW);
    expect([[...s.heads.keys()], s.stale]).toEqual([[40001, 40005], [36003, 37002]]);
    expect([...splitSupply(prs, times, null, NOW).heads.keys()]).toEqual([40001, 37002, 36003, 40005]);
  });
});

describe('local commit times (git, no network)', () => {
  test('present heads → committer time · missing head → absent · not a sha → ignored', () => {
    const repo = mkdtempSync(join(tmpdir(), 'pr-aging-git-'));
    const g = (args: string[], env: Record<string, string> = {}) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
    g(['init', '-q']);
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    g(['add', 'a.txt']);
    g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'a'], { GIT_COMMITTER_DATE: '2026-11-19T02:30:00Z', GIT_AUTHOR_DATE: '2026-11-01T00:00:00Z' });
    const head = g(['rev-parse', 'HEAD']).stdout.trim();
    const t = headCommitTimes(repo, [head, H(99), 'not-a-sha']);
    expect([...t.entries()]).toEqual([[head, Date.parse('2026-11-19T02:30:00Z')]]);
    expect(headCommitTimes('', [head]).size).toBe(0);
  });
});
