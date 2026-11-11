'use client';

import { OperatorReleaseRoute } from '@/components/ops/OperatorReleaseRoute';
import { useOperator } from '@/lib/use-operator';

export default function ReleasePage(): React.ReactNode {
  return <OperatorReleaseRoute operator={useOperator()} />;
}
