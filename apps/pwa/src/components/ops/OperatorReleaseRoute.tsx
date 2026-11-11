'use client';

import { ReleaseRunsView } from './ReleaseRunsView';

/** Keep the static-exported route blank until /v1/me confirms operator access. */
export function OperatorReleaseRoute({ operator }: { operator: boolean }): React.ReactNode {
  return operator ? <ReleaseRunsView /> : null;
}
