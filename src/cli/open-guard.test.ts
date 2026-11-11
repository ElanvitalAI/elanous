import { expect, test } from 'bun:test';
import { guardHotspotStart, hotspotApprovalCommentId, type HotspotApproval, type HotspotApprovalSource } from './open-guard.js';
import type { Inventory, OpenPr } from '../pr-tool/census.js';

const row = (number: number, headSha: string, files: string[]): OpenPr => ({
  number, headSha, files, title: `PR ${number}`, draft: false, updatedAt: '2026-11-08T00:00:00Z',
  labels: [], seat: null, cellId: null,
});
const inventory: Inventory = { status: 'checked', prs: [
  row(10, 'a'.repeat(40), ['src/shared.ts', 'src/one.ts']),
  row(11, 'b'.repeat(40), ['src/shared.ts']),
  row(12, 'c'.repeat(40), ['src/other.ts']),
] };

test('planned file with two open PRs refuses until OP approves the exact observed heads', () => {
  const refused = guardHotspotStart(['src/shared.ts'], inventory);
  expect(refused).toMatchObject({ status: 'refuse', reason: 'hotspot-op-approval-required', hotspots: [
    { file: 'src/shared.ts', prs: [{ number: 10, headSha: 'a'.repeat(40) }, { number: 11, headSha: 'b'.repeat(40) }] },
  ] });
  const approval: HotspotApproval = {
    commentUrl: 'https://github.com/ElanvitalAI/elanous/issues/42#issuecomment-42', files: ['src/shared.ts'],
    prs: [{ number: 10, headSha: 'a'.repeat(40) }, { number: 11, headSha: 'b'.repeat(40) }],
  };
  const sourcePayload = JSON.stringify({ kind: 'HOTSPOT-FILE-LEASE-APPROVAL', files: approval.files, prs: approval.prs });
  const source: HotspotApprovalSource = { commentId: 42, author: 'ElanvitalAI', body: sourcePayload };
  expect(guardHotspotStart(['src/shared.ts'], inventory, approval, source)).toMatchObject({ status: 'allow', approval: approval.commentUrl });
  const reorderedPrs = approval.prs.map(({ number, headSha }) => ({ headSha, number, extra: 'ignored' }));
  const reorderedApproval = { ...approval, prs: reorderedPrs };
  const reorderedSource = { ...source, body: JSON.stringify({ kind: 'HOTSPOT-FILE-LEASE-APPROVAL', files: approval.files, prs: reorderedPrs }) };
  expect(guardHotspotStart(['src/shared.ts'], inventory, reorderedApproval, reorderedSource).status).toBe('allow');
  expect(guardHotspotStart(['src/shared.ts'], inventory, approval, { ...source, author: 'another-user' }).status).toBe('refuse');
  expect(guardHotspotStart(['src/shared.ts'], inventory, approval, { ...source, body: 'forged' }).status).toBe('refuse');
  expect(guardHotspotStart(['src/shared.ts'], { status: 'checked', prs: [
    row(10, 'a'.repeat(40), ['src/shared.ts']), row(11, 'd'.repeat(40), ['src/shared.ts']),
  ] }, approval, source)).toMatchObject({ status: 'refuse' });
  expect(guardHotspotStart(['src/shared.ts', 'src/other.ts'], inventory, approval, source).status).toBe('allow');
  expect(hotspotApprovalCommentId('https://github.com/another/repo/issues/42#issuecomment-42')).toBeNull();
});

test('one overlap is permitted and incomplete observations fail closed', () => {
  expect(guardHotspotStart(['src/one.ts'], inventory)).toMatchObject({ status: 'allow', hotspots: [] });
  expect(guardHotspotStart(['src/shared.ts'], { status: 'unknown', reason: 'GitHub unavailable' }))
    .toMatchObject({ status: 'unknown', reason: 'inventory-unknown: GitHub unavailable' });
  expect(guardHotspotStart(['../outside.ts'], inventory)).toMatchObject({ status: 'unknown', reason: 'planned-files-unknown' });
  for (const alias of ['./src/shared.ts', 'src/./shared.ts', 'src//shared.ts', 'src\\shared.ts'])
    expect(guardHotspotStart([alias], inventory)).toMatchObject({ status: 'unknown', reason: 'planned-files-unknown' });
});
