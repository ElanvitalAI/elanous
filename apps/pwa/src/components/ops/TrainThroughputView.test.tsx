import { expect, test } from 'bun:test';
import { Children, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TrainThroughputContent } from './TrainThroughputView';
import type { OpsResult, TrainThroughput } from '@/lib/ops-api';

const base = { assigned: 0, assignedPrs: 0, completed: 0, succeeded: 0, rejected: 0, failed: 0,
  rejectedByReason: { typecheck: 0, ratchet: 0, introduced: 0, 'setup-unmeasured': 0, authorization: 0, 'lock-owner': 0, other: 0 },
  unmeasured: 0, landed: null, averageWaitSeconds: null };
const data: TrainThroughput = { date: '2026-11-02', generatedAt: '2026-11-02T07:00:00.000Z',
  hosts: { aws2: { ...base, assigned: 2, completed: 1, rejected: 1, landed: null, averageWaitSeconds: 480,
    rejectedByReason: { ...base.rejectedByReason, authorization: 1 } } }, hours: {}, attempts: [] };

test('shows rejection reasons and distinguishes unavailable land counts', () => {
  const result: OpsResult<TrainThroughput> = { kind: 'ready', data };
  const html = renderToStaticMarkup(<TrainThroughputContent result={result} date="2026-11-02" />);
  expect(html).toContain('authorization 1');
  expect(html).toContain('미측정');
  expect(html).toContain('480초');
});

test('exposes and invokes a refresh action for current throughput data', () => {
  let refreshes = 0;
  const result: OpsResult<TrainThroughput> = { kind: 'ready', data };
  const section = TrainThroughputContent({ result, date: '2026-11-02', onRefresh: () => { refreshes++; } });
  const sectionChildren = Children.toArray((section as ReactElement<{ children: ReactNode }>).props.children);
  const header = sectionChildren[0] as ReactElement<{ children: ReactNode }>;
  const button = Children.toArray(header.props.children)[1] as ReactElement<{ children: ReactNode; onClick: () => void }>;
  expect(button.props.children).toBe('새로고침');
  button.props.onClick();
  expect(refreshes).toBe(1);
});
