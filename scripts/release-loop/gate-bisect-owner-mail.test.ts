import { expect, test } from 'bun:test';
import { deliverGateBisectOwnerMail, ownerSeatFromPullRequest, uniqueAssociatedPullRequest, type GateBisectOwnerCandidate } from './gate-bisect-owner-mail.js';

const candidate: GateBisectOwnerCandidate = {
  file: 'src/nexus/apps/app-db.test.ts', firstFailingCommit: 'a'.repeat(40), pullRequest: 35699,
  owner: 'automation-login', ownerSeat: 'MVP-B', evidence: '/ledger/gate-bisect.json',
};

test('GATE-FAIL-BISECT-SIDECAR: owner mail includes root PR, owner, reproduction, and land-queue evidence', async () => {
  const posted: Array<{ seat: string; body: string }> = [];
  const evidence = await deliverGateBisectOwnerMail([candidate], { post: async (seat, body) => {
    posted.push({ seat, body });
    return { id: '#82799' };
  } });
  expect(posted).toHaveLength(1);
  expect(posted[0]?.seat).toBe('MVP-B');
  expect(posted[0]?.body).toContain('원인 PR: #35699');
  expect(posted[0]?.body).toContain('담당 MVP-B');
  expect(posted[0]?.body).toContain(`(repo=$(git rev-parse --show-toplevel); tree=/tmp/gate-fail-bisect-${candidate.firstFailingCommit.slice(0, 12)};`);
  expect(posted[0]?.body).toContain(`git -C "$repo" worktree add --detach "$tree" ${candidate.firstFailingCommit}`);
  expect(posted[0]?.body).toContain(`trap 'git -C "$repo" worktree remove "$tree"' EXIT`);
  expect(posted[0]?.body).toContain('bun test ./src/nexus/apps/app-db.test.ts');
  expect(posted[0]?.body).toContain('land-queue 근거: gate-failure PR #35699');
  expect(evidence).toEqual([expect.objectContaining({ pullRequest: 35699, ownerSeat: 'MVP-B', status: 'delivered', messageId: '#82799' })]);
});

test('GATE-FAIL-BISECT-SIDECAR: unresolved owners stay in evidence and are not misaddressed', async () => {
  let posts = 0;
  const evidence = await deliverGateBisectOwnerMail([{ ...candidate, ownerSeat: null }], { post: async () => { posts++; return {}; } });
  expect(posts).toBe(0);
  expect(evidence).toEqual([expect.objectContaining({ status: 'unresolved', ownerSeat: null, pullRequest: 35699 })]);
});

test('GATE-FAIL-BISECT-SIDECAR: delivery failures are explicit and do not erase owner evidence', async () => {
  const evidence = await deliverGateBisectOwnerMail([candidate], { post: async () => { throw new Error('mail down'); } });
  expect(evidence).toEqual([expect.objectContaining({ status: 'failed', ownerSeat: 'MVP-B', error: 'Error: mail down' })]);
});

test('GATE-FAIL-BISECT-SIDECAR: resolves a confirmed seat only when PR identity and branch agree', () => {
  expect(ownerSeatFromPullRequest({ headRefName: 'MVP-B-nexus-fix', assignees: ['MVP-B'] })).toBe('MVP-B');
  expect(ownerSeatFromPullRequest({ headRefName: 'opt/release-work', assignees: ['OPT'] })).toBe('OPT');
  expect(ownerSeatFromPullRequest({ headRefName: 'random-branch', assignees: ['UX'] })).toBe('UX');
  expect(ownerSeatFromPullRequest({ headRefName: 'MVP-B-nexus-fix', assignees: ['TC'] })).toBeNull();
  expect(ownerSeatFromPullRequest({ headRefName: 'MVP-B-nexus-fix', assignees: ['automation-login'] })).toBeNull();
  expect(ownerSeatFromPullRequest({ headRefName: 'MVP-B-nexus-fix', assignees: ['MVP-B', 'TC'] })).toBeNull();
  expect(ownerSeatFromPullRequest({ headRefName: 'MVP-B-nexus-fix', assignees: [] })).toBeNull();
  expect(ownerSeatFromPullRequest({ headRefName: 'random-branch', assignees: [] })).toBeNull();
});

test('GATE-FAIL-BISECT-SIDECAR: commit ownership requires one exact associated PR', () => {
  expect(uniqueAssociatedPullRequest([401, 401])).toBe(401);
  expect(uniqueAssociatedPullRequest([])).toBeNull();
  expect(uniqueAssociatedPullRequest([401, 402])).toBeNull();
});
