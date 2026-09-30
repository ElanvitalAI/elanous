import { expect, test } from 'bun:test';
import { GraphApprovals } from '@/components/approvals/GraphApprovals';
import { MergeApprovals } from '@/components/approvals/MergeApprovals';
import ApprovalsPage from './page';

test('approvals page mounts graph decisions before merge approvals', () => {
  const page = ApprovalsPage();
  const children = page.props.children as Array<{ type: unknown }>;
  expect(children.map(child => child.type)).toEqual([GraphApprovals, MergeApprovals]);
});
