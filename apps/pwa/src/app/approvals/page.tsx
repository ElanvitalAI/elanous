'use client';

import { MergeApprovals } from '@/components/approvals/MergeApprovals';
import { GraphApprovals } from '@/components/approvals/GraphApprovals';

export default function ApprovalsPage() {
  return <><GraphApprovals /><MergeApprovals /></>;
}
